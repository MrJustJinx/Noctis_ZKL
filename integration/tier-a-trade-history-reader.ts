// ============================================================================
// Noctis Protocol — Tier A/B Trade History Reader
// ============================================================================
// Reconstructs a launch's full real transaction history — every action ever
// taken against its bonding_curve (and vesting) script UTxOs — by walking
// the UTXO chain backward from the CURRENT UTxO to the genesis mint output.
// bonding_curve.ak's (and bonding_curve_tier_b.ak's) own design makes this
// possible: each script address is a single-threaded state machine — every
// action spends exactly the one existing UTxO for a launch and creates
// exactly one continuing one (until a terminal action like Migrate), so the
// full history is a simple linked list, walkable via each transaction's own
// real inputs (confirmed directly against real Preprod data this session:
// a real buy tx's own input at the curve address pointed at exactly the
// prior ActivateCurve tx).
//
// Real Blockfrost API shape, verified directly (not assumed) before
// building this:
//   - /txs/{hash}/utxos — real inputs (each with its own creating tx_hash)
//     and outputs for a transaction.
//   - /txs/{hash}/redeemers — real per-redeemer metadata, but only a
//     `redeemer_data_hash` (NOT the raw bytes).
//   - /scripts/datum/{hash}/cbor — the real redeemer CBOR bytes, keyed by
//     that same hash (Blockfrost indexes redeemer data alongside datums).
//   - Data.from(cborHex) with NO schema argument returns a real Constr
//     instance (confirmed via a live runtime test), letting every
//     redeemer's real constructor index + positional fields be read
//     without needing a named schema for each one.
//
// No new storage — live Blockfrost queries per call, same "platform owns
// state, cache briefly" convention Phase 2's reader already established.
// ============================================================================

import { Constr, Data } from '@lucid-evolution/lucid';
import { BondingCurveDatumSchema, BondingCurveTierBDatumSchema, VestingDatumSchema, type BondingCurveDatumData, type VestingDatumData } from './tier-a-schemas.js';

export interface TradeEvent {
  txHash: string;
  blockTime: number;
  contract: 'bonding_curve' | 'vesting';
  action: string;
  /** True only for ClaimCreatorFees and ClaimVested — the two actions this
   *  codebase's own redeemer logic requires the CREATOR's real signature
   *  for (T92). BuyTokens/ClaimBuyback are real community-buyer actions —
   *  the creator is explicitly blocked from buying their own curve (T32),
   *  so there is no real "creator buy" to flag. */
  isCreatorAction: boolean;
  fields: Record<string, string>;
}

interface BlockfrostConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
}

async function bf<T>(config: BlockfrostConfig, path: string): Promise<T> {
  const res = await fetch(`${config.blockfrostUrl}${path}`, {
    headers: { project_id: config.blockfrostProjectId },
  });
  if (!res.ok) {
    throw new Error(`Blockfrost ${path} returned ${res.status}`);
  }
  return res.json() as Promise<T>;
}

interface BfTxUtxos {
  inputs: Array<{ address: string; tx_hash: string; output_index: number }>;
  outputs: Array<{ address: string; inline_datum: string | null }>;
}

interface BfRedeemer {
  purpose: string;
  script_hash: string;
  redeemer_data_hash: string;
}

// Redeemer constructor index -> [action name, field names] — real
// declaration order, verified directly against bonding_curve.ak/vesting.ak
// this session (see tier-a-curve-submitter.ts / tier-a-graduation-
// submitter.ts / tier-a-claims-submitter.ts / tier-a-dex-change-
// submitter.ts's own redeemer-index comments, all cross-checked against
// the real BondingCurveRedeemer/VestingRedeemer declarations).
// T111 fix (2026-07-19, full-suite security audit): re-verified against
// the freshly-regenerated plutus.json after that pass — SellTokens (T106)
// inserted at index 5 shifts every action from CancelCurve onward by one
// relative to the map this session originally shipped; ClaimCreatorFees
// gained a second field (platform_claim_fee, T107).
const BONDING_CURVE_ACTIONS: Record<number, [string, string[]]> = {
  0: ['ActivateCurve', ['current_timestamp']],
  1: ['BuyTokens', ['token_amount', 'claimed_price', 'gross_payment', 'claimed_creator_fee', 'claimed_treasury_fee', 'claimed_ops_fee', 'buyer_key_hash']],
  2: ['ClaimCreatorFees', ['amount', 'platform_claim_fee']],
  3: ['ClaimTreasuryFees', ['amount']],
  4: ['ClaimOpsFees', ['amount']],
  5: ['SellTokens', ['token_amount', 'claimed_price', 'gross_proceeds', 'claimed_creator_fee', 'claimed_treasury_fee', 'claimed_ops_fee', 'seller_key_hash']],
  6: ['CancelCurve', []],
  7: ['ExpireCurve', ['current_timestamp']],
  8: ['ClaimBuyback', ['token_amount', 'buyer_key_hash']],
  9: ['Graduate', []],
  10: ['TriggerCTO', ['community_pub_key_hash']],
  11: ['DissolveCTO', []],
};

// T111 fix: ClaimCancelledAllocation inserted at index 6 shifts QueryState
// from 5 to 7 relative to the map this session originally shipped.
const VESTING_ACTIONS: Record<number, [string, string[]]> = {
  0: ['StartVesting', ['start_timestamp']],
  1: ['ClaimVested', ['claim_amount', 'current_timestamp']],
  2: ['TriggerCTO', ['community_treasury_wallet']],
  3: ['DissolveCTO', []],
  4: ['ClaimCommunityAllocation', []],
  5: ['CancelLaunch', []],
  6: ['ClaimCancelledAllocation', []],
  7: ['QueryState', []],
};

// Tier B's bonding_curve_tier_b.ak has a DIFFERENT constructor order than
// Tier A's bonding_curve.ak — T46's ClaimDarkVeilTokens is inserted at
// index 2, shifting every action after BuyTokens by one relative to Tier A.
// Reusing BONDING_CURVE_ACTIONS for Tier B would silently mis-decode every
// action from ClaimCreatorFees onward (the exact class of bug T66 already
// found once in this project) — verified directly against
// bonding_curve_tier_b.ak's real BondingCurveTierBRedeemer declaration
// before writing this, not assumed from Tier A's shape.
// T112 fix (2026-07-19, Tier B cross-chain audit): AnchorDvAllocationRoot
// inserted at index 12 (before QueryState) shifts QueryState from 12 to 13.
const BONDING_CURVE_TIER_B_ACTIONS: Record<number, [string, string[]]> = {
  0: ['ActivateCurve', ['current_timestamp']],
  1: ['BuyTokens', ['token_amount', 'claimed_price', 'gross_payment', 'claimed_creator_fee', 'claimed_treasury_fee', 'claimed_ops_fee', 'buyer_key_hash']],
  2: ['ClaimDarkVeilTokens', ['dv_amount', 'salt', 'merkle_proof', 'claimed_creator_fee', 'claimed_treasury_fee', 'claimed_ops_fee', 'buyer_key_hash']],
  3: ['ClaimCreatorFees', ['amount']],
  4: ['ClaimTreasuryFees', ['amount']],
  5: ['ClaimOpsFees', ['amount']],
  6: ['CancelCurve', []],
  7: ['ExpireCurve', ['current_timestamp']],
  8: ['ClaimBuyback', ['token_amount', 'buyer_key_hash']],
  9: ['Graduate', []],
  10: ['TriggerCTO', ['community_pub_key_hash']],
  11: ['DissolveCTO', []],
  12: ['AnchorDvAllocationRoot', ['dv_allocation_root']],
  13: ['QueryState', []],
};

const CREATOR_ACTIONS = new Set(['ClaimCreatorFees', 'ClaimVested']);

function decodeRedeemerFields(constrValue: unknown, fieldNames: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!(constrValue instanceof Constr)) return out;
  constrValue.fields.forEach((f: unknown, i: number) => {
    const name = fieldNames[i] ?? `field${i}`;
    out[name] = typeof f === 'bigint' ? f.toString() : String(f);
  });
  return out;
}

/**
 * Walks one script address's UTXO chain backward from a known starting
 * transaction to the genesis mint, decoding each transaction's own
 * redeemer along the way (skipping the genesis tx itself, which has no
 * redeemer — it's a mint, not a script spend).
 */
async function walkHistory(
  config: BlockfrostConfig,
  scriptAddress: string,
  startTxHash: string,
  contract: 'bonding_curve' | 'vesting',
  actionTable: Record<number, [string, string[]]>,
  /** Incremental-cache support: stop walking (without re-fetching) as soon
   *  as this tx is reached — everything from there backward is assumed
   *  already known to the caller. Omit to walk all the way to genesis. */
  stopAtTxHash?: string
): Promise<TradeEvent[]> {
  const events: TradeEvent[] = [];
  let currentTxHash: string | null = startTxHash;
  const seen = new Set<string>();

  while (currentTxHash && currentTxHash !== stopAtTxHash && !seen.has(currentTxHash)) {
    seen.add(currentTxHash);
    const txHash: string = currentTxHash;

    const [txMeta, utxos] = await Promise.all([
      bf<{ block_time: number }>(config, `/txs/${txHash}`),
      bf<BfTxUtxos>(config, `/txs/${txHash}/utxos`),
    ]);

    const ownInput = utxos.inputs.find((i) => i.address === scriptAddress);

    if (ownInput) {
      // This tx spent an existing UTXO at our address — decode its redeemer.
      try {
        const redeemers = await bf<BfRedeemer[]>(config, `/txs/${txHash}/redeemers`);
        const ownRedeemer = redeemers.find((r) => r.purpose === 'spend');
        if (ownRedeemer) {
          const { cbor } = await bf<{ cbor: string }>(
            config,
            `/scripts/datum/${ownRedeemer.redeemer_data_hash}/cbor`
          );
          const decoded = Data.from(cbor);
          const [action, fieldNames] = actionTable[(decoded as Constr<unknown>).index] ?? ['Unknown', []];
          events.push({
            txHash,
            blockTime: txMeta.block_time,
            contract,
            action,
            isCreatorAction: CREATOR_ACTIONS.has(action),
            fields: decodeRedeemerFields(decoded, fieldNames),
          });
        }
      } catch {
        events.push({ txHash, blockTime: txMeta.block_time, contract, action: 'Unknown', isCreatorAction: false, fields: {} });
      }
      currentTxHash = ownInput.tx_hash;
    } else {
      // No input at our address — this tx is the genesis (mint).
      events.push({ txHash, blockTime: txMeta.block_time, contract, action: 'Mint', isCreatorAction: false, fields: {} });
      currentTxHash = null;
    }
  }

  return events;
}

export interface TierATradeHistoryConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  bondingCurveAddress: string;
  /** Tier A only (vesting.ak) — omit for Tier B (bonding_curve_tier_b.ak
   *  has no vesting counterpart; Tier B/C vesting lives on Midnight). Only
   *  getTradeHistory() (both contracts) needs this; getCurveTradeHistory()
   *  (the trade/chart consumer) never touches it. */
  vestingAddress?: string;
  launchIdHex: string;
  /** Tier B's bonding_curve_tier_b.ak has a different datum shape AND a
   *  different redeemer constructor order than Tier A's bonding_curve.ak
   *  (see BONDING_CURVE_TIER_B_ACTIONS's own header note) — only affects
   *  getCurveTradeHistory(); getTradeHistory() (Tier A + vesting) is
   *  unaffected. Defaults to 'A' for backward compatibility with existing
   *  callers. */
  tier?: 'A' | 'B';
}

export class TierATradeHistoryReader {
  constructor(private config: TierATradeHistoryConfig) {}

  async getTradeHistory(): Promise<TradeEvent[]> {
    const bfConfig = { blockfrostProjectId: this.config.blockfrostProjectId, blockfrostUrl: this.config.blockfrostUrl };

    const [curveUtxos, vestingUtxos] = await Promise.all([
      bf<Array<{ tx_hash: string; output_index: number; inline_datum: string | null }>>(
        bfConfig,
        `/addresses/${this.config.bondingCurveAddress}/utxos`
      ),
      this.config.vestingAddress
        ? bf<Array<{ tx_hash: string; output_index: number; inline_datum: string | null }>>(
            bfConfig,
            `/addresses/${this.config.vestingAddress}/utxos`
          )
        : Promise.resolve([]),
    ]);

    const findOwn = (
      utxos: Array<{ tx_hash: string; inline_datum: string | null }>,
      schema: unknown
    ): string | null => {
      for (const u of utxos) {
        if (!u.inline_datum) continue;
        try {
          const decoded = Data.from<{ launch_id: string }>(u.inline_datum, schema as never);
          if (decoded.launch_id === this.config.launchIdHex) return u.tx_hash;
        } catch {
          continue;
        }
      }
      return null;
    };

    const curveStartTx = findOwn(curveUtxos, BondingCurveDatumSchema);
    const vestingStartTx = findOwn(vestingUtxos, VestingDatumSchema);

    const [curveEvents, vestingEvents] = await Promise.all([
      curveStartTx
        ? walkHistory(bfConfig, this.config.bondingCurveAddress, curveStartTx, 'bonding_curve', BONDING_CURVE_ACTIONS)
        : Promise.resolve([]),
      vestingStartTx && this.config.vestingAddress
        ? walkHistory(bfConfig, this.config.vestingAddress, vestingStartTx, 'vesting', VESTING_ACTIONS)
        : Promise.resolve([]),
    ]);

    return [...curveEvents, ...vestingEvents].sort((a, b) => a.blockTime - b.blockTime);
  }

  /**
   * Bonding-curve-only history, for trade/chart consumers (BuyTokens/
   * ClaimBuyback only — vesting has nothing price-relevant to chart).
   * Supports incremental walking: pass the newest tx_hash already cached
   * by the caller as `stopAtTxHash` to only fetch what's new since then,
   * ascending-sorted (oldest of the NEW events first) so the caller can
   * simply append the result to its existing cached list.
   */
  async getCurveTradeHistory(stopAtTxHash?: string): Promise<TradeEvent[]> {
    const bfConfig = { blockfrostProjectId: this.config.blockfrostProjectId, blockfrostUrl: this.config.blockfrostUrl };
    const isTierB = this.config.tier === 'B';
    const datumSchema = isTierB ? BondingCurveTierBDatumSchema : BondingCurveDatumSchema;
    const actionTable = isTierB ? BONDING_CURVE_TIER_B_ACTIONS : BONDING_CURVE_ACTIONS;

    const curveUtxos = await bf<Array<{ tx_hash: string; inline_datum: string | null }>>(
      bfConfig,
      `/addresses/${this.config.bondingCurveAddress}/utxos`
    );

    let curveStartTx: string | null = null;
    for (const u of curveUtxos) {
      if (!u.inline_datum) continue;
      try {
        const decoded = Data.from<{ launch_id: string }>(u.inline_datum, datumSchema as never);
        if (decoded.launch_id === this.config.launchIdHex) {
          curveStartTx = u.tx_hash;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!curveStartTx) return [];

    const events = await walkHistory(
      bfConfig,
      this.config.bondingCurveAddress,
      curveStartTx,
      'bonding_curve',
      actionTable,
      stopAtTxHash
    );
    return events.sort((a, b) => a.blockTime - b.blockTime);
  }
}

export type { BondingCurveDatumData, VestingDatumData };
