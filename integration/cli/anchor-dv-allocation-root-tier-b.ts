// ============================================================================
// Noctis Protocol — T112 follow-up
// AnchorDvAllocationRoot — governor-signed, single-phase (same pattern as
// activate-tier-a-curve.ts's ActivateCurve; see that file's own header for
// why single-phase build->sign->submit was chosen over a build(Lucid)/
// sign(PHP)/submit(Lucid) split).
// ============================================================================
// Input: single JSON object on stdin, including the governor's PLAINTEXT
// 64-byte extended private key hex (decrypted server-side by the PHP
// caller — same trust boundary it already crosses for the mint flow's
// policy-wallet signing) and the real dv_allocation_root (hex), computed
// off-chain via dv-allocation-tree.ts's buildDvAllocationTree from the
// governor's own DarkVeil-close accounting. Never logged. Output:
// {txHash} on stdout.
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CardanoDvAllocationAnchorSubmitter } from '../cardano-dv-allocation-anchor-submitter.js';
import type { Network as LucidNetwork } from '@lucid-evolution/lucid';

declare const __dirname: string;

interface AnchorDvAllocationRootInput {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  governorAddress: string;
  governorPrivateKeyExtendedHex: string;
  dvAllocationRootHex: string;
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
  let input: AnchorDvAllocationRootInput;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON on stdin.');
  }

  const required: Array<keyof AnchorDvAllocationRootInput> = [
    'network', 'launchIdHex', 'governorAddress', 'governorPrivateKeyExtendedHex',
    'dvAllocationRootHex', 'blockfrostProjectId', 'blockfrostUrl',
  ];
  for (const key of required) {
    if (!input[key]) {
      throw new Error(`Missing required field: ${key}`);
    }
  }

  const blueprintPath = join(__dirname, '..', '..', '..', 'contracts', 'cardano', 'plutus.json');
  const blueprint = JSON.parse(readFileSync(blueprintPath, 'utf8'));
  const validatorEntry = blueprint.validators.find(
    (v: { title: string }) => v.title === 'bonding_curve_tier_b.bonding_curve_tier_b.spend'
  );
  if (!validatorEntry) {
    throw new Error('bonding_curve_tier_b.bonding_curve_tier_b.spend not found in plutus.json.');
  }

  const NETWORK_MAP: Record<AnchorDvAllocationRootInput['network'], LucidNetwork> = {
    preview: 'Preview',
    preprod: 'Preprod',
    mainnet: 'Mainnet',
  };

  const submitter = new CardanoDvAllocationAnchorSubmitter({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    network: NETWORK_MAP[input.network],
    compiledScriptCbor: validatorEntry.compiledCode,
    launchIdHex: input.launchIdHex,
  });

  const result = await submitter.anchorDvAllocationRoot(
    input.governorPrivateKeyExtendedHex,
    input.governorAddress,
    input.dvAllocationRootHex
  );
  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
