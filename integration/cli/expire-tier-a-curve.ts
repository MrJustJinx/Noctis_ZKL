// ============================================================================
// Noctis Protocol — Tier A Preprod Milestone, Phase 7
// ExpireCurve (bonding_curve.ak) — permissionless on-chain (T29/T90), the
// governor's key here is only used as this CLI's fee-paying/signing
// wallet, not for authorization. See tier-a-curve-submitter.ts's
// expireCurve() header for the T90 real-narrow-validity-range requirement.
// ============================================================================
// Input: single JSON object on stdin, including the governor's PLAINTEXT
// 64-byte extended private key hex (decrypted server-side by the PHP
// caller). Never logged. Output: {txHash} on stdout.
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LucidTierACurveSubmitter } from '../tier-a-curve-submitter.js';
import type { Network as LucidNetwork } from '@lucid-evolution/lucid';

declare const __dirname: string;

interface ExpireCurveInput {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  governorAddress: string;
  governorPrivateKeyExtendedHex: string;
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
  let input: ExpireCurveInput;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON on stdin.');
  }

  const required: Array<keyof ExpireCurveInput> = [
    'network', 'launchIdHex', 'governorAddress', 'governorPrivateKeyExtendedHex',
    'blockfrostProjectId', 'blockfrostUrl',
  ];
  for (const key of required) {
    if (!input[key] && input[key] !== 0) {
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

  const NETWORK_MAP: Record<ExpireCurveInput['network'], LucidNetwork> = {
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

  const result = await submitter.expireCurve(
    input.governorPrivateKeyExtendedHex,
    input.governorAddress
  );
  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  if (process.env.NOCTIS_DEBUG) {
    console.error('FULL ERROR:', err);
    console.error('STACK:', err instanceof Error ? err.stack : null);
  }
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
