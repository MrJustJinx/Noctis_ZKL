// ============================================================================
// Noctis Protocol — Tier A Preprod Milestone, Phase 7
// ClaimBuyback — buyer-signed, mnemonic-based (this session's CLI-driven
// verification path, same convention as buy-tier-a-curve.ts).
// ============================================================================
// Input: single JSON object on stdin. Output: single JSON object on stdout
// ({txHash, share}).
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LucidTierACurveSubmitter } from '../tier-a-curve-submitter.js';
import type { Network as LucidNetwork } from '@lucid-evolution/lucid';

declare const __dirname: string;

interface ClaimBuybackInput {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  buyerMnemonic: string;
  tokenAmount: string; // stringified bigint over stdin JSON
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
  let input: ClaimBuybackInput;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON on stdin.');
  }

  const required: Array<keyof ClaimBuybackInput> = [
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

  const NETWORK_MAP: Record<ClaimBuybackInput['network'], LucidNetwork> = {
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

  const result = await submitter.claimBuyback(input.buyerMnemonic, BigInt(input.tokenAmount));
  process.stdout.write(JSON.stringify(jsonSafe(result)));
}

main().catch((err) => {
  if (process.env.NOCTIS_DEBUG) {
    console.error('FULL ERROR:', err);
    console.error('STACK:', err instanceof Error ? err.stack : null);
  }
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
