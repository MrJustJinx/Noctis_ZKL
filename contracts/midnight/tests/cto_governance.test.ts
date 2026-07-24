import { describe, it, expect } from 'vitest';
import { Contract, ledger, ProposalType, ProposalState, BreakGlassState, CtoState, type Witnesses } from '../compiled/cto_governance/contract/index.js';
import { deployForTest, nextContext, nextContextAtTime, fakeBytes32 } from './helpers.js';
import { deriveUserPublicKey, buildBalanceSnapshotTree, type MerkleProofEntry } from '../../../packages/zk-proofs/src/cto-governance.js';

// T-AUDIT fix (2026-07-21): every circuit here that takes a currentTimestamp
// parameter now binds it to real chain time (blockTimeGte/blockTimeLte, same
// idiom as lp_escrow.compact's sealLock) — see cto_governance.compact's own
// comments on updateBalanceSnapshot/updateCreatorActivity/checkSilenceLock/
// createProposal/castVote/finalizeProposal/bondedSilenceChallenge/
// resolveBreakGlassChallenge for the full Critical finding. Every call site
// below now pins the simulator's block time via nextContextAtTime to match
// the currentTimestamp value it passes, the same pattern lp_escrow.test.ts
// already established for sealLock.

type PrivateState = undefined;

const EMPTY_PROOF: MerkleProofEntry[] = [];

function makeWitnesses(
  userFill: number,
  balanceLeafAmount: bigint = 0n,
  balanceProof: MerkleProofEntry[] = EMPTY_PROOF,
): Witnesses<PrivateState> {
  return {
    getUserSecret: (_ctx) => [undefined, { bytes: fakeBytes32(userFill) }],
    getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
    getBalanceLeafAmount: (_ctx) => [undefined, balanceLeafAmount],
    getBalanceProof: (_ctx) => [undefined, balanceProof],
  };
}

const TOTAL_SUPPLY = 1_000_000_000n;
const GRADUATION_TIMESTAMP = 0n;
const MIN_POST_GRAD_DELAY = 2_592_000n; // 30 days
const SILENCE_THRESHOLD = 7_776_000n; // 90 days
const BALLOT_DURATION = 259_200n; // 72 hours
const MAX_SNAPSHOT_AGE = 2_592_000n; // 30 days
const QUORUM_BPS = 500n; // 5%
const CREATOR_VOTE_CAP = (TOTAL_SUPPLY * 200n) / 10_000n; // 2% of total supply, computed off-chain

// Fixed test identities. CREATOR_FILL's derived public key is what gets
// passed as the constructor's creatorPubKey_, so votes cast with
// makeWitnesses(CREATOR_FILL, ...) are the ones the circuit will recognize
// as isCreator === true; every other fill is a regular voter.
const CREATOR_FILL = 99;
const CREATOR_PUBKEY = deriveUserPublicKey(fakeBytes32(CREATOR_FILL));
const VOTER_FILL = 3;
const OTHER_VOTER_FILL = 77;
const CHALLENGER_FILL = 55;

const BREAK_GLASS_BOND_MIN = 1_000_000n;
const BREAK_GLASS_RESPONSE_WINDOW = 259_200n; // 72 hours
const TREASURY_ADDR = fakeBytes32(200);
const OPS_ADDR = fakeBytes32(201);

function deploy(creatorVoteCap: bigint = CREATOR_VOTE_CAP, hasClaimableBalance: boolean = true) {
  const witnesses = makeWitnesses(VOTER_FILL);
  const contract = new Contract<PrivateState>(witnesses);
  const { init, contractAddress, ctx } = deployForTest(
    contract,
    undefined,
    fakeBytes32(9),
    TOTAL_SUPPLY,
    GRADUATION_TIMESTAMP,
    creatorVoteCap,
    CREATOR_PUBKEY,
    hasClaimableBalance,
    BREAK_GLASS_BOND_MIN,
    TREASURY_ADDR,
    OPS_ADDR,
  );
  return { contract, init, contractAddress, ctx };
}

/**
 * Publishes a balance-snapshot root containing exactly the given
 * (fill, balance) pairs (design requirement). Returns a `witnessesFor(fill)` helper that builds the right
 * getBalanceLeafAmount/getBalanceProof pair for any fill in the snapshot.
 */
function publishBalanceSnapshot(
  d: ReturnType<typeof deploy>,
  entries: Array<{ fill: number; balance: bigint }>,
  // Defaults to SILENCE_THRESHOLD -- every caller in this file creates its
  // proposal at or shortly after that timestamp, so this keeps the
  // snapshot fresh (stale-snapshot fix, 2026-07-19) without every call
  // site needing to pass it explicitly.
  snapshotTimestamp: bigint = SILENCE_THRESHOLD,
) {
  const keyed = entries.map((e) => ({ fill: e.fill, voterKey: deriveUserPublicKey(fakeBytes32(e.fill)), balance: e.balance }));
  const tree = buildBalanceSnapshotTree(keyed.map(({ voterKey, balance }) => ({ voterKey, balance })));

  const pinnedCtx = nextContextAtTime(d.contractAddress, d.ctx, Number(snapshotTimestamp));
  const r = d.contract.circuits.updateBalanceSnapshot(pinnedCtx, tree.root, snapshotTimestamp);
  const ctx = nextContext(d.contractAddress, r.context);

  function witnessesFor(fill: number): Witnesses<PrivateState> {
    const idx = keyed.findIndex((e) => e.fill === fill);
    if (idx === -1) throw new Error(`publishBalanceSnapshot: fill ${fill} not in this snapshot`);
    return makeWitnesses(fill, keyed[idx].balance, tree.getProof(idx));
  }

  return { ctx, witnessesFor };
}

/** Create a SilenceLockTrigger proposal at exactly the silence threshold. */
function deployAndCreateProposal(balances: Array<{ fill: number; balance: bigint }>, hasClaimableBalance: boolean = true) {
  const d = deploy(CREATOR_VOTE_CAP, hasClaimableBalance);
  const { ctx: ctxAfterSnapshot, witnessesFor } = publishBalanceSnapshot(d, balances);
  const createTime = SILENCE_THRESHOLD;
  const pinnedCtx = nextContextAtTime(d.contractAddress, ctxAfterSnapshot, Number(createTime));
  const r = d.contract.circuits.createProposal(
    pinnedCtx,
    ProposalType.SilenceLockTrigger,
    fakeBytes32(40), // descriptionHash
    createTime,
    fakeBytes32(0), // targetDexAddr (unused for this proposal type)
    0n, // allocationAmount
    fakeBytes32(0), // allocationRecipient
    fakeBytes32(90), // proposedCommunityWallet
  );
  const proposalId = r.result as Uint8Array;
  const ctx = nextContext(d.contractAddress, r.context);
  return { ...d, ctx, proposalId, createTime, witnessesFor };
}

describe('cto_governance.compact — T-AUDIT fix: currentTimestamp forgery (Critical)', () => {
  it('rejects a fabricated currentTimestamp when the simulator block time is left at its real default (unpinned)', () => {
    // Before the fix: every currentTimestamp-taking circuit trusted this
    // parameter outright, so a caller must not be able to fabricate an
    // internally-consistent-but-fictional create->vote->finalize sequence
    // in one real transaction. This test deliberately does NOT call
    // nextContextAtTime — it uses the default (real wall-clock) block time,
    // exactly what a real attacker's single real transaction would see —
    // and supplies a small, arbitrary currentTimestamp (SILENCE_THRESHOLD)
    // completely disconnected from it. Before the fix this would have
    // succeeded; after the fix it must fail on the new band check, not the
    // "no balance snapshot" check that would otherwise fire first.
    const d = deploy();
    expect(() =>
      d.contract.circuits.createProposal(
        d.ctx, ProposalType.SilenceLockTrigger, fakeBytes32(40),
        SILENCE_THRESHOLD, fakeBytes32(0), 0n, fakeBytes32(0), fakeBytes32(90),
      ),
    ).toThrow(/currentTimestamp/i);
  });

  it('rejects a currentTimestamp claimed to be in the future relative to real block time', () => {
    const d = deploy();
    const farFuture = 99_999_999_999n;
    const pinnedCtx = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENCE_THRESHOLD));
    expect(() =>
      d.contract.circuits.createProposal(
        pinnedCtx, ProposalType.SilenceLockTrigger, fakeBytes32(40),
        farFuture, fakeBytes32(0), 0n, fakeBytes32(0), fakeBytes32(90),
      ),
    ).toThrow(/cannot be in the future/i);
  });

  it('rejects a forged castVote currentTimestamp that does not match real block time', () => {
    const { contract, ctx, proposalId, createTime } = deployAndCreateProposal([
      { fill: VOTER_FILL, balance: 1000n },
    ]);
    // Real block time is still pinned at createTime (from deployAndCreateProposal).
    // Claiming a currentTimestamp far past the ballot window, without
    // advancing real block time to match, must fail on the timestamp band
    // check rather than being accepted as "voting ended".
    const forgedTime = createTime + BALLOT_DURATION + 100_000n;
    expect(() =>
      contract.circuits.castVote(ctx, proposalId, true, forgedTime),
    ).toThrow(/currentTimestamp/i);
  });
});

describe('cto_governance.compact — proposal lifecycle gating', () => {
  it('rejects creating a proposal before a balance snapshot has been published', () => {
    const d = deploy();
    const pinnedCtx = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENCE_THRESHOLD));
    expect(() =>
      d.contract.circuits.createProposal(
        pinnedCtx, ProposalType.SilenceLockTrigger, fakeBytes32(40),
        SILENCE_THRESHOLD, fakeBytes32(0), 0n, fakeBytes32(0), fakeBytes32(90),
      ),
    ).toThrow();
  });

  it('rejects creating a proposal against a balance snapshot older than 30 days (stale-snapshot fix)', () => {
    const d = deploy();
    // Published at deploy time; createProposal fires 90 days later --
    // 90 days > the 30-day maxSnapshotAge, so the snapshot is stale even
    // though it exists and the silence/post-grad-delay checks would
    // otherwise pass.
    const { ctx } = publishBalanceSnapshot(d, [{ fill: VOTER_FILL, balance: 1n }], 0n);
    const pinnedCtx = nextContextAtTime(d.contractAddress, ctx, Number(SILENCE_THRESHOLD));
    expect(() =>
      d.contract.circuits.createProposal(
        pinnedCtx, ProposalType.SilenceLockTrigger, fakeBytes32(40),
        SILENCE_THRESHOLD, fakeBytes32(0), 0n, fakeBytes32(0), fakeBytes32(90),
      ),
    ).toThrow(/stale/i);
  });

  it('allows creating a proposal when the snapshot is exactly at the 30-day staleness boundary', () => {
    const d = deploy();
    const snapshotTime = SILENCE_THRESHOLD - MAX_SNAPSHOT_AGE;
    const { ctx } = publishBalanceSnapshot(d, [{ fill: VOTER_FILL, balance: 1n }], snapshotTime);
    const pinnedCtx = nextContextAtTime(d.contractAddress, ctx, Number(SILENCE_THRESHOLD));
    const r = d.contract.circuits.createProposal(
      pinnedCtx, ProposalType.SilenceLockTrigger, fakeBytes32(40),
      SILENCE_THRESHOLD, fakeBytes32(0), 0n, fakeBytes32(0), fakeBytes32(90),
    );
    expect(r.result).toBeInstanceOf(Uint8Array);
  });

  it('rejects creating a proposal before the 30-day post-graduation delay', () => {
    const d = deploy();
    // Snapshot published at deploy time (0n) -- explicit override so this
    // test isolates the post-grad-delay assert, not the stale-snapshot one
    // (MIN_POST_GRAD_DELAY - 1n is earlier than the default SILENCE_THRESHOLD
    // snapshot timestamp, which would underflow the elapsed-age check).
    const { ctx } = publishBalanceSnapshot(d, [{ fill: VOTER_FILL, balance: 1n }], 0n);
    const pinnedCtx = nextContextAtTime(d.contractAddress, ctx, Number(MIN_POST_GRAD_DELAY - 1n));
    expect(() =>
      d.contract.circuits.createProposal(
        pinnedCtx, ProposalType.SilenceLockTrigger, fakeBytes32(40),
        MIN_POST_GRAD_DELAY - 1n, fakeBytes32(0), 0n, fakeBytes32(0), fakeBytes32(90),
      ),
    ).toThrow();
  });

  it('rejects a SilenceLockTrigger proposal before the creator has been silent 90 days', () => {
    const d = deploy();
    // Snapshot published right at this test's own createProposal timestamp
    // -- explicit override so this isolates the silence-threshold assert,
    // not the stale-snapshot one.
    const { ctx } = publishBalanceSnapshot(d, [{ fill: VOTER_FILL, balance: 1n }], SILENCE_THRESHOLD - 1n);
    const pinnedCtx = nextContextAtTime(d.contractAddress, ctx, Number(SILENCE_THRESHOLD - 1n));
    expect(() =>
      d.contract.circuits.createProposal(
        pinnedCtx, ProposalType.SilenceLockTrigger, fakeBytes32(40),
        SILENCE_THRESHOLD - 1n, fakeBytes32(0), 0n, fakeBytes32(0), fakeBytes32(90),
      ),
    ).toThrow();
  });

  it('allows creating a SilenceLockTrigger proposal once the creator has been silent long enough', () => {
    const { ctx, proposalId } = deployAndCreateProposal([{ fill: VOTER_FILL, balance: 1n }]);
    const state = ledger(ctx.currentQueryContext.state);
    expect(state.proposalCount).toBe(1n);
    expect(proposalId).toBeInstanceOf(Uint8Array);
  });

  it('rejects a SilenceLockTrigger proposal for a zero-volume launch (T36)', () => {
    const d = deploy(CREATOR_VOTE_CAP, false); // hasClaimableBalance = false at deploy
    const { ctx } = publishBalanceSnapshot(d, [{ fill: VOTER_FILL, balance: 1n }]);
    const pinnedCtx = nextContextAtTime(d.contractAddress, ctx, Number(SILENCE_THRESHOLD));
    expect(() =>
      d.contract.circuits.createProposal(
        pinnedCtx, ProposalType.SilenceLockTrigger, fakeBytes32(40),
        SILENCE_THRESHOLD, fakeBytes32(0), 0n, fakeBytes32(0), fakeBytes32(90),
      ),
    ).toThrow(/claimable/i);
  });

  it('allows a SilenceLockTrigger proposal once the governor attests a real balance exists (T36)', () => {
    const d = deploy(CREATOR_VOTE_CAP, false);
    const { ctx: snapshotCtx } = publishBalanceSnapshot(d, [{ fill: VOTER_FILL, balance: 1n }]);
    // Governor later confirms fees did accrue after all — same call that
    // refreshes lastCreatorActivity also flips hasClaimableBalance.
    const pinnedActivityCtx = nextContextAtTime(d.contractAddress, snapshotCtx, 0);
    const rActivity = d.contract.circuits.updateCreatorActivity(pinnedActivityCtx, 0n, true, 0n);
    const ctx = nextContext(d.contractAddress, rActivity.context);
    const pinnedCtx = nextContextAtTime(d.contractAddress, ctx, Number(SILENCE_THRESHOLD));
    const r = d.contract.circuits.createProposal(
      pinnedCtx, ProposalType.SilenceLockTrigger, fakeBytes32(40),
      SILENCE_THRESHOLD, fakeBytes32(0), 0n, fakeBytes32(0), fakeBytes32(90),
    );
    expect(r.result).toBeInstanceOf(Uint8Array);
  });
});

describe('cto_governance.compact — quorum and majority math (T35 creator vote cap)', () => {
  it('passes a proposal that meets both quorum (5%) and majority', () => {
    const yesWeight = (TOTAL_SUPPLY * 6n) / 100n; // 60,000,000 — clears 5% quorum with a clean majority
    const { contract, contractAddress, ctx, proposalId, createTime, witnessesFor } = deployAndCreateProposal([
      { fill: VOTER_FILL, balance: yesWeight },
    ]);

    const voterContract = new Contract<PrivateState>(witnessesFor(VOTER_FILL));
    const voteTime = createTime + 1n;
    const pinnedVoteCtx = nextContextAtTime(contractAddress, ctx, Number(voteTime));
    const rVote = voterContract.circuits.castVote(pinnedVoteCtx, proposalId, true, voteTime);
    const ctx2 = nextContext(contractAddress, rVote.context);

    const finalizeTime = createTime + BALLOT_DURATION + 1n;
    const pinnedFinalizeCtx = nextContextAtTime(contractAddress, ctx2, Number(finalizeTime));
    const rFinalize = contract.circuits.finalizeProposal(pinnedFinalizeCtx, proposalId, finalizeTime);
    const proposal = ledger(rFinalize.context.currentQueryContext.state).proposals.lookup(proposalId);
    expect(proposal.state).toBe(ProposalState.Passed);
    expect(proposal.yesVotes).toBe(yesWeight);
  });

  it('fails a proposal that has majority support but does not meet quorum', () => {
    const yesWeight = TOTAL_SUPPLY / 100n; // 1% — well under the 5% quorum
    const { contract, contractAddress, ctx, proposalId, createTime, witnessesFor } = deployAndCreateProposal([
      { fill: VOTER_FILL, balance: yesWeight },
    ]);

    const voterContract = new Contract<PrivateState>(witnessesFor(VOTER_FILL));
    const voteTime = createTime + 1n;
    const pinnedVoteCtx = nextContextAtTime(contractAddress, ctx, Number(voteTime));
    const rVote = voterContract.circuits.castVote(pinnedVoteCtx, proposalId, true, voteTime);
    const ctx2 = nextContext(contractAddress, rVote.context);

    const finalizeTime = createTime + BALLOT_DURATION + 1n;
    const pinnedFinalizeCtx = nextContextAtTime(contractAddress, ctx2, Number(finalizeTime));
    const rFinalize = contract.circuits.finalizeProposal(pinnedFinalizeCtx, proposalId, finalizeTime);
    const proposal = ledger(rFinalize.context.currentQueryContext.state).proposals.lookup(proposalId);
    expect(proposal.state).not.toBe(ProposalState.Passed);
  });

  it('fails a proposal that meets quorum but has more no votes than yes votes', () => {
    const yesWeight = (TOTAL_SUPPLY * 3n) / 100n; // 3%
    const noWeight = (TOTAL_SUPPLY * 4n) / 100n; // 4% — combined 7% clears quorum, but no > yes
    const { contract, contractAddress, ctx, proposalId, createTime, witnessesFor } = deployAndCreateProposal([
      { fill: VOTER_FILL, balance: yesWeight },
      { fill: OTHER_VOTER_FILL, balance: noWeight },
    ]);

    const yesVoter = new Contract<PrivateState>(witnessesFor(VOTER_FILL));
    const noVoter = new Contract<PrivateState>(witnessesFor(OTHER_VOTER_FILL));

    const yesTime = createTime + 1n;
    const pinnedYesCtx = nextContextAtTime(contractAddress, ctx, Number(yesTime));
    const rYes = yesVoter.circuits.castVote(pinnedYesCtx, proposalId, true, yesTime);
    const ctx2 = nextContext(contractAddress, rYes.context);

    const noTime = createTime + 2n;
    const pinnedNoCtx = nextContextAtTime(contractAddress, ctx2, Number(noTime));
    const rNo = noVoter.circuits.castVote(pinnedNoCtx, proposalId, false, noTime);

    const finalizeTime = createTime + BALLOT_DURATION + 1n;
    const pinnedFinalizeCtx = nextContextAtTime(contractAddress, nextContext(contractAddress, rNo.context), Number(finalizeTime));
    const rFinalize = contract.circuits.finalizeProposal(pinnedFinalizeCtx, proposalId, finalizeTime);
    const proposal = ledger(rFinalize.context.currentQueryContext.state).proposals.lookup(proposalId);
    expect(proposal.state).not.toBe(ProposalState.Passed);
  });

  it('rejects voting twice on the same proposal from the same identity (vote nullifier)', () => {
    const { contractAddress, ctx, proposalId, createTime, witnessesFor } = deployAndCreateProposal([
      { fill: VOTER_FILL, balance: 1000n },
    ]);
    const voterContract = new Contract<PrivateState>(witnessesFor(VOTER_FILL));

    const vote1Time = createTime + 1n;
    const pinnedCtx1 = nextContextAtTime(contractAddress, ctx, Number(vote1Time));
    const r1 = voterContract.circuits.castVote(pinnedCtx1, proposalId, true, vote1Time);
    const ctx2 = nextContext(contractAddress, r1.context);

    const vote2Time = createTime + 2n;
    const pinnedCtx2 = nextContextAtTime(contractAddress, ctx2, Number(vote2Time));
    expect(() =>
      voterContract.circuits.castVote(pinnedCtx2, proposalId, true, vote2Time),
    ).toThrow();
  });

  it('rejects voting after the 72-hour ballot window closes', () => {
    const { contractAddress, ctx, proposalId, createTime, witnessesFor } = deployAndCreateProposal([{ fill: VOTER_FILL, balance: 1000n }]);
    const voterContract = new Contract<PrivateState>(witnessesFor(VOTER_FILL));
    const voteTime = createTime + BALLOT_DURATION + 1n;
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, Number(voteTime));
    expect(() =>
      voterContract.circuits.castVote(pinnedCtx, proposalId, true, voteTime),
    ).toThrow();
  });

  it('rejects finalizing before the ballot window closes', () => {
    const { contract, contractAddress, ctx, proposalId, createTime } = deployAndCreateProposal([{ fill: VOTER_FILL, balance: 1000n }]);
    const finalizeTime = createTime + BALLOT_DURATION - 1n;
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, Number(finalizeTime));
    expect(() =>
      contract.circuits.finalizeProposal(pinnedCtx, proposalId, finalizeTime),
    ).toThrow();
  });

  it('rejects a vote whose balance proof does not match the pinned snapshot root (forged weight)', () => {
    const { contractAddress, ctx, proposalId, createTime, witnessesFor } = deployAndCreateProposal([
      { fill: VOTER_FILL, balance: 1000n },
    ]);
    // Security-audit fix regression: a caller can no longer just assert an
    // arbitrary weight — supplying a balance that doesn't match this
    // voter's real leaf in the published tree must be rejected.
    const forgedContract = new Contract<PrivateState>(makeWitnesses(VOTER_FILL, 999_999_999n, []));
    const voteTime = createTime + 1n;
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, Number(voteTime));
    expect(() =>
      forgedContract.circuits.castVote(pinnedCtx, proposalId, true, voteTime),
    ).toThrow();
    void witnessesFor;
  });
});

describe('cto_governance.compact — creator vote cap (T35 / creatorVoteCap regression)', () => {
  it('rejects a zero or out-of-range creatorVoteCap at construction', () => {
    expect(() => deploy(0n)).toThrow();
    expect(() => deploy(TOTAL_SUPPLY + 1n)).toThrow();
  });

  it('IMPORTANT FINDING (fixed): a creator-flagged vote above the cap is capped, not zeroed and not unbounded', () => {
    // Before the fix, `creatorVoteCapBps` was declared but never assigned
    // in the constructor, so it silently defaulted to 0 — every
    // creator-flagged vote was capped at ZERO, not the intended 2%. A
    // naive bps-with-missing-/10000 fix (mirroring the walletCap bug)
    // would have gone the other way, making the cap 10000x too large. The
    // real fix takes the cap as a correctly-precomputed constructor arg.
    //
    // isCreator is now derived on-chain from the voter's own identity
    // (design requirement) — this test votes AS the identity
    // whose public key was passed as creatorPubKey at deploy time, rather
    // than passing an isCreator flag directly.
    const aboveCapWeight = CREATOR_VOTE_CAP * 2n;
    const { contractAddress, ctx, proposalId, createTime, witnessesFor } = deployAndCreateProposal([
      { fill: CREATOR_FILL, balance: aboveCapWeight },
    ]);
    const creatorContract = new Contract<PrivateState>(witnessesFor(CREATOR_FILL));
    const voteTime = createTime + 1n;
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, Number(voteTime));
    const rVote = creatorContract.circuits.castVote(pinnedCtx, proposalId, true, voteTime);
    const proposal = ledger(rVote.context.currentQueryContext.state).proposals.lookup(proposalId);
    expect(proposal.creatorYesVotes).toBe(CREATOR_VOTE_CAP);
    expect(proposal.yesVotes).toBe(CREATOR_VOTE_CAP);
  });

  it('a creator-flagged vote at or below the cap passes through unchanged', () => {
    const belowCapWeight = CREATOR_VOTE_CAP / 2n;
    const { contractAddress, ctx, proposalId, createTime, witnessesFor } = deployAndCreateProposal([
      { fill: CREATOR_FILL, balance: belowCapWeight },
    ]);
    const creatorContract = new Contract<PrivateState>(witnessesFor(CREATOR_FILL));
    const voteTime = createTime + 1n;
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, Number(voteTime));
    const rVote = creatorContract.circuits.castVote(pinnedCtx, proposalId, true, voteTime);
    const proposal = ledger(rVote.context.currentQueryContext.state).proposals.lookup(proposalId);
    expect(proposal.creatorYesVotes).toBe(belowCapWeight);
    expect(proposal.yesVotes).toBe(belowCapWeight);
  });

  it('a non-creator vote is never capped, regardless of weight', () => {
    const largeWeight = CREATOR_VOTE_CAP * 10n;
    const { contractAddress, ctx, proposalId, createTime, witnessesFor } = deployAndCreateProposal([
      { fill: VOTER_FILL, balance: largeWeight },
    ]);
    const voterContract = new Contract<PrivateState>(witnessesFor(VOTER_FILL));
    const voteTime = createTime + 1n;
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, Number(voteTime));
    const rVote = voterContract.circuits.castVote(pinnedCtx, proposalId, true, voteTime);
    const proposal = ledger(rVote.context.currentQueryContext.state).proposals.lookup(proposalId);
    expect(proposal.creatorYesVotes).toBe(0n);
    expect(proposal.yesVotes).toBe(largeWeight);
  });

  it('a voter with a self-declared isCreator-style claim cannot borrow the creator cap exemption without the real creator identity', () => {
    // Security-audit fix regression for the original vote-forgery finding:
    // there is no isCreator parameter anymore at all — a non-creator
    // voter's weight is simply never capped, and there is no way to make
    // the circuit treat them as the creator without controlling
    // CREATOR_PUBKEY's actual secret.
    const largeWeight = CREATOR_VOTE_CAP * 5n;
    const { contractAddress, ctx, proposalId, createTime, witnessesFor } = deployAndCreateProposal([
      { fill: OTHER_VOTER_FILL, balance: largeWeight },
    ]);
    const voterContract = new Contract<PrivateState>(witnessesFor(OTHER_VOTER_FILL));
    const voteTime = createTime + 1n;
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, Number(voteTime));
    const rVote = voterContract.circuits.castVote(pinnedCtx, proposalId, true, voteTime);
    const proposal = ledger(rVote.context.currentQueryContext.state).proposals.lookup(proposalId);
    expect(proposal.creatorYesVotes).toBe(0n);
    expect(proposal.yesVotes).toBe(largeWeight);
  });
});

describe('cto_governance.compact — bonded break-glass fallback (governor censorship risk)', () => {
  // deploy()'s constructor sets lastCreatorActivity = GRADUATION_TIMESTAMP
  // (0n), so this is exactly the silence threshold's own elapsed value.
  const SILENT_TIME = SILENCE_THRESHOLD;

  function deployWithoutClaimableBalance() {
    return deploy(CREATOR_VOTE_CAP, false);
  }

  function challengerContract() {
    return new Contract<PrivateState>(makeWitnesses(CHALLENGER_FILL));
  }

  it('rejects opening a challenge when hasClaimableBalance is already true', () => {
    const d = deploy(); // hasClaimableBalance: true by default
    const pinnedCtx = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENT_TIME));
    expect(() =>
      challengerContract().circuits.bondedSilenceChallenge(pinnedCtx, BREAK_GLASS_BOND_MIN, SILENT_TIME),
    ).toThrow(/no need to challenge/i);
  });

  it('rejects opening a challenge before the creator has been silent long enough', () => {
    const d = deployWithoutClaimableBalance();
    const t = SILENCE_THRESHOLD - 1n;
    const pinnedCtx = nextContextAtTime(d.contractAddress, d.ctx, Number(t));
    expect(() =>
      challengerContract().circuits.bondedSilenceChallenge(pinnedCtx, BREAK_GLASS_BOND_MIN, t),
    ).toThrow(/silent long enough/i);
  });

  it('rejects a bond below the minimum', () => {
    const d = deployWithoutClaimableBalance();
    const pinnedCtx = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENT_TIME));
    expect(() =>
      challengerContract().circuits.bondedSilenceChallenge(pinnedCtx, BREAK_GLASS_BOND_MIN - 1n, SILENT_TIME),
    ).toThrow(/below minimum/i);
  });

  it('opens a pending challenge with a valid bond once the creator is genuinely silent', () => {
    const d = deployWithoutClaimableBalance();
    const pinnedCtx = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENT_TIME));
    const r = challengerContract().circuits.bondedSilenceChallenge(pinnedCtx, BREAK_GLASS_BOND_MIN, SILENT_TIME);
    const state = ledger(r.context.currentQueryContext.state);
    expect(state.breakGlassChallenge.state).toBe(BreakGlassState.Pending);
    expect(state.breakGlassChallenge.bondAmount).toBe(BREAK_GLASS_BOND_MIN);
    // hasClaimableBalance is untouched until the challenge actually resolves.
    expect(state.hasClaimableBalance).toBe(false);
  });

  it('rejects opening a second challenge while one is already pending', () => {
    const d = deployWithoutClaimableBalance();
    const pinnedCtx1 = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENT_TIME));
    const r1 = challengerContract().circuits.bondedSilenceChallenge(pinnedCtx1, BREAK_GLASS_BOND_MIN, SILENT_TIME);
    const ctx2 = nextContext(d.contractAddress, r1.context);
    const t2 = SILENT_TIME + 1n;
    const pinnedCtx2 = nextContextAtTime(d.contractAddress, ctx2, Number(t2));
    expect(() =>
      challengerContract().circuits.bondedSilenceChallenge(pinnedCtx2, BREAK_GLASS_BOND_MIN, t2),
    ).toThrow(/already pending/i);
  });

  it('rejects resolving before the response window elapses with no governor response', () => {
    const d = deployWithoutClaimableBalance();
    const pinnedCtx1 = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENT_TIME));
    const r1 = challengerContract().circuits.bondedSilenceChallenge(pinnedCtx1, BREAK_GLASS_BOND_MIN, SILENT_TIME);
    const ctx2 = nextContext(d.contractAddress, r1.context);
    const resolveTime = SILENT_TIME + BREAK_GLASS_RESPONSE_WINDOW - 1n;
    const pinnedResolveCtx = nextContextAtTime(d.contractAddress, ctx2, Number(resolveTime));
    expect(() =>
      d.contract.circuits.resolveBreakGlassChallenge(pinnedResolveCtx, resolveTime),
    ).toThrow(/has not elapsed/i);
  });

  it('auto-confirms and forces hasClaimableBalance true once the response window elapses undefended', () => {
    // This is the actual "break glass": the governor never touched
    // updateCreatorActivity at all since the challenge was opened.
    const d = deployWithoutClaimableBalance();
    const pinnedCtx1 = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENT_TIME));
    const r1 = challengerContract().circuits.bondedSilenceChallenge(pinnedCtx1, BREAK_GLASS_BOND_MIN, SILENT_TIME);
    const ctx2 = nextContext(d.contractAddress, r1.context);

    const resolveTime = SILENT_TIME + BREAK_GLASS_RESPONSE_WINDOW + 1n;
    const pinnedResolveCtx = nextContextAtTime(d.contractAddress, ctx2, Number(resolveTime));
    const r2 = d.contract.circuits.resolveBreakGlassChallenge(pinnedResolveCtx, resolveTime);
    const state = ledger(r2.context.currentQueryContext.state);
    expect(state.hasClaimableBalance).toBe(true);
    expect(state.breakGlassChallenge.state).toBe(BreakGlassState.Confirmed);
    expect(state.breakGlassChallenge.bondAmount).toBe(BREAK_GLASS_BOND_MIN);
  });

  it('T-AUDIT fix (2026-07-21): treats a genuine governor rebuttal (still no claimable balance) as Rebutted, WITHOUT forfeiting the bond', () => {
    // Before the fix, this branch forfeited the bond 60/40 to
    // treasuryAddr/opsAddr — platform-controlled addresses, the SAME party
    // as the governor being checked. That made every challenge against a
    // dishonest governor a free, guaranteed profit for that governor's own
    // platform. Now Rebutted keeps the bond intact, refundable to the
    // challenger — see resolveBreakGlassChallenge's own header comment.
    const d = deployWithoutClaimableBalance();
    const pinnedCtx1 = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENT_TIME));
    const r1 = challengerContract().circuits.bondedSilenceChallenge(pinnedCtx1, BREAK_GLASS_BOND_MIN, SILENT_TIME);
    const ctx2 = nextContext(d.contractAddress, r1.context);

    // Governor genuinely checks in after the challenge and still confirms
    // no claimable balance exists -- real engagement, not silence.
    const activityTime = SILENT_TIME + 1n;
    const pinnedActivityCtx = nextContextAtTime(d.contractAddress, ctx2, Number(activityTime));
    const rActivity = d.contract.circuits.updateCreatorActivity(pinnedActivityCtx, 0n, false, activityTime);
    const ctx3 = nextContext(d.contractAddress, rActivity.context);

    const resolveTime = SILENT_TIME + 2n;
    const pinnedResolveCtx = nextContextAtTime(d.contractAddress, ctx3, Number(resolveTime));
    const r2 = d.contract.circuits.resolveBreakGlassChallenge(pinnedResolveCtx, resolveTime);
    const state = ledger(r2.context.currentQueryContext.state);
    expect(state.hasClaimableBalance).toBe(false);
    expect(state.breakGlassChallenge.state).toBe(BreakGlassState.Rebutted);
    expect(state.breakGlassChallenge.bondAmount).toBe(BREAK_GLASS_BOND_MIN); // no forfeiture
  });

  it('lets the original challenger claim a full refund after Confirmed', () => {
    const d = deployWithoutClaimableBalance();
    const challenger = challengerContract();
    const pinnedCtx1 = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENT_TIME));
    const r1 = challenger.circuits.bondedSilenceChallenge(pinnedCtx1, BREAK_GLASS_BOND_MIN, SILENT_TIME);
    const ctx2 = nextContext(d.contractAddress, r1.context);
    const resolveTime = SILENT_TIME + BREAK_GLASS_RESPONSE_WINDOW + 1n;
    const pinnedResolveCtx = nextContextAtTime(d.contractAddress, ctx2, Number(resolveTime));
    const r2 = d.contract.circuits.resolveBreakGlassChallenge(pinnedResolveCtx, resolveTime);
    const ctx3 = nextContext(d.contractAddress, r2.context);

    const r3 = challenger.circuits.claimBreakGlassBondRefund(ctx3, fakeBytes32(60));
    const state = ledger(r3.context.currentQueryContext.state);
    expect(state.breakGlassChallenge.bondAmount).toBe(0n);

    // Double-claim rejected.
    expect(() =>
      challenger.circuits.claimBreakGlassBondRefund(nextContext(d.contractAddress, r3.context), fakeBytes32(60)),
    ).toThrow(/already claimed/i);
  });

  it('T-AUDIT fix (2026-07-21): lets the original challenger claim a full refund after Rebutted too (no forfeiture)', () => {
    const d = deployWithoutClaimableBalance();
    const challenger = challengerContract();
    const pinnedCtx1 = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENT_TIME));
    const r1 = challenger.circuits.bondedSilenceChallenge(pinnedCtx1, BREAK_GLASS_BOND_MIN, SILENT_TIME);
    const ctx2 = nextContext(d.contractAddress, r1.context);

    const activityTime = SILENT_TIME + 1n;
    const pinnedActivityCtx = nextContextAtTime(d.contractAddress, ctx2, Number(activityTime));
    const rActivity = d.contract.circuits.updateCreatorActivity(pinnedActivityCtx, 0n, false, activityTime);
    const ctx3 = nextContext(d.contractAddress, rActivity.context);

    const resolveTime = SILENT_TIME + 2n;
    const pinnedResolveCtx = nextContextAtTime(d.contractAddress, ctx3, Number(resolveTime));
    const r2 = d.contract.circuits.resolveBreakGlassChallenge(pinnedResolveCtx, resolveTime);
    const ctx4 = nextContext(d.contractAddress, r2.context);

    const r3 = challenger.circuits.claimBreakGlassBondRefund(ctx4, fakeBytes32(60));
    const state = ledger(r3.context.currentQueryContext.state);
    expect(state.breakGlassChallenge.bondAmount).toBe(0n); // fully refunded, no split, no confiscation
  });

  it('rejects a refund claim from someone other than the original challenger', () => {
    const d = deployWithoutClaimableBalance();
    const pinnedCtx1 = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENT_TIME));
    const r1 = challengerContract().circuits.bondedSilenceChallenge(pinnedCtx1, BREAK_GLASS_BOND_MIN, SILENT_TIME);
    const ctx2 = nextContext(d.contractAddress, r1.context);
    const resolveTime = SILENT_TIME + BREAK_GLASS_RESPONSE_WINDOW + 1n;
    const pinnedResolveCtx = nextContextAtTime(d.contractAddress, ctx2, Number(resolveTime));
    const r2 = d.contract.circuits.resolveBreakGlassChallenge(pinnedResolveCtx, resolveTime);
    const ctx3 = nextContext(d.contractAddress, r2.context);

    const impostor = new Contract<PrivateState>(makeWitnesses(OTHER_VOTER_FILL));
    expect(() =>
      impostor.circuits.claimBreakGlassBondRefund(ctx3, fakeBytes32(61)),
    ).toThrow(/original challenger/i);
  });

  it('rejects a refund claim while the challenge is still Pending', () => {
    const d = deployWithoutClaimableBalance();
    const challenger = challengerContract();
    const pinnedCtx1 = nextContextAtTime(d.contractAddress, d.ctx, Number(SILENT_TIME));
    const r1 = challenger.circuits.bondedSilenceChallenge(pinnedCtx1, BREAK_GLASS_BOND_MIN, SILENT_TIME);
    const ctx2 = nextContext(d.contractAddress, r1.context);
    expect(() =>
      challenger.circuits.claimBreakGlassBondRefund(ctx2, fakeBytes32(60)),
    ).toThrow(/not resolved to a refundable state/i);
  });

  it('end-to-end: an undefended break-glass challenge unblocks a SilenceLockTrigger proposal the governor was withholding', () => {
    const d = deployWithoutClaimableBalance();
    const { ctx: snapshotCtx } = publishBalanceSnapshot(d, [{ fill: VOTER_FILL, balance: 1n }]);

    // Without break-glass, this is exactly T36's gate rejecting the
    // proposal because the governor never confirmed a claimable balance.
    const pinnedCreateCtx = nextContextAtTime(d.contractAddress, snapshotCtx, Number(SILENT_TIME));
    expect(() =>
      d.contract.circuits.createProposal(
        pinnedCreateCtx, ProposalType.SilenceLockTrigger, fakeBytes32(40),
        SILENT_TIME, fakeBytes32(0), 0n, fakeBytes32(0), fakeBytes32(90),
      ),
    ).toThrow(/claimable/i);

    const pinnedChallengeCtx = nextContextAtTime(d.contractAddress, snapshotCtx, Number(SILENT_TIME));
    const rChallenge = challengerContract().circuits.bondedSilenceChallenge(pinnedChallengeCtx, BREAK_GLASS_BOND_MIN, SILENT_TIME);
    const ctxAfterChallenge = nextContext(d.contractAddress, rChallenge.context);

    const resolveTime = SILENT_TIME + BREAK_GLASS_RESPONSE_WINDOW + 1n;
    const pinnedResolveCtx = nextContextAtTime(d.contractAddress, ctxAfterChallenge, Number(resolveTime));
    const rResolve = d.contract.circuits.resolveBreakGlassChallenge(pinnedResolveCtx, resolveTime);
    const ctxAfterResolve = nextContext(d.contractAddress, rResolve.context);

    const pinnedProposalCtx = nextContextAtTime(d.contractAddress, ctxAfterResolve, Number(resolveTime));
    const rProposal = d.contract.circuits.createProposal(
      pinnedProposalCtx, ProposalType.SilenceLockTrigger, fakeBytes32(41),
      resolveTime, fakeBytes32(0), 0n, fakeBytes32(0), fakeBytes32(90),
    );
    expect(rProposal.result).toBeInstanceOf(Uint8Array);
  });
});

describe('cto_governance.compact — T-AUDIT fix (2026-07-21, Medium): executeProposal re-validates ctoState', () => {
  it('rejects executing a stale SilenceLockTrigger proposal once ctoState has already changed since it passed', () => {
    // Two SilenceLockTrigger proposals both validly created while
    // ctoState == PreCTO, both pass, but only the FIRST to execute should
    // succeed — the second must now be rejected since ctoState is no
    // longer PreCTO by the time it tries to execute. Before the fix, the
    // second execution would have silently succeeded too, overwriting
    // communityWallet with no error.
    const yesWeight = (TOTAL_SUPPLY * 6n) / 100n; // clears 5% quorum
    const d = deploy();
    const { ctx: snapCtx, witnessesFor } = publishBalanceSnapshot(d, [{ fill: VOTER_FILL, balance: yesWeight }]);

    const communityWalletA = fakeBytes32(70);
    const communityWalletB = fakeBytes32(71);
    const createTime1 = SILENCE_THRESHOLD;
    const pinnedCreate1 = nextContextAtTime(d.contractAddress, snapCtx, Number(createTime1));
    const rCreate1 = d.contract.circuits.createProposal(
      pinnedCreate1, ProposalType.SilenceLockTrigger, fakeBytes32(50),
      createTime1, fakeBytes32(0), 0n, fakeBytes32(0), communityWalletA,
    );
    const proposalId1 = rCreate1.result as Uint8Array;
    let ctx = nextContext(d.contractAddress, rCreate1.context);

    const createTime2 = createTime1 + 10n;
    const pinnedCreate2 = nextContextAtTime(d.contractAddress, ctx, Number(createTime2));
    const rCreate2 = d.contract.circuits.createProposal(
      pinnedCreate2, ProposalType.SilenceLockTrigger, fakeBytes32(51),
      createTime2, fakeBytes32(0), 0n, fakeBytes32(0), communityWalletB,
    );
    const proposalId2 = rCreate2.result as Uint8Array;
    ctx = nextContext(d.contractAddress, rCreate2.context);

    const voter = new Contract<PrivateState>(witnessesFor(VOTER_FILL));
    const voteTime1 = createTime1 + 1n;
    const rVote1 = voter.circuits.castVote(nextContextAtTime(d.contractAddress, ctx, Number(voteTime1)), proposalId1, true, voteTime1);
    ctx = nextContext(d.contractAddress, rVote1.context);
    const voteTime2 = createTime2 + 1n;
    const rVote2 = voter.circuits.castVote(nextContextAtTime(d.contractAddress, ctx, Number(voteTime2)), proposalId2, true, voteTime2);
    ctx = nextContext(d.contractAddress, rVote2.context);

    const finalizeTime = createTime2 + BALLOT_DURATION + 1n;
    const rFin1 = d.contract.circuits.finalizeProposal(nextContextAtTime(d.contractAddress, ctx, Number(finalizeTime)), proposalId1, finalizeTime);
    ctx = nextContext(d.contractAddress, rFin1.context);
    const rFin2 = d.contract.circuits.finalizeProposal(nextContextAtTime(d.contractAddress, ctx, Number(finalizeTime)), proposalId2, finalizeTime);
    ctx = nextContext(d.contractAddress, rFin2.context);

    expect(ledger(ctx.currentQueryContext.state).proposals.lookup(proposalId1).state).toBe(ProposalState.Passed);
    expect(ledger(ctx.currentQueryContext.state).proposals.lookup(proposalId2).state).toBe(ProposalState.Passed);

    // First execution succeeds, sets ctoState = CTOTriggered.
    const rExec1 = d.contract.circuits.executeProposal(ctx, proposalId1);
    const stateAfterExec1 = ledger(rExec1.context.currentQueryContext.state);
    expect(stateAfterExec1.ctoState).toBe(CtoState.CTOTriggered);
    expect(stateAfterExec1.communityWallet).toEqual(communityWalletA);
    const ctxAfterExec1 = nextContext(d.contractAddress, rExec1.context);

    // Second execution — same proposal type, already-passed state, but
    // ctoState is no longer PreCTO — must now be rejected.
    expect(() => d.contract.circuits.executeProposal(ctxAfterExec1, proposalId2)).toThrow(/CTO state changed/i);

    // communityWallet must still be A, never overwritten by B.
    const finalState = ledger(ctxAfterExec1.currentQueryContext.state);
    expect(finalState.communityWallet).toEqual(communityWalletA);
  });
});
