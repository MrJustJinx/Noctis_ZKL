// ============================================================================
// Noctis Protocol — Tier A Preprod Milestone, Phase 5
// StartVesting (vesting.ak) — standalone, independently retriable.
// T91 (2026-07-17): split out of graduate-tier-a-launch.ts's single tx once
// embedding all 3 validators in one transaction exceeded Cardano's real
// 16384-byte tx size cap. Verified independent of Graduate/SealLock (no
// cross-contract check in either direction) — see
// tier-a-graduation-submitter.ts's own header for the full trail. Exists as
// its own CLI both for the normal graduate() flow's TX2 and for recovery:
// if TX2 fails after TX1 (Graduate+SealLock) already landed on-chain, this
// can be re-run alone without re-touching curve/lp_escrow state.
// ============================================================================
// Input: single JSON object on stdin, including the governor's PLAINTEXT
// 64-byte extended private key hex (decrypted server-side by the PHP
// caller). Never logged. Output: {txHash} on stdout.
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TierAGraduationSubmitter } from '../tier-a-graduation-submitter.js';
import type { Network as LucidNetwork } from '@lucid-evolution/lucid';

declare const __dirname: string;

interface StartVestingInput {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  governorAddress: string;
  governorPrivateKeyExtendedHex: string;
  vestStartTimestampSeconds: number;
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
  let input: StartVestingInput;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON on stdin.');
  }

  const required: Array<keyof StartVestingInput> = [
    'network', 'launchIdHex', 'governorAddress', 'governorPrivateKeyExtendedHex',
    'vestStartTimestampSeconds', 'blockfrostProjectId', 'blockfrostUrl',
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

  const NETWORK_MAP: Record<StartVestingInput['network'], LucidNetwork> = {
    preview: 'Preview',
    preprod: 'Preprod',
    mainnet: 'Mainnet',
  };

  const submitter = new TierAGraduationSubmitter({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    network: NETWORK_MAP[input.network],
    // Graduate/SealLock scripts aren't needed for this call, but the
    // submitter's constructor derives all 3 validator addresses up front —
    // pass the real compiled code for all 3 regardless.
    bondingCurveScriptCbor: findScript('bonding_curve.bonding_curve.spend'),
    lpEscrowScriptCbor: findScript('lp_escrow.lp_escrow.spend'),
    vestingScriptCbor: findScript('vesting.vesting.spend'),
    launchIdHex: input.launchIdHex,
  });

  const result = await submitter.startVesting(
    input.governorPrivateKeyExtendedHex,
    input.governorAddress,
    input.vestStartTimestampSeconds
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
