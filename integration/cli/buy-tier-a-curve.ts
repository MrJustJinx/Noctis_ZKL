// ============================================================================
// Noctis Protocol — Tier A Preprod Milestone, Phase 4
// BuyTokens — buyer-signed, mnemonic-based (this session's CLI-driven
// verification path; see tier-a-curve-submitter.ts's header for why this
// isn't the real browser-wallet production path, which is a deferred Launch
// Wizard task).
// ============================================================================
// Input: single JSON object on stdin. Output: single JSON object on stdout
// ({txHash, grossPayment, claimedPrice}).
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LucidTierACurveSubmitter } from '../tier-a-curve-submitter.js';
import type { Network as LucidNetwork } from '@lucid-evolution/lucid';

declare const __dirname: string;

interface BuyTierACurveInput {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  buyerMnemonic: string;
  tokenAmount: string; // stringified bigint over stdin JSON
  blockfrostProjectId: string;
  blockfrostUrl: string;
  /** See tier-a-curve-submitter.ts's buyTokens() docs — deliberate on-chain
   *  cap-rejection verification only, never a real buy flow. */
  skipClientCapCheck?: boolean;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  }
  return value;
}

async function main() {
  const raw = await readStdin();
  let input: BuyTierACurveInput;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON on stdin.');
  }

  const required: Array<keyof BuyTierACurveInput> = [
    'network', 'launchIdHex', 'buyerMnemonic', 'tokenAmount',
    'blockfrostProjectId', 'blockfrostUrl',
  ];
  for (const key of required) {
    if (!input[key]) {
      throw new Error(`Missing required field: ${key}`);
    }
  }

  const blueprintPath = join(__dirname, '..', '..', '..', 'contracts', 'cardano', 'plutus.json');
  const blueprint = JSON.parse(readFileSync(blueprintPath, 'utf8'));
  const validatorEntry = blueprint.validators.find(
    (v: { title: string }) => v.title === 'bonding_curve.bonding_curve.spend'
  );
  if (!validatorEntry) {
    throw new Error('bonding_curve.bonding_curve.spend not found in plutus.json.');
  }

  const NETWORK_MAP: Record<BuyTierACurveInput['network'], LucidNetwork> = {
    preview: 'Preview',
    preprod: 'Preprod',
    mainnet: 'Mainnet',
  };

  const submitter = new LucidTierACurveSubmitter({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    network: NETWORK_MAP[input.network],
    compiledScriptCbor: validatorEntry.compiledCode,
    launchIdHex: input.launchIdHex,
  });

  const result = await submitter.buyTokens(
    input.buyerMnemonic,
    BigInt(input.tokenAmount),
    input.skipClientCapCheck ?? false
  );
  process.stdout.write(JSON.stringify(jsonSafe(result)));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
