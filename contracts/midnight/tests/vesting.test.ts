import { describe, it, expect } from 'vitest';
import { Contract, ledger, VestingState, type Witnesses } from '../compiled/vesting/contract/index.js';
import { deployForTest, nextContext, nextContextAtTime, fakeBytes32 } from './helpers.js';

type PrivateState = undefined;

const witnesses: Witnesses<PrivateState> = {
  getCreatorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(3) }],
  getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
};

const TOKEN_ALLOCATION = 90_000_000n;
const VEST_DAYS = 90n;
const VEST_SECONDS = VEST_DAYS * 86_400n; // 7,776,000

// Phase 3 security fix (2026-07-12): startVesting/claimVested now bind their
// timestamp arguments to real chain time (blockTimeGte/blockTimeLte), so
// tests must pin the simulator's block time via nextContextAtTime instead
// of passing arbitrary small values like 0/1 — those would now fail the
// "timestamp too far in the past" check on startVesting, or (for
// claimVested) simply never have been reachable relative to a realistic
// vestStartTimestamp. NOW is an arbitrary but realistic epoch-seconds
// anchor, fixed here so every test in this file agrees on it.
const NOW = 1_780_000_000;

function deploy() {
  const contract = new Contract<PrivateState>(witnesses);
  const { init, contractAddress, ctx } = deployForTest(
    contract,
    undefined,
    fakeBytes32(9),
    TOKEN_ALLOCATION,
    VEST_DAYS,
  );
  return { contract, init, contractAddress, ctx };
}

function deployAndStart(startAt: number = NOW) {
  const d = deploy();
  const pinnedCtx = nextContextAtTime(d.contractAddress, d.ctx, startAt);
  const r = d.contract.circuits.startVesting(pinnedCtx, BigInt(startAt));
  const ctx = nextContext(d.contractAddress, r.context);
  return { ...d, ctx, startAt };
}

/** Calls claimVested with the simulator's block time pinned to `atTime`. */
function claimVestedAt(
  contract: Contract<PrivateState>,
  contractAddress: ReturnType<typeof deploy>['contractAddress'],
  ctx: ReturnType<typeof deploy>['ctx'],
  claimAmount: bigint,
  atTime: number,
) {
  const pinnedCtx = nextContextAtTime(contractAddress, ctx, atTime);
  return contract.circuits.claimVested(pinnedCtx, claimAmount, BigInt(atTime));
}

describe('vesting.compact — creator TOKEN vesting, separate from fee escrow (split regression)', () => {
  it('starts NotStarted and rejects claims before startVesting', () => {
    const { contract, ctx } = deploy();
    expect(ledger(ctx.currentQueryContext.state).vestingState).toBe(VestingState.NotStarted);
    expect(() => contract.circuits.claimVested(ctx, 1n, 1n)).toThrow();
  });

  it('rejects claiming zero tokens before vesting has run at all (elapsed=0)', () => {
    const { contract, contractAddress, ctx } = deployAndStart();
    expect(() => claimVestedAt(contract, contractAddress, ctx, 1n, NOW)).toThrow();
  });

  it('allows claiming the exact vested amount at 25% elapsed', () => {
    // IMPORTANT: unlike a naive floating-point vesting calc, Compact's
    // Field type only supports EXACT equality (see bonding_curve's
    // "IMPORTANT FINDING" tests) — claimAmount * vestSeconds must exactly
    // equal tokenAllocation * elapsedSeconds. These numbers are chosen so
    // that resolves cleanly (90M * 1,944,000 / 7,776,000 = 22.5M exactly).
    const { contract, contractAddress, ctx } = deployAndStart();
    const quarterElapsed = VEST_SECONDS / 4n; // 1,944,000
    const expectedVested = TOKEN_ALLOCATION / 4n; // 22,500,000

    const result = claimVestedAt(contract, contractAddress, ctx, expectedVested, NOW + Number(quarterElapsed));
    const state = ledger(result.context.currentQueryContext.state);
    expect(state.claimedTokens).toBe(expectedVested);
    expect(state.vestingState).toBe(VestingState.Vesting);
  });

  it('rejects claiming more than what is vested-to-date', () => {
    const { contract, contractAddress, ctx } = deployAndStart();
    const quarterElapsed = VEST_SECONDS / 4n;
    const tooMuch = TOKEN_ALLOCATION / 4n + 1n; // 1 more than vested

    expect(() =>
      claimVestedAt(contract, contractAddress, ctx, tooMuch, NOW + Number(quarterElapsed)),
    ).toThrow();
  });

  it('rejects a currentTimestamp claimed to be in the future relative to real chain time', () => {
    // Phase 3 fix regression: the block time is pinned to NOW (25% elapsed),
    // but the circuit is called claiming currentTimestamp is a full vesting
    // period ahead of that — must be rejected regardless of how the
    // cross-multiplication math would otherwise resolve.
    const { contract, contractAddress, ctx } = deployAndStart();
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, NOW + Number(VEST_SECONDS / 4n));
    expect(() =>
      contract.circuits.claimVested(pinnedCtx, TOKEN_ALLOCATION, BigInt(NOW + Number(VEST_SECONDS))),
    ).toThrow();
  });

  it('accumulates claims correctly across multiple calls as vesting progresses', () => {
    const { contract, contractAddress, ctx } = deployAndStart();

    const r1 = claimVestedAt(contract, contractAddress, ctx, TOKEN_ALLOCATION / 4n, NOW + Number(VEST_SECONDS / 4n));
    const ctx2 = nextContext(contractAddress, r1.context);

    // Second claim brings CUMULATIVE claimed to 45M (half), at the 50%
    // elapsed checkpoint — the circuit checks the running total against
    // vested-to-date, not the incremental claim amount in isolation.
    const r2 = claimVestedAt(contract, contractAddress, ctx2, TOKEN_ALLOCATION / 4n, NOW + Number(VEST_SECONDS / 2n));
    const state = ledger(r2.context.currentQueryContext.state);
    expect(state.claimedTokens).toBe(TOKEN_ALLOCATION / 2n);
  });

  it('fully claims at 100% elapsed and transitions to FullyClaimed', () => {
    const { contract, contractAddress, ctx } = deployAndStart();
    const result = claimVestedAt(contract, contractAddress, ctx, TOKEN_ALLOCATION, NOW + Number(VEST_SECONDS));
    const state = ledger(result.context.currentQueryContext.state);
    expect(state.claimedTokens).toBe(TOKEN_ALLOCATION);
    expect(state.vestingState).toBe(VestingState.FullyClaimed);
  });

  it('rejects a claim from anyone but the creator', () => {
    const attacker = new Contract<PrivateState>({
      getCreatorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(66) }],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
    });
    const { contractAddress, ctx } = deployAndStart();
    expect(() =>
      claimVestedAt(attacker, contractAddress, ctx, TOKEN_ALLOCATION / 4n, NOW + Number(VEST_SECONDS / 4n)),
    ).toThrow();
  });
});

describe('vesting.compact — startVesting anchor forgery (Phase 3 fix)', () => {
  it('rejects a startTimestamp far in the past (would inflate elapsed time)', () => {
    const d = deploy();
    // Real chain time pinned to NOW, but the governor claims vesting
    // started at epoch 0 — before the fix, this would let the creator
    // immediately claim the full allocation via a since-real-time-massively-
    // exceeds-vestSeconds elapsed calculation.
    const pinnedCtx = nextContextAtTime(d.contractAddress, d.ctx, NOW);
    expect(() => d.contract.circuits.startVesting(pinnedCtx, 0n)).toThrow();
  });

  it('rejects a startTimestamp in the future', () => {
    const d = deploy();
    const pinnedCtx = nextContextAtTime(d.contractAddress, d.ctx, NOW);
    expect(() => d.contract.circuits.startVesting(pinnedCtx, BigInt(NOW + Number(VEST_SECONDS)))).toThrow();
  });

  it('accepts a startTimestamp exactly at real chain time', () => {
    const d = deploy();
    const pinnedCtx = nextContextAtTime(d.contractAddress, d.ctx, NOW);
    const result = d.contract.circuits.startVesting(pinnedCtx, BigInt(NOW));
    expect(ledger(result.context.currentQueryContext.state).vestStartTimestamp).toBe(BigInt(NOW));
  });

  it('accepts a startTimestamp within the 1-hour tolerance window', () => {
    const d = deploy();
    const pinnedCtx = nextContextAtTime(d.contractAddress, d.ctx, NOW);
    // timestamp + 3600 >= NOW, i.e. timestamp >= NOW - 3600 — well within bounds
    const result = d.contract.circuits.startVesting(pinnedCtx, BigInt(NOW - 1800));
    expect(ledger(result.context.currentQueryContext.state).vestStartTimestamp).toBe(BigInt(NOW - 1800));
  });

  it('rejects a startTimestamp just outside the 1-hour tolerance window', () => {
    const d = deploy();
    const pinnedCtx = nextContextAtTime(d.contractAddress, d.ctx, NOW);
    expect(() => d.contract.circuits.startVesting(pinnedCtx, BigInt(NOW - 3601))).toThrow();
  });
});

describe('vesting.compact — CTO freeze', () => {
  it('triggerCTO freezes further claims', () => {
    const { contract, contractAddress, ctx } = deployAndStart();
    const rTrigger = contract.circuits.triggerCTO(ctx, fakeBytes32(4));
    const ctx2 = nextContext(contractAddress, rTrigger.context);

    const state = ledger(ctx2.currentQueryContext.state);
    expect(state.vestingState).toBe(VestingState.CTOFrozen);
    expect(state.ctoTriggered).toBe(true);

    expect(() =>
      claimVestedAt(contract, contractAddress, ctx2, TOKEN_ALLOCATION / 4n, NOW + Number(VEST_SECONDS / 4n)),
    ).toThrow();
  });

  it('dissolveCTO resumes vesting from where it left off', () => {
    const { contract, contractAddress, ctx } = deployAndStart();
    const rTrigger = contract.circuits.triggerCTO(ctx, fakeBytes32(4));
    const ctx2 = nextContext(contractAddress, rTrigger.context);
    const rDissolve = contract.circuits.dissolveCTO(ctx2);
    const ctx3 = nextContext(contractAddress, rDissolve.context);

    expect(ledger(ctx3.currentQueryContext.state).vestingState).toBe(VestingState.Vesting);

    // Claiming works again post-dissolve
    const result = claimVestedAt(contract, contractAddress, ctx3, TOKEN_ALLOCATION / 4n, NOW + Number(VEST_SECONDS / 4n));
    expect(ledger(result.context.currentQueryContext.state).claimedTokens).toBe(TOKEN_ALLOCATION / 4n);
  });

  it('rejects triggering CTO twice', () => {
    const { contract, contractAddress, ctx } = deployAndStart();
    const r1 = contract.circuits.triggerCTO(ctx, fakeBytes32(4));
    const ctx2 = nextContext(contractAddress, r1.context);
    expect(() => contract.circuits.triggerCTO(ctx2, fakeBytes32(4))).toThrow();
  });

  it('Phase 5 hygiene fix: triggerCTO rejects an empty (all-zero) community wallet address', () => {
    const { contract, ctx } = deployAndStart();
    expect(() => contract.circuits.triggerCTO(ctx, fakeBytes32(0))).toThrow();
  });

  it('rejects triggerCTO on a NEVER-STARTED schedule', () => {
    // Before the fix: triggerCTO only forbade FullyClaimed, so it could be
    // entered from NotStarted too. dissolveCTO then unconditionally set
    // vestingState = Vesting without ever setting vestStartTimestamp (still
    // 0, the constructor default) — letting the creator call claimVested
    // with currentTimestamp = vestDays*86400 and claim 100% of the
    // allocation in one call, on day one. This must now be rejected at
    // triggerCTO itself.
    const { contract, ctx } = deploy(); // startVesting never called
    expect(() => contract.circuits.triggerCTO(ctx, fakeBytes32(4))).toThrow(/actively in progress/i);
  });

  it('T-AUDIT fix (2026-07-21, Medium): rejects triggerCTO on a Cancelled schedule (same root cause, second path)', () => {
    const { contract, contractAddress, ctx } = deployAndStart();
    const rCancel = contract.circuits.cancelLaunch(ctx);
    const ctxCancelled = nextContext(contractAddress, rCancel.context);
    expect(() => contract.circuits.triggerCTO(ctxCancelled, fakeBytes32(4))).toThrow(/actively in progress/i);
  });
});

describe('vesting.compact — cancelLaunch authorization (GitHub #68 fix, 2026-07-14)', () => {
  it('succeeds with governor signature and transitions to Cancelled', () => {
    const { contract, ctx } = deploy();
    const result = contract.circuits.cancelLaunch(ctx);
    expect(ledger(result.context.currentQueryContext.state).vestingState).toBe(VestingState.Cancelled);
  });

  it('rejects a caller without the governor signature', () => {
    const attacker = new Contract<PrivateState>({
      getCreatorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(3) }],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(66) }],
    });
    const { ctx } = deploy();
    expect(() => attacker.circuits.cancelLaunch(ctx)).toThrow();
  });

  it('rejects cancelling an already-cancelled launch', () => {
    const { contract, contractAddress, ctx } = deploy();
    const r1 = contract.circuits.cancelLaunch(ctx);
    const ctx2 = nextContext(contractAddress, r1.context);
    expect(() => contract.circuits.cancelLaunch(ctx2)).toThrow();
  });
});
