// ============================================================================
// Noctis Protocol — Staking Rewards Pool (T66, 2026-07-14)
// ============================================================================
// Optional per-launch feature, Tier A + B. A creator may allocate a fixed
// 25% of total supply into this pool at launch (contracts/cardano/
// validators/bonding_curve.ak and bonding_curve_tier_b.ak's `Graduate`
// redeemer seeds it, alongside LP, once graduated — see those files'
// `staking_seeding_output_ok` check).
//
// Two datum shapes share this one validator address, wrapped in the
// `StakingDatum` enum below:
//   - Pool(StakingPoolDatum): ONE per launch. Holds the depleting reward
//     token balance as real UTXO value (no separate on-chain balance
//     field — the value IS the balance, same discipline as
//     bonding_curve.ak's curve_token_balance_decreased). Tracks
//     claimed_so_far per staker as a List<(VerificationKeyHash, Int)>,
//     mirroring bonding_curve.ak's own per_address_purchases pattern —
//     an already-accepted tradeoff in this codebase for "many identities,
//     one shared ledger" tracking, not a new contention risk introduced
//     here.
//   - Position(StakingPositionDatum): one per staker per stake action.
//     Holds a staker's real staked tokens as UTXO value. Deliberately NOT
//     consolidated across multiple stakes by the same wallet — each stake
//     action creates its own fresh position UTXO (permissionless output
//     creation, no validator invocation needed for staking itself, same
//     as any deposit), avoiding both single-UTXO contention for the
//     frequent stake/unstake action AND any need to merge/reset bonding
//     periods across a wallet's multiple positions.
//
// Reward accounting is NOT computed on-chain. Compact has no in-circuit
// division and no reward-per-share pattern exists anywhere in this
// codebase (confirmed before designing this) — rather than invent new
// on-chain division workarounds, this reuses the exact trust model
// already shipped for cto_governance.compact's balance-snapshot tree and
// eligibility_gate.compact's DarkVeil allowlist tree: the governor
// computes each staker's cumulative accrued reward off-chain (from real,
// publicly observable stake/unstake events — independently
// re-derivable by anyone, not a hidden computation) and periodically
// publishes a Merkle root via `PublishRewardRoot`. A claim is a ZK-style
// proof of membership for the caller's own `(staker_vkh,
// cumulative_amount)` leaf — verified on-chain, no division anywhere.
// The bonding period (7 days before a new position earns anything) is
// enforced entirely by that same off-chain formula, using each
// position's real on-chain `stake_timestamp` — no separate on-chain
// check exists for it here.
//
// The on-chain contract's only real invariant is that cumulative claims
// never exceed the pool's real token balance — this is what makes a
// pool top-up need no rate-recalculation logic anywhere: there is no
// stored duration, end-timestamp, or emission-rate field on-chain at
// all. The "3-5 year runway" is an off-chain governor commitment,
// auditable via the published root sequence over time.
// ============================================================================

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash, blake2b_256}
use aiken/primitive/bytearray
use cardano/address.{Address, from_verification_key, with_delegation_key}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{Input, InlineDatum, Output, OutputReference, Transaction}

// ============================================================================
// TYPES
// ============================================================================

/// One step of a Merkle inclusion proof — same `(sibling, direction)` shape
/// already used by bonding_curve_tier_b.ak's DarkVeil allocation proofs.
pub type MerkleProofStep {
  sibling: ByteArray,
  goes_left: Bool,
}

/// One per launch. Its own UTXO value holds the real, depleting reward
/// token balance.
pub type StakingPoolDatum {
  launch_id: ByteArray,
  governor_pub_key_hash: VerificationKeyHash,
  creator_pub_key_hash: VerificationKeyHash,
  token_policy_id: PolicyId,
  token_asset_name: AssetName,
  // Governor-published Merkle root over (staker_vkh, cumulative_amount)
  // leaves — see file header. Updated only via PublishRewardRoot.
  reward_root: ByteArray,
  // How much each staker has already withdrawn, cumulative — prevents
  // re-claiming the same leaf. Same list-of-pairs pattern as
  // bonding_curve.ak's per_address_purchases.
  claimed_so_far: List<(VerificationKeyHash, Int)>,
}

/// One per stake action. Its own UTXO value holds the staker's real
/// staked tokens.
pub type StakingPositionDatum {
  launch_id: ByteArray,
  staker_vkh: VerificationKeyHash,
  staked_amount: Int,
  // Posix seconds this position was created — read by the governor's
  // off-chain snapshot formula to apply the 7-day bonding period. Not
  // independently re-verified on-chain here (same trust boundary as the
  // rest of the off-chain reward computation).
  stake_timestamp: Int,
}

pub type StakingDatum {
  Pool(StakingPoolDatum)
  Position(StakingPositionDatum)
}

/// Redeemer actions. Staking itself (first stake, or an additional stake
/// by the same wallet) needs no redeemer at all — creating a new Position
/// output at this validator's address is permissionless, same as any
/// deposit; only spending an existing UTXO here needs validator approval.
pub type StakingPoolRedeemer {
  /// Full withdrawal of one position — staker-signed. No partial unstake;
  /// an additional stake or a partial exit is just a second position
  /// created/unstaked separately.
  Unstake
  /// Permissionless — same "the proof is the authorization" idiom as
  /// bonding_curve.ak's Graduate/ExpireCurve. A real Merkle proof of
  /// membership for (staker_vkh, claimed_cumulative_amount), plus a hard
  /// check that payout can only reach staker_vkh's own address, is the
  /// full authorization; nobody benefits from submitting someone else's
  /// claim since the funds can't be redirected.
  ClaimRewards {
    staker_vkh: VerificationKeyHash,
    claimed_cumulative_amount: Int,
    merkle_proof: List<MerkleProofStep>,
  }
  /// Creator-only. Adds `amount` of the reward token to the pool's own
  /// value. No rate recalculation anywhere — see file header.
  TopUpPool { amount: Int }
  /// Governor-only. Updates reward_root; the pool's own token value and
  /// claimed_so_far must be unchanged — this redeemer can publish a new
  /// snapshot but can never move funds.
  PublishRewardRoot { new_root: ByteArray }
  /// Read-only query, no state change.
  QueryState
}

// ============================================================================
// HELPERS
// ============================================================================

/// Leaf hash for a reward claim: `blake2b_256(staker_vkh ||
/// cumulative_amount_16be)`. No salt — unlike bonding_curve_tier_b.ak's
/// DarkVeil allocation leaf, reward amounts carry no privacy requirement
/// here, so there's nothing a salt would need to protect against
/// brute-forcing.
fn hash_reward_leaf(staker_vkh: VerificationKeyHash, cumulative_amount: Int) -> ByteArray {
  blake2b_256(bytearray.concat(staker_vkh, bytearray.from_int_big_endian(cumulative_amount, 16)))
}

fn hash_reward_node(left: ByteArray, right: ByteArray) -> ByteArray {
  blake2b_256(bytearray.concat(left, right))
}

fn verify_reward_merkle_proof(
  root: ByteArray,
  leaf: ByteArray,
  proof: List<MerkleProofStep>,
) -> Bool {
  let computed =
    list.foldl(
      proof,
      leaf,
      fn(step, acc) {
        if step.goes_left {
          hash_reward_node(step.sibling, acc)
        } else {
          hash_reward_node(acc, step.sibling)
        }
      },
    )
  computed == root
}

/// Look up a staker's cumulative claimed-so-far total (0 if not found) —
/// same shape as bonding_curve.ak's cumulative_purchases.
fn cumulative_claimed(
  claims: List<(VerificationKeyHash, Int)>,
  staker_vkh: VerificationKeyHash,
) -> Int {
  when claims is {
    [] -> 0
    [(k, amount), ..rest] ->
      if k == staker_vkh {
        amount
      } else {
        cumulative_claimed(rest, staker_vkh)
      }
  }
}

/// Update (or insert) a staker's cumulative claimed-so-far total — same
/// shape as bonding_curve.ak's update_purchases.
fn update_claimed(
  claims: List<(VerificationKeyHash, Int)>,
  staker_vkh: VerificationKeyHash,
  new_total: Int,
) -> List<(VerificationKeyHash, Int)> {
  when claims is {
    [] -> [(staker_vkh, new_total)]
    [(k, amount), ..rest] ->
      if k == staker_vkh {
        [(k, new_total), ..rest]
      } else {
        [(k, amount), ..update_claimed(rest, staker_vkh, new_total)]
      }
  }
}

/// Find this validator's own continuing output (same address as the input
/// being spent) and decode its inline datum — same pattern as
/// bonding_curve.ak's own_continuing_datum, generalized over the wrapping
/// StakingDatum enum.
fn own_continuing_datum(self: Transaction, own_ref: OutputReference) -> StakingDatum {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  expect InlineDatum(raw_datum) = own_output.datum
  expect new_datum: StakingDatum = raw_datum
  new_datum
}

/// T111 fix (2026-07-19, full-suite security audit): CRITICAL finding —
/// combining an Unstake (spending a Position) and a ClaimRewards (spending
/// the Pool) in the SAME transaction let a single output satisfy BOTH
/// checks at once, since Unstake's exact-match payment check and
/// ClaimRewards' >= threshold check both independently search
/// self.outputs by address alone, with no exclusivity between them.
/// Concretely: staking a real 500-token position plus a real pending
/// 100-token reward claim, a single 500-token output to the staker
/// satisfies Unstake's exact-match requirement AND (being >= 100)
/// ClaimRewards' threshold — letting the real 100-token reward be diverted
/// to a third party in the same transaction while the staker's own signed
/// Unstake half looks, from their perspective, like an ordinary unstake.
/// Requiring at most one input (and one output) at this shared address per
/// transaction closes this by construction — a staker can still unstake
/// multiple positions or claim rewards, just not combined with a DIFFERENT
/// staking_pool.ak UTXO in the same transaction. Same fix pattern already
/// applied to bonding_curve.ak/lp_escrow.ak/vesting.ak for the identical
/// shared-unparameterized-address root cause.
fn single_own_utxo(self: Transaction, own_address: Address) -> Bool {
  list.length(list.filter(self.inputs, fn(input) { input.output.address == own_address })) <= 1 && list.length(
    list.filter(self.outputs, fn(output) { output.address == own_address }),
  ) <= 1
}

// ============================================================================
// MAIN VALIDATOR
// ============================================================================

validator staking_pool {
  spend(
    datum_opt: Option<StakingDatum>,
    redeemer: StakingPoolRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(datum) = datum_opt
    expect Some(own_input) =
      list.find(self.inputs, fn(input) { input.output_reference == own_ref })

    and {
      single_own_utxo(self, own_input.output.address),
      when (datum, redeemer) is {
      (Pool(pool), ClaimRewards { staker_vkh, claimed_cumulative_amount, merkle_proof }) -> {
        let leaf = hash_reward_leaf(staker_vkh, claimed_cumulative_amount)
        let already_claimed = cumulative_claimed(pool.claimed_so_far, staker_vkh)
        let payout = claimed_cumulative_amount - already_claimed

        expect Some(own_input) =
          list.find(self.inputs, fn(input) { input.output_reference == own_ref })
        let own_address = own_input.output.address
        expect Some(own_output) =
          list.find(self.outputs, fn(output) { output.address == own_address })

        let pool_decreased_by_payout =
          assets.quantity_of(own_input.output.value, pool.token_policy_id, pool.token_asset_name) == assets.quantity_of(
            own_output.value,
            pool.token_policy_id,
            pool.token_asset_name,
          ) + payout

        // T93/T115-class fix (2026-07-22): compare only the payment
        // credential, not the full address. `from_verification_key`
        // constructs a bare ENTERPRISE address (no stake credential) — the
        // same construction T93 (bonding_curve.ak) and T115
        // (bonding_curve_tier_b.ak) found silently required a payout
        // destination no real Cardano wallet uses by default. This file
        // wasn't in scope for either of those fix passes and had the
        // identical bug, undiscovered until now. See those entries in
        // internal tracking for the full reasoning — same fix here.
        let staker_credential = from_verification_key(staker_vkh).payment_credential
        let staker_paid =
          list.any(
            self.outputs,
            fn(output) {
              output.address.payment_credential == staker_credential && assets.quantity_of(
                output.value,
                pool.token_policy_id,
                pool.token_asset_name,
              ) >= payout
            },
          )

        let new_datum = own_continuing_datum(self, own_ref)
        let expected_datum =
          Pool(
            StakingPoolDatum {
              ..pool,
              claimed_so_far: update_claimed(
                pool.claimed_so_far,
                staker_vkh,
                claimed_cumulative_amount,
              ),
            },
          )

        and {
          claimed_cumulative_amount > already_claimed,
          verify_reward_merkle_proof(pool.reward_root, leaf, merkle_proof),
          pool_decreased_by_payout,
          staker_paid,
          new_datum == expected_datum,
          // T81: ClaimRewards is permissionless — the pool's own
          // continuing output can't be padded with junk assets. See
          // bonding_curve.ak's output_value_clean for the full rationale
          // (found by comparing against MeshJS's open-source escrow.ak).
          list.length(assets.flatten(own_output.value)) <= 2,
        }
      }

      (Pool(pool), TopUpPool { amount }) -> {
        expect Some(own_input) =
          list.find(self.inputs, fn(input) { input.output_reference == own_ref })
        let own_address = own_input.output.address
        expect Some(own_output) =
          list.find(self.outputs, fn(output) { output.address == own_address })

        let pool_increased_by_amount =
          assets.quantity_of(own_output.value, pool.token_policy_id, pool.token_asset_name) == assets.quantity_of(
            own_input.output.value,
            pool.token_policy_id,
            pool.token_asset_name,
          ) + amount

        let new_datum = own_continuing_datum(self, own_ref)

        and {
          list.has(self.extra_signatories, pool.creator_pub_key_hash),
          amount > 0,
          pool_increased_by_amount,
          new_datum == Pool(pool),
          // T81: same cap as ClaimRewards — even a legitimate top-up
          // shouldn't be able to leave junk assets in the long-lived pool.
          list.length(assets.flatten(own_output.value)) <= 2,
        }
      }

      (Pool(pool), PublishRewardRoot { new_root }) -> {
        expect Some(own_input) =
          list.find(self.inputs, fn(input) { input.output_reference == own_ref })
        let own_address = own_input.output.address
        expect Some(own_output) =
          list.find(self.outputs, fn(output) { output.address == own_address })

        let value_unchanged =
          assets.quantity_of(own_output.value, pool.token_policy_id, pool.token_asset_name) == assets.quantity_of(
            own_input.output.value,
            pool.token_policy_id,
            pool.token_asset_name,
          )

        let new_datum = own_continuing_datum(self, own_ref)
        let expected_datum = Pool(StakingPoolDatum { ..pool, reward_root: new_root })

        and {
          list.has(self.extra_signatories, pool.governor_pub_key_hash),
          value_unchanged,
          new_datum == expected_datum,
        }
      }

      (Position(pos), Unstake) -> {
        expect Some(own_input) =
          list.find(self.inputs, fn(input) { input.output_reference == own_ref })

        // No claim of "no continuing output at this address" is needed or
        // wanted here — other position UTXOs at this same script address
        // may legitimately be spent/created in the same transaction (e.g.
        // a different staker unstaking concurrently). This position's own
        // safety only depends on ITS specific value reaching the staker,
        // checked below — not on the address's total output count.
        // T93/T115-class fix (2026-07-22) — same payment-credential-only
        // comparison as ClaimRewards above; see that branch's comment.
        let staker_credential = from_verification_key(pos.staker_vkh).payment_credential
        // Position UTXOs carry a launch-token policy the pool datum
        // doesn't record locally — verify by comparing the full
        // non-lovelace value (in practice exactly the one launch token)
        // rather than needing a policy id here.
        let staker_paid =
          list.any(
            self.outputs,
            fn(output) {
              output.address.payment_credential == staker_credential && assets.without_lovelace(
                output.value,
              ) == assets.without_lovelace(own_input.output.value)
            },
          )

        and {
          list.has(self.extra_signatories, pos.staker_vkh),
          pos.staked_amount > 0,
          staker_paid,
        }
      }

      // T109 CRITICAL fix (2026-07-19, full-suite security audit) — same
      // fix as bonding_curve.ak: was an unconditional `True` (zero checks),
      // an unconditional authorization over the pool's reward tokens or any
      // staker's locked position. See that file's own comment on this exact
      // line for the full explanation.
      (_, QueryState) -> False

      _ -> False
      },
    }
  }
}

// ============================================================================
// TESTS
// ============================================================================

fn mock_pool_datum() -> StakingPoolDatum {
  StakingPoolDatum {
    launch_id: #"01",
    governor_pub_key_hash: #"22",
    creator_pub_key_hash: #"11",
    token_policy_id: #"33",
    token_asset_name: "tok",
    reward_root: #"",
    claimed_so_far: [],
  }
}

fn mock_position_datum() -> StakingPositionDatum {
  StakingPositionDatum {
    launch_id: #"01",
    staker_vkh: #"dd",
    staked_amount: 500,
    stake_timestamp: 1000,
  }
}

test hash_reward_leaf_is_deterministic() {
  hash_reward_leaf(#"dd", 100) == hash_reward_leaf(#"dd", 100)
}

test hash_reward_leaf_differs_by_amount() {
  hash_reward_leaf(#"dd", 100) != hash_reward_leaf(#"dd", 101)
}

test verify_reward_merkle_proof_accepts_single_leaf_tree() {
  let leaf = hash_reward_leaf(#"dd", 100)
  verify_reward_merkle_proof(leaf, leaf, [])
}

test verify_reward_merkle_proof_accepts_real_proof_in_two_leaf_tree() {
  let leaf0 = hash_reward_leaf(#"dd", 100)
  let leaf1 = hash_reward_leaf(#"ee", 50)
  let root = hash_reward_node(leaf0, leaf1)
  let proof0 = [MerkleProofStep { sibling: leaf1, goes_left: False }]
  let proof1 = [MerkleProofStep { sibling: leaf0, goes_left: True }]
  and {
    verify_reward_merkle_proof(root, leaf0, proof0),
    verify_reward_merkle_proof(root, leaf1, proof1),
  }
}

test verify_reward_merkle_proof_rejects_tampered_sibling() {
  let leaf0 = hash_reward_leaf(#"dd", 100)
  let leaf1 = hash_reward_leaf(#"ee", 50)
  let root = hash_reward_node(leaf0, leaf1)
  let tampered_proof = [MerkleProofStep { sibling: #"ff", goes_left: False }]
  !verify_reward_merkle_proof(root, leaf0, tampered_proof)
}

test cumulative_claimed_empty_list() {
  cumulative_claimed([], #"dd") == 0
}

test cumulative_claimed_finds_existing() {
  cumulative_claimed([(#"dd", 40), (#"ee", 10)], #"dd") == 40
}

test update_claimed_inserts_new_entry() {
  update_claimed([], #"dd", 40) == [(#"dd", 40)]
}

test update_claimed_updates_existing_entry() {
  update_claimed([(#"dd", 40), (#"ee", 10)], #"dd", 100) == [(#"dd", 100), (#"ee", 10)]
}

test claim_rewards_succeeds_with_valid_proof_and_real_payout() {
  let leaf0 = hash_reward_leaf(#"dd", 100)
  let leaf1 = hash_reward_leaf(#"ee", 50)
  let root = hash_reward_node(leaf0, leaf1)
  let proof0 = [MerkleProofStep { sibling: leaf1, goes_left: False }]

  let pool = StakingPoolDatum { ..mock_pool_datum(), reward_root: root }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let staker_address = from_verification_key(#"dd")

  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000)),
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  let new_pool =
    Pool(StakingPoolDatum { ..pool, claimed_so_far: [(#"dd", 100)] })
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 900)),
      datum: InlineDatum(new_pool),
      reference_script: None,
    }
  let payout_output =
    Output {
      address: staker_address,
      value: assets.from_asset(#"33", "tok", 100),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, payout_output],
    }

  staking_pool.spend(
    Some(Pool(pool)),
    ClaimRewards { staker_vkh: #"dd", claimed_cumulative_amount: 100, merkle_proof: proof0 },
    own_ref,
    self,
  )
}

test claim_rewards_rejects_padded_pool_output() {
  // T81: identical to claim_rewards_succeeds_with_valid_proof_and_real_payout,
  // except the pool's own continuing output carries one extra, unrelated
  // junk asset. ClaimRewards is permissionless, so ANYONE could otherwise
  // pad this long-lived pool UTXO this way before the T81 fix.
  let leaf0 = hash_reward_leaf(#"dd", 100)
  let leaf1 = hash_reward_leaf(#"ee", 50)
  let root = hash_reward_node(leaf0, leaf1)
  let proof0 = [MerkleProofStep { sibling: leaf1, goes_left: False }]

  let pool = StakingPoolDatum { ..mock_pool_datum(), reward_root: root }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let staker_address = from_verification_key(#"dd")

  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000)),
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  let new_pool =
    Pool(StakingPoolDatum { ..pool, claimed_so_far: [(#"dd", 100)] })
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 900)),
        // Junk asset from an unrelated policy — the padding attack.
        assets.from_asset(#"deadbeef", "spam", 1),
      ),
      datum: InlineDatum(new_pool),
      reference_script: None,
    }
  let payout_output =
    Output {
      address: staker_address,
      value: assets.from_asset(#"33", "tok", 100),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, payout_output],
    }

  !staking_pool.spend(
    Some(Pool(pool)),
    ClaimRewards { staker_vkh: #"dd", claimed_cumulative_amount: 100, merkle_proof: proof0 },
    own_ref,
    self,
  )
}

test claim_rewards_fails_with_tampered_proof() {
  let leaf0 = hash_reward_leaf(#"dd", 100)
  let leaf1 = hash_reward_leaf(#"ee", 50)
  let root = hash_reward_node(leaf0, leaf1)
  let tampered_proof = [MerkleProofStep { sibling: #"ff", goes_left: False }]

  let pool = StakingPoolDatum { ..mock_pool_datum(), reward_root: root }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let staker_address = from_verification_key(#"dd")

  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000)),
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  let new_pool =
    Pool(StakingPoolDatum { ..pool, claimed_so_far: [(#"dd", 100)] })
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 900)),
      datum: InlineDatum(new_pool),
      reference_script: None,
    }
  let payout_output =
    Output {
      address: staker_address,
      value: assets.from_asset(#"33", "tok", 100),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, payout_output],
    }

  !staking_pool.spend(
    Some(Pool(pool)),
    ClaimRewards { staker_vkh: #"dd", claimed_cumulative_amount: 100, merkle_proof: tampered_proof },
    own_ref,
    self,
  )
}

test claim_rewards_fails_if_amount_not_greater_than_already_claimed() {
  let leaf = hash_reward_leaf(#"dd", 100)
  let pool = StakingPoolDatum { ..mock_pool_datum(), reward_root: leaf, claimed_so_far: [(#"dd", 100)] }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let staker_address = from_verification_key(#"dd")

  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000)),
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000)),
      datum: InlineDatum(Pool(pool)),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
    }

  !staking_pool.spend(
    Some(Pool(pool)),
    ClaimRewards { staker_vkh: #"dd", claimed_cumulative_amount: 100, merkle_proof: [] },
    own_ref,
    self,
  )
}

// T93/T115-class regression test: proves ClaimRewards now accepts a
// payout to the staker's real BASE address (payment + stake credential),
// not just the narrow bare-enterprise-address shape from_verification_key
// alone produces. Before this fix, this exact test would have failed.
test claim_rewards_succeeds_paying_a_real_base_address_not_just_enterprise() {
  let leaf0 = hash_reward_leaf(#"dd", 100)
  let leaf1 = hash_reward_leaf(#"ee", 50)
  let root = hash_reward_node(leaf0, leaf1)
  let proof0 = [MerkleProofStep { sibling: leaf1, goes_left: False }]

  let pool = StakingPoolDatum { ..mock_pool_datum(), reward_root: root }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let staker_base_address = from_verification_key(#"dd") |> with_delegation_key(#"aa")

  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000)),
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  let new_pool =
    Pool(StakingPoolDatum { ..pool, claimed_so_far: [(#"dd", 100)] })
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 900)),
      datum: InlineDatum(new_pool),
      reference_script: None,
    }
  let payout_output =
    Output {
      address: staker_base_address,
      value: assets.from_asset(#"33", "tok", 100),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, payout_output],
    }

  staking_pool.spend(
    Some(Pool(pool)),
    ClaimRewards { staker_vkh: #"dd", claimed_cumulative_amount: 100, merkle_proof: proof0 },
    own_ref,
    self,
  )
}

test top_up_pool_succeeds_with_creator_signature() {
  let pool = mock_pool_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")

  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000)),
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_500)),
      datum: InlineDatum(Pool(pool)),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"11"],
    }

  staking_pool.spend(Some(Pool(pool)), TopUpPool { amount: 500 }, own_ref, self)
}

test top_up_pool_rejects_padded_output() {
  // T81: identical to top_up_pool_succeeds_with_creator_signature, except
  // the pool's own continuing output carries one extra, unrelated junk
  // asset — even a legitimate creator top-up shouldn't be able to leave
  // junk in the long-lived pool.
  let pool = mock_pool_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")

  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000)),
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_500)),
        // Junk asset from an unrelated policy — the padding attack.
        assets.from_asset(#"deadbeef", "spam", 1),
      ),
      datum: InlineDatum(Pool(pool)),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"11"],
    }

  !staking_pool.spend(Some(Pool(pool)), TopUpPool { amount: 500 }, own_ref, self)
}

test top_up_pool_fails_without_creator_signature() {
  let pool = mock_pool_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")

  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000)),
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_500)),
      datum: InlineDatum(Pool(pool)),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
    }

  !staking_pool.spend(Some(Pool(pool)), TopUpPool { amount: 500 }, own_ref, self)
}

test publish_reward_root_succeeds_with_governor_signature() {
  let pool = mock_pool_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")

  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000)),
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  let new_pool = Pool(StakingPoolDatum { ..pool, reward_root: #"aabb" })
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000)),
      datum: InlineDatum(new_pool),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"22"],
    }

  staking_pool.spend(Some(Pool(pool)), PublishRewardRoot { new_root: #"aabb" }, own_ref, self)
}

test publish_reward_root_fails_if_value_changes() {
  let pool = mock_pool_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")

  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000)),
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  // Attempted drain disguised as a root update: value decreased.
  let new_pool = Pool(StakingPoolDatum { ..pool, reward_root: #"aabb" })
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1)),
      datum: InlineDatum(new_pool),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"22"],
    }

  !staking_pool.spend(Some(Pool(pool)), PublishRewardRoot { new_root: #"aabb" }, own_ref, self)
}

test unstake_succeeds_with_staker_signature_and_real_payout() {
  let pos = mock_position_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let staker_address = from_verification_key(#"dd")

  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 500)),
        datum: InlineDatum(Position(pos)),
        reference_script: None,
      },
    }
  let payout_output =
    Output {
      address: staker_address,
      value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 500)),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [payout_output],
      extra_signatories: [#"dd"],
    }

  staking_pool.spend(Some(Position(pos)), Unstake, own_ref, self)
}

// T93/T115-class regression test: proves Unstake now accepts a payout to
// the staker's real BASE address, not just a bare enterprise address.
test unstake_succeeds_paying_a_real_base_address_not_just_enterprise() {
  let pos = mock_position_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let staker_base_address = from_verification_key(#"dd") |> with_delegation_key(#"aa")

  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 500)),
        datum: InlineDatum(Position(pos)),
        reference_script: None,
      },
    }
  let payout_output =
    Output {
      address: staker_base_address,
      value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 500)),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [payout_output],
      extra_signatories: [#"dd"],
    }

  staking_pool.spend(Some(Position(pos)), Unstake, own_ref, self)
}

test unstake_fails_without_staker_signature() {
  let pos = mock_position_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let staker_address = from_verification_key(#"dd")

  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 500)),
        datum: InlineDatum(Position(pos)),
        reference_script: None,
      },
    }
  let payout_output =
    Output {
      address: staker_address,
      value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 500)),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [payout_output],
    }

  !staking_pool.spend(Some(Position(pos)), Unstake, own_ref, self)
}

// T109: QueryState previously authorized ANY spend unconditionally
// (`(_, QueryState) -> True`, zero checks) — a complete, unauthenticated
// drain of the pool's reward tokens. Proves the fix.
test query_state_rejects_unauthenticated_pool_drain_attempt() {
  let pool = mock_pool_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let attacker_address = from_verification_key(#"ee")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(2_000_000),
          assets.from_asset(#"33", "tok", 10_000),
        ),
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  let drain_output =
    Output {
      address: attacker_address,
      value: assets.merge(
        assets.from_lovelace(2_000_000),
        assets.from_asset(#"33", "tok", 10_000),
      ),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction { ..transaction.placeholder, inputs: [own_input], outputs: [drain_output] }

  !staking_pool.spend(Some(Pool(pool)), QueryState, own_ref, self)
}

// Regression test: the value-conservation case verified against the full
// security audit — combining Unstake (Position, 500 tok, staker-signed)
// and ClaimRewards (Pool, 100 tok pending, permissionless) in ONE
// transaction, with a single 500-tok output to the staker attempting to
// satisfy BOTH checks at once (Unstake's exact-match AND ClaimRewards'
// >=100 threshold), while the real 100-tok reward is diverted to a third
// party. Proves this is now rejected — two inputs at the shared
// staking_pool.ak address in one transaction violates single_own_utxo.
test claim_rewards_rejects_combined_with_unstake_same_tx() {
  let pos = mock_position_datum()
  let leaf0 = hash_reward_leaf(#"dd", 100)
  let leaf1 = hash_reward_leaf(#"ee", 50)
  let root = hash_reward_node(leaf0, leaf1)
  let proof0 = [MerkleProofStep { sibling: leaf1, goes_left: False }]
  let pool = StakingPoolDatum { ..mock_pool_datum(), reward_root: root }
  let own_address = from_verification_key(#"cc")
  let staker_address = from_verification_key(#"dd")
  let attacker_address = from_verification_key(#"ee")

  let position_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let position_input =
    Input {
      output_reference: position_ref,
      output: Output {
        address: own_address,
        value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 500)),
        datum: InlineDatum(Position(pos)),
        reference_script: None,
      },
    }
  let pool_ref = OutputReference { transaction_id: #"00", output_index: 1 }
  let pool_input =
    Input {
      output_reference: pool_ref,
      output: Output {
        address: own_address,
        value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000)),
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  let new_pool = Pool(StakingPoolDatum { ..pool, claimed_so_far: [(#"dd", 100)] })
  let pool_continuing_output =
    Output {
      address: own_address,
      value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 900)),
      datum: InlineDatum(new_pool),
      reference_script: None,
    }
  // Only the staker's own 500-tok unstake payout — no separate output for
  // the 100-tok reward at all. The real reward goes to the attacker.
  let combined_payout =
    Output {
      address: staker_address,
      value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 500)),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let diverted_reward =
    Output {
      address: attacker_address,
      value: assets.from_asset(#"33", "tok", 100),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [position_input, pool_input],
      outputs: [pool_continuing_output, combined_payout, diverted_reward],
      extra_signatories: [#"dd"],
    }

  !staking_pool.spend(
    Some(Pool(pool)),
    ClaimRewards { staker_vkh: #"dd", claimed_cumulative_amount: 100, merkle_proof: proof0 },
    pool_ref,
    self,
  )
}
