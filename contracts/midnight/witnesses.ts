// ============================================================================
// Noctis Protocol — TypeScript Witness Definitions for All 7 Midnight PSMs
// ============================================================================
// This file provides the TypeScript witness providers for every PSM contract
// in the Noctis Protocol. Each PSM requires specific witnesses that supply
// private data (secret keys, nonces, Merkle proofs) to the circuit without
// revealing them on-chain.
//
// Phase 2 security-audit fix (2026-07-11): darkveil.compact was retired as
// a standalone deployment — its logic is now merged into eligibility_gate.compact
// (Tier B) and was already merged into bonding_curve.compact (Tier C, T25).
// 8 PSMs -> 7: there is no separate DarkVeilWitnesses/darkveilWitnesses
// anymore; getBuyNonce moved into EligibilityGateWitnesses/
// eligibilityGateWitnesses (Tier B) and stays part of BondingCurveWitnesses
// (Tier C, unchanged by this pass).
//
// Usage: import the witness provider for the PSM you're interacting with,
// construct the compiled Contract with it, then call circuits with the
// real, positional-argument `.callTx.<circuit>(...)` API (see
// integration/midnight-client.ts for the full pattern — there is no
// `sdk.call(name, argsRecord)` shape on any real @midnight-ntwrk package):
//
//   const contract = new EligibilityGateContract(
//     eligibilityGateWitnesses(userSk, merkleProof, registrationNonce)
//   );
//   await deployed.callTx.registerForDarkVeil(bondCommitment);
//
// All secret keys are generated client-side and NEVER shared on-chain.
// Domain separation is used across PSMs to prevent key reuse attacks.
//
// Compiler: compactc v0.31.1
// ============================================================================

import {
  persistentHash,
  CompactTypeBytes,
  CompactTypeVector,
} from '@midnight-ntwrk/compact-runtime';

// ============================================================================
// SHARED TYPES
// ============================================================================

/**
 * Every Noctis PSM uses trivial private state — witnesses close over
 * client-held secrets directly rather than accumulating state across calls.
 * Matches the `PrivateState = undefined` convention already validated in
 * contracts/midnight/tests/*.test.ts against the real compiled contracts.
 */
export type PrivateState = undefined;

/**
 * A witness function's real shape, per compactc-generated
 * `Witnesses<PS>` (see any contracts/midnight/compiled/<psm>/contract/index.d.ts):
 * takes a `WitnessContext<Ledger, PS>` and returns `[PS, value]`, NOT a
 * bare `() => value` getter. `Ledger`/`WitnessContext` are intentionally
 * `any` here since this type is only used to shape the tuple return —
 * each PSM's real `Witnesses<PS>` (imported from its own compiled output)
 * is what actually constrains call sites.
 */
type WitnessFn<T> = (context: unknown) => [PrivateState, T];

/** 32-byte secret key — generated client-side, never revealed */
export interface UserSecretKey {
  bytes: Uint8Array; // 32 bytes
}

/** 32-byte public key — derived from secret key via domain-separated hash */
export interface UserPublicKey {
  bytes: Uint8Array; // 32 bytes
}

/**
 * One level of a Merkle inclusion proof — matches
 * eligibility_gate.compact's `MerkleProofEntry` struct (T42, 2026-07-09).
 * `goesLeft` is required per-level (not derivable from a leaf index alone
 * without also fixing the tree's leaf ordering convention) since the
 * circuit needs to know whether to hash(node, sibling) or
 * hash(sibling, node) at each step.
 */
export interface MerkleProofEntry {
  sibling: Uint8Array; // Bytes<32>
  goesLeft: boolean;
}

/**
 * Merkle proof — always exactly 20 entries (T64, 2026-07-12 — depth
 * reduced from the original 32 to cut proving cost; this comment was
 * stale until now), matching the circuit's fixed-depth
 * `Vector<20, MerkleProofEntry>` witness. Build one with
 * `buildAllowlistTree` from packages/zk-proofs/src/eligibility-gate.ts,
 * which implements the exact same node-hashing and padding convention
 * `verifyAllowlist()` checks against.
 */
export type MerkleProof = MerkleProofEntry[]; // 20 entries

/**
 * `pad(32, s)` — Compact's stdlib domain-separator helper. UTF-8 bytes of
 * `s`, right-padded with zero bytes to a fixed 32-byte length. Matches
 * packages/zk-proofs/src/compact-types.ts's `pad32`, duplicated here rather
 * than imported to keep this file dependency-free of that package (no
 * workspace link exists between contracts/midnight and packages/zk-proofs).
 */
function pad32(s: string): Uint8Array {
  const encoded = new TextEncoder().encode(s);
  if (encoded.length > 32) {
    throw new Error(`pad32: "${s}" is ${encoded.length} bytes, exceeds 32`);
  }
  const out = new Uint8Array(32);
  out.set(encoded);
  return out;
}

const bytes32Type = new CompactTypeBytes(32);
const domainKeyVectorType = new CompactTypeVector(2, bytes32Type);

/**
 * Domain-separated key derivation — matches every PSM's
 * `persistentHash<Vector<2, Bytes<32>>>([pad(32, domain), sk.bytes])`
 * pattern exactly (verified against `@midnight-ntwrk/compact-runtime`'s
 * `persistentHash`, the same primitive packages/zk-proofs/src/compact-
 * types.ts's `hashDomainKey` uses and hash-parity.test.ts proves correct
 * against real compiled circuits). Security-audit fix: this used to be a
 * non-hashing byte-slice stub, silently wrong for any real on-chain
 * comparison — integration/midnight-client.ts calls this for real.
 */
export function deriveUserPublicKey(
  sk: UserSecretKey,
  domain: string
): UserPublicKey {
  return { bytes: persistentHash(domainKeyVectorType, [pad32(domain), sk.bytes]) };
}

/** Generate a random 32-byte secret key */
export function generateSecretKey(): UserSecretKey {
  return {
    bytes: crypto.getRandomValues(new Uint8Array(32))
  };
}

/** Generate a random 32-byte nonce */
export function generateNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

// ============================================================================
// DOMAIN SEPARATION STRINGS (must match the pad(32, "...") in each .compact)
// ============================================================================

// Security-audit fix: ELIGIBILITY_*/CURVE_* previously read
// 'noctis:eligibility:...'/'noctis:curve:...', which predates the T25
// merge. eligibility_gate.compact and bonding_curve.compact's merged Tier C
// copy both derive identity under the SAME unified domain today (see
// bonding_curve.compact's file header "Identity note") — kept as two named
// constants (rather than collapsing to one) only so existing call sites
// referencing either name don't need to change, but both now correctly
// point at the one real on-chain domain.
export const DOMAINS = {
  // Eligibility Gate (Tier B, merged with DarkVeil — post-Phase-2: same
  // domain as Bonding Curve, see below. DARKVEIL_USER/GOVERNOR retired
  // along with the standalone darkveil.compact deployment — Tier B's
  // DarkVeil circuits now derive identity under this same domain.)
  ELIGIBILITY_USER: 'noctis:user:pk:v1',
  ELIGIBILITY_GOVERNOR: 'noctis:governor:pk:v1',

  // Bonding Curve (Tier C, merged with Eligibility Gate + DarkVeil, T25:
  // unified with Eligibility Gate's domain)
  CURVE_USER: 'noctis:user:pk:v1',
  CURVE_GOVERNOR: 'noctis:governor:pk:v1',

  // Creator Escrow
  ESCROW_CREATOR: 'noctis:escrow:creator:pk:v1',
  ESCROW_GOVERNOR: 'noctis:escrow:governor:pk:v1',
  ESCROW_COMMUNITY: 'noctis:escrow:community:pk:v1',

  // LP Escrow
  LP_GOVERNOR: 'noctis:lp:governor:pk:v1',
  LP_COMMUNITY: 'noctis:lp:community:pk:v1',

  // Treasury
  TREASURY_GOVERNOR: 'noctis:treasury:governor:pk:v1',

  // CTO Governance
  CTO_USER: 'noctis:cto:user:pk:v1',
  CTO_GOVERNOR: 'noctis:cto:governor:pk:v1',
} as const;

// ============================================================================
// WITNESS PROVIDERS — ONE PER PSM
// ============================================================================

// ---------------------------------------------------------------------------
// 1. ELIGIBILITY GATE PSM (Tier B — merged with DarkVeil, Phase 2 2026-07-11)
// Witnesses: getUserSecret, getMerkleProof, getRegistrationNonce,
//            getGovernorSecret, getBuyNonce
//
// Security-audit fix (Phase 2, 2026-07-11): eligibility_gate.compact is now
// MERGED with darkveil.compact for Tier B (mirrors T25's Tier C merge of
// bonding_curve.compact — Compact has no working cross-contract call
// mechanism, so folding the two sources into one deployed contract with a
// shared ledger was the only way to make claimRatioBondRefund's per-
// registrant purchase data enforceable). getBuyNonce (previously the
// standalone DarkVeilWitnesses/darkveilWitnesses below) is now part of this
// same witness set — there is no separate darkveil.compact deployment for
// either tier anymore.
//
// Design requirement: getAllowlistLeaf removed — the allowlist
// leaf is now derived in-circuit from the caller's own identity
// (verifyAllowlist(caller)), closing the "borrow someone else's leaf+proof"
// gap a free witness value allowed. The off-chain Merkle tree must be built
// with each leaf as hashAllowlistLeaf(registrantPubKey) — see
// packages/zk-proofs/src/eligibility-gate.ts.
// ---------------------------------------------------------------------------

export type EligibilityGateWitnesses = {
  getUserSecret: WitnessFn<UserSecretKey>;
  getMerkleProof: WitnessFn<MerkleProofEntry[]>; // Vector<20, MerkleProofEntry>
  getRegistrationNonce: WitnessFn<Uint8Array>; // Bytes<32>
  getGovernorSecret: WitnessFn<UserSecretKey>;
  getBuyNonce: WitnessFn<Uint8Array>; // Bytes<32>
};

export function eligibilityGateWitnesses(
  userSk: UserSecretKey,
  merkleProof: MerkleProofEntry[],
  registrationNonce: Uint8Array,
  buyNonce: Uint8Array,
  governorSk?: UserSecretKey
): EligibilityGateWitnesses {
  return {
    getUserSecret: () => [undefined, userSk],
    getMerkleProof: () => [undefined, merkleProof],
    getRegistrationNonce: () => [undefined, registrationNonce],
    getGovernorSecret: () => [undefined, governorSk ?? userSk], // fallback for non-admin calls
    getBuyNonce: () => [undefined, buyNonce],
  };
}

// ---------------------------------------------------------------------------
// 2. BONDING CURVE PSM
// Witnesses: getUserSecret, getGovernorSecret
// ---------------------------------------------------------------------------

// T25 fix (2026-07-10): bonding_curve.compact is now MERGED with
// eligibility_gate.compact for Tier C (see the file header in
// contracts/midnight/bonding_curve.compact for why — Compact has no
// working cross-contract call mechanism, so folding the two sources into
// one deployed contract with a shared ledger was the only way to make the
// 5% cumulative cap enforceable). This witness type carries both halves'
// requirements now.
// T25 follow-up (2026-07-10): darkveil.compact's getBuyNonce is now also
// part of this merged contract's witness set — see
// contracts/midnight/bonding_curve.compact's file header for the 3-way
// merge (eligibility_gate + darkveil + bonding_curve, Tier C only).
// Design requirement: getAllowlistLeaf removed here too — same
// reasoning as EligibilityGateWitnesses above (this contract merges that
// same verifyAllowlist(caller) logic for Tier C).
export type BondingCurveWitnesses = {
  getUserSecret: WitnessFn<UserSecretKey>;
  getGovernorSecret: WitnessFn<UserSecretKey>;
  getMerkleProof: WitnessFn<MerkleProofEntry[]>; // Vector<20, MerkleProofEntry>
  getRegistrationNonce: WitnessFn<Uint8Array>; // Bytes<32>
  getBuyNonce: WitnessFn<Uint8Array>; // Bytes<32>
};

export function bondingCurveWitnesses(
  userSk: UserSecretKey,
  merkleProof: MerkleProofEntry[],
  registrationNonce: Uint8Array,
  buyNonce: Uint8Array,
  governorSk?: UserSecretKey
): BondingCurveWitnesses {
  return {
    getUserSecret: () => [undefined, userSk],
    getGovernorSecret: () => [undefined, governorSk ?? userSk],
    getMerkleProof: () => [undefined, merkleProof],
    getRegistrationNonce: () => [undefined, registrationNonce],
    getBuyNonce: () => [undefined, buyNonce],
  };
}

// ---------------------------------------------------------------------------
// 3. CREATOR ESCROW PSM
// Witnesses: getCreatorSecret, getGovernorSecret, getCommunitySecret
// ---------------------------------------------------------------------------

export type CreatorEscrowWitnesses = {
  getCreatorSecret: WitnessFn<UserSecretKey>;
  getGovernorSecret: WitnessFn<UserSecretKey>;
  getCommunitySecret: WitnessFn<UserSecretKey>;
};

export function creatorEscrowWitnesses(
  creatorSk: UserSecretKey,
  governorSk: UserSecretKey,
  communitySk?: UserSecretKey
): CreatorEscrowWitnesses {
  return {
    getCreatorSecret: () => [undefined, creatorSk],
    getGovernorSecret: () => [undefined, governorSk],
    getCommunitySecret: () => [undefined, communitySk ?? creatorSk], // fallback for non-community calls
  };
}

// ---------------------------------------------------------------------------
// 4. VESTING PSM
// Witnesses: getCreatorSecret, getGovernorSecret
// New 2026-07-09 — see the "v3" note on CreatorEscrowCalls above for why
// this is a separate PSM from Creator Escrow. No community witness: the
// CTO redirect here is a one-time freeze-and-hand-off at trigger time
// (matching CLAUDE.md's "frozen, redirected to community treasury"), not
// an ongoing claim relationship like Creator Escrow's post-CTO fee claims.
// ---------------------------------------------------------------------------

export type VestingWitnesses = {
  getCreatorSecret: WitnessFn<UserSecretKey>;
  getGovernorSecret: WitnessFn<UserSecretKey>;
};

export function vestingWitnesses(
  creatorSk: UserSecretKey,
  governorSk: UserSecretKey
): VestingWitnesses {
  return {
    getCreatorSecret: () => [undefined, creatorSk],
    getGovernorSecret: () => [undefined, governorSk],
  };
}

// ---------------------------------------------------------------------------
// 5. LP ESCROW PSM
// Witnesses: getGovernorSecret, getCommunitySecret
// ---------------------------------------------------------------------------

export type LpEscrowWitnesses = {
  getGovernorSecret: WitnessFn<UserSecretKey>;
  getCommunitySecret: WitnessFn<UserSecretKey>;
};

export function lpEscrowWitnesses(
  governorSk: UserSecretKey,
  communitySk?: UserSecretKey
): LpEscrowWitnesses {
  return {
    getGovernorSecret: () => [undefined, governorSk],
    getCommunitySecret: () => [undefined, communitySk ?? governorSk], // fallback for non-CTO calls
  };
}

// ---------------------------------------------------------------------------
// 6. TREASURY PSM
// Witnesses: getGovernorSecret
// ---------------------------------------------------------------------------

export type TreasuryWitnesses = {
  getGovernorSecret: WitnessFn<UserSecretKey>;
};

export function treasuryWitnesses(
  governorSk: UserSecretKey
): TreasuryWitnesses {
  return {
    getGovernorSecret: () => [undefined, governorSk],
  };
}

// ---------------------------------------------------------------------------
// 7. CTO GOVERNANCE PSM
// Witnesses: getUserSecret, getGovernorSecret, getBalanceLeafAmount,
//            getBalanceProof
// Design requirement: getBalanceLeafAmount/getBalanceProof
// added — castVote no longer trusts a caller-supplied voteWeight/isCreator;
// the voter instead proves their real balance via a Merkle proof against a
// governor-published balanceSnapshotRoot. `balanceLeafAmount` is the
// voter's own real balance (private, disclosed only as the vote weight
// itself — which was already public before this fix); `balanceProof` is
// their 20-level inclusion proof (depth reduced from 32, T64, 2026-07-12),
// built with packages/zk-proofs/src/cto-governance.ts's `buildBalanceSnapshotTree`.
// ---------------------------------------------------------------------------

export type CtoGovernanceWitnesses = {
  getUserSecret: WitnessFn<UserSecretKey>;
  getGovernorSecret: WitnessFn<UserSecretKey>;
  getBalanceLeafAmount: WitnessFn<bigint>;
  getBalanceProof: WitnessFn<MerkleProofEntry[]>; // Vector<20, MerkleProofEntry>
};

export function ctoGovernanceWitnesses(
  userSk: UserSecretKey,
  balanceLeafAmount: bigint,
  balanceProof: MerkleProofEntry[],
  governorSk?: UserSecretKey
): CtoGovernanceWitnesses {
  return {
    getUserSecret: () => [undefined, userSk],
    getGovernorSecret: () => [undefined, governorSk ?? userSk], // fallback for non-admin calls
    getBalanceLeafAmount: () => [undefined, balanceLeafAmount],
    getBalanceProof: () => [undefined, balanceProof],
  };
}

// ============================================================================
// CIRCUIT CALLS AND CROSS-PSM COMPOSITION — see integration/midnight-client.ts
// ============================================================================
// The `*Calls` object literals and `merged*` helpers that used to live here
// were built against a fictional `contract.call(name, argsRecord)` /
// `contract.createCall(name, argsRecord)` API — no such methods exist on
// @midnight-ntwrk/midnight-js-contracts's real `FoundContract`/
// `DeployedContract`. The real SDK exposes typed, POSITIONAL circuit calls
// via `deployed.callTx.<circuitName>(...args)`, so a name+object-args
// indirection layer adds nothing beyond what each compiled contract's own
// `Witnesses<PS>`/`ImpureCircuits<PS>` types already give you.
//
// Cross-PSM composition ("merged tx") is also NOT what it looked like here:
// the real SDK's only transaction-batching primitive,
// `withContractScopedTransaction<C, PCK>`, is parameterized by a single
// contract type `C` — it batches multiple calls to ONE contract, not calls
// across different contract types. Confirmed via
// @midnight-ntwrk/midnight-js-contracts@4.1.1's type declarations
// (2026-07-09). This means true cross-PSM atomicity (T2) is not something
// the current public SDK surface provides — Noctis's cross-PSM operations
// (buy + cap check, graduation, CTO execution, cancellation) are called
// sequentially in integration/midnight-client.ts, consistent with
// CLAUDE.md's default 10-minute settlement window pending T2 resolution.
// ============================================================================
