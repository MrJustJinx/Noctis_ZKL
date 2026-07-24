// ============================================================================
// Noctis Protocol — Tier A/B Trade History CLI
// ============================================================================
// Thin stdin/stdout wrapper around tier-a-trade-history-reader.ts's
// getCurveTradeHistory(), same proc_open calling convention as
// read-tier-a-launch-state.ts (single JSON object on stdin, single JSON
// object on stdout, exit 0 on success even for an empty/not-found result).
//
// Deliberately returns raw decoded TradeEvent[] and lets the PHP bridge
// (trade-history-reader.php) own the incremental-cache boundary and the
// candle-bucketing interpretation — this CLI's only job is "decode what's
// new on chain since stopAtTxHash," not aggregation. Keeps the Node layer a
// pure chain-decoder, matching this project's existing split (chain-state-
// reader.php interprets/caches; the CLI it calls only decodes).
//
// Bundled as CJS (see build.mjs) — __dirname is a native CJS global here,
// same reasoning as read-tier-a-launch-state.ts.
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validatorToAddress } from '@lucid-evolution/lucid';
import type { Network as LucidNetwork } from '@lucid-evolution/lucid';
import { loadValidator } from '../tier-a-schemas.js';
import { TierATradeHistoryReader, type TradeEvent } from '../tier-a-trade-history-reader.js';

declare const __dirname: string;

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  }
  return value;
}

interface ReadTradeHistoryInput {
  launchIdHex: string;
  network: 'preview' | 'preprod' | 'mainnet';
  blockfrostProjectId: string;
  blockfrostUrl: string;
  /** Tier B launches resolve to bonding_curve_tier_b.ak's own fixed script
   *  address instead of Tier A's bonding_curve.ak — everything else about
   *  the walk is identical (Step 8 of the trade-history plan). */
  tier: 'A' | 'B';
  /** Incremental-cache boundary — omit to walk all the way to genesis. */
  stopAtTxHash?: string;
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
  let input: ReadTradeHistoryInput;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON on stdin.');
  }

  const required: Array<keyof ReadTradeHistoryInput> = [
    'launchIdHex',
    'network',
    'blockfrostProjectId',
    'blockfrostUrl',
    'tier',
  ];
  for (const key of required) {
    if (!input[key]) {
      throw new Error(`Missing required field: ${key}`);
    }
  }

  // __dirname resolves relative to where the BUNDLED .cjs actually runs
  // from (cli/dist/), same '..'-count as read-tier-a-launch-state.ts.
  const blueprintPath = join(__dirname, '..', '..', '..', 'contracts', 'cardano', 'plutus.json');
  const blueprint = JSON.parse(readFileSync(blueprintPath, 'utf8'));

  const validatorTitle = input.tier === 'B'
    ? 'bonding_curve_tier_b.bonding_curve_tier_b.spend'
    : 'bonding_curve.bonding_curve.spend';
  const bondingCurveValidator = loadValidator(blueprint, validatorTitle);

  const NETWORK_MAP: Record<ReadTradeHistoryInput['network'], LucidNetwork> = {
    preview: 'Preview',
    preprod: 'Preprod',
    mainnet: 'Mainnet',
  };
  const network = NETWORK_MAP[input.network];
  const bondingCurveAddress = validatorToAddress(network, bondingCurveValidator);

  const reader = new TierATradeHistoryReader({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    bondingCurveAddress,
    launchIdHex: input.launchIdHex,
    tier: input.tier,
  });

  const events: TradeEvent[] = await reader.getCurveTradeHistory(input.stopAtTxHash);

  process.stdout.write(
    JSON.stringify({
      events: jsonSafe(events),
      newestTxHash: events.length ? events[events.length - 1].txHash : (input.stopAtTxHash ?? null),
    })
  );
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
