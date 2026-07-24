import { describe, it, expect } from 'vitest';
import { Contract, ledger, LaunchPhase, DarkVeilState, type Witnesses } from '../compiled/eligibility_gate/contract/index.js';
import { deployForTest, nextContext, fakeBytes32 } from './helpers.js';
import { buildAllowlistTree, deriveUserPublicKey, hashAllowlistLeaf } from '../../../packages/zk-proofs/src/eligibility-gate.js';
import { computeBuyCommit } from '../../../packages/zk-proofs/src/darkveil.js';

type PrivateState = undefined;

// T42 fix (2026-07-09): verifyAllowlist() now does real Merkle verification
// (see contracts/midnight/eligibility_gate.compact and
// packages/zk-proofs/tests/allowlist-merkle.test.ts for the dedicated
// adversarial suite) — these tests need a real allowlist tree the witness
// proof actually matches, not an arbitrary root + garbage proof.
//
// Design requirement: the leaf is no longer a free witness — it's
// derived in-circuit as hashAllowlistLeaf(caller), so the tree must be
// built with that same formula for the registrant's real derived identity
// (fakeBytes32(3)), not an arbitrary opaque value.
const REGISTRANT_KEY = deriveUserPublicKey(fakeBytes32(3));
const ALLOWLIST_LEAF = hashAllowlistLeaf(REGISTRANT_KEY);
const ALLOWLIST_TREE = buildAllowlistTree([ALLOWLIST_LEAF]);
const BUY_NONCE = fakeBytes32(8);

// Phase 2 security-audit fix (2026-07-11): darkveil.compact merged into
// this file (mirrors T25's Tier C merge) — getBuyNonce is now part of this
// contract's own witness set.
const witnesses: Witnesses<PrivateState> = {
  getUserSecret: (_ctx) => [undefined, { bytes: fakeBytes32(3) }],
  getMerkleProof: (_ctx) => [undefined, ALLOWLIST_TREE.getProof(0)],
  getRegistrationNonce: (_ctx) => [undefined, fakeBytes32(6)],
  getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
  getBuyNonce: (_ctx) => [undefined, BUY_NONCE],
};

const TOTAL_SUPPLY = 1_000_000_000n;
const MAX_WALLET_PERCENT = 5n;
const CORRECT_WALLET_CAP = (TOTAL_SUPPLY * MAX_WALLET_PERCENT) / 100n; // 50,000,000

// DarkVeil-side constructor args (from the retired darkveil.compact)
const DV_ALLOCATION = 500n;
const DV_PRICE = 90n;
const ALLOWLIST_SIZE = 1n;
const REGISTRATION_CLOSE_TIME = 1_000_000n;
// T37: permissive by default (1n) so pre-existing tests below, which only
// ever register 1 registrant via REGISTRANT_KEY, aren't broken by the new
// minimum-participant floor. Dedicated tests further down deploy with a
// real threshold to exercise the floor itself.
const MIN_DV_PARTICIPANTS_TEST = 1n;
const LAUNCH_ID = fakeBytes32(9);

// T32: creator's identity, distinct from the regular registrant secret
// (fakeBytes32(3)) every other test in this file uses. deriveUserPublicKey
// here is the raw off-chain mirror (Uint8Array in, Uint8Array out) — not
// the UserSecretKey/UserPublicKey struct wrapper the witness type uses.
const CREATOR_SECRET_BYTES = fakeBytes32(42);
const CREATOR_KEY = deriveUserPublicKey(CREATOR_SECRET_BYTES);

// T33-equivalent: fixed payout addresses for the forfeited portion of a
// ratio-based bond refund — real unshielded addresses, not derived
// identities, so plain fakeBytes32 is fine.
const TREASURY_ADDR = fakeBytes32(60);
const OPS_ADDR = fakeBytes32(40);

function deploy(walletCap: bigint = CORRECT_WALLET_CAP) {
  const contract = new Contract<PrivateState>(witnesses);
  const { init, contractAddress, ctx } = deployForTest(
    contract,
    undefined,
    LAUNCH_ID,
    ALLOWLIST_TREE.root, // allowlistRoot
    TOTAL_SUPPLY,
    MAX_WALLET_PERCENT,
    1000n, // bondAmount
    walletCap,
    DV_ALLOCATION,
    DV_PRICE,
    ALLOWLIST_SIZE,
    REGISTRATION_CLOSE_TIME,
    MIN_DV_PARTICIPANTS_TEST,
    CREATOR_KEY,
    TREASURY_ADDR,
    OPS_ADDR,
  );
  return { contract, init, contractAddress, ctx };
}

// T-AUDIT fix (2026-07-21): registerForDarkVeil now requires
// dvState == Registration (not just phase == DarkVeil), so this helper
// also calls startRegistration() — every caller of this helper registers
// afterward.
function deployAndStartDarkVeil() {
  const d = deploy();
  const r0 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
  const ctx0 = nextContext(d.contractAddress, r0.context);
  const r1 = d.contract.circuits.startRegistration(ctx0);
  const ctx = nextContext(d.contractAddress, r1.context);
  return { ...d, ctx };
}

/**
 * Drives dvState through Inactive -> Registration -> Buying (independent of
 * `phase` — see DarkVeilState's comment). Also registers the default buyer
 * (REGISTRANT_KEY, matching the shared `witnesses` object) for DarkVeil —
 * Phase 4 fix (2026-07-12): submitBuyCommit now requires proof of prior
 * registration (a recomputed registration nullifier), so every test built
 * on this helper needs a real registration behind it, not just an active
 * buying phase.
 */
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

describe('eligibility_gate.compact — wallet cap math (CRITICAL regression)', () => {
  it('IMPORTANT FINDING (fixed): walletCap constructor arg is honored exactly, no on-chain multiplication', () => {
    // Before the 2026-07-09 fix, the constructor computed
    // `walletCap = totalSupply * maxWalletPercent` with NO division by 100
    // at all, despite its own comment describing the /100 formula and a
    // worked example. For totalSupply=1,000,000,000 and maxWalletPercent=5,
    // that bug would have produced walletCap = 5,000,000,000 — five times
    // the ENTIRE token supply, silently disabling the 5% anti-whale cap
    // almost completely (no purchase could ever exceed a cap bigger than
    // total supply). The fix makes walletCap an explicit constructor
    // argument the deployer must compute off-chain and pass in correctly.
    const buggyWalletCapWouldHaveBeen = TOTAL_SUPPLY * MAX_WALLET_PERCENT; // 5,000,000,000
    const { init } = deploy(CORRECT_WALLET_CAP);
    // No direct ledger field exposes walletCap (it's sealed), so we prove
    // it's the correct value indirectly via revealBuyCommit's boundary
    // behavior in the "wallet cap enforcement via revealBuyCommit" describe
    // block below. This test just documents the magnitude of what the bug
    // would have produced, for the record.
    expect(buggyWalletCapWouldHaveBeen).toBe(5_000_000_000n);
    expect(CORRECT_WALLET_CAP).toBe(50_000_000n);
    expect(init.currentContractState).toBeDefined();
  });
});

// Phase 4 (2026-07-12): checkAndUpdateCap was a standalone circuit nothing
// in this contract called — revealBuyCommit already enforces the identical
// 5% cumulative wallet cap inline (see its own "Bonus fix (this merge)"
// comment), so the standalone circuit was dead code and has been removed.
// These tests port the boundary coverage the old checkAndUpdateCap tests
// provided onto the real enforcement path instead of losing it.
//
// dvAllocation and baseSlot are deployed generously large in every test
// below so the pool-wide and per-registrant caps are never the binding
// constraint — only walletCap is under test.
describe('eligibility_gate.compact — wallet cap enforcement via revealBuyCommit (ported from removed checkAndUpdateCap)', () => {
  const BIG_DV_ALLOCATION = 200_000_000n; // well above 2x CORRECT_WALLET_CAP
  const BIG_BASE_SLOT = 100_000_000n; // above CORRECT_WALLET_CAP alone

  function revealAt(
    tree: ReturnType<typeof buildAllowlistTree>,
    secretBytes: Uint8Array,
    tokenAmount: bigint,
    allowlistIndex: number,
    allowlistSize: bigint,
  ) {
    const buyerKey = deriveUserPublicKey(secretBytes);
    const capWitnesses: Witnesses<PrivateState> = {
      getUserSecret: (_ctx) => [undefined, { bytes: secretBytes }],
      getMerkleProof: (_ctx) => [undefined, tree.getProof(allowlistIndex)],
      getRegistrationNonce: (_ctx) => [undefined, fakeBytes32(6)],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
      getBuyNonce: (_ctx) => [undefined, BUY_NONCE],
    };
    const contract = new Contract<PrivateState>(capWitnesses);
    const { contractAddress, ctx } = deployForTest(
      contract,
      undefined,
      LAUNCH_ID,
      tree.root,
      TOTAL_SUPPLY,
      MAX_WALLET_PERCENT,
      1000n,
      CORRECT_WALLET_CAP,
      BIG_DV_ALLOCATION,
      DV_PRICE,
      allowlistSize,
      REGISTRATION_CLOSE_TIME,
      MIN_DV_PARTICIPANTS_TEST,
      CREATOR_KEY,
      TREASURY_ADDR,
      OPS_ADDR,
    );
    const r0 = contract.circuits.advancePhase(ctx, LaunchPhase.DarkVeil);
    const ctx0 = nextContext(contractAddress, r0.context);
    const r1 = contract.circuits.startRegistration(ctx0);
    const ctx1 = nextContext(contractAddress, r1.context);
    // Phase 4 fix: submitBuyCommit now requires proof of prior registration.
    // T-AUDIT fix (2026-07-21): registerForDarkVeil now requires
    // dvState == Registration, so this must happen after startRegistration.
    const rReg = contract.circuits.registerForDarkVeil(ctx1, fakeBytes32(7));
    const ctxReg = nextContext(contractAddress, rReg.context);
    const r2 = contract.circuits.startBuying(ctxReg);
    const ctx2 = nextContext(contractAddress, r2.context);

    const commitment = computeBuyCommit({ buyerKey, launchId: LAUNCH_ID, tokenAmount, pricePerToken: DV_PRICE, nonce: BUY_NONCE });
    const r3 = contract.circuits.submitBuyCommit(ctx2, commitment, 1n);
    const ctx3 = nextContext(contractAddress, r3.context);
    const r4 = contract.circuits.closeDarkVeil(ctx3, 2n, BIG_BASE_SLOT);
    const ctx4 = nextContext(contractAddress, r4.context);

    return () => contract.circuits.revealBuyCommit(ctx4, commitment, tokenAmount, DV_PRICE);
  }

  it('accepts a reveal at exactly the 5% wallet cap boundary', () => {
    const tree = buildAllowlistTree([hashAllowlistLeaf(deriveUserPublicKey(fakeBytes32(20)))]);
    const doReveal = revealAt(tree, fakeBytes32(20), CORRECT_WALLET_CAP, 0, 1n);
    expect(doReveal()).toBeDefined();
  });

  it('rejects a reveal exceeding the 5% wallet cap by even 1 token', () => {
    const tree = buildAllowlistTree([hashAllowlistLeaf(deriveUserPublicKey(fakeBytes32(21)))]);
    const doReveal = revealAt(tree, fakeBytes32(21), CORRECT_WALLET_CAP + 1n, 0, 1n);
    expect(doReveal).toThrow();
  });

  it('the wallet cap is per-identity, not global — two different registrants each get their own 5%', () => {
    // Security-audit fix (the design requirement, preserved by this port): the caller's
    // identity is derived in-circuit from getUserSecret(), never taken as a
    // caller-supplied key parameter, so this can only ever affect the real
    // transaction signer's own cap entry. Proven here via two separate
    // registrants (separate secrets, separate allowlist leaves) each
    // independently claiming their own full 5% cap.
    const secretA = fakeBytes32(22);
    const secretB = fakeBytes32(23);
    const tree = buildAllowlistTree([
      hashAllowlistLeaf(deriveUserPublicKey(secretA)),
      hashAllowlistLeaf(deriveUserPublicKey(secretB)),
    ]);
    const doRevealA = revealAt(tree, secretA, CORRECT_WALLET_CAP, 0, 2n);
    const doRevealB = revealAt(tree, secretB, CORRECT_WALLET_CAP, 1, 2n);
    expect(doRevealA()).toBeDefined();
    expect(doRevealB()).toBeDefined();
  });
});

describe('eligibility_gate.compact — registration nullifier (disclose() placement regression)', () => {
  it('allows registration for a new wallet during the DarkVeil phase', () => {
    const { contract, ctx } = deployAndStartDarkVeil();
    const result = contract.circuits.registerForDarkVeil(ctx, fakeBytes32(20));
    const state = ledger(result.context.currentQueryContext.state);
    expect(state.registrationCount).toBe(1n);
  });

  it('rejects a double-registration using the same witness-derived nullifier', () => {
    // This is the exact regression this test guards: eligibility_gate.compact
    // had a disclose() placed on the outer boolean of the nullifier
    // membership check instead of on the witness-derived nullifier value
    // itself (`disclose(!registrationNullifiers.member(nullifier))` instead
    // of `!registrationNullifiers.member(disclose(nullifier))`). Beyond the
    // privacy issue that fix addressed, this proves the double-registration
    // guard actually works at runtime: registering twice with the same
    // witnesses (same nonce/user secret => same nullifier) must fail the
    // second time.
    const { contract, contractAddress, ctx } = deployAndStartDarkVeil();
    const r1 = contract.circuits.registerForDarkVeil(ctx, fakeBytes32(20));
    const ctx2 = nextContext(contractAddress, r1.context);

    expect(() => contract.circuits.registerForDarkVeil(ctx2, fakeBytes32(20))).toThrow();
  });

  it('rejects registration outside the DarkVeil phase', () => {
    const { contract, ctx } = deploy(); // still Pending, never advanced
    expect(() => contract.circuits.registerForDarkVeil(ctx, fakeBytes32(20))).toThrow();
  });

  it('T-AUDIT fix (2026-07-21, Medium): rejects registration once dvState has moved past Registration, even though phase is still DarkVeil', () => {
    // Before the fix, registerForDarkVeil only checked `phase ==
    // LaunchPhase.DarkVeil`, never `dvState` — registration stayed open
    // through Buying/Closed, breaking the registration-freeze fairness
    // model (T37's minDvParticipants floor and base_slot computation both
    // assume the registrant set is fixed once Buying starts).
    const { contract, contractAddress, ctx } = deployAndStartDarkVeil();
    // MIN_DV_PARTICIPANTS_TEST floor (1) needs a real registrant before
    // startBuying will succeed.
    const r1 = contract.circuits.registerForDarkVeil(ctx, fakeBytes32(20));
    const ctx1 = nextContext(contractAddress, r1.context);
    const rBuying = contract.circuits.startBuying(ctx1);
    const ctxBuying = nextContext(contractAddress, rBuying.context);

    const lateRegistrant = new Contract<PrivateState>({
      getUserSecret: (_ctx) => [undefined, { bytes: fakeBytes32(3) }],
      getMerkleProof: (_ctx) => [undefined, ALLOWLIST_TREE.getProof(0)],
      getRegistrationNonce: (_ctx) => [undefined, fakeBytes32(6)],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
      getBuyNonce: (_ctx) => [undefined, BUY_NONCE],
    });
    expect(() => lateRegistrant.circuits.registerForDarkVeil(ctxBuying, fakeBytes32(21))).toThrow(/registration sub-phase/i);
  });

  it('T32: rejects the creator registering for their own DarkVeil (CLAUDE.md eligibility check #3)', () => {
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
      1000n,
      CORRECT_WALLET_CAP,
      DV_ALLOCATION,
      DV_PRICE,
      ALLOWLIST_SIZE,
      REGISTRATION_CLOSE_TIME,
      MIN_DV_PARTICIPANTS_TEST,
      CREATOR_KEY,
      TREASURY_ADDR,
      OPS_ADDR,
    );
    const r1 = contract.circuits.advancePhase(ctx, LaunchPhase.DarkVeil);
    const ctx1 = nextContext(contractAddress, r1.context);

    expect(() => contract.circuits.registerForDarkVeil(ctx1, fakeBytes32(20))).toThrow();
  });
});

describe('eligibility_gate.compact — NIGHT bond payment enforcement (T40)', () => {
  it('registration succeeds and still requires receiveUnshielded(nativeToken(), bondAmount) to be wired', () => {
    // Before T40's fix, lockedBonds credited `bondAmount` purely on trust —
    // nothing tied it to a real transfer. registerForDarkVeil now also
    // calls receiveUnshielded, which adds a ledger-enforced constraint that
    // this transaction includes a matching unshielded NIGHT input. The
    // local compact-runtime simulator doesn't model cross-transaction UTXO
    // matching (that's real-node enforcement, not something this simulator
    // can verify — see T3), so this test can't prove a missing payment is
    // rejected end-to-end; it proves the call is wired in and doesn't
    // break the existing registration flow.
    const { contract, ctx } = deployAndStartDarkVeil();
    const result = contract.circuits.registerForDarkVeil(ctx, fakeBytes32(20));
    const state = ledger(result.context.currentQueryContext.state);
    expect(state.registrationCount).toBe(1n);
    expect(state.lockedBonds.size()).toBe(1n);
  });
});

describe('eligibility_gate.compact — NIGHT bond refund', () => {
  it('locks a bond on registration and allows refund after the launch is cancelled', () => {
    const { contract, contractAddress, ctx } = deployAndStartDarkVeil();
    const r1 = contract.circuits.registerForDarkVeil(ctx, fakeBytes32(20));
    const ctx2 = nextContext(contractAddress, r1.context);

    const rCancel = contract.circuits.advancePhase(ctx2, LaunchPhase.Cancelled);
    const ctx3 = nextContext(contractAddress, rCancel.context);

    const r2 = contract.circuits.claimBondRefund(ctx3, fakeBytes32(5));
    const ctx4 = nextContext(contractAddress, r2.context);
    // A second refund of an already-cleared bond fails
    expect(() => contract.circuits.claimBondRefund(ctx4, fakeBytes32(5))).toThrow();
  });

  it('rejects a bond refund claim while the launch is still active', () => {
    const { contract, contractAddress, ctx } = deployAndStartDarkVeil();
    const r1 = contract.circuits.registerForDarkVeil(ctx, fakeBytes32(20));
    const ctx2 = nextContext(contractAddress, r1.context);

    expect(() => contract.circuits.claimBondRefund(ctx2, fakeBytes32(5))).toThrow();
  });

  it('Phase 2 security-audit fix regression: claimBondRefund pays out via sendUnshielded (does not throw locally)', () => {
    // Before this fix, claimBondRefund only cleared the ledger entry with
    // a comment deferring to "the Zswap layer via transaction merging" — a
    // mechanism that doesn't exist. Same simulator caveat as every other
    // sendUnshielded test in this suite: proves the call is wired in, not
    // verified end-to-end against a live network.
    const { contract, contractAddress, ctx } = deployAndStartDarkVeil();
    const r1 = contract.circuits.registerForDarkVeil(ctx, fakeBytes32(20));
    const ctx2 = nextContext(contractAddress, r1.context);
    const rCancel = contract.circuits.advancePhase(ctx2, LaunchPhase.Cancelled);
    const ctx3 = nextContext(contractAddress, rCancel.context);

    expect(() => contract.circuits.claimBondRefund(ctx3, fakeBytes32(5))).not.toThrow();
  });

  it('Phase 5 hygiene fix: claimBondRefund rejects an empty (all-zero) recipient address', () => {
    const { contract, contractAddress, ctx } = deployAndStartDarkVeil();
    const r1 = contract.circuits.registerForDarkVeil(ctx, fakeBytes32(20));
    const ctx2 = nextContext(contractAddress, r1.context);
    const rCancel = contract.circuits.advancePhase(ctx2, LaunchPhase.Cancelled);
    const ctx3 = nextContext(contractAddress, rCancel.context);

    expect(() => contract.circuits.claimBondRefund(ctx3, fakeBytes32(0))).toThrow();
  });
});

describe('eligibility_gate.compact — DarkVeil failure refund gate (T22/T43 regression)', () => {
  it('T22 FIXED: refund is claimable when DarkVeil failed even though the launch converts to Public, not Cancelled', () => {
    // Before this fix, claimBondRefund only checked phase == Cancelled.
    // Under T22's resolution, a failed DarkVeil converts the launch to a
    // public-only launch (phase -> Public), not death (phase -> Cancelled)
    // — so registrants would have had no way to reclaim a bond at all.
    const { contract, contractAddress, ctx } = deployAndStartDarkVeil();
    const r1 = contract.circuits.registerForDarkVeil(ctx, fakeBytes32(20));
    const ctx2 = nextContext(contractAddress, r1.context);

    const rMark = contract.circuits.markDarkVeilFailed(ctx2);
    const ctx3 = nextContext(contractAddress, rMark.context);
    expect(ledger(ctx3.currentQueryContext.state).dvFailed).toBe(true);

    // Launch converts to Public (per T22), NOT Cancelled
    const rAdvance = contract.circuits.advancePhase(ctx3, LaunchPhase.Public);
    const ctx4 = nextContext(contractAddress, rAdvance.context);
    expect(ledger(ctx4.currentQueryContext.state).phase).toBe(LaunchPhase.Public);

    // Refund still works, because dvFailed is independent of phase
    const rRefund = contract.circuits.claimBondRefund(ctx4, fakeBytes32(5));
    const ctx5 = nextContext(contractAddress, rRefund.context);
    expect(() => contract.circuits.claimBondRefund(ctx5, fakeBytes32(5))).toThrow(); // already claimed
  });

  it('markDarkVeilFailed is governor-only', () => {
    const { contract, ctx } = deployAndStartDarkVeil();
    const attacker = new Contract<PrivateState>({
      getUserSecret: (_ctx) => [undefined, { bytes: fakeBytes32(3) }],
      getMerkleProof: (_ctx) => [undefined, ALLOWLIST_TREE.getProof(0)],
      getRegistrationNonce: (_ctx) => [undefined, fakeBytes32(6)],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(99) }], // wrong governor
      getBuyNonce: (_ctx) => [undefined, BUY_NONCE],
    });
    expect(() => attacker.circuits.markDarkVeilFailed(ctx)).toThrow();
  });

  it('rejects marking DarkVeil failed twice', () => {
    const { contract, contractAddress, ctx } = deployAndStartDarkVeil();
    const r1 = contract.circuits.markDarkVeilFailed(ctx);
    const ctx2 = nextContext(contractAddress, r1.context);
    expect(() => contract.circuits.markDarkVeilFailed(ctx2)).toThrow();
  });
});

// ============================================================================
// T37 resolution (2026-07-13): minimum absolute registrant count required
// before startBuying() opens the buying phase. Below the floor, the
// governor must call cancelDarkVeil() (T22's existing, already-refundable
// failure path) instead.
// ============================================================================

describe('eligibility_gate.compact — T37 minimum DarkVeil participant floor', () => {
  // Three real distinct registrant identities, each a real leaf in a
  // purpose-built 3-leaf allowlist tree — the shared top-level
  // ALLOWLIST_TREE only contains one leaf (REGISTRANT_KEY), so exercising a
  // multi-registrant floor needs its own tree, same pattern as the wallet
  // cap describe block above.
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
      getMerkleProof: (_ctx) => [undefined, FLOOR_TREE.getProof(index)],
      getRegistrationNonce: (_ctx) => [undefined, fakeBytes32(6)],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
      getBuyNonce: (_ctx) => [undefined, BUY_NONCE],
    });
  }

  function deployWithFloor(minDvParticipants: bigint) {
    const governorContract = new Contract<PrivateState>({
      getUserSecret: (_ctx) => [undefined, { bytes: SECRET_A }],
      getMerkleProof: (_ctx) => [undefined, FLOOR_TREE.getProof(0)],
      getRegistrationNonce: (_ctx) => [undefined, fakeBytes32(6)],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
      getBuyNonce: (_ctx) => [undefined, BUY_NONCE],
    });
    const { contractAddress, ctx } = deployForTest(
      governorContract,
      undefined,
      LAUNCH_ID,
      FLOOR_TREE.root,
      TOTAL_SUPPLY,
      MAX_WALLET_PERCENT,
      1000n,
      CORRECT_WALLET_CAP,
      DV_ALLOCATION,
      DV_PRICE,
      3n, // allowlistSize — matches the 3-leaf FLOOR_TREE
      REGISTRATION_CLOSE_TIME,
      minDvParticipants,
      CREATOR_KEY,
      TREASURY_ADDR,
      OPS_ADDR,
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
        1000n,
        CORRECT_WALLET_CAP,
        DV_ALLOCATION,
        DV_PRICE,
        ALLOWLIST_SIZE,
        REGISTRATION_CLOSE_TIME,
        0n, // minDvParticipants — invalid
        CREATOR_KEY,
        TREASURY_ADDR,
        OPS_ADDR,
      )
    ).toThrow();
  });
});

// ============================================================================
// Phase 2 security-audit fix (2026-07-11): darkveil.compact merged into
// this contract for Tier B. Test coverage below ports what darkveil.test.ts
// used to cover (now deleted — that file tested a contract nothing deploys
// anymore), adapted for the merged identity/constructor, plus new coverage
// for what the merge specifically added (cumulativePurchases/
// dvTokensPurchased wiring, claimRatioBondRefund).
// ============================================================================

describe('eligibility_gate.compact — merged DarkVeil private buy (Phase 2)', () => {
  it('submitBuyCommit accepts a commitment during the Buying sub-phase, discloses nothing about the amount', () => {
    const d = deployAndStartDvBuying();
    const buyerKey = REGISTRANT_KEY;
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

  it('rejects a duplicate commitment hash', () => {
    const { contract, contractAddress, ctx } = deployAndStartDvBuying();
    const r1 = contract.circuits.submitBuyCommit(ctx, fakeBytes32(30), 1n);
    const ctx2 = nextContext(contractAddress, r1.context);

    expect(() =>
      contract.circuits.submitBuyCommit(ctx2, fakeBytes32(30), 2n),
    ).toThrow(/already exists/i);
  });

  it('T-AUDIT fix (2026-07-21): rejects a second buy commitment from the same identity, even with a different commitment hash', () => {
    // Before the fix, the buy nullifier was a free caller-supplied
    // parameter — a single registrant could submit unlimited buy
    // commitments simply by choosing a fresh nullifier value each time.
    // Now the nullifier is derived in-circuit from the caller's own secret
    // key, so a SECOND submission from the same identity always collides on
    // the SAME derived nullifier automatically — no caller-supplied
    // nullifier argument exists anymore to test the collision directly.
    const { contract, contractAddress, ctx } = deployAndStartDvBuying();
    const r1 = contract.circuits.submitBuyCommit(ctx, fakeBytes32(30), 1n);
    const ctx2 = nextContext(contractAddress, r1.context);

    expect(() =>
      contract.circuits.submitBuyCommit(ctx2, fakeBytes32(33), 2n),
    ).toThrow(/already bought/i);
  });

  it('rejects commitments submitted outside the buying phase', () => {
    const { contract, ctx } = deploy(); // still Inactive
    expect(() =>
      contract.circuits.submitBuyCommit(ctx, fakeBytes32(30), 1n),
    ).toThrow();
  });

  it('rejects revealing a commitment before DarkVeil closes', () => {
    const { contract, contractAddress, ctx } = deployAndStartDvBuying();
    const r1 = contract.circuits.submitBuyCommit(ctx, fakeBytes32(30), 1n);
    const ctx2 = nextContext(contractAddress, r1.context);

    expect(() =>
      contract.circuits.revealBuyCommit(ctx2, fakeBytes32(30), 1000n, 100n),
    ).toThrow();
  });

  it('T-AUDIT fix (2026-07-21): rejects cancelling someone else\'s commitment (ownership check)', () => {
    // Before the fix, this test constructed an artificial mismatch by
    // passing an arbitrary nullifier at submit time. That's no longer
    // possible — submitBuyCommit always derives the correct nullifier for
    // its real caller now. The real ownership-check scenario is a
    // DIFFERENT identity (not the original submitter) attempting to cancel.
    const d = deployAndStartDvBuying();
    const buyerKey = REGISTRANT_KEY;
    const commitment = computeBuyCommit({
      buyerKey,
      launchId: LAUNCH_ID,
      tokenAmount: 50n,
      pricePerToken: DV_PRICE,
      nonce: BUY_NONCE,
    });
    const r1 = d.contract.circuits.submitBuyCommit(d.ctx, commitment, 1n);
    const ctx2 = nextContext(d.contractAddress, r1.context);

    const impostor = new Contract<PrivateState>({
      getUserSecret: (_ctx) => [undefined, { bytes: fakeBytes32(77) }],
      getMerkleProof: (_ctx) => [undefined, ALLOWLIST_TREE.getProof(0)],
      getRegistrationNonce: (_ctx) => [undefined, fakeBytes32(6)],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
      getBuyNonce: (_ctx) => [undefined, BUY_NONCE],
    });
    expect(() => impostor.circuits.cancelBuyCommit(ctx2, commitment)).toThrow(/commitment owner/i);
  });

  it('cancelBuyCommit works before DarkVeil closes, decrements participant count', () => {
    const d = deployAndStartDvBuying();
    const buyerKey = REGISTRANT_KEY;
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
    // deployAndStartDvBuying registers exactly 1 participant (REGISTRANT_KEY),
    // so any baseSlot above DV_ALLOCATION (500) collectively promises more
    // than the pool actually reserves.
    const d = deployAndStartDvBuying();
    expect(() =>
      d.contract.circuits.closeDarkVeil(d.ctx, 12345n, DV_ALLOCATION + 1n),
    ).toThrow(/exceeds dvAllocation/i);
  });

  it('accepts a baseSlot exactly at the dvAllocation / registrationCount boundary', () => {
    const d = deployAndStartDvBuying();
    const r = d.contract.circuits.closeDarkVeil(d.ctx, 12345n, DV_ALLOCATION); // 500 * 1 == 500
    const state = ledger(r.context.currentQueryContext.state);
    expect(state.dvState).toBe(DarkVeilState.Closed);
  });

  it('rejects a DarkVeil buy exceeding the total dvAllocation pool', () => {
    const d = deployAndStartDvBuying();
    const buyerKey = REGISTRANT_KEY;
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
    // T-AUDIT fix (2026-07-21) note: baseSlot can no longer be set above
    // dvAllocation / registrationCount (closeDarkVeil now enforces this —
    // see that circuit's own comment) — with 1 registrant, the max legal
    // baseSlot equals DV_ALLOCATION itself, which is already below
    // overAmount, so this rejection is still real (either check fires) even
    // though it's no longer possible to isolate the pool-wide check alone
    // with a single registrant.
    const r2 = d.contract.circuits.closeDarkVeil(ctx1, 2n, DV_ALLOCATION);
    const ctx2 = nextContext(d.contractAddress, r2.context);

    expect(() => d.contract.circuits.revealBuyCommit(ctx2, commitment, overAmount, DV_PRICE)).toThrow();
  });

  it('the design requirement/T46 regression: rejects a reveal exceeding the per-registrant baseSlot, even within the pool-wide dvAllocation', () => {
    const d = deployAndStartDvBuying();
    const buyerKey = REGISTRANT_KEY;
    const tokenAmount = 50n; // exceeds baseSlot (40) but well within dvAllocation (500)
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

    expect(() => d.contract.circuits.revealBuyCommit(ctx2, commitment, tokenAmount, DV_PRICE)).toThrow();
  });

  it('T32: rejects the creator submitting a DarkVeil buy commitment at all — they can never have registered', () => {
    // Phase 4 fix (2026-07-12): submitBuyCommit now requires a valid
    // registration nullifier, and registerForDarkVeil already refuses to
    // register the creator (T32). So the creator is now rejected at
    // submitBuyCommit itself — earlier and stronger than the previous
    // behavior, where they were only caught later at revealBuyCommit.
    // revealBuyCommit's own creator check (below) remains as defense in
    // depth, but this test reflects the actual, earliest rejection point.
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
      1000n,
      CORRECT_WALLET_CAP,
      DV_ALLOCATION,
      DV_PRICE,
      ALLOWLIST_SIZE,
      REGISTRATION_CLOSE_TIME,
      MIN_DV_PARTICIPANTS_TEST,
      CREATOR_KEY,
      TREASURY_ADDR,
      OPS_ADDR,
    );
    const rPhase = contract.circuits.advancePhase(ctx, LaunchPhase.DarkVeil);
    const ctxPhase = nextContext(contractAddress, rPhase.context);
    const r1 = contract.circuits.startRegistration(ctxPhase);
    const ctx1 = nextContext(contractAddress, r1.context);
    // T37: startBuying() now requires at least MIN_DV_PARTICIPANTS_TEST real
    // registrants — a legitimate registrant (REGISTRANT_KEY, the shared
    // ALLOWLIST_TREE's leaf 0) registers first so the floor is met; the
    // creator themselves is never one of them, which is exactly this test's
    // point.
    const registrantContract = new Contract<PrivateState>(witnesses);
    const rReg = registrantContract.circuits.registerForDarkVeil(ctx1, fakeBytes32(7));
    const ctxReg = nextContext(contractAddress, rReg.context);
    const r2 = contract.circuits.startBuying(ctxReg);
    const ctx2 = nextContext(contractAddress, r2.context);

    const buyerKey = deriveUserPublicKey(CREATOR_SECRET_BYTES);
    const tokenAmount = 10n;
    const pricePerToken = DV_PRICE;
    const commitment = computeBuyCommit({ buyerKey, launchId: LAUNCH_ID, tokenAmount, pricePerToken, nonce: BUY_NONCE });

    expect(() =>
      contract.circuits.submitBuyCommit(ctx2, commitment, 1n),
    ).toThrow();
  });

  it('Bonus fix (this merge): a non-creator reveal updates cumulativePurchases and dvTokensPurchased atomically', () => {
    // Before this merge, revealBuyCommit never touched cumulativePurchases
    // at all — the standalone checkAndUpdateCap was the only way to update
    // it, and nothing in the old darkveil.compact ever called it. Also
    // proves dvTokensPurchased (needed by claimRatioBondRefund below) is
    // now tracked per-buyer.
    const d = deployAndStartDvBuying();
    const buyerKey = REGISTRANT_KEY;
    const tokenAmount = 10n;
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
    const r3 = d.contract.circuits.revealBuyCommit(ctx2, commitment, tokenAmount, DV_PRICE);
    const ctx3 = nextContext(d.contractAddress, r3.context);

    const capAfter = d.contract.circuits.checkCap(ctx3, buyerKey);
    expect(capAfter.result).toBe(tokenAmount);
  });

  it('getFairLaunchCert reads back the certificate after close', () => {
    const d = deployAndStartDvBuying();
    const r = d.contract.circuits.closeDarkVeil(d.ctx, 999n, 100n);
    const ctx = nextContext(d.contractAddress, r.context);
    const result = d.contract.circuits.getFairLaunchCert(ctx);
    expect(result.result.closeTimestamp).toBe(999n);
  });
});

describe('eligibility_gate.compact — Phase 2: claimRatioBondRefund (previously Tier C only)', () => {
  /** Registers, submits + reveals a DV buy for `purchased` tokens, closes DarkVeil with `baseSlot`. */
  function registerBuyAndClose(purchased: bigint, baseSlot: bigint) {
    const d = deploy();
    const r0 = d.contract.circuits.advancePhase(d.ctx, LaunchPhase.DarkVeil);
    const ctx0 = nextContext(d.contractAddress, r0.context);
    const r1 = d.contract.circuits.startRegistration(ctx0);
    const ctx1 = nextContext(d.contractAddress, r1.context);
    // T-AUDIT fix (2026-07-21): registerForDarkVeil now requires
    // dvState == Registration, so this must happen after startRegistration.
    const rReg0 = d.contract.circuits.registerForDarkVeil(ctx1, fakeBytes32(7));
    const ctxReg0 = nextContext(d.contractAddress, rReg0.context);
    const r3 = d.contract.circuits.startBuying(ctxReg0);
    let ctx = nextContext(d.contractAddress, r3.context);

    if (purchased > 0n) {
      const buyerKey = REGISTRANT_KEY;
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
      const r6 = d.contract.circuits.revealBuyCommit(ctx, commitment, purchased, DV_PRICE);
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
    const claimedRefund = (1000n * 100n) / 100n; // 1000 — floor is exact here (bondAmount=1000)
    const treasuryShare = 0n; // forfeited = 1000 - 1000 = 0
    expect(() => contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(5), claimedRefund, treasuryShare)).not.toThrow();
  });

  it('bought 50% of baseSlot -> half bond refund, floor-exact, forfeited half split 60/40', () => {
    const { contract, ctx } = registerBuyAndClose(50n, 100n);
    const claimedRefund = (1000n * 50n) / 100n; // 500
    const treasuryShare = (500n * 60n) / 100n; // 300 — forfeited(500) * 60%
    expect(() => contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(5), claimedRefund, treasuryShare)).not.toThrow();
  });

  it('ghost registrant (bought 0%) -> zero refund, entire bond forfeited and split 60/40', () => {
    const { contract, ctx } = registerBuyAndClose(0n, 100n);
    const treasuryShare = (1000n * 60n) / 100n; // 600 — forfeited(1000) * 60%
    expect(() => contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(5), 0n, treasuryShare)).not.toThrow();
  });

  it('accepts the correct FLOOR refund at a non-exact division (T39-style floor-rounding)', () => {
    // bond=1000, purchased=37, baseSlot=90: true value = 1000*37/90 = 411.11...
    const { contract, ctx } = registerBuyAndClose(37n, 90n);
    const floorRefund = (1000n * 37n) / 90n; // 411 (bigint division truncates = floor for positives)
    expect(floorRefund).toBe(411n);
    const forfeited = 1000n - floorRefund; // 589
    const treasuryShare = (forfeited * 60n) / 100n; // floor(589*0.6) = 353
    expect(() => contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(5), floorRefund, treasuryShare)).not.toThrow();
  });

  it('rejects a refund claim one unit above the correct floor', () => {
    const { contract, ctx } = registerBuyAndClose(37n, 90n);
    const floorRefund = (1000n * 37n) / 90n; // 411
    expect(() => contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(5), floorRefund + 1n, 0n)).toThrow();
  });

  it('rejects a refund claim below the correct floor', () => {
    const { contract, ctx } = registerBuyAndClose(37n, 90n);
    const floorRefund = (1000n * 37n) / 90n; // 411
    expect(() => contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(5), floorRefund - 1n, 0n)).toThrow();
  });

  it('rejects an incorrect treasury share for an otherwise-correct refund claim', () => {
    const { contract, ctx } = registerBuyAndClose(50n, 100n);
    const claimedRefund = (1000n * 50n) / 100n; // 500
    const wrongTreasuryShare = 301n; // correct floor is 300
    expect(() =>
      contract.circuits.claimRatioBondRefund(ctx, fakeBytes32(5), claimedRefund, wrongTreasuryShare),
    ).toThrow();
  });

  it('rejects claiming twice for the same bond', () => {
    const { contract, contractAddress, ctx } = registerBuyAndClose(50n, 100n);
    const claimedRefund = (1000n * 50n) / 100n;
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
