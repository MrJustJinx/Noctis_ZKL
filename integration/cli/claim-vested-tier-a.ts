// ============================================================================
// Noctis Protocol — Tier A Preprod Milestone, Phase 6
// ClaimVested (vesting.ak) — creator-signed. See
// tier-a-claims-submitter.ts's header for the T92 fix this depends on.
// ============================================================================
// Input: single JSON object on stdin, including the creator's PLAINTEXT
// 64-byte extended private key hex (decrypted server-side by the PHP
// caller). Never logged. Output: {txHash} on stdout.
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TierAClaimsSubmitter } from '../tier-a-claims-submitter.js';
import type { Network as LucidNetwork } from '@lucid-evolution/lucid';

declare const __dirname: string;

interface ClaimVestedInput {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  creatorAddress: string;
  creatorPrivateKeyExtendedHex: string;
  claimAmount: string;
  currentTimestampSeconds: number;
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
  let input: ClaimVestedInput;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON on stdin.');
  }

  const required: Array<keyof ClaimVestedInput> = [
    'network', 'launchIdHex', 'creatorAddress', 'creatorPrivateKeyExtendedHex',
    'claimAmount', 'currentTimestampSeconds', 'blockfrostProjectId', 'blockfrostUrl',
  ];
  for (const key of required) {
    if (!input[key] && input[key] !== 0) {
      throw new Error(`Missing required field: ${key}`);
    }
  }

  const blueprintPath = join(__dirname, '..', '..', '..', 'contracts', 'cardano', 'plutus.json');
  const blueprint = JSON.parse(readFileSync(blueprintPath, 'utf8'));

  function findScript(title: string): string {
    const entry = blueprint.validators.find((v: { title: string }) => v.title === title);
    if (!entry) throw new Error(`${title} not found in plutus.json.`);
    return entry.compiledCode;
  }

  const NETWORK_MAP: Record<ClaimVestedInput['network'], LucidNetwork> = {
    preview: 'Preview',
    preprod: 'Preprod',
    mainnet: 'Mainnet',
  };

  const submitter = new TierAClaimsSubmitter({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    network: NETWORK_MAP[input.network],
    vestingScriptCbor: findScript('vesting.vesting.spend'),
    bondingCurveScriptCbor: findScript('bonding_curve.bonding_curve.spend'),
    launchIdHex: input.launchIdHex,
  });

  const result = await submitter.claimVested(
    input.creatorPrivateKeyExtendedHex,
    input.creatorAddress,
    BigInt(input.claimAmount),
    input.currentTimestampSeconds
  );
  process.stdout.write(JSON.stringify({ txHash: result.txHash }));
}

main().catch((err) => {
  if (process.env.NOCTIS_DEBUG) {
    console.error('FULL ERROR:', err);
    console.error('KEYS:', err && typeof err === 'object' ? Object.keys(err) : null);
    console.error('STACK:', err instanceof Error ? err.stack : null);
  }
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
