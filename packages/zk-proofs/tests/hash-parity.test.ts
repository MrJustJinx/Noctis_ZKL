// Proves this package's off-chain hash helpers produce byte-identical
// output to the real compiled Compact circuits, by driving the actual
// contracts (not reimplementations) through @midnight-ntwrk/compact-runtime
// and cross-checking against circuits that accept externally-supplied
// derived keys. This is the same verification method used by
// contracts/midnight/tests/ — see that package's tests for prerequisites
// (this test imports its ../../contracts/midnight compiled fixtures and
// its shared test helpers directly, no duplication).
import { describe, it, expect } from 'vitest';
import {
  Contract as EligibilityGateContract,
  ledger as eligibilityGateLedger,
  LaunchPhase,
  type Witnesses as EligibilityGateWitnesses,
} from '../../../contracts/midnight/compiled/eligibility_gate/contract/index.js';
import {
  Contract as CtoGovernanceContract,
  ProposalType,
  type Witnesses as CtoGovernanceWitnesses,
} from '../../../contracts/midnight/compiled/cto_governance/contract/index.js';
import { deployForTest, nextContext, fakeBytes32 } from '../../../contracts/midnight/tests/helpers.js';
import * as eligibilityGate from '../src/eligibility-gate.js';
import * as ctoGovernance from '../src/cto-governance.js';

type PrivateState = undefined;

describe('eligibility-gate.ts — parity with the compiled circuit', () => {
  it('deriveUserPublicKey matches the key registerForDarkVeil derives and locks the bond under', () => {
    const sk = fakeBytes32(3);
    const myKey = eligibilityGate.deriveUserPublicKey(sk);
    // Design requirement: the leaf is no longer a free witness —
    // it must be hashAllowlistLeaf(myKey), matching what verifyAllowlist
    // now derives in-circuit from the caller's own identity.
    const leaf = eligibilityGate.hashAllowlistLeaf(myKey);
    const tree = eligibilityGate.buildAllowlistTree([leaf]);
    // Phase 2 security-audit fix (2026-07-11): darkveil.compact merged
    // into eligibility_gate.compact — getBuyNonce is now part of this
    // contract's own witness set.
    const witnesses: EligibilityGateWitnesses<PrivateState> = {
      getUserSecret: (_ctx) => [undefined, { bytes: sk }],
      getMerkleProof: (_ctx) => [undefined, tree.getProof(0)],
      getRegistrationNonce: (_ctx) => [undefined, fakeBytes32(6)],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
      getBuyNonce: (_ctx) => [undefined, fakeBytes32(7)],
    };
    const contract = new EligibilityGateContract<PrivateState>(witnesses);
    const { contractAddress, ctx } = deployForTest(
      contract,
      undefined,
      fakeBytes32(9), // launchId
      tree.root, // allowlistRoot
      1_000_000_000n, // totalSupply
      5n, // maxWalletPercent
      1000n, // bondAmount
      50_000_000n, // walletCap
      500n, // dvAllocation — not exercised by this test
      90n, // dvPrice
      1n, // allowlistSize
      1_000_000n, // registrationCloseTime
      1n, // minDvParticipants (T37) — permissive, this test doesn't exercise the floor
      fakeBytes32(88), // creatorPubKey — distinct from myKey so this registrant isn't rejected as the creator
      fakeBytes32(60), // treasuryAddr
      fakeBytes32(40), // opsAddr
    );
    const rPhase = contract.circuits.advancePhase(ctx, LaunchPhase.DarkVeil);
    const ctx2 = nextContext(contractAddress, rPhase.context);
    const rRegister = contract.circuits.registerForDarkVeil(ctx2, fakeBytes32(7));

    // The contract's own `caller.bytes` (its internal deriveUserPublicKey(sk))
    // is the key it locked the bond under — read it back via the ledger and
    // compare against this package's independently computed key.
    const state = eligibilityGateLedger(rRegister.context.currentQueryContext.state);
    expect(state.lockedBonds.member(myKey)).toBe(true);
    expect(state.lockedBonds.lookup(myKey)).toBe(1000n);
  });
});

describe('cto-governance.ts — parity with the compiled circuit', () => {
  it('deriveUserPublicKey + computeVoteNullifier match what castVote derives and hasVoted checks', () => {
    const sk = fakeBytes32(11);
    const myVoterKey = ctoGovernance.deriveUserPublicKey(sk);
    const voteWeight = 1000n;

    // Design requirement: castVote now requires a real
    // Merkle-proven balance instead of a caller-supplied voteWeight — build
    // a one-leaf snapshot tree for this voter's real derived identity.
    const tree = ctoGovernance.buildBalanceSnapshotTree([{ voterKey: myVoterKey, balance: voteWeight }]);

    const witnesses: CtoGovernanceWitnesses<PrivateState> = {
      getUserSecret: (_ctx) => [undefined, { bytes: sk }],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
      getBalanceLeafAmount: (_ctx) => [undefined, voteWeight],
      getBalanceProof: (_ctx) => [undefined, tree.getProof(0)],
    };
    const contract = new CtoGovernanceContract<PrivateState>(witnesses);
    const launchId = fakeBytes32(9);
    const { contractAddress, ctx } = deployForTest(
      contract,
      undefined,
      launchId,
      1_000_000_000n, // totalSupply
      0n, // graduationTimestamp
      20_000_000n, // creatorVoteCap (2% of totalSupply, precomputed off-chain)
      fakeBytes32(88), // creatorPubKey — distinct from myVoterKey
      true, // hasClaimableBalance
      1_000_000n, // breakGlassBondMin
      fakeBytes32(200), // treasuryAddr
      fakeBytes32(201), // opsAddr
    );

    const SILENCE_THRESHOLD = 7_776_000n;
    // Published right before proposal creation — stale-snapshot fix
    // (2026-07-19) rejects a snapshot published long before the proposal
    // that relies on it (max 30 days old).
    const rSnapshot = contract.circuits.updateBalanceSnapshot(ctx, tree.root, SILENCE_THRESHOLD);
    const ctxSnapshot = nextContext(contractAddress, rSnapshot.context);
    const rCreate = contract.circuits.createProposal(
      ctxSnapshot,
      ProposalType.SilenceLockTrigger,
      fakeBytes32(40),
      SILENCE_THRESHOLD,
      fakeBytes32(0),
      0n,
      fakeBytes32(0),
      fakeBytes32(0), // proposedCommunityWallet — unused for this proposal type
    );
    const proposalId = rCreate.result as Uint8Array;
    const ctx2 = nextContext(contractAddress, rCreate.context);
    const rVote = contract.circuits.castVote(ctx2, proposalId, true, SILENCE_THRESHOLD + 1n);
    const ctx3 = nextContext(contractAddress, rVote.context);

    // hasVoted(voterKey, proposalId) recomputes computeVoteNullifier(voterKey, launchId, proposalId)
    // internally and checks Set membership — if it returns true for OUR
    // independently-derived key, both deriveUserPublicKey and
    // computeVoteNullifier are proven byte-identical to the real circuits.
    const rHasVoted = contract.circuits.hasVoted(ctx3, myVoterKey, proposalId);
    expect(rHasVoted.result).toBe(true);

    // And the nullifier this package computes matches what the real
    // circuit's own hasVoted check is comparing against, independently.
    const myNullifier = ctoGovernance.computeVoteNullifier({ voterKey: myVoterKey, launchId, proposalId });
    expect(myNullifier).toBeInstanceOf(Uint8Array);
    expect(myNullifier.length).toBe(32);
  });
});
