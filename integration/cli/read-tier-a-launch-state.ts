// ============================================================================
// Noctis Protocol — Tier A Preprod Milestone, Phase 2
// Live chain-state reader: bonding_curve / vesting / lp_escrow, by launch_id
// ============================================================================
// None of Tier A's 3 relevant validators (bonding_curve.ak, vesting.ak,
// lp_escrow.ak) take constructor parameters — confirmed directly against
// contracts/cardano/plutus.json (`parameters` is undefined on all 3 spend
// validators). Every launch shares ONE fixed script address per validator;
// finding a specific launch's state means scanning that address's UTxOs for
// the one whose datum's `launch_id` field matches.
//
// Schema note: every field name/order/constructor-index below is read
// directly from contracts/cardano/plutus.json at runtime (fs.readFileSync,
// not a bundled import) — never hardcoded or copied from .ak source
// comments, which can drift (confirmed happening for real once already this
// project, T66 — see darkveil-claim-submitter.ts's own header for the same
// lesson). Re-run `aiken build` before trusting this script if any of the 3
// .ak files have changed since the last build.
//
// Script hashes as of 2026-07-16 (post-T81 — bonding_curve.ak and
// lp_escrow.ak's bytecode changed that day; vesting.ak did not):
//   bonding_curve.bonding_curve.spend -> e7a7fbbc8ec4b39e5e4d6d9555979114ab9895bafe67363733228db6
//   lp_escrow.lp_escrow.spend         -> 868f16110286a39c7bd5ab5178a876802e37312c039bdde44777710e
//   vesting.vesting.spend             -> ba28cd17f164026b1749fa412e110aba92637aeab12a5212f3c286cc
// Not hardcoded as constants below — derived fresh from plutus.json's own
// compiledCode via validatorToAddress() every run, so this file can never
// silently drift from what's actually deployed.
//
// Input: single JSON object on stdin (never argv), same convention as
// check-night-balance.ts. Output: single JSON object on stdout, exit 0 on a
// successful check (found or not-found are both success), non-zero with
// {"error": "..."} on any failure the caller couldn't complete.
//
// NOT yet tested against a real launch's UTxOs — no real mint has happened
// yet (Phase 3 of this milestone). What IS real and tested: the "not found"
// path against real Preprod addresses that today hold zero UTxOs (Phase 3
// hasn't seeded them), which is exactly this phase's own checkpoint.
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Blockfrost,
  Data,
  Lucid,
  validatorToAddress,
} from '@lucid-evolution/lucid';
import type {
  Network as LucidNetwork,
} from '@lucid-evolution/lucid';
import {
  BondingCurveDatumSchema,
  VestingDatumSchema,
  LpEscrowDatumSchema,
  loadValidator,
} from '../tier-a-schemas.js';

// Bundled as CJS (see build.mjs's readTierALaunchStateCliConfig comment) —
// __dirname is a native CJS global here, no fileURLToPath(import.meta.url)
// dance needed the way the ESM-format CLI bundles in this directory do.
declare const __dirname: string;

// Datum schemas (BondingCurveDatumSchema/VestingDatumSchema/LpEscrowDatumSchema)
// and loadValidator() now live in ../tier-a-schemas.ts, shared with the
// genesis-datum encoder (Phase 3) so the two can never drift apart — see
// that file's own header for the full rationale. Extracted 2026-07-17.

// ============================================================================
// Helpers
// ============================================================================

/** BigInt -> string, everything else passed through, for JSON-safe output. */
function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  }
  return value;
}

// ============================================================================
// Input
// ============================================================================

interface ReadLaunchStateInput {
  launchIdHex: string;
  network: 'preview' | 'preprod' | 'mainnet';
  blockfrostProjectId: string;
  blockfrostUrl: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const raw = await readStdin();
  let input: ReadLaunchStateInput;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON on stdin.');
  }

  const required: Array<keyof ReadLaunchStateInput> = [
    'launchIdHex',
    'network',
    'blockfrostProjectId',
    'blockfrostUrl',
  ];
  for (const key of required) {
    if (!input[key]) {
      throw new Error(`Missing required field: ${key}`);
    }
  }

  // __dirname resolves relative to where the BUNDLED .cjs actually runs
  // from (cli/dist/), not this source file's own location (cli/) — one
  // extra '..' to compensate for that (found via a real run, not assumed).
  const blueprintPath = join(__dirname, '..', '..', '..', 'contracts', 'cardano', 'plutus.json');
  const blueprint = JSON.parse(readFileSync(blueprintPath, 'utf8'));

  const bondingCurveValidator = loadValidator(blueprint, 'bonding_curve.bonding_curve.spend');
  const vestingValidator = loadValidator(blueprint, 'vesting.vesting.spend');
  const lpEscrowValidator = loadValidator(blueprint, 'lp_escrow.lp_escrow.spend');

  // Lucid Evolution's real Network type is capitalized ("Preprod", not
  // "preprod" — confirmed against @lucid-evolution/core-types' own .d.ts,
  // not assumed) — this input field stays lowercase for consistency with
  // every other network field across this codebase's PHP/TS boundary.
  const NETWORK_MAP: Record<ReadLaunchStateInput['network'], LucidNetwork> = {
    preview: 'Preview',
    preprod: 'Preprod',
    mainnet: 'Mainnet',
  };
  const network = NETWORK_MAP[input.network];
  const bondingCurveAddress = validatorToAddress(network, bondingCurveValidator);
  const vestingAddress = validatorToAddress(network, vestingValidator);
  const lpEscrowAddress = validatorToAddress(network, lpEscrowValidator);

  const lucid = await Lucid(
    new Blockfrost(input.blockfrostUrl, input.blockfrostProjectId),
    network
  );

  async function findLaunchUtxo<T>(address: string, schema: T): Promise<{ decoded: unknown; txHash: string; outputIndex: number } | null> {
    const utxos = await lucid.utxosAt(address);
    for (const utxo of utxos) {
      if (!utxo.datum) continue;
      let decoded: unknown;
      try {
        decoded = Data.from(utxo.datum, schema as never);
      } catch {
        continue; // datum doesn't match this schema shape — not our launch's UTxO (or a stale/foreign one)
      }
      const d = decoded as { launch_id?: string };
      if (d.launch_id === input.launchIdHex) {
        return { decoded, txHash: utxo.txHash, outputIndex: utxo.outputIndex };
      }
    }
    return null;
  }

  const [bondingCurve, vesting, lpEscrow] = await Promise.all([
    findLaunchUtxo(bondingCurveAddress, BondingCurveDatumSchema),
    findLaunchUtxo(vestingAddress, VestingDatumSchema),
    findLaunchUtxo(lpEscrowAddress, LpEscrowDatumSchema),
  ]);

  process.stdout.write(
    JSON.stringify({
      found: !!(bondingCurve || vesting || lpEscrow),
      bondingCurve: bondingCurve ? { ...jsonSafe(bondingCurve.decoded) as object, txHash: bondingCurve.txHash, outputIndex: bondingCurve.outputIndex } : null,
      vesting: vesting ? { ...jsonSafe(vesting.decoded) as object, txHash: vesting.txHash, outputIndex: vesting.outputIndex } : null,
      lpEscrow: lpEscrow ? { ...jsonSafe(lpEscrow.decoded) as object, txHash: lpEscrow.txHash, outputIndex: lpEscrow.outputIndex } : null,
    })
  );
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
