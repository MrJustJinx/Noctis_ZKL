// ============================================================================
// Noctis Protocol — CTO Governance: Balance Snapshot Builder (item #12)
// ============================================================================
// Builds cto_governance.compact's balanceSnapshotRoot Merkle tree for a real
// launch: enumerate every real Cardano holder of the launch token, exclude
// wallets the primary sybil filter flags as creator-linked, resolve each
// remaining holder's Cardano address to their registered Midnight CTO
// voter identity (T101's verifyAndDeriveCtoVoterIdentity /
// CtoVoterRegistry, built earlier this session), then hash into the same
// tree structure cto_governance.compact's on-chain castVote verifies
// against.
//
// $50 USD floor DROPPED for this first pass (decided with Jinx,
// 2026-07-19): no real post-graduation DEX price reader exists anywhere in
// this codebase for any tier (every CTO proposal is gated to 30+ days
// post-graduation, by which point a pre-graduation bonding-curve price
// would be actively wrong to use) — see T100's investigation. Snapshot
// includes every nonzero holder, matching what castVote actually enforces
// on-chain today (weighted by real balance, no floor check exists in the
// circuit itself). Revisit once a real DEX price reader exists.
//
// Sybil defense — primary automatic filter only (item #16's bonded
// challenge contract is the secondary layer, for links this filter
// misses): reuses checkStakeKeyMatch/checkNoDirectAdaFlow from
// eligibility-checker.ts verbatim — same functions T8's DarkVeil
// eligibility check already uses for the identical "is this wallet
// secretly the creator" question, just applied to CTO voting instead of
// DarkVeil registration.
//
// Holders with no CTO voter registration on record (T101) are excluded
// with a real, counted reason (unregisteredCount) — not silently dropped
// — since a holder who never registered simply has no way for the
// governor to know their Midnight voting identity yet.
//
// Split into pure filtering logic (determineSnapshotEntries — trivially
// testable, no network needed) and a thin I/O wrapper
// (buildCtoBalanceSnapshot) that gathers the real per-holder facts and
// calls it — same separation as cto-badge.ts/cto-vote-relayer.ts.
// ============================================================================

import { BlockfrostClient } from './blockfrost-client.js';
import { checkStakeKeyMatch, checkNoDirectAdaFlow } from './eligibility-checker.js';
import type { CtoVoterRegistry } from './cto-voter-registry.js';
import { buildBalanceSnapshotTree, type MerkleProofEntry } from '../packages/zk-proofs/src/cto-governance.js';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export interface SnapshotEntry {
  cardanoAddress: string;
  voterKeyHex: string;
  balance: bigint;
}

/** One real holder's already-gathered facts — everything determineSnapshotEntries needs, with no I/O of its own. */
export interface HolderFact {
  cardanoAddress: string;
  balance: bigint;
  /** True if the primary sybil filter passed (NOT creator-linked) — same polarity as eligibility-checker.ts's own `eligible` fields. */
  sybilFilterPassed: boolean;
  /** The holder's registered CTO voter pubkey hex, or null if never registered (T101). */
  ctoVoterPubKeyHex: string | null;
}

export interface DetermineEntriesResult {
  entries: SnapshotEntry[];
  excludedSybilCount: number;
  unregisteredCount: number;
}

/** Pure decision logic — no I/O. */
export function determineSnapshotEntries(facts: HolderFact[]): DetermineEntriesResult {
  const entries: SnapshotEntry[] = [];
  let excludedSybilCount = 0;
  let unregisteredCount = 0;

  for (const fact of facts) {
    if (fact.balance <= 0n) continue;
    if (!fact.sybilFilterPassed) {
      excludedSybilCount++;
      continue;
    }
    if (!fact.ctoVoterPubKeyHex) {
      unregisteredCount++;
      continue;
    }
    entries.push({ cardanoAddress: fact.cardanoAddress, voterKeyHex: fact.ctoVoterPubKeyHex, balance: fact.balance });
  }

  return { entries, excludedSybilCount, unregisteredCount };
}

export interface SnapshotBuildResult extends DetermineEntriesResult {
  root: Uint8Array;
  /** Total distinct addresses Blockfrost reported holding the token, before any filtering. */
  totalHoldersFound: number;
}

export interface BuildSnapshotConfig {
  policyIdHex: string;
  assetNameHex: string;
  creatorAddress: string;
  /** 90 days per CLAUDE.md's own DarkVeil eligibility check #5 (no direct ADA flow lookback) — reused for consistency, same underlying concern. */
  adaFlowLookbackDays?: number;
}

/** Real I/O wrapper — enumerates real holders, runs the real sybil checks and registry lookups, then builds the tree via the pure function above. */
export async function buildCtoBalanceSnapshot(
  blockfrostClient: BlockfrostClient,
  registry: CtoVoterRegistry,
  config: BuildSnapshotConfig
): Promise<SnapshotBuildResult> {
  const asset = config.policyIdHex + config.assetNameHex;
  const holders = await blockfrostClient.getAssetAddresses(asset);

  const facts: HolderFact[] = await Promise.all(
    holders.map(async (holder): Promise<HolderFact> => {
      const balance = BigInt(holder.quantity);
      if (balance <= 0n) {
        return { cardanoAddress: holder.address, balance, sybilFilterPassed: true, ctoVoterPubKeyHex: null };
      }

      const [stakeMatch, adaFlow] = await Promise.all([
        checkStakeKeyMatch(blockfrostClient, holder.address, config.creatorAddress),
        checkNoDirectAdaFlow(blockfrostClient, holder.address, config.creatorAddress, config.adaFlowLookbackDays ?? 90),
      ]);
      const sybilFilterPassed = stakeMatch.eligible && adaFlow.eligible;

      const registration = sybilFilterPassed ? await registry.lookup(holder.address) : null;

      return {
        cardanoAddress: holder.address,
        balance,
        sybilFilterPassed,
        ctoVoterPubKeyHex: registration?.ctoVoterPubKeyHex ?? null,
      };
    })
  );

  const { entries, excludedSybilCount, unregisteredCount } = determineSnapshotEntries(facts);

  const tree = buildBalanceSnapshotTree(
    entries.map((e) => ({ voterKey: hexToBytes(e.voterKeyHex), balance: e.balance }))
  );

  return {
    root: tree.root,
    entries,
    excludedSybilCount,
    unregisteredCount,
    totalHoldersFound: holders.length,
  };
}

/** Builds a specific voter's inclusion proof from an already-built entry list (e.g. for a client's castVote call). */
export function getSnapshotProof(
  entries: SnapshotEntry[],
  cardanoAddress: string
): { leafIndex: number; proof: MerkleProofEntry[]; balance: bigint } | null {
  const idx = entries.findIndex((e) => e.cardanoAddress === cardanoAddress);
  if (idx === -1) return null;
  const tree = buildBalanceSnapshotTree(entries.map((e) => ({ voterKey: hexToBytes(e.voterKeyHex), balance: e.balance })));
  return { leafIndex: idx, proof: tree.getProof(idx), balance: entries[idx].balance };
}
