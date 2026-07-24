// ============================================================================
// Noctis Protocol — Tier A Preprod Milestone, Phase 5b
// Real Migrate (lp_escrow.ak) + Minswap V2 pool-creation, combined in one
// transaction. See tier-a-lp-migration-submitter.ts's header for the full
// design and verification trail.
// ============================================================================
// Input: single JSON object on stdin, including the governor's PLAINTEXT
// 64-byte extended private key hex (decrypted server-side by the PHP
// caller). Never logged. Output: {txHash, lpAssetNameHex, initialLiquidity}
// on stdout.
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TierALpMigrationSubmitter } from '../tier-a-lp-migration-submitter.js';
import type { Network as LucidNetwork } from '@lucid-evolution/lucid';

declare const __dirname: string;

interface MigrateInput {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  governorAddress: string;
  governorPrivateKeyExtendedHex: string;
  currentTimestampSeconds: number;
  blockfrostProjectId: string;
  blockfrostUrl: string;
  minswap: {
    factoryAddress: string;
    factoryScriptHash: string;
    factoryAsset: string;
    poolAuthenAsset: string;
    lpPolicyId: string;
    poolCreationAddress: string;
    poolScriptHash: string;
    poolBatchingStakeScriptHash: string;
    factoryValidatorCbor: string;
    authenPolicyCbor: string;
  };
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
  let input: MigrateInput;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON on stdin.');
  }

  const required: Array<keyof MigrateInput> = [
    'network', 'launchIdHex', 'governorAddress', 'governorPrivateKeyExtendedHex',
    'currentTimestampSeconds', 'blockfrostProjectId', 'blockfrostUrl', 'minswap',
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

  const NETWORK_MAP: Record<MigrateInput['network'], LucidNetwork> = {
    preview: 'Preview',
    preprod: 'Preprod',
    mainnet: 'Mainnet',
  };

  const submitter = new TierALpMigrationSubmitter({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    network: NETWORK_MAP[input.network],
    lpEscrowScriptCbor: findScript('lp_escrow.lp_escrow.spend'),
    launchIdHex: input.launchIdHex,
    minswap: input.minswap,
  });

  const result = await submitter.migrateToMinswapPool(
    input.governorPrivateKeyExtendedHex,
    input.governorAddress,
    input.currentTimestampSeconds
  );
  process.stdout.write(
    JSON.stringify({
      txHash: result.txHash,
      lpAssetNameHex: result.lpAssetNameHex,
      initialLiquidity: result.initialLiquidity.toString(),
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
