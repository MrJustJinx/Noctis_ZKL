// ============================================================================
// Noctis Protocol — Tier A Preprod Milestone, Phase 5
// Graduate + SealLock + StartVesting.
// T91 (2026-07-17): split into TWO sequential transactions — TX1 (Graduate +
// SealLock) and TX2 (StartVesting) — real Preprod tx size limit (16384
// bytes) is exceeded by embedding all 3 validators in one tx after T90's
// fix grew bonding_curve.ak/lp_escrow.ak's bytecode. See
// tier-a-graduation-submitter.ts's own header for the full verification
// trail (why this split is safe, why reference scripts weren't viable).
// Governor-signed throughout (StartVesting is the only one of the three
// that requires a signature — see tier-a-graduation-submitter.ts's own
// header). Same single-phase build+sign+submit design as
// activate-tier-a-curve.ts (CML.PrivateKey.from_extended_bytes(), proved on
// real Preprod via T86).
// ============================================================================
// Input: single JSON object on stdin, including the governor's PLAINTEXT
// 64-byte extended private key hex (decrypted server-side by the PHP
// caller). Never logged. Output: {graduateSealLockTxHash, startVestingTxHash,
// lpAda, lpReserveTokens, stakingReserveTokens} on stdout.
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TierAGraduationSubmitter } from '../tier-a-graduation-submitter.js';
import type { Network as LucidNetwork } from '@lucid-evolution/lucid';

declare const __dirname: string;

interface GraduateInput {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  governorAddress: string;
  governorPrivateKeyExtendedHex: string;
  lockSealTimestampSeconds: number;
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
  let input: GraduateInput;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON on stdin.');
  }

  const required: Array<keyof GraduateInput> = [
    'network', 'launchIdHex', 'governorAddress', 'governorPrivateKeyExtendedHex',
    'lockSealTimestampSeconds', 'blockfrostProjectId', 'blockfrostUrl',
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

  const NETWORK_MAP: Record<GraduateInput['network'], LucidNetwork> = {
    preview: 'Preview',
    preprod: 'Preprod',
    mainnet: 'Mainnet',
  };

  const submitter = new TierAGraduationSubmitter({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    network: NETWORK_MAP[input.network],
    bondingCurveScriptCbor: findScript('bonding_curve.bonding_curve.spend'),
    lpEscrowScriptCbor: findScript('lp_escrow.lp_escrow.spend'),
    vestingScriptCbor: findScript('vesting.vesting.spend'),
    launchIdHex: input.launchIdHex,
  });

  const result = await submitter.graduate(
    input.governorPrivateKeyExtendedHex,
    input.governorAddress,
    input.lockSealTimestampSeconds
  );
  process.stdout.write(
    JSON.stringify({
      graduateSealLockTxHash: result.graduateSealLockTxHash,
      startVestingTxHash: result.startVestingTxHash,
      lpAda: result.lpAda.toString(),
      lpReserveTokens: result.lpReserveTokens.toString(),
      stakingReserveTokens: result.stakingReserveTokens.toString(),
    })
  );
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
