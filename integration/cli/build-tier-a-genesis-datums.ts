// ============================================================================
// Noctis Protocol — Tier A Preprod Milestone, Phase 3
// Genesis-datum encoder: BondingCurveDatum / VestingDatum / LpEscrowDatum
// ============================================================================
// Produces the 3 CBOR-encoded inline datums a Tier A mint+seed transaction
// must attach to its 3 genesis outputs (bonding_curve/vesting/lp_escrow's
// fixed script addresses — see finding #1 in TIER_A_PREPROD_MILESTONE.md:
// none of the 3 validators take constructor parameters, so every launch
// shares ONE address per validator and is distinguished purely by its
// datum's launch_id field).
//
// Schemas are imported from ../tier-a-schemas.ts, the SAME module
// read-tier-a-launch-state.ts (Phase 2) uses to decode — Data.to() here is
// the direct inverse of that file's Data.from(), so the two can never
// silently drift apart (the class of bug T66 already caused once for real
// in this project: a stale plutus.json producing a wrong-shaped tx).
//
// Genesis field values below were derived by reading each validator's own
// redeemer-handling logic directly (not assumed from CLAUDE.md prose, which
// documents intent but not exact datum shape) — specifically:
//   - bonding_curve.ak's mock_datum() + Graduate's lp_seeding_output_ok():
//     community_pub_key_hash starts "" (empty), cto_triggered/lp_seeded/
//     staking_seeded start False, lp_escrow_credential/staking_pool_credential
//     are the FIXED script addresses' own credentials (ScriptCredential),
//     not placeholder key credentials — Graduate later verifies real value
//     lands exactly there.
//   - vesting.ak's StartVesting: only checks vesting_state == NotStarted,
//     does not cross-check token_allocation against deposited value — but
//     community_treasury_wallet still starts "" per its own mock_datum().
//   - lp_escrow.ak's SealLock + lp_value_received(): lock_timestamp must be
//     exactly 0, lock_duration must be >= min_lock_duration (31_536_000s /
//     365 days) — and critically, lp_value_received() checks the SEALING
//     transaction deposits exactly datum.lp_token_amount of
//     (datum.lp_token_policy_id, datum.lp_token_name); SealLock's own
//     equality check on new_datum never updates those 3 fields, meaning
//     they must ALREADY be correct at GENESIS, not set later. Concretely:
//     lp_token_policy_id/lp_token_name = the launch's own token identity,
//     lp_token_amount = lp_reserve_tokens (same figure bonding_curve's own
//     lp_reserve_tokens field holds) — confirmed by reading lp_value_received()
//     directly, not assumed from the "15% of supply" prose alone.
//
// launch_id scheme (fresh decision, 2026-07-17, restated explicitly here
// since it wasn't preserved verbatim across a context compaction earlier
// this session): blake2b_256(token_policy_id_bytes ++ token_asset_name_bytes),
// 32 bytes. A minted policy+asset pair is already globally unique per launch
// (Anvil generates a fresh policy per mint) and is known before genesis
// datums are built (policy provisioning happens before the mint tx), so
// hashing it produces a deterministic, collision-safe, opaque launch_id
// with no extra input needed. Uses @noble/hashes/blake2.js's real
// blake2b(msg, {dkLen}) API — same verified-real primitive/package
// zk-cert-relayer.ts already uses for Blake2b-256 hashing on this project.
//
// Credential encoding: CredentialSchema's real runtime shape (verified
// against @lucid-evolution/lucid's own .d.ts, not assumed) is a discriminated
// union of { PubKeyCredential: [hashHex] } | { ScriptCredential: [hashHex] }
// — a different, PlutusData-encoding-specific type from Lucid's own
// address-building `Credential` ({type:"Key"|"Script",hash}), which is NOT
// what Data.to() needs here. lp_escrow/staking_pool script hashes come from
// validatorToScriptHash() against the same freshly-loaded plutus.json
// validators the mint-tx builder and Phase 2's reader both use.
//
// Input: single JSON object on stdin (includes `network`, same
// preview/preprod/mainnet convention as read-tier-a-launch-state.ts). Output:
// single JSON object on stdout with 3 CBOR-hex-encoded datums, the computed
// launch_id, the supply split, AND the 3 fixed validator addresses
// (bonding_curve/vesting/lp_escrow, network-specific, derived the same way
// Phase 2's reader derives them) — so the PHP mint-flow orchestrator never
// needs its own bech32 address derivation; this script is the one place
// that loads plutus.json and owns that logic. Caller attaches the 3 CBOR
// datums as inlineDatum on outputs at these 3 addresses, and persists
// launch_id_hex back to the np_launch CPT (per inc/cpt/launch.php's own
// "populated once minted — Phase 3+" comment).
//
// NOT yet tested against a real Preprod submission — this script only
// proves it can construct byte-correct CBOR; the mint+seed transaction
// itself (build-tier-a-mint-tx.ts or an anvil-client.php extension,
// depending on Phase 0's still-pending datum-output spike result) is the
// next deliverable that actually uses this output for real.
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blake2b } from '@noble/hashes/blake2.js';
import {
  Data,
  validatorToScriptHash,
  validatorToAddress,
} from '@lucid-evolution/lucid';
import type {
  Network as LucidNetwork,
} from '@lucid-evolution/lucid';
import {
  BondingCurveDatumSchema,
  BondingCurveTierBDatumSchema,
  VestingDatumSchema,
  LpEscrowDatumSchema,
  loadValidator,
} from '../tier-a-schemas.js';

declare const __dirname: string;

// ============================================================================
// Input
// ============================================================================

interface BuildGenesisDatumsInput {
  network: 'preview' | 'preprod' | 'mainnet';
  // 'A' (default) → bonding_curve.ak / BondingCurveDatum.
  // 'B' → bonding_curve_tier_b.ak / BondingCurveTierBDatum. The ONLY genesis
  // difference is the curve validator + the curve datum's purchase-tracking
  // fields (Tier A's per_address_purchases vs Tier B's identity_purchases +
  // dv_allocation_root/dv_claimed/dv_settled — the T46 DarkVeil-claim
  // mechanism). Supply split is identical: DarkVeil claims draw from the SAME
  // curve_supply (verified against bonding_curve_tier_b.ak's
  // ClaimDarkVeilTokens — `dv_amount <= curve_supply - tokens_sold`), so there
  // is NO separate DarkVeil token carve-out at genesis. vesting/lp_escrow are
  // the shared validators, identical for both tiers.
  tier?: 'A' | 'B';
  creatorPubKeyHashHex: string;
  governorPubKeyHashHex: string;
  tokenPolicyIdHex: string;
  tokenAssetNameHex: string;

  totalSupply?: number;      // default 1_000_000_000 (CLAUDE.md TOTAL_SUPPLY)
  lpReservePct?: number;     // default 15 (LP_RESERVE_PCT, platform-fixed)
  creatorAllocPct?: number;  // default 5 (CREATOR_ALLOC_REC low end; 5-8 recommended, 10 max)
  walletCapPct?: number;     // default 5 (WALLET_CAP_PCT)
  stakingEnabled?: boolean;  // default false
  stakingAllocPct?: number;  // default 25 (STAKING_ALLOC_PCT), only applied if stakingEnabled

  basePrice: number;         // lovelace/token at sold=0
  maxPrice: number;          // lovelace/token at sold=curve_supply
  vestDays: number;          // 90-365, no default (CLAUDE.md: forced active selection)
  lpLockDurationSeconds?: number; // default 31_536_000 (365 days / LP_LOCK_DAYS, also lp_escrow.ak's own min_lock_duration floor)

  // T119 (2026-07-23): the governance thread-NFT policy id (PolicyId, 28-byte
  // hex) all three genesis datums now carry (cto_governance_nft). Only read by
  // the cto_vote_verified check (CTO voting) — inert for mint/activate/buy/
  // graduate/vest/stake. DEFAULTS to 28 zero bytes: a valid placeholder that
  // lets the full pre-CTO test flow run before the real governance-NFT minting
  // (the open off-chain half of T119) is wired. Set to the real policy id once
  // that minting exists, before any launch that will actually run a CTO vote.
  ctoGovernanceNftPolicyIdHex?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`Odd-length hex string: "${hex}"`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

async function main() {
  const raw = await readStdin();
  let input: BuildGenesisDatumsInput;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON on stdin.');
  }

  const required: Array<keyof BuildGenesisDatumsInput> = [
    'network',
    'creatorPubKeyHashHex',
    'governorPubKeyHashHex',
    'tokenPolicyIdHex',
    'tokenAssetNameHex',
    'basePrice',
    'maxPrice',
    'vestDays',
  ];
  for (const key of required) {
    if (input[key] === undefined || input[key] === null || input[key] === '') {
      throw new Error(`Missing required field: ${key}`);
    }
  }

  const tier = input.tier ?? 'A';
  if (tier !== 'A' && tier !== 'B') {
    throw new Error(`tier must be 'A' or 'B', got ${JSON.stringify(tier)}`);
  }
  const totalSupply = input.totalSupply ?? 1_000_000_000;
  const lpReservePct = input.lpReservePct ?? 15;
  const creatorAllocPct = input.creatorAllocPct ?? 5;
  const walletCapPct = input.walletCapPct ?? 5;
  const stakingEnabled = input.stakingEnabled ?? false;
  const stakingAllocPct = input.stakingAllocPct ?? 25;
  const lpLockDurationSeconds = input.lpLockDurationSeconds ?? 31_536_000;

  if (input.vestDays < 90 || input.vestDays > 365) {
    throw new Error(`vestDays must be 90-365 (VESTING_MIN_DAYS/VESTING_MAX_DAYS), got ${input.vestDays}`);
  }
  if (creatorAllocPct < 0 || creatorAllocPct > 10) {
    throw new Error(`creatorAllocPct must be 0-10 (CREATOR_ALLOC_MAX), got ${creatorAllocPct}`);
  }
  if (lpLockDurationSeconds < 31_536_000) {
    throw new Error(`lpLockDurationSeconds must be >= 31,536,000 (lp_escrow.ak's own min_lock_duration), got ${lpLockDurationSeconds}`);
  }

  const lpReserveTokens = Math.floor((totalSupply * lpReservePct) / 100);
  const creatorAllocTokens = Math.floor((totalSupply * creatorAllocPct) / 100);
  const stakingReserveTokens = stakingEnabled ? Math.floor((totalSupply * stakingAllocPct) / 100) : 0;
  const walletCap = Math.floor((totalSupply * walletCapPct) / 100);
  const curveSupply = totalSupply - lpReserveTokens - creatorAllocTokens - stakingReserveTokens;
  if (curveSupply <= 0) {
    throw new Error(`Supply split leaves curve_supply <= 0 (total=${totalSupply}, lp=${lpReserveTokens}, creator=${creatorAllocTokens}, staking=${stakingReserveTokens}) — allocations too large.`);
  }

  // launch_id = blake2b_256(policy_id_bytes ++ asset_name_bytes) — see file
  // header for the full rationale.
  const policyIdBytes = hexToBytes(input.tokenPolicyIdHex);
  const assetNameBytes = hexToBytes(input.tokenAssetNameHex);
  const launchIdBytes = blake2b(
    new Uint8Array([...policyIdBytes, ...assetNameBytes]),
    { dkLen: 32 }
  );
  const launchIdHex = bytesToHex(launchIdBytes);

  // __dirname resolves relative to the BUNDLED .cjs's real location
  // (cli/dist/), not this source file's — same convention already
  // established and verified by read-tier-a-launch-state.ts.
  const blueprintPath = join(__dirname, '..', '..', '..', 'contracts', 'cardano', 'plutus.json');
  const blueprint = JSON.parse(readFileSync(blueprintPath, 'utf8'));

  const bondingCurveValidator = loadValidator(
    blueprint,
    tier === 'B' ? 'bonding_curve_tier_b.bonding_curve_tier_b.spend' : 'bonding_curve.bonding_curve.spend'
  );
  const vestingValidator = loadValidator(blueprint, 'vesting.vesting.spend');
  const lpEscrowValidator = loadValidator(blueprint, 'lp_escrow.lp_escrow.spend');
  const stakingPoolValidator = loadValidator(blueprint, 'staking_pool.staking_pool.spend');
  const ctoGovernanceValidator = loadValidator(blueprint, 'cto_governance.cto_governance.spend');

  const lpEscrowScriptHash = validatorToScriptHash(lpEscrowValidator as never);
  const stakingPoolScriptHash = validatorToScriptHash(stakingPoolValidator as never);
  const ctoGovernanceScriptHash = validatorToScriptHash(ctoGovernanceValidator as never);

  // T119: the on-chain BondingCurve/Vesting/LpEscrow datums now bind the CTO
  // governance validator's own credential (the redirect target the
  // cto_vote_verified NFT check authorizes) plus the governance thread-NFT
  // policy id. cto_governance_nft defaults to a valid 28-byte-zero placeholder
  // — see BuildGenesisDatumsInput.ctoGovernanceNftPolicyIdHex for why that is
  // safe for the pre-CTO test flow.
  const ctoGovernanceCredential = { ScriptCredential: [ctoGovernanceScriptHash] };
  const ctoGovernanceNftPolicyId = input.ctoGovernanceNftPolicyIdHex ?? '00'.repeat(28);

  // Same Network capitalization mapping as read-tier-a-launch-state.ts
  // (Lucid Evolution's real Network type is "Preprod", not "preprod" —
  // confirmed against @lucid-evolution/core-types' own .d.ts).
  const NETWORK_MAP: Record<BuildGenesisDatumsInput['network'], LucidNetwork> = {
    preview: 'Preview',
    preprod: 'Preprod',
    mainnet: 'Mainnet',
  };
  const network = NETWORK_MAP[input.network];
  const bondingCurveAddress = validatorToAddress(network, bondingCurveValidator as never);
  const vestingAddress = validatorToAddress(network, vestingValidator as never);
  const lpEscrowAddress = validatorToAddress(network, lpEscrowValidator as never);

  const lpEscrowCredential = { ScriptCredential: [lpEscrowScriptHash] };
  const stakingPoolCredential = { ScriptCredential: [stakingPoolScriptHash] };

  // Fields shared by both curve datums. The tier-specific purchase-tracking
  // fields are added below. Data.to() reads fields by the SCHEMA's key order,
  // not this object's — so key position here is irrelevant, only presence +
  // value matter (verified: the round-trip decode below matches the contract's
  // own field order exactly).
  const sharedCurveFields = {
    launch_id: launchIdHex,
    creator_pub_key_hash: input.creatorPubKeyHashHex,
    governor_pub_key_hash: input.governorPubKeyHashHex,
    base_price: BigInt(input.basePrice),
    max_price: BigInt(input.maxPrice),
    curve_supply: BigInt(curveSupply),
    curve_state: 'Inactive',
    activated_at: 0n,
    tokens_sold: 0n,
    total_raised: 0n,
    creator_fees_accrued: 0n,
    treasury_fees_accrued: 0n,
    ops_fees_accrued: 0n,
    wallet_cap: BigInt(walletCap),
    token_policy_id: input.tokenPolicyIdHex,
    token_asset_name: input.tokenAssetNameHex,
    lp_escrow_credential: lpEscrowCredential,
    lp_reserve_tokens: BigInt(lpReserveTokens),
    lp_seeded: false,
    community_pub_key_hash: '',
    cto_triggered: false,
    staking_enabled: stakingEnabled,
    staking_pool_credential: stakingPoolCredential,
    staking_reserve_tokens: BigInt(stakingReserveTokens),
    staking_seeded: false,
    cto_governance_credential: ctoGovernanceCredential,
    cto_governance_nft: ctoGovernanceNftPolicyId,
  };

  const bondingCurveDatum = tier === 'B'
    ? {
        ...sharedCurveFields,
        // Tier B DarkVeil-claim fields (T46/T112). All start empty/false at
        // genesis: identity_purchases fills as wallets transact;
        // dv_allocation_root is anchored later by AnchorDvAllocationRoot (with
        // dv_settled → true), which ActivateCurve then requires.
        identity_purchases: [],
        dv_allocation_root: '',
        dv_claimed: [],
        dv_settled: false,
      }
    : {
        ...sharedCurveFields,
        per_address_purchases: [],
      };

  const bondingCurveSchema = tier === 'B' ? BondingCurveTierBDatumSchema : BondingCurveDatumSchema;

  const vestingDatum = {
    launch_id: launchIdHex,
    creator_pub_key_hash: input.creatorPubKeyHashHex,
    governor_pub_key_hash: input.governorPubKeyHashHex,
    token_allocation: BigInt(creatorAllocTokens),
    vest_days: BigInt(input.vestDays),
    vesting_state: 'NotStarted',
    claimed_tokens: 0n,
    vest_start_timestamp: 0n,
    cto_triggered: false,
    community_treasury_wallet: '',
    token_policy_id: input.tokenPolicyIdHex,
    token_asset_name: input.tokenAssetNameHex,
    cto_governance_credential: ctoGovernanceCredential,
    cto_governance_nft: ctoGovernanceNftPolicyId,
    last_claimed_allocation_timestamp: 0n, // T119: starts at 0 at genesis
  };

  const lpEscrowDatum = {
    launch_id: launchIdHex,
    lock_timestamp: 0n,
    lock_duration: BigInt(lpLockDurationSeconds),
    lp_state: 'Locked', // irrelevant pre-seal — SealLock always overwrites to Locked; no "NotStarted" LpState variant exists
    governor_pub_key_hash: input.governorPubKeyHashHex,
    community_wallet_hash: '',
    cto_triggered: false,
    fee_recipient_pub_key_hash: input.creatorPubKeyHashHex,
    dex_whitelist: [], // confirmed decision 2026-07-17: start empty, add Minswap via real governance in Phase 5b
    multisig_signers: [input.governorPubKeyHashHex], // confirmed decision 2026-07-17: governor only, 1-of-1
    multisig_threshold: 1n,
    pending_dex_change: null,
    lp_token_policy_id: input.tokenPolicyIdHex,
    lp_token_name: input.tokenAssetNameHex,
    lp_token_amount: BigInt(lpReserveTokens),
    cto_governance_credential: ctoGovernanceCredential,
    cto_governance_nft: ctoGovernanceNftPolicyId,
  };

  const bondingCurveCbor = Data.to(bondingCurveDatum as never, bondingCurveSchema);
  const vestingCbor = Data.to(vestingDatum as never, VestingDatumSchema);
  const lpEscrowCbor = Data.to(lpEscrowDatum as never, LpEscrowDatumSchema);

  process.stdout.write(
    JSON.stringify({
      tier,
      launchIdHex,
      supplySplit: {
        totalSupply,
        curveSupply,
        lpReserveTokens,
        creatorAllocTokens,
        stakingReserveTokens,
        walletCap,
      },
      addresses: {
        bondingCurve: bondingCurveAddress,
        vesting: vestingAddress,
        lpEscrow: lpEscrowAddress,
      },
      lpEscrowScriptHash,
      stakingPoolScriptHash,
      datums: {
        bondingCurve: bondingCurveCbor,
        vesting: vestingCbor,
        lpEscrow: lpEscrowCbor,
      },
    })
  );
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
