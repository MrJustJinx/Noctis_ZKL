// ============================================================================
// Noctis Protocol — Tier A Preprod Milestone, Phase 5b
// ProposeDexChange (lp_escrow.ak) — multisig-signed, starts the 72h public
// notice clock. See tier-a-dex-change-submitter.ts's header for the full
// design (why backdating `timestamp` here is legitimate, unlike
// ExecuteDexChange).
// ============================================================================
// Input: single JSON object on stdin, including the governor's PLAINTEXT
// 64-byte extended private key hex (decrypted server-side by the PHP
// caller). Never logged. Output: {txHash} on stdout.
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TierADexChangeSubmitter, type DexAction } from '../tier-a-dex-change-submitter.js';
import type { Network as LucidNetwork } from '@lucid-evolution/lucid';

declare const __dirname: string;

interface ProposeDexChangeInput {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  governorAddress: string;
  governorPrivateKeyExtendedHex: string;
  targetDexScriptHashHex: string;
  action: DexAction;
  proposedAtMs: number;
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
  let input: ProposeDexChangeInput;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON on stdin.');
  }

  const required: Array<keyof ProposeDexChangeInput> = [
    'network', 'launchIdHex', 'governorAddress', 'governorPrivateKeyExtendedHex',
    'targetDexScriptHashHex', 'action', 'proposedAtMs', 'blockfrostProjectId', 'blockfrostUrl',
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

  const NETWORK_MAP: Record<ProposeDexChangeInput['network'], LucidNetwork> = {
    preview: 'Preview',
    preprod: 'Preprod',
    mainnet: 'Mainnet',
  };

  const submitter = new TierADexChangeSubmitter({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    network: NETWORK_MAP[input.network],
    lpEscrowScriptCbor: findScript('lp_escrow.lp_escrow.spend'),
    launchIdHex: input.launchIdHex,
  });

  const result = await submitter.proposeDexChange(
    input.governorPrivateKeyExtendedHex,
    input.governorAddress,
    input.targetDexScriptHashHex,
    input.action,
    input.proposedAtMs
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
