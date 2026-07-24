import { describe, it, expect } from 'vitest';
import { Contract, ledger, CurveState, LaunchPhase, DarkVeilState, type Witnesses } from '../compiled/bonding_curve/contract/index.js';
import { deployForTest, nextContext, nextContextAtTime, fakeBytes32 } from './helpers.js';
import { buildAllowlistTree, deriveUserPublicKey, hashAllowlistLeaf } from '../../../packages/zk-proofs/src/eligibility-gate.js';
import { computeBuyCommit } from '../../../packages/zk-proofs/src/darkveil.js';

type PrivateState = undefined;

// T25 fix (2026-07-10, extended same day): bonding_curve.compact is now a
// 3-WAY MERGE of eligibility_gate.compact + darkveil.compact +
// bonding_curve.compact for Tier C — see the file header in
// contracts/midnight/bonding_curve.compact for why (Compact has no working
// cross-contract call mechanism, verified this session; folding sources
// into one deployed contract with a shared ledger is the only mechanism
// confirmed to work). This test file now covers all three halves.
//
// Doc-sync note (Phase 2, 2026-07-11): the standalone darkveil.compact this
// comment used to reference for Tier B no longer exists — Tier B's
// eligibility_gate.compact merged in the same logic (mirrors this file's
// own T25 merge). packages/zk-proofs/src/darkveil.ts still exists purely as
// a pure struct-hashing helper module (computeBuyCommit/computeNullifier
// are unaffected by which domain a buyerKey came from), reused by both
// this file and eligibility_gate.test.ts. For THIS merged contract's
// tests, the buyerKey itself must come from eligibility-gate.ts's
// deriveUserPublicKey (the ONE unified identity this merge standardized
// on), not darkveil.ts's own deriveUserPublicKey (still under the
// "noctis:darkveil:user:pk:v1" domain, which no on-chain circuit derives
// under anymore, either tier, after this merge).
// Design requirement: the allowlist leaf is no longer a free
// witness — verifyAllowlist derives it in-circuit as
// hashAllowlistLeaf(caller), so the off-chain tree must be built with the
// SAME formula for the buyer's real derived identity (fakeBytes32(3)),
// not an arbitrary opaque value.
const BUYER_KEY = deriveUserPublicKey(fakeBytes32(3));
const ALLOWLIST_LEAF = hashAllowlistLeaf(BUYER_KEY);
const ALLOWLIST_TREE = buildAllowlistTree([ALLOWLIST_LEAF]);
const BUY_NONCE = fakeBytes32(8);

const witnesses: Witnesses<PrivateState> = {
  getUserSecret: (_ctx) => [undefined, { bytes: fakeBytes32(3) }],
  getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
  getMerkleProof: (_ctx) => [undefined, ALLOWLIST_TREE.getProof(0)],
  getRegistrationNonce: (_ctx) => [undefined, fakeBytes32(6)],
  getBuyNonce: (_ctx) => [undefined, BUY_NONCE],
};

// base=100, max=1000, curveSupply=1000 (round numbers chosen so the
// quadratic formula's expected outputs are easy to hand-verify)
const BASE_PRICE = 100n;
const MAX_PRICE = 1000n;
const CURVE_SUPPLY = 1000n;

// Eligibility-gate-side constructor args
const TOTAL_SUPPLY = 1_000_000_000n;
const MAX_WALLET_PERCENT = 5n;
const WALLET_CAP = (TOTAL_SUPPLY * MAX_WALLET_PERCENT) / 100n; // 50,000,000
const BOND_AMOUNT = 1000n;

// DarkVeil-side constructor args
const DV_ALLOCATION = 500n;
const DV_PRICE = 90n;
const ALLOWLIST_SIZE = 1n;
const REGISTRATION_CLOSE_TIME = 1_000_000n;
// T37: permissive by default (1n) so pre-existing tests aren't broken by
// the new minimum-participant floor. Dedicated tests further down deploy
// with a real threshold to exercise the floor itself.
const MIN_DV_PARTICIPANTS_TEST = 1n;

const LAUNCH_ID = fakeBytes32(9);

// T32: the creator's identity, distinct from the regular buyer secret
// (fakeBytes32(3)) every other test in this file uses — same derivation
// off-chain mirror (deriveUserPublicKey) the contract's own creatorKey
// check compares against. deriveUserPublicKey here is the raw off-chain
// mirror (Uint8Array in/out), not the UserSecretKey/UserPublicKey struct
// wrapper the witness type uses.
const CREATOR_SECRET_BYTES = fakeBytes32(42);
const CREATOR_KEY = deriveUserPublicKey(CREATOR_SECRET_BYTES);

// T33: fixed payout addresses for forfeited DarkVeil bond NIGHT — real
// unshielded addresses, not derived identities, so plain fakeBytes32 is
// fine (nothing derives from these the way CREATOR_KEY is derived).
const TREASURY_ADDR = fakeBytes32(60);
const OPS_ADDR = fakeBytes32(40);

// Design requirement: real unshielded payout addresses
// withdrawFees/graduateLp pay out to — added to the constructor alongside
// treasuryAddr/opsAddr above.
const CREATOR_ADDR = fakeBytes32(61);
const LP_ESCROW_ADDR = fakeBytes32(62);

function deploy() {
  const contract = new Contract<PrivateState>(witnesses);
  const { init, contractAddress, ctx } = deployForTest(
    contract,
    undefined,
    LAUNCH_ID,
    ALLOWLIST_TREE.root, // allowlistRoot
    TOTAL_SUPPLY,
    MAX_WALLET_PERCENT,
    BOND_AMOUNT,
    WALLET_CAP,
    BASE_PRICE,
    MAX_PRICE,
    CURVE_SUPPLY,
    DV_ALLOCATION,
    DV_PRICE,
    ALLOWLIST_SIZE,
    REGISTRATION_CLOSE_TIME,
    MIN_DV_PARTICIPANTS_TEST,
    CREATOR_KEY,
    TREASURY_ADDR,
    OPS_ADDR,
    CREATOR_ADDR,
    LP_ESCROW_ADDR,
  );
  return { contract, init, contractAddress, ctx };
}

/** Advances phase Pending -> DarkVeil -> Public, matching real deploy flow. */
function deployAndAdvanceToPublic() {
  const d = deploy();
  const r1 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
  const ctx1 = nextContext(d.contractAddress, r1.context);
  const r2 = d.contract.circuits.advancePhase(ctx1, LaunchPhase.Public);
  const ctx2 = nextContext(d.contractAddress, r2.context);
  return { ...d, ctx: ctx2 };
}

function deployAndActivate() {
  const d = deployAndAdvanceToPublic();
  const r = d.contract.circuits.activateCurve(d.ctx, 1000n);
  const ctx = nextContext(d.contractAddress, r.context);
  return { ...d, ctx };
}

/**
 * price = floor(basePrice + (maxPrice - basePrice) * sold^2 / curveSupply^2)
 * bigint `/` truncates toward zero, which is floor for all-positive
 * operands here — this is now ALWAYS the correct claimedPrice (T39 fix:
 * verifyPrice checks claimedPrice is the floor of the true value via a
 * double inequality, not exact equality), not just at "lucky" checkpoints.
 */
function expectedPrice(sold: bigint): bigint {
  return BASE_PRICE + ((MAX_PRICE - BASE_PRICE) * sold * sold) / (CURVE_SUPPLY * CURVE_SUPPLY);
}

/** Fee split: 1.0% creator, 0.6% treasury, 0.4% ops (bps / 10000), floor-rounded (T39 fix). */
function fees(gross: bigint) {
  return {
    creator: (gross * 100n) / 10_000n,
    treasury: (gross * 60n) / 10_000n,
    ops: (gross * 40n) / 10_000n,
  };
}

describe('bonding_curve.compact — quadratic pricing', () => {
  it('prices at basePrice when sold=0', () => {
    expect(expectedPrice(0n)).toBe(100n);
  });

  it('prices at maxPrice when sold=curveSupply (full sell-through)', () => {
    expect(expectedPrice(CURVE_SUPPLY)).toBe(1000n);
  });

  it('prices at basePrice + 25% of the range at 50% sold (quadratic, not linear)', () => {
    // At 50% sold, a LINEAR curve would be at the midpoint (550). The
    // quadratic curve is deliberately NOT at the midpoint — this is the
    // whole point of the quadratic rewrite (see bonding_curve.compact's
    // header comment on why this replaced an earlier linear draft).
    const price = expectedPrice(500n);
    expect(price).toBe(325n); // 100 + 900 * 0.25
    expect(price).not.toBe(550n); // what a linear curve would give
  });

  it('accepts a buy with the correct quadratic price and fee split', () => {
    const { contract, contractAddress, ctx } = deployAndActivate();

    const tokenAmount = 10n;
    const claimedPrice = expectedPrice(0n); // 100
    const grossPayment = tokenAmount * claimedPrice; // 1000
    const { creator, treasury, ops } = fees(grossPayment); // 10, 6, 4

    const result = contract.circuits.buyTokens(
      ctx,
      tokenAmount,
      claimedPrice,
      grossPayment,
      creator,
      treasury,
      ops,
      1_000_000n,
    );

    const state = ledger(result.context.currentQueryContext.state);
    expect(state.tokensSold).toBe(10n);
    expect(state.creatorFees).toBe(10n);
    expect(state.treasuryFees).toBe(6n);
    expect(state.opsFees).toBe(4n);
    expect(state.totalRaised).toBe(grossPayment - creator - treasury - ops); // 980
  });

  it('rejects a buy with an incorrect claimed price (verifyPrice regression)', () => {
    const { contract, ctx } = deployAndActivate();
    const wrongPrice = 999n; // not what the quadratic formula gives at sold=0

    expect(() =>
      contract.circuits.buyTokens(ctx, 10n, wrongPrice, 10n * wrongPrice, 0n, 0n, 0n, 1n),
    ).toThrow();
  });

  it('rejects a buy with a fee split missing the /10000 divisor (the original bug)', () => {
    const { contract, ctx } = deployAndActivate();
    const tokenAmount = 10n;
    const claimedPrice = expectedPrice(0n);
    const grossPayment = tokenAmount * claimedPrice;
    const brokenCreatorFee = grossPayment * 100n; // the original (broken) formula

    expect(() =>
      contract.circuits.buyTokens(ctx, tokenAmount, claimedPrice, grossPayment, brokenCreatorFee, 0n, 0n, 1n),
    ).toThrow();
  });

  it('rejects a buy with mismatched fee amounts (correct total, wrong split)', () => {
    const { contract, ctx } = deployAndActivate();
    const tokenAmount = 10n;
    const claimedPrice = expectedPrice(0n);
    const grossPayment = tokenAmount * claimedPrice;
    const { creator, treasury, ops } = fees(grossPayment);

    expect(() =>
      contract.circuits.buyTokens(ctx, tokenAmount, claimedPrice, grossPayment, treasury, creator, ops, 1n),
    ).toThrow();
  });

  it('accumulates fees correctly across multiple buys, at ARBITRARY (non-checkpoint) amounts', () => {
    const { contract, contractAddress, ctx } = deployAndActivate();

    const buy1Price = expectedPrice(0n); // 100
    const buy1Gross = 37n * buy1Price;
    const buy1Fees = fees(buy1Gross);
    const r1 = contract.circuits.buyTokens(
      ctx, 37n, buy1Price, buy1Gross, buy1Fees.creator, buy1Fees.treasury, buy1Fees.ops, 1n,
    );

    const ctx2 = nextContext(contractAddress, r1.context);
    const buy2Price = expectedPrice(37n); // not a "nice" checkpoint at all
    const buy2Gross = 213n * buy2Price;
    const buy2Fees = fees(buy2Gross);
    const r2 = contract.circuits.buyTokens(
      ctx2, 213n, buy2Price, buy2Gross, buy2Fees.creator, buy2Fees.treasury, buy2Fees.ops, 2n,
    );

    const state = ledger(r2.context.currentQueryContext.state);
    expect(state.tokensSold).toBe(250n);
    expect(state.creatorFees).toBe(buy1Fees.creator + buy2Fees.creator);
    expect(state.treasuryFees).toBe(buy1Fees.treasury + buy2Fees.treasury);
    expect(state.opsFees).toBe(buy1Fees.ops + buy2Fees.ops);
  });

  it('T39 FIXED: verifyPrice now accepts the correct floor price at a non-checkpoint sold value', () => {
    const { contract, contractAddress, ctx } = deployAndActivate();
    const r1 = contract.circuits.buyTokens(ctx, 10n, 100n, 1000n, 10n, 6n, 4n, 1n);
    const ctx2 = nextContext(contractAddress, r1.context);
    expect(ledger(r1.context.currentQueryContext.state).tokensSold).toBe(10n);

    const trueMathematicalPrice = 100.09;
    expect(trueMathematicalPrice).toBeGreaterThan(100);
    expect(trueMathematicalPrice).toBeLessThan(101);

    const rFloor = contract.circuits.buyTokens(ctx2, 1n, 100n, 100n, 1n, 0n, 0n, 2n);
    expect(ledger(rFloor.context.currentQueryContext.state).tokensSold).toBe(11n);

    expect(() =>
      contract.circuits.buyTokens(ctx2, 1n, 101n, 101n, 1n, 0n, 0n, 2n),
    ).toThrow();
  });

  it('T39 FIXED: verifyFeeSlice now accepts the correct floor fee for an arbitrary gross payment', () => {
    const { contract, contractAddress, ctx } = deployAndActivate();
    const r1 = contract.circuits.buyTokens(ctx, 100n, 100n, 10_000n, 100n, 60n, 40n, 1n);
    const ctx2 = nextContext(contractAddress, r1.context);
    expect(ledger(r1.context.currentQueryContext.state).tokensSold).toBe(100n);

    const gross = 1090n; // 10 tokens at price 109 (sold=100 checkpoint)
    const floorCreatorFee = (gross * 100n) / 10_000n; // 10, floor of 10.9
    const floorTreasuryFee = (gross * 60n) / 10_000n; // 6, floor of 6.54
    const floorOpsFee = (gross * 40n) / 10_000n; // 4, floor of 4.36
    const rFloor = contract.circuits.buyTokens(
      ctx2, 10n, 109n, gross, floorCreatorFee, floorTreasuryFee, floorOpsFee, 2n,
    );
    expect(ledger(rFloor.context.currentQueryContext.state).tokensSold).toBe(110n);

    expect(() =>
      contract.circuits.buyTokens(
        ctx2, 10n, 109n, gross, floorCreatorFee, floorTreasuryFee + 1n, floorOpsFee, 2n,
      ),
    ).toThrow();
  });

  it('T40: every buy requires receiveUnshielded, does not throw locally', () => {
    // The local compact-runtime simulator doesn't model cross-transaction
    // UTXO matching (real-node/ledger enforcement — see T3), so this test
    // can't prove a mismatched payment is rejected end-to-end. It proves
    // receiveUnshielded is wired into every buy (unconditional — this
    // contract is Tier C/NIGHT only).
    const { contract, ctx } = deployAndActivate();
    const price = expectedPrice(0n);
    const gross = 5n * price;
    const { creator, treasury, ops } = fees(gross);
    const r = contract.circuits.buyTokens(ctx, 5n, price, gross, creator, treasury, ops, 1n);
    expect(ledger(r.context.currentQueryContext.state).tokensSold).toBe(5n);
  });

  it('T24: claimCurveRefund succeeds once after cancellation, for a buyer who actually paid', () => {
    const { contract, contractAddress, ctx } = deployAndActivate();
    const price = expectedPrice(0n);
    const gross = 10n * price;
    const { creator, treasury, ops } = fees(gross);
    const r1 = contract.circuits.buyTokens(ctx, 10n, price, gross, creator, treasury, ops, 1n);
    const ctx2 = nextContext(contractAddress, r1.context);

    const r2 = contract.circuits.cancelCurve(ctx2);
    const ctx3 = nextContext(contractAddress, r2.context);

    expect(() => contract.circuits.claimCurveRefund(ctx3, fakeBytes32(5))).not.toThrow();
  });

  it('T24: claimCurveRefund rejects when the curve is not cancelled', () => {
    const { contract, contractAddress, ctx } = deployAndActivate();
    const price = expectedPrice(0n);
    const gross = 10n * price;
    const { creator, treasury, ops } = fees(gross);
    const r1 = contract.circuits.buyTokens(ctx, 10n, price, gross, creator, treasury, ops, 1n);
    const ctx2 = nextContext(contractAddress, r1.context);

    expect(() => contract.circuits.claimCurveRefund(ctx2, fakeBytes32(5))).toThrow();
  });

  it('T24: claimCurveRefund rejects a caller with no payment on record', () => {
    const { contract, contractAddress, ctx } = deployAndActivate();
    const r1 = contract.circuits.cancelCurve(ctx);
    const ctx2 = nextContext(contractAddress, r1.context);

    expect(() => contract.circuits.claimCurveRefund(ctx2, fakeBytes32(5))).toThrow();
  });

  it('T24: claimCurveRefund rejects double-claim', () => {
    const { contract, contractAddress, ctx } = deployAndActivate();
    const price = expectedPrice(0n);
    const gross = 10n * price;
    const { creator, treasury, ops } = fees(gross);
    const r1 = contract.circuits.buyTokens(ctx, 10n, price, gross, creator, treasury, ops, 1n);
    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.cancelCurve(ctx2);
    const ctx3 = nextContext(contractAddress, r2.context);
    const r3 = contract.circuits.claimCurveRefund(ctx3, fakeBytes32(5));
    const ctx4 = nextContext(contractAddress, r3.context);

    expect(() => contract.circuits.claimCurveRefund(ctx4, fakeBytes32(5))).toThrow();
  });

  it('Phase 5 hygiene fix: claimCurveRefund rejects an empty (all-zero) recipient address', () => {
    const { contract, contractAddress, ctx } = deployAndActivate();
    const price = expectedPrice(0n);
    const gross = 10n * price;
    const { creator, treasury, ops } = fees(gross);
    const r1 = contract.circuits.buyTokens(ctx, 10n, price, gross, creator, treasury, ops, 1n);
    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.cancelCurve(ctx2);
    const ctx3 = nextContext(contractAddress, r2.context);

    expect(() => contract.circuits.claimCurveRefund(ctx3, fakeBytes32(0))).toThrow();
  });

  it('T29: expireCurve force-cancels a stalled curve after 90 days, with no governor signature required', () => {
    // Design requirement: expireCurve no longer takes a
    // caller-supplied timestamp — it gates on blockTimeGt against the real
    // simulator clock (see helpers.ts's nextContextAtTime), which cannot
    // be forged the way the old parameter could.
    const { contract, contractAddress, ctx } = deployAndActivate(); // activated_at = 1000n
    const pastDeadline = 1000 + 7776000 + 1;
    const ctxAtDeadline = nextContextAtTime(contractAddress, ctx, pastDeadline);

    // No extra_signatories-equivalent setup at all — expireCurve is
    // permissionless by design, unlike cancelCurve.
    const r = contract.circuits.expireCurve(ctxAtDeadline);
    expect(ledger(r.context.currentQueryContext.state).curveState).toBe(CurveState.Cancelled);
    // Once expired, the same refund path T24's claimCurveRefund already
    // provides works exactly as if the governor had called cancelCurve —
    // expireCurve is just a permissionless alternate path to Cancelled.
  });

  it('T29: expireCurve rejects before the 90-day deadline has passed', () => {
    const { contract, contractAddress, ctx } = deployAndActivate(); // activated_at = 1000n
    const beforeDeadline = 1000 + 7776000; // exactly at the boundary, not past it
    const ctxBeforeDeadline = nextContextAtTime(contractAddress, ctx, beforeDeadline);

    expect(() => contract.circuits.expireCurve(ctxBeforeDeadline)).toThrow();
  });

  it('T29: expireCurve rejects a curve that is not Active (e.g. already Cancelled)', () => {
    const { contract, contractAddress, ctx } = deployAndActivate();
    const r1 = contract.circuits.cancelCurve(ctx);
    const ctx2 = nextContext(contractAddress, r1.context);
    const pastDeadline = 1000 + 7776000 + 1;
    const ctxAtDeadline = nextContextAtTime(contractAddress, ctx2, pastDeadline);

    expect(() => contract.circuits.expireCurve(ctxAtDeadline)).toThrow();
  });

  it('graduates automatically at 100% sell-through', () => {
    const { contract, ctx } = deployAndActivate();

    const claimedPrice = expectedPrice(0n);
    const grossPayment = CURVE_SUPPLY * claimedPrice;
    const { creator, treasury, ops } = fees(grossPayment);

    const result = contract.circuits.buyTokens(
      ctx, CURVE_SUPPLY, claimedPrice, grossPayment, creator, treasury, ops, 1n,
    );

    const state = ledger(result.context.currentQueryContext.state);
    expect(state.tokensSold).toBe(CURVE_SUPPLY);
    expect(state.curveState).toBe(CurveState.Graduated);
  });

  it('rejects buys once the curve has graduated', () => {
    const { contract, contractAddress, ctx } = deployAndActivate();

    const claimedPrice = expectedPrice(0n);
    const grossPayment = CURVE_SUPPLY * claimedPrice;
    const { creator, treasury, ops } = fees(grossPayment);
    const r1 = contract.circuits.buyTokens(
      ctx, CURVE_SUPPLY, claimedPrice, grossPayment, creator, treasury, ops, 1n,
    );
    const ctx2 = nextContext(contractAddress, r1.context);

    expect(() => contract.circuits.buyTokens(ctx2, 1n, expectedPrice(CURVE_SUPPLY), expectedPrice(CURVE_SUPPLY), 0n, 0n, 0n, 2n)).toThrow();
  });

  it('rejects buying more tokens than remain on the curve', () => {
    const { contract, ctx } = deployAndActivate();
    const claimedPrice = expectedPrice(0n);
    const overAmount = CURVE_SUPPLY + 1n;

    expect(() =>
      contract.circuits.buyTokens(ctx, overAmount, claimedPrice, overAmount * claimedPrice, 0n, 0n, 0n, 1n),
    ).toThrow();
  });

  it('T32: rejects the creator buying their own public bonding curve', () => {
    const creatorWitnesses: Witnesses<PrivateState> = {
      ...witnesses,
      getUserSecret: (_ctx) => [undefined, { bytes: CREATOR_SECRET_BYTES }],
    };
    const contract = new Contract<PrivateState>(creatorWitnesses);
    const { contractAddress, ctx } = deployForTest(
      contract,
      undefined,
      LAUNCH_ID,
      ALLOWLIST_TREE.root,
      TOTAL_SUPPLY,
      MAX_WALLET_PERCENT,
      BOND_AMOUNT,
      WALLET_CAP,
      BASE_PRICE,
      MAX_PRICE,
      CURVE_SUPPLY,
      DV_ALLOCATION,
      DV_PRICE,
      ALLOWLIST_SIZE,
      REGISTRATION_CLOSE_TIME,
      MIN_DV_PARTICIPANTS_TEST,
      CREATOR_KEY,
      TREASURY_ADDR,
      OPS_ADDR,
      CREATOR_ADDR,
      LP_ESCROW_ADDR,
    );
    const r1 = contract.circuits.advancePhase(ctx, LaunchPhase.DarkVeil);
    const ctx1 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.advancePhase(ctx1, LaunchPhase.Public);
    const ctx2 = nextContext(contractAddress, r2.context);
    const r3 = contract.circuits.activateCurve(ctx2, 1000n);
    const ctx3 = nextContext(contractAddress, r3.context);

    const claimedPrice = expectedPrice(0n);
    const grossPayment = 10n * claimedPrice;
    const { creator, treasury, ops } = fees(grossPayment);
    expect(() =>
      contract.circuits.buyTokens(ctx3, 10n, claimedPrice, grossPayment, creator, treasury, ops, 1n),
    ).toThrow();
  });

  it('requires the curve to be activated before any buy', () => {
    const { contract, ctx } = deployAndAdvanceToPublic(); // phase is Public, but curve not yet activated
    const claimedPrice = expectedPrice(0n);

    expect(() =>
      contract.circuits.buyTokens(ctx, 10n, claimedPrice, 10n * claimedPrice, 1n, 1n, 1n, 1n),
    ).toThrow();
  });

  it('activateCurve requires phase == Public (new invariant enabled by the T25 merge)', () => {
    // Before the merge, activateCurve had no way to know what phase the
    // launch was in at all — `phase` lived in a different contract. Now
    // that they're one contract, activation is gated on it directly.
    const d = deploy(); // phase is still Pending
    expect(() => d.contract.circuits.activateCurve(d.ctx, 1000n)).toThrow();
  });
});

describe('bonding_curve.compact — merged eligibility gate (T25)', () => {
  it('registerForDarkVeil succeeds with a valid allowlist proof and bond payment', () => {
    const d = deploy();
    const r = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
    const ctx0 = nextContext(d.contractAddress, r.context);
    const rReg = d.contract.circuits.startRegistration(ctx0);
    const ctx = nextContext(d.contractAddress, rReg.context);

    expect(() => d.contract.circuits.registerForDarkVeil(ctx, fakeBytes32(7))).not.toThrow();
  });

  it('T25 FIXED: buyTokens enforces the 5% wallet cap directly against cumulativePurchases, atomically', () => {
    // This is the core T25 regression test — before this merge, buyTokens
    // had NO cap enforcement at all (the check was "supposed to happen via
    // transaction merging" that never actually worked, per T2). Now it's
    // inline in the same circuit call.
    const { contract, ctx } = deployAndActivate();

    // curveSupply=1000, so buying the whole curve (1000 tokens) is well
    // under WALLET_CAP (50,000,000) in this test's numbers.
    const claimedPrice = expectedPrice(0n);
    const grossPayment = CURVE_SUPPLY * claimedPrice;
    const { creator, treasury, ops } = fees(grossPayment);

    // A full sell-through buy is comfortably under the cap and must succeed.
    expect(() =>
      contract.circuits.buyTokens(ctx, CURVE_SUPPLY, claimedPrice, grossPayment, creator, treasury, ops, 1n),
    ).not.toThrow();
  });

  it('regression: buyTokens rejects a purchase that would push cumulativePurchases over the cap', () => {
    // Design requirement: checkAndUpdateCap (a standalone,
    // unauthenticated circuit taking an arbitrary callerKey) was removed
    // from this file entirely — buyTokens/revealBuyCommit already enforce
    // the cap inline. This proves the boundary the removed circuit's test
    // used to cover is still real: a tight per-launch wallet cap must
    // reject a buy that would exceed it.
    const witnessesTight: Witnesses<PrivateState> = { ...witnesses };
    const contract = new Contract<PrivateState>(witnessesTight);
    const tightCap = 5n; // less than a full sell-through (1000 tokens)
    const { contractAddress, ctx } = deployForTest(
      contract,
      undefined,
      LAUNCH_ID,
      ALLOWLIST_TREE.root,
      TOTAL_SUPPLY,
      MAX_WALLET_PERCENT,
      BOND_AMOUNT,
      tightCap,
      BASE_PRICE,
      MAX_PRICE,
      CURVE_SUPPLY,
      DV_ALLOCATION,
      DV_PRICE,
      ALLOWLIST_SIZE,
      REGISTRATION_CLOSE_TIME,
      MIN_DV_PARTICIPANTS_TEST,
      CREATOR_KEY,
      TREASURY_ADDR,
      OPS_ADDR,
      CREATOR_ADDR,
      LP_ESCROW_ADDR,
    );
    const r0 = contract.circuits.advancePhase(ctx, LaunchPhase.DarkVeil);
    const ctx0 = nextContext(contractAddress, r0.context);
    const r1 = contract.circuits.advancePhase(ctx0, LaunchPhase.Public);
    const ctx1 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.activateCurve(ctx1, 1000n);
    const ctx2 = nextContext(contractAddress, r2.context);

    const claimedPrice = expectedPrice(0n);
    const tokenAmount = tightCap + 1n; // exceeds tightCap (5)
    const grossPayment = tokenAmount * claimedPrice;
    const { creator, treasury, ops } = fees(grossPayment);

    expect(() =>
      contract.circuits.buyTokens(ctx2, tokenAmount, claimedPrice, grossPayment, creator, treasury, ops, 1n),
    ).toThrow();
  });

  it('T25 FIXED: cumulativePurchases is shared across separate buyTokens calls for the same identity', () => {
    // Proves cumulativePurchases is genuinely shared across purchases: two
    // separate buyTokens calls for the SAME derived identity both update/
    // read the SAME map entry (see bonding_curve.compact's identity-
    // unification note). getUserSecret's witness always returns
    // fakeBytes32(3) in this test file — deriveUserPublicKey (the real,
    // verified off-chain mirror of the on-chain circuit, same domain
    // "noctis:user:pk:v1") computes what buyTokens actually keys its
    // ledger writes by.
    const d = deployAndActivate();
    const buyerDerivedKey = deriveUserPublicKey(fakeBytes32(3));

    const claimedPrice = expectedPrice(0n);
    const tokenAmount = 25n;
    const grossPayment = tokenAmount * claimedPrice;
    const { creator, treasury, ops } = fees(grossPayment);

    const r = d.contract.circuits.buyTokens(d.ctx, tokenAmount, claimedPrice, grossPayment, creator, treasury, ops, 1n);
    const ctx2 = nextContext(d.contractAddress, r.context);

    // Reading cumulativePurchases for the buyer's REAL derived key (via the
    // read-only checkCap, not checkAndUpdateCap) should now show
    // tokenAmount — proving buyTokens wrote into the exact same map entry
    // checkAndUpdateCap/checkCap read.
    const capProbe = d.contract.circuits.checkCap(ctx2, buyerDerivedKey);
    expect(capProbe.result).toBe(tokenAmount);
  });

  it('claimBondRefund pays out after DarkVeil is marked failed (T22/T43)', () => {
    const d = deploy();
    const r1 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    const rStart = d.contract.circuits.startRegistration(ctx1);
    const ctxStart = nextContext(d.contractAddress, rStart.context);
    const r2 = d.contract.circuits.registerForDarkVeil(ctxStart, fakeBytes32(7));
    const ctx2 = nextContext(d.contractAddress, r2.context);
    const r3 = d.contract.circuits.advancePhase(ctx2, LaunchPhase.Public);
    const ctx3 = nextContext(d.contractAddress, r3.context);
    const r4 = d.contract.circuits.markDarkVeilFailed(ctx3);
    const ctx4 = nextContext(d.contractAddress, r4.context);

    expect(() => d.contract.circuits.claimBondRefund(ctx4, fakeBytes32(5))).not.toThrow();
  });

  it('Phase 5 hygiene fix: claimBondRefund rejects an empty (all-zero) recipient address', () => {
    const d = deploy();
    const r1 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    const rStart = d.contract.circuits.startRegistration(ctx1);
    const ctxStart = nextContext(d.contractAddress, rStart.context);
    const r2 = d.contract.circuits.registerForDarkVeil(ctxStart, fakeBytes32(7));
    const ctx2 = nextContext(d.contractAddress, r2.context);
    const r3 = d.contract.circuits.advancePhase(ctx2, LaunchPhase.Public);
    const ctx3 = nextContext(d.contractAddress, r3.context);
    const r4 = d.contract.circuits.markDarkVeilFailed(ctx3);
    const ctx4 = nextContext(d.contractAddress, r4.context);

    expect(() => d.contract.circuits.claimBondRefund(ctx4, fakeBytes32(0))).toThrow();
  });
});

// ============================================================================
// T37 resolution (2026-07-13): minimum absolute registrant count required
// before startBuying() opens the buying phase. Same fix as
// eligibility_gate.compact (Tier B) — below the floor, the governor must
// call cancelDarkVeil() (T22's existing, already-refundable failure path)
// instead.
// ============================================================================

describe('bonding_curve.compact — T37 minimum DarkVeil participant floor', () => {
  // Three real distinct registrant identities, each a real leaf in a
  // purpose-built 3-leaf allowlist tree — the shared top-level
  // ALLOWLIST_TREE only contains one leaf (BUYER_KEY).
  const SECRET_A = fakeBytes32(101);
  const SECRET_B = fakeBytes32(102);
  const SECRET_C = fakeBytes32(103);
  const KEY_A = deriveUserPublicKey(SECRET_A);
  const KEY_B = deriveUserPublicKey(SECRET_B);
  const KEY_C = deriveUserPublicKey(SECRET_C);
  const FLOOR_TREE = buildAllowlistTree([
    hashAllowlistLeaf(KEY_A),
    hashAllowlistLeaf(KEY_B),
    hashAllowlistLeaf(KEY_C),
  ]);

  function registrantContract(secretBytes: Uint8Array, index: number) {
    return new Contract<PrivateState>({
      getUserSecret: (_ctx) => [undefined, { bytes: secretBytes }],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
      getMerkleProof: (_ctx) => [undefined, FLOOR_TREE.getProof(index)],
      getRegistrationNonce: (_ctx) => [undefined, fakeBytes32(6)],
      getBuyNonce: (_ctx) => [undefined, BUY_NONCE],
    });
  }

  function deployWithFloor(minDvParticipants: bigint) {
    const governorContract = new Contract<PrivateState>({
      getUserSecret: (_ctx) => [undefined, { bytes: SECRET_A }],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
      getMerkleProof: (_ctx) => [undefined, FLOOR_TREE.getProof(0)],
      getRegistrationNonce: (_ctx) => [undefined, fakeBytes32(6)],
      getBuyNonce: (_ctx) => [undefined, BUY_NONCE],
    });
    const { contractAddress, ctx } = deployForTest(
      governorContract,
      undefined,
      LAUNCH_ID,
      FLOOR_TREE.root,
      TOTAL_SUPPLY,
      MAX_WALLET_PERCENT,
      BOND_AMOUNT,
      WALLET_CAP,
      BASE_PRICE,
      MAX_PRICE,
      CURVE_SUPPLY,
      DV_ALLOCATION,
      DV_PRICE,
      3n, // allowlistSize — matches the 3-leaf FLOOR_TREE
      REGISTRATION_CLOSE_TIME,
      minDvParticipants,
      CREATOR_KEY,
      TREASURY_ADDR,
      OPS_ADDR,
      CREATOR_ADDR,
      LP_ESCROW_ADDR,
    );
    const r0 = governorContract.circuits.advancePhase(ctx, LaunchPhase.DarkVeil);
    const ctx0 = nextContext(contractAddress, r0.context);
    const r1 = governorContract.circuits.startRegistration(ctx0);
    const ctx1 = nextContext(contractAddress, r1.context);
    return { governorContract, contractAddress, ctx: ctx1 };
  }

  it('rejects startBuying() below the floor, but cancelDarkVeil() still works as the escape hatch', () => {
    const { governorContract, contractAddress, ctx } = deployWithFloor(3n);

    // Only 2 of the 3 leaves register — below the floor of 3.
    const rA = registrantContract(SECRET_A, 0).circuits.registerForDarkVeil(ctx, fakeBytes32(201));
    const ctxA = nextContext(contractAddress, rA.context);
    const rB = registrantContract(SECRET_B, 1).circuits.registerForDarkVeil(ctxA, fakeBytes32(202));
    const ctxB = nextContext(contractAddress, rB.context);

    expect(ledger(ctxB.currentQueryContext.state).registrationCount).toBe(2n);
    expect(() => governorContract.circuits.startBuying(ctxB)).toThrow();

    // The governor's real escape hatch (T22) still works from here.
    const rCancel = governorContract.circuits.cancelDarkVeil(ctxB);
    const ctxCancelled = nextContext(contractAddress, rCancel.context);
    expect(ledger(ctxCancelled.currentQueryContext.state).dvState).toBe(DarkVeilState.Cancelled);
  });

  it('allows startBuying() once registration count reaches the floor', () => {
    const { governorContract, contractAddress, ctx } = deployWithFloor(3n);

    const rA = registrantContract(SECRET_A, 0).circuits.registerForDarkVeil(ctx, fakeBytes32(201));
    const ctxA = nextContext(contractAddress, rA.context);
    const rB = registrantContract(SECRET_B, 1).circuits.registerForDarkVeil(ctxA, fakeBytes32(202));
    const ctxB = nextContext(contractAddress, rB.context);
    const rC = registrantContract(SECRET_C, 2).circuits.registerForDarkVeil(ctxB, fakeBytes32(203));
    const ctxC = nextContext(contractAddress, rC.context);

    expect(ledger(ctxC.currentQueryContext.state).registrationCount).toBe(3n);
    const rBuy = governorContract.circuits.startBuying(ctxC);
    const ctxBuying = nextContext(contractAddress, rBuy.context);
    expect(ledger(ctxBuying.currentQueryContext.state).dvState).toBe(DarkVeilState.Buying);
  });

  it('rejects a zero minDvParticipants at deploy time', () => {
    expect(() =>
      deployForTest(
        new Contract<PrivateState>(witnesses),
        undefined,
        LAUNCH_ID,
        ALLOWLIST_TREE.root,
        TOTAL_SUPPLY,
        MAX_WALLET_PERCENT,
        BOND_AMOUNT,
        WALLET_CAP,
        BASE_PRICE,
        MAX_PRICE,
        CURVE_SUPPLY,
        DV_ALLOCATION,
        DV_PRICE,
        ALLOWLIST_SIZE,
        REGISTRATION_CLOSE_TIME,
        0n, // minDvParticipants — invalid
        CREATOR_KEY,
        TREASURY_ADDR,
        OPS_ADDR,
        CREATOR_ADDR,
        LP_ESCROW_ADDR,
      )
    ).toThrow();
  });
});

describe('bonding_curve.compact — merged DarkVeil private buy (T25 follow-up)', () => {
  /**
   * Drives dvState through Inactive -> Registration -> Buying, AND phase
   * to DarkVeil (the two are independent state machines — see
   * DarkVeilState's comment in bonding_curve.compact — but advancePhase's
   * own transition guards need phase to have moved too, e.g. before it can
   * later go to Public).
   */
  // Phase 4 fix (2026-07-12): submitBuyCommit now requires proof of prior
  // registration (a recomputed registration nullifier), so this helper
  // registers the default buyer (fakeBytes32(3), matching the shared
  // `witnesses` object) before opening buying — same fix as
  // eligibility_gate.test.ts's identical helper.
  function deployAndStartDvBuying() {
    const d = deploy();
    const r0 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
    const ctx0 = nextContext(d.contractAddress, r0.context);
    const r1 = d.contract.circuits.startRegistration(ctx0);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    // T-AUDIT fix (2026-07-21): registerForDarkVeil now requires
    // dvState == Registration, so this must happen after startRegistration.
    const rReg = d.contract.circuits.registerForDarkVeil(ctx1, fakeBytes32(7));
    const ctxReg = nextContext(d.contractAddress, rReg.context);
    const r2 = d.contract.circuits.startBuying(ctxReg);
    const ctx2 = nextContext(d.contractAddress, r2.context);
    return { ...d, ctx: ctx2 };
  }

  it('submitBuyCommit accepts a commitment during the Buying sub-phase, discloses nothing about the amount', () => {
    const d = deployAndStartDvBuying();
    const buyerKey = deriveUserPublicKey(fakeBytes32(3));
    const tokenAmount = 50n;
    const commitment = computeBuyCommit({
      buyerKey,
      launchId: LAUNCH_ID,
      tokenAmount,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });

    const r = d.contract.circuits.submitBuyCommit(d.ctx, commitment, 1n);
    const state = ledger(r.context.currentQueryContext.state);
    expect(state.dvTotalParticipants).toBe(1n);
    // Nothing about tokenAmount appears anywhere in public state at this point.
    expect(state.totalTokensCommitted).toBe(0n);
  });

  it('T-AUDIT fix (2026-07-21, High): rejects a second buy commitment from the same identity, even with a different commitment hash', () => {
    // Before the fix, the buy nullifier was a free caller-supplied
    // parameter — a single registrant could submit unlimited buy
    // commitments simply by choosing a fresh nullifier value each time,
    // capturing up to walletCap instead of their fair per-registrant share.
    // Now the nullifier is derived in-circuit from the caller's own secret
    // key, so a second submission from the same identity always collides
    // on the same derived nullifier automatically.
    const d = deployAndStartDvBuying();
    const buyerKey = deriveUserPublicKey(fakeBytes32(3));
    const commitment1 = computeBuyCommit({
      buyerKey, launchId: LAUNCH_ID, tokenAmount: 10n, pricePerToken: DV_PRICE, nonce: BUY_NONCE,
    });
    const r1 = d.contract.circuits.submitBuyCommit(d.ctx, commitment1, 1n);
    const ctx1 = nextContext(d.contractAddress, r1.context);

    const commitment2 = computeBuyCommit({
      buyerKey, launchId: LAUNCH_ID, tokenAmount: 20n, pricePerToken: DV_PRICE, nonce: BUY_NONCE,
    });
    expect(() =>
      d.contract.circuits.submitBuyCommit(ctx1, commitment2, 2n),
    ).toThrow(/already bought/i);
  });

  it('T25 follow-up FIXED: revealBuyCommit requires real NIGHT payment (receiveUnshielded wired in, does not throw locally)', () => {
    // Same simulator caveat as every other receiveUnshielded regression
    // test in this suite (see T40's tests) — the local compact-runtime
    // simulator doesn't model cross-transaction UTXO matching, so this
    // proves the call is wired in structurally, not that a missing
    // payment is rejected end-to-end against a live network.
    const d = deployAndStartDvBuying();
    const buyerKey = deriveUserPublicKey(fakeBytes32(3));
    const tokenAmount = 50n;
    const commitment = computeBuyCommit({
      buyerKey,
      launchId: LAUNCH_ID,
      tokenAmount,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });
    const r1 = d.contract.circuits.submitBuyCommit(d.ctx, commitment, 1n);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    const r2 = d.contract.circuits.closeDarkVeil(ctx1, 2n, 100n);
    const ctx2 = nextContext(d.contractAddress, r2.context);

    const grossPayment = tokenAmount * DV_PRICE;
    const { creator, treasury, ops } = fees(grossPayment);
    const r3 = d.contract.circuits.revealBuyCommit(ctx2, commitment, tokenAmount, DV_PRICE, creator, treasury, ops);
    const state = ledger(r3.context.currentQueryContext.state);
    expect(state.totalTokensCommitted).toBe(tokenAmount);
    expect(state.totalRaisedCommitted).toBe(grossPayment);
    // T-AUDIT fix (2026-07-21): the Critical fix — DarkVeil proceeds must
    // now flow into the SAME real accumulators graduateLp/withdrawFees pay
    // out, not just the gross-statistic totalRaisedCommitted.
    expect(state.creatorFees).toBe(creator);
    expect(state.treasuryFees).toBe(treasury);
    expect(state.opsFees).toBe(ops);
    expect(state.totalRaised).toBe(grossPayment - creator - treasury - ops);
  });

  it('T25 follow-up FIXED: revealBuyCommit enforces the 5% cumulative cap', () => {
    // Sets a tight wallet cap for this one test so a single DarkVeil buy
    // can actually exceed it, proving the cap check inside revealBuyCommit
    // (not just buyTokens) is real.
    const witnessesTight: Witnesses<PrivateState> = { ...witnesses };
    const contract = new Contract<PrivateState>(witnessesTight);
    const tightCap = 40n; // less than the 50-token DV allocation this test attempts
    const { contractAddress, ctx } = deployForTest(
      contract,
      undefined,
      LAUNCH_ID,
      ALLOWLIST_TREE.root,
      TOTAL_SUPPLY,
      MAX_WALLET_PERCENT,
      BOND_AMOUNT,
      tightCap,
      BASE_PRICE,
      MAX_PRICE,
      CURVE_SUPPLY,
      DV_ALLOCATION,
      DV_PRICE,
      ALLOWLIST_SIZE,
      REGISTRATION_CLOSE_TIME,
      MIN_DV_PARTICIPANTS_TEST,
      CREATOR_KEY,
      TREASURY_ADDR,
      OPS_ADDR,
      CREATOR_ADDR,
      LP_ESCROW_ADDR,
    );
    // Phase 4 fix: submitBuyCommit now requires proof of prior registration.
    const r0 = contract.circuits.advancePhase(ctx, LaunchPhase.DarkVeil);
    const ctx0 = nextContext(contractAddress, r0.context);
    const r1 = contract.circuits.startRegistration(ctx0);
    const ctx1 = nextContext(contractAddress, r1.context);
    // T-AUDIT fix (2026-07-21): registerForDarkVeil now requires
    // dvState == Registration, so this must happen after startRegistration.
    const rReg = contract.circuits.registerForDarkVeil(ctx1, fakeBytes32(7));
    const ctxReg = nextContext(contractAddress, rReg.context);
    const r2 = contract.circuits.startBuying(ctxReg);
    const ctx2 = nextContext(contractAddress, r2.context);

    const buyerKey = deriveUserPublicKey(fakeBytes32(3));
    const tokenAmount = 50n; // exceeds tightCap (40)
    const commitment = computeBuyCommit({
      buyerKey,
      launchId: LAUNCH_ID,
      tokenAmount,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });
    const r3 = contract.circuits.submitBuyCommit(ctx2, commitment, 1n);
    const ctx3 = nextContext(contractAddress, r3.context);
    const r4 = contract.circuits.closeDarkVeil(ctx3, 2n, 100n);
    const ctx4 = nextContext(contractAddress, r4.context);

    const { creator: tightCreator, treasury: tightTreasury, ops: tightOps } = fees(tokenAmount * DV_PRICE);
    expect(() =>
      contract.circuits.revealBuyCommit(ctx4, commitment, tokenAmount, DV_PRICE, tightCreator, tightTreasury, tightOps),
    ).toThrow();
  });

  it('Phase 2 regression: revealBuyCommit rejects a reveal exceeding the per-registrant baseSlot, even within the pool-wide dvAllocation and wallet cap', () => {
    // Security-audit fix (Phase 2): before this fix, Tier C's merged
    // revealBuyCommit set/read baseSlot for the ratio-refund formula but
    // never enforced it as a purchase-time ceiling — only the pool-wide
    // dvAllocation and the (generous, default) wallet cap were checked.
    // Uses the default (non-tight) walletCap/deploy() so this rejection is
    // driven specifically by baseSlot, not incidentally by the wallet cap
    // (unlike the tightCap test above).
    const d = deployAndStartDvBuying();
    const buyerKey = deriveUserPublicKey(fakeBytes32(3));
    const tokenAmount = 50n; // exceeds baseSlot (40) but well within dvAllocation (500) and WALLET_CAP (50,000,000)
    const commitment = computeBuyCommit({
      buyerKey,
      launchId: LAUNCH_ID,
      tokenAmount,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });
    const r1 = d.contract.circuits.submitBuyCommit(d.ctx, commitment, 1n);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    const r2 = d.contract.circuits.closeDarkVeil(ctx1, 2n, 40n); // baseSlot=40, less than tokenAmount=50
    const ctx2 = nextContext(d.contractAddress, r2.context);

    const { creator: baseSlotCreator, treasury: baseSlotTreasury, ops: baseSlotOps } = fees(tokenAmount * DV_PRICE);
    expect(() =>
      d.contract.circuits.revealBuyCommit(ctx2, commitment, tokenAmount, DV_PRICE, baseSlotCreator, baseSlotTreasury, baseSlotOps),
    ).toThrow();
  });

  it('T25 follow-up FIXED: a DarkVeil reveal and a later public buyTokens share the same cumulativePurchases entry', () => {
    // The core regression this fix exists for: before it, DarkVeil
    // purchases were never counted toward the cap at all. Now a DV reveal
    // followed by a public buy for the SAME identity must respect the
    // combined total.
    const d = deployAndStartDvBuying();
    const buyerKey = deriveUserPublicKey(fakeBytes32(3));
    const dvAmount = 30n;
    const commitment = computeBuyCommit({
      buyerKey,
      launchId: LAUNCH_ID,
      tokenAmount: dvAmount,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });
    const r1 = d.contract.circuits.submitBuyCommit(d.ctx, commitment, 1n);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    const r2 = d.contract.circuits.closeDarkVeil(ctx1, 2n, 100n);
    const ctx2 = nextContext(d.contractAddress, r2.context);
    const { creator: dvCreator, treasury: dvTreasury, ops: dvOps } = fees(dvAmount * DV_PRICE);
    const r3 = d.contract.circuits.revealBuyCommit(ctx2, commitment, dvAmount, DV_PRICE, dvCreator, dvTreasury, dvOps);
    const ctx3 = nextContext(d.contractAddress, r3.context);

    // checkCap (read-only) confirms the DV reveal already counted toward
    // this buyer's cumulative total, via the exact same map buyTokens uses.
    const capAfterDv = d.contract.circuits.checkCap(ctx3, buyerKey);
    expect(capAfterDv.result).toBe(dvAmount);

    // Advance to Public and activate the curve, then buy — cumulative
    // total must now include BOTH the DV reveal and this public buy.
    const r4 = d.contract.circuits.advancePhase(ctx3, LaunchPhase.Public);
    const ctx4 = nextContext(d.contractAddress, r4.context);
    const r5 = d.contract.circuits.activateCurve(ctx4, 1000n);
    const ctx5 = nextContext(d.contractAddress, r5.context);

    const claimedPrice = expectedPrice(0n);
    const publicAmount = 10n;
    const grossPayment = publicAmount * claimedPrice;
    const { creator, treasury, ops } = fees(grossPayment);
    const r6 = d.contract.circuits.buyTokens(ctx5, publicAmount, claimedPrice, grossPayment, creator, treasury, ops, 3n);
    const ctx6 = nextContext(d.contractAddress, r6.context);

    const capAfterPublic = d.contract.circuits.checkCap(ctx6, buyerKey);
    expect(capAfterPublic.result).toBe(dvAmount + publicAmount);
  });

  it('cancelBuyCommit works before DarkVeil closes, decrements participant count', () => {
    const d = deployAndStartDvBuying();
    const buyerKey = deriveUserPublicKey(fakeBytes32(3));
    const commitment = computeBuyCommit({
      buyerKey,
      launchId: LAUNCH_ID,
      tokenAmount: 50n,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });
    const r1 = d.contract.circuits.submitBuyCommit(d.ctx, commitment, 1n);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    expect(ledger(r1.context.currentQueryContext.state).dvTotalParticipants).toBe(1n);

    const r2 = d.contract.circuits.cancelBuyCommit(ctx1, commitment);
    expect(ledger(r2.context.currentQueryContext.state).dvTotalParticipants).toBe(0n);
  });

  it('closeDarkVeil generates a FairLaunchCert and transitions dvState to Closed', () => {
    const d = deployAndStartDvBuying();
    const r = d.contract.circuits.closeDarkVeil(d.ctx, 12345n, 100n);
    const state = ledger(r.context.currentQueryContext.state);
    expect(state.dvState).toBe(DarkVeilState.Closed);
    expect(state.fairLaunchCert.closeTimestamp).toBe(12345n);
  });

  it('T-AUDIT fix (2026-07-21, Medium): rejects a baseSlot whose total (baseSlot * registrationCount) exceeds dvAllocation', () => {
    // deployAndStartDvBuying registers exactly 1 participant, so any
    // baseSlot above DV_ALLOCATION (500) collectively promises more than
    // the pool actually reserves. Same fix as eligibility_gate.compact.
    const d = deployAndStartDvBuying();
    expect(() =>
      d.contract.circuits.closeDarkVeil(d.ctx, 12345n, DV_ALLOCATION + 1n),
    ).toThrow(/exceeds dvAllocation/i);
  });

  it('T-AUDIT fix (2026-07-21, Medium): rejects registration once dvState has moved past Registration, even though phase is still DarkVeil', () => {
    const d = deploy();
    const r0 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
    const ctx0 = nextContext(d.contractAddress, r0.context);
    const r1 = d.contract.circuits.startRegistration(ctx0);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    const rReg = d.contract.circuits.registerForDarkVeil(ctx1, fakeBytes32(7));
    const ctxReg = nextContext(d.contractAddress, rReg.context);
    const rBuying = d.contract.circuits.startBuying(ctxReg);
    const ctxBuying = nextContext(d.contractAddress, rBuying.context);

    const lateRegistrant = new Contract<PrivateState>({
      getUserSecret: (_ctx) => [undefined, { bytes: fakeBytes32(3) }],
      getMerkleProof: (_ctx) => [undefined, ALLOWLIST_TREE.getProof(0)],
      getRegistrationNonce: (_ctx) => [undefined, fakeBytes32(6)],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
      getBuyNonce: (_ctx) => [undefined, BUY_NONCE],
    });
    expect(() => lateRegistrant.circuits.registerForDarkVeil(ctxBuying, fakeBytes32(21))).toThrow(/registration sub-phase/i);
  });

  it('rejects revealBuyCommit before DarkVeil is closed', () => {
    const d = deployAndStartDvBuying();
    const buyerKey = deriveUserPublicKey(fakeBytes32(3));
    const commitment = computeBuyCommit({
      buyerKey,
      launchId: LAUNCH_ID,
      tokenAmount: 50n,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });
    const r1 = d.contract.circuits.submitBuyCommit(d.ctx, commitment, 1n);
    const ctx1 = nextContext(d.contractAddress, r1.context);

    const { creator: notClosedCreator, treasury: notClosedTreasury, ops: notClosedOps } = fees(50n * DV_PRICE);
    expect(() =>
      d.contract.circuits.revealBuyCommit(ctx1, commitment, 50n, DV_PRICE, notClosedCreator, notClosedTreasury, notClosedOps),
    ).toThrow();
  });

  it('rejects a DarkVeil buy exceeding the total dvAllocation pool', () => {
    const d = deployAndStartDvBuying();
    const buyerKey = deriveUserPublicKey(fakeBytes32(3));
    const overAmount = DV_ALLOCATION + 1n;
    const commitment = computeBuyCommit({
      buyerKey,
      launchId: LAUNCH_ID,
      tokenAmount: overAmount,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });
    const r1 = d.contract.circuits.submitBuyCommit(d.ctx, commitment, 1n);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    const r2 = d.contract.circuits.closeDarkVeil(ctx1, 2n, 100n);
    const ctx2 = nextContext(d.contractAddress, r2.context);

    const { creator: overCreator, treasury: overTreasury, ops: overOps } = fees(overAmount * DV_PRICE);
    expect(() =>
      d.contract.circuits.revealBuyCommit(ctx2, commitment, overAmount, DV_PRICE, overCreator, overTreasury, overOps),
    ).toThrow();
  });
});

describe('bonding_curve.compact — T43: ratio-based NIGHT bond refund', () => {
  /** Registers, submits + reveals a DV buy for `purchased` tokens, closes DarkVeil with `baseSlot`. */
  function registerBuyAndClose(purchased: bigint, baseSlot: bigint) {
    const d = deploy();
    const r0 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
    const ctx0 = nextContext(d.contractAddress, r0.context);
    const r1 = d.contract.circuits.startRegistration(ctx0);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    // T-AUDIT fix (2026-07-21): registerForDarkVeil now requires
    // dvState == Registration, so this must happen after startRegistration.
    const rReg1 = d.contract.circuits.registerForDarkVeil(ctx1, fakeBytes32(7));
    const ctxReg1 = nextContext(d.contractAddress, rReg1.context);
    const r3 = d.contract.circuits.startBuying(ctxReg1);
    let ctx = nextContext(d.contractAddress, r3.context);

    if (purchased > 0n) {
      const buyerKey = deriveUserPublicKey(fakeBytes32(3));
      const commitment = computeBuyCommit({
        buyerKey,
        launchId: LAUNCH_ID,
        tokenAmount: purchased,
        pricePerToken: DV_PRICE,
        nonce: BUY_NONCE,
      });
      const r4 = d.contract.circuits.submitBuyCommit(ctx, commitment, 1n);
      ctx = nextContext(d.contractAddress, r4.context);
      const r5 = d.contract.circuits.closeDarkVeil(ctx, 2n, baseSlot);
      ctx = nextContext(d.contractAddress, r5.context);
      const { creator: purchasedCreator, treasury: purchasedTreasury, ops: purchasedOps } = fees(purchased * DV_PRICE);
      const r6 = d.contract.circuits.revealBuyCommit(ctx, commitment, purchased, DV_PRICE, purchasedCreator, purchasedTreasury, purchasedOps);
      ctx = nextContext(d.contractAddress, r6.context);
    } else {
      // Ghost registrant — never submits or reveals anything.
      const r4 = d.contract.circuits.closeDarkVeil(ctx, 2n, baseSlot);
      ctx = nextContext(d.contractAddress, r4.context);
    }

    return { contract: d.contract, contractAddress: d.contractAddress, ctx };
  }

  it('bought 100% of baseSlot -> full bond refund', () => {
    const { contract, ctx } = registerBuyAndClose(100n, 100n);
    const claimedRefund = (BOND_AMOUNT * 100n) / 100n; // 1000 — floor is exact here
    const treasuryShare = 0n; // forfeited = 1000 - 1000 = 0
    expect(() => contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(5), claimedRefund, treasuryShare)).not.toThrow();
  });

  it('Phase 5 hygiene fix: claimRatioBondRefund rejects an empty (all-zero) recipient address', () => {
    const { contract, ctx } = registerBuyAndClose(100n, 100n);
    const claimedRefund = (BOND_AMOUNT * 100n) / 100n;
    const treasuryShare = 0n;
    expect(() => contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(0), claimedRefund, treasuryShare)).toThrow();
  });

  it('bought 50% of baseSlot -> half bond refund, floor-exact, forfeited half split 60/40', () => {
    const { contract, ctx } = registerBuyAndClose(50n, 100n);
    const claimedRefund = (BOND_AMOUNT * 50n) / 100n; // 500
    const treasuryShare = (500n * 60n) / 100n; // 300 — forfeited(500) * 60%
    expect(() => contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(5), claimedRefund, treasuryShare)).not.toThrow();
  });

  it('ghost registrant (bought 0%) -> zero refund, entire bond forfeited and split 60/40', () => {
    const { contract, ctx } = registerBuyAndClose(0n, 100n);
    const treasuryShare = (BOND_AMOUNT * 60n) / 100n; // 600 — forfeited(1000) * 60%
    expect(() => contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(5), 0n, treasuryShare)).not.toThrow();
  });

  it('accepts the correct FLOOR refund at a non-exact division (T39-style floor-rounding)', () => {
    // bond=1000, purchased=37, baseSlot=90: true value = 1000*37/90 = 411.11...
    const { contract, ctx } = registerBuyAndClose(37n, 90n);
    const floorRefund = (BOND_AMOUNT * 37n) / 90n; // 411 (bigint division truncates = floor for positives)
    expect(floorRefund).toBe(411n);
    const forfeited = BOND_AMOUNT - floorRefund; // 589
    const treasuryShare = (forfeited * 60n) / 100n; // floor(589*0.6) = 353
    expect(() => contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(5), floorRefund, treasuryShare)).not.toThrow();
  });

  it('rejects a refund claim one unit above the correct floor', () => {
    const { contract, ctx } = registerBuyAndClose(37n, 90n);
    const floorRefund = (BOND_AMOUNT * 37n) / 90n; // 411
    expect(() => contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(5), floorRefund + 1n, 0n)).toThrow();
  });

  it('rejects a refund claim below the correct floor', () => {
    const { contract, ctx } = registerBuyAndClose(37n, 90n);
    const floorRefund = (BOND_AMOUNT * 37n) / 90n; // 411
    expect(() => contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(5), floorRefund - 1n, 0n)).toThrow();
  });

  it('rejects an incorrect treasury share for an otherwise-correct refund claim', () => {
    // T33 regression: claimedRefund is right, but claimedTreasuryShare is
    // not the floor of forfeited*60% — must be rejected independently of
    // the refund check.
    const { contract, ctx } = registerBuyAndClose(50n, 100n);
    const claimedRefund = (BOND_AMOUNT * 50n) / 100n; // 500
    const wrongTreasuryShare = 301n; // correct floor is 300
    expect(() =>
      contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(5), claimedRefund, wrongTreasuryShare),
    ).toThrow();
  });

  it('rejects claiming twice for the same bond', () => {
    const { contract, contractAddress, ctx } = registerBuyAndClose(50n, 100n);
    const claimedRefund = (BOND_AMOUNT * 50n) / 100n;
    const treasuryShare = (500n * 60n) / 100n; // 300
    const r1 = contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(5), claimedRefund, treasuryShare);
    const ctx2 = nextContext(contractAddress, r1.context);

    expect(() => contract.circuits.claimRatioBondRefund(ctx2, fakeBytes32(5), claimedRefund, treasuryShare)).toThrow();
  });

  it('rejects claimRatioBondRefund when DarkVeil failed (must use claimBondRefund instead)', () => {
    const d = deploy();
    const r0 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
    const ctx0 = nextContext(d.contractAddress, r0.context);
    const r1 = d.contract.circuits.startRegistration(ctx0);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    const rReg = d.contract.circuits.registerForDarkVeil(ctx1, fakeBytes32(7));
    const ctxReg = nextContext(d.contractAddress, rReg.context);
    const r2 = d.contract.circuits.advancePhase(ctxReg, LaunchPhase.Public);
    const ctx2 = nextContext(d.contractAddress, r2.context);
    const r3 = d.contract.circuits.markDarkVeilFailed(ctx2);
    const ctx3 = nextContext(d.contractAddress, r3.context);

    expect(() => d.contract.circuits.claimRatioBondRefund(ctx3, fakeBytes32(5), 0n, 0n)).toThrow();
  });

  it('rejects claimRatioBondRefund before DarkVeil has closed', () => {
    const d = deploy();
    const r0 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
    const ctx0 = nextContext(d.contractAddress, r0.context);
    const r1 = d.contract.circuits.startRegistration(ctx0);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    const rReg = d.contract.circuits.registerForDarkVeil(ctx1, fakeBytes32(7));
    const ctxReg = nextContext(d.contractAddress, rReg.context);
    const r3 = d.contract.circuits.startBuying(ctxReg);
    const ctx3 = nextContext(d.contractAddress, r3.context);

    expect(() => d.contract.circuits.claimRatioBondRefund(ctx3, fakeBytes32(5), 0n, 0n)).toThrow();
  });
});

describe('bonding_curve.compact — the design requirement: withdrawFees and graduateLp actually pay out', () => {
  /** Buys the whole curve so it graduates, accruing real fees along the way. */
  function deployActivateAndGraduate() {
    const d = deployAndActivate();
    const claimedPrice = expectedPrice(0n);
    const grossPayment = CURVE_SUPPLY * claimedPrice;
    const { creator, treasury, ops } = fees(grossPayment);
    const r = d.contract.circuits.buyTokens(d.ctx, CURVE_SUPPLY, claimedPrice, grossPayment, creator, treasury, ops, 1n);
    const ctx = nextContext(d.contractAddress, r.context);
    return { ...d, ctx, creatorFees: creator, treasuryFees: treasury, opsFees: ops };
  }

  it('withdrawFees pays out via sendUnshielded and zeroes the claimed amounts (governor only)', () => {
    const { contract, contractAddress, ctx, creatorFees, treasuryFees, opsFees } = deployActivateAndGraduate();

    // Design requirement: before this fix, withdrawFees only
    // decremented these counters with no sendUnshielded call at all —
    // fees were permanently stuck. Proving it doesn't throw here confirms
    // the sendUnshielded calls are wired in (same simulator caveat as
    // every other receiveUnshielded/sendUnshielded test in this file: the
    // local runtime doesn't model cross-transaction UTXO matching, so this
    // proves the calls are structurally present, not end-to-end verified
    // against a live network).
    const r = contract.circuits.withdrawFees(ctx, creatorFees, treasuryFees, opsFees);
    const state = ledger(r.context.currentQueryContext.state);
    expect(state.creatorFees).toBe(0n);
    expect(state.treasuryFees).toBe(0n);
    expect(state.opsFees).toBe(0n);
  });

  it('withdrawFees rejects a non-governor caller', () => {
    const { contractAddress, ctx, creatorFees, treasuryFees, opsFees } = deployActivateAndGraduate();
    const nonGovernorWitnesses: Witnesses<PrivateState> = {
      ...witnesses,
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(99) }],
    };
    const otherContract = new Contract<PrivateState>(nonGovernorWitnesses);
    expect(() =>
      otherContract.circuits.withdrawFees(ctx, creatorFees, treasuryFees, opsFees),
    ).toThrow();
    void contractAddress;
  });

  it('withdrawFees rejects an amount exceeding the accrued fee balance', () => {
    const { contract, ctx, creatorFees } = deployActivateAndGraduate();
    expect(() => contract.circuits.withdrawFees(ctx, creatorFees + 1n, 0n, 0n)).toThrow();
  });

  it('Phase 2 regression: withdrawFees rejects on a cancelled curve (double-drain fix)', () => {
    // Security-audit fix (Phase 2): before this fix, withdrawFees had no
    // curveState guard at all — claimCurveRefund pays cancelled-curve
    // buyers their FULL gross (fee-inclusive) payment back, so the
    // governor could separately withdraw the same fees against the same
    // underlying NIGHT balance. A cancelled curve's fees are now void.
    const { contract, contractAddress, ctx } = deployAndActivate();
    const price = expectedPrice(0n);
    const gross = 10n * price;
    const { creator, treasury, ops } = fees(gross);
    const r1 = contract.circuits.buyTokens(ctx, 10n, price, gross, creator, treasury, ops, 1n);
    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.cancelCurve(ctx2);
    const ctx3 = nextContext(contractAddress, r2.context);

    expect(() => contract.circuits.withdrawFees(ctx3, creator, treasury, ops)).toThrow();
  });

  it('triggerCTO succeeds with governor signature and sets ctoTriggered/communityWallet', () => {
    const { contract, ctx } = deployActivateAndGraduate();
    const r = contract.circuits.triggerCTO(ctx, fakeBytes32(70));
    const state = ledger(r.context.currentQueryContext.state);
    expect(state.ctoTriggered).toBe(true);
    expect(state.communityWallet).toEqual(fakeBytes32(70));
  });

  it('triggerCTO rejects a non-governor caller', () => {
    const { ctx } = deployActivateAndGraduate();
    const nonGovernorWitnesses: Witnesses<PrivateState> = {
      ...witnesses,
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(99) }],
    };
    const otherContract = new Contract<PrivateState>(nonGovernorWitnesses);
    expect(() => otherContract.circuits.triggerCTO(ctx, fakeBytes32(70))).toThrow();
  });

  it('triggerCTO rejects being triggered twice', () => {
    const { contract, contractAddress, ctx } = deployActivateAndGraduate();
    const r1 = contract.circuits.triggerCTO(ctx, fakeBytes32(70));
    const ctx2 = nextContext(contractAddress, r1.context);
    expect(() => contract.circuits.triggerCTO(ctx2, fakeBytes32(71))).toThrow();
  });

  it('Phase 5 hygiene fix: triggerCTO rejects an empty (all-zero) community wallet address', () => {
    const { contract, ctx } = deployActivateAndGraduate();
    expect(() => contract.circuits.triggerCTO(ctx, fakeBytes32(0))).toThrow();
  });

  it('dissolveCTO succeeds with governor signature and resets ctoTriggered/communityWallet', () => {
    const { contract, contractAddress, ctx } = deployActivateAndGraduate();
    const r1 = contract.circuits.triggerCTO(ctx, fakeBytes32(70));
    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.dissolveCTO(ctx2);
    const state = ledger(r2.context.currentQueryContext.state);
    expect(state.ctoTriggered).toBe(false);
  });

  it('dissolveCTO rejects if CTO was never triggered', () => {
    const { contract, ctx } = deployActivateAndGraduate();
    expect(() => contract.circuits.dissolveCTO(ctx)).toThrow();
  });

  it('CTO fee-redirect fix regression: withdrawFees still succeeds once a CTO has been triggered — the exact gap this fix closes (this contract previously had no CTO concept at all, so a passed CTO vote never redirected the creator fee share)', () => {
    const { contract, contractAddress, ctx, creatorFees, treasuryFees, opsFees } = deployActivateAndGraduate();
    const r1 = contract.circuits.triggerCTO(ctx, fakeBytes32(70));
    const ctx2 = nextContext(contractAddress, r1.context);
    // Same simulator caveat as the base withdrawFees test above: proves the
    // redirected sendUnshielded call is wired in structurally (governor can
    // still call withdrawFees, and it still zeroes the accrued balances),
    // not that fakeBytes32(70) specifically received the NIGHT — the local
    // runtime doesn't model cross-transaction UTXO matching.
    const r3 = contract.circuits.withdrawFees(ctx2, creatorFees, treasuryFees, opsFees);
    const state = ledger(r3.context.currentQueryContext.state);
    expect(state.creatorFees).toBe(0n);
    expect(state.communityWallet).toEqual(fakeBytes32(70));
  });

  it('graduateLp pays out totalRaised via sendUnshielded exactly once (lpSeeded replay guard)', () => {
    const { contract, contractAddress, ctx } = deployActivateAndGraduate();
    expect(ledger(ctx.currentQueryContext.state).curveState).toBe(CurveState.Graduated);

    const r1 = contract.circuits.graduateLp(ctx);
    expect(ledger(r1.context.currentQueryContext.state).lpSeeded).toBe(true);
    const ctx2 = nextContext(contractAddress, r1.context);

    // Design requirement: lpSeeded must prevent a second call
    // from re-draining totalRaised.
    expect(() => contract.circuits.graduateLp(ctx2)).toThrow();
  });

  it('graduateLp rejects a curve that has not graduated yet', () => {
    const { contract, ctx } = deployAndActivate(); // not graduated — no buys yet
    expect(() => contract.circuits.graduateLp(ctx)).toThrow();
  });
});
