// ============================================================================
// Noctis Protocol — Cardano L1 Bonding Curve Contract (Aiken)
// Tier A only
// ============================================================================
// Tier A never touches Midnight — this is the entire public sale mechanism
// for Tier A launches. Per CLAUDE.md's tier design, Tier A is deliberately
// the "weak" tier: LINEAR pricing (not quadratic) and a weak per-ADDRESS
// cap (not a strong ZK-identity cap — the same wallet can be split to dodge
// it, an accepted trade-off for the free/simple tier). The quadratic curve
// + ZK-identity cap combination is Tier B/C's, on Midnight instead — see
// contracts/midnight/bonding_curve.compact. Do not import that file's
// shape here; the two are intentionally different curves for different
// tiers, not two implementations of the same thing.
//
// Price formula: price = base_price + k * sold
//   where k = (max_price - base_price) / curve_supply
//   i.e. price = base_price + ((max_price - base_price) * sold) / curve_supply
//
// At sold=0:             price = base_price
// At sold=curve_supply:  price = max_price
//
// Fee structure (2.0% total, same split as Tier B/C):
//   1.0% -> creator fee accumulator (claimed by creator; mirrors the
//           "Stream A" Bonding Curve Escrow pattern from CLAUDE.md — Tier A
//           has no separate Cardano Creator Fee Escrow contract in the
//           architecture table, so this curve contract accrues and gates
//           the claim directly instead of handing off to another PSM)
//   0.6% -> treasury accumulator (governor-claimed)
//   0.4% -> ops accumulator (governor-claimed)
//
// Graduation: 100% sell-through only (CLAUDE.md — no partial graduation).
// On graduation this contract stops accepting buys and marks Graduated.
//
// T49 fix (2026-07-10): 100% sell-through only ever flipped a `curve_state`
// flag — nothing actually moved the raised ADA or the LP token reserve into
// lp_escrow.ak, so a "graduated" launch never really produced a working LP.
// Added a `Graduate` redeemer (permissionless, same "the condition itself is
// the authorization" idiom as ExpireCurve below) that consumes the curve's
// accrued `total_raised` ADA (T27: Option A, all net-of-fee principal) and a
// dedicated `lp_reserve_tokens` balance — held in this same UTXO from deploy
// time onward, untouched by BuyTokens/ClaimBuyback — and verifies both
// actually land at the launch's `lp_escrow_credential` in the same
// transaction. The curve contract is NOT fully consumed by Graduate: its fee
// accumulators (creator/treasury/ops) stay claimable afterward exactly as
// before, matching CLAUDE.md's Stream A description ("amount fixed at
// graduation, does not continue, but is still claimed after"). A `lp_seeded`
// flag guards against double-seeding.
//
// Bonus fix found while designing Graduate (2026-07-10): `token_delivered`
// (used by BuyTokens) only ever checked that SOME output held `token_amount`
// of the launch token — it never checked that the curve's OWN reserve
// actually decreased by that amount, the delivery-side mirror of T40's
// payment-side fix. Undetected before now because nothing downstream relied
// on the curve's real token balance staying honest; it matters now because
// `lp_reserve_tokens` sits in the same UTXO Graduate reads from, so an
// inflated/fake `tokens_sold` count (reachable by self-supplying the
// "delivery" output while the curve's real balance never moves) could
// falsely trigger Graduated and let Graduate try to pay out a reserve that
// was never actually there. Fixed via a new `curve_token_balance_decreased`
// check, applied to BuyTokens the same way `payment_received` already is —
// same real-value-movement discipline as ClaimBuyback's helpers below.
//
// T29 fix (2026-07-10): 100% sell-through with no timeout meant a
// poorly-marketed or abandoned curve could stall below Graduated forever —
// no LP ever seeds, so early buyers hold permanently illiquid tokens with
// no forced resolution if the governor never acts. Added `activated_at`
// (set when ActivateCurve fires) and a permissionless `ExpireCurve`
// redeemer, mirroring cto_governance.ak's `ExpireProposal` idiom exactly:
// a `current_timestamp` redeemer field checked against the tx's actual
// validity range via `interval.contains` (Cardano scripts can't read a
// wall clock directly), no signature required once the deadline has
// passed. `max_curve_duration` defaults to 90 days — same order of
// magnitude as SILENCE_LOCK_DAYS's "something hasn't happened in a
// reasonable business timeframe" precedent, not a value CLAUDE.md
// specified; treat as adjustable, same status as T2's settlement-window
// default. Stranded-principal disposition (once Cancelled) is T48's
// ClaimBuyback below — that question is resolved, not open anymore.
//
// Rewritten 2026-07-09 to match real Aiken v1.1.23 syntax — the original
// draft used a fictional API (`fn spend(...) -> Void`, `ctx: ScriptContext`,
// `Ed25519.verify(...)`, `Blake2b_224.hash(...)`, `require(...)`) that
// doesn't exist in any real Aiken version and crashed the compiler on
// import resolution. Authorization now uses the idiomatic pattern of
// checking `self.extra_signatories` (the ledger already verifies those
// signatures before the script runs) instead of manually re-verifying an
// Ed25519 signature passed through the redeemer.
// ============================================================================

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval
use aiken/interval.{Interval, IntervalBoundType}
use cardano/address.{Address, Credential, from_verification_key, with_delegation_key}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{Input, InlineDatum, Output, OutputReference, Transaction}
use cto_governance.{
  CTOTriggered as CtoAnchorTriggered, CtoGovernanceDatum, DissolveCTOProposal,
  Executed, Passed, PreCTO, ProposalAnchor, ProposalType, SilenceLockTrigger,
}

/// T90: a Cardano script only ever sees a transaction's OWN DECLARED
/// validity range, never real wall-clock time — `interval.contains` alone
/// lets ANY caller claim ANY timestamp within an arbitrarily wide,
/// self-chosen range, which defeats a "deadline" check entirely for a
/// PERMISSIONLESS redeemer (no trusted signer to rely on instead, unlike
/// e.g. ActivateCurve). `ExpireCurve` is permissionless by design ("the
/// deadline check itself is the authorization") — without this, literally
/// a curve must not be cancellable immediately after activation by
/// simply declaring a wide-enough validity range and claiming a
/// timestamp near its far end. Found while researching Phase 5b (real DEX
/// migration) of the Tier A Preprod Milestone — see internal tracking's
/// [T90] for the full cross-contract audit (this same gap exists in
/// bonding_curve_tier_b.ak's ExpireCurve, lp_escrow.ak's
/// ExecuteDexChange, and cto_governance.ak's AnchorProposal/
/// ExpireProposal, all fixed in the same pass). `max_width` is generous
/// (10 minutes) relative to Preprod's real ~20s block time, comfortably
/// covering real network/build delays while still closing the gap.
fn validity_range_is_narrow(range: Interval, max_width: Int) -> Bool {
  when (range.lower_bound.bound_type, range.upper_bound.bound_type) is {
    (IntervalBoundType.Finite(lo), IntervalBoundType.Finite(hi)) ->
      hi >= lo && hi - lo <= max_width
    _ -> False
  }
}

/// 10 minutes in milliseconds — the max validity-range width permitted for
/// any permissionless, timestamp-deadline-gated redeemer in this file.
const max_validity_range_width = 600_000

// ============================================================================
// TYPES
// ============================================================================

/// Curve lifecycle
pub type CurveState {
  Inactive
  Active
  Graduated
  Cancelled
}

/// The datum stored at the bonding curve UTxO
pub type BondingCurveDatum {
  // Identity
  launch_id: ByteArray,
  creator_pub_key_hash: VerificationKeyHash,
  governor_pub_key_hash: VerificationKeyHash,
  // Curve parameters (fixed at deploy)
  base_price: Int,
  // lovelace per token at sold = 0
  max_price: Int,
  // lovelace per token at sold = curve_supply
  curve_supply: Int,
  // total tokens sellable on this curve
  // Live state
  curve_state: CurveState,
  // Posix time (seconds) the curve was activated — 0 while still
  // Inactive. Used by ExpireCurve (T29) to detect a stalled curve.
  activated_at: Int,
  tokens_sold: Int,
  total_raised: Int,
  // net of fees, lovelace
  // Fee accumulators (2.0% total: 1.0/0.6/0.4 split, same as Tier B/C)
  creator_fees_accrued: Int,
  treasury_fees_accrued: Int,
  ops_fees_accrued: Int,
  // Weak per-address cap (5% of curve_supply) — deliberately per raw
  // verification-key hash, not per ZK identity; splitting wallets defeats
  // this, which is the accepted Tier A trade-off per CLAUDE.md
  wallet_cap: Int,
  per_address_purchases: List<(VerificationKeyHash, Int)>,
  // Token identity (the launch's native asset, locked in this UTxO)
  token_policy_id: PolicyId,
  token_asset_name: AssetName,
  // T49: LP graduation fields. `lp_escrow_credential` is fixed at deploy —
  // the payment credential of THIS launch's own LP Escrow contract UTXO, so
  // Graduate can't be redirected to seed an unrelated address.
  // `lp_reserve_tokens` (15% of TOTAL_SUPPLY, per CLAUDE.md's
  // LP_RESERVE_PCT) is deposited into this same UTXO at deploy time
  // alongside the curve_supply worth of sellable tokens, and is untouched
  // by BuyTokens/ClaimBuyback — only Graduate ever moves it.
  lp_escrow_credential: Credential,
  lp_reserve_tokens: Int,
  lp_seeded: Bool,
  // CTO fee-redirect fix (2026-07-12): once a CTO passes via
  // cto_governance.ak's SilenceLockTrigger, future ClaimCreatorFees claims
  // redirect to the community wallet instead of the creator — mirrors
  // lp_escrow.ak's cto_triggered/community_wallet_hash pattern (T13),
  // applied here for the first time to bonding-curve trade fees. Before
  // this fix, a passed CTO vote never actually redirected anything: this
  // contract had no CTO concept at all, so the creator could keep claiming
  // regardless of governance outcome.
  community_pub_key_hash: VerificationKeyHash,
  cto_triggered: Bool,
  // Staking Rewards Pool (T66, 2026-07-14): optional per-launch feature.
  // `staking_pool_credential` is fixed at deploy — this launch's own
  // staking_pool.ak instance, same "can't be redirected" guarantee as
  // `lp_escrow_credential`. `staking_reserve_tokens` is 0 when the creator
  // didn't opt in; when they did, it's STAKING_ALLOC_PCT (25%) of
  // TOTAL_SUPPLY, deposited into this UTXO at deploy time alongside
  // curve_supply and lp_reserve_tokens, untouched by BuyTokens/ClaimBuyback
  // — only Graduate ever moves it, in the same transaction as LP seeding.
  staking_enabled: Bool,
  staking_pool_credential: Credential,
  staking_reserve_tokens: Int,
  staking_seeded: Bool,
  // T-CTO-ENFORCE fix: cto_governance.ak's own fixed script address, set
  // at genesis exactly like lp_escrow_credential/staking_pool_credential
  // above — same "no constructor params, one fixed address shared across
  // every launch, so this field never actually varies" shape. Needed
  // because TriggerCTO/DissolveCTO below now require real reference-input
  // evidence a vote actually passed, instead of trusting a bare governor
  // signature — that evidence lives at this address.
  cto_governance_credential: Credential,
  // C-1 fix (2026-07-23 security audit): the governance THREAD NFT's policy
  // id. Paying to a script address never runs its validator, and reference
  // inputs are read-only — so trusting a reference input at
  // cto_governance_credential by address alone is not sufficient authentication, because
  // place a UTXO there carrying an unauthenticated
  // datum and reference it. cto_vote_verified now additionally requires the
  // referenced governance UTXO to carry the genuine per-launch governance
  // NFT (this policy, asset_name = launch_id) — minted once, at governance
  // setup, under a governor-signature policy no attacker can satisfy, and
  // preserved in cto_governance.ak's continuing output on every spend. Set
  // at genesis exactly like the credentials above.
  cto_governance_nft: PolicyId,
}

/// Redeemer actions — what the contract can be spent with
pub type BondingCurveRedeemer {
  /// Governor activates the curve (Inactive -> Active). `current_timestamp`
  /// is stamped into `activated_at`, verified against the tx's actual
  /// validity range (T29) so ExpireCurve has a trustworthy start point.
  ActivateCurve { current_timestamp: Int }
  /// Public buy — no identity proof required, unlike Tier B/C's DarkVeil-
  /// gated purchases. The caller supplies the expected price and fee split
  /// (computed off-chain) and the contract verifies both.
  BuyTokens {
    token_amount: Int,
    claimed_price: Int,
    gross_payment: Int,
    claimed_creator_fee: Int,
    claimed_treasury_fee: Int,
    claimed_ops_fee: Int,
    buyer_key_hash: VerificationKeyHash,
  }
  /// Creator claims accrued creator fees (Stream A pattern — pre-graduation
  /// bonding curve fees only; distinct from post-graduation LP trading fees).
  ///
  /// T107 fix (2026-07-19): two changes, found during pre-test security
  /// review ahead of a live Preprod fee-claim test. (1) Previously had NO
  /// value-conservation check at all — only the datum's accrued counter was
  /// verified, not that the curve's real lovelace balance actually
  /// decreased by `amount` or that `amount` reached the claimer. Since the
  /// signer must BE the fee recipient, this wasn't a third-party theft
  /// risk, but it let that signer construct a transaction draining the
  /// ENTIRE curve balance (buyers' `total_raised` principal included)
  /// while the datum showed only a token-sized `amount` decrement — fixed
  /// via the same real-value-movement discipline every other value-moving
  /// redeemer in this file already uses (`payment_received`,
  /// `lovelace_paid_from_curve`, `graduation_funds_left_curve`). (2) New
  /// `platform_claim_fee` — a real, on-chain-enforced flat charge (in
  /// addition to `amount`, paid INTO the curve, not out of it) covering
  /// this claim, split 40/60 ops/treasury into the existing
  /// `ops_fees_accrued`/`treasury_fees_accrued` accumulators rather than a
  /// new payout address. Approximates CLAUDE.md's existing
  /// `STAKING_CLAIM_FEE_USD` ($1) precedent but — unlike that fee, which is
  /// advisory-only in `staking_pool.ak` — this one is a real on-chain
  /// minimum, not just a client convention. Aiken has no in-circuit oracle
  /// access (same architectural constraint Compact has), so
  /// `min_platform_claim_fee_lovelace` below is a deliberately conservative
  /// SANITY FLOOR, not a precise live $1 peg — the real $1-equivalent is
  /// computed off-chain via the already-real `usdToMinAdaLovelace()`
  /// Orcfax oracle (`integration/ada-price-oracle.ts`) and paid with
  /// margin above the floor in the normal case.
  ClaimCreatorFees { amount: Int, platform_claim_fee: Int }
  /// Governor claims accrued treasury fees.
  ///
  /// T107 fix: same missing value-conservation gap as ClaimCreatorFees,
  /// fixed the same way — no new fee added here (the governor is claiming
  /// treasury's OWN existing accrual, not paying a new platform charge).
  ClaimTreasuryFees { amount: Int }
  /// Governor claims accrued ops fees. T107 fix: same as ClaimTreasuryFees.
  ClaimOpsFees { amount: Int }
  /// Public sell — the reverse of BuyTokens (T106, 2026-07-19). Symmetric
  /// pricing: BuyTokens prices a batch at the PRE-trade `tokens_sold` (the
  /// low edge of the range being added); SellTokens prices at the
  /// POST-trade `tokens_sold` (`datum.tokens_sold - token_amount` — the low
  /// edge of the range being removed, the SAME point). This makes an
  /// immediate buy-then-sell of the same amount net to zero before fees —
  /// the 2.0% round-trip fee is the only intentional friction, not a
  /// pricing-formula asymmetry. Verified by working through the invariant
  /// `total_raised + creator_fees_accrued + treasury_fees_accrued +
  /// ops_fees_accrued == curve's real lovelace balance` (true after every
  /// BuyTokens call) and confirming it still holds after SellTokens:
  /// `total_raised` decreases by the FULL `gross_proceeds` (not just
  /// `net_proceeds`), while `fee_total` accrues to the same 3 accumulators
  /// exactly as a buy's fee does — only `net_proceeds` (gross minus fees)
  /// actually leaves the curve to pay the seller.
  ///
  /// A seller can only sell up to their own tracked `per_address_purchases`
  /// total via THIS contract — deliberate scope, not a bug:
  /// `per_address_purchases` only tracks purchases made through BuyTokens,
  /// so tokens a wallet acquired via a direct secondary transfer aren't
  /// tracked here and can't be sold back through this redeemer. This also
  /// means the creator (permanently blocked from BuyTokens by T32, so
  /// their tracked purchase total is always 0) can never sell here either
  /// — no separate creator-block needed, it falls out of this check for
  /// free. Selling decrements the same tracked total BuyTokens increments,
  /// freeing wallet_cap headroom for future buys — this contract treats
  /// the cap as "current net curve position," not "lifetime gross
  /// purchases."
  SellTokens {
    token_amount: Int,
    claimed_price: Int,
    gross_proceeds: Int,
    claimed_creator_fee: Int,
    claimed_treasury_fee: Int,
    claimed_ops_fee: Int,
    seller_key_hash: VerificationKeyHash,
  }
  /// Cancel the launch (governor only, failure path — voluntary, any time)
  CancelCurve
  /// Permissionless — anyone can force-cancel a curve that's been Active
  /// for longer than `max_curve_duration` without reaching Graduated
  /// (T29). No signature required, same trust model as
  /// cto_governance.ak's `ExpireProposal`: the deadline check itself is
  /// the authorization.
  ExpireCurve { current_timestamp: Int }
  /// Pro-rata buyback (T48, 2026-07-10): once Cancelled, a token holder
  /// returns `token_amount` of the launch token to this contract and
  /// reclaims their proportional share of the stranded ADA principal
  /// (`total_raised * token_amount / tokens_sold`, using the curve's own
  /// real division — Aiken's Int is arbitrary-precision, no ZK-circuit
  /// division restriction the way Compact has). The buyer must actually
  /// send the tokens in the same transaction (`tokens_returned_to_curve`)
  /// and actually receive the computed ADA share
  /// (`lovelace_paid_from_curve`) — same real-value-movement pattern as
  /// `payment_received`/`token_delivered`, not a self-reported claim.
  ClaimBuyback { token_amount: Int, buyer_key_hash: VerificationKeyHash }
  /// T49: seed the LP once Graduated. Permissionless — same idiom as
  /// ExpireCurve, since every effect is verified against real value
  /// movement, not a signature-backed claim: nobody benefits from calling
  /// this "incorrectly" because a malformed attempt simply fails the
  /// invariant checks below. Moves `total_raised` lovelace and
  /// `lp_reserve_tokens` of the launch token to `lp_escrow_credential`;
  /// fee accumulators are untouched and remain separately claimable.
  Graduate
  /// Trigger CTO — governor only, called after a SilenceLockTrigger
  /// proposal passes on cto_governance.ak. Redirects future
  /// ClaimCreatorFees claims to community_pub_key_hash. Same pattern as
  /// lp_escrow.ak's TriggerCTO (T13).
  TriggerCTO { community_pub_key_hash: VerificationKeyHash }
  /// Dissolve CTO — governor only, called after a DissolveCTO proposal
  /// passes (creator returned). Reverts ClaimCreatorFees back to the
  /// original creator.
  DissolveCTO
  /// Read-only query, no state change — off-chain callers should just read
  /// the datum directly rather than spend through this redeemer
  QueryState
}

// ============================================================================
// CONSTANTS
// ============================================================================

/// Fee split in basis points (10000 = 100%) — 1.0% / 0.6% / 0.4% = 2.0% total
const creator_bps = 100

const treasury_bps = 60

const ops_bps = 40

const bps_denominator = 10_000

/// T107: deliberately conservative SANITY FLOOR for ClaimCreatorFees's new
/// platform_claim_fee, not a precise $1 peg (Aiken has no in-circuit oracle
/// access — same constraint Compact has). 0.2 ADA comfortably undershoots
/// $1's real ADA value across ADA's entire realistic historical trading
/// range; the real $1-equivalent is computed off-chain via the already-
/// real usdToMinAdaLovelace() Orcfax oracle and paid with margin above
/// this floor in the normal case. Same "fixed ADA figure, not oracle-
/// verified in-circuit" idiom as NHOP_CHALLENGE_BOND (25 ADA).
const min_platform_claim_fee_lovelace = 200_000

/// T107: 40/60 ops/treasury split for platform_claim_fee — same ratio as
/// every other fee split in this codebase (TIER_A_OPS_PCT/TIER_A_TREASURY_PCT,
/// STAKING_CLAIM_FEE_OPS_PCT/STAKING_CLAIM_FEE_TREASURY_PCT).
const platform_fee_ops_bps = 4_000

const platform_fee_treasury_bps = 6_000

/// 90 days in MILLISECONDS — max time a curve can sit Active without
/// reaching Graduated before anyone can force-expire it (T29). Not a
/// CLAUDE.md-specified constant; same status as T2's settlement-window
/// default — a documented starting point, adjustable.
///
/// T87 fix (2026-07-17): this was previously `7_776_000` (90 days in
/// SECONDS), justified by a comment claiming it matched cto_governance.ak's
/// own `execution_window` "Posix seconds, not ms" convention — that
/// justification was itself wrong. `ActivateCurve`/`ExpireCurve`'s
/// `current_timestamp` is checked via `interval.contains(self.validity_range,
/// current_timestamp)`, and Cardano's real transaction validity range is
/// natively expressed in MILLISECONDS (confirmed via a real, on-chain-
/// confirmed `ActivateCurve` transaction recording `activated_at:
/// 1784273626775`, a 13-digit ms epoch). Adding a seconds-scale constant to
/// a ms-scale `activated_at` meant the documented "90-day stall window" was
/// actually enforced as ~7,776,000ms ≈ 2.16 real hours. Found while
/// building Phase 5 of the Tier A Preprod Milestone (see internal tracking's
/// [T87]) — fixed here, and the SAME bug pattern was found and fixed in
/// cto_governance.ak's `execution_window` in the same pass (that field is
/// ALSO checked via `interval.contains`, so it needed the identical fix).
const max_curve_duration = 7_776_000_000

// ============================================================================
// HELPERS
// ============================================================================

/// Verify the claimed price matches the linear curve formula via
/// cross-multiplication (exact — no floor-division rounding drift):
///   claimed_price * curve_supply == base_price * curve_supply
///                                     + (max_price - base_price) * sold
fn verify_price(datum: BondingCurveDatum, sold: Int, claimed_price: Int) -> Bool {
  let price_range = datum.max_price - datum.base_price
  claimed_price * datum.curve_supply == datum.base_price * datum.curve_supply + price_range * sold
}

/// Verify a claimed fee slice equals gross_payment * bps / bps_denominator,
/// via cross-multiplication so no rounding disagreement is possible:
///   claimed_fee * bps_denominator == gross_payment * bps
fn verify_fee_slice(gross_payment: Int, bps: Int, claimed_fee: Int) -> Bool {
  claimed_fee * bps_denominator == gross_payment * bps
}

/// Look up a wallet's cumulative purchase total (0 if not found)
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

/// Find this validator's own continuing output (same address as the input
/// being spent) and decode its inline datum.
fn own_continuing_datum(
  self: Transaction,
  own_ref: OutputReference,
) -> BondingCurveDatum {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  expect InlineDatum(raw_datum) = own_output.datum
  expect new_datum: BondingCurveDatum = raw_datum
  new_datum
}

/// Verify the buyer's `gross_payment` lovelace actually increased the
/// validator's own continuing output by exactly that amount.
///
/// T40 fix (2026-07-09): before this, `gross_payment` was purely
/// self-reported — `token_delivered` below checked the buyer received
/// their tokens, but nothing checked the buyer actually paid anything.
/// Same class of gap as bonding_curve.compact's missing `receiveUnshielded`
/// (fixed the same day on the Midnight side); here the equivalent is
/// checking the UTXO's own lovelace value increased, since Cardano's value
/// model makes real payment a property of the transaction's outputs, not
/// something a circuit declares as an effect.
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
  datum: BondingCurveDatum,
  token_amount: Int,
) -> Bool {
  list.any(
    self.outputs,
    fn(output: Output) {
      assets.quantity_of(output.value, datum.token_policy_id, datum.token_asset_name) == token_amount
    },
  )
}

/// Bonus fix found while designing T49 (2026-07-10): verify the curve's OWN
/// continuing output's token balance actually decreased by `token_amount` —
/// the delivery-side mirror of `payment_received`'s payment-side check.
/// Without this, `token_delivered` above only proves SOME output received
/// tokens, not that they came from the curve's own reserve — a buyer could
/// self-supply the "delivery" from tokens they already hold, inflating
/// `tokens_sold` (and therefore triggering Graduated) without the curve's
/// real balance ever shrinking. Matters concretely now that
/// `lp_reserve_tokens` sits in this same UTXO: a falsely-triggered
/// Graduated state would let Graduate try to pay out a reserve that isn't
/// really backed.
fn curve_token_balance_decreased(
  self: Transaction,
  own_ref: OutputReference,
  datum: BondingCurveDatum,
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

/// T81 fix (2026-07-16): caps how many distinct (policy, asset name)
/// entries a script-controlled output may hold. Found by comparing against
/// MeshJS's own open-source escrow.ak, which names this the "unbounded
/// value vulnerability" and fixes it the same way (value_length <= 9 —
/// tighter here at 2, since Noctis's own outputs only ever legitimately
/// hold lovelace + one tracked launch token, unlike MeshJS's escrow which
/// genuinely allows multiple asset kinds per party by design). Without
/// this, the curve's own continuing UTXO — spent and re-created on every
/// single buy for the launch's entire life — could be padded with junk
/// native assets by any buyer, inflating the execution-unit cost of every
/// subsequent buy until the curve becomes expensive or impossible to
/// interact with. Not a fund-theft risk; a griefing/availability one.
fn output_value_clean(output: Output, max_assets: Int) -> Bool {
  list.length(assets.flatten(output.value)) <= max_assets
}

/// T81: the curve's own continuing output specifically — looked up the
/// same way payment_received/curve_token_balance_decreased already do.
fn curve_own_output_clean(self: Transaction, own_ref: OutputReference) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  output_value_clean(own_output, 2)
}

/// T111 fix (2026-07-19, full-suite security audit): closes a
/// double-satisfaction risk. Every value-check helper in this file locates
/// "this input's own continuing output" by ADDRESS ONLY
/// (list.find/list.any on own_address) — not by a per-UTXO beacon token or
/// input-index correlation. Since every Tier A launch's curve shares ONE
/// fixed, unparameterized script address (no constructor params — see this
/// file's own header), a transaction combining inputs from TWO DIFFERENT
/// launches' curves in one transaction would make every such lookup
/// resolve to whichever matching output happens to come first, not
/// necessarily the one that specific input's own checks intend — the
/// classic eUTXO "double satisfaction" bug shape. Requiring AT MOST ONE
/// input and AT MOST ONE output at this contract's own address, for the
/// WHOLE transaction, makes every list.find/list.any call in this file
/// unambiguous by construction: there is only ever one real candidate to
/// find. Applied once at the top of the validator (see `spend` below)
/// rather than duplicated into every redeemer branch.
fn single_own_utxo(self: Transaction, own_address: Address) -> Bool {
  list.length(list.filter(self.inputs, fn(input) { input.output.address == own_address })) <= 1 && list.length(
    list.filter(self.outputs, fn(output) { output.address == own_address }),
  ) <= 1
}

/// T48, generalized T106: verify the caller actually sent token_amount of
/// the launch token INTO this contract's own continuing output (the
/// reverse of token_delivered). Originally ClaimBuyback-only ("the
/// buyback's return-the-tokens half"); reused as-is by SellTokens (T106) —
/// the check is identical regardless of which redeemer needs "tokens flow
/// into the curve" verified.
fn tokens_returned_to_curve(
  self: Transaction,
  own_ref: OutputReference,
  datum: BondingCurveDatum,
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

/// T48, generalized T106/T107: verify this contract's own continuing
/// output lovelace decreased by exactly `share`, and `recipient_key_hash`
/// actually received `share` lovelace in some output (reverse of
/// payment_received). Originally ClaimBuyback-only; reused as-is by
/// SellTokens (T106, seller in place of buyer) and ClaimTreasuryFees/
/// ClaimOpsFees (T107 fix, governor in place of buyer) — the check is
/// identical regardless of which redeemer needs "lovelace flows out of the
/// curve to X" verified. ClaimCreatorFees needs a different, two-way
/// check (money out AND platform_claim_fee in, same transaction) — see its
/// own match arm below, not this helper.
///
/// T93/T115 fix (2026-07-22): previously compared the FULL output address
/// against `from_verification_key(recipient_key_hash)` — Aiken stdlib's
/// real `from_verification_key` (confirmed against the installed
/// `aiken-lang/stdlib` source) constructs a bare ENTERPRISE address (no
/// stake credential), not the recipient's real base address. Since this
/// helper is shared by all four redeemers above, that meant EVERY one of
/// them (not just ClaimBuyback, which is where T93 first found it) could
/// only pay out to a derived enterprise address, never the recipient's own
/// real wallet address directly. Not a security bug (the recipient's own
/// key controls either address identically), but a real UX footgun — funds
/// landing somewhere a normal wallet UI doesn't automatically surface —
/// and it forced every off-chain submitter for all four redeemers to
/// separately re-derive that same enterprise address rather than just
/// paying the recipient's real address. Fixed by comparing only the
/// PAYMENT CREDENTIAL, matching the same `.address.payment_credential`
/// idiom this file already uses elsewhere (`lp_escrow_credential`/
/// `staking_pool_credential`/`cto_governance_credential` checks) — any
/// output whose payment credential matches `recipient_key_hash`,
/// enterprise or base, satisfies this now.
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

/// T49: verify the curve's own continuing output lovelace decreased by
/// exactly `lp_ada` AND its token balance decreased by exactly
/// `lp_reserve_tokens` — the "funds actually left the curve" half of
/// Graduate, same real-value-movement discipline as lovelace_paid_from_curve /
/// tokens_returned_to_curve above.
fn graduation_funds_left_curve(
  self: Transaction,
  own_ref: OutputReference,
  datum: BondingCurveDatum,
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

/// T-CTO-ENFORCE fix: real evidence a vote actually passed, replacing a
/// bare governor signature. Before this, TriggerCTO/DissolveCTO required
/// only `list.has(self.extra_signatories, datum.governor_pub_key_hash)` —
/// no check anywhere that a real community vote ever happened, let alone
/// passed. A compromised or rogue governor could unilaterally seize any
/// launch's creator fees with zero community involvement. Fixed by
/// requiring a reference input at cto_governance.ak's own fixed address
/// (`datum.cto_governance_credential`, set at genesis) showing a real
/// anchored `last_executed_proposal` for THIS launch matching the
/// expected type/outcome/recipient. `last_executed_proposal` — not the
/// clearable `active_proposal` — specifically because a governor could
/// otherwise let a vote pass, then call cto_governance.ak's
/// governor-only `ClearProposal` before this reference-input check ever
/// ran against it, erasing the only on-chain evidence and reopening the
/// same gap. See that field's own doc comment in cto_governance.ak.
///
/// Once this evidence exists, the redeemer becomes fully permissionless —
/// same "the passed state is the authorization" idiom already used for
/// ExpireCurve/Graduate in this file. Residual, low-probability risk
/// worth naming: `last_executed_proposal` is a single slot that a LATER,
/// unrelated proposal could in principle overwrite before this call ever
/// fires — cto_governance.ak's own 90-day mandatory cooldown between any
/// two proposals gives a wide real-world window to act on it first.
/// `expected_recipient` is only meaningful for SilenceLockTrigger —
/// cto_governance.ak's own AnchorVoteResult only ever copies
/// `allocation_recipient_hash` into the new community wallet for that
/// proposal type (DissolveCTOProposal always resets it to empty
/// regardless of whatever value was submitted), so checking it for
/// dissolve would test an arbitrary, meaningless value. Pass `None` for
/// DissolveCTOProposal, where the proposal_type + outcome +
/// execution_status match is the only real evidence needed.
fn cto_vote_verified(
  self: Transaction,
  datum: BondingCurveDatum,
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

/// The identity currently allowed to claim creator fees — the creator's own
/// key, or (once CTO has been triggered) the community wallet. Mirrors
/// lp_escrow.ak's active_fee_recipient exactly (T13).
fn active_fee_recipient(datum: BondingCurveDatum) -> VerificationKeyHash {
  if datum.cto_triggered {
    datum.community_pub_key_hash
  } else {
    datum.creator_pub_key_hash
  }
}

/// T49: verify an output at the launch's own `lp_escrow_credential` holds
/// AT LEAST `lp_ada` lovelace and exactly `lp_reserve_tokens` of the launch
/// token — the "funds actually arrived at the LP" half of Graduate.
///
/// T88 fix (2026-07-17): the lovelace check was previously EXACT equality
/// (`== lp_ada`), which can never be satisfied in a real transaction —
/// `lp_escrow.ak`'s genesis placeholder UTXO always holds a non-zero
/// min-ADA balance BEFORE `SealLock` runs (a real, unavoidable Cardano
/// requirement — no UTXO can hold 0 lovelace), and `SealLock`'s own
/// `lp_value_received` check is RELATIVE (`own_output == own_input +
/// seeded_ada`), so the real resulting output always holds MORE than
/// `lp_ada` alone (existing balance + lp_ada). The two checks were
/// mathematically incompatible for any real, already-funded lp_escrow
/// UTXO — confirmed by a real, on-chain-reproduced Graduate+SealLock
/// transaction failure (see internal tracking's [T88]), then isolated to
/// this exact line via `aiken tx simulate` (redeemer-index-to-input
/// mapping showed the FAILING redeemer was Graduate, not SealLock — the
/// opposite of the original bisection's conclusion) and confirmed with a
/// minimal Aiken unit test modeling a realistic (non-zero) pre-existing
/// lp_escrow balance. `graduation_funds_left_curve` already enforces an
/// EXACT decrease on the curve's OWN side, and `lp_value_received`
/// already enforces an EXACT relative increase on lp_escrow's OWN side —
/// this check only needs to confirm real value arrived, not re-derive an
/// absolute amount it has no way to know (it doesn't see lp_escrow's
/// pre-existing balance). `>=` closes the gap without weakening any
/// invariant: nothing is gained by an attacker padding this output with
/// EXTRA lovelace from a third source (same "harmless donation" reasoning
/// already applied elsewhere in this file).
fn lp_seeding_output_ok(
  self: Transaction,
  datum: BondingCurveDatum,
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

/// T66: verify an output at the launch's own `staking_pool_credential` holds
/// exactly `staking_reserve_tokens` of the launch token — the "funds
/// actually arrived at the staking pool" half of Graduate. Trivially true
/// when the launch never opted into staking (staking_enabled == False),
/// same "0 means nothing to check" convention as lp_reserve_tokens would
/// use if it were ever optional.
fn staking_seeding_output_ok(self: Transaction, datum: BondingCurveDatum) -> Bool {
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

validator bonding_curve {
  spend(
    datum_opt: Option<BondingCurveDatum>,
    redeemer: BondingCurveRedeemer,
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
          interval.contains(self.validity_range, current_timestamp),
          new_datum == BondingCurveDatum {
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
        let prior_purchases = cumulative_purchases(datum.per_address_purchases, buyer_key_hash)
        let new_total_purchases = prior_purchases + token_amount
        let new_tokens_sold = datum.tokens_sold + token_amount
        let next_state = if new_tokens_sold == datum.curve_supply {
          Graduated
        } else {
          datum.curve_state
        }
        let expected_datum =
          BondingCurveDatum {
            ..datum,
            tokens_sold: new_tokens_sold,
            total_raised: datum.total_raised + net_payment,
            creator_fees_accrued: datum.creator_fees_accrued + claimed_creator_fee,
            treasury_fees_accrued: datum.treasury_fees_accrued + claimed_treasury_fee,
            ops_fees_accrued: datum.ops_fees_accrued + claimed_ops_fee,
            per_address_purchases: update_purchases(
              datum.per_address_purchases,
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
          // T32 fix: buyer_key_hash was previously self-reported in the
          // redeemer with no cryptographic binding to who actually signed
          // the tx — matching Tier B's bonding_curve_tier_b.ak, which
          // already had this check. Without it, the creator-block below is
          // not sufficient on its own and the
          // wallet cap itself is theatrical (claim a fresh hash every buy).
          list.has(self.extra_signatories, buyer_key_hash),
          // T32: creator cannot wash-trade their own public bonding curve.
          buyer_key_hash != datum.creator_pub_key_hash,
          new_datum == expected_datum,
          token_delivered(self, datum, token_amount),
          payment_received(self, own_ref, gross_payment),
          // Bonus fix (found while designing T49): the curve's own reserve
          // must actually shrink by token_amount, not just "some output"
          // claim to hold it.
          curve_token_balance_decreased(self, own_ref, datum, token_amount),
          // T81: the curve's own continuing output can't be padded with
          // junk assets — this UTXO is reused by every future buy.
          curve_own_output_clean(self, own_ref),
        }
      }

      SellTokens {
        token_amount,
        claimed_price,
        gross_proceeds,
        claimed_creator_fee,
        claimed_treasury_fee,
        claimed_ops_fee,
        seller_key_hash,
      } -> {
        let new_sold = datum.tokens_sold - token_amount
        let fee_total = claimed_creator_fee + claimed_treasury_fee + claimed_ops_fee
        let net_proceeds = gross_proceeds - fee_total
        let prior_purchases = cumulative_purchases(datum.per_address_purchases, seller_key_hash)
        let new_total_purchases = prior_purchases - token_amount
        let expected_datum =
          BondingCurveDatum {
            ..datum,
            tokens_sold: new_sold,
            // T106: subtract the FULL gross_proceeds (not net_proceeds) —
            // see this redeemer's own doc comment in BondingCurveRedeemer
            // above for the invariant this preserves.
            total_raised: datum.total_raised - gross_proceeds,
            creator_fees_accrued: datum.creator_fees_accrued + claimed_creator_fee,
            treasury_fees_accrued: datum.treasury_fees_accrued + claimed_treasury_fee,
            ops_fees_accrued: datum.ops_fees_accrued + claimed_ops_fee,
            per_address_purchases: update_purchases(
              datum.per_address_purchases,
              seller_key_hash,
              new_total_purchases,
            ),
          }
        let new_datum = own_continuing_datum(self, own_ref)

        and {
          datum.curve_state == Active,
          token_amount > 0,
          new_sold >= 0,
          // Can only sell back what this wallet is tracked as having
          // bought via THIS contract — see the redeemer's own doc comment
          // for why (also what makes an explicit creator-block redundant
          // here, unlike BuyTokens's explicit T32 check).
          token_amount <= prior_purchases,
          // NOTE: deliberately no `gross_proceeds <= datum.total_raised`
          // guard here — an earlier draft had one, reasoning "don't let
          // total_raised go negative," but tracing a concrete symmetric
          // round-trip (buy 10 at sold=0, immediately sell the same 10
          // back to sold=0) through the numbers showed total_raised going
          // negative by exactly the ORIGINAL buy's fee_total is the
          // CORRECT, expected outcome, not a bug: the SUM invariant
          // (total_raised + 3 accumulators == curve's real lovelace above
          // its base) holds exactly regardless of total_raised's
          // individual sign, because fee_total on both the buy and the
          // sell always lands in the accumulators, never lost. A guard
          // here would have rejected legitimate round-trip sells — the
          // exact transactions this feature exists for. total_raised
          // going negative only means Graduate can't succeed until enough
          // net buying brings it positive again (checked by
          // graduation_funds_left_curve's own real-value-movement
          // requirement) — never a fund-safety issue, since
          // lovelace_paid_from_curve already makes it physically
          // impossible to pay out more real ADA than the curve holds.
          verify_price(datum, new_sold, claimed_price),
          claimed_price * token_amount == gross_proceeds,
          gross_proceeds > fee_total,
          verify_fee_slice(gross_proceeds, creator_bps, claimed_creator_fee),
          verify_fee_slice(gross_proceeds, treasury_bps, claimed_treasury_fee),
          verify_fee_slice(gross_proceeds, ops_bps, claimed_ops_fee),
          list.has(self.extra_signatories, seller_key_hash),
          new_datum == expected_datum,
          tokens_returned_to_curve(self, own_ref, datum, token_amount),
          lovelace_paid_from_curve(self, own_ref, seller_key_hash, net_proceeds),
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
        // T107: the curve's own balance moves in TWO directions in the
        // same transaction — `amount` leaves (paid to the claimer),
        // `platform_claim_fee` arrives (paid by the claimer) — a
        // different shape from lovelace_paid_from_curve's single-direction
        // check, so verified directly here rather than via that helper.
        let curve_balance_net_ok =
          assets.lovelace_of(own_output.value) == assets.lovelace_of(own_input.output.value) - amount + platform_claim_fee
        // T93/T115 fix (2026-07-22): same payment-credential-only fix as
        // lovelace_paid_from_curve above — this redeemer has its own
        // separate recipient check (not routed through that helper, since
        // it's a two-directional balance check), so needed the identical
        // fix applied here independently.
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
          new_datum == BondingCurveDatum {
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
          new_datum == BondingCurveDatum {
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
          new_datum == BondingCurveDatum {
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
          new_datum == BondingCurveDatum { ..datum, curve_state: Cancelled },
        }
      }

      ExpireCurve { current_timestamp } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          datum.curve_state == Active,
          interval.contains(self.validity_range, current_timestamp),
          // T90: bound the declared validity range's own width — see this
          // file's own `validity_range_is_narrow` comment for why.
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          current_timestamp > datum.activated_at + max_curve_duration,
          new_datum == BondingCurveDatum { ..datum, curve_state: Cancelled },
        }
      }

      ClaimBuyback { token_amount, buyer_key_hash } -> {
        // T111 fix (2026-07-19, full-suite security audit): total_raised
        // can legitimately go negative after enough SellTokens (T106)
        // round-trip activity — see that redeemer's own doc comment for
        // why this is a correct, not buggy, outcome. Left unguarded here,
        // a negative total_raised produced a negative `share`, which
        // inverted this redeemer's own value-conservation checks (the
        // curve would need to INCREASE, not decrease, and "buyer_paid >=
        // negative_number" became trivially true for any output) —
        // breaking this redeemer's whole pro-rata-refund guarantee for
        // every legitimate holder on a curve that saw heavy net selling
        // before being cancelled. Flooring at 0 means: once total_raised
        // is non-positive, there is genuinely no stranded PRINCIPAL left
        // to redistribute this way (any real remaining value has already
        // been reclassified into the fee accumulators via SellTokens'
        // own accounting) — a real, defensible outcome, not a workaround.
        let effective_total_raised = if datum.total_raised > 0 {
          datum.total_raised
        } else {
          0
        }
        // Pro-rata share of the stranded principal, computed with real
        // division (Aiken's Int is arbitrary-precision) — no caller-
        // supplied claim to verify, unlike the Compact-side circuits.
        let share = effective_total_raised * token_amount / datum.tokens_sold
        let new_datum =
          BondingCurveDatum {
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
          tokens_returned_to_curve(self, own_ref, datum, token_amount),
          lovelace_paid_from_curve(self, own_ref, buyer_key_hash, share),
        }
      }

      Graduate -> {
        let new_datum = own_continuing_datum(self, own_ref)
        let expected_datum =
          BondingCurveDatum {
            ..datum,
            total_raised: 0,
            lp_seeded: True,
            staking_seeded: True,
          }
        and {
          datum.curve_state == Graduated,
          !datum.lp_seeded,
          !datum.staking_seeded,
          // T111 fix (2026-07-19, full-suite security audit): a curve can
          // reach tokens_sold == curve_supply (Graduated) while
          // total_raised is non-positive, if enough SellTokens (T106)
          // activity happened before the final buy that pushed it to
          // 100%. Left unguarded, Graduate could succeed with
          // total_raised <= 0 — graduation_funds_left_curve's own check
          // degrades to "curve doesn't decrease" (trivially true at 0) and
          // lp_seeding_output_ok's lovelace requirement becomes `>= a
          // non-positive number` (trivially satisfiable by any real
          // output) — producing a real, "Graduated"-labeled launch with a
          // ZERO-ADA-backed, permanently-locked-for-365-days LP position.
          // Unlike ClaimBuyback (where flooring the share at 0 is a
          // legitimate outcome — nothing stranded, nothing owed), silently
          // graduating with a worthless LP would misrepresent what
          // actually happened to anyone trusting the Graduated status or
          // certificate — better to require real, positive backing before
          // this redeemer can ever succeed.
          datum.total_raised > 0,
          graduation_funds_left_curve(self, own_ref, datum, datum.total_raised),
          lp_seeding_output_ok(self, datum, datum.total_raised),
          staking_seeding_output_ok(self, datum),
          // T81: the curve's own post-graduation output, and the two new
          // genesis outputs it creates, can't be padded with junk assets.
          curve_own_output_clean(self, own_ref),
        }
      }

      TriggerCTO { community_pub_key_hash } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          // T-CTO-ENFORCE: permissionless, gated on real anchored vote
          // evidence instead of a bare governor signature — see
          // cto_vote_verified's own doc comment for the full reasoning.
          cto_vote_verified(
            self,
            datum,
            SilenceLockTrigger,
            Some(community_pub_key_hash),
          ),
          !datum.cto_triggered,
          community_pub_key_hash != #"",
          new_datum == BondingCurveDatum {
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
          // DissolveCTOProposal instead of a bare governor signature. No
          // recipient to check — see cto_vote_verified's own doc comment
          // for why that field isn't meaningful for this proposal type.
          cto_vote_verified(self, datum, DissolveCTOProposal, None),
          datum.cto_triggered,
          new_datum == BondingCurveDatum {
            ..datum,
            cto_triggered: False,
            community_pub_key_hash: #"",
          },
        }
      }

      // T109 CRITICAL fix (2026-07-19, full-suite security audit): this was
      // previously `True` — an unconditional pass with ZERO checks. Any
      // transaction spending this UTXO with redeemer=QueryState was fully
      // authorized regardless of what it did with the curve's real value —
      // an unconditional authorization, which must never be possible (buyers' principal, all 3
      // fee accumulators, the LP/staking reserves) reachable by anyone, on
      // every deployed Tier A launch. QueryState was always DOCUMENTED as
      // "off-chain callers should read the datum directly rather than
      // spend through this redeemer" — the redeemer variant exists so
      // off-chain tooling can reference it as a value, but it must never
      // actually authorize spending. `False` closes this without removing
      // the variant (avoids a wider blast-radius rename across every
      // off-chain caller).
      QueryState -> False
      },
    }
  }
}

// ============================================================================
// TESTS
// ============================================================================

fn mock_datum(curve_state: CurveState, tokens_sold: Int) -> BondingCurveDatum {
  BondingCurveDatum {
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
    per_address_purchases: [],
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
    // C-1 fix: mock governance thread NFT policy — matches the NFT placed in
    // the cto_governance reference input's value in the CTO-vote tests below.
    cto_governance_nft: #"c0ffee",
  }
}

test verify_price_at_zero_sold() {
  verify_price(mock_datum(Active, 0), 0, 100)
}

test verify_price_at_full_sold() {
  verify_price(mock_datum(Active, 1000), 1000, 1000)
}

test verify_price_at_half_sold() {
  // base=100, max=1000, range=900, at 500/1000 sold: price = 100 + 900*500/1000 = 550
  verify_price(mock_datum(Active, 500), 500, 550)
}

test verify_price_rejects_wrong_price() {
  !verify_price(mock_datum(Active, 500), 500, 999)
}

test verify_fee_slice_creator_1pct() {
  verify_fee_slice(100_000, creator_bps, 1_000)
}

test verify_fee_slice_treasury_0_6pct() {
  verify_fee_slice(100_000, treasury_bps, 600)
}

test verify_fee_slice_ops_0_4pct() {
  verify_fee_slice(100_000, ops_bps, 400)
}

test verify_fee_slice_rejects_wrong_amount() {
  !verify_fee_slice(100_000, creator_bps, 999)
}

test cumulative_purchases_empty_list() {
  cumulative_purchases([], #"aa") == 0
}

test cumulative_purchases_finds_existing() {
  let purchases = [(#"aa", 10), (#"bb", 20)]
  cumulative_purchases(purchases, #"bb") == 20
}

test cumulative_purchases_missing_is_zero() {
  cumulative_purchases([(#"aa", 10)], #"cc") == 0
}

test update_purchases_inserts_new_entry() {
  update_purchases([], #"aa", 10) == [(#"aa", 10)]
}

test update_purchases_updates_existing_entry() {
  let purchases = [(#"aa", 10), (#"bb", 20)]
  update_purchases(purchases, #"aa", 15) == [(#"aa", 15), (#"bb", 20)]
}

test activate_curve_succeeds_with_governor_signature() {
  let datum = mock_datum(Inactive, 0)
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
    BondingCurveDatum { ..datum, curve_state: Active, activated_at: 500 }
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

  bonding_curve.spend(
    Some(datum),
    ActivateCurve { current_timestamp: 500 },
    own_ref,
    self,
  )
}

test activate_curve_fails_without_governor_signature() {
  let datum = mock_datum(Inactive, 0)
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
    BondingCurveDatum { ..datum, curve_state: Active, activated_at: 500 }
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
      validity_range: interval.between(400, 600),
      // no extra_signatories — governor never signed
    }

  !bonding_curve.spend(
    Some(datum),
    ActivateCurve { current_timestamp: 500 },
    own_ref,
    self,
  )
}

test expire_curve_succeeds_after_deadline_with_no_signature() {
  let datum = BondingCurveDatum { ..mock_datum(Active, 100), activated_at: 0 }
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
  let new_datum = BondingCurveDatum { ..datum, curve_state: Cancelled }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.zero,
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // T87: one ms past the 90-day (7_776_000_000ms) deadline from activated_at: 0
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
      // deliberately no extra_signatories — ExpireCurve is permissionless
    }

  bonding_curve.spend(
    Some(datum),
    ExpireCurve { current_timestamp: past_deadline },
    own_ref,
    self,
  )
}

// T90: identical to expire_curve_succeeds_after_deadline_with_no_signature
// except the declared validity range is far wider than
// max_validity_range_width (600_000ms) — before this fix, ANY caller could
// force-expire a curve immediately after activation by simply declaring a
// wide range and claiming a timestamp near its far end, since
// interval.contains alone never checked how wide the caller's OWN declared
// range was.
test expire_curve_rejects_wide_validity_range() {
  let datum = BondingCurveDatum { ..mock_datum(Active, 100), activated_at: 0 }
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
  let new_datum = BondingCurveDatum { ..datum, curve_state: Cancelled }
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
      // Real activation was just now (0); a real, honest ExpireCurve tx
      // would declare a narrow range near 0. This one instead spans all
      // the way out to past_deadline, comfortably exceeding
      // max_validity_range_width, to claim current_timestamp is already
      // past the real 90-day deadline when it isn't.
      validity_range: interval.between(0, past_deadline + 100),
    }

  !bonding_curve.spend(
    Some(datum),
    ExpireCurve { current_timestamp: past_deadline },
    own_ref,
    self,
  )
}

test expire_curve_rejects_before_deadline() {
  let datum = BondingCurveDatum { ..mock_datum(Active, 100), activated_at: 0 }
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
  let new_datum = BondingCurveDatum { ..datum, curve_state: Cancelled }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.zero,
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // T87: one ms BEFORE the 90-day (7_776_000_000ms) deadline — should be rejected
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

  !bonding_curve.spend(
    Some(datum),
    ExpireCurve { current_timestamp: before_deadline },
    own_ref,
    self,
  )
}

test expire_curve_rejects_already_graduated_curve() {
  // Fully sold-through curve is Graduated, not Active — ExpireCurve should
  // never be usable to retroactively cancel a successful launch.
  let datum =
    BondingCurveDatum { ..mock_datum(Graduated, 1000), activated_at: 0 }
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
  let new_datum = BondingCurveDatum { ..datum, curve_state: Cancelled }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.zero,
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // T87: ms-scale, matches max_curve_duration's real unit
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

  !bonding_curve.spend(
    Some(datum),
    ExpireCurve { current_timestamp: past_deadline },
    own_ref,
    self,
  )
}

test buy_tokens_succeeds_with_correct_price_and_fees() {
  let datum = mock_datum(Active, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(#"dd")
  // Base lovelace already held by the curve UTXO (min-UTXO + whatever's
  // been raised so far) — payment_received checks the continuing output
  // holds exactly this much MORE, so both inputs need a real starting value.
  // Curve also holds its full curve_supply (1000) of the launch token at
  // the start — curve_token_balance_decreased checks this shrinks by
  // exactly token_amount on every buy.
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
  // At sold=0, price=base_price=100. Buying 10 tokens: gross = 1000.
  // Fees: creator 1.0% = 10, treasury 0.6% = 6, ops 0.4% = 4. Net = 980.
  let new_datum =
    BondingCurveDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 980,
      creator_fees_accrued: 10,
      treasury_fees_accrued: 6,
      ops_fees_accrued: 4,
      per_address_purchases: [(#"dd", 10)],
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

  bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test buy_tokens_rejects_padded_continuing_output() {
  // T81: everything about this buy is otherwise correct (price, fees,
  // token delivery, datum update, real payment) — the only difference
  // from buy_tokens_succeeds_with_correct_price_and_fees is a THIRD,
  // unrelated junk asset stuffed into the curve's own continuing output.
  // Before the T81 fix, output_value_clean didn't exist and this would
  // have been accepted — a buyer could pad the curve's reused UTXO with
  // spam assets, degrading every subsequent buyer.
  let datum = mock_datum(Active, 0)
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
    BondingCurveDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 980,
      creator_fees_accrued: 10,
      treasury_fees_accrued: 6,
      ops_fees_accrued: 4,
      per_address_purchases: [(#"dd", 10)],
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

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test buy_tokens_rejects_payment_not_actually_received() {
  // T40 fix regression: everything else about this buy is correct (price,
  // fees, token delivery, datum update) — only the continuing output's
  // lovelace value is unchanged, i.e. the buyer never actually paid the
  // claimed gross_payment. Before this fix, this transaction would have
  // been accepted.
  let datum = mock_datum(Active, 0)
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
    BondingCurveDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 980,
      creator_fees_accrued: 10,
      treasury_fees_accrued: 6,
      ops_fees_accrued: 4,
      per_address_purchases: [(#"dd", 10)],
    }
  let continuing_output =
    Output {
      address: own_address,
      // No increase at all — claims to have received 1000 lovelace but didn't.
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

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test buy_tokens_rejects_underpayment() {
  // Buyer pays 999 lovelace instead of the claimed 1000 — a subtler
  // version of the same gap, proving the check is an exact equality, not
  // just "some positive amount arrived."
  let datum = mock_datum(Active, 0)
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
    BondingCurveDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 980,
      creator_fees_accrued: 10,
      treasury_fees_accrued: 6,
      ops_fees_accrued: 4,
      per_address_purchases: [(#"dd", 10)],
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace + 999),
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

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test buy_tokens_rejects_missing_token_delivery() {
  let datum = mock_datum(Active, 0)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
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
    BondingCurveDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 980,
      creator_fees_accrued: 10,
      treasury_fees_accrued: 6,
      ops_fees_accrued: 4,
      per_address_purchases: [(#"dd", 10)],
    }
  let continuing_output =
    Output {
      address: own_address,
      // Payment IS correctly received here, and the curve's own balance
      // correctly shrinks — isolates this test to exactly one failure
      // cause (missing external delivery), not several.
      value: assets.merge(
        assets.from_lovelace(base_lovelace + 1000),
        assets.from_asset(#"33", "tok", 990),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // No delivery output to the buyer at all this time.
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
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

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test buy_tokens_rejects_tokens_not_sourced_from_curve_reserve() {
  // Bonus fix regression test (found while designing T49): the buyer
  // receives 10 tokens (token_delivered passes) but the curve's own
  // reserve never shrinks — as if the buyer supplied their own tokens as
  // "proof of delivery" instead of the curve's reserve actually paying out.
  // Before this fix, this transaction would have been accepted, letting
  // tokens_sold (and therefore Graduated) advance without any real
  // depletion of the curve's reserve.
  let datum = mock_datum(Active, 0)
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
    BondingCurveDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 980,
      creator_fees_accrued: 10,
      treasury_fees_accrued: 6,
      ops_fees_accrued: 4,
      per_address_purchases: [(#"dd", 10)],
    }
  let continuing_output =
    Output {
      address: own_address,
      // Payment IS correctly received — curve's token balance is
      // UNCHANGED (still 1000), not decreased to 990.
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

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test buy_tokens_rejects_unauthenticated_buyer_key_hash() {
  // T32 fix regression: everything else about this buy is correct (price,
  // fees, payment, delivery) — but nobody signed as #"dd", so the redeemer's
  // buyer_key_hash is just an unverified claim. Before this fix, this
  // transaction would have been accepted, making the wallet cap trivially
  // bypassable (claim a fresh hash every time) and the creator-block below
  // meaningless (claim a different hash while still being the real signer).
  let datum = mock_datum(Active, 0)
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
    BondingCurveDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 980,
      creator_fees_accrued: 10,
      treasury_fees_accrued: 6,
      ops_fees_accrued: 4,
      per_address_purchases: [(#"dd", 10)],
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
      // deliberately no extra_signatories — buyer_key_hash #"dd" is unsigned
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

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test buy_tokens_rejects_creator_buying_own_curve() {
  let datum = mock_datum(Active, 0)
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
    BondingCurveDatum {
      ..datum,
      tokens_sold: 10,
      total_raised: 980,
      creator_fees_accrued: 10,
      treasury_fees_accrued: 6,
      ops_fees_accrued: 4,
      // mock_datum's creator_pub_key_hash is #"11"
      per_address_purchases: [(#"11", 10)],
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
      // creator-identity check, not the T32 signature-authentication fix
      // above (which would also reject an unsigned #"11").
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

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

// ----------------------------------------------------------------------------
// SellTokens (T106)
// ----------------------------------------------------------------------------

/// Shared starting state for the SellTokens tests: wallet #"dd" already
/// bought 10 tokens at sold=0 (mirrors buy_tokens_succeeds_with_correct_
/// price_and_fees's own resulting state exactly), so selling them back is
/// a real, traceable round trip.
fn sold_state_datum() -> BondingCurveDatum {
  BondingCurveDatum {
    ..mock_datum(Active, 10),
    total_raised: 980,
    creator_fees_accrued: 10,
    treasury_fees_accrued: 6,
    ops_fees_accrued: 4,
    per_address_purchases: [(#"dd", 10)],
  }
}

test sell_tokens_succeeds_symmetric_round_trip() {
  // Selling all 10 tokens back to sold=0 prices at new_sold=0 — the SAME
  // spot price (100) the original buy used, by design (see this
  // redeemer's own doc comment). gross_proceeds = 100*10 = 1000, fee_total
  // = 20 (10/6/4), net_proceeds = 980 paid to the seller.
  let datum = sold_state_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let seller_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace + 1000),
          assets.from_asset(#"33", "tok", 990),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      tokens_sold: 0,
      // 980 - 1000 = -20 — see the redeemer's own inline comment for why
      // this is the correct outcome, not a bug.
      total_raised: -20,
      creator_fees_accrued: 20,
      treasury_fees_accrued: 12,
      ops_fees_accrued: 8,
      per_address_purchases: [(#"dd", 0)],
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace + 1000 - 980),
        assets.from_asset(#"33", "tok", 1000),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let proceeds_output =
    Output {
      address: seller_address,
      value: assets.from_lovelace(980),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, proceeds_output],
      extra_signatories: [#"dd"],
    }
  let redeemer =
    SellTokens {
      token_amount: 10,
      claimed_price: 100,
      gross_proceeds: 1000,
      claimed_creator_fee: 10,
      claimed_treasury_fee: 6,
      claimed_ops_fee: 4,
      seller_key_hash: #"dd",
    }

  bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test sell_tokens_rejects_selling_more_than_ever_bought() {
  let datum = sold_state_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let seller_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace + 1000),
          assets.from_asset(#"33", "tok", 990),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  // Wallet #"dd" only ever bought 10 (per sold_state_datum) — attempting
  // to sell 11 (as though tokens were topped up via a secondary transfer)
  // must be rejected, per this redeemer's own documented scope limit.
  let new_datum =
    BondingCurveDatum {
      ..datum,
      tokens_sold: -1,
      total_raised: -120,
      creator_fees_accrued: 21,
      treasury_fees_accrued: 12,
      ops_fees_accrued: 8,
      per_address_purchases: [(#"dd", -1)],
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace + 1000 - 1078),
        assets.from_asset(#"33", "tok", 1001),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let proceeds_output =
    Output {
      address: seller_address,
      value: assets.from_lovelace(1078),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, proceeds_output],
      extra_signatories: [#"dd"],
    }
  let redeemer =
    SellTokens {
      token_amount: 11,
      claimed_price: 110,
      gross_proceeds: 1210,
      claimed_creator_fee: 13,
      claimed_treasury_fee: 7,
      claimed_ops_fee: 5,
      seller_key_hash: #"dd",
    }

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test sell_tokens_rejects_creator_selling_own_curve() {
  // The creator is permanently blocked from BuyTokens (T32), so their
  // tracked per_address_purchases total is always 0 — sell_tokens_rejects_
  // selling_more_than_ever_bought's own logic (token_amount <=
  // prior_purchases) already covers this with no separate check needed.
  // This test confirms that fallout is real, not just theorized.
  let datum = mock_datum(Active, 10)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let creator_address = from_verification_key(#"11")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(5_000_000),
          assets.from_asset(#"33", "tok", 990),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum = BondingCurveDatum { ..datum, tokens_sold: 0 }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(5_000_000 - 980),
        assets.from_asset(#"33", "tok", 1000),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let proceeds_output =
    Output {
      address: creator_address,
      value: assets.from_lovelace(980),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, proceeds_output],
      extra_signatories: [#"11"],
    }
  let redeemer =
    SellTokens {
      token_amount: 10,
      claimed_price: 100,
      gross_proceeds: 1000,
      claimed_creator_fee: 10,
      claimed_treasury_fee: 6,
      claimed_ops_fee: 4,
      seller_key_hash: #"11",
    }

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test sell_tokens_rejects_unauthenticated_seller_key_hash() {
  let datum = sold_state_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let seller_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace + 1000),
          assets.from_asset(#"33", "tok", 990),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      tokens_sold: 0,
      total_raised: -20,
      creator_fees_accrued: 20,
      treasury_fees_accrued: 12,
      ops_fees_accrued: 8,
      per_address_purchases: [(#"dd", 0)],
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace + 20),
        assets.from_asset(#"33", "tok", 1000),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let proceeds_output =
    Output {
      address: seller_address,
      value: assets.from_lovelace(980),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, proceeds_output],
      // No extra_signatories at all — #"dd" never actually signed.
    }
  let redeemer =
    SellTokens {
      token_amount: 10,
      claimed_price: 100,
      gross_proceeds: 1000,
      claimed_creator_fee: 10,
      claimed_treasury_fee: 6,
      claimed_ops_fee: 4,
      seller_key_hash: #"dd",
    }

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test sell_tokens_rejects_wrong_price() {
  let datum = sold_state_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let seller_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace + 1000),
          assets.from_asset(#"33", "tok", 990),
        ),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      tokens_sold: 0,
      total_raised: 820,
      // Wrongly claims price=1000 (max_price, the sold=1000 spot) instead
      // of the correct price=100 at new_sold=0.
      creator_fees_accrued: 110,
      treasury_fees_accrued: 66,
      ops_fees_accrued: 44,
      per_address_purchases: [(#"dd", 0)],
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace + 1000 - 9800),
        assets.from_asset(#"33", "tok", 1000),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let proceeds_output =
    Output {
      address: seller_address,
      value: assets.from_lovelace(9800),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, proceeds_output],
      extra_signatories: [#"dd"],
    }
  let redeemer =
    SellTokens {
      token_amount: 10,
      claimed_price: 1000,
      gross_proceeds: 10_000,
      claimed_creator_fee: 100,
      claimed_treasury_fee: 60,
      claimed_ops_fee: 40,
      seller_key_hash: #"dd",
    }

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

// ----------------------------------------------------------------------------
// T-CTO-ENFORCE: TriggerCTO/DissolveCTO gated on real anchored vote
// evidence (reference input into cto_governance.ak) instead of a bare
// governor signature + redirected ClaimCreatorFees
// ----------------------------------------------------------------------------

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
      // C-1 fix: the genuine governance UTXO carries its per-launch thread
      // NFT (policy = the curve datum's cto_governance_nft `#"c0ffee"`,
      // asset_name = launch_id). cto_vote_verified now requires it.
      value: assets.from_asset(#"c0ffee", cto_datum.launch_id, 1),
      datum: InlineDatum(cto_datum),
      reference_script: None,
    },
  }
}

test trigger_cto_succeeds_with_real_anchored_vote() {
  let cto_address = from_verification_key(#"aa")
  let cto_credential = cto_address.payment_credential
  let datum =
    BondingCurveDatum { ..mock_datum(Active, 0), cto_governance_credential: cto_credential }
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
    BondingCurveDatum {
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

  bonding_curve.spend(
    Some(datum),
    TriggerCTO { community_pub_key_hash: #"ee" },
    own_ref,
    self,
  )
}

// C-1 regression (2026-07-23 audit): a UTXO planted at
// cto_governance_credential with a fully forged "Passed / Executed,
// recipient = attacker" datum but WITHOUT the genuine governance thread NFT
// must NOT satisfy cto_vote_verified — this is the exact free forgery the
// C-1 fix closes (paying to a script address never runs its validator, and
// a reference input is never spent). Identical to
// trigger_cto_succeeds_with_real_anchored_vote except the reference input's
// value carries no NFT, so quantity_of(...) == 1 is False and the spend
// cleanly returns False (the ref input exists; it just lacks the NFT — no
// panic, so a plain `!spend(...)` assertion suffices).
test trigger_cto_rejects_forged_governance_utxo_without_nft() {
  let cto_address = from_verification_key(#"aa")
  let cto_credential = cto_address.payment_credential
  let datum =
    BondingCurveDatum { ..mock_datum(Active, 0), cto_governance_credential: cto_credential }
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
    BondingCurveDatum { ..datum, cto_triggered: True, community_pub_key_hash: #"ee" }
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
  // FORGED: same governance address, a fully "passed" datum naming the
  // attacker as recipient — but the UTXO does NOT hold the thread NFT.
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

  !bonding_curve.spend(
    Some(datum),
    TriggerCTO { community_pub_key_hash: #"ee" },
    own_ref,
    self,
  )
}

// T-CTO-ENFORCE: cto_vote_verified's `expect Some(cto_ref_input) = ...`
// panics (rather than returning False) when no matching reference input
// exists — Aiken's `expect` semantics, not a graceful pattern match. A
// `!spend(...)` assertion can't observe a panic, only a clean False, so
// this needs the `fail` test annotation instead (same real pattern already
// used by lp_escrow.ak's execute_dex_change_rejects_with_no_pending_change).
test trigger_cto_rejects_without_reference_input() fail {
  let cto_address = from_verification_key(#"aa")
  let cto_credential = cto_address.payment_credential
  let datum =
    BondingCurveDatum { ..mock_datum(Active, 0), cto_governance_credential: cto_credential }
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
    BondingCurveDatum {
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
      // no reference_inputs at all — no evidence a vote ever happened,
      // and (T-CTO-ENFORCE) a bare governor signature is no longer
      // sufficient on its own either.
      extra_signatories: [#"22"],
    }

  bonding_curve.spend(
    Some(datum),
    TriggerCTO { community_pub_key_hash: #"ee" },
    own_ref,
    self,
  )
}

test trigger_cto_rejects_wrong_recipient() {
  let cto_address = from_verification_key(#"aa")
  let cto_credential = cto_address.payment_credential
  let datum =
    BondingCurveDatum { ..mock_datum(Active, 0), cto_governance_credential: cto_credential }
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
    BondingCurveDatum {
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
  // Real anchored vote exists, but it named a DIFFERENT recipient (#"ff")
  // than what this TriggerCTO call is trying to install (#"ee") — a
  // malicious relayer/governor can't redirect a legitimately-passed vote
  // to an address the community never actually voted for.
  let executed_proposal =
    mock_proposal_anchor(SilenceLockTrigger, Passed, Executed, #"ff")
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

  !bonding_curve.spend(
    Some(datum),
    TriggerCTO { community_pub_key_hash: #"ee" },
    own_ref,
    self,
  )
}

test trigger_cto_rejects_wrong_launch_id() {
  let cto_address = from_verification_key(#"aa")
  let cto_credential = cto_address.payment_credential
  let datum =
    BondingCurveDatum { ..mock_datum(Active, 0), cto_governance_credential: cto_credential }
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
    BondingCurveDatum {
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
  // Real, valid, passed+executed vote — but anchored for a DIFFERENT
  // launch. A shared cto_governance.ak address serves every launch on the
  // platform, so a launch_id mismatch must be rejected, not just a
  // missing reference input entirely.
  let executed_proposal =
    mock_proposal_anchor(SilenceLockTrigger, Passed, Executed, #"ee")
  let cto_datum =
    mock_cto_governance_datum(#"99", Some(executed_proposal))
  let cto_ref_input = mock_cto_ref_input(cto_address, cto_datum)
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [cto_ref_input],
      outputs: [continuing_output],
    }

  !bonding_curve.spend(
    Some(datum),
    TriggerCTO { community_pub_key_hash: #"ee" },
    own_ref,
    self,
  )
}

test trigger_cto_rejects_if_already_triggered() {
  let cto_address = from_verification_key(#"aa")
  let cto_credential = cto_address.payment_credential
  let datum =
    BondingCurveDatum {
      ..mock_datum(Active, 0),
      cto_governance_credential: cto_credential,
      cto_triggered: True,
      community_pub_key_hash: #"ee",
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
    BondingCurveDatum { ..datum, community_pub_key_hash: #"ff" }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.zero,
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let executed_proposal =
    mock_proposal_anchor(SilenceLockTrigger, Passed, Executed, #"ff")
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

  !bonding_curve.spend(
    Some(datum),
    TriggerCTO { community_pub_key_hash: #"ff" },
    own_ref,
    self,
  )
}

test dissolve_cto_succeeds_with_real_anchored_vote() {
  let cto_address = from_verification_key(#"aa")
  let cto_credential = cto_address.payment_credential
  let datum =
    BondingCurveDatum {
      ..mock_datum(Active, 0),
      cto_governance_credential: cto_credential,
      cto_triggered: True,
      community_pub_key_hash: #"ee",
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
    BondingCurveDatum {
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

  bonding_curve.spend(Some(datum), DissolveCTO, own_ref, self)
}

// T-CTO-ENFORCE: same `fail`-annotation reasoning as
// trigger_cto_rejects_without_reference_input above.
test dissolve_cto_rejects_without_reference_input() fail {
  let cto_address = from_verification_key(#"aa")
  let cto_credential = cto_address.payment_credential
  let datum =
    BondingCurveDatum {
      ..mock_datum(Active, 0),
      cto_governance_credential: cto_credential,
      cto_triggered: True,
      community_pub_key_hash: #"ee",
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
    BondingCurveDatum {
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
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"22"],
    }

  bonding_curve.spend(Some(datum), DissolveCTO, own_ref, self)
}

test dissolve_cto_rejects_if_not_triggered() {
  let cto_address = from_verification_key(#"aa")
  let cto_credential = cto_address.payment_credential
  let datum =
    BondingCurveDatum { ..mock_datum(Active, 0), cto_governance_credential: cto_credential }
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
    BondingCurveDatum {
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

  !bonding_curve.spend(Some(datum), DissolveCTO, own_ref, self)
}

/// T107: shared shape for the ClaimCreatorFees success-path tests below —
/// curve holds 1,000,000 lovelace going in; claimer takes `amount` (200)
/// out and pays `platform_claim_fee` (exactly the floor, 200,000) in, so
/// the curve's continuing output must show 1,000,000 - 200 + 200,000 =
/// 1,199,800.
fn claim_creator_fees_tx(
  datum: BondingCurveDatum,
  new_datum: BondingCurveDatum,
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

test claim_creator_fees_succeeds_via_creator_when_no_cto() {
  let datum = BondingCurveDatum { ..mock_datum(Active, 0), creator_fees_accrued: 500 }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      creator_fees_accrued: 300,
      treasury_fees_accrued: 120_000,
      ops_fees_accrued: 80_000,
    }
  let (own_ref, self) = claim_creator_fees_tx(datum, new_datum, #"11", #"11")

  bonding_curve.spend(
    Some(datum),
    ClaimCreatorFees { amount: 200, platform_claim_fee: 200_000 },
    own_ref,
    self,
  )
}

test claim_creator_fees_rejects_creator_once_cto_triggered() {
  // The exact gap this fix closes: before it, the creator could keep
  // claiming bonding-curve fees regardless of a passed CTO vote, since this
  // contract had no CTO concept at all.
  let datum =
    BondingCurveDatum {
      ..mock_datum(Active, 0),
      creator_fees_accrued: 500,
      cto_triggered: True,
      community_pub_key_hash: #"ee",
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      creator_fees_accrued: 300,
      treasury_fees_accrued: 120_000,
      ops_fees_accrued: 80_000,
    }
  // Original creator (#"11") signs, not the community wallet — must now be
  // rejected.
  let (own_ref, self) = claim_creator_fees_tx(datum, new_datum, #"11", #"11")

  !bonding_curve.spend(
    Some(datum),
    ClaimCreatorFees { amount: 200, platform_claim_fee: 200_000 },
    own_ref,
    self,
  )
}

test claim_creator_fees_succeeds_via_community_wallet_once_cto_triggered() {
  let datum =
    BondingCurveDatum {
      ..mock_datum(Active, 0),
      creator_fees_accrued: 500,
      cto_triggered: True,
      community_pub_key_hash: #"ee",
    }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      creator_fees_accrued: 300,
      treasury_fees_accrued: 120_000,
      ops_fees_accrued: 80_000,
    }
  let (own_ref, self) = claim_creator_fees_tx(datum, new_datum, #"ee", #"ee")

  bonding_curve.spend(
    Some(datum),
    ClaimCreatorFees { amount: 200, platform_claim_fee: 200_000 },
    own_ref,
    self,
  )
}

// Value-conservation requirement identified in the pre-test security review
// describes — draining far more than `amount` while the datum shows only a
// small decrement. Same setup as the success case, except the continuing
// output's lovelace is nowhere near 1,199,800 (most of the curve's balance
// was siphoned off as unaccounted-for "change").
test claim_creator_fees_rejects_draining_more_than_amount() {
  let datum = BondingCurveDatum { ..mock_datum(Active, 0), creator_fees_accrued: 500, total_raised: 900_000 }
  let new_datum =
    BondingCurveDatum {
      ..datum,
      creator_fees_accrued: 300,
      treasury_fees_accrued: 120_000,
      ops_fees_accrued: 80_000,
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
  // Only 1,800 lovelace left in the curve instead of the real 1,199,800 —
  // the rest (998,200) silently left as change to the signer, with the
  // datum still claiming only a 200-lovelace creator_fees_accrued decrement.
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_lovelace(1_800),
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

  !bonding_curve.spend(
    Some(datum),
    ClaimCreatorFees { amount: 200, platform_claim_fee: 200_000 },
    own_ref,
    self,
  )
}

test claim_creator_fees_rejects_platform_fee_below_floor() {
  let datum = BondingCurveDatum { ..mock_datum(Active, 0), creator_fees_accrued: 500 }
  let new_datum =
    BondingCurveDatum { ..datum, creator_fees_accrued: 300, treasury_fees_accrued: 6, ops_fees_accrued: 4 }
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
  // platform_claim_fee of 10 lovelace — far below the 200,000 floor.
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

  !bonding_curve.spend(
    Some(datum),
    ClaimCreatorFees { amount: 200, platform_claim_fee: 10 },
    own_ref,
    self,
  )
}

test claim_treasury_fees_rejects_without_real_payout() {
  // T107: same gap as ClaimCreatorFees, applied to the governor's treasury
  // claim — datum shows the right decrement, but no output ever pays the
  // governor.
  let datum = BondingCurveDatum { ..mock_datum(Active, 0), treasury_fees_accrued: 500 }
  let new_datum = BondingCurveDatum { ..datum, treasury_fees_accrued: 300 }
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

  !bonding_curve.spend(Some(datum), ClaimTreasuryFees { amount: 200 }, own_ref, self)
}

test claim_ops_fees_succeeds_with_real_payout() {
  let datum = BondingCurveDatum { ..mock_datum(Active, 0), ops_fees_accrued: 500 }
  let new_datum = BondingCurveDatum { ..datum, ops_fees_accrued: 300 }
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

  bonding_curve.spend(Some(datum), ClaimOpsFees { amount: 200 }, own_ref, self)
}

/// T93/T115 fix (2026-07-22) regression: proves the real fix for
/// lovelace_paid_from_curve, shared by ClaimTreasuryFees/ClaimOpsFees/
/// SellTokens/ClaimBuyback. Under the OLD exact-full-address check, this
/// test would have FAILED — the governor's real production wallet is
/// always a base address (payment + stake, per WeldPress_CardanoWalletPHP's
/// real wallet generation), never a bare enterprise address, meaning
/// ClaimTreasuryFees/ClaimOpsFees's real production payout was silently
/// broken before this fix, not just a cosmetic UX gap like ClaimBuyback's
/// already-worked-around case.
test claim_ops_fees_succeeds_paying_a_real_base_address_not_just_enterprise() {
  let datum = BondingCurveDatum { ..mock_datum(Active, 0), ops_fees_accrued: 500 }
  let new_datum = BondingCurveDatum { ..datum, ops_fees_accrued: 300 }
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

  bonding_curve.spend(Some(datum), ClaimOpsFees { amount: 200 }, own_ref, self)
}

fn buyback_datum() -> BondingCurveDatum {
  // 100 tokens sold, 1000 lovelace raised (net) — ratio 10 lovelace/token.
  BondingCurveDatum {
    ..mock_datum(Cancelled, 100),
    total_raised: 1000,
  }
}

test claim_buyback_succeeds_with_correct_pro_rata_share() {
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
  // Buyer returns 10 tokens; share = 1000 * 10 / 100 = 100 lovelace.
  let new_datum =
    BondingCurveDatum { ..datum, tokens_sold: 90, total_raised: 900 }
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

  bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

/// T93/T115 fix (2026-07-22) regression: proves the real fix, not just that
/// the old enterprise-address-only behavior still happens to pass. Pays the
/// buyback share to the buyer's REAL BASE ADDRESS (payment credential #"dd"
/// PLUS a stake credential #"ee") — under the old exact-full-address check
/// this would have been rejected (from_verification_key(#"dd") never equals
/// a base address), since only the bare enterprise address ever matched.
test claim_buyback_succeeds_paying_a_real_base_address_not_just_enterprise() {
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
    BondingCurveDatum { ..datum, tokens_sold: 90, total_raised: 900 }
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

  bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test claim_buyback_rejects_before_curve_cancelled() {
  let datum = BondingCurveDatum { ..buyback_datum(), curve_state: Active }
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
    BondingCurveDatum { ..datum, tokens_sold: 90, total_raised: 900 }
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

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test claim_buyback_rejects_unauthenticated_buyer() {
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
    BondingCurveDatum { ..datum, tokens_sold: 90, total_raised: 900 }
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
      // deliberately no extra_signatories — buyer_key_hash #"dd" is unsigned
    }
  let redeemer = ClaimBuyback { token_amount: 10, buyer_key_hash: #"dd" }

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test claim_buyback_rejects_tokens_not_actually_returned() {
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
    BondingCurveDatum { ..datum, tokens_sold: 90, total_raised: 900 }
  // Pays the ADA share but the tokens never actually flow into the curve's
  // continuing output — still 0 tokens held, claims 10 were returned.
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace - 100),
        assets.from_asset(#"33", "tok", 0),
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

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

test claim_buyback_rejects_ada_share_not_actually_paid() {
  let datum = buyback_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
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
    BondingCurveDatum { ..datum, tokens_sold: 90, total_raised: 900 }
  // Tokens ARE returned, but the curve's lovelace balance never decreases
  // and the buyer receives nothing — no payout output at all.
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace),
        assets.from_asset(#"33", "tok", 10),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"dd"],
    }
  let redeemer = ClaimBuyback { token_amount: 10, buyer_key_hash: #"dd" }

  !bonding_curve.spend(Some(datum), redeemer, own_ref, self)
}

fn graduation_datum() -> BondingCurveDatum {
  BondingCurveDatum { ..mock_datum(Graduated, 1000), total_raised: 98_000 }
}

test graduate_succeeds_with_correct_lp_seeding() {
  let datum = graduation_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let lp_address = from_verification_key(#"ff")
  // Curve holds the raised ADA plus its own min-UTXO rent, and the 150
  // lp_reserve_tokens set aside at deploy (mock_datum). No sellable tokens
  // remain — tokens_sold == curve_supply, i.e. fully graduated.
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
    BondingCurveDatum {
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

  bonding_curve.spend(Some(datum), Graduate, own_ref, self)
}

test graduate_rejects_padded_lp_output() {
  // T81: identical to graduate_succeeds_with_correct_lp_seeding, except the
  // new lp_escrow genesis output carries one extra, unrelated junk asset.
  // Graduate is permissionless (see comment below), so ANYONE could
  // otherwise pad the newly-seeded lp_escrow UTXO this way before the
  // T81 fix.
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
    BondingCurveDatum {
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

  !bonding_curve.spend(Some(datum), Graduate, own_ref, self)
}

test graduate_rejects_before_graduated() {
  let datum = BondingCurveDatum { ..graduation_datum(), curve_state: Active }
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
    BondingCurveDatum {
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

  !bonding_curve.spend(Some(datum), Graduate, own_ref, self)
}

test graduate_rejects_if_already_seeded() {
  let datum = BondingCurveDatum { ..graduation_datum(), lp_seeded: True }
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
    BondingCurveDatum {
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

  !bonding_curve.spend(Some(datum), Graduate, own_ref, self)
}

test graduate_rejects_wrong_lp_destination() {
  // Correct amounts, wrong address — proves the LP credential is actually
  // checked, not just the value totals.
  let datum = graduation_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let wrong_address = from_verification_key(#"ee")
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
    BondingCurveDatum {
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
      address: wrong_address,
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

  !bonding_curve.spend(Some(datum), Graduate, own_ref, self)
}

test graduate_rejects_underpaid_lp_seeding() {
  // LP output exists at the right address but is short on lovelace —
  // proves the amount is checked exactly, not just "some value arrived."
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
    BondingCurveDatum {
      ..datum,
      total_raised: 0,
      lp_seeded: True,
      staking_seeded: True,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace - 90_000),
        assets.from_asset(#"33", "tok", 0),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let lp_output =
    Output {
      address: lp_address,
      value: assets.merge(
        // Only 90,000 instead of the full 98,000 raised.
        assets.from_lovelace(90_000),
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

  !bonding_curve.spend(Some(datum), Graduate, own_ref, self)
}

// T66: Graduate + staking rewards pool seeding

fn staking_graduation_datum() -> BondingCurveDatum {
  BondingCurveDatum {
    ..graduation_datum(),
    staking_enabled: True,
    staking_reserve_tokens: 250,
  }
}

test graduate_succeeds_with_lp_and_staking_seeding() {
  let datum = staking_graduation_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let lp_address = from_verification_key(#"ff")
  let staking_address = from_verification_key(#"aa")
  // Curve holds raised ADA + rent, plus 150 lp_reserve_tokens and 250
  // staking_reserve_tokens set aside at deploy.
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
    BondingCurveDatum {
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

  bonding_curve.spend(Some(datum), Graduate, own_ref, self)
}

test graduate_rejects_missing_staking_output_when_enabled() {
  // LP seeding is correct, but the staking pool output is entirely
  // missing — proves staking_seeding_output_ok is actually enforced when
  // staking_enabled, not skipped.
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
    BondingCurveDatum {
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

  !bonding_curve.spend(Some(datum), Graduate, own_ref, self)
}

test graduate_succeeds_without_staking_output_when_disabled() {
  // Staking never enabled for this launch (staking_reserve_tokens == 0) —
  // Graduate must succeed with only LP seeding, same as the pre-T66 tests.
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
    BondingCurveDatum {
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

  bonding_curve.spend(Some(datum), Graduate, own_ref, self)
}

// QueryState must never authorize a spend. Regression guard: a
// transaction spending a real, funded curve UTXO with
// redeemer=QueryState and its value routed away from the script
// (no signature, no legitimate state transition) must be rejected.
test query_state_rejects_unauthenticated_drain_attempt() {
  let datum = mock_datum(Active, 100)
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
  // The entire curve balance routed to the attacker — no continuing
  // output at the script address at all.
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

  !bonding_curve.spend(Some(datum), QueryState, own_ref, self)
}

// T111: closes the double-satisfaction risk found in the full security
// audit — a transaction combining TWO different launches' curve UTXOs
// (same shared script address, different launch_id) must be rejected
// outright, regardless of whether either individual leg looks otherwise
// valid, since no value-check helper in this file can safely disambiguate
// which output belongs to which input once more than one real UTXO from
// this address is present.
test single_own_utxo_rejects_two_curve_inputs_same_tx() {
  let datum_a = mock_datum(Active, 0)
  let datum_b = BondingCurveDatum { ..mock_datum(Active, 0), launch_id: #"02" }
  let own_ref_a = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_ref_b = OutputReference { transaction_id: #"00", output_index: 1 }
  let own_address = from_verification_key(#"cc")
  let buyer_address = from_verification_key(#"dd")
  let base_lovelace = 5_000_000
  let input_a =
    Input {
      output_reference: own_ref_a,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 1000),
        ),
        datum: InlineDatum(datum_a),
        reference_script: None,
      },
    }
  let input_b =
    Input {
      output_reference: own_ref_b,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(base_lovelace),
          assets.from_asset(#"33", "tok", 1000),
        ),
        datum: InlineDatum(datum_b),
        reference_script: None,
      },
    }
  let new_datum_a =
    BondingCurveDatum {
      ..datum_a,
      tokens_sold: 10,
      total_raised: 980,
      creator_fees_accrued: 10,
      treasury_fees_accrued: 6,
      ops_fees_accrued: 4,
      per_address_purchases: [(#"dd", 10)],
    }
  let continuing_output_a =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_lovelace(base_lovelace + 1000),
        assets.from_asset(#"33", "tok", 990),
      ),
      datum: InlineDatum(new_datum_a),
      reference_script: None,
    }
  let delivery_output =
    Output {
      address: buyer_address,
      value: assets.from_asset(#"33", "tok", 10),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  // Curve B's own UTXO is spent too (present as a second input at the
  // same shared address) but has no matching continuing output at all —
  // this is deliberately malformed on curve B's side; the point is that
  // curve A's OWN otherwise-fully-correct BuyTokens must ALSO be rejected
  // purely because a second same-address input exists in the transaction.
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [input_a, input_b],
      outputs: [continuing_output_a, delivery_output],
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

  !bonding_curve.spend(Some(datum_a), redeemer, own_ref_a, self)
}

// T111 fix regression test: a curve that reaches 100% sold (Graduated)
// with non-positive total_raised (reachable via heavy SellTokens activity
// before the final buy — see SellTokens' own doc comment) must not be
// allowed to graduate with a worthless, zero-backed LP position.
test graduate_rejects_non_positive_total_raised() {
  let datum = BondingCurveDatum { ..mock_datum(Graduated, 1000), total_raised: 0 }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let lp_address = from_verification_key(#"ff")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(assets.from_lovelace(98_000), assets.from_asset(#"33", "tok", 150)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    BondingCurveDatum { ..datum, total_raised: 0, lp_seeded: True, staking_seeded: True }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(assets.from_lovelace(98_000), assets.from_asset(#"33", "tok", 0)),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // A real output at the LP address, but with ZERO backing ADA — exactly
  // the "valid-looking but worthless LP" scenario this fix closes.
  let lp_output =
    Output {
      address: lp_address,
      value: assets.merge(assets.from_lovelace(0), assets.from_asset(#"33", "tok", 150)),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, lp_output],
    }

  !bonding_curve.spend(Some(datum), Graduate, own_ref, self)
}
