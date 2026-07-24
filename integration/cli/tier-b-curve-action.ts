// ============================================================================
// Noctis Protocol — T74: Tier B public bonding curve, real Cardano actions
// ============================================================================
// One consolidated CLI (action-dispatched) rather than 7 near-identical
// per-redeemer files, matching the class this session's own T108 fix
// exposed: activate/buy/claim-creator-fees/claim-treasury-fees/
// claim-ops-fees/expire/claim-buyback are all thin wrappers around
// tier-b-curve-submitter.ts's real methods — one process per call either
// way, just fewer files to keep in sync with that submitter's own method
// signatures.
//
// Input: single JSON object on stdin, `action` selects the operation.
// Output: single JSON object on stdout (the submitter method's own result,
// bigints stringified) or { error }.
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LucidTierBCurveSubmitter } from '../tier-b-curve-submitter.js';
import type { Network as LucidNetwork } from '@lucid-evolution/lucid';

declare const __dirname: string;

type Action =
  | 'activate'
  | 'buy'
  | 'claim-creator-fees'
  | 'claim-treasury-fees'
  | 'claim-ops-fees'
  | 'expire'
  | 'claim-buyback';

interface Input {
  action: Action;
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  blockfrostProjectId: string;
  blockfrostUrl: string;

  // activate / claim-treasury-fees / claim-ops-fees / expire — governor-signed
  governorPrivateKeyExtendedHex?: string;
  governorAddress?: string;

  // activate
  currentTimestampMs?: number;

  // buy / claim-buyback
  buyerMnemonic?: string;
  tokenAmount?: string; // stringified bigint
  skipClientCapCheck?: boolean;

  // claim-creator-fees — same extended-key signing shape as
  // governorPrivateKeyExtendedHex/governorAddress above (see
  // tier-b-curve-submitter.ts's claimCreatorFees() doc comment for why:
  // the platform wallet custody scheme never persists a mnemonic).
  signerPrivateKeyExtendedHex?: string;
  signerAddress?: string;
  platformClaimFeeLovelace?: string; // stringified bigint, optional (defaults to the on-chain floor)

  // claim-*-fees (all three)
  amount?: string; // stringified bigint
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

function requireField<T>(input: Input, key: keyof Input): T {
  const value = input[key];
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing required field for action "${input.action}": ${String(key)}`);
  }
  return value as T;
}

async function main() {
  const raw = await readStdin();
  let input: Input;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON on stdin.');
  }

  for (const key of ['action', 'network', 'launchIdHex', 'blockfrostProjectId', 'blockfrostUrl'] as const) {
    if (!input[key]) throw new Error(`Missing required field: ${key}`);
  }

  const blueprintPath = join(__dirname, '..', '..', '..', 'contracts', 'cardano', 'plutus.json');
  const blueprint = JSON.parse(readFileSync(blueprintPath, 'utf8'));
  const validatorEntry = blueprint.validators.find(
    (v: { title: string }) => v.title === 'bonding_curve_tier_b.bonding_curve_tier_b.spend'
  );
  if (!validatorEntry) {
    throw new Error('bonding_curve_tier_b.bonding_curve_tier_b.spend not found in plutus.json.');
  }

  const NETWORK_MAP: Record<Input['network'], LucidNetwork> = {
    preview: 'Preview',
    preprod: 'Preprod',
    mainnet: 'Mainnet',
  };

  const submitter = new LucidTierBCurveSubmitter({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    network: NETWORK_MAP[input.network],
    compiledScriptCbor: validatorEntry.compiledCode,
    launchIdHex: input.launchIdHex,
  });

  let result: unknown;
  switch (input.action) {
    case 'activate': {
      const key = requireField<string>(input, 'governorPrivateKeyExtendedHex');
      const addr = requireField<string>(input, 'governorAddress');
      const ts = requireField<number>(input, 'currentTimestampMs');
      result = await submitter.activateCurve(key, addr, ts);
      break;
    }
    case 'buy': {
      const mnemonic = requireField<string>(input, 'buyerMnemonic');
      const amount = BigInt(requireField<string>(input, 'tokenAmount'));
      result = await submitter.buyTokens(mnemonic, amount, input.skipClientCapCheck ?? false);
      break;
    }
    case 'claim-creator-fees': {
      const key = requireField<string>(input, 'signerPrivateKeyExtendedHex');
      const addr = requireField<string>(input, 'signerAddress');
      const amount = BigInt(requireField<string>(input, 'amount'));
      const platformFee = input.platformClaimFeeLovelace !== undefined ? BigInt(input.platformClaimFeeLovelace) : undefined;
      result = platformFee !== undefined
        ? await submitter.claimCreatorFees(key, addr, amount, platformFee)
        : await submitter.claimCreatorFees(key, addr, amount);
      break;
    }
    case 'claim-treasury-fees': {
      const key = requireField<string>(input, 'governorPrivateKeyExtendedHex');
      const addr = requireField<string>(input, 'governorAddress');
      const amount = BigInt(requireField<string>(input, 'amount'));
      result = await submitter.claimTreasuryFees(key, addr, amount);
      break;
    }
    case 'claim-ops-fees': {
      const key = requireField<string>(input, 'governorPrivateKeyExtendedHex');
      const addr = requireField<string>(input, 'governorAddress');
      const amount = BigInt(requireField<string>(input, 'amount'));
      result = await submitter.claimOpsFees(key, addr, amount);
      break;
    }
    case 'expire': {
      const key = requireField<string>(input, 'governorPrivateKeyExtendedHex');
      const addr = requireField<string>(input, 'governorAddress');
      result = await submitter.expireCurve(key, addr);
      break;
    }
    case 'claim-buyback': {
      const mnemonic = requireField<string>(input, 'buyerMnemonic');
      const amount = BigInt(requireField<string>(input, 'tokenAmount'));
      result = await submitter.claimBuyback(mnemonic, amount);
      break;
    }
    default:
      throw new Error(`Unknown action: ${input.action}`);
  }

  process.stdout.write(JSON.stringify(jsonSafe(result)));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
