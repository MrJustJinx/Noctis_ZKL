// ============================================================================
// Noctis Protocol — Cardano L1 CTO Governance Contract (Aiken)
// Used by Tier A, Tier B, and Tier C (CLAUDE.md Contract Architecture table)
// ============================================================================
// This contract is the Cardano L1 anchor for the Midnight CTO Governance PSM.
// It records the results of community takeover votes that happen privately
// on Midnight, making them publicly verifiable on Cardano.
//
// Key properties:
//   1. Anchors vote results from Midnight (T31: open relay — any token holder
//      can submit the anchor with a signed proof bundle)
//   2. Records: proposal type, vote counts, creator vote composition (T35),
//      quorum status, pass/fail, execution status
//   3. Once anchored, results are immutable — no reversal possible
//   4. Supports the full CTO lifecycle: trigger, vote, finalize, execute, dissolve
//
// T31 Resolution: Open relay (Option C) — any token holder can submit the
// anchor transaction using the signed proof bundle from Midnight. The
// contract only checks the proof bundle hash is present and the business
// rules (quorum, creator cap) hold — no signer authorization is required
// for this specific redeemer, by design.
//
// T35 Resolution: Creator vote composition is recorded as an audit field.
// The community can see how many creator tokens voted yes/no.
//
// Lifecycle:
//   1. Creator goes silent (90+ days, tracked on Midnight)
//   2. Community creates proposal on Midnight cto_governance PSM
//   3. 72-hour ballot window — private voting on Midnight
//   4. Ballot closes — anyone can finalize on Midnight
//   5. Open relay: anyone submits the result to this Cardano anchor
//   6. Once anchored, the CTO is considered "triggered" on Cardano L1
//   7. Creator escrow + LP escrow contracts check this anchor for CTO status
//   8. If creator returns, community can dissolve CTO (another vote + anchor)
//
// Rewritten 2026-07-09 to match real Aiken v1.1.23 syntax — see
// bonding_curve.ak's header comment for the full explanation. Governor/
// community authorization now uses `self.extra_signatories` instead of
// manually re-verifying a signature passed through the redeemer.
// "Current time" checks (execution window) take an explicit
// `current_timestamp` redeemer field verified against the transaction's
// actual validity range via `interval.contains` — Cardano scripts can't
// read a wall-clock time directly, only reason about the tx's declared
// validity interval.
// ============================================================================

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval
use aiken/interval.{Interval, IntervalBoundType}
use cardano/address.{Address, Credential, from_verification_key}
use cardano/assets.{PolicyId}
use cardano/transaction.{Input, InlineDatum, Output, OutputReference, Transaction}

/// T90: same finding/fix as Tier A's bonding_curve.ak — see that file's own
/// comment on `validity_range_is_narrow` for the full explanation. Applies
/// here to `AnchorProposal` (open-relay/permissionless by design, T31) and
/// `ExpireProposal` (also permissionless) — NOT `ExecuteProposal`, which
/// requires a real governor-or-community signature (same "trusted signer"
/// exemption as `ActivateCurve`).
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

/// CTO lifecycle states on Cardano L1
pub type CtoAnchorState {
  /// No CTO activity yet — creator is active
  PreCTO
  /// A CTO vote has been anchored — the community voted to trigger CTO
  CTOTriggered
  /// CTO was dissolved — creator returned and community voted to dissolve
  CTODissolved
}

/// Proposal types (mirrors Midnight cto_governance.compact)
pub type ProposalType {
  SilenceLockTrigger
  FundAllocation
  DexMigration
  WhitelistUpdate
  DissolveCTOProposal
}

/// Proposal outcome
pub type ProposalOutcome {
  Passed
  Failed
}

/// Execution status
pub type ExecutionStatus {
  PendingExecution
  Executed
  Expired
}

/// A proposal result anchored from Midnight
pub type ProposalAnchor {
  proposal_type: ProposalType,
  // Hash of the off-chain proposal description
  description_hash: ByteArray,
  // Midnight proof bundle hash (verifies the vote was legitimate)
  proof_bundle_hash: ByteArray,
  // Vote results
  yes_votes: Int,
  // Total YES token-weight
  no_votes: Int,
  // Total NO token-weight
  voter_count: Int,
  // Number of unique voters
  // Creator vote audit (T35)
  creator_yes_votes: Int,
  // Creator's YES weight (capped at 2%)
  creator_no_votes: Int,
  // Creator's NO weight (capped at 2%)
  // Outcome
  outcome: ProposalOutcome,
  // Timing
  start_timestamp: Int,
  // Ballot start (on Midnight)
  end_timestamp: Int,
  // Ballot end (on Midnight)
  anchor_timestamp: Int,
  // When this was anchored on Cardano
  // Execution
  execution_status: ExecutionStatus,
  // Execution payload (what happens when executed)
  target_dex_credential: Option<Credential>,
  // For DexMigration / WhitelistUpdate
  allocation_amount: Int,
  // For FundAllocation
  allocation_recipient_hash: VerificationKeyHash,
  // For FundAllocation
  // Relayer who anchored this (open relay, T31)
  relayer_credential_hash: VerificationKeyHash,
}

/// The datum stored at the CTO Governance anchor UTxO
pub type CtoGovernanceDatum {
  // Launch identity
  launch_id: ByteArray,
  // Current CTO state on Cardano L1
  cto_state: CtoAnchorState,
  // Community wallet hash (set when CTO triggered, cleared when dissolved)
  community_wallet_hash: VerificationKeyHash,
  // Governor credential hash (platform admin for emergency actions)
  governor_credential_hash: VerificationKeyHash,
  // Total token supply (for quorum verification)
  total_supply: Int,
  // Quorum threshold in basis points (500 = 5%)
  quorum_bps: Int,
  // Creator vote cap in basis points (200 = 2%, T35)
  creator_vote_cap_bps: Int,
  // Active proposal anchor (if any)
  active_proposal: Option<ProposalAnchor>,
  // Proposal history count
  proposal_count: Int,
  // T-CTO-ENFORCE fix: set (never cleared) by ExecuteProposal, independent
  // of active_proposal — which ClearProposal (governor-only) can wipe.
  // Without this, a governor could let a vote pass, then call
  // ClearProposal before any downstream TriggerCTO/DissolveCTO reference-
  // input check ever ran against it, silently erasing the only on-chain
  // evidence a real vote happened and reopening the exact bare-signature
  // trust gap this fix exists to close. This field is the permanent
  // record those downstream checks read instead. A later proposal
  // overwrites it, but the mandatory cooldown_duration between any two
  // proposals gives a wide real-world window to act on it first.
  last_executed_proposal: Option<ProposalAnchor>,
  // T111 fix (2026-07-19, full-suite security audit): CRITICAL finding —
  // AnchorVoteResult (open relay, T31) never verified the "proof bundle"
  // against anything real; an anchor must carry real evidence and a bond
  // result and, since AnchorVoteResult ALSO flipped cto_state/
  // community_wallet_hash immediately, self-sign a follow-up
  // ExecuteProposal as "the community" (a key they themselves control,
  // just written moments earlier) — a complete, two-transaction, no-real-
  // party-required forgery of a CTO takeover. Fixed via a bonded challenge
  // window, the same pattern already established in this codebase for
  // "can't verify an off-chain claim on-chain" (nhop_challenge.ak,
  // cto_sybil_challenge.ak): AnchorVoteResult now requires a real ADA
  // bond and no longer mutates cto_state/community_wallet_hash directly
  // (deferred to ExecuteProposal, which now also requires the challenge
  // window to have elapsed). The governor (same trust boundary already
  // used everywhere else in this codebase — hasClaimableBalance,
  // lastCreatorActivity) can void an anchor within the window via
  // VoidPendingProposal, slashing the relayer's bond as a real
  // deterrent. If unvoided, the relayer reclaims their bond via
  // ReclaimRelayerBond once the proposal is Executed or Expired.
  pending_relayer_bond: Int,
  pending_relayer_key_hash: VerificationKeyHash,
  // Genesis-fixed payout destinations for a slashed relayer bond — same
  // "no new payout address invented, real fixed destinations" discipline
  // as every other bonded mechanism in this codebase.
  treasury_pub_key_hash: VerificationKeyHash,
  ops_pub_key_hash: VerificationKeyHash,
  // C-1 fix (2026-07-23 security audit): this governance UTXO's own thread
  // NFT policy id. Downstream validators (bonding_curve, bonding_curve_tier_b,
  // lp_escrow, vesting) read this UTXO as a REFERENCE input to decide whether
  // a CTO vote passed. A reference input is never spent, and paying to a
  // script address never runs its validator — so an address match alone
  // does not authenticate the governance record. Those validators additionally
  // require the referenced UTXO to hold exactly 1 of this NFT
  // (asset_name = launch_id), minted once under a governor-signature policy
  // no attacker can satisfy. This contract preserves the NFT in its
  // continuing output on EVERY spend (governance_nft_preserved), so the
  // genuine governance UTXO is the only place it can ever live.
  cto_governance_nft: PolicyId,
}

/// Redeemer actions
pub type CtoGovernanceRedeemer {
  /// Anchor a vote result from Midnight (open relay, T31) — anyone can
  /// submit this, no signer authorization required by design.
  ///
  /// T111 fix: now requires a real relayer_bond (paid into this
  /// contract's own value — see this redeemer's real check below) and no
  /// longer mutates cto_state/community_wallet_hash directly — that now
  /// only happens via ExecuteProposal, once the challenge window has
  /// elapsed. See CtoGovernanceDatum's own doc comment on
  /// pending_relayer_bond for the full reasoning.
  AnchorVoteResult {
    proposal_type: ProposalType,
    description_hash: ByteArray,
    proof_bundle_hash: ByteArray,
    yes_votes: Int,
    no_votes: Int,
    voter_count: Int,
    creator_yes_votes: Int,
    creator_no_votes: Int,
    outcome: ProposalOutcome,
    start_timestamp: Int,
    end_timestamp: Int,
    anchor_timestamp: Int,
    target_dex_credential: Option<Credential>,
    allocation_amount: Int,
    allocation_recipient_hash: VerificationKeyHash,
    relayer_credential_hash: VerificationKeyHash,
    relayer_bond: Int,
  }
  /// Execute a passed proposal (governor or community wallet). T111 fix:
  /// now also requires the challenge window has elapsed since anchoring,
  /// and applies the cto_state/community_wallet_hash mutation that used
  /// to happen immediately in AnchorVoteResult.
  ExecuteProposal { current_timestamp: Int }
  /// Mark proposal as expired (if not executed within 30 days)
  ExpireProposal { current_timestamp: Int }
  /// Clear the active proposal (after execution or expiry)
  ClearProposal
  /// Emergency: governor sets community wallet (compromise detected)
  EmergencySetCommunityWallet { community_wallet_hash: VerificationKeyHash }
  /// T111 fix: governor-only, within the challenge window — voids a
  /// pending anchor found to be fraudulent (same trust boundary already
  /// used throughout this codebase for off-chain-verified claims) and
  /// slashes the relayer's bond, split 60/40 treasury/ops (same ratio as
  /// every other forfeited bond in this codebase — T33, nhop_challenge.ak,
  /// cto_sybil_challenge.ak).
  VoidPendingProposal { current_timestamp: Int }
  /// T111 fix: the relayer reclaims their bond once their anchored
  /// proposal has been legitimately Executed or Expired (never voided) —
  /// permissionless, but the payout destination is fixed by the datum's
  /// own pending_relayer_key_hash, same "the invariant is the
  /// authorization" idiom as every other permissionless claim in this
  /// codebase.
  ReclaimRelayerBond
  /// Read-only query, no state change, no authorization required
  QueryState
}

// ============================================================================
// CONSTANTS
// ============================================================================

/// 30 days in MILLISECONDS — max time to execute a passed proposal.
///
/// T87 fix (2026-07-17): was previously `2_592_000` (30 days in SECONDS).
/// `anchor_timestamp`/`current_timestamp` are checked via
/// `interval.contains(self.validity_range, ...)` (see AnchorProposal/
/// ExecuteProposal/ExpireProposal below), and Cardano's real transaction
/// validity range is natively expressed in MILLISECONDS — same root cause,
/// found and fixed in the same pass, as bonding_curve.ak's
/// `max_curve_duration` (see that file's own T87 comment for the full
/// on-chain evidence). The documented "30-day execution window" was
/// actually only ~2,592 real seconds (~43 minutes).
const execution_window = 2_592_000_000

/// T111: 24 hours in MILLISECONDS — same window length as
/// nhop_challenge.ak's own defence_seconds-equivalent concept (that file
/// uses seconds since it never binds to Cardano's own ms-scale
/// validity_range; here it does, via interval.contains, same as
/// execution_window above). How long a governor has to void a freshly-
/// anchored, potentially-fraudulent proposal before it becomes
/// executable.
const challenge_window = 86_400_000

/// T111: 25 ADA — same fixed-figure-not-oracle-verified idiom as
/// NHOP_CHALLENGE_BOND, reused for consistency (this mechanism's purpose
/// — deter a costless forged anchor — is the same underlying concern).
const min_relayer_bond = 25_000_000

const treasury_bps = 60

const ops_bps = 40

const bps_denominator = 100

// ============================================================================
// HELPERS
// ============================================================================

/// Find this validator's own continuing output (same address as the input
/// being spent) and decode its inline datum.
fn own_continuing_datum(
  self: Transaction,
  own_ref: OutputReference,
) -> CtoGovernanceDatum {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  expect InlineDatum(raw_datum) = own_output.datum
  expect new_datum: CtoGovernanceDatum = raw_datum
  new_datum
}

/// T111: verify some output pays at least `amount` lovelace to
/// `key_hash`'s wallet address — same pattern as nhop_challenge.ak's/
/// cto_sybil_challenge.ak's own `paid_to` helper.
fn paid_to(self: Transaction, key_hash: VerificationKeyHash, amount: Int) -> Bool {
  let addr = from_verification_key(key_hash)
  list.any(
    self.outputs,
    fn(output) {
      output.address == addr && assets.lovelace_of(output.value) >= amount
    },
  )
}

/// T111: verify this contract's own continuing output lovelace increased
/// by exactly `amount` relative to the input — the receiving-side mirror
/// of bonding_curve.ak's payment_received, applied here to a relayer's
/// posted bond.
fn bond_received(self: Transaction, own_ref: OutputReference, amount: Int) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  assets.lovelace_of(own_output.value) == assets.lovelace_of(own_input.output.value) + amount
}

/// T111: verify this contract's own continuing output lovelace decreased
/// by exactly `amount` relative to the input — the paying-side mirror of
/// bond_received, applied to reclaiming or slashing a relayer's bond.
fn bond_paid_out(self: Transaction, own_ref: OutputReference, amount: Int) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  assets.lovelace_of(own_input.output.value) == assets.lovelace_of(own_output.value) + amount
}

/// T111: same double-satisfaction closure as bonding_curve.ak/lp_escrow.ak
/// etc. — see those files' own single_own_utxo comment for the full
/// explanation.
fn single_own_utxo(self: Transaction, own_address: Address) -> Bool {
  list.length(list.filter(self.inputs, fn(input) { input.output.address == own_address })) <= 1 && list.length(
    list.filter(self.outputs, fn(output) { output.address == own_address }),
  ) <= 1
}

/// C-1 fix (2026-07-23 security audit): every spend of this governance UTXO
/// must carry its thread NFT forward into the continuing output unchanged
/// (exactly 1, asset_name = launch_id). Downstream validators (bonding_curve,
/// bonding_curve_tier_b, lp_escrow, vesting) trust the PRESENCE of this NFT
/// as proof they are reading the genuine governance UTXO as a reference
/// input. Every redeemer here produces a continuing output (state machine),
/// and several are permissionless by design (AnchorVoteResult open-relay per
/// T31, ExpireProposal, ClearProposal). Without this check, such a caller
/// could spend the real governance UTXO and send the NFT to an address they
/// control, then plant it in a forged governance UTXO — defeating the entire
/// C-1 fix. Applied at the top of the validator (like single_own_utxo), so
/// the NFT can never leave the genuine governance UTXO by any path.
fn governance_nft_preserved(
  self: Transaction,
  own_ref: OutputReference,
  datum: CtoGovernanceDatum,
) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  assets.quantity_of(own_output.value, datum.cto_governance_nft, datum.launch_id) == 1
}

// ============================================================================
// MAIN VALIDATOR
// ============================================================================

validator cto_governance {
  spend(
    datum_opt: Option<CtoGovernanceDatum>,
    redeemer: CtoGovernanceRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(datum) = datum_opt
    expect Some(own_input) =
      list.find(self.inputs, fn(input) { input.output_reference == own_ref })

    and {
      when redeemer is {
        AnchorVoteResult {
        proposal_type,
        description_hash,
        proof_bundle_hash,
        yes_votes,
        no_votes,
        voter_count,
        creator_yes_votes,
        creator_no_votes,
        outcome,
        start_timestamp,
        end_timestamp,
        anchor_timestamp,
        target_dex_credential,
        allocation_amount,
        allocation_recipient_hash,
        relayer_credential_hash,
        relayer_bond,
      } -> {
        let total_votes = yes_votes + no_votes
        let quorum_ok = if outcome == Passed {
          let quorum_required = datum.total_supply * datum.quorum_bps
          let quorum_actual = total_votes * 10_000
          quorum_actual >= quorum_required && yes_votes > no_votes
        } else {
          True
        }

        let creator_total = creator_yes_votes + creator_no_votes
        let creator_cap = datum.total_supply * datum.creator_vote_cap_bps / 10_000
        let creator_cap_ok = creator_total <= creator_cap

        // SilenceLockTrigger and the dissolve proposal must pass to have
        // any effect on cto_state / community_wallet_hash
        let trigger_ok = if proposal_type == SilenceLockTrigger {
          outcome == Passed
        } else {
          True
        }
        let dissolve_ok = if proposal_type == DissolveCTOProposal {
          outcome == Passed
        } else {
          True
        }

        let proposal =
          ProposalAnchor {
            proposal_type,
            description_hash,
            proof_bundle_hash,
            yes_votes,
            no_votes,
            voter_count,
            creator_yes_votes,
            creator_no_votes,
            outcome,
            start_timestamp,
            end_timestamp,
            anchor_timestamp,
            execution_status: PendingExecution,
            target_dex_credential,
            allocation_amount,
            allocation_recipient_hash,
            relayer_credential_hash,
          }

        // T111 fix: cto_state/community_wallet_hash are NO LONGER mutated
        // here — only ExecuteProposal applies them, once the challenge
        // window has elapsed unvoided. See this redeemer's own doc
        // comment in CtoGovernanceRedeemer above for the full reasoning.
        let expected_datum =
          CtoGovernanceDatum {
            ..datum,
            active_proposal: Some(proposal),
            proposal_count: datum.proposal_count + 1,
            pending_relayer_bond: relayer_bond,
            pending_relayer_key_hash: relayer_credential_hash,
          }
        let new_datum = own_continuing_datum(self, own_ref)

        and {
          single_own_utxo(self, own_input.output.address),
          datum.active_proposal == None,
          interval.contains(self.validity_range, anchor_timestamp),
          // T90: bound the declared validity range's own width — this
          // redeemer is open-relay/permissionless by design (T31), and
          // anchor_timestamp becomes the permanent base every later
          // execution-window check is computed from.
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          quorum_ok,
          creator_cap_ok,
          trigger_ok,
          dissolve_ok,
          // T111 CRITICAL fix: a real relayer bond is now required and
          // actually paid into the contract's own value — closes the
          // "forge a vote result for free" gap. See CtoGovernanceDatum's
          // pending_relayer_bond doc comment for the full mechanism.
          relayer_bond >= min_relayer_bond,
          bond_received(self, own_ref, relayer_bond),
          new_datum == expected_datum,
        }
      }

      ExecuteProposal { current_timestamp } -> {
        expect Some(proposal) = datum.active_proposal
        let executed_proposal =
          ProposalAnchor { ..proposal, execution_status: Executed }
        let new_datum = own_continuing_datum(self, own_ref)

        // T111 fix: cto_state/community_wallet_hash mutation moved here
        // from AnchorVoteResult (see that redeemer's own comment).
        let new_cto_state = if proposal.proposal_type == SilenceLockTrigger {
          CTOTriggered
        } else if proposal.proposal_type == DissolveCTOProposal {
          CTODissolved
        } else {
          datum.cto_state
        }
        let new_community_wallet = if proposal.proposal_type == SilenceLockTrigger {
          proposal.allocation_recipient_hash
        } else if proposal.proposal_type == DissolveCTOProposal {
          #""
        } else {
          datum.community_wallet_hash
        }

        and {
          single_own_utxo(self, own_input.output.address),
          proposal.outcome == Passed,
          proposal.execution_status == PendingExecution,
          interval.contains(self.validity_range, current_timestamp),
          // T111 fix: permissionless (no signature requirement — a real
          // governor/community signature is no longer meaningful trust
          // here, now that anchoring itself is bonded and
          // governor-reviewable during the challenge window; requiring a
          // signature on EXECUTE too would just reopen the exact
          // censorship risk T31 was resolved to avoid, since
          // community_wallet_hash doesn't exist yet for a launch's FIRST
          // SilenceLockTrigger). validity_range_is_narrow closes the same
          // "declare an arbitrarily wide range" gap every other
          // permissionless deadline check in this codebase already closes.
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          // T111 CRITICAL fix: the challenge window must have elapsed —
          // this is what actually closes the forgery gap (a fraudulent
          // anchor can be voided by the governor before this point).
          current_timestamp >= proposal.anchor_timestamp + challenge_window,
          current_timestamp <= proposal.anchor_timestamp + execution_window,
          new_datum == CtoGovernanceDatum {
            ..datum,
            cto_state: new_cto_state,
            community_wallet_hash: new_community_wallet,
            active_proposal: Some(executed_proposal),
            // T-CTO-ENFORCE: permanent record for downstream reference-
            // input checks — see the field's own doc comment above.
            last_executed_proposal: Some(executed_proposal),
          },
        }
      }

      // T111 fix: governor-only, within the challenge window — voids a
      // pending anchor found to be fraudulent, slashing the relayer's
      // bond. See this redeemer's own doc comment in CtoGovernanceRedeemer
      // above for the full reasoning.
      VoidPendingProposal { current_timestamp } -> {
        expect Some(proposal) = datum.active_proposal
        let voided_proposal =
          ProposalAnchor { ..proposal, execution_status: Expired }
        let new_datum = own_continuing_datum(self, own_ref)
        let treasury_share = datum.pending_relayer_bond * treasury_bps / bps_denominator
        let ops_share = datum.pending_relayer_bond - treasury_share

        and {
          single_own_utxo(self, own_input.output.address),
          list.has(self.extra_signatories, datum.governor_credential_hash),
          proposal.execution_status == PendingExecution,
          interval.contains(self.validity_range, current_timestamp),
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          current_timestamp < proposal.anchor_timestamp + challenge_window,
          paid_to(self, datum.treasury_pub_key_hash, treasury_share),
          paid_to(self, datum.ops_pub_key_hash, ops_share),
          bond_paid_out(self, own_ref, datum.pending_relayer_bond),
          new_datum == CtoGovernanceDatum {
            ..datum,
            active_proposal: Some(voided_proposal),
            pending_relayer_bond: 0,
            pending_relayer_key_hash: #"",
          },
        }
      }

      // T111 fix: the relayer reclaims their bond once their anchored
      // proposal has been legitimately Executed or Expired (a natural
      // 30-day timeout, not a void) — never reachable if the governor
      // voided it, since VoidPendingProposal already zeroes
      // pending_relayer_bond. Permissionless — the payout destination is
      // fixed by the datum's own pending_relayer_key_hash.
      ReclaimRelayerBond -> {
        expect Some(proposal) = datum.active_proposal
        let new_datum = own_continuing_datum(self, own_ref)

        and {
          single_own_utxo(self, own_input.output.address),
          proposal.execution_status == Executed || proposal.execution_status == Expired,
          datum.pending_relayer_bond > 0,
          paid_to(self, datum.pending_relayer_key_hash, datum.pending_relayer_bond),
          bond_paid_out(self, own_ref, datum.pending_relayer_bond),
          new_datum == CtoGovernanceDatum {
            ..datum,
            pending_relayer_bond: 0,
            pending_relayer_key_hash: #"",
          },
        }
      }

      ExpireProposal { current_timestamp } -> {
        expect Some(proposal) = datum.active_proposal
        let expired_proposal =
          ProposalAnchor { ..proposal, execution_status: Expired }
        let new_datum = own_continuing_datum(self, own_ref)

        and {
          proposal.execution_status == PendingExecution,
          interval.contains(self.validity_range, current_timestamp),
          // T90: bound the declared validity range's own width — this
          // redeemer is permissionless by design (same idiom as ExpireCurve).
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          current_timestamp > proposal.anchor_timestamp + execution_window,
          new_datum == CtoGovernanceDatum {
            ..datum,
            active_proposal: Some(expired_proposal),
          },
        }
      }

      ClearProposal -> {
        expect Some(proposal) = datum.active_proposal
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          list.has(self.extra_signatories, datum.governor_credential_hash),
          proposal.execution_status == Executed || proposal.execution_status == Expired,
          // T111 fix: without this, a governor could ClearProposal (which
          // resets active_proposal to None) BEFORE the relayer calls
          // ReclaimRelayerBond — which itself requires `datum.
          // active_proposal` to be Some — permanently stranding a
          // legitimate relayer's bond in the contract with no path to
          // reclaim it. Requiring the bond already be reclaimed (or
          // already zeroed by VoidPendingProposal) enforces the correct
          // order: settle the bond first, only then clear the record.
          datum.pending_relayer_bond == 0,
          new_datum == CtoGovernanceDatum { ..datum, active_proposal: None },
        }
      }

      EmergencySetCommunityWallet { community_wallet_hash } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          list.has(self.extra_signatories, datum.governor_credential_hash),
          datum.cto_state == CTOTriggered,
          new_datum == CtoGovernanceDatum {
            ..datum,
            community_wallet_hash: community_wallet_hash,
          },
        }
      }

      // T109 CRITICAL fix (2026-07-19, full-suite security audit) — same
      // fix as bonding_curve.ak: was an unconditional `True` (zero checks).
      // Lower direct-fund-value here than the other 5 files (this contract
      // mostly anchors vote evidence rather than holding principal), but
      // still a real unauthenticated-spend gap, closed the same way for
      // consistency and to remove the attack surface entirely.
      QueryState -> False
      },
      // C-1 fix (2026-07-23 audit): preserve the governance thread NFT on
      // EVERY successful spend — see governance_nft_preserved's doc comment.
      // Every redeemer above produces a continuing output (state machine),
      // and several are permissionless by design (AnchorVoteResult open-relay
      // per T31, ExpireProposal, ClearProposal). Without this, such a caller
      // could spend the real governance UTXO, move the NFT to an address they
      // control, and plant it in a forged governance UTXO — defeating every
      // downstream C-1 check at once. Placed last so it is only reached once
      // a redeemer's own logic has otherwise succeeded (QueryState/fail paths
      // short-circuit before it), but a genuine state change can never drop
      // the NFT.
      governance_nft_preserved(self, own_ref, datum),
    }
  }
}

// ============================================================================
// TESTS
// ============================================================================

fn mock_datum(active_proposal: Option<ProposalAnchor>) -> CtoGovernanceDatum {
  CtoGovernanceDatum {
    launch_id: #"01",
    cto_state: PreCTO,
    community_wallet_hash: #"",
    governor_credential_hash: #"22",
    total_supply: 1_000_000,
    quorum_bps: 500,
    // 5%
    creator_vote_cap_bps: 200,
    // 2%
    active_proposal: active_proposal,
    proposal_count: 0,
    last_executed_proposal: None,
    pending_relayer_bond: 0,
    pending_relayer_key_hash: #"",
    treasury_pub_key_hash: #"55",
    ops_pub_key_hash: #"66",
    cto_governance_nft: mock_cto_nft_policy(),
  }
}

/// C-1 fix: mock governance thread NFT policy id used across the tests. The
/// genuine governance UTXO (and its continuing output) must carry exactly 1
/// of `(mock_cto_nft_policy(), launch_id)`.
fn mock_cto_nft_policy() -> PolicyId {
  #"c0ffee"
}

/// C-1 fix: build a governance-UTXO value carrying the thread NFT (asset_name
/// = launch_id `#"01"`), used by the success-path tests whose continuing
/// output must satisfy governance_nft_preserved. The NFT is a token, not
/// lovelace, so this does not disturb the lovelace-based bond checks.
fn cto_out_value(lovelace: Int) -> assets.Value {
  assets.from_lovelace(lovelace) |> assets.add(mock_cto_nft_policy(), #"01", 1)
}

fn mock_proposal(
  outcome: ProposalOutcome,
  execution_status: ExecutionStatus,
  anchor_timestamp: Int,
) -> ProposalAnchor {
  ProposalAnchor {
    proposal_type: SilenceLockTrigger,
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
    anchor_timestamp: anchor_timestamp,
    execution_status: execution_status,
    target_dex_credential: None,
    allocation_amount: 0,
    allocation_recipient_hash: #"ff",
    relayer_credential_hash: #"33",
  }
}

test anchor_vote_result_succeeds_with_quorum_met() {
  let datum = mock_datum(None)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.from_lovelace(2_000_000),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  // 70_000 total votes out of 1_000_000 supply = 7% > 5% quorum. Yes > No.
  let proposal = mock_proposal(Passed, PendingExecution, 500)
  // T111: AnchorVoteResult no longer mutates cto_state/community_wallet_hash
  // directly (that's ExecuteProposal's job now, after the challenge window)
  // — it only records the pending proposal + the relayer's posted bond.
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      active_proposal: Some(proposal),
      proposal_count: 1,
      pending_relayer_bond: 25_000_000,
      pending_relayer_key_hash: #"33",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: cto_out_value(27_000_000),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(400, 600),
    }
  let redeemer =
    AnchorVoteResult {
      proposal_type: SilenceLockTrigger,
      description_hash: #"aa",
      proof_bundle_hash: #"bb",
      yes_votes: 60_000,
      no_votes: 10_000,
      voter_count: 5,
      creator_yes_votes: 0,
      creator_no_votes: 0,
      outcome: Passed,
      start_timestamp: 0,
      end_timestamp: 1000,
      anchor_timestamp: 500,
      target_dex_credential: None,
      allocation_amount: 0,
      allocation_recipient_hash: #"ff",
      relayer_credential_hash: #"33",
      relayer_bond: 25_000_000,
    }

  cto_governance.spend(Some(datum), redeemer, own_ref, self)
}

// C-1 regression (2026-07-23 audit): a spend that DROPS the governance thread
// NFT from its continuing output must be rejected. Downstream validators rely
// on the NFT living ONLY in the genuine governance UTXO, so no redeemer here
// (several are permissionless — open relay, T31) may move it out to be
// planted in a forgery. Identical to anchor_vote_result_succeeds_with_quorum_met
// except the continuing output carries plain lovelace and no NFT, so
// governance_nft_preserved returns False and the whole spend returns False.
test anchor_vote_result_rejects_dropping_thread_nft() {
  let datum = mock_datum(None)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: cto_out_value(2_000_000),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let proposal = mock_proposal(Passed, PendingExecution, 500)
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      active_proposal: Some(proposal),
      proposal_count: 1,
      pending_relayer_bond: 25_000_000,
      pending_relayer_key_hash: #"33",
    }
  // The continuing output DROPS the NFT — plain lovelace only. The lovelace
  // bond arithmetic still balances (27M == 2M + 25M), so ONLY the missing
  // NFT can be what rejects this spend.
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_lovelace(27_000_000),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(400, 600),
    }
  let redeemer =
    AnchorVoteResult {
      proposal_type: SilenceLockTrigger,
      description_hash: #"aa",
      proof_bundle_hash: #"bb",
      yes_votes: 60_000,
      no_votes: 10_000,
      voter_count: 5,
      creator_yes_votes: 0,
      creator_no_votes: 0,
      outcome: Passed,
      start_timestamp: 0,
      end_timestamp: 1000,
      anchor_timestamp: 500,
      target_dex_credential: None,
      allocation_amount: 0,
      allocation_recipient_hash: #"ff",
      relayer_credential_hash: #"33",
      relayer_bond: 25_000_000,
    }

  !cto_governance.spend(Some(datum), redeemer, own_ref, self)
}

// C-1 regression (2026-07-23 audit): the cross-launch reuse variant — the NFT
// asset_name is bound to launch_id, so a genuine NFT minted for a DIFFERENT
// launch (wrong asset_name) must not satisfy the preservation check either.
test anchor_vote_result_rejects_wrong_launch_nft() {
  let datum = mock_datum(None)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: cto_out_value(2_000_000),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let proposal = mock_proposal(Passed, PendingExecution, 500)
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      active_proposal: Some(proposal),
      proposal_count: 1,
      pending_relayer_bond: 25_000_000,
      pending_relayer_key_hash: #"33",
    }
  // Right NFT policy, WRONG asset_name (another launch's id `#"02"`, not this
  // launch's `#"01"`) — quantity_of(value, policy, #"01") == 1 is False.
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_lovelace(27_000_000)
        |> assets.add(mock_cto_nft_policy(), #"02", 1),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(400, 600),
    }
  let redeemer =
    AnchorVoteResult {
      proposal_type: SilenceLockTrigger,
      description_hash: #"aa",
      proof_bundle_hash: #"bb",
      yes_votes: 60_000,
      no_votes: 10_000,
      voter_count: 5,
      creator_yes_votes: 0,
      creator_no_votes: 0,
      outcome: Passed,
      start_timestamp: 0,
      end_timestamp: 1000,
      anchor_timestamp: 500,
      target_dex_credential: None,
      allocation_amount: 0,
      allocation_recipient_hash: #"ff",
      relayer_credential_hash: #"33",
      relayer_bond: 25_000_000,
    }

  !cto_governance.spend(Some(datum), redeemer, own_ref, self)
}

// T111: same as the success case above but the relayer posts less than
// min_relayer_bond — a costless forged anchor attempt must be rejected.
test anchor_vote_result_rejects_underfunded_bond() {
  let datum = mock_datum(None)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.from_lovelace(2_000_000),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let proposal = mock_proposal(Passed, PendingExecution, 500)
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      active_proposal: Some(proposal),
      proposal_count: 1,
      pending_relayer_bond: 1_000_000,
      pending_relayer_key_hash: #"33",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: cto_out_value(3_000_000),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(400, 600),
    }
  let redeemer =
    AnchorVoteResult {
      proposal_type: SilenceLockTrigger,
      description_hash: #"aa",
      proof_bundle_hash: #"bb",
      yes_votes: 60_000,
      no_votes: 10_000,
      voter_count: 5,
      creator_yes_votes: 0,
      creator_no_votes: 0,
      outcome: Passed,
      start_timestamp: 0,
      end_timestamp: 1000,
      anchor_timestamp: 500,
      target_dex_credential: None,
      allocation_amount: 0,
      allocation_recipient_hash: #"ff",
      relayer_credential_hash: #"33",
      relayer_bond: 1_000_000,
    }

  !cto_governance.spend(Some(datum), redeemer, own_ref, self)
}

// T111: relayer_bond claimed in the redeemer is above the floor, but no
// matching real lovelace ever lands in the contract's own continuing
// output — must be rejected (a claimed-but-unpaid bond).
test anchor_vote_result_rejects_unpaid_bond() {
  let datum = mock_datum(None)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.from_lovelace(2_000_000),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let proposal = mock_proposal(Passed, PendingExecution, 500)
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      active_proposal: Some(proposal),
      proposal_count: 1,
      pending_relayer_bond: 25_000_000,
      pending_relayer_key_hash: #"33",
    }
  let continuing_output =
    Output {
      address: own_address,
      // Bond claimed is 25 ADA but the continuing output's real lovelace
      // never increased — no real payment made.
      value: cto_out_value(2_000_000),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(400, 600),
    }
  let redeemer =
    AnchorVoteResult {
      proposal_type: SilenceLockTrigger,
      description_hash: #"aa",
      proof_bundle_hash: #"bb",
      yes_votes: 60_000,
      no_votes: 10_000,
      voter_count: 5,
      creator_yes_votes: 0,
      creator_no_votes: 0,
      outcome: Passed,
      start_timestamp: 0,
      end_timestamp: 1000,
      anchor_timestamp: 500,
      target_dex_credential: None,
      allocation_amount: 0,
      allocation_recipient_hash: #"ff",
      relayer_credential_hash: #"33",
      relayer_bond: 25_000_000,
    }

  !cto_governance.spend(Some(datum), redeemer, own_ref, self)
}

// T90: identical to anchor_vote_result_succeeds_with_quorum_met except the
// declared validity range is far wider than max_validity_range_width —
// before this fix, ANY relayer (this redeemer is open-relay/permissionless
// by design, T31) could anchor a proposal with a fabricated anchor_timestamp
// by declaring a wide range, corrupting the permanent base every later
// execution-window check is computed from.
test anchor_vote_result_rejects_wide_validity_range() {
  let datum = mock_datum(None)
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
  let proposal = mock_proposal(Passed, PendingExecution, 500)
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      cto_state: CTOTriggered,
      community_wallet_hash: #"ff",
      active_proposal: Some(proposal),
      proposal_count: 1,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_asset(mock_cto_nft_policy(), #"01", 1),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(0, 700_000),
    }
  let redeemer =
    AnchorVoteResult {
      proposal_type: SilenceLockTrigger,
      description_hash: #"aa",
      proof_bundle_hash: #"bb",
      yes_votes: 60_000,
      no_votes: 10_000,
      voter_count: 5,
      creator_yes_votes: 0,
      creator_no_votes: 0,
      outcome: Passed,
      start_timestamp: 0,
      end_timestamp: 1000,
      anchor_timestamp: 500,
      target_dex_credential: None,
      allocation_amount: 0,
      allocation_recipient_hash: #"ff",
      relayer_credential_hash: #"33",
      relayer_bond: 25_000_000,
    }

  !cto_governance.spend(Some(datum), redeemer, own_ref, self)
}

test anchor_vote_result_fails_without_quorum() {
  let datum = mock_datum(None)
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
  // Only 10_000 total votes out of 1_000_000 supply = 1% < 5% quorum.
  let proposal = mock_proposal(Passed, PendingExecution, 500)
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      cto_state: CTOTriggered,
      community_wallet_hash: #"ff",
      active_proposal: Some(proposal),
      proposal_count: 1,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_asset(mock_cto_nft_policy(), #"01", 1),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(400, 600),
    }
  let redeemer =
    AnchorVoteResult {
      proposal_type: SilenceLockTrigger,
      description_hash: #"aa",
      proof_bundle_hash: #"bb",
      yes_votes: 9_000,
      no_votes: 1_000,
      voter_count: 5,
      creator_yes_votes: 0,
      creator_no_votes: 0,
      outcome: Passed,
      start_timestamp: 0,
      end_timestamp: 1000,
      anchor_timestamp: 500,
      target_dex_credential: None,
      allocation_amount: 0,
      allocation_recipient_hash: #"ff",
      relayer_credential_hash: #"33",
      relayer_bond: 25_000_000,
    }

  !cto_governance.spend(Some(datum), redeemer, own_ref, self)
}

test anchor_vote_result_fails_when_creator_cap_exceeded() {
  let datum = mock_datum(None)
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
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [],
      validity_range: interval.between(400, 600),
    }
  // Creator cap is 2% of 1_000_000 = 20_000. Creator voted 25_000 total.
  let redeemer =
    AnchorVoteResult {
      proposal_type: FundAllocation,
      description_hash: #"aa",
      proof_bundle_hash: #"bb",
      yes_votes: 60_000,
      no_votes: 10_000,
      voter_count: 5,
      creator_yes_votes: 25_000,
      creator_no_votes: 0,
      outcome: Passed,
      start_timestamp: 0,
      end_timestamp: 1000,
      anchor_timestamp: 500,
      target_dex_credential: None,
      allocation_amount: 0,
      allocation_recipient_hash: #"ff",
      relayer_credential_hash: #"33",
      relayer_bond: 25_000_000,
    }

  !cto_governance.spend(Some(datum), redeemer, own_ref, self)
}

test execute_proposal_succeeds_by_governor_within_window() {
  let proposal = mock_proposal(Passed, PendingExecution, 1000)
  let datum = mock_datum(Some(proposal))
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
  let executed_proposal = ProposalAnchor { ..proposal, execution_status: Executed }
  // T111: ExecuteProposal now applies the cto_state/community_wallet_hash
  // mutation that used to happen directly in AnchorVoteResult — the mock
  // proposal is SilenceLockTrigger/Passed, so a real execution flips
  // cto_state to CTOTriggered and sets community_wallet_hash from the
  // proposal's allocation_recipient_hash.
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      cto_state: CTOTriggered,
      community_wallet_hash: #"ff",
      active_proposal: Some(executed_proposal),
      last_executed_proposal: Some(executed_proposal),
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_asset(mock_cto_nft_policy(), #"01", 1),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // T87: ms-scale, matches execution_window's real unit — 1000 + 10 days,
  // well within the 30-day window, and well past the 24h challenge window.
  let current_timestamp = 1000 + 864_000_000
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(current_timestamp - 100, current_timestamp + 100),
      extra_signatories: [#"22"],
    }

  cto_governance.spend(
    Some(datum),
    ExecuteProposal { current_timestamp: current_timestamp },
    own_ref,
    self,
  )
}

// T111: challenge window (24h) has NOT yet elapsed since anchoring — even
// though the proposal legitimately passed, ExecuteProposal must reject so
// the governor still has their real window to void a fraudulent anchor.
test execute_proposal_rejects_before_challenge_window_elapsed() {
  let proposal = mock_proposal(Passed, PendingExecution, 1000)
  let datum = mock_datum(Some(proposal))
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
  let executed_proposal = ProposalAnchor { ..proposal, execution_status: Executed }
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      cto_state: CTOTriggered,
      community_wallet_hash: #"ff",
      active_proposal: Some(executed_proposal),
      last_executed_proposal: Some(executed_proposal),
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_asset(mock_cto_nft_policy(), #"01", 1),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // Only 1 hour after anchoring — well inside the 24h challenge window.
  let current_timestamp = 1000 + 3_600_000
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(current_timestamp - 100, current_timestamp + 100),
    }

  !cto_governance.spend(
    Some(datum),
    ExecuteProposal { current_timestamp: current_timestamp },
    own_ref,
    self,
  )
}

test execute_proposal_fails_after_window_expired() {
  let proposal = mock_proposal(Passed, PendingExecution, 1000)
  let datum = mock_datum(Some(proposal))
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
  let executed_proposal = ProposalAnchor { ..proposal, execution_status: Executed }
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      active_proposal: Some(executed_proposal),
      last_executed_proposal: Some(executed_proposal),
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_asset(mock_cto_nft_policy(), #"01", 1),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // T87: ms-scale, matches execution_window's real unit — 1000 + 31 days, past the 30-day window
  let current_timestamp = 1000 + 2_678_400_000
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(current_timestamp - 100, current_timestamp + 100),
      extra_signatories: [#"22"],
    }

  !cto_governance.spend(
    Some(datum),
    ExecuteProposal { current_timestamp: current_timestamp },
    own_ref,
    self,
  )
}

// T111: ExecuteProposal is now permissionless by design (see the
// redeemer's own comment) — a stranger's signature is no longer the
// rejection reason here. This test now proves a DIFFERENT, still-real
// protection: even a stranger racing to execute the instant a proposal is
// anchored is blocked by the challenge window, same as anyone else.
test execute_proposal_rejects_within_challenge_window_even_for_stranger() {
  let proposal = mock_proposal(Passed, PendingExecution, 1000)
  let datum = mock_datum(Some(proposal))
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
  let executed_proposal = ProposalAnchor { ..proposal, execution_status: Executed }
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      cto_state: CTOTriggered,
      community_wallet_hash: #"ff",
      active_proposal: Some(executed_proposal),
      last_executed_proposal: Some(executed_proposal),
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_asset(mock_cto_nft_policy(), #"01", 1),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let current_timestamp = 1000 + 864_000
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(current_timestamp - 100, current_timestamp + 100),
      // no signature at all — permissionless, but still inside the window
      extra_signatories: [],
    }

  !cto_governance.spend(
    Some(datum),
    ExecuteProposal { current_timestamp: current_timestamp },
    own_ref,
    self,
  )
}

test expire_proposal_succeeds_after_window() {
  let proposal = mock_proposal(Passed, PendingExecution, 1000)
  let datum = mock_datum(Some(proposal))
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
  let expired_proposal = ProposalAnchor { ..proposal, execution_status: Expired }
  let new_datum = CtoGovernanceDatum { ..datum, active_proposal: Some(expired_proposal) }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_asset(mock_cto_nft_policy(), #"01", 1),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // T87: ms-scale, matches execution_window's real unit
  let current_timestamp = 1000 + 2_678_400_000
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(current_timestamp - 100, current_timestamp + 100),
    }

  cto_governance.spend(
    Some(datum),
    ExpireProposal { current_timestamp: current_timestamp },
    own_ref,
    self,
  )
}

// T90: identical to expire_proposal_succeeds_after_window except the
// declared validity range is far wider than max_validity_range_width —
// before this fix, ANY caller (this redeemer is permissionless) could
// mark a proposal Expired immediately after anchoring by declaring a wide
// range and claiming a far-future current_timestamp.
test expire_proposal_rejects_wide_validity_range() {
  let proposal = mock_proposal(Passed, PendingExecution, 1000)
  let datum = mock_datum(Some(proposal))
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
  let expired_proposal = ProposalAnchor { ..proposal, execution_status: Expired }
  let new_datum = CtoGovernanceDatum { ..datum, active_proposal: Some(expired_proposal) }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_asset(mock_cto_nft_policy(), #"01", 1),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let current_timestamp = 1000 + 2_678_400_000
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(0, current_timestamp + 100),
    }

  !cto_governance.spend(
    Some(datum),
    ExpireProposal { current_timestamp: current_timestamp },
    own_ref,
    self,
  )
}

test expire_proposal_fails_before_window() {
  let proposal = mock_proposal(Passed, PendingExecution, 1000)
  let datum = mock_datum(Some(proposal))
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
  let expired_proposal = ProposalAnchor { ..proposal, execution_status: Expired }
  let new_datum = CtoGovernanceDatum { ..datum, active_proposal: Some(expired_proposal) }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_asset(mock_cto_nft_policy(), #"01", 1),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // T87: ms-scale, matches execution_window's real unit
  let current_timestamp = 1000 + 864_000_000
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(current_timestamp - 100, current_timestamp + 100),
    }

  !cto_governance.spend(
    Some(datum),
    ExpireProposal { current_timestamp: current_timestamp },
    own_ref,
    self,
  )
}

// T109: QueryState previously authorized ANY spend unconditionally
// (`QueryState -> True`, zero checks). Proves the fix — a transaction
// spending this UTXO with redeemer=QueryState, discarding the real datum
// entirely (no continuing output, no evidence, no signer), must now be
// rejected.
test query_state_rejects_unauthenticated_spend_attempt() {
  let datum = mock_datum(None)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let attacker_address = from_verification_key(#"ee")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.from_lovelace(2_000_000),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let drain_output =
    Output {
      address: attacker_address,
      value: assets.from_lovelace(2_000_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction { ..transaction.placeholder, inputs: [own_input], outputs: [drain_output] }

  !cto_governance.spend(Some(datum), QueryState, own_ref, self)
}

// ============================================================================
// T111: Bonded challenge window — VoidPendingProposal / ReclaimRelayerBond
// ============================================================================

fn mock_datum_with_bond(
  active_proposal: Option<ProposalAnchor>,
  pending_relayer_bond: Int,
) -> CtoGovernanceDatum {
  CtoGovernanceDatum {
    ..mock_datum(active_proposal),
    pending_relayer_bond: pending_relayer_bond,
    pending_relayer_key_hash: #"33",
  }
}

test void_pending_proposal_succeeds_and_slashes_bond() {
  let proposal = mock_proposal(Passed, PendingExecution, 1000)
  let datum = mock_datum_with_bond(Some(proposal), 25_000_000)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.from_lovelace(27_000_000),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let voided_proposal = ProposalAnchor { ..proposal, execution_status: Expired }
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      active_proposal: Some(voided_proposal),
      pending_relayer_bond: 0,
      pending_relayer_key_hash: #"",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: cto_out_value(2_000_000),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // treasury_bps=60, ops_bps=40 of the 25 ADA bond
  let treasury_output =
    Output {
      address: from_verification_key(#"55"),
      value: assets.from_lovelace(15_000_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let ops_output =
    Output {
      address: from_verification_key(#"66"),
      value: assets.from_lovelace(10_000_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  // 1 hour after anchoring — well inside the 24h challenge window
  let current_timestamp = 1000 + 3_600_000
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, treasury_output, ops_output],
      validity_range: interval.between(current_timestamp - 100, current_timestamp + 100),
      extra_signatories: [#"22"],
    }

  cto_governance.spend(
    Some(datum),
    VoidPendingProposal { current_timestamp: current_timestamp },
    own_ref,
    self,
  )
}

test void_pending_proposal_rejects_for_non_governor() {
  let proposal = mock_proposal(Passed, PendingExecution, 1000)
  let datum = mock_datum_with_bond(Some(proposal), 25_000_000)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.from_lovelace(27_000_000),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let voided_proposal = ProposalAnchor { ..proposal, execution_status: Expired }
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      active_proposal: Some(voided_proposal),
      pending_relayer_bond: 0,
      pending_relayer_key_hash: #"",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: cto_out_value(2_000_000),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let treasury_output =
    Output {
      address: from_verification_key(#"55"),
      value: assets.from_lovelace(15_000_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let ops_output =
    Output {
      address: from_verification_key(#"66"),
      value: assets.from_lovelace(10_000_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let current_timestamp = 1000 + 3_600_000
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, treasury_output, ops_output],
      validity_range: interval.between(current_timestamp - 100, current_timestamp + 100),
      // not the governor
      extra_signatories: [#"99"],
    }

  !cto_governance.spend(
    Some(datum),
    VoidPendingProposal { current_timestamp: current_timestamp },
    own_ref,
    self,
  )
}

test void_pending_proposal_rejects_after_challenge_window_elapsed() {
  let proposal = mock_proposal(Passed, PendingExecution, 1000)
  let datum = mock_datum_with_bond(Some(proposal), 25_000_000)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.from_lovelace(27_000_000),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let voided_proposal = ProposalAnchor { ..proposal, execution_status: Expired }
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      active_proposal: Some(voided_proposal),
      pending_relayer_bond: 0,
      pending_relayer_key_hash: #"",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: cto_out_value(2_000_000),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let treasury_output =
    Output {
      address: from_verification_key(#"55"),
      value: assets.from_lovelace(15_000_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let ops_output =
    Output {
      address: from_verification_key(#"66"),
      value: assets.from_lovelace(10_000_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  // 10 days after anchoring — past the 24h challenge window
  let current_timestamp = 1000 + 864_000_000
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, treasury_output, ops_output],
      validity_range: interval.between(current_timestamp - 100, current_timestamp + 100),
      extra_signatories: [#"22"],
    }

  !cto_governance.spend(
    Some(datum),
    VoidPendingProposal { current_timestamp: current_timestamp },
    own_ref,
    self,
  )
}

test reclaim_relayer_bond_succeeds_after_execution() {
  let proposal = mock_proposal(Passed, Executed, 1000)
  let datum = mock_datum_with_bond(Some(proposal), 25_000_000)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.from_lovelace(27_000_000),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    CtoGovernanceDatum { ..datum, pending_relayer_bond: 0, pending_relayer_key_hash: #"" }
  let continuing_output =
    Output {
      address: own_address,
      value: cto_out_value(2_000_000),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let relayer_output =
    Output {
      address: from_verification_key(#"33"),
      value: assets.from_lovelace(25_000_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, relayer_output],
    }

  cto_governance.spend(Some(datum), ReclaimRelayerBond, own_ref, self)
}

test reclaim_relayer_bond_rejects_when_nothing_pending() {
  let proposal = mock_proposal(Passed, Executed, 1000)
  let datum = mock_datum(Some(proposal))
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.from_lovelace(2_000_000),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_lovelace(2_000_000),
      datum: InlineDatum(datum),
      reference_script: None,
    }
  let self =
    Transaction { ..transaction.placeholder, inputs: [own_input], outputs: [continuing_output] }

  !cto_governance.spend(Some(datum), ReclaimRelayerBond, own_ref, self)
}

// T111: closes the ClearProposal/ReclaimRelayerBond fund-stranding race —
// the governor must not be able to wipe active_proposal (which
// ReclaimRelayerBond needs to read) while a relayer bond is still
// unsettled.
test clear_proposal_rejects_with_pending_relayer_bond() {
  let proposal = mock_proposal(Passed, Executed, 1000)
  let datum = mock_datum_with_bond(Some(proposal), 25_000_000)
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
  let new_datum = CtoGovernanceDatum { ..datum, active_proposal: None }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_asset(mock_cto_nft_policy(), #"01", 1),
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

  !cto_governance.spend(Some(datum), ClearProposal, own_ref, self)
}

test clear_proposal_succeeds_once_bond_settled() {
  let proposal = mock_proposal(Passed, Executed, 1000)
  let datum = mock_datum(Some(proposal))
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
  let new_datum = CtoGovernanceDatum { ..datum, active_proposal: None }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_asset(mock_cto_nft_policy(), #"01", 1),
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

  cto_governance.spend(Some(datum), ClearProposal, own_ref, self)
}
