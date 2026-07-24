import { describe, it, expect } from 'vitest';
import { Contract, ledger, type Witnesses } from '../compiled/staking_pool/contract/index.js';
import { deployForTest, nextContext, fakeBytes32 } from './helpers.js';
import {
  deriveUserPublicKey,
  deriveCreatorKey,
  buildStakeSnapshotTree,
  buildRewardTree,
  type MerkleProofEntry,
} from '../../../packages/zk-proofs/src/staking-pool.js';

type PrivateState = undefined;

const EMPTY_PROOF: MerkleProofEntry[] = [];

const GOVERNOR_FILL = 2;
const CREATOR_FILL = 3;
// creatorKey is a raw pass-through in the constructor (disclose(creatorPubKey_))
// — the deployer computes deriveCreatorKey(realSecret) off-chain and supplies
// the resulting public key directly, same convention as
// cto_governance.compact's creatorPubKey_ constructor argument.
const CREATOR_PUBKEY = deriveCreatorKey(fakeBytes32(CREATOR_FILL));

function makeWitnesses(
  userFill: number,
  opts: {
    governorFill?: number;
    creatorFill?: number;
    stakeLeafAmount?: bigint;
    stakeProof?: MerkleProofEntry[];
    rewardLeafAmount?: bigint;
    rewardProof?: MerkleProofEntry[];
  } = {},
): Witnesses<PrivateState> {
  return {
    getUserSecret: (_ctx) => [undefined, { bytes: fakeBytes32(userFill) }],
    getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(opts.governorFill ?? GOVERNOR_FILL) }],
    getCreatorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(opts.creatorFill ?? CREATOR_FILL) }],
    getStakeLeafAmount: (_ctx) => [undefined, opts.stakeLeafAmount ?? 0n],
    getStakeProof: (_ctx) => [undefined, opts.stakeProof ?? EMPTY_PROOF],
    getRewardLeafAmount: (_ctx) => [undefined, opts.rewardLeafAmount ?? 0n],
    getRewardProof: (_ctx) => [undefined, opts.rewardProof ?? EMPTY_PROOF],
  };
}

const TREASURY_ADDR = fakeBytes32(50);
const OPS_ADDR = fakeBytes32(51);
const INITIAL_CLAIM_FEE = 5_000_000n; // arbitrary NIGHT atomic-unit stand-in for "$1"

function deploy() {
  const witnesses = makeWitnesses(99); // caller identity irrelevant for constructor
  const contract = new Contract<PrivateState>(witnesses);
  const { init, contractAddress, ctx } = deployForTest(
    contract,
    undefined,
    fakeBytes32(9), // launchId
    CREATOR_PUBKEY,
    TREASURY_ADDR,
    OPS_ADDR,
    INITIAL_CLAIM_FEE,
  );
  return { contract, init, contractAddress, ctx };
}

/** Publishes a stake-snapshot root containing exactly the given (fill, stakedAmount) pairs. */
function publishStakeSnapshot(
  d: ReturnType<typeof deploy>,
  entries: Array<{ fill: number; stakedAmount: bigint }>,
) {
  const keyed = entries.map((e) => ({
    fill: e.fill,
    stakerKey: deriveUserPublicKey(fakeBytes32(e.fill)),
    stakedAmount: e.stakedAmount,
  }));
  const tree = buildStakeSnapshotTree(keyed.map(({ stakerKey, stakedAmount }) => ({ stakerKey, stakedAmount })));

  const r = d.contract.circuits.publishStakeSnapshot(d.ctx, tree.root);
  const ctx = nextContext(d.contractAddress, r.context);

  function stakeArgsFor(fill: number) {
    const idx = keyed.findIndex((e) => e.fill === fill);
    if (idx === -1) throw new Error(`publishStakeSnapshot: fill ${fill} not in this snapshot`);
    return { stakeLeafAmount: keyed[idx].stakedAmount, stakeProof: tree.getProof(idx) };
  }

  return { ctx, stakeArgsFor, root: tree.root };
}

/** Publishes a reward root containing exactly the given (fill, cumulativeAmount) pairs. */
function publishRewardRoot(
  d: { contract: ReturnType<typeof deploy>['contract']; contractAddress: ReturnType<typeof deploy>['contractAddress']; ctx: any },
  entries: Array<{ fill: number; cumulativeAmount: bigint }>,
) {
  const keyed = entries.map((e) => ({
    fill: e.fill,
    stakerKey: deriveUserPublicKey(fakeBytes32(e.fill)),
    cumulativeAmount: e.cumulativeAmount,
  }));
  const tree = buildRewardTree(keyed.map(({ stakerKey, cumulativeAmount }) => ({ stakerKey, cumulativeAmount })));

  const r = d.contract.circuits.publishRewardRoot(d.ctx, tree.root);
  const ctx = nextContext(d.contractAddress, r.context);

  function rewardArgsFor(fill: number) {
    const idx = keyed.findIndex((e) => e.fill === fill);
    if (idx === -1) throw new Error(`publishRewardRoot: fill ${fill} not in this snapshot`);
    return { rewardLeafAmount: keyed[idx].cumulativeAmount, rewardProof: tree.getProof(idx) };
  }

  return { ctx, rewardArgsFor, root: tree.root };
}

describe('staking_pool.compact — deploy', () => {
  it('starts with zero pool balance and empty roots', () => {
    const { ctx } = deploy();
    const state = ledger(ctx.currentQueryContext.state);
    expect(state.poolBalance).toBe(0n);
    expect(state.claimFeeNightAmount).toBe(INITIAL_CLAIM_FEE);
  });
});

describe('staking_pool.compact — topUpPool', () => {
  it('succeeds with creator signature and increases poolBalance', () => {
    const { contract, ctx } = deploy();
    const r = contract.circuits.topUpPool(ctx, 1_000_000n);
    expect(ledger(r.context.currentQueryContext.state).poolBalance).toBe(1_000_000n);
  });

  it('accumulates across multiple top-ups', () => {
    const { contract, contractAddress, ctx } = deploy();
    const r1 = contract.circuits.topUpPool(ctx, 1_000_000n);
    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.topUpPool(ctx2, 500_000n);
    expect(ledger(r2.context.currentQueryContext.state).poolBalance).toBe(1_500_000n);
  });

  it('fails without creator signature', () => {
    const { ctx } = deploy();
    const attacker = new Contract<PrivateState>(makeWitnesses(1, { creatorFill: 66 }));
    expect(() => attacker.circuits.topUpPool(ctx, 1_000_000n)).toThrow();
  });

  it('fails with a zero amount', () => {
    const { contract, ctx } = deploy();
    expect(() => contract.circuits.topUpPool(ctx, 0n)).toThrow();
  });
});

describe('staking_pool.compact — publishStakeSnapshot / publishRewardRoot / updateClaimFee', () => {
  it('publishStakeSnapshot succeeds with governor signature', () => {
    const d = deploy();
    const { ctx } = publishStakeSnapshot(d, [{ fill: 10, stakedAmount: 1_000n }]);
    expect(ledger(ctx.currentQueryContext.state).stakeSnapshotRoot).toBeDefined();
  });

  it('publishStakeSnapshot fails without governor signature', () => {
    const { ctx } = deploy();
    const attacker = new Contract<PrivateState>(makeWitnesses(1, { governorFill: 66 }));
    expect(() => attacker.circuits.publishStakeSnapshot(ctx, fakeBytes32(7))).toThrow();
  });

  it('publishRewardRoot succeeds with governor signature', () => {
    const d = deploy();
    const { ctx } = publishRewardRoot(d, [{ fill: 10, cumulativeAmount: 500n }]);
    expect(ledger(ctx.currentQueryContext.state).rewardRoot).toBeDefined();
  });

  it('publishRewardRoot fails without governor signature', () => {
    const { ctx } = deploy();
    const attacker = new Contract<PrivateState>(makeWitnesses(1, { governorFill: 66 }));
    expect(() => attacker.circuits.publishRewardRoot(ctx, fakeBytes32(7))).toThrow();
  });

  it('updateClaimFee succeeds with governor signature', () => {
    const { contract, ctx } = deploy();
    const r = contract.circuits.updateClaimFee(ctx, 6_000_000n);
    expect(ledger(r.context.currentQueryContext.state).claimFeeNightAmount).toBe(6_000_000n);
  });

  it('updateClaimFee fails without governor signature', () => {
    const { ctx } = deploy();
    const attacker = new Contract<PrivateState>(makeWitnesses(1, { governorFill: 66 }));
    expect(() => attacker.circuits.updateClaimFee(ctx, 6_000_000n)).toThrow();
  });

  it('updateClaimFee fails with a zero amount', () => {
    const { contract, ctx } = deploy();
    expect(() => contract.circuits.updateClaimFee(ctx, 0n)).toThrow();
  });
});

describe('staking_pool.compact — proveStake', () => {
  it('returns the correct staked amount for a valid proof', () => {
    const d = deploy();
    const STAKER_FILL = 10;
    const { ctx, stakeArgsFor } = publishStakeSnapshot(d, [
      { fill: STAKER_FILL, stakedAmount: 4_200n },
      { fill: 11, stakedAmount: 800n },
    ]);
    const staker = new Contract<PrivateState>(makeWitnesses(STAKER_FILL, stakeArgsFor(STAKER_FILL)));
    const r = staker.circuits.proveStake(ctx);
    expect(r.result).toBe(4_200n);
  });

  it('rejects a tampered stake proof', () => {
    const d = deploy();
    const STAKER_FILL = 10;
    const { ctx, stakeArgsFor } = publishStakeSnapshot(d, [
      { fill: STAKER_FILL, stakedAmount: 4_200n },
      { fill: 11, stakedAmount: 800n },
    ]);
    const args = stakeArgsFor(STAKER_FILL);
    const staker = new Contract<PrivateState>(
      makeWitnesses(STAKER_FILL, { ...args, stakeLeafAmount: args.stakeLeafAmount + 1n }),
    );
    expect(() => staker.circuits.proveStake(ctx)).toThrow();
  });
});

describe('staking_pool.compact — claimRewards', () => {
  const STAKER_FILL = 10;
  const STAKER_ADDR = fakeBytes32(200); // real unshielded payout address, distinct from the derived identity

  function setupWithPool(poolAmount: bigint, cumulativeAmount: bigint) {
    const d = deploy();
    const r1 = d.contract.circuits.topUpPool(d.ctx, poolAmount);
    const ctxAfterTopUp = nextContext(d.contractAddress, r1.context);
    const { ctx, rewardArgsFor } = publishRewardRoot(
      { contract: d.contract, contractAddress: d.contractAddress, ctx: ctxAfterTopUp },
      [
        { fill: STAKER_FILL, cumulativeAmount },
        { fill: 11, cumulativeAmount: 1n },
      ],
    );
    return { ...d, ctx, rewardArgsFor };
  }

  it('succeeds with a valid proof, real payout does not throw locally, and updates ledger', () => {
    const { contractAddress, ctx, rewardArgsFor } = setupWithPool(10_000n, 3_000n);
    const args = rewardArgsFor(STAKER_FILL);
    const staker = new Contract<PrivateState>(makeWitnesses(STAKER_FILL, args));
    // Split of INITIAL_CLAIM_FEE (5_000_000n) at 60% treasury, floor: 3_000_000n
    const r = staker.circuits.claimRewards(ctx, STAKER_ADDR, 3_000_000n);
    const state = ledger(r.context.currentQueryContext.state);
    expect(state.poolBalance).toBe(7_000n); // 10_000 - 3_000
    expect(state.claimedRewards.lookup(deriveUserPublicKey(fakeBytes32(STAKER_FILL)))).toBe(3_000n);
  });

  it('rejects a tampered reward proof', () => {
    const { ctx, rewardArgsFor } = setupWithPool(10_000n, 3_000n);
    const args = rewardArgsFor(STAKER_FILL);
    const staker = new Contract<PrivateState>(
      makeWitnesses(STAKER_FILL, { ...args, rewardLeafAmount: args.rewardLeafAmount + 1n }),
    );
    expect(() => staker.circuits.claimRewards(ctx, STAKER_ADDR, 3_000_000n)).toThrow();
  });

  it('rejects a claim with nothing new to claim (cumulative == already claimed)', () => {
    const { contractAddress, ctx, rewardArgsFor } = setupWithPool(10_000n, 3_000n);
    const args = rewardArgsFor(STAKER_FILL);
    const staker = new Contract<PrivateState>(makeWitnesses(STAKER_FILL, args));
    const r1 = staker.circuits.claimRewards(ctx, STAKER_ADDR, 3_000_000n);
    const ctx2 = nextContext(contractAddress, r1.context);
    // Same proof, same cumulative amount — nothing new accrued since last claim.
    expect(() => staker.circuits.claimRewards(ctx2, STAKER_ADDR, 3_000_000n)).toThrow();
  });

  it('pays only the delta on a second claim after a new reward root is published', () => {
    const { contract, contractAddress, ctx, rewardArgsFor } = setupWithPool(10_000n, 3_000n);
    const args1 = rewardArgsFor(STAKER_FILL);
    const staker = new Contract<PrivateState>(makeWitnesses(STAKER_FILL, args1));
    const r1 = staker.circuits.claimRewards(ctx, STAKER_ADDR, 3_000_000n);
    const ctx2 = nextContext(contractAddress, r1.context);

    // Governor publishes a fresh root: staker has now earned 5,000 cumulative.
    const { ctx: ctx3, rewardArgsFor: rewardArgsFor2 } = publishRewardRoot(
      { contract, contractAddress, ctx: ctx2 },
      [
        { fill: STAKER_FILL, cumulativeAmount: 5_000n },
        { fill: 11, cumulativeAmount: 1n },
      ],
    );
    const args2 = rewardArgsFor2(STAKER_FILL);
    const staker2 = new Contract<PrivateState>(makeWitnesses(STAKER_FILL, args2));
    // The $1-equivalent claim fee is FLAT per claim, not proportional to the
    // reward amount — treasury share is still 60% of INITIAL_CLAIM_FEE.
    const r2 = staker2.circuits.claimRewards(ctx3, STAKER_ADDR, 3_000_000n);
    const state = ledger(r2.context.currentQueryContext.state);
    // Delta claimed this time: 5,000 - 3,000 = 2,000
    expect(state.claimedRewards.lookup(deriveUserPublicKey(fakeBytes32(STAKER_FILL)))).toBe(5_000n);
    expect(state.poolBalance).toBe(5_000n); // 10_000 - 3_000 (1st) - 2_000 (2nd)
  });

  it('rejects a payout exceeding the remaining pool balance', () => {
    const { ctx, rewardArgsFor } = setupWithPool(1_000n, 3_000n); // pool has less than the claim
    const args = rewardArgsFor(STAKER_FILL);
    const staker = new Contract<PrivateState>(makeWitnesses(STAKER_FILL, args));
    expect(() => staker.circuits.claimRewards(ctx, STAKER_ADDR, 3_000_000n)).toThrow();
  });

  it('rejects an incorrect treasury/ops fee split', () => {
    const { ctx, rewardArgsFor } = setupWithPool(10_000n, 3_000n);
    const args = rewardArgsFor(STAKER_FILL);
    const staker = new Contract<PrivateState>(makeWitnesses(STAKER_FILL, args));
    expect(() => staker.circuits.claimRewards(ctx, STAKER_ADDR, 999_999n)).toThrow();
  });

  it('rejects an empty recipient address', () => {
    const { ctx, rewardArgsFor } = setupWithPool(10_000n, 3_000n);
    const args = rewardArgsFor(STAKER_FILL);
    const staker = new Contract<PrivateState>(makeWitnesses(STAKER_FILL, args));
    expect(() => staker.circuits.claimRewards(ctx, fakeBytes32(0), 3_000_000n)).toThrow();
  });
});
