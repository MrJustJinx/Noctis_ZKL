// ============================================================================
// Noctis Protocol — Cardano L1 Bonding Curve Contract (Aiken)
// Tier B — public phase only
// ============================================================================
// T24 resolution (2026-07-09): Tier B's public bonding curve moved from a
// Midnight PSM to Cardano/Aiken entirely. Reasoning: the public phase is,
// by definition, public — nothing about price, amounts, or cap status
// needs Midnight's privacy once DarkVeil closes. Cardano already proved it
// can do real quadratic curve math AND real payment enforcement natively
// (see bonding_curve.ak, Tier A) with no bridge at all. Keeping the public
// curve on Midnight would have needed a NEW relayer/oracle just so
// `buyTokens` could learn a Cardano payment happened — worse than the
// bridge this file avoids by existing. Only DarkVeil's private
// registration/buying phase stays on Midnight, in
// contracts/midnight/eligibility_gate.compact — the standalone
// darkveil.compact this note originally pointed to was retired and merged
// into eligibility_gate.compact during the Phase 2 security-audit pass
// (2026-07-11); it no longer exists as a separate file.
//
// What stayed the same as bonding_curve.compact's quadratic design:
//   Price formula: price = base_price + k * sold^2
//     where k = (max_price - base_price) / curve_supply^2
//   Same k for both Tier B and Tier C (Jinx's explicit call, unchanged by
//   this move) — this file and bonding_curve.compact (now Tier C only)
//   verify the identical formula, just in two different languages.
//
// What's different from Tier A's bonding_curve.ak:
//   - Quadratic pricing, not linear (see verify_price below)
//   - `identity_purchases` is a cumulative-cap tracker shared by BOTH the
//     DarkVeil claim path (ClaimDarkVeilTokens) and the public path
//     (BuyTokens). This is what makes Tier B's cap "strong" (per
//     CLAUDE.md) relative to Tier A's "weak" one: a DarkVeil registrant's
//     ZK-vetted allocation carries forward and cannot be re-spent fresh on
//     the public phase. A buyer who never went through DarkVeil just
//     starts at 0 here, same as Tier A.
//
// T46/privacy fix (2026-07-11): the ORIGINAL version of this file
// pre-seeded `identity_purchases` at deploy with every registrant's
// `(cardano_vkh, dv_cumulative_amount)` pair, in plaintext, in the public
// datum — regardless of whether that wallet ever claimed or transacted
// again. That directly contradicted CLAUDE.md's Fair Launch Certificate
// promise ("Private forever: Individual wallet addresses, Individual buy
// amounts") and, separately, never actually delivered tokens or charged
// ADA for a DarkVeil purchase at all — the pre-seed only ever fed the cap
// check, not a real settlement. Both problems are fixed together:
//   - `identity_purchases` now starts EMPTY at deploy. An entry only ever
//     appears for a wallet once THAT wallet transacts (claims its DV
//     allocation or buys publicly) — never published for the full
//     registrant roster up front.
//   - `dv_allocation_root` replaces the plaintext pre-seed: a Merkle root
//     over `(vkh, dv_amount, salt)` leaves, computed off-chain from
//     eligibility_gate.compact's private `cumulativePurchases` map and
//     anchored once at DarkVeil close by the platform relayer (same
//     relayer/trust pattern already used for the ZK Fair Launch
//     Certificate, T21 — not a new trust dependency).
//   - The new `ClaimDarkVeilTokens` redeemer lets a DV buyer settle their
//     private purchase for real: they present their own `(dv_amount,
//     salt, merkle_proof)` — known only to them — pay `dv_amount *
//     base_price` in real ADA (the flat DarkVeil price, same pattern as
//     `payment_received` below), receive the tokens
//     (`token_delivered`/`curve_token_balance_decreased`), and are marked
//     in `dv_claimed` so the same allocation can't be claimed twice.
//     Nobody's DV amount is ever visible on-chain unless and until that
//     specific wallet claims — and even then, only their own amount is
//     ever revealed, mirroring the nullifier pattern already used
//     elsewhere in this codebase (a spend reveals the spender's own data,
//     never anyone else's).
//   - T25 (cross-PSM cumulative cap tracking) is still resolved as a side
//     effect: there is no cross-PSM call at buy OR claim time. The DV
//     allocation crosses exactly once, at DarkVeil close, as a single
//     Merkle root — not a per-registrant list, and not on every buy.
//
// T49 fix (2026-07-10): same graduation gap as Tier A — `Graduated` was
// just a state flag with no redeemer moving the raised ADA or LP token
// reserve into lp_escrow.ak. Added the identical `Graduate` redeemer
// (permissionless, verified by real value movement, not a signature) and
// the identical `curve_token_balance_decreased` bonus fix to BuyTokens —
// see bonding_curve.ak's header for the full reasoning on both; not
// repeated here since the mechanism is byte-for-byte the same, just typed
// against BondingCurveTierBDatum instead.
// ============================================================================

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash, blake2b_256}
use aiken/interval
use aiken/interval.{Interval, IntervalBoundType}
use aiken/primitive/bytearray
use cardano/address.{Address, Credential, from_verification_key, with_delegation_key}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{Input, InlineDatum, Output, OutputReference, Transaction}
use cto_governance.{
  CtoGovernanceDatum, DissolveCTOProposal, Executed, Passed, PreCTO,
  ProposalAnchor, ProposalType, SilenceLockTrigger,
}

/// T90: same finding/fix as Tier A's bonding_curve.ak — see that file's
/// own comment on `validity_range_is_narrow` for the full explanation.
fn validity_range_is_narrow(range: Interval, max_width: Int) -> Bool {
  when (range.lower_bound.bound_type, range.upper_bound.bound_type) is {
    (IntervalBoundType.Finite(lo), IntervalBoundType.Finite(hi)) ->
      hi >= lo && hi - lo <= max_width
    _ -> False
  }
}

const max_validity_range_width = 600_000

// ============================================================================
// TYPES
// ============================================================================

pub type CurveState {
  Inactive
  Active
  Graduated
  Cancelled
}

/// One step of a Merkle inclusion proof — same `(sibling, direction)` shape
/// already used by the Compact contracts' allowlist/balance-snapshot
/// proofs, just typed for Aiken instead.
pub type MerkleProofStep {
  sibling: ByteArray,
  goes_left: Bool,
}

pub type BondingCurveTierBDatum {
  launch_id: ByteArray,
  creator_pub_key_hash: VerificationKeyHash,
  governor_pub_key_hash: VerificationKeyHash,
  base_price: Int,
  max_price: Int,
  curve_supply: Int,
  curve_state: CurveState,
  // Posix time (seconds) the curve was activated — 0 while still
  // Inactive. Used by ExpireCurve (T29) to detect a stalled curve.
  activated_at: Int,
  tokens_sold: Int,
  total_raised: Int,
  creator_fees_accrued: Int,
  treasury_fees_accrued: Int,
  ops_fees_accrued: Int,
  // 5% of curve_supply — same wallet_cap semantics as Tier A, just applied
  // to a list that may already carry a DarkVeil claim per entry.
  wallet_cap: Int,
  // Starts EMPTY at deploy (T46/privacy fix, 2026-07-11) — an entry only
  // appears once a wallet actually transacts (ClaimDarkVeilTokens or
  // BuyTokens), never pre-published for the full registrant roster. See
  // file header.
  identity_purchases: List<(VerificationKeyHash, Int)>,
  // Merkle root over `(vkh, dv_amount, salt)` leaves, anchored once by the
  // relayer at DarkVeil close (T46/privacy fix). Lets ClaimDarkVeilTokens
  // verify a private allocation without ever publishing the full list.
  dv_allocation_root: ByteArray,
  // Nullifier set: wallets that have already claimed their DarkVeil
  // allocation, so the same allocation can't be claimed twice.
  dv_claimed: List<VerificationKeyHash>,
  // T112 fix (2026-07-19, Tier B cross-chain audit): whether
  // dv_allocation_root has been anchored to a real, governor-computed
  // value yet. Starts False at genesis (real value unknown at mint time —
  // DarkVeil hasn't even opened yet). Set True only by the new
  // AnchorDvAllocationRoot redeemer, and required True by ActivateCurve —
  // closes the gap where dv_allocation_root previously had NO on-chain
  // write path at all, meaning ClaimDarkVeilTokens could never succeed for
  // any real buyer. A dedicated Bool rather than comparing against a
  // placeholder byte value — avoids any ambiguity about what counts as
  // "still unset." See file header and internal tracking.
  dv_settled: Bool,
  token_policy_id: PolicyId,
  token_asset_name: AssetName,
  // T49: same LP graduation fields as Tier A's bonding_curve.ak — see that
  // file's datum comment for the full reasoning.
  lp_escrow_credential: Credential,
  lp_reserve_tokens: Int,
  lp_seeded: Bool,
  // CTO fee-redirect fix (2026-07-12): same as Tier A's bonding_curve.ak —
  // once a CTO passes, ClaimCreatorFees redirects to the community wallet.
  // Mirrors lp_escrow.ak's cto_triggered/community_wallet_hash (T13).
  community_pub_key_hash: VerificationKeyHash,
  cto_triggered: Bool,
  // Staking Rewards Pool (T66, 2026-07-14): optional per-launch feature —
  // same fields and Graduate-time seeding semantics as Tier A's
  // bonding_curve.ak. See that file's datum comment for the full reasoning.
  staking_enabled: Bool,
  staking_pool_credential: Credential,
  staking_reserve_tokens: Int,
  staking_seeded: Bool,
  // T-CTO-ENFORCE fix: cto_governance.ak's own fixed script address, set
  // at genesis — same pattern as Tier A's bonding_curve.ak; see that
  // file's doc comment for the full reasoning. Needed because
  // TriggerCTO/DissolveCTO below now require real reference-input
  // evidence a vote actually passed, instead of trusting a bare governor
  // signature.
  cto_governance_credential: Credential,
  // C-1 fix (2026-07-23 audit): governance THREAD NFT policy id — see the
  // full doc comment on Tier A's bonding_curve.ak. cto_vote_verified now
  // requires the referenced governance UTXO to carry this NFT
  // (asset_name = launch_id), closing the forge-a-fake-governance-UTXO gap.
  cto_governance_nft: PolicyId,
}

pub type BondingCurveTierBRedeemer {
  /// `current_timestamp` stamped into `activated_at`, verified against the
  /// tx's validity range (T29, same pattern as Tier A).
  ActivateCurve { current_timestamp: Int }
  BuyTokens {
    token_amount: Int,
    claimed_price: Int,
    gross_payment: Int,
    claimed_creator_fee: Int,
    claimed_treasury_fee: Int,
    claimed_ops_fee: Int,
    buyer_key_hash: VerificationKeyHash,
  }
  /// T46/privacy fix (2026-07-11): settles a private DarkVeil purchase for
  /// real — charges the flat DV price in ADA, delivers the tokens, and
  /// consumes the buyer's own Merkle leaf without ever revealing anyone
  /// else's allocation. See file header.
  ClaimDarkVeilTokens {
    dv_amount: Int,
    salt: ByteArray,
    merkle_proof: List<MerkleProofStep>,
    claimed_creator_fee: Int,
    claimed_treasury_fee: Int,
    claimed_ops_fee: Int,
    buyer_key_hash: VerificationKeyHash,
  }
  /// T108 fix (2026-07-21): (1) previously only the datum counter was
  /// checked — no verification that real lovelace ever left the curve's
  /// UTXO and reached the claimer, an identical gap to Tier A's T107,
  /// letting the signer drain the ENTIRE curve balance (buyers' principal
  /// included) while the datum showed only a small decrement. Fixed via
  /// the same real-value-movement discipline every other value-moving
  /// redeemer in this file already uses (`payment_received`,
  /// `buyback_share_paid`, `graduation_funds_left_curve`). (2) New
  /// `platform_claim_fee` — ported for parity with Tier A's T107 fix
  /// (confirmed 2026-07-21): a real, on-chain-enforced flat charge (in
  /// addition to `amount`, paid INTO the curve, not out of it), split
  /// 40/60 ops/treasury into the existing `ops_fees_accrued`/
  /// `treasury_fees_accrued` accumulators. Same deliberately conservative
  /// sanity-floor approach as Tier A (no in-circuit oracle access) — see
  /// `min_platform_claim_fee_lovelace`'s own comment.
  ClaimCreatorFees { amount: Int, platform_claim_fee: Int }
  /// T108 fix: same missing value-conservation gap as ClaimCreatorFees,
  /// fixed the same way — no new fee added here (the governor is claiming
  /// treasury's OWN existing accrual, not paying a new platform charge).
  ClaimTreasuryFees { amount: Int }
  /// T108 fix: same as ClaimTreasuryFees.
  ClaimOpsFees { amount: Int }
  CancelCurve
  /// Permissionless force-cancel once Active for longer than
  /// `max_curve_duration` without reaching Graduated (T29) — same idiom
  /// as Tier A's ExpireCurve.
  ExpireCurve { current_timestamp: Int }
  /// Pro-rata buyback (T48) — same mechanism as Tier A's ClaimBuyback.
  ClaimBuyback { token_amount: Int, buyer_key_hash: VerificationKeyHash }
  /// T49: seed the LP once Graduated — same mechanism as Tier A's Graduate.
  Graduate
  /// CTO fee-redirect fix (2026-07-12) — same mechanism as Tier A's
  /// bonding_curve.ak.
  TriggerCTO { community_pub_key_hash: VerificationKeyHash }
  DissolveCTO
  /// T112 fix (2026-07-19, Tier B cross-chain audit): anchors the real
  /// dv_allocation_root computed off-chain by the governor from
  /// eligibility_gate.compact's dvTokensPurchased map, once DarkVeil has
  /// closed on Midnight. Governor-signed — same trust boundary as
  /// ActivateCurve; no open-relay/censorship-resistance need here, unlike
  /// cto_governance.ak's AnchorVoteResult (T111), since there's no
  /// community vote this value could be used to suppress. Gated on
  /// curve_state == Inactive, so it can only run before public trading
  /// opens and can be safely re-called (overwriting a mistaken root) any
  /// number of times while still Inactive — ClaimDarkVeilTokens itself
  /// requires curve_state == Active, so no claim could ever have processed
  /// against a not-yet-final root. See file header and
  /// internal tracking.
  AnchorDvAllocationRoot { dv_allocation_root: ByteArray }
  QueryState
}

// ============================================================================
// CONSTANTS
// ============================================================================

/// Fee split in basis points (10000 = 100%) — 1.0% / 0.6% / 0.4% = 2.0% total,
/// identical to Tier A and Tier C.
const creator_bps = 100

const treasury_bps = 60

const ops_bps = 40

const bps_denominator = 10_000

/// T108 fix (2026-07-21): ported verbatim from Tier A's bonding_curve.ak
/// (T107) — deliberately conservative SANITY FLOOR for ClaimCreatorFees's
/// new platform_claim_fee, not a precise $1 peg (Aiken has no in-circuit
/// oracle access). 0.2 ADA comfortably undershoots $1's real ADA value
/// across ADA's entire realistic historical trading range; the real
/// $1-equivalent is computed off-chain via the same usdToMinAdaLovelace()
/// Orcfax oracle Tier A uses, paid with margin above this floor in the
/// normal case.
const min_platform_claim_fee_lovelace = 200_000

/// T108 fix: 40/60 ops/treasury split for platform_claim_fee — same ratio
/// as Tier A's identical constants and every other fee split in this
/// codebase (TIER_B_OPS_PCT/TIER_B_TREASURY_PCT,
/// STAKING_CLAIM_FEE_OPS_PCT/STAKING_CLAIM_FEE_TREASURY_PCT). Deliberately
/// separate from creator_bps/treasury_bps/ops_bps above, which split the
/// 2% TRADE fee, not this flat claim fee — different denominators, same
/// bps_denominator by coincidence only.
const platform_fee_ops_bps = 4_000

const platform_fee_treasury_bps = 6_000

/// 90 days in MILLISECONDS — same T29 default and rationale as Tier A's
/// bonding_curve.ak.
///
/// T89 fix (2026-07-17): same bug, same fix, as Tier A's bonding_curve.ak
/// own `max_curve_duration` (T87) — this file's `ActivateCurve`/
/// `ExpireCurve` bind `current_timestamp`/`activated_at` to
/// `interval.contains(self.validity_range, ...)` identically, so the same
/// ms-vs-seconds mismatch applied here too, never separately checked when
/// T87 was fixed. Found during Phase 5b research.
const max_curve_duration = 7_776_000_000

// ============================================================================
// HELPERS
// ============================================================================

/// Leaf hash for a DarkVeil allocation: `blake2b_256(vkh || dv_amount_16be
/// || salt)`. `salt` is chosen off-chain per registrant so the leaf can't
/// be brute-forced from a guessed `(vkh, dv_amount)` pair alone — the same
/// role a nonce plays in the Compact contracts' commitment schemes.
fn hash_dv_leaf(vkh: VerificationKeyHash, dv_amount: Int, salt: ByteArray) -> ByteArray {
  blake2b_256(
    bytearray.concat(
      bytearray.concat(vkh, bytearray.from_int_big_endian(dv_amount, 16)),
      salt,
    ),
  )
}

/// Internal Merkle node hash: `blake2b_256(left || right)`.
fn hash_dv_node(left: ByteArray, right: ByteArray) -> ByteArray {
  blake2b_256(bytearray.concat(left, right))
}

/// Verify `leaf` is included under `root` via `proof` — walks bottom-up,
/// folding each sibling in on the side its `goes_left` flag indicates.
/// Proof length is whatever depth the off-chain tree actually has (no
/// fixed-depth padding needed — unlike Compact's 32-level Merkle proofs,
/// Aiken has no `fold`-only-fixed-loop-count constraint to work around).
fn verify_dv_merkle_proof(
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
          hash_dv_node(step.sibling, acc)
        } else {
          hash_dv_node(acc, step.sibling)
        }
      },
    )
  computed == root
}

/// Verify the claimed price is the FLOOR of the true quadratic curve value,
/// via cross-multiplication (no division on-chain):
///   claimed_price * supply^2 <= base_price*supply^2 + price_range*sold^2
///                             < (claimed_price + 1) * supply^2
///
/// Same floor-rounding double-inequality as bonding_curve.compact's
/// verifyPrice (T39's fix) — Aiken's `Int` is arbitrary-precision, so unlike
/// the Compact version this needs none of that file's narrow-Uint bit-
/// budgeting; the inequality itself is what matters, not the width tricks
/// that were only necessary to keep Compact's non-Field multiplication
/// under its 124-bit ceiling.
fn verify_price(datum: BondingCurveTierBDatum, sold: Int, claimed_price: Int) -> Bool {
  let price_range = datum.max_price - datum.base_price
  let supply_squared = datum.curve_supply * datum.curve_supply
  let sold_squared = sold * sold
  let true_value_times_supply_squared =
    datum.base_price * supply_squared + price_range * sold_squared
  let claimed_times_supply_squared = claimed_price * supply_squared
  and {
    claimed_times_supply_squared <= true_value_times_supply_squared,
    true_value_times_supply_squared < claimed_times_supply_squared + supply_squared,
  }
}

/// Verify a claimed fee slice is the FLOOR of gross_payment * bps / 10000,
/// via cross-multiplication:
///   claimed_fee * 10000 <= gross_payment * bps < (claimed_fee + 1) * 10000
fn verify_fee_slice(gross_payment: Int, bps: Int, claimed_fee: Int) -> Bool {
  and {
    claimed_fee * bps_denominator <= gross_payment * bps,
    gross_payment * bps < (claimed_fee + 1) * bps_denominator,
  }
}

/// Look up a wallet's cumulative purchase total (0 if not found) — may
/// already be non-zero at first public buy, if this key was pre-seeded
/// from a DarkVeil allocation.
fn cumulative_purchases(
  purchases: List<(VerificationKeyHash, Int)>,
  key_hash: VerificationKeyHash,
) -> Int {
  when purchases is {
    [] -> 0
    [(k, amount), ..rest] ->
      if k == key_hash {
        amount
      } else {
        cumulative_purchases(rest, key_hash)
      }
  }
}

/// Update (or insert) a wallet's cumulative purchase total
fn update_purchases(
  purchases: List<(VerificationKeyHash, Int)>,
  key_hash: VerificationKeyHash,
  new_total: Int,
) -> List<(VerificationKeyHash, Int)> {
  when purchases is {
    [] -> [(key_hash, new_total)]
    [(k, amount), ..rest] ->
      if k == key_hash {
        [(k, new_total), ..rest]
      } else {
        [(k, amount), ..update_purchases(rest, key_hash, new_total)]
      }
  }
}

/// Find this validator's own continuing output and decode its inline datum.
fn own_continuing_datum(
  self: Transaction,
  own_ref: OutputReference,
) -> BondingCurveTierBDatum {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  expect InlineDatum(raw_datum) = own_output.datum
  expect new_datum: BondingCurveTierBDatum = raw_datum
  new_datum
}

/// T-CTO-ENFORCE fix: real evidence a vote actually passed, replacing a
/// bare governor signature — same mechanism and reasoning as Tier A's
/// bonding_curve.ak's own cto_vote_verified (see that file's doc comment
/// for the full explanation).
fn cto_vote_verified(
  self: Transaction,
  datum: BondingCurveTierBDatum,
  proposal_type: ProposalType,
  expected_recipient: Option<VerificationKeyHash>,
) -> Bool {
  expect Some(cto_ref_input) =
    list.find(
      self.reference_inputs,
      fn(input) {
        input.output.address.payment_credential == datum.cto_governance_credential
      },
    )
  expect InlineDatum(cto_raw_datum) = cto_ref_input.output.datum
  expect cto_datum: CtoGovernanceDatum = cto_raw_datum
  expect Some(executed) = cto_datum.last_executed_proposal

  let recipient_ok = when expected_recipient is {
    Some(recipient) -> executed.allocation_recipient_hash == recipient
    None -> True
  }

  and {
    // C-1 fix (2026-07-23 audit): the referenced governance UTXO must carry
    // the genuine per-launch governance thread NFT (policy =
    // datum.cto_governance_nft, asset_name = launch_id). WITHOUT this,
    // list.find above trusts the UTXO by ADDRESS ALONE — and anyone can
    // create a UTXO at cto_governance_credential carrying a forged
    // governance datum claiming a passed, executed outcome
    // datum, because paying to a script address never runs its validator
    // and this reference input is never spent (no validator runs on it).
    // The NFT is minted once at governance setup under a governor-signature
    // policy (no attacker can mint it) and preserved in cto_governance.ak's
    // continuing output on every spend, so only the real governance UTXO
    // can ever carry it.
    assets.quantity_of(cto_ref_input.output.value, datum.cto_governance_nft, datum.launch_id) == 1,
    cto_datum.launch_id == datum.launch_id,
    executed.proposal_type == proposal_type,
    executed.outcome == Passed,
    executed.execution_status == Executed,
    recipient_ok,
  }
}

/// Verify the buyer's `gross_payment` lovelace actually increased the
/// validator's own continuing output by exactly that amount — same real
/// payment-enforcement pattern as Tier A's bonding_curve.ak (T40).
fn payment_received(
  self: Transaction,
  own_ref: OutputReference,
  gross_payment: Int,
) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  assets.lovelace_of(own_output.value) == assets.lovelace_of(own_input.output.value) + gross_payment
}

/// Verify the buyer receives token_amount of the launch token in some output
fn token_delivered(
  self: Transaction,
  datum: BondingCurveTierBDatum,
  token_amount: Int,
) -> Bool {
  list.any(
    self.outputs,
    fn(output: Output) {
      assets.quantity_of(output.value, datum.token_policy_id, datum.token_asset_name) == token_amount
    },
  )
}

/// Bonus fix found while designing T49 (2026-07-10) — same as Tier A's
/// bonding_curve.ak: verify the curve's OWN reserve actually shrinks by
/// token_amount, not just that some output claims to hold it. See that
/// file's comment on the equivalent helper for the full reasoning.
fn curve_token_balance_decreased(
  self: Transaction,
  own_ref: OutputReference,
  datum: BondingCurveTierBDatum,
  token_amount: Int,
) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  assets.quantity_of(
    own_input.output.value,
    datum.token_policy_id,
    datum.token_asset_name,
  ) == assets.quantity_of(
    own_output.value,
    datum.token_policy_id,
    datum.token_asset_name,
  ) + token_amount
}

/// T81: same fix, same reasoning, as Tier A's bonding_curve.ak — see that
/// file's comment on output_value_clean for the full rationale (MeshJS's
/// escrow.ak names this the "unbounded value vulnerability").
fn output_value_clean(output: Output, max_assets: Int) -> Bool {
  list.length(assets.flatten(output.value)) <= max_assets
}

fn curve_own_output_clean(self: Transaction, own_ref: OutputReference) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  output_value_clean(own_output, 2)
}

/// T111 fix (2026-07-19, full-suite security audit) — same fix, same
/// reasoning, as Tier A's bonding_curve.ak: closes a double-satisfaction
/// risk since every Tier B launch's curve shares this one fixed,
/// unparameterized script address. See that file's own comment on this
/// exact helper for the full explanation.
fn single_own_utxo(self: Transaction, own_address: Address) -> Bool {
  list.length(list.filter(self.inputs, fn(input) { input.output.address == own_address })) <= 1 && list.length(
    list.filter(self.outputs, fn(output) { output.address == own_address }),
  ) <= 1
}

/// T48: same buyback helpers as Tier A's bonding_curve.ak.
fn buyback_tokens_returned(
  self: Transaction,
  own_ref: OutputReference,
  datum: BondingCurveTierBDatum,
  token_amount: Int,
) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  assets.quantity_of(own_output.value, datum.token_policy_id, datum.token_asset_name) == assets.quantity_of(
    own_input.output.value,
    datum.token_policy_id,
    datum.token_asset_name,
  ) + token_amount
}

/// T93/T115 fix (2026-07-22): previously compared the FULL output address
/// against `from_verification_key(buyer_key_hash)` — a bare enterprise
/// address, not the buyer's real base address (T93's original Tier A
/// finding; confirmed to apply byte-for-byte identically here, T115).
/// Fixed to compare only the payment credential — same idiom this file
/// already uses for lp_escrow_credential/staking_pool_credential/
/// cto_governance_credential checks.
fn buyback_share_paid(
  self: Transaction,
  own_ref: OutputReference,
  buyer_key_hash: VerificationKeyHash,
  share: Int,
) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  let curve_decreased_by_share =
    assets.lovelace_of(own_input.output.value) == assets.lovelace_of(own_output.value) + share
  let buyer_credential = from_verification_key(buyer_key_hash).payment_credential
  let buyer_paid =
    list.any(
      self.outputs,
      fn(output) {
        output.address.payment_credential == buyer_credential && assets.lovelace_of(
          output.value,
        ) >= share
      },
    )
  curve_decreased_by_share && buyer_paid
}

/// T108 fix (2026-07-21): ported from Tier A's bonding_curve.ak — real
/// value-conservation check for a single-direction curve payout (money
/// only leaves, nothing comes in). Used by ClaimTreasuryFees/ClaimOpsFees
/// below; ClaimCreatorFees needs a different two-way check since
/// platform_claim_fee also flows IN — see that redeemer's own comment.
///
/// T93/T115 fix (2026-07-22): same payment-credential-only fix as
/// buyback_share_paid above — this was ported from Tier A's now-fixed
/// lovelace_paid_from_curve, so it inherited the identical bug at
/// port time (T108 predates the T93/T115 fix).
fn lovelace_paid_from_curve(
  self: Transaction,
  own_ref: OutputReference,
  recipient_key_hash: VerificationKeyHash,
  share: Int,
) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  let curve_decreased_by_share =
    assets.lovelace_of(own_input.output.value) == assets.lovelace_of(own_output.value) + share
  let recipient_credential = from_verification_key(recipient_key_hash).payment_credential
  let recipient_paid =
    list.any(
      self.outputs,
      fn(output) {
        output.address.payment_credential == recipient_credential && assets.lovelace_of(
          output.value,
        ) >= share
      },
    )
  curve_decreased_by_share && recipient_paid
}

/// T49: same graduation helpers as Tier A's bonding_curve.ak.
fn graduation_funds_left_curve(
  self: Transaction,
  own_ref: OutputReference,
  datum: BondingCurveTierBDatum,
  lp_ada: Int,
) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  let lovelace_ok =
    assets.lovelace_of(own_input.output.value) == assets.lovelace_of(own_output.value) + lp_ada
  // T66: staking_reserve_tokens leaves the curve alongside lp_reserve_tokens
  // in the same Graduate transaction, when the launch opted in (0 otherwise).
  let tokens_leaving = datum.lp_reserve_tokens + datum.staking_reserve_tokens
  let tokens_ok =
    assets.quantity_of(
      own_input.output.value,
      datum.token_policy_id,
      datum.token_asset_name,
    ) == assets.quantity_of(
      own_output.value,
      datum.token_policy_id,
      datum.token_asset_name,
    ) + tokens_leaving
  lovelace_ok && tokens_ok
}

/// The identity currently allowed to claim creator fees — same
/// active_fee_recipient pattern as Tier A's bonding_curve.ak and
/// lp_escrow.ak's T13 (CTO fee-redirect fix, 2026-07-12).
fn active_fee_recipient(datum: BondingCurveTierBDatum) -> VerificationKeyHash {
  if datum.cto_triggered {
    datum.community_pub_key_hash
  } else {
    datum.creator_pub_key_hash
  }
}

/// T88 fix (2026-07-17): same bug, same fix, as Tier A's bonding_curve.ak
/// own `lp_seeding_output_ok` — see that file's comment for the full
/// on-chain-reproduced/aiken-tx-simulate-isolated/unit-test-confirmed
/// explanation. Exact lovelace equality against `lp_ada` alone can never
/// be satisfied against a real, already-funded lp_escrow genesis UTXO;
/// `>=` is correct since `graduation_funds_left_curve`/`lp_value_received`
/// already enforce the exact amounts on each side independently.
fn lp_seeding_output_ok(
  self: Transaction,
  datum: BondingCurveTierBDatum,
  lp_ada: Int,
) -> Bool {
  list.any(
    self.outputs,
    fn(output) {
      output.address.payment_credential == datum.lp_escrow_credential && assets.lovelace_of(
        output.value,
      ) >= lp_ada && assets.quantity_of(
        output.value,
        datum.token_policy_id,
        datum.token_asset_name,
      ) == datum.lp_reserve_tokens && output_value_clean(output, 2)
    },
  )
}

/// T66: same staking_seeding_output_ok pattern as Tier A's bonding_curve.ak.
fn staking_seeding_output_ok(
  self: Transaction,
  datum: BondingCurveTierBDatum,
) -> Bool {
  if !datum.staking_enabled {
    True
  } else {
    list.any(
      self.outputs,
      fn(output) {
        output.address.payment_credential == datum.staking_pool_credential && assets.quantity_of(
          output.value,
          datum.token_policy_id,
          datum.token_asset_name,
        ) == datum.staking_reserve_tokens && output_value_clean(output, 2)
      },
    )
  }
}

// ============================================================================
// MAIN VALIDATOR
// ============================================================================

validator bonding_curve_tier_b {
  spend(
    datum_opt: Option<BondingCurveTierBDatum>,
    redeemer: BondingCurveTierBRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(datum) = datum_opt
    expect Some(own_input) =
      list.find(self.inputs, fn(input) { input.output_reference == own_ref })

    and {
      // T111: see single_own_utxo's own doc comment — closes the
      // double-satisfaction risk for every redeemer below in one place.
      single_own_utxo(self, own_input.output.address),
      when redeemer is {
        ActivateCurve { current_timestamp } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          list.has(self.extra_signatories, datum.governor_pub_key_hash),
          datum.curve_state == Inactive,
          // T112 fix: cannot open public trading until the real
          // dv_allocation_root has been anchored (AnchorDvAllocationRoot
          // below) — closes the gap where a launch could go public with
          // DarkVeil claims permanently broken with no on-chain signal.
          datum.dv_settled,
          interval.contains(self.validity_range, current_timestamp),
          new_datum == BondingCurveTierBDatum {
            ..datum,
            curve_state: Active,
            activated_at: current_timestamp,
          },
        }
      }

      BuyTokens {
        token_amount,
        claimed_price,
        gross_payment,
        claimed_creator_fee,
        claimed_treasury_fee,
        claimed_ops_fee,
        buyer_key_hash,
      } -> {
        let remaining = datum.curve_supply - datum.tokens_sold
        let fee_total = claimed_creator_fee + claimed_treasury_fee + claimed_ops_fee
        let net_payment = gross_payment - fee_total
        // May already be non-zero here — this buyer could have already
        // claimed a DarkVeil allocation via ClaimDarkVeilTokens, not
        // starting fresh (see file header).
        let prior_purchases = cumulative_purchases(datum.identity_purchases, buyer_key_hash)
        let new_total_purchases = prior_purchases + token_amount
        let new_tokens_sold = datum.tokens_sold + token_amount
        let next_state = if new_tokens_sold == datum.curve_supply {
          Graduated
        } else {
          datum.curve_state
        }
        let expected_datum =
          BondingCurveTierBDatum {
            ..datum,
            tokens_sold: new_tokens_sold,
            total_raised: datum.total_raised + net_payment,
            creator_fees_accrued: datum.creator_fees_accrued + claimed_creator_fee,
            treasury_fees_accrued: datum.treasury_fees_accrued + claimed_treasury_fee,
            ops_fees_accrued: datum.ops_fees_accrued + claimed_ops_fee,
            identity_purchases: update_purchases(
              datum.identity_purchases,
              buyer_key_hash,
              new_total_purchases,
            ),
            curve_state: next_state,
          }
        let new_datum = own_continuing_datum(self, own_ref)

        and {
          datum.curve_state == Active,
          token_amount > 0,
          token_amount <= remaining,
          verify_price(datum, datum.tokens_sold, claimed_price),
          claimed_price * token_amount == gross_payment,
          verify_fee_slice(gross_payment, creator_bps, claimed_creator_fee),
          verify_fee_slice(gross_payment, treasury_bps, claimed_treasury_fee),
          verify_fee_slice(gross_payment, ops_bps, claimed_ops_fee),
          new_total_purchases <= datum.wallet_cap,
          list.has(self.extra_signatories, buyer_key_hash),
          // T32: creator cannot wash-trade their own public bonding curve.
          buyer_key_hash != datum.creator_pub_key_hash,
          new_datum == expected_datum,
          token_delivered(self, datum, token_amount),
          payment_received(self, own_ref, gross_payment),
          // Bonus fix (found while designing T49): the curve's own reserve
          // must actually shrink by token_amount.
          curve_token_balance_decreased(self, own_ref, datum, token_amount),
          // T81: the curve's own continuing output can't be padded.
          curve_own_output_clean(self, own_ref),
        }
      }

      ClaimDarkVeilTokens {
        dv_amount,
        salt,
        merkle_proof,
        claimed_creator_fee,
        claimed_treasury_fee,
        claimed_ops_fee,
        buyer_key_hash,
      } -> {
        let remaining = datum.curve_supply - datum.tokens_sold
        // Flat DarkVeil price (base_price = P0), not the quadratic
        // formula — the buyer already locked this price privately on
        // Midnight during the DV buying window (see file header).
        let gross_payment = dv_amount * datum.base_price
        let fee_total = claimed_creator_fee + claimed_treasury_fee + claimed_ops_fee
        let net_payment = gross_payment - fee_total
        let leaf = hash_dv_leaf(buyer_key_hash, dv_amount, salt)
        // May already be non-zero here — this buyer could have already
        // bought publicly before claiming their DV allocation.
        let prior_purchases = cumulative_purchases(datum.identity_purchases, buyer_key_hash)
        let new_total_purchases = prior_purchases + dv_amount
        let new_tokens_sold = datum.tokens_sold + dv_amount
        let next_state = if new_tokens_sold == datum.curve_supply {
          Graduated
        } else {
          datum.curve_state
        }
        let expected_datum =
          BondingCurveTierBDatum {
            ..datum,
            tokens_sold: new_tokens_sold,
            total_raised: datum.total_raised + net_payment,
            creator_fees_accrued: datum.creator_fees_accrued + claimed_creator_fee,
            treasury_fees_accrued: datum.treasury_fees_accrued + claimed_treasury_fee,
            ops_fees_accrued: datum.ops_fees_accrued + claimed_ops_fee,
            identity_purchases: update_purchases(
              datum.identity_purchases,
              buyer_key_hash,
              new_total_purchases,
            ),
            dv_claimed: [buyer_key_hash, ..datum.dv_claimed],
            curve_state: next_state,
          }
        let new_datum = own_continuing_datum(self, own_ref)

        and {
          datum.curve_state == Active,
          dv_amount > 0,
          dv_amount <= remaining,
          verify_dv_merkle_proof(datum.dv_allocation_root, leaf, merkle_proof),
          !list.has(datum.dv_claimed, buyer_key_hash),
          verify_fee_slice(gross_payment, creator_bps, claimed_creator_fee),
          verify_fee_slice(gross_payment, treasury_bps, claimed_treasury_fee),
          verify_fee_slice(gross_payment, ops_bps, claimed_ops_fee),
          new_total_purchases <= datum.wallet_cap,
          list.has(self.extra_signatories, buyer_key_hash),
          // Same wash-trade protection as BuyTokens (T32) — a creator
          // cannot register/claim a DarkVeil allocation against their own
          // launch either.
          buyer_key_hash != datum.creator_pub_key_hash,
          new_datum == expected_datum,
          token_delivered(self, datum, dv_amount),
          payment_received(self, own_ref, gross_payment),
          curve_token_balance_decreased(self, own_ref, datum, dv_amount),
          // T81: the curve's own continuing output can't be padded.
          curve_own_output_clean(self, own_ref),
        }
      }

      ClaimCreatorFees { amount, platform_claim_fee } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        let platform_ops_share =
          platform_claim_fee * platform_fee_ops_bps / bps_denominator
        let platform_treasury_share = platform_claim_fee - platform_ops_share
        expect Some(own_input) =
          list.find(self.inputs, fn(input) { input.output_reference == own_ref })
        let own_address = own_input.output.address
        expect Some(own_output) =
          list.find(self.outputs, fn(output) { output.address == own_address })
        // T108: the curve's own balance moves in TWO directions in the
        // same transaction — `amount` leaves (paid to the claimer),
        // `platform_claim_fee` arrives (paid by the claimer) — same shape
        // as Tier A's identical fix, verified directly here rather than
        // via lovelace_paid_from_curve's single-direction check.
        let curve_balance_net_ok =
          assets.lovelace_of(own_output.value) == assets.lovelace_of(own_input.output.value) - amount + platform_claim_fee
        // T93/T115 fix (2026-07-22): same payment-credential-only fix as
        // lovelace_paid_from_curve/buyback_share_paid above.
        let recipient_credential = from_verification_key(active_fee_recipient(datum)).payment_credential
        let recipient_paid =
          list.any(
            self.outputs,
            fn(output) {
              output.address.payment_credential == recipient_credential && assets.lovelace_of(
                output.value,
              ) >= amount
            },
          )
        and {
          // CTO fee-redirect fix: was hardcoded to creator_pub_key_hash —
          // now respects cto_triggered via active_fee_recipient.
          list.has(self.extra_signatories, active_fee_recipient(datum)),
          amount <= datum.creator_fees_accrued,
          platform_claim_fee >= min_platform_claim_fee_lovelace,
          curve_balance_net_ok,
          recipient_paid,
          new_datum == BondingCurveTierBDatum {
            ..datum,
            creator_fees_accrued: datum.creator_fees_accrued - amount,
            treasury_fees_accrued: datum.treasury_fees_accrued + platform_treasury_share,
            ops_fees_accrued: datum.ops_fees_accrued + platform_ops_share,
          },
          curve_own_output_clean(self, own_ref),
        }
      }

      ClaimTreasuryFees { amount } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          list.has(self.extra_signatories, datum.governor_pub_key_hash),
          amount <= datum.treasury_fees_accrued,
          new_datum == BondingCurveTierBDatum {
            ..datum,
            treasury_fees_accrued: datum.treasury_fees_accrued - amount,
          },
          lovelace_paid_from_curve(self, own_ref, datum.governor_pub_key_hash, amount),
          curve_own_output_clean(self, own_ref),
        }
      }

      ClaimOpsFees { amount } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          list.has(self.extra_signatories, datum.governor_pub_key_hash),
          amount <= datum.ops_fees_accrued,
          new_datum == BondingCurveTierBDatum {
            ..datum,
            ops_fees_accrued: datum.ops_fees_accrued - amount,
          },
          lovelace_paid_from_curve(self, own_ref, datum.governor_pub_key_hash, amount),
          curve_own_output_clean(self, own_ref),
        }
      }

      CancelCurve -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          list.has(self.extra_signatories, datum.governor_pub_key_hash),
          datum.curve_state != Graduated,
          new_datum == BondingCurveTierBDatum { ..datum, curve_state: Cancelled },
        }
      }

      ExpireCurve { current_timestamp } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          datum.curve_state == Active,
          interval.contains(self.validity_range, current_timestamp),
          // T90: bound the declared validity range's own width.
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          current_timestamp > datum.activated_at + max_curve_duration,
          new_datum == BondingCurveTierBDatum { ..datum, curve_state: Cancelled },
        }
      }

      ClaimBuyback { token_amount, buyer_key_hash } -> {
        let share = datum.total_raised * token_amount / datum.tokens_sold
        let new_datum =
          BondingCurveTierBDatum {
            ..datum,
            tokens_sold: datum.tokens_sold - token_amount,
            total_raised: datum.total_raised - share,
          }
        let actual_new_datum = own_continuing_datum(self, own_ref)
        and {
          datum.curve_state == Cancelled,
          token_amount > 0,
          token_amount <= datum.tokens_sold,
          datum.tokens_sold > 0,
          list.has(self.extra_signatories, buyer_key_hash),
          actual_new_datum == new_datum,
          buyback_tokens_returned(self, own_ref, datum, token_amount),
          buyback_share_paid(self, own_ref, buyer_key_hash, share),
        }
      }

      Graduate -> {
        let new_datum = own_continuing_datum(self, own_ref)
        let expected_datum =
          BondingCurveTierBDatum {
            ..datum,
            total_raised: 0,
            lp_seeded: True,
            staking_seeded: True,
          }
        and {
          datum.curve_state == Graduated,
          !datum.lp_seeded,
          !datum.staking_seeded,
          new_datum == expected_datum,
          graduation_funds_left_curve(self, own_ref, datum, datum.total_raised),
          lp_seeding_output_ok(self, datum, datum.total_raised),
          staking_seeding_output_ok(self, datum),
          // T81: the curve's own post-graduation output can't be padded.
          curve_own_output_clean(self, own_ref),
        }
      }

      TriggerCTO { community_pub_key_hash } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          // T-CTO-ENFORCE: permissionless, gated on real anchored vote
          // evidence instead of a bare governor signature.
          cto_vote_verified(
            self,
            datum,
            SilenceLockTrigger,
            Some(community_pub_key_hash),
          ),
          !datum.cto_triggered,
          community_pub_key_hash != #"",
          new_datum == BondingCurveTierBDatum {
            ..datum,
            cto_triggered: True,
            community_pub_key_hash: community_pub_key_hash,
          },
        }
      }

      DissolveCTO -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          // T-CTO-ENFORCE: same reasoning, gated on a real anchored
          // DissolveCTOProposal instead of a bare governor signature.
          cto_vote_verified(self, datum, DissolveCTOProposal, None),
          datum.cto_triggered,
          new_datum == BondingCurveTierBDatum {
            ..datum,
            cto_triggered: False,
            community_pub_key_hash: #"",
          },
        }
      }

      // T112 fix (2026-07-19, Tier B cross-chain audit): see
      // AnchorDvAllocationRoot's own doc comment in
      // BondingCurveTierBRedeemer above for the full reasoning.
      AnchorDvAllocationRoot { dv_allocation_root } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          list.has(self.extra_signatories, datum.governor_pub_key_hash),
          datum.curve_state == Inactive,
          new_datum == BondingCurveTierBDatum {
            ..datum,
            dv_allocation_root: dv_allocation_root,
            dv_settled: True,
          },
        }
      }

      // T109 CRITICAL fix (2026-07-19, full-suite security audit) — same
      // fix as bonding_curve.ak: was an unconditional `True` (zero checks),
      // an unconditional authorization, which must never be possible. See that file's own comment
      // on this exact line for the full explanation.
      QueryState -> False
      },
    }
  }
}

// ============================================================================
// TESTS
// ============================================================================

fn mock_datum(
  curve_state: CurveState,
  tokens_sold: Int,
  identity_purchases: List<(VerificationKeyHash, Int)>,
) -> BondingCurveTierBDatum {
  BondingCurveTierBDatum {
    launch_id: #"01",
    creator_pub_key_hash: #"11",
    governor_pub_key_hash: #"22",
    base_price: 100,
    max_price: 1000,
    curve_supply: 1000,
    curve_state: curve_state,
    activated_at: 0,
    tokens_sold: tokens_sold,
    total_raised: 0,
    creator_fees_accrued: 0,
    treasury_fees_accrued: 0,
    ops_fees_accrued: 0,
    wallet_cap: 500,
    identity_purchases: identity_purchases,
    dv_allocation_root: #"00",
    dv_claimed: [],
    // T112: real launches must call AnchorDvAllocationRoot before
    // ActivateCurve; tests that specifically exercise ActivateCurve
    // override this explicitly (see activate_curve_* tests below) — every
    // other test passes curve_state directly, bypassing ActivateCurve's
    // own check, so False here doesn't affect them.
    dv_settled: False,
    token_policy_id: #"33",
    token_asset_name: "tok",
    lp_escrow_credential: from_verification_key(#"ff").payment_credential,
    lp_reserve_tokens: 150,
    lp_seeded: False,
    community_pub_key_hash: #"",
    cto_triggered: False,
    staking_enabled: False,
    staking_pool_credential: from_verification_key(#"aa").payment_credential,
    staking_reserve_tokens: 0,
    staking_seeded: False,
    cto_governance_credential: from_verification_key(#"dd").payment_credential,
    cto_governance_nft: #"c0ffee",
  }
}

fn mock_proposal_anchor(
  proposal_type: ProposalType,
  outcome: cto_governance.ProposalOutcome,
  execution_status: cto_governance.ExecutionStatus,
  allocation_recipient_hash: ByteArray,
) -> ProposalAnchor {
  ProposalAnchor {
    proposal_type: proposal_type,
    description_hash: #"aa",
    proof_bundle_hash: #"bb",
    yes_votes: 60_000,
    no_votes: 10_000,
    voter_count: 5,
    creator_yes_votes: 0,
    creator_no_votes: 0,
    outcome: outcome,
    start_timestamp: 0,
    end_timestamp: 1000,
    anchor_timestamp: 500,
    execution_status: execution_status,
    target_dex_credential: None,
    allocation_amount: 0,
    allocation_recipient_hash: allocation_recipient_hash,
    relayer_credential_hash: #"33",
  }
}

fn mock_cto_governance_datum(
  launch_id: ByteArray,
  last_executed_proposal: Option<ProposalAnchor>,
) -> CtoGovernanceDatum {
  CtoGovernanceDatum {
    launch_id: launch_id,
    cto_state: PreCTO,
    community_wallet_hash: #"",
    governor_credential_hash: #"22",
    total_supply: 1_000_000,
    quorum_bps: 500,
    creator_vote_cap_bps: 200,
    active_proposal: None,
    proposal_count: 1,
    last_executed_proposal: last_executed_proposal,
    pending_relayer_bond: 0,
    pending_relayer_key_hash: #"",
    treasury_pub_key_hash: #"55",
    ops_pub_key_hash: #"66",
    // C-1 fix: must match both the curve datum's cto_governance_nft and the
    // NFT placed in this reference UTXO's value in the CTO-vote tests below.
    cto_governance_nft: #"c0ffee",
  }
}

/// A reference input at the given address holding the given
/// CtoGovernanceDatum — mirrors how a real TriggerCTO/DissolveCTO
/// transaction would present cto_governance.ak's own UTXO as evidence.
fn mock_cto_ref_input(
  cto_address: Address,
  cto_datum: CtoGovernanceDatum,
) -> Input {
  Input {
    output_reference: OutputReference { transaction_id: #"cd", output_index: 0 },
    output: Output {
      address: cto_address,
      // C-1 fix: genuine governance UTXO carries its per-launch thread NFT
      // (policy = the curve datum's cto_governance_nft `#"c0ffee"`,
      // asset_name = launch_id); cto_vote_verified now requires it.
      value: assets.from_asset(#"c0ffee", cto_datum.launch_id, 1),
      datum: InlineDatum(cto_datum),
      reference_script: None,
    },
  }
}

test verify_price_quadratic_at_zero_sold() {
  verify_price(mock_datum(Active, 0, []), 0, 100)
}

test verify_price_quadratic_at_full_sold() {
  verify_price(mock_datum(Active, 1000, []), 1000, 1000)
}

test verify_price_quadratic_at_half_sold() {
  // base=100, max=1000, range=900, supply=1000: at sold=500,
  // price = 100 + 900 * 500^2 / 1000^2 = 100 + 900*250000/1000000 = 325
  verify_price(mock_datum(Active, 500, []), 500, 325)
}

test verify_price_quadratic_rejects_wrong_price() {
  !verify_price(mock_datum(Active, 500, []), 500, 999)
}

test verify_price_quadratic_curves_slower_than_linear_early() {
  // At 10% sold, quadratic price should be well below the linear
  // midpoint-style increase — confirms this is really x^2, not x.
  // sold=100: price = 100 + 900*100^2/1000^2 = 100 + 9 = 109
  verify_price(mock_datum(Active, 100, []), 100, 109)
}

test verify_fee_slice_creator_1pct() {
  verify_fee_slice(100_000, creator_bps, 1_000)
}

test verify_fee_slice_rejects_wrong_amount() {
  !verify_fee_slice(100_000, creator_bps, 999)
}

test cumulative_purchases_reflects_a_prior_darkveil_claim() {
  // Entry present as if this wallet already called ClaimDarkVeilTokens
  // (T46/privacy fix) — not pre-seeded at deploy, just already transacted.
  let seeded = [(#"dd", 200)]
  cumulative_purchases(seeded, #"dd") == 200
}

test cumulative_purchases_public_only_buyer_starts_zero() {
  let seeded = [(#"dd", 200)]
  cumulative_purchases(seeded, #"ee") == 0
}

test update_purchases_carries_forward_prior_total() {
  let seeded = [(#"dd", 200)]
  update_purchases(seeded, #"dd", 250) == [(#"dd", 250)]
}

test buy_tokens_succeeds_for_buyer_who_already_claimed_darkveil() {
  // Buyer already claimed 200 tokens via ClaimDarkVeilTokens; buying 10
  // more here must respect the SAME cap (500) across both phases.
  let seeded = [(#"dd", 200)]
  let datum = mock_datum(Active, 0, seeded)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 1000),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 980,
      creator_fees_accrued: 10,
      treasury_fees_accrued: 6,
      ops_fees_accrued: 4,
      identity_purchases: [(#"dd", 210)],
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace + 1000),
        assets.from_asset(#"33", "tok", 990),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: buyer_address,
      value: assets.from_asset(#"33", "tok", 10),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
      extra_signatories: [#"dd"],
    }
  let redeemer =
    BuyTokens {
      token_amount: 10,
      claimed_price: 100,
      gross_payment: 1000,
      claimed_creator_fee: 10,
      claimed_treasury_fee: 6,
      claimed_ops_fee: 4,
      buyer_key_hash: #"dd",
    }

  bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test buy_tokens_rejects_padded_continuing_output() {
  // T81: identical to a normal successful buy, except the curve's own
  // continuing output carries one extra, unrelated junk asset. Before the
  // T81 fix, output_value_clean didn't exist and this would have been
  // accepted — any buyer could pad the curve's reused UTXO with spam
  // assets, degrading every subsequent buyer for the launch's whole life.
  let datum = mock_datum(Active, 0, [])
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 1000),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 980,
      creator_fees_accrued: 10,
      treasury_fees_accrued: 6,
      ops_fees_accrued: 4,
      identity_purchases: [(#"dd", 10)],
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.merge(
          assets.from_lovelace(base_lovelace + 1000),
          assets.from_asset(#"33", "tok", 990),
        ),
        // Junk asset from an unrelated policy — the padding attack.
        assets.from_asset(#"deadbeef", "spam", 1),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: buyer_address,
      value: assets.from_asset(#"33", "tok", 10),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
      extra_signatories: [#"dd"],
    }
  let redeemer =
    BuyTokens {
      token_amount: 10,
      claimed_price: 100,
      gross_payment: 1000,
      claimed_creator_fee: 10,
      claimed_treasury_fee: 6,
      claimed_ops_fee: 4,
      buyer_key_hash: #"dd",
    }

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test buy_tokens_rejects_tokens_not_sourced_from_curve_reserve() {
  // Bonus fix regression test (found while designing T49) — same as Tier
  // A: the buyer's delivery output is present, but the curve's own token
  // balance never shrinks. Before this fix, this would have been accepted.
  let datum = mock_datum(Active, 0, [])
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 1000),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 980,
      creator_fees_accrued: 10,
      treasury_fees_accrued: 6,
      ops_fees_accrued: 4,
      identity_purchases: [(#"dd", 10)],
    }
  let continuing_output =
    Output {
      address: own_address,
      // Curve's token balance unchanged (still 1000) — not the required 990.
      value: assets.merge(
        assets.from_lovelace(base_lovelace + 1000),
        assets.from_asset(#"33", "tok", 1000),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: buyer_address,
      value: assets.from_asset(#"33", "tok", 10),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
      extra_signatories: [#"dd"],
    }
  let redeemer =
    BuyTokens {
      token_amount: 10,
      claimed_price: 100,
      gross_payment: 1000,
      claimed_creator_fee: 10,
      claimed_treasury_fee: 6,
      claimed_ops_fee: 4,
      buyer_key_hash: #"dd",
    }

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test buy_tokens_rejects_creator_buying_own_curve() {
  // T32: same protection as Tier A's bonding_curve.ak — creator cannot
  // wash-trade their own public curve to force last-mile 100% sell-through.
  let datum = mock_datum(Active, 0, [])
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let creator_address = from_verification_key(#"11")
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 1000),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 980,
      creator_fees_accrued: 10,
      treasury_fees_accrued: 6,
      ops_fees_accrued: 4,
      // mock_datum's creator_pub_key_hash is #"11"
      identity_purchases: [(#"11", 10)],
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace + 1000),
        assets.from_asset(#"33", "tok", 990),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: creator_address,
      value: assets.from_asset(#"33", "tok", 10),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
      // creator DOES sign as themselves — proves the rejection is the
      // creator-identity check, not the pre-existing signature check.
      extra_signatories: [#"11"],
    }
  let redeemer =
    BuyTokens {
      token_amount: 10,
      claimed_price: 100,
      gross_payment: 1000,
      claimed_creator_fee: 10,
      claimed_treasury_fee: 6,
      claimed_ops_fee: 4,
      buyer_key_hash: #"11",
    }

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test buy_tokens_rejects_cap_breach_across_darkveil_and_public() {
  // Buyer already claimed 495 via ClaimDarkVeilTokens (out of a 500 cap)
  // and tries to buy 10 more publicly — 505 > 500, must fail even though
  // this SINGLE public purchase alone (10 tokens) would never have
  // tripped a fresh cap.
  let seeded = [(#"dd", 495)]
  let datum = mock_datum(Active, 0, seeded)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 1000),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 980,
      creator_fees_accrued: 10,
      treasury_fees_accrued: 6,
      ops_fees_accrued: 4,
      identity_purchases: [(#"dd", 505)],
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace + 1000),
        assets.from_asset(#"33", "tok", 990),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: buyer_address,
      value: assets.from_asset(#"33", "tok", 10),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
      extra_signatories: [#"dd"],
    }
  let redeemer =
    BuyTokens {
      token_amount: 10,
      claimed_price: 100,
      gross_payment: 1000,
      claimed_creator_fee: 10,
      claimed_treasury_fee: 6,
      claimed_ops_fee: 4,
      buyer_key_hash: #"dd",
    }

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

// ----------------------------------------------------------------------------
// T46/privacy fix (2026-07-11): ClaimDarkVeilTokens + Merkle proof helpers
// ----------------------------------------------------------------------------

test verify_dv_merkle_proof_accepts_single_leaf_tree() {
  // Edge case: zero real levels — the root IS the leaf, proof is empty.
  let leaf = hash_dv_leaf(#"aa", 100, #"01")
  verify_dv_merkle_proof(leaf, leaf, [])
}

test verify_dv_merkle_proof_accepts_real_proof_in_two_leaf_tree() {
  let leaf0 = hash_dv_leaf(#"aa", 100, #"01")
  let leaf1 = hash_dv_leaf(#"bb", 200, #"02")
  let root = hash_dv_node(leaf0, leaf1)
  let proof0 = [MerkleProofStep { sibling: leaf1, goes_left: False }]
  let proof1 = [MerkleProofStep { sibling: leaf0, goes_left: True }]
  and {
    verify_dv_merkle_proof(root, leaf0, proof0),
    verify_dv_merkle_proof(root, leaf1, proof1),
  }
}

test verify_dv_merkle_proof_rejects_tampered_sibling() {
  let leaf0 = hash_dv_leaf(#"aa", 100, #"01")
  let leaf1 = hash_dv_leaf(#"bb", 200, #"02")
  let root = hash_dv_node(leaf0, leaf1)
  let tampered_proof = [MerkleProofStep { sibling: #"ff", goes_left: False }]
  !verify_dv_merkle_proof(root, leaf0, tampered_proof)
}

test verify_dv_merkle_proof_rejects_flipped_direction_bit() {
  let leaf0 = hash_dv_leaf(#"aa", 100, #"01")
  let leaf1 = hash_dv_leaf(#"bb", 200, #"02")
  let root = hash_dv_node(leaf0, leaf1)
  let flipped_proof = [MerkleProofStep { sibling: leaf1, goes_left: True }]
  !verify_dv_merkle_proof(root, leaf0, flipped_proof)
}

test hash_dv_leaf_differs_for_different_salts() {
  // Salt binding matters: without it, a leaf could be brute-forced from a
  // guessed (vkh, dv_amount) pair alone.
  hash_dv_leaf(#"aa", 100, #"01") != hash_dv_leaf(#"aa", 100, #"02")
}

test claim_darkveil_tokens_succeeds_with_valid_proof_and_payment() {
  let buyer_key = #"dd"
  let dv_amount = 10
  let salt = #"aa"
  let leaf = hash_dv_leaf(buyer_key, dv_amount, salt)
  let datum =
    BondingCurveTierBDatum { ..mock_datum(Active, 0, []), dv_allocation_root: leaf }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(buyer_key)
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 1000),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 980,
      creator_fees_accrued: 10,
      treasury_fees_accrued: 6,
      ops_fees_accrued: 4,
      identity_purchases: [(buyer_key, 10)],
      dv_claimed: [buyer_key],
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace + 1000),
        assets.from_asset(#"33", "tok", 990),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: buyer_address,
      value: assets.from_asset(#"33", "tok", 10),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
      extra_signatories: [buyer_key],
    }
  let redeemer =
    ClaimDarkVeilTokens {
      dv_amount: dv_amount,
      salt: salt,
      merkle_proof: [],
      claimed_creator_fee: 10,
      claimed_treasury_fee: 6,
      claimed_ops_fee: 4,
      buyer_key_hash: buyer_key,
    }

  bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test claim_darkveil_tokens_rejects_double_claim() {
  let buyer_key = #"dd"
  let dv_amount = 10
  let salt = #"aa"
  let leaf = hash_dv_leaf(buyer_key, dv_amount, salt)
  let datum =
    BondingCurveTierBDatum {
      ..mock_datum(Active, 0, []),
      dv_allocation_root: leaf,
      // Already claimed once — this is the exact double-claim this test
      // proves is rejected.
      dv_claimed: [buyer_key],
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(buyer_key)
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 1000),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 980,
      creator_fees_accrued: 10,
      treasury_fees_accrued: 6,
      ops_fees_accrued: 4,
      identity_purchases: [(buyer_key, 10)],
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace + 1000),
        assets.from_asset(#"33", "tok", 990),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: buyer_address,
      value: assets.from_asset(#"33", "tok", 10),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
      extra_signatories: [buyer_key],
    }
  let redeemer =
    ClaimDarkVeilTokens {
      dv_amount: dv_amount,
      salt: salt,
      merkle_proof: [],
      claimed_creator_fee: 10,
      claimed_treasury_fee: 6,
      claimed_ops_fee: 4,
      buyer_key_hash: buyer_key,
    }

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test claim_darkveil_tokens_rejects_wrong_salt() {
  // Same scaffolding as the success test, but the claim presents a
  // different salt than the one the root was actually built from — the
  // derived leaf won't match, proving the claim is bound to the real
  // private allocation, not just a guessed (vkh, amount) pair.
  let buyer_key = #"dd"
  let dv_amount = 10
  let real_salt = #"aa"
  let leaf = hash_dv_leaf(buyer_key, dv_amount, real_salt)
  let datum =
    BondingCurveTierBDatum { ..mock_datum(Active, 0, []), dv_allocation_root: leaf }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(buyer_key)
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 1000),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 980,
      creator_fees_accrued: 10,
      treasury_fees_accrued: 6,
      ops_fees_accrued: 4,
      identity_purchases: [(buyer_key, 10)],
      dv_claimed: [buyer_key],
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace + 1000),
        assets.from_asset(#"33", "tok", 990),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: buyer_address,
      value: assets.from_asset(#"33", "tok", 10),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
      extra_signatories: [buyer_key],
    }
  let redeemer =
    ClaimDarkVeilTokens {
      dv_amount: dv_amount,
      salt: #"bb",
      merkle_proof: [],
      claimed_creator_fee: 10,
      claimed_treasury_fee: 6,
      claimed_ops_fee: 4,
      buyer_key_hash: buyer_key,
    }

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test claim_darkveil_tokens_rejects_creator_claiming() {
  // T32-equivalent protection: the creator cannot claim a DarkVeil
  // allocation against their own launch, even with a structurally valid
  // proof — same wash-trade concern BuyTokens already guards against.
  let creator_key = #"11"
  // mock_datum's creator_pub_key_hash
  let dv_amount = 10
  let salt = #"aa"
  let leaf = hash_dv_leaf(creator_key, dv_amount, salt)
  let datum =
    BondingCurveTierBDatum { ..mock_datum(Active, 0, []), dv_allocation_root: leaf }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let creator_address = from_verification_key(creator_key)
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 1000),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 980,
      creator_fees_accrued: 10,
      treasury_fees_accrued: 6,
      ops_fees_accrued: 4,
      identity_purchases: [(creator_key, 10)],
      dv_claimed: [creator_key],
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace + 1000),
        assets.from_asset(#"33", "tok", 990),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: creator_address,
      value: assets.from_asset(#"33", "tok", 10),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
      extra_signatories: [creator_key],
    }
  let redeemer =
    ClaimDarkVeilTokens {
      dv_amount: dv_amount,
      salt: salt,
      merkle_proof: [],
      claimed_creator_fee: 10,
      claimed_treasury_fee: 6,
      claimed_ops_fee: 4,
      buyer_key_hash: creator_key,
    }

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test claim_darkveil_tokens_rejects_payment_not_received() {
  let buyer_key = #"dd"
  let dv_amount = 10
  let salt = #"aa"
  let leaf = hash_dv_leaf(buyer_key, dv_amount, salt)
  let datum =
    BondingCurveTierBDatum { ..mock_datum(Active, 0, []), dv_allocation_root: leaf }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(buyer_key)
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 1000),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 980,
      creator_fees_accrued: 10,
      treasury_fees_accrued: 6,
      ops_fees_accrued: 4,
      identity_purchases: [(buyer_key, 10)],
      dv_claimed: [buyer_key],
    }
  let continuing_output =
    Output {
      address: own_address,
      // No lovelace increase — claimed payment but didn't actually send it.
      value: assets.merge(
        assets.from_lovelace(base_lovelace),
        assets.from_asset(#"33", "tok", 990),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: buyer_address,
      value: assets.from_asset(#"33", "tok", 10),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
      extra_signatories: [buyer_key],
    }
  let redeemer =
    ClaimDarkVeilTokens {
      dv_amount: dv_amount,
      salt: salt,
      merkle_proof: [],
      claimed_creator_fee: 10,
      claimed_treasury_fee: 6,
      claimed_ops_fee: 4,
      buyer_key_hash: buyer_key,
    }

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test claim_darkveil_tokens_rejects_cap_breach_with_prior_public_purchase() {
  // Buyer already bought 495 publicly (out of a 500 cap) and tries to
  // claim 10 more via DarkVeil — 505 > 500, same cumulative cap across
  // both paths as buy_tokens_rejects_cap_breach_across_darkveil_and_public
  // proves in the other direction.
  let buyer_key = #"dd"
  let dv_amount = 10
  let salt = #"aa"
  let leaf = hash_dv_leaf(buyer_key, dv_amount, salt)
  let seeded = [(buyer_key, 495)]
  let datum =
    BondingCurveTierBDatum { ..mock_datum(Active, 0, seeded), dv_allocation_root: leaf }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(buyer_key)
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 1000),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 980,
      creator_fees_accrued: 10,
      treasury_fees_accrued: 6,
      ops_fees_accrued: 4,
      identity_purchases: [(buyer_key, 505)],
      dv_claimed: [buyer_key],
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace + 1000),
        assets.from_asset(#"33", "tok", 990),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: buyer_address,
      value: assets.from_asset(#"33", "tok", 10),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
      extra_signatories: [buyer_key],
    }
  let redeemer =
    ClaimDarkVeilTokens {
      dv_amount: dv_amount,
      salt: salt,
      merkle_proof: [],
      claimed_creator_fee: 10,
      claimed_treasury_fee: 6,
      claimed_ops_fee: 4,
      buyer_key_hash: buyer_key,
    }

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test buy_tokens_rejects_without_buyer_signature() {
  // Same as a valid buy, but the buyer never signed — proves cap
  // enforcement is bound to a real signature, not just a claimed key hash
  // in the redeemer.
  let datum = mock_datum(Active, 0, [])
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 1000),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 980,
      creator_fees_accrued: 10,
      treasury_fees_accrued: 6,
      ops_fees_accrued: 4,
      identity_purchases: [(#"dd", 10)],
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace + 1000),
        assets.from_asset(#"33", "tok", 990),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: buyer_address,
      value: assets.from_asset(#"33", "tok", 10),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
      // no extra_signatories — buyer never signed
    }
  let redeemer =
    BuyTokens {
      token_amount: 10,
      claimed_price: 100,
      gross_payment: 1000,
      claimed_creator_fee: 10,
      claimed_treasury_fee: 6,
      claimed_ops_fee: 4,
      buyer_key_hash: #"dd",
    }

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test buy_tokens_rejects_payment_not_actually_received() {
  let datum = mock_datum(Active, 0, [])
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 1000),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 980,
      creator_fees_accrued: 10,
      treasury_fees_accrued: 6,
      ops_fees_accrued: 4,
      identity_purchases: [(#"dd", 10)],
    }
  let continuing_output =
    Output {
      address: own_address,
      // No increase — claimed 1000 lovelace but didn't pay it.
      value: assets.merge(
        assets.from_lovelace(base_lovelace),
        assets.from_asset(#"33", "tok", 990),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: buyer_address,
      value: assets.from_asset(#"33", "tok", 10),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, delivery_output],
      extra_signatories: [#"dd"],
    }
  let redeemer =
    BuyTokens {
      token_amount: 10,
      claimed_price: 100,
      gross_payment: 1000,
      claimed_creator_fee: 10,
      claimed_treasury_fee: 6,
      claimed_ops_fee: 4,
      buyer_key_hash: #"dd",
    }

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test activate_curve_succeeds_with_governor_signature() {
  let datum = BondingCurveTierBDatum { ..mock_datum(Inactive, 0, []), dv_settled: True }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.zero,
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum { ..datum, curve_state: Active, activated_at: 500 }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.zero,
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"22"],
      validity_range: interval.between(400, 600),
    }

  bonding_curve_tier_b.spend(
    Some(datum),
    ActivateCurve { current_timestamp: 500 },
    own_ref,
    self,
  )
}

// T112: DarkVeil settlement not anchored yet — real launches must not be
// able to open public trading with dv_allocation_root still at its
// placeholder (ClaimDarkVeilTokens would then be permanently unusable for
// this launch, with no on-chain signal anything is wrong).
test activate_curve_rejects_when_dv_not_settled() {
  let datum = mock_datum(Inactive, 0, [])
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.zero,
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum { ..datum, curve_state: Active, activated_at: 500 }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.zero,
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"22"],
      validity_range: interval.between(400, 600),
    }

  !bonding_curve_tier_b.spend(
    Some(datum),
    ActivateCurve { current_timestamp: 500 },
    own_ref,
    self,
  )
}

// T112: the core fix — governor anchors the real, off-chain-computed
// allocation root while the curve is still Inactive.
test anchor_dv_allocation_root_succeeds_for_governor() {
  let datum = mock_datum(Inactive, 0, [])
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.zero,
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let real_root = #"deadbeef"
  let new_datum =
    BondingCurveTierBDatum { ..datum, dv_allocation_root: real_root, dv_settled: True }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.zero,
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"22"],
    }

  bonding_curve_tier_b.spend(
    Some(datum),
    AnchorDvAllocationRoot { dv_allocation_root: real_root },
    own_ref,
    self,
  )
}

test anchor_dv_allocation_root_rejects_non_governor() {
  let datum = mock_datum(Inactive, 0, [])
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.zero,
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let real_root = #"deadbeef"
  let new_datum =
    BondingCurveTierBDatum { ..datum, dv_allocation_root: real_root, dv_settled: True }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.zero,
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      // stranger, not the governor
      extra_signatories: [#"99"],
    }

  !bonding_curve_tier_b.spend(
    Some(datum),
    AnchorDvAllocationRoot { dv_allocation_root: real_root },
    own_ref,
    self,
  )
}

// T112: once public trading has opened, the root is permanently frozen —
// ClaimDarkVeilTokens's own curve_state == Active requirement means any
// claim already made was validated against whatever root was anchored
// before activation; letting the governor rewrite it afterward would let
// an already-settled claim's proof retroactively become invalid, or a new
// forged tree validate claims that were never real.
test anchor_dv_allocation_root_rejects_after_curve_active() {
  let datum = BondingCurveTierBDatum { ..mock_datum(Active, 0, []), dv_settled: True }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.zero,
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let forged_root = #"cafebabe"
  let new_datum =
    BondingCurveTierBDatum { ..datum, dv_allocation_root: forged_root, dv_settled: True }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.zero,
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"22"],
    }

  !bonding_curve_tier_b.spend(
    Some(datum),
    AnchorDvAllocationRoot { dv_allocation_root: forged_root },
    own_ref,
    self,
  )
}

test expire_curve_succeeds_after_deadline_with_no_signature() {
  let datum =
    BondingCurveTierBDatum { ..mock_datum(Active, 100, []), activated_at: 0 }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.zero,
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum = BondingCurveTierBDatum { ..datum, curve_state: Cancelled }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.zero,
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // T89: ms-scale, matches max_curve_duration's real unit
  let past_deadline = 7_776_000_001
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(
        past_deadline - 100,
        past_deadline + 100,
      ),
    }

  bonding_curve_tier_b.spend(
    Some(datum),
    ExpireCurve { current_timestamp: past_deadline },
    own_ref,
    self,
  )
}

// T90: same finding/fix as Tier A's bonding_curve.ak — see that file's
// own `expire_curve_rejects_wide_validity_range` test for the full
// explanation.
test expire_curve_rejects_wide_validity_range() {
  let datum =
    BondingCurveTierBDatum { ..mock_datum(Active, 100, []), activated_at: 0 }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.zero,
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum = BondingCurveTierBDatum { ..datum, curve_state: Cancelled }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.zero,
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let past_deadline = 7_776_000_001
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(0, past_deadline + 100),
    }

  !bonding_curve_tier_b.spend(
    Some(datum),
    ExpireCurve { current_timestamp: past_deadline },
    own_ref,
    self,
  )
}

test expire_curve_rejects_before_deadline() {
  let datum =
    BondingCurveTierBDatum { ..mock_datum(Active, 100, []), activated_at: 0 }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.zero,
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum = BondingCurveTierBDatum { ..datum, curve_state: Cancelled }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.zero,
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // T89: ms-scale, matches max_curve_duration's real unit
  let before_deadline = 7_775_999_999
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(
        before_deadline - 100,
        before_deadline + 100,
      ),
    }

  !bonding_curve_tier_b.spend(
    Some(datum),
    ExpireCurve { current_timestamp: before_deadline },
    own_ref,
    self,
  )
}

test cancel_curve_fails_after_graduation() {
  let datum = mock_datum(Graduated, 1000, [])
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.zero,
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum = BondingCurveTierBDatum { ..datum, curve_state: Cancelled }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.zero,
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"22"],
    }

  !bonding_curve_tier_b.spend(Some(datum), CancelCurve, own_ref, self)
}

// ----------------------------------------------------------------------------
// CTO fee-redirect fix (2026-07-12): TriggerCTO/DissolveCTO + redirected
// ClaimCreatorFees — same tests as Tier A's bonding_curve.ak.
// ----------------------------------------------------------------------------

test tier_b_trigger_cto_succeeds_with_real_anchored_vote() {
  let datum = mock_datum(Active, 0, [])
  let cto_address = from_verification_key(#"dd")
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.zero,
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      cto_triggered: True,
      community_pub_key_hash: #"ee",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.zero,
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let executed_proposal =
    mock_proposal_anchor(SilenceLockTrigger, Passed, Executed, #"ee")
  let cto_datum =
    mock_cto_governance_datum(datum.launch_id, Some(executed_proposal))
  let cto_ref_input = mock_cto_ref_input(cto_address, cto_datum)
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [cto_ref_input],
      outputs: [continuing_output],
    }

  bonding_curve_tier_b.spend(
    Some(datum),
    TriggerCTO { community_pub_key_hash: #"ee" },
    own_ref,
    self,
  )
}

// C-1 regression (2026-07-23 audit): a UTXO planted at
// cto_governance_credential with a fully forged "Passed / Executed" datum but
// WITHOUT the genuine governance thread NFT must NOT satisfy
// cto_vote_verified. Cleanly returns False (ref input exists, lacks the NFT),
// so a plain `!spend(...)` assertion works.
test tier_b_trigger_cto_rejects_forged_governance_utxo_without_nft() {
  let datum = mock_datum(Active, 0, [])
  let cto_address = from_verification_key(#"dd")
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.zero,
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      cto_triggered: True,
      community_pub_key_hash: #"ee",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.zero,
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let executed_proposal =
    mock_proposal_anchor(SilenceLockTrigger, Passed, Executed, #"ee")
  let cto_datum =
    mock_cto_governance_datum(datum.launch_id, Some(executed_proposal))
  // FORGED: right governance address, fully "passed" datum, but no NFT.
  let forged_ref_input =
    Input {
      output_reference: OutputReference { transaction_id: #"cd", output_index: 0 },
      output: Output {
        address: cto_address,
        value: assets.zero,
        datum: InlineDatum(cto_datum),
        reference_script: None,
      },
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [forged_ref_input],
      outputs: [continuing_output],
    }

  !bonding_curve_tier_b.spend(
    Some(datum),
    TriggerCTO { community_pub_key_hash: #"ee" },
    own_ref,
    self,
  )
}

// T-CTO-ENFORCE: cto_vote_verified's `expect Some(cto_ref_input) = ...`
// panics rather than returning False when no matching reference input
// exists, so this needs the `fail` test annotation — same reasoning as
// Tier A's identically-named test.
test tier_b_trigger_cto_rejects_without_reference_input() fail {
  let datum = mock_datum(Active, 0, [])
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.zero,
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      cto_triggered: True,
      community_pub_key_hash: #"ee",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.zero,
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"22"],
    }

  bonding_curve_tier_b.spend(
    Some(datum),
    TriggerCTO { community_pub_key_hash: #"ee" },
    own_ref,
    self,
  )
}

test tier_b_dissolve_cto_succeeds_with_real_anchored_vote() {
  let datum =
    BondingCurveTierBDatum {
      ..mock_datum(Active, 0, []),
      cto_triggered: True,
      community_pub_key_hash: #"ee",
    }
  let cto_address = from_verification_key(#"dd")
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.zero,
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      cto_triggered: False,
      community_pub_key_hash: #"",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.zero,
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let executed_proposal =
    mock_proposal_anchor(DissolveCTOProposal, Passed, Executed, #"")
  let cto_datum =
    mock_cto_governance_datum(datum.launch_id, Some(executed_proposal))
  let cto_ref_input = mock_cto_ref_input(cto_address, cto_datum)
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [cto_ref_input],
      outputs: [continuing_output],
    }

  bonding_curve_tier_b.spend(Some(datum), DissolveCTO, own_ref, self)
}

/// T108 fix: shared shape for the ClaimCreatorFees success-path tests
/// below — same as Tier A's claim_creator_fees_tx. Curve holds 1,000,000
/// lovelace going in; claimer takes `amount` (200) out and pays
/// `platform_claim_fee` (exactly the floor, 200,000) in, so the curve's
/// continuing output must show 1,000,000 - 200 + 200,000 = 1,199,800.
fn tier_b_claim_creator_fees_tx(
  datum: BondingCurveTierBDatum,
  new_datum: BondingCurveTierBDatum,
  recipient_key_hash: VerificationKeyHash,
  signer: VerificationKeyHash,
) -> (OutputReference, Transaction) {
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.from_lovelace(1_000_000),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_lovelace(1_199_800),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let recipient_payout =
    Output {
      address: from_verification_key(recipient_key_hash),
      value: assets.from_lovelace(200),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, recipient_payout],
      extra_signatories: [signer],
    }
  (own_ref, self)
}

test tier_b_claim_creator_fees_succeeds_via_creator_when_no_cto() {
  let datum =
    BondingCurveTierBDatum { ..mock_datum(Active, 0, []), creator_fees_accrued: 500 }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      creator_fees_accrued: 300,
      treasury_fees_accrued: 120_000,
      ops_fees_accrued: 80_000,
    }
  let (own_ref, self) = tier_b_claim_creator_fees_tx(datum, new_datum, #"11", #"11")

  bonding_curve_tier_b.spend(
    Some(datum),
    ClaimCreatorFees { amount: 200, platform_claim_fee: 200_000 },
    own_ref,
    self,
  )
}

test tier_b_claim_creator_fees_rejects_creator_once_cto_triggered() {
  let datum =
    BondingCurveTierBDatum {
      ..mock_datum(Active, 0, []),
      creator_fees_accrued: 500,
      cto_triggered: True,
      community_pub_key_hash: #"ee",
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      creator_fees_accrued: 300,
      treasury_fees_accrued: 120_000,
      ops_fees_accrued: 80_000,
    }
  // Original creator (#"11") signs, not the community wallet — must now be
  // rejected.
  let (own_ref, self) = tier_b_claim_creator_fees_tx(datum, new_datum, #"11", #"11")

  !bonding_curve_tier_b.spend(
    Some(datum),
    ClaimCreatorFees { amount: 200, platform_claim_fee: 200_000 },
    own_ref,
    self,
  )
}

test tier_b_claim_creator_fees_succeeds_via_community_wallet_once_cto_triggered() {
  let datum =
    BondingCurveTierBDatum {
      ..mock_datum(Active, 0, []),
      creator_fees_accrued: 500,
      cto_triggered: True,
      community_pub_key_hash: #"ee",
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      creator_fees_accrued: 300,
      treasury_fees_accrued: 120_000,
      ops_fees_accrued: 80_000,
    }
  let (own_ref, self) = tier_b_claim_creator_fees_tx(datum, new_datum, #"ee", #"ee")

  bonding_curve_tier_b.spend(
    Some(datum),
    ClaimCreatorFees { amount: 200, platform_claim_fee: 200_000 },
    own_ref,
    self,
  )
}

test tier_b_claim_creator_fees_rejects_platform_fee_below_floor() {
  // T108 fix regression: platform_claim_fee below the 200,000 floor must
  // be rejected, same as Tier A's identical test.
  let datum =
    BondingCurveTierBDatum { ..mock_datum(Active, 0, []), creator_fees_accrued: 500 }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      creator_fees_accrued: 300,
      treasury_fees_accrued: 6,
      ops_fees_accrued: 4,
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.from_lovelace(1_000_000),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_lovelace(999_810),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let recipient_payout =
    Output {
      address: from_verification_key(#"11"),
      value: assets.from_lovelace(200),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, recipient_payout],
      extra_signatories: [#"11"],
    }

  !bonding_curve_tier_b.spend(
    Some(datum),
    ClaimCreatorFees { amount: 200, platform_claim_fee: 10 },
    own_ref,
    self,
  )
}

test tier_b_claim_creator_fees_rejects_value_drain_attempt() {
  // T108 fix regression: the datum decrements amount correctly but the
  // curve's real lovelace balance is untouched (no real payout, no real
  // platform fee collected) — must be rejected now.
  let datum =
    BondingCurveTierBDatum { ..mock_datum(Active, 0, []), creator_fees_accrued: 500 }
  let new_datum = BondingCurveTierBDatum { ..datum, creator_fees_accrued: 300 }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.from_lovelace(1_000_000),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_lovelace(1_000_000),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"11"],
    }

  !bonding_curve_tier_b.spend(
    Some(datum),
    ClaimCreatorFees { amount: 200, platform_claim_fee: 200_000 },
    own_ref,
    self,
  )
}

test tier_b_claim_treasury_fees_rejects_without_real_payout() {
  // T108 fix: same gap as ClaimCreatorFees, applied to the governor's
  // treasury claim — datum shows the right decrement, but no output ever
  // pays the governor. No prior test coverage existed for this redeemer
  // at all before this fix.
  let datum =
    BondingCurveTierBDatum { ..mock_datum(Active, 0, []), treasury_fees_accrued: 500 }
  let new_datum = BondingCurveTierBDatum { ..datum, treasury_fees_accrued: 300 }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.from_lovelace(1_000_000),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      // Curve's own balance never actually shrank.
      value: assets.from_lovelace(1_000_000),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"22"],
    }

  !bonding_curve_tier_b.spend(Some(datum), ClaimTreasuryFees { amount: 200 }, own_ref, self)
}

test tier_b_claim_ops_fees_succeeds_with_real_payout() {
  // T108 fix: no prior test coverage existed for this redeemer at all.
  let datum = BondingCurveTierBDatum { ..mock_datum(Active, 0, []), ops_fees_accrued: 500 }
  let new_datum = BondingCurveTierBDatum { ..datum, ops_fees_accrued: 300 }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.from_lovelace(1_000_000),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_lovelace(999_800),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let governor_payout =
    Output {
      address: from_verification_key(#"22"),
      value: assets.from_lovelace(200),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, governor_payout],
      extra_signatories: [#"22"],
    }

  bonding_curve_tier_b.spend(Some(datum), ClaimOpsFees { amount: 200 }, own_ref, self)
}

/// T93/T115 fix (2026-07-22) regression: same real-base-address proof as
/// Tier A's identical test — see that file's own comment for why this
/// matters more than a cosmetic UX gap (the governor's real production
/// wallet is always a base address, so this redeemer's real payout was
/// silently broken before this fix, not just inconvenient).
test tier_b_claim_ops_fees_succeeds_paying_a_real_base_address_not_just_enterprise() {
  let datum = BondingCurveTierBDatum { ..mock_datum(Active, 0, []), ops_fees_accrued: 500 }
  let new_datum = BondingCurveTierBDatum { ..datum, ops_fees_accrued: 300 }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.from_lovelace(1_000_000),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_lovelace(999_800),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let governor_base_address = from_verification_key(#"22") |> with_delegation_key(#"ee")
  let governor_payout =
    Output {
      address: governor_base_address,
      value: assets.from_lovelace(200),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, governor_payout],
      extra_signatories: [#"22"],
    }

  bonding_curve_tier_b.spend(Some(datum), ClaimOpsFees { amount: 200 }, own_ref, self)
}

fn buyback_datum() -> BondingCurveTierBDatum {
  BondingCurveTierBDatum {
    ..mock_datum(Cancelled, 100, []),
    total_raised: 1000,
  }
}

test tier_b_claim_buyback_succeeds_with_correct_pro_rata_share() {
  let datum = buyback_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000 + 1000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 0),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum { ..datum, tokens_sold: 90, total_raised: 900 }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace - 100),
        assets.from_asset(#"33", "tok", 10),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let payout_output =
    Output {
      address: buyer_address,
      value: assets.from_lovelace(100),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, payout_output],
      extra_signatories: [#"dd"],
    }
  let redeemer = ClaimBuyback { token_amount: 10, buyer_key_hash: #"dd" }

  bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

/// T93/T115 fix (2026-07-22) regression: same real-base-address proof as
/// Tier A's identical test.
test tier_b_claim_buyback_succeeds_paying_a_real_base_address_not_just_enterprise() {
  let datum = buyback_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_base_address = from_verification_key(#"dd") |> with_delegation_key(#"ee")
  let base_lovelace = 5_000_000 + 1000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 0),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum { ..datum, tokens_sold: 90, total_raised: 900 }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace - 100),
        assets.from_asset(#"33", "tok", 10),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let payout_output =
    Output {
      address: buyer_base_address,
      value: assets.from_lovelace(100),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, payout_output],
      extra_signatories: [#"dd"],
    }
  let redeemer = ClaimBuyback { token_amount: 10, buyer_key_hash: #"dd" }

  bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test tier_b_claim_buyback_rejects_before_curve_cancelled() {
  let datum = BondingCurveTierBDatum { ..buyback_datum(), curve_state: Active }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000 + 1000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 0),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum { ..datum, tokens_sold: 90, total_raised: 900 }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace - 100),
        assets.from_asset(#"33", "tok", 10),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let payout_output =
    Output {
      address: buyer_address,
      value: assets.from_lovelace(100),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, payout_output],
      extra_signatories: [#"dd"],
    }
  let redeemer = ClaimBuyback { token_amount: 10, buyer_key_hash: #"dd" }

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

test tier_b_claim_buyback_rejects_unauthenticated_buyer() {
  let datum = buyback_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000 + 1000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 0),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum { ..datum, tokens_sold: 90, total_raised: 900 }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace - 100),
        assets.from_asset(#"33", "tok", 10),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let payout_output =
    Output {
      address: buyer_address,
      value: assets.from_lovelace(100),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, payout_output],
      // deliberately no extra_signatories
    }
  let redeemer = ClaimBuyback { token_amount: 10, buyer_key_hash: #"dd" }

  !bonding_curve_tier_b.spend(Some(datum), redeemer, own_ref, self)
}

fn graduation_datum() -> BondingCurveTierBDatum {
  BondingCurveTierBDatum {
    ..mock_datum(Graduated, 1000, []),
    total_raised: 98_000,
  }
}

test tier_b_graduate_succeeds_with_correct_lp_seeding() {
  let datum = graduation_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let lp_address = from_verification_key(#"ff")
  let base_lovelace = 5_000_000 + 98_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 150),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      total_raised: 0,
      lp_seeded: True,
      staking_seeded: True,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace - 98_000),
        assets.from_asset(#"33", "tok", 0),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let lp_output =
    Output {
      address: lp_address,
      value: assets.merge(
        assets.from_lovelace(98_000),
        assets.from_asset(#"33", "tok", 150),
      ),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, lp_output],
      // Graduate is permissionless — deliberately no extra_signatories.
    }

  bonding_curve_tier_b.spend(Some(datum), Graduate, own_ref, self)
}

test tier_b_graduate_rejects_padded_lp_output() {
  // T81: identical to tier_b_graduate_succeeds_with_correct_lp_seeding,
  // except the new lp_escrow genesis output carries one extra, unrelated
  // junk asset. Graduate is permissionless, so ANYONE could otherwise pad
  // the newly-seeded lp_escrow UTXO this way before the T81 fix.
  let datum = graduation_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let lp_address = from_verification_key(#"ff")
  let base_lovelace = 5_000_000 + 98_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 150),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      total_raised: 0,
      lp_seeded: True,
      staking_seeded: True,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace - 98_000),
        assets.from_asset(#"33", "tok", 0),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let lp_output =
    Output {
      address: lp_address,
      value: assets.merge(
        assets.merge(
          assets.from_lovelace(98_000),
          assets.from_asset(#"33", "tok", 150),
        ),
        // Junk asset from an unrelated policy — the padding attack.
        assets.from_asset(#"deadbeef", "spam", 1),
      ),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, lp_output],
    }

  !bonding_curve_tier_b.spend(Some(datum), Graduate, own_ref, self)
}

test tier_b_graduate_rejects_before_graduated() {
  let datum = BondingCurveTierBDatum { ..graduation_datum(), curve_state: Active }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let lp_address = from_verification_key(#"ff")
  let base_lovelace = 5_000_000 + 98_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 150),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      total_raised: 0,
      lp_seeded: True,
      staking_seeded: True,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace - 98_000),
        assets.from_asset(#"33", "tok", 0),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let lp_output =
    Output {
      address: lp_address,
      value: assets.merge(
        assets.from_lovelace(98_000),
        assets.from_asset(#"33", "tok", 150),
      ),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, lp_output],
    }

  !bonding_curve_tier_b.spend(Some(datum), Graduate, own_ref, self)
}

test tier_b_graduate_rejects_if_already_seeded() {
  let datum =
    BondingCurveTierBDatum { ..graduation_datum(), lp_seeded: True }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let lp_address = from_verification_key(#"ff")
  let base_lovelace = 5_000_000 + 98_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 150),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      total_raised: 0,
      lp_seeded: True,
      staking_seeded: True,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace - 98_000),
        assets.from_asset(#"33", "tok", 0),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let lp_output =
    Output {
      address: lp_address,
      value: assets.merge(
        assets.from_lovelace(98_000),
        assets.from_asset(#"33", "tok", 150),
      ),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, lp_output],
    }

  !bonding_curve_tier_b.spend(Some(datum), Graduate, own_ref, self)
}

// T66: Graduate + staking rewards pool seeding

fn staking_graduation_datum() -> BondingCurveTierBDatum {
  BondingCurveTierBDatum {
    ..graduation_datum(),
    staking_enabled: True,
    staking_reserve_tokens: 250,
  }
}

test tier_b_graduate_succeeds_with_lp_and_staking_seeding() {
  let datum = staking_graduation_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let lp_address = from_verification_key(#"ff")
  let staking_address = from_verification_key(#"aa")
  let base_lovelace = 5_000_000 + 98_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 400),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      total_raised: 0,
      lp_seeded: True,
      staking_seeded: True,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace - 98_000),
        assets.from_asset(#"33", "tok", 0),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let lp_output =
    Output {
      address: lp_address,
      value: assets.merge(
        assets.from_lovelace(98_000),
        assets.from_asset(#"33", "tok", 150),
      ),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let staking_output =
    Output {
      address: staking_address,
      value: assets.from_asset(#"33", "tok", 250),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, lp_output, staking_output],
    }

  bonding_curve_tier_b.spend(Some(datum), Graduate, own_ref, self)
}

test tier_b_graduate_rejects_missing_staking_output_when_enabled() {
  let datum = staking_graduation_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let lp_address = from_verification_key(#"ff")
  let base_lovelace = 5_000_000 + 98_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 400),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      total_raised: 0,
      lp_seeded: True,
      staking_seeded: True,
    }
  let continuing_output =
    Output {
      address: own_address,
      // Never actually loses the 250 staking_reserve_tokens.
      value: assets.merge(
        assets.from_lovelace(base_lovelace - 98_000),
        assets.from_asset(#"33", "tok", 250),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let lp_output =
    Output {
      address: lp_address,
      value: assets.merge(
        assets.from_lovelace(98_000),
        assets.from_asset(#"33", "tok", 150),
      ),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, lp_output],
    }

  !bonding_curve_tier_b.spend(Some(datum), Graduate, own_ref, self)
}

test tier_b_graduate_succeeds_without_staking_output_when_disabled() {
  let datum = graduation_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let lp_address = from_verification_key(#"ff")
  let base_lovelace = 5_000_000 + 98_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 150),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveTierBDatum {
      ..datum,
      total_raised: 0,
      lp_seeded: True,
      staking_seeded: True,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace - 98_000),
        assets.from_asset(#"33", "tok", 0),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let lp_output =
    Output {
      address: lp_address,
      value: assets.merge(
        assets.from_lovelace(98_000),
        assets.from_asset(#"33", "tok", 150),
      ),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, lp_output],
    }

  bonding_curve_tier_b.spend(Some(datum), Graduate, own_ref, self)
}

// T109: QueryState previously authorized ANY spend unconditionally
// (`QueryState -> True`, zero checks) — an unconditional authorization
// path. Proves the fix.
test query_state_rejects_unauthenticated_drain_attempt() {
  let datum = mock_datum(Active, 100, [])
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let attacker_address = from_verification_key(#"ee")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(50_000_000),
          assets.from_asset(#"33", "tok", 900),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let drain_output =
    Output {
      address: attacker_address,
      value: assets.merge(
        assets.from_lovelace(50_000_000),
        assets.from_asset(#"33", "tok", 900),
      ),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction { ..transaction.placeholder, inputs: [own_input], outputs: [drain_output] }

  !bonding_curve_tier_b.spend(Some(datum), QueryState, own_ref, self)
}
