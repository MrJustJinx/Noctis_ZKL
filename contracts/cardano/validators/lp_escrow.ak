// ============================================================================
// Noctis Protocol — Cardano L1 LP Escrow Contract (Aiken)
// Used by Tier A and Tier B (CLAUDE.md Contract Architecture table)
// ============================================================================
// This is the Cardano L1 counterpart to the Midnight lp_escrow.compact PSM
// (Tier C uses a Midnight-native LP Escrow PSM instead — see [T20]). Same
// invariants either way:
//   1. 365-day lock from graduation timestamp
//   2. No withdraw() — EVER. Zero code paths return LP tokens to any wallet.
//   3. migrate() requires: lock expired + governor/community signature +
//      whitelist member
//   4. DEX whitelist is updatable via team multisig + 72h public notice
//      (T30: Option B, implemented for real 2026-07-10 — see below)
//   5. CTO support: community wallet can migrate after lock expiry
//   6. Cancel state for T29 (stuck bonding curve resolution)
//
// Rewritten 2026-07-09 to match real Aiken v1.1.23 syntax — see
// bonding_curve.ak's header comment for the full explanation of what was
// wrong with the original draft (fictional `ScriptContext`/`Ed25519`/
// `Blake2b_224` API, `require()`, `fn spend(...) -> Void`). Authorization
// now uses `self.extra_signatories` instead of manually re-verifying
// signatures passed through the redeemer, and the DEX whitelist is typed
// as `List<Credential>` (a real Cardano address credential) instead of a
// raw `ByteArray` hash — this lets migration verification check the
// output's actual `payment_credential` directly instead of re-deriving it.
//
// T30 fix (2026-07-10): this file's own header claimed "T30: Option B —
// multisig + 72h notice" from the day it was rewritten, but the actual
// `AddDex`/`RemoveDex` redeemers only ever required ONE governor signature
// with immediate effect — no multisig, no notice period. The comment
// described the intended design; the code didn't implement it. Replaced
// both redeemers with a propose → 72h-notice → execute pattern:
// `ProposeDexChange` (requires `multisig_threshold`-of-`multisig_signers`
// real signatures, not any hardcoded number — the M/N split is a
// deployment-time choice, not baked into contract logic), then
// `ExecuteDexChange` once `notice_period` (259_200s = 72h) has passed
// since the proposal — permissionless, same "the deadline check itself is
// the authorization" idiom as T29's `ExpireCurve`, since the proposal was
// already public for the full notice window by the time anyone can
// execute it. `CancelPendingDexChange` lets the multisig withdraw a
// proposal before it takes effect (e.g. community pushback during the
// notice window).
//
// T49 fix (2026-07-10): `SealLock` previously just required a governor
// signature and flipped `lp_state` to `Locked` — it never checked that any
// real ADA or LP tokens actually arrived at this UTXO. Paired with the
// bonding curve contracts' new `Graduate` redeemer (bonding_curve.ak /
// bonding_curve_tier_b.ak, T49), a graduation transaction now needs BOTH
// halves to validate in the same tx: Graduate verifies the curve's own
// balance shrinks by the exact amount moving here, and SealLock (now
// permissionless, replacing the governor-signature requirement with a real
// value check via `lp_value_received`) verifies this contract's own
// continuing output actually gained `seeded_ada` lovelace and exactly
// `lp_token_amount` of the launch token — the same "the correctness of the
// resulting state is the authorization, not a signature" idiom used by
// ExpireCurve/ExecuteDexChange/Graduate. `lp_token_amount` is fixed at
// deploy (15% of TOTAL_SUPPLY, known before graduation) and now represents
// the EXPECTED reserve quantity to be checked against, not just a record of
// what's already there.
//
// T13 fix (2026-07-10): CLAUDE.md's "Stream B — LP Trading Fees" describes
// DEX pool fees paying "directly to fee_recipient, not via escrow" — but
// since the LP position itself is locked HERE (a script address, not a
// wallet), any DEX-native fee-harvest mechanism has to be invoked through
// this contract, whatever "directly" means at the DEX's own level. Added a
// new `HarvestFees` redeemer and `fee_recipient_pub_key_hash` field
// (CTO-redirectable, same pattern as Migrate's authorization). Deliberately
// DEX-AGNOSTIC and narrow in scope: each whitelisted DEX (CSwap, Minswap,
// Splash, Spectrum) has its own real harvest interface, none of which is
// confirmed yet (T13's still-open sub-question — "confirm fee harvesting
// capability per DEX before finalising whitelist"), so this script cannot
// verify the DEX-side call at all. What it CAN and DOES verify, regardless
// of which DEX is involved: the locked LP position is completely untouched
// (`lp_position_untouched`) and the correct recipient actually receives the
// harvested ADA in the same transaction (`fee_recipient_paid`) — the real
// per-DEX harvest call happens as other inputs/outputs in that same
// transaction, outside what this validator can or needs to see.
// ============================================================================

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval
use aiken/interval.{Interval, IntervalBoundType}
use cardano/address.{Address, Credential, from_script, from_verification_key}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{Input, InlineDatum, Output, OutputReference, Transaction}
use cto_governance.{
  CtoGovernanceDatum, DissolveCTOProposal, Executed, Passed, PreCTO,
  ProposalAnchor, ProposalType, SilenceLockTrigger,
}

/// T90: same finding/fix as Tier A's bonding_curve.ak — see that file's
/// own comment on `validity_range_is_narrow` for the full explanation.
/// Only `ExecuteDexChange` needs this here — it's the one permissionless,
/// timestamp-deadline-gated redeemer in this file (`ProposeDexChange`
/// requires a real multisig signature, same "trusted signer" exemption as
/// `ActivateCurve`; `SealLock`/`Migrate`'s own timestamp fields aren't
/// bound to `interval.contains` at all, a different mechanism entirely).
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

/// LP escrow states — mirrors the Midnight PSM enum
pub type LpState {
  Locked
  Migrated
  Cancelled
}

/// Which way a proposed whitelist change goes (T30)
pub type DexAction {
  ProposeAdd
  ProposeRemove
}

/// A whitelist change awaiting its 72h public notice period (T30) — at
/// most one pending change at a time, deliberately: a second proposal
/// can't be queued until the first resolves (executes or is cancelled),
/// so there's never ambiguity about which change a given execute call
/// applies to.
pub type PendingDexChange {
  dex_credential: Credential,
  action: DexAction,
  proposed_at: Int,
}

/// The datum stored at the LP escrow UTxO
pub type LpEscrowDatum {
  // Identity
  launch_id: ByteArray,
  // Lock timing
  lock_timestamp: Int,
  // POSIX seconds when lock started
  lock_duration: Int,
  // 31536000 = 365 days (enforced >= this)
  // State
  lp_state: LpState,
  // Authorization
  governor_pub_key_hash: VerificationKeyHash,
  community_wallet_hash: VerificationKeyHash,
  cto_triggered: Bool,
  // T13: who receives harvested DEX trading fees (CLAUDE.md's Stream B
  // "fee_recipient") — the creator's own wallet, set once at deploy.
  // Redirected to community_wallet_hash once cto_triggered, same rule
  // CLAUDE.md states ("Redirected to CTO wallet if governance vote
  // passes") and the same pattern Migrate's is_authorized already uses.
  fee_recipient_pub_key_hash: VerificationKeyHash,
  // DEX whitelist (payment credentials of approved DEX contracts)
  dex_whitelist: List<Credential>,
  // T30: the team multisig that can propose/cancel whitelist changes. Set
  // once at deploy — M-of-N is a deployment-time choice (multisig_threshold
  // out of however many keys are in multisig_signers), not hardcoded here.
  multisig_signers: List<VerificationKeyHash>,
  multisig_threshold: Int,
  // T30: at most one whitelist change awaiting its notice period.
  pending_dex_change: Option<PendingDexChange>,
  // Token info (what LP tokens are locked)
  lp_token_policy_id: PolicyId,
  lp_token_name: AssetName,
  lp_token_amount: Int,
  // T-CTO-ENFORCE fix: cto_governance.ak's own fixed script address, set
  // at genesis — same pattern as bonding_curve.ak's own
  // cto_governance_credential field; see that file's doc comment for the
  // full reasoning. Needed because TriggerCTO/DissolveCTO below now
  // require real reference-input evidence a vote actually passed, instead
  // of trusting a bare governor signature.
  cto_governance_credential: Credential,
  // C-1 fix (2026-07-23 audit): governance THREAD NFT policy id — see the
  // full doc comment on bonding_curve.ak. cto_vote_verified now requires
  // the referenced governance UTXO to carry this NFT (asset_name =
  // launch_id), closing the forge-a-fake-governance-UTXO gap.
  cto_governance_nft: PolicyId,
}

/// Redeemer actions — what the contract can be spent with
pub type LpEscrowRedeemer {
  /// T49: seals the lock (sets lock_timestamp), paired with the bonding
  /// curve's `Graduate` redeemer in the same transaction. Permissionless —
  /// verified by `lp_value_received` actually finding `seeded_ada`
  /// lovelace and `lp_token_amount` of the launch token in this contract's
  /// own continuing output, not by a governor signature.
  SealLock { timestamp: Int, seeded_ada: Int }
  /// T30: propose adding/removing a DEX from the whitelist. Requires
  /// `multisig_threshold`-of-`multisig_signers` real signatures. Starts
  /// the 72h public notice clock — does NOT change the whitelist yet.
  ProposeDexChange { dex_credential: Credential, action: DexAction, timestamp: Int }
  /// T30: apply a pending whitelist change once its 72h notice period has
  /// elapsed. Permissionless — the proposal was already public for the
  /// full window, same "deadline is the authorization" idiom as T29's
  /// ExpireCurve.
  ExecuteDexChange { current_timestamp: Int }
  /// T30: multisig withdraws a pending change before it takes effect.
  CancelPendingDexChange
  /// Migrate LP to a whitelisted DEX after lock expiry. Either governor or
  /// community wallet (if CTO triggered) can call this.
  Migrate { target_dex_credential: Credential, current_timestamp: Int }
  /// Trigger CTO — redirect control to community wallet
  TriggerCTO { community_wallet_hash: VerificationKeyHash }
  /// Dissolve CTO — return control to governor
  DissolveCTO
  /// Cancel launch (T29 — bonding curve expired without graduation)
  CancelLaunch
  /// T13: harvest DEX trading fees without touching the locked LP position.
  /// Permissionless — like ExpireCurve/ExecuteDexChange/Graduate, the
  /// invariant checks are the authorization: the locked LP position cannot
  /// change and the correct recipient must actually be paid, so there is
  /// nothing a malformed or adversarial caller could gain by invoking this
  /// incorrectly. Real per-DEX harvest mechanics are NOT modeled here — see
  /// file header.
  HarvestFees { harvested_amount: Int }
  /// Read-only query, no state change, no authorization required
  QueryState
}

// ============================================================================
// CONSTANTS
// ============================================================================

/// Minimum lock duration: 365 days in seconds
const min_lock_duration = 31_536_000

/// T30: 72 hours in MILLISECONDS — public notice period between proposing
/// and executing a DEX whitelist change.
///
/// T89 fix (2026-07-17): was previously `259_200` (72 hours in SECONDS) —
/// same bug class as T87 (bonding_curve.ak's `max_curve_duration`,
/// cto_governance.ak's `execution_window`). `ProposeDexChange`'s `timestamp`
/// and `ExecuteDexChange`'s `current_timestamp` are both checked via
/// `interval.contains(self.validity_range, ...)`, and Cardano's real
/// transaction validity range is natively milliseconds — so the real
/// "72-hour public notice period" was actually only 259,200 milliseconds,
/// about 4.3 real minutes. Found while researching Phase 5b (real DEX
/// migration) of the Tier A Preprod Milestone, before ever building or
/// testing the mechanism for real. Every existing test derives its
/// timestamps FROM this constant (`dex_change_notice_period ± 100`, not
/// hardcoded literals like T87's original bugs), so no test rescaling was
/// needed — see internal tracking's [T89].
const dex_change_notice_period = 259_200_000

// ============================================================================
// HELPERS
// ============================================================================

fn is_whitelisted(whitelist: List<Credential>, credential: Credential) -> Bool {
  list.has(whitelist, credential)
}

/// T30: at least `threshold` of `signers` must appear in the tx's real
/// signatures — a real M-of-N multisig check, not a single governor key.
fn multisig_satisfied(
  signers: List<VerificationKeyHash>,
  threshold: Int,
  self: Transaction,
) -> Bool {
  let signed_count =
    list.length(
      list.filter(signers, fn(vkh) { list.has(self.extra_signatories, vkh) }),
    )
  signed_count >= threshold
}

fn is_lock_expired(datum: LpEscrowDatum, current_timestamp: Int) -> Bool {
  current_timestamp >= datum.lock_timestamp + datum.lock_duration
}

/// T-CTO-ENFORCE fix: real evidence a vote actually passed, replacing a
/// bare governor signature — same mechanism and reasoning as
/// bonding_curve.ak's own cto_vote_verified (see that file's doc comment
/// for the full explanation, including why last_executed_proposal rather
/// than the clearable active_proposal, and why expected_recipient is
/// `None` for DissolveCTOProposal).
fn cto_vote_verified(
  self: Transaction,
  datum: LpEscrowDatum,
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

/// Governor, or (if CTO has been triggered) the community wallet
fn is_authorized(datum: LpEscrowDatum, self: Transaction) -> Bool {
  list.has(self.extra_signatories, datum.governor_pub_key_hash) || (
    datum.cto_triggered && list.has(
      self.extra_signatories,
      datum.community_wallet_hash,
    )
  )
}

/// Find this validator's own continuing output (same address as the input
/// being spent) and decode its inline datum.
fn own_continuing_datum(
  self: Transaction,
  own_ref: OutputReference,
) -> LpEscrowDatum {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  expect InlineDatum(raw_datum) = own_output.datum
  expect new_datum: LpEscrowDatum = raw_datum
  new_datum
}

/// T49: verify this contract's own continuing output actually gained
/// `seeded_ada` lovelace (relative to the input being spent) and holds
/// exactly `lp_token_amount` of the launch token — the receiving-side
/// mirror of bonding_curve.ak's `graduation_funds_left_curve`/
/// `lp_seeding_output_ok`. Real value movement, not a self-reported claim.
fn lp_value_received(
  self: Transaction,
  own_ref: OutputReference,
  datum: LpEscrowDatum,
  seeded_ada: Int,
) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  let lovelace_ok =
    assets.lovelace_of(own_output.value) == assets.lovelace_of(own_input.output.value) + seeded_ada
  let tokens_ok =
    assets.quantity_of(
      own_output.value,
      datum.lp_token_policy_id,
      datum.lp_token_name,
    ) == datum.lp_token_amount
  lovelace_ok && tokens_ok
}

/// T81 fix (2026-07-16): same fix, same reasoning, as bonding_curve.ak —
/// see that file's comment on output_value_clean for the full rationale
/// (MeshJS's own open-source escrow.ak names this the "unbounded value
/// vulnerability"). Both SealLock and HarvestFees are permissionless —
/// this contract's output could otherwise be padded on its long-lived, repeatedly-spent
/// LP UTXO with junk native assets.
fn output_value_clean(output: Output, max_assets: Int) -> Bool {
  list.length(assets.flatten(output.value)) <= max_assets
}

fn lp_own_output_clean(self: Transaction, own_ref: OutputReference) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  output_value_clean(own_output, 2)
}

/// T111 fix (2026-07-19, full-suite security audit) — same fix, same
/// reasoning, as bonding_curve.ak: closes a double-satisfaction risk,
/// since every launch's LP escrow shares this one fixed, unparameterized
/// script address. See that file's own comment on this exact helper for
/// the full explanation.
fn single_own_utxo(self: Transaction, own_address: Address) -> Bool {
  list.length(list.filter(self.inputs, fn(input) { input.output.address == own_address })) <= 1 && list.length(
    list.filter(self.outputs, fn(output) { output.address == own_address }),
  ) <= 1
}

/// T111 fix (2026-07-19, full-suite security audit): CRITICAL finding —
/// `ExecuteDexChange`, `ProposeDexChange`, `CancelPendingDexChange`,
/// `TriggerCTO`, `DissolveCTO`, and `CancelLaunch` previously relied on
/// `own_continuing_datum` ALONE — which only ever compares the continuing
/// output's DATUM, never its VALUE. Nothing stopped any of these six
/// redeemers (three of them fully permissionless) from being satisfied by
/// a continuing output carrying the exact right datum but only min-UTXO
/// lovelace, while the REAL locked ADA + LP tokens were diverted
/// elsewhere in the same transaction — directly contradicting this file's
/// own "no withdraw() ever" invariant. This verifies the continuing
/// output's real value is byte-for-byte UNCHANGED from the input being
/// spent — the correct requirement for every one of these six redeemers,
/// none of which are meant to move the locked position at all (only
/// `SealLock`/`Migrate`/`HarvestFees` legitimately touch real value, and
/// each already has its own dedicated, real value-movement check).
fn lp_value_unchanged(self: Transaction, own_ref: OutputReference) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  own_output.value == own_input.output.value
}

/// T13: the active recipient of harvested DEX trading fees — the creator's
/// own wallet, or (once CTO has been triggered) the community wallet.
/// Mirrors `is_authorized`'s exact same governor-vs-community switch, just
/// for a payment destination instead of a signature check.
fn active_fee_recipient(datum: LpEscrowDatum) -> VerificationKeyHash {
  if datum.cto_triggered {
    datum.community_wallet_hash
  } else {
    datum.fee_recipient_pub_key_hash
  }
}

/// T13: verify the locked LP position is completely untouched by a
/// HarvestFees call — same policy target, quantity, and identity as the
/// input being spent. This is the core invariant the whole redeemer exists
/// to protect: harvesting trading fees must never be usable to drain the
/// locked LP itself.
fn lp_position_untouched(
  self: Transaction,
  own_ref: OutputReference,
  datum: LpEscrowDatum,
) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  assets.quantity_of(
    own_output.value,
    datum.lp_token_policy_id,
    datum.lp_token_name,
  ) == assets.quantity_of(
    own_input.output.value,
    datum.lp_token_policy_id,
    datum.lp_token_name,
  )
}

/// T13: verify the active fee recipient actually receives `harvested_amount`
/// lovelace in some output of this same transaction.
fn fee_recipient_paid(
  self: Transaction,
  datum: LpEscrowDatum,
  harvested_amount: Int,
) -> Bool {
  let recipient_address = from_verification_key(active_fee_recipient(datum))
  list.any(
    self.outputs,
    fn(output) {
      output.address == recipient_address && assets.lovelace_of(output.value) >= harvested_amount
    },
  )
}

/// Verify the LP tokens land at the target DEX's payment credential, in the
/// full locked amount, in a single migration transaction.
///
/// T111 fix (2026-07-19, full-suite security audit): previously only
/// verified the LP TOKEN quantity — the escrow's real locked ADA (seeded
/// at SealLock time via `seeded_ada`, but not persisted anywhere in the
/// datum afterward) was never checked anywhere in `Migrate`, letting the
/// authorized signer (governor, or community post-CTO) divert all the
/// locked ADA to themselves while still completing an apparently-valid
/// migration to a real whitelisted DEX — directly contradicting CLAUDE.md's
/// "underlying ADA + tokens never appear in any wallet UTxO" migration
/// invariant. Since no datum field records the locked ADA amount, the only
/// real source of truth is the escrow's OWN INPUT value at the moment of
/// migration (`own_input`) — the target output must receive at least that
/// much lovelace, not a self-reported or datum-derived figure.
fn migration_output_ok(
  self: Transaction,
  datum: LpEscrowDatum,
  target_dex_credential: Credential,
  own_input_lovelace: Int,
) -> Bool {
  list.any(
    self.outputs,
    fn(output) {
      output.address.payment_credential == target_dex_credential && assets.quantity_of(
        output.value,
        datum.lp_token_policy_id,
        datum.lp_token_name,
      ) == datum.lp_token_amount && assets.lovelace_of(output.value) >= own_input_lovelace
    },
  )
}

// ============================================================================
// MAIN VALIDATOR
// ============================================================================

validator lp_escrow {
  spend(
    datum_opt: Option<LpEscrowDatum>,
    redeemer: LpEscrowRedeemer,
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
        SealLock { timestamp, seeded_ada } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          datum.lock_duration >= min_lock_duration,
          datum.lock_timestamp == 0,
          seeded_ada > 0,
          lp_value_received(self, own_ref, datum, seeded_ada),
          // T81: the sealed LP position can't be padded with junk assets.
          lp_own_output_clean(self, own_ref),
          new_datum == LpEscrowDatum {
            ..datum,
            lock_timestamp: timestamp,
            lp_state: Locked,
          },
        }
      }

      ProposeDexChange { dex_credential, action, timestamp } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        let action_makes_sense = when action is {
          ProposeAdd -> !is_whitelisted(datum.dex_whitelist, dex_credential)
          ProposeRemove -> is_whitelisted(datum.dex_whitelist, dex_credential)
        }
        and {
          multisig_satisfied(datum.multisig_signers, datum.multisig_threshold, self),
          datum.pending_dex_change == None,
          action_makes_sense,
          interval.contains(self.validity_range, timestamp),
          new_datum == LpEscrowDatum {
            ..datum,
            pending_dex_change: Some(
              PendingDexChange {
                dex_credential: dex_credential,
                action: action,
                proposed_at: timestamp,
              },
            ),
          },
          // T111: this redeemer only ever proposes a future whitelist
          // change — it must never move the locked position's real value.
          lp_value_unchanged(self, own_ref),
        }
      }

      ExecuteDexChange { current_timestamp } -> {
        expect Some(pending) = datum.pending_dex_change
        let new_whitelist = when pending.action is {
          ProposeAdd -> [pending.dex_credential, ..datum.dex_whitelist]
          ProposeRemove ->
            list.filter(
              datum.dex_whitelist,
              fn(c) { c != pending.dex_credential },
            )
        }
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          interval.contains(self.validity_range, current_timestamp),
          // T90: bound the declared validity range's own width — without
          // this, ANYONE (this redeemer is permissionless by design) could
          // claim a far-future current_timestamp and bypass the real
          // 72-hour public notice period entirely.
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          current_timestamp >= pending.proposed_at + dex_change_notice_period,
          new_datum == LpEscrowDatum {
            ..datum,
            dex_whitelist: new_whitelist,
            pending_dex_change: None,
          },
          // This redeemer is fully permissionless, so it must enforce full value
          // conservation on-chain: the locked ADA + LP tokens must be
          // preserved, not merely the datum. A correct-looking datum alone
          // must never authorize moving the locked value away
          // elsewhere in the same transaction). Only the whitelist and
          // pending-change fields should ever change here.
          lp_value_unchanged(self, own_ref),
        }
      }

      CancelPendingDexChange -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          multisig_satisfied(datum.multisig_signers, datum.multisig_threshold, self),
          datum.pending_dex_change != None,
          new_datum == LpEscrowDatum { ..datum, pending_dex_change: None },
          // T111: this redeemer only ever clears a pending proposal — it
          // must never move the locked position's real value.
          lp_value_unchanged(self, own_ref),
        }
      }

      Migrate { target_dex_credential, current_timestamp } ->
        // Contract is fully consumed here — LP moves to the new DEX, no
        // continuing output at this script address is expected.
        and {
          datum.lp_state == Locked,
          is_lock_expired(datum, current_timestamp),
          is_whitelisted(datum.dex_whitelist, target_dex_credential),
          is_authorized(datum, self),
          // T111 fix: migration_output_ok now also requires the target
          // output receive at least the escrow's own real locked lovelace
          // (read from own_input, not a self-reported/datum figure — see
          // that function's own doc comment for why no datum field can
          // serve this purpose).
          migration_output_ok(
            self,
            datum,
            target_dex_credential,
            assets.lovelace_of(own_input.output.value),
          ),
        }

      TriggerCTO { community_wallet_hash } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          // T-CTO-ENFORCE: permissionless, gated on real anchored vote
          // evidence instead of a bare governor signature.
          cto_vote_verified(
            self,
            datum,
            SilenceLockTrigger,
            Some(community_wallet_hash),
          ),
          !datum.cto_triggered,
          community_wallet_hash != #"",
          new_datum == LpEscrowDatum {
            ..datum,
            cto_triggered: True,
            community_wallet_hash: community_wallet_hash,
          },
          // T111 CRITICAL fix: this redeemer is permissionless given real
          // vote evidence — was previously a drain path for the same
          // reason as ExecuteDexChange above. Only cto_triggered/
          // community_wallet_hash should ever change here.
          lp_value_unchanged(self, own_ref),
        }
      }

      DissolveCTO -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          // T-CTO-ENFORCE: same reasoning, gated on a real anchored
          // DissolveCTOProposal instead of a bare governor signature.
          cto_vote_verified(self, datum, DissolveCTOProposal, None),
          datum.cto_triggered,
          new_datum == LpEscrowDatum {
            ..datum,
            cto_triggered: False,
            community_wallet_hash: #"",
          },
          // T111: same reasoning as TriggerCTO above.
          lp_value_unchanged(self, own_ref),
        }
      }

      CancelLaunch -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          list.has(self.extra_signatories, datum.governor_pub_key_hash),
          datum.lp_state == Locked,
          new_datum == LpEscrowDatum { ..datum, lp_state: Cancelled },
          // T111: a governor signature alone should never be able to also
          // divert the locked position's real value while flipping this
          // flag — only the state transition should be observable here.
          lp_value_unchanged(self, own_ref),
        }
      }

      HarvestFees { harvested_amount } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          datum.lp_state == Locked,
          harvested_amount > 0,
          new_datum == datum,
          // T111 CRITICAL fix: lp_position_untouched only ever checked the
          // LP TOKEN quantity, never lovelace — this permissionless
          // redeemer could previously be called with a trivial
          // harvested_amount (e.g. 1) while the entire real locked ADA
          // balance was diverted as unaccounted-for "change" in the same
          // transaction. The real harvested fee must come from OUTSIDE
          // this escrow (a genuine external DEX fee-collection mechanism,
          // not this contract's own locked balance) — so the escrow's own
          // value must stay completely unchanged, same requirement as
          // every other non-SealLock/Migrate redeemer in this file.
          lp_value_unchanged(self, own_ref),
          lp_position_untouched(self, own_ref, datum),
          fee_recipient_paid(self, datum, harvested_amount),
          // T81: HarvestFees is permissionless — the LP position's own
          // continuing output can't be padded with junk assets either.
          lp_own_output_clean(self, own_ref),
        }
      }

      // T109 CRITICAL fix (2026-07-19, full-suite security audit) — same
      // fix as bonding_curve.ak: was an unconditional `True` (zero checks),
      // an unconditional authorization over the locked LP position. See
      // that file's own comment on this exact line for the full
      // explanation.
      QueryState -> False
      },
    }
  }
}

// ============================================================================
// TESTS
// ============================================================================

fn mock_datum(lp_state: LpState, lock_timestamp: Int) -> LpEscrowDatum {
  LpEscrowDatum {
    launch_id: #"01",
    lock_timestamp: lock_timestamp,
    lock_duration: min_lock_duration,
    lp_state: lp_state,
    governor_pub_key_hash: #"22",
    community_wallet_hash: #"",
    cto_triggered: False,
    fee_recipient_pub_key_hash: #"dd",
    dex_whitelist: [],
    multisig_signers: [#"aa", #"bb", #"cc"],
    multisig_threshold: 2,
    pending_dex_change: None,
    lp_token_policy_id: #"33",
    lp_token_name: "lp",
    lp_token_amount: 1000,
    cto_governance_credential: from_verification_key(#"aa").payment_credential,
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
    // C-1 fix: must match both the escrow datum's cto_governance_nft and the
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
      // (policy = the escrow datum's cto_governance_nft `#"c0ffee"`,
      // asset_name = launch_id); cto_vote_verified now requires it.
      value: assets.from_asset(#"c0ffee", cto_datum.launch_id, 1),
      datum: InlineDatum(cto_datum),
      reference_script: None,
    },
  }
}

test is_lock_expired_at_exact_boundary() {
  let datum = mock_datum(Locked, 1000)
  is_lock_expired(datum, 1000 + min_lock_duration)
}

test is_lock_expired_one_second_early_fails() {
  let datum = mock_datum(Locked, 1000)
  !is_lock_expired(datum, 1000 + min_lock_duration - 1)
}

test is_whitelisted_finds_member() {
  let dex = from_script(#"aa").payment_credential
  is_whitelisted([dex], dex)
}

test is_whitelisted_rejects_non_member() {
  let dex_a = from_script(#"aa").payment_credential
  let dex_b = from_script(#"bb").payment_credential
  !is_whitelisted([dex_a], dex_b)
}

test seal_lock_succeeds_with_real_value_received() {
  // T49: SealLock is permissionless now — no extra_signatories at all —
  // verified instead by the continuing output actually holding the seeded
  // ADA and the exact lp_token_amount (1000, per mock_datum).
  let datum = mock_datum(Cancelled, 0)
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
  let new_datum =
    LpEscrowDatum { ..datum, lock_timestamp: 500, lp_state: Locked }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(2_000_000 + 98_000),
        assets.from_asset(#"33", "lp", 1000),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
    }

  lp_escrow.spend(
    Some(datum),
    SealLock { timestamp: 500, seeded_ada: 98_000 },
    own_ref,
    self,
  )
}

test seal_lock_rejects_padded_output() {
  // T81: identical to seal_lock_succeeds_with_real_value_received, except
  // the sealed continuing output carries one extra, unrelated junk asset.
  // SealLock is permissionless, so ANYONE could otherwise pad this
  // long-lived LP UTXO this way before the T81 fix.
  let datum = mock_datum(Cancelled, 0)
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
  let new_datum =
    LpEscrowDatum { ..datum, lock_timestamp: 500, lp_state: Locked }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.merge(
          assets.from_lovelace(2_000_000 + 98_000),
          assets.from_asset(#"33", "lp", 1000),
        ),
        // Junk asset from an unrelated policy — the padding attack.
        assets.from_asset(#"deadbeef", "spam", 1),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
    }

  !lp_escrow.spend(
    Some(datum),
    SealLock { timestamp: 500, seeded_ada: 98_000 },
    own_ref,
    self,
  )
}

test seal_lock_fails_if_already_sealed() {
  // lock_timestamp != 0 means it's already been sealed once
  let datum = mock_datum(Locked, 100)
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
  let new_datum =
    LpEscrowDatum { ..datum, lock_timestamp: 500, lp_state: Locked }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(2_000_000 + 98_000),
        assets.from_asset(#"33", "lp", 1000),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
    }

  !lp_escrow.spend(
    Some(datum),
    SealLock { timestamp: 500, seeded_ada: 98_000 },
    own_ref,
    self,
  )
}

test seal_lock_rejects_zero_seeded_ada() {
  let datum = mock_datum(Cancelled, 0)
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
  let new_datum =
    LpEscrowDatum { ..datum, lock_timestamp: 500, lp_state: Locked }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(2_000_000),
        assets.from_asset(#"33", "lp", 1000),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
    }

  !lp_escrow.spend(
    Some(datum),
    SealLock { timestamp: 500, seeded_ada: 0 },
    own_ref,
    self,
  )
}

test seal_lock_rejects_wrong_token_amount() {
  // Correct ADA, but only 900 of the expected 1000 lp_token_amount arrived
  // — proves the token quantity is checked exactly, not just "some tokens."
  let datum = mock_datum(Cancelled, 0)
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
  let new_datum =
    LpEscrowDatum { ..datum, lock_timestamp: 500, lp_state: Locked }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(2_000_000 + 98_000),
        assets.from_asset(#"33", "lp", 900),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
    }

  !lp_escrow.spend(
    Some(datum),
    SealLock { timestamp: 500, seeded_ada: 98_000 },
    own_ref,
    self,
  )
}

test migrate_succeeds_after_expiry_to_whitelisted_dex() {
  let target_dex = from_script(#"aa")
  let datum =
    LpEscrowDatum {
      ..mock_datum(Locked, 0),
      dex_whitelist: [target_dex.payment_credential],
    }
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
  let migration_output =
    Output {
      address: target_dex,
      value: assets.from_asset(#"33", "lp", 1000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [migration_output],
      extra_signatories: [#"22"],
    }
  let redeemer =
    Migrate {
      target_dex_credential: target_dex.payment_credential,
      current_timestamp: min_lock_duration,
    }

  lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

test migrate_fails_before_lock_expiry() {
  let target_dex = from_script(#"aa")
  let datum =
    LpEscrowDatum {
      ..mock_datum(Locked, 0),
      dex_whitelist: [target_dex.payment_credential],
    }
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
  let migration_output =
    Output {
      address: target_dex,
      value: assets.from_asset(#"33", "lp", 1000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [migration_output],
      extra_signatories: [#"22"],
    }
  let redeemer =
    Migrate {
      target_dex_credential: target_dex.payment_credential,
      current_timestamp: min_lock_duration - 1,
    }

  !lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

test migrate_fails_to_non_whitelisted_dex() {
  let target_dex = from_script(#"aa")
  // whitelist is empty — target_dex was never added
  let datum = mock_datum(Locked, 0)
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
  let migration_output =
    Output {
      address: target_dex,
      value: assets.from_asset(#"33", "lp", 1000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [migration_output],
      extra_signatories: [#"22"],
    }
  let redeemer =
    Migrate {
      target_dex_credential: target_dex.payment_credential,
      current_timestamp: min_lock_duration,
    }

  !lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

test trigger_cto_succeeds_with_real_anchored_vote() {
  let datum = mock_datum(Locked, 0)
  let cto_address = from_verification_key(#"aa")
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
    LpEscrowDatum {
      ..datum,
      cto_triggered: True,
      community_wallet_hash: #"ee",
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

  lp_escrow.spend(
    Some(datum),
    TriggerCTO { community_wallet_hash: #"ee" },
    own_ref,
    self,
  )
}

// C-1 regression (2026-07-23 audit): a UTXO planted at
// cto_governance_credential with a fully forged "Passed / Executed" datum but
// WITHOUT the genuine governance thread NFT must NOT satisfy
// cto_vote_verified. Cleanly returns False (ref input exists, lacks the NFT),
// so a plain `!spend(...)` assertion works.
test trigger_cto_rejects_forged_governance_utxo_without_nft() {
  let datum = mock_datum(Locked, 0)
  let cto_address = from_verification_key(#"aa")
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
    LpEscrowDatum {
      ..datum,
      cto_triggered: True,
      community_wallet_hash: #"ee",
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

  !lp_escrow.spend(
    Some(datum),
    TriggerCTO { community_wallet_hash: #"ee" },
    own_ref,
    self,
  )
}

// T-CTO-ENFORCE: cto_vote_verified's `expect Some(cto_ref_input) = ...`
// panics rather than returning False when no matching reference input
// exists, so this needs the `fail` test annotation — same reasoning as
// bonding_curve.ak's identically-named test.
test trigger_cto_rejects_without_reference_input() fail {
  let datum = mock_datum(Locked, 0)
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
    LpEscrowDatum {
      ..datum,
      cto_triggered: True,
      community_wallet_hash: #"ee",
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

  lp_escrow.spend(
    Some(datum),
    TriggerCTO { community_wallet_hash: #"ee" },
    own_ref,
    self,
  )
}

test dissolve_cto_succeeds_with_real_anchored_vote() {
  let datum =
    LpEscrowDatum { ..mock_datum(Locked, 0), cto_triggered: True, community_wallet_hash: #"ee" }
  let cto_address = from_verification_key(#"aa")
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
    LpEscrowDatum {
      ..datum,
      cto_triggered: False,
      community_wallet_hash: #"",
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

  lp_escrow.spend(Some(datum), DissolveCTO, own_ref, self)
}

test dissolve_cto_rejects_if_not_triggered() fail {
  let datum = mock_datum(Locked, 0)
  let cto_address = from_verification_key(#"aa")
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
    LpEscrowDatum {
      ..datum,
      cto_triggered: False,
      community_wallet_hash: #"",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.zero,
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // No CTO was ever triggered on this launch, so no real DissolveCTOProposal
  // could legitimately exist for it — omitting the reference input entirely
  // (rather than fabricating one) is the honest way to model that; the
  // `expect` panic is what should reject this, same as the
  // rejects_without_reference_input case above.
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
    }

  lp_escrow.spend(Some(datum), DissolveCTO, own_ref, self)
}

test migrate_succeeds_via_community_wallet_after_cto() {
  let target_dex = from_script(#"aa")
  let datum =
    LpEscrowDatum {
      ..mock_datum(Locked, 0),
      dex_whitelist: [target_dex.payment_credential],
      cto_triggered: True,
      community_wallet_hash: #"ee",
    }
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
  let migration_output =
    Output {
      address: target_dex,
      value: assets.from_asset(#"33", "lp", 1000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [migration_output],
      // community wallet signs, not governor
      extra_signatories: [#"ee"],
    }
  let redeemer =
    Migrate {
      target_dex_credential: target_dex.payment_credential,
      current_timestamp: min_lock_duration,
    }

  lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

// T30 tests — mock_datum's multisig is [#"aa", #"bb", #"cc"], threshold 2.

test propose_dex_change_succeeds_with_threshold_signatures() {
  let datum = mock_datum(Locked, 0)
  let target_dex = from_script(#"aa")
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
    LpEscrowDatum {
      ..datum,
      pending_dex_change: Some(
        PendingDexChange {
          dex_credential: target_dex.payment_credential,
          action: ProposeAdd,
          proposed_at: 1000,
        },
      ),
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
      // 2-of-3: aa and bb sign, cc doesn't
      extra_signatories: [#"aa", #"bb"],
      validity_range: interval.between(900, 1100),
    }
  let redeemer =
    ProposeDexChange {
      dex_credential: target_dex.payment_credential,
      action: ProposeAdd,
      timestamp: 1000,
    }

  lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

test propose_dex_change_rejects_below_multisig_threshold() {
  let datum = mock_datum(Locked, 0)
  let target_dex = from_script(#"aa")
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
    LpEscrowDatum {
      ..datum,
      pending_dex_change: Some(
        PendingDexChange {
          dex_credential: target_dex.payment_credential,
          action: ProposeAdd,
          proposed_at: 1000,
        },
      ),
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
      // only 1-of-3 signs — below the threshold of 2
      extra_signatories: [#"aa"],
      validity_range: interval.between(900, 1100),
    }
  let redeemer =
    ProposeDexChange {
      dex_credential: target_dex.payment_credential,
      action: ProposeAdd,
      timestamp: 1000,
    }

  !lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

test propose_dex_change_rejects_when_a_change_is_already_pending() {
  let target_dex = from_script(#"aa")
  let other_dex = from_script(#"bb")
  let datum =
    LpEscrowDatum {
      ..mock_datum(Locked, 0),
      pending_dex_change: Some(
        PendingDexChange {
          dex_credential: other_dex.payment_credential,
          action: ProposeAdd,
          proposed_at: 500,
        },
      ),
    }
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
    LpEscrowDatum {
      ..datum,
      pending_dex_change: Some(
        PendingDexChange {
          dex_credential: target_dex.payment_credential,
          action: ProposeAdd,
          proposed_at: 1000,
        },
      ),
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
      extra_signatories: [#"aa", #"bb"],
      validity_range: interval.between(900, 1100),
    }
  let redeemer =
    ProposeDexChange {
      dex_credential: target_dex.payment_credential,
      action: ProposeAdd,
      timestamp: 1000,
    }

  !lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

test execute_dex_change_succeeds_after_notice_period() {
  let target_dex = from_script(#"aa")
  let datum =
    LpEscrowDatum {
      ..mock_datum(Locked, 0),
      pending_dex_change: Some(
        PendingDexChange {
          dex_credential: target_dex.payment_credential,
          action: ProposeAdd,
          proposed_at: 0,
        },
      ),
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  // T111: real, non-zero locked value (15,000 ADA + 150M LP tokens) —
  // proves the new lp_value_unchanged check doesn't reject a genuine,
  // value-preserving whitelist-change execution.
  let locked_value =
    assets.merge(assets.from_lovelace(15_000_000_000), assets.from_asset(#"33", "lp", 150_000_000))
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: locked_value,
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    LpEscrowDatum {
      ..datum,
      dex_whitelist: [target_dex.payment_credential],
      pending_dex_change: None,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: locked_value,
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      // no signatures at all — execution is permissionless once due
      validity_range: interval.between(
        dex_change_notice_period - 100,
        dex_change_notice_period + 100,
      ),
    }
  let redeemer = ExecuteDexChange { current_timestamp: dex_change_notice_period }

  lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

// Regression test: the value-conservation case verified against the full
// security audit — ExecuteDexChange is permissionless, and previously
// only checked the continuing output's DATUM, never its value. This
// proves a transaction with the CORRECT new datum but a continuing output
// stripped down to a token min-UTXO (the real 15,000 ADA + 150M LP tokens
// diverted away from the script instead) is rejected.
test execute_dex_change_rejects_value_drain_attempt() {
  let target_dex = from_script(#"aa")
  let datum =
    LpEscrowDatum {
      ..mock_datum(Locked, 0),
      pending_dex_change: Some(
        PendingDexChange {
          dex_credential: target_dex.payment_credential,
          action: ProposeAdd,
          proposed_at: 0,
        },
      ),
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let attacker_address = from_verification_key(#"ee")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(15_000_000_000),
          assets.from_asset(#"33", "lp", 150_000_000),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    LpEscrowDatum {
      ..datum,
      dex_whitelist: [target_dex.payment_credential],
      pending_dex_change: None,
    }
  // Correct new datum, but a nearly-empty continuing output — the real
  // locked value goes to the attacker instead.
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_lovelace(1_500_000),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let drain_output =
    Output {
      address: attacker_address,
      value: assets.merge(
        assets.from_lovelace(13_498_500_000),
        assets.from_asset(#"33", "lp", 150_000_000),
      ),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, drain_output],
      validity_range: interval.between(
        dex_change_notice_period - 100,
        dex_change_notice_period + 100,
      ),
    }
  let redeemer = ExecuteDexChange { current_timestamp: dex_change_notice_period }

  !lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

// T90: identical to execute_dex_change_succeeds_after_notice_period except
// the declared validity range is far wider than max_validity_range_width
// — before this fix, ANY caller (this redeemer is permissionless once a
// change is pending) could execute a DEX whitelist change immediately
// after ProposeDexChange by declaring a wide range and claiming a
// far-future current_timestamp, bypassing the real 72-hour public notice
// period entirely.
test execute_dex_change_rejects_wide_validity_range() {
  let target_dex = from_script(#"aa")
  let datum =
    LpEscrowDatum {
      ..mock_datum(Locked, 0),
      pending_dex_change: Some(
        PendingDexChange {
          dex_credential: target_dex.payment_credential,
          action: ProposeAdd,
          proposed_at: 0,
        },
      ),
    }
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
    LpEscrowDatum {
      ..datum,
      dex_whitelist: [target_dex.payment_credential],
      pending_dex_change: None,
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
      // Real proposal was at 0; a real, honest ExecuteDexChange tx would
      // declare a narrow range near the real notice-period boundary. This
      // one instead spans all the way from 0, comfortably exceeding
      // max_validity_range_width.
      validity_range: interval.between(0, dex_change_notice_period + 100),
    }
  let redeemer = ExecuteDexChange { current_timestamp: dex_change_notice_period }

  !lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

test execute_dex_change_rejects_before_notice_period_elapsed() {
  let target_dex = from_script(#"aa")
  let datum =
    LpEscrowDatum {
      ..mock_datum(Locked, 0),
      pending_dex_change: Some(
        PendingDexChange {
          dex_credential: target_dex.payment_credential,
          action: ProposeAdd,
          proposed_at: 0,
        },
      ),
    }
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
    LpEscrowDatum {
      ..datum,
      dex_whitelist: [target_dex.payment_credential],
      pending_dex_change: None,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.zero,
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let too_early = dex_change_notice_period - 1
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(too_early - 100, too_early + 100),
    }
  let redeemer = ExecuteDexChange { current_timestamp: too_early }

  !lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

// `expect Some(pending) = None` traps rather than returning false, so this
// is a genuine runtime abort, not a negatable Bool — marked `fail` per
// Aiken's expected-panic test convention instead of wrapping in `!`.
test execute_dex_change_rejects_with_no_pending_change() fail {
  let datum = mock_datum(Locked, 0)
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
  let continuing_output =
    Output {
      address: own_address,
      value: assets.zero,
      datum: InlineDatum(datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      validity_range: interval.between(
        dex_change_notice_period - 100,
        dex_change_notice_period + 100,
      ),
    }
  let redeemer = ExecuteDexChange { current_timestamp: dex_change_notice_period }

  lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}

test cancel_pending_dex_change_succeeds_with_multisig() {
  let target_dex = from_script(#"aa")
  let datum =
    LpEscrowDatum {
      ..mock_datum(Locked, 0),
      pending_dex_change: Some(
        PendingDexChange {
          dex_credential: target_dex.payment_credential,
          action: ProposeAdd,
          proposed_at: 0,
        },
      ),
    }
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
  let new_datum = LpEscrowDatum { ..datum, pending_dex_change: None }
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
      extra_signatories: [#"bb", #"cc"],
    }

  lp_escrow.spend(Some(datum), CancelPendingDexChange, own_ref, self)
}

test cancel_pending_dex_change_rejects_below_multisig_threshold() {
  let target_dex = from_script(#"aa")
  let datum =
    LpEscrowDatum {
      ..mock_datum(Locked, 0),
      pending_dex_change: Some(
        PendingDexChange {
          dex_credential: target_dex.payment_credential,
          action: ProposeAdd,
          proposed_at: 0,
        },
      ),
    }
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
  let new_datum = LpEscrowDatum { ..datum, pending_dex_change: None }
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
      extra_signatories: [#"bb"],
    }

  !lp_escrow.spend(Some(datum), CancelPendingDexChange, own_ref, self)
}

// T13 tests — mock_datum's fee_recipient_pub_key_hash is #"dd".

test harvest_fees_succeeds_paying_the_creator_when_no_cto() {
  let datum = mock_datum(Locked, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let recipient_address = from_verification_key(#"dd")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(2_000_000),
          assets.from_asset(#"33", "lp", 1000),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  // Datum is completely unchanged — the LP position itself is never touched.
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(2_000_000),
        assets.from_asset(#"33", "lp", 1000),
      ),
      datum: InlineDatum(datum),
      reference_script: None,
    }
  let harvest_payout =
    Output {
      address: recipient_address,
      value: assets.from_lovelace(50_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, harvest_payout],
      // Permissionless — deliberately no extra_signatories.
    }

  lp_escrow.spend(Some(datum), HarvestFees { harvested_amount: 50_000 }, own_ref, self)
}

test harvest_fees_rejects_padded_output() {
  // T81: identical to harvest_fees_succeeds_paying_the_creator_when_no_cto,
  // except the LP position's own continuing output carries one extra,
  // unrelated junk asset (the LP token quantity itself is still exactly
  // preserved — lp_position_untouched alone wouldn't catch this). Also
  // permissionless — the same padding risk as SealLock applies here too.
  let datum = mock_datum(Locked, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let recipient_address = from_verification_key(#"dd")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(2_000_000),
          assets.from_asset(#"33", "lp", 1000),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.merge(
          assets.from_lovelace(2_000_000),
          assets.from_asset(#"33", "lp", 1000),
        ),
        // Junk asset from an unrelated policy — the padding attack.
        assets.from_asset(#"deadbeef", "spam", 1),
      ),
      datum: InlineDatum(datum),
      reference_script: None,
    }
  let harvest_payout =
    Output {
      address: recipient_address,
      value: assets.from_lovelace(50_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, harvest_payout],
    }

  !lp_escrow.spend(Some(datum), HarvestFees { harvested_amount: 50_000 }, own_ref, self)
}

test harvest_fees_pays_the_community_wallet_once_cto_triggered() {
  let datum = LpEscrowDatum { ..mock_datum(Locked, 0), cto_triggered: True, community_wallet_hash: #"ee" }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let community_address = from_verification_key(#"ee")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(2_000_000),
          assets.from_asset(#"33", "lp", 1000),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(2_000_000),
        assets.from_asset(#"33", "lp", 1000),
      ),
      datum: InlineDatum(datum),
      reference_script: None,
    }
  let harvest_payout =
    Output {
      address: community_address,
      value: assets.from_lovelace(50_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, harvest_payout],
    }

  lp_escrow.spend(Some(datum), HarvestFees { harvested_amount: 50_000 }, own_ref, self)
}

test harvest_fees_rejects_payout_to_the_creator_once_cto_triggered() {
  // Same scenario as the success case, but the payout still targets the
  // ORIGINAL creator (fee_recipient_pub_key_hash, #"dd") instead of the
  // community wallet — proves the redirect is actually enforced, not just
  // documented.
  let datum = LpEscrowDatum { ..mock_datum(Locked, 0), cto_triggered: True, community_wallet_hash: #"ee" }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let creator_address = from_verification_key(#"dd")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(2_000_000),
          assets.from_asset(#"33", "lp", 1000),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(2_000_000),
        assets.from_asset(#"33", "lp", 1000),
      ),
      datum: InlineDatum(datum),
      reference_script: None,
    }
  let harvest_payout =
    Output {
      address: creator_address,
      value: assets.from_lovelace(50_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, harvest_payout],
    }

  !lp_escrow.spend(Some(datum), HarvestFees { harvested_amount: 50_000 }, own_ref, self)
}

test harvest_fees_rejects_if_the_locked_lp_position_shrinks() {
  // The fee recipient IS correctly paid, but the LP's own locked token
  // quantity drops from 1000 to 900 in the same transaction — proves
  // HarvestFees cannot be used as a backdoor withdraw() on the locked LP.
  let datum = mock_datum(Locked, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let recipient_address = from_verification_key(#"dd")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(2_000_000),
          assets.from_asset(#"33", "lp", 1000),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(2_000_000),
        assets.from_asset(#"33", "lp", 900),
      ),
      datum: InlineDatum(datum),
      reference_script: None,
    }
  let harvest_payout =
    Output {
      address: recipient_address,
      value: assets.from_lovelace(50_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, harvest_payout],
    }

  !lp_escrow.spend(Some(datum), HarvestFees { harvested_amount: 50_000 }, own_ref, self)
}

test harvest_fees_rejects_before_lp_is_locked() {
  let datum = mock_datum(Cancelled, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let recipient_address = from_verification_key(#"dd")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(2_000_000),
          assets.from_asset(#"33", "lp", 1000),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(2_000_000),
        assets.from_asset(#"33", "lp", 1000),
      ),
      datum: InlineDatum(datum),
      reference_script: None,
    }
  let harvest_payout =
    Output {
      address: recipient_address,
      value: assets.from_lovelace(50_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, harvest_payout],
    }

  !lp_escrow.spend(Some(datum), HarvestFees { harvested_amount: 50_000 }, own_ref, self)
}

// T109: QueryState previously authorized ANY spend unconditionally
// (`QueryState -> True`, zero checks) — an unconditional authorization
// of the locked LP position. Proves the fix.
test query_state_rejects_unauthenticated_drain_attempt() {
  let datum = mock_datum(Locked, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let attacker_address = from_verification_key(#"ee")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(15_000_000),
          assets.from_asset(#"33", "lp", 1000),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let drain_output =
    Output {
      address: attacker_address,
      value: assets.merge(
        assets.from_lovelace(15_000_000),
        assets.from_asset(#"33", "lp", 1000),
      ),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction { ..transaction.placeholder, inputs: [own_input], outputs: [drain_output] }

  !lp_escrow.spend(Some(datum), QueryState, own_ref, self)
}

// Regression test: the value-conservation case verified against the full
// security audit — lp_position_untouched previously checked ONLY the LP
// TOKEN quantity, never lovelace. This proves a HarvestFees call that
// declares a trivial harvested_amount, keeps the LP token count exactly
// unchanged, but strips the escrow's real lovelace balance down to near
// nothing (the rest diverted away from the script) is rejected.
test harvest_fees_rejects_real_lovelace_drain_attempt() {
  let datum = mock_datum(Locked, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let recipient_address = from_verification_key(#"dd")
  let attacker_address = from_verification_key(#"ee")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(15_000_000_000),
          assets.from_asset(#"33", "lp", 1000),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  // LP token count exactly preserved (satisfies the old, still-present
  // lp_position_untouched check) — but almost all the real lovelace is
  // gone.
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(assets.from_lovelace(1_500_000), assets.from_asset(#"33", "lp", 1000)),
      datum: InlineDatum(datum),
      reference_script: None,
    }
  let harvest_payout =
    Output {
      address: recipient_address,
      value: assets.from_lovelace(1),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let drain_output =
    Output {
      address: attacker_address,
      value: assets.from_lovelace(14_998_500_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, harvest_payout, drain_output],
    }

  !lp_escrow.spend(Some(datum), HarvestFees { harvested_amount: 1 }, own_ref, self)
}

// T111 fix regression test: Migrate previously only verified the LP TOKEN
// lands at the target DEX — the real locked ADA was never checked. This
// proves a migration that correctly delivers the LP tokens but diverts
// the real locked ADA elsewhere is now rejected.
test migrate_rejects_ada_diversion() {
  let target_dex = from_script(#"aa")
  let datum =
    LpEscrowDatum { ..mock_datum(Locked, 0), dex_whitelist: [target_dex.payment_credential] }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let attacker_address = from_verification_key(#"ee")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(15_000_000_000),
          assets.from_asset(#"33", "lp", 1000),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  // Full LP token quantity correctly lands at the target DEX, but only a
  // token amount of ADA — the rest diverted to the attacker.
  let dex_output =
    Output {
      address: target_dex,
      value: assets.merge(assets.from_lovelace(1_500_000), assets.from_asset(#"33", "lp", 1000)),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let drain_output =
    Output {
      address: attacker_address,
      value: assets.from_lovelace(14_998_500_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [dex_output, drain_output],
      extra_signatories: [#"22"],
    }
  let redeemer =
    Migrate { target_dex_credential: target_dex.payment_credential, current_timestamp: min_lock_duration }

  !lp_escrow.spend(Some(datum), redeemer, own_ref, self)
}
