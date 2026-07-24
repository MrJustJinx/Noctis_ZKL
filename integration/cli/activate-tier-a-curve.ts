// ============================================================================
// Noctis Protocol — Tier A Preprod Milestone, Phase 4
// ActivateCurve — governor-signed, single-phase (see tier-a-curve-
// submitter.ts's own header for why the original two-phase build/sign(PHP)/
// submit design was abandoned: WeldPress's CBOR parser rejected Lucid's
// indefinite-length encoding, and a canonical-CBOR workaround then hit a
// ScriptIntegrityHashMismatch from reconstructing the tx in a separate
// process. Signing directly here with CML.PrivateKey.from_extended_bytes()
// avoids both.)
// ============================================================================
// Input: single JSON object on stdin, including the governor's PLAINTEXT
// 64-byte extended private key hex (decrypted server-side by the PHP
// caller — same trust boundary it already crosses for the mint flow's
// policy-wallet signing). Never logged. Output: {txHash} on stdout.
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LucidTierACurveSubmitter } from '../tier-a-curve-submitter.js';
import type { Network as LucidNetwork } from '@lucid-evolution/lucid';

declare const __dirname: string;

interface ActivateCurveInput {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  governorAddress: string;
  governorPrivateKeyExtendedHex: string;
  currentTimestampMs: number;
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
  let input: ActivateCurveInput;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON on stdin.');
  }

  const required: Array<keyof ActivateCurveInput> = [
    'network', 'launchIdHex', 'governorAddress', 'governorPrivateKeyExtendedHex',
    'currentTimestampMs', 'blockfrostProjectId', 'blockfrostUrl',
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

  const NETWORK_MAP: Record<ActivateCurveInput['network'], LucidNetwork> = {
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

  const result = await submitter.activateCurve(
    input.governorPrivateKeyExtendedHex,
    input.governorAddress,
    input.currentTimestampMs
  );
  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
