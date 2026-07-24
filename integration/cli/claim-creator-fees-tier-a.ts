// ============================================================================
// Noctis Protocol — Tier A Preprod Milestone, Phase 6
// ClaimCreatorFees (bonding_curve.ak) — creator-signed (or community
// wallet, once CTO triggered — not exercised here).
// ============================================================================
// Input: single JSON object on stdin, including the creator's PLAINTEXT
// 64-byte extended private key hex (decrypted server-side by the PHP
// caller). Never logged. Output: {txHash} on stdout.
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TierAClaimsSubmitter } from '../tier-a-claims-submitter.js';
import { BlockfrostClient } from '../blockfrost-client.js';
import { usdToMinAdaLovelace } from '../ada-price-oracle.js';
import type { Network as LucidNetwork } from '@lucid-evolution/lucid';

declare const __dirname: string;

interface ClaimCreatorFeesInput {
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  creatorAddress: string;
  creatorPrivateKeyExtendedHex: string;
  amount: string;
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
  let input: ClaimCreatorFeesInput;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON on stdin.');
  }

  const required: Array<keyof ClaimCreatorFeesInput> = [
    'network', 'launchIdHex', 'creatorAddress', 'creatorPrivateKeyExtendedHex',
    'amount', 'blockfrostProjectId', 'blockfrostUrl',
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

  const NETWORK_MAP: Record<ClaimCreatorFeesInput['network'], LucidNetwork> = {
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

  // T107: bonding_curve.ak now requires a real, on-chain-enforced $1 ADA
  // platform claim fee paid alongside every ClaimCreatorFees. Computed here
  // via the same real Orcfax oracle already built for staking_pool.ak's
  // identical STAKING_CLAIM_FEE_USD (T66) — the contract's own on-chain
  // check is only a conservative 0.2 ADA floor (Aiken has no in-circuit
  // oracle access), so this real, live-priced amount comfortably clears it.
  const blockfrostClient = new BlockfrostClient({
    apiKey: input.blockfrostProjectId,
    network: input.network,
  });
  const { minLovelace: platformClaimFeeLovelace } = await usdToMinAdaLovelace(1, blockfrostClient);

  const result = await submitter.claimCreatorFees(
    input.creatorPrivateKeyExtendedHex,
    input.creatorAddress,
    BigInt(input.amount),
    platformClaimFeeLovelace
  );
  process.stdout.write(JSON.stringify({ txHash: result.txHash, platformClaimFeeLovelace: platformClaimFeeLovelace.toString() }));
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
