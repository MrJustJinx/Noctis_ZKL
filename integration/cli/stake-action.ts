// ============================================================================
// Noctis Protocol — Staking Rewards Pool (T66) real Cardano actions
// ============================================================================
// One consolidated CLI (action-dispatched), matching tier-b-curve-
// action.ts's established pattern rather than one file per action.
//
// Input: single JSON object on stdin, `action` selects the operation.
// Output: single JSON object on stdout (bigints stringified) or { error }.
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StakingSubmitter } from '../staking-submitter.js';
import { buildStakingRewardSnapshot, getRewardProof } from '../staking-reward-tree-builder.js';
import { validatorToAddress } from '@lucid-evolution/lucid';
import type { Network as LucidNetwork } from '@lucid-evolution/lucid';

declare const __dirname: string;

type Action =
  | 'stake'
  | 'unstake'
  | 'claim-rewards'
  | 'top-up'
  | 'publish-reward-root'
  | 'read-pool'
  | 'read-positions'
  | 'build-reward-snapshot'
  | 'get-reward-proof';

interface Input {
  action: Action;
  network: 'preview' | 'preprod' | 'mainnet';
  launchIdHex: string;
  blockfrostProjectId: string;
  blockfrostUrl: string;

  // stake / unstake / claim-rewards — CLI verification path only (mnemonic)
  stakerMnemonic?: string;
  stakerAddress?: string; // read-positions

  // stake
  amount?: string; // stringified bigint
  // stake — optional backdating for real Preprod verification of the
  // 7-day bonding period without a literal 7-day wait (see staking-
  // submitter.ts's stakeCore comment for why this is safe to accept).
  stakeTimestampMs?: number;

  // unstake — identifies which of the staker's positions to close
  positionTxHash?: string;
  positionOutputIndex?: number;

  // claim-rewards / get-reward-proof
  claimedCumulativeAmount?: string; // stringified bigint
  merkleProof?: Array<{ sibling: string; goesLeft: boolean }>;
  stakerVkhHex?: string; // get-reward-proof

  // top-up / publish-reward-root — governor/creator extended-key signing
  signerPrivateKeyExtendedHex?: string;
  signerAddress?: string;
  newRootHex?: string; // publish-reward-root

  // build-reward-snapshot — governor cron job
  tokenPolicyId?: string;
  tokenAssetName?: string;
  durationDays?: number;
  bondingPeriodDays?: number;

  // get-reward-proof — the already-built snapshot's entries, re-supplied
  // by the caller (a REST route reading its own last-published snapshot),
  // not recomputed here.
  entries?: Array<{ stakerVkh: string; cumulativeAmount: string }>;
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
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
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
  const validatorEntry = blueprint.validators.find((v: { title: string }) => v.title === 'staking_pool.staking_pool.spend');
  if (!validatorEntry) {
    throw new Error('staking_pool.staking_pool.spend not found in plutus.json.');
  }

  const NETWORK_MAP: Record<Input['network'], LucidNetwork> = {
    preview: 'Preview',
    preprod: 'Preprod',
    mainnet: 'Mainnet',
  };

  const submitter = new StakingSubmitter({
    blockfrostProjectId: input.blockfrostProjectId,
    blockfrostUrl: input.blockfrostUrl,
    network: NETWORK_MAP[input.network],
    stakingPoolScriptCbor: validatorEntry.compiledCode,
    launchIdHex: input.launchIdHex,
  });

  let result: unknown;
  switch (input.action) {
    case 'stake': {
      const mnemonic = requireField<string>(input, 'stakerMnemonic');
      const amount = BigInt(requireField<string>(input, 'amount'));
      result = await submitter.stake(mnemonic, amount, input.stakeTimestampMs);
      break;
    }
    case 'unstake': {
      const mnemonic = requireField<string>(input, 'stakerMnemonic');
      // Resolve the staker's own address the same way the submitter does internally, to locate their position(s).
      const { Lucid, Blockfrost } = await import('@lucid-evolution/lucid');
      const lucidForAddr = await Lucid(new Blockfrost(input.blockfrostUrl, input.blockfrostProjectId), NETWORK_MAP[input.network]);
      lucidForAddr.selectWallet.fromSeed(mnemonic);
      const stakerAddress = await lucidForAddr.wallet().address();
      const positions = await submitter.findPositions(stakerAddress);
      if (positions.length === 0) throw new Error('No staking positions found for this wallet.');
      const position =
        input.positionTxHash !== undefined
          ? positions.find(
              (p) => p.utxo.txHash === input.positionTxHash && p.utxo.outputIndex === (input.positionOutputIndex ?? 0)
            )
          : positions[0];
      if (!position) throw new Error('Specified position not found.');
      result = await submitter.unstake(mnemonic, position);
      break;
    }
    case 'claim-rewards': {
      const mnemonic = requireField<string>(input, 'stakerMnemonic');
      const claimedCumulativeAmount = BigInt(requireField<string>(input, 'claimedCumulativeAmount'));
      const merkleProof = requireField<Array<{ sibling: string; goesLeft: boolean }>>(input, 'merkleProof');
      result = await submitter.claimRewards(mnemonic, claimedCumulativeAmount, merkleProof);
      break;
    }
    case 'top-up': {
      const key = requireField<string>(input, 'signerPrivateKeyExtendedHex');
      const addr = requireField<string>(input, 'signerAddress');
      const amount = BigInt(requireField<string>(input, 'amount'));
      result = await submitter.topUpPool(key, addr, amount);
      break;
    }
    case 'publish-reward-root': {
      const key = requireField<string>(input, 'signerPrivateKeyExtendedHex');
      const addr = requireField<string>(input, 'signerAddress');
      const newRoot = requireField<string>(input, 'newRootHex');
      result = await submitter.publishRewardRoot(key, addr, newRoot);
      break;
    }
    case 'read-pool': {
      result = await submitter.readPoolDatum();
      break;
    }
    case 'read-positions': {
      const stakerAddress = requireField<string>(input, 'stakerAddress');
      result = await submitter.findPositions(stakerAddress);
      break;
    }
    case 'build-reward-snapshot': {
      const stakingPoolAddress = validatorToAddress(NETWORK_MAP[input.network], {
        type: 'PlutusV3',
        script: validatorEntry.compiledCode,
      });
      const tokenPolicyId = requireField<string>(input, 'tokenPolicyId');
      const tokenAssetName = requireField<string>(input, 'tokenAssetName');
      const durationDays = requireField<number>(input, 'durationDays');
      const snapshot = await buildStakingRewardSnapshot(
        { blockfrostProjectId: input.blockfrostProjectId, blockfrostUrl: input.blockfrostUrl },
        {
          stakingPoolAddress,
          launchIdHex: input.launchIdHex,
          tokenPolicyId,
          tokenAssetName,
          durationDays,
          bondingPeriodDays: input.bondingPeriodDays,
        }
      );
      result = {
        rootHex: Buffer.from(snapshot.tree.root).toString('hex'),
        entries: snapshot.entries.map((e) => ({ stakerVkh: e.stakerVkh, cumulativeAmount: e.cumulativeAmount })),
        initialSeededAmount: snapshot.initialSeededAmount,
        dailyEmission: snapshot.dailyEmission,
      };
      break;
    }
    case 'get-reward-proof': {
      const stakerVkhHex = requireField<string>(input, 'stakerVkhHex');
      const entriesRaw = requireField<Array<{ stakerVkh: string; cumulativeAmount: string }>>(input, 'entries');
      const entries = entriesRaw.map((e) => ({ stakerVkh: e.stakerVkh, cumulativeAmount: BigInt(e.cumulativeAmount) }));
      result = getRewardProof(entries, stakerVkhHex);
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
