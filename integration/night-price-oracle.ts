// ============================================================================
// Noctis Protocol — NIGHT/USD Price Oracle (T65 check #2)
// ============================================================================
//
// Combines Minswap's real NIGHT/ADA TWAP with Orcfax's real ADA/USD datum
// into a NIGHT/USD price, and converts a USD threshold into atomic NIGHT
// units (STAR) for comparison against getUnshieldedNightBalance's result.
// See CLAUDE.md's ORACLE STRATEGY section (2026-07-13 correction) for why
// this triangulates through ADA rather than reading a direct Orcfax
// NIGHT/USD feed -- no such feed exists on any network.
//
// NIGHT_DECIMALS: 1 NIGHT = 1,000,000 STAR (6 decimals) -- sourced from
// Midnight's public tokenomics whitepaper/FAQ (cross-referenced via web
// search 2026-07-13: midnight.gd's FAQ and NIGHT MiCA whitepaper both state
// this), NOT verified directly against SDK source (the primary-source PDF
// couldn't be parsed for this session). Flagging honestly rather than
// treating this as SDK-verified -- worth a direct confirmation before
// mainnet use, same discipline as this project's other Midnight-specific
// facts.
// ============================================================================

import type { BlockfrostClient } from './blockfrost-client.js';
import { getNightAdaTwap } from './minswap-client.js';
import { getOrcfaxAdaUsdPrice, ORCFAX_ADA_USD_PREPROD_CONFIG, type OrcfaxFeedConfig } from './orcfax-client.js';

export const NIGHT_DECIMALS = 6;
export const NIGHT_ATOMIC_UNITS_PER_NIGHT = 1_000_000n; // 10^NIGHT_DECIMALS

// Internal working precision for the USD -> NIGHT-atomic conversion, kept
// as an integer scale throughout (no intermediate float division) except
// for the final display-only `nightUsdApprox` figure.
const WORK_SCALE = 1_000_000_000_000_000_000n; // 10^18

export interface NightUsdThresholdResult {
  /** Minimum atomic NIGHT (STAR) units needed to reach the USD amount. */
  minNightAtomic: bigint;
  /** Display-only approximate NIGHT/USD price (float, not used in the comparison itself). */
  nightUsdApprox: number;
  /** Orcfax datum's own validity timestamp -- compare against ORACLE_STALENESS_MIN (10 min). */
  oracleTimestampMs: number;
  twapSamplesUsed: number;
}

export function adaUsdToFraction(exponent: bigint, significand: bigint): { numerator: bigint; denominator: bigint } {
  if (exponent >= 0n) {
    return { numerator: significand * 10n ** exponent, denominator: 1n };
  }
  return { numerator: significand, denominator: 10n ** -exponent };
}

/**
 * Computes the minimum atomic NIGHT (STAR) balance needed to be worth
 * `usdAmount` USD, using a real Minswap TWAP and a real Orcfax ADA/USD
 * datum. Throws rather than fabricating a value if either real source is
 * unavailable or stale beyond what the caller's own staleness policy
 * (ORACLE_STALENESS_MIN) allows -- staleness itself is the caller's call,
 * this function surfaces `oracleTimestampMs` for that decision.
 */
export async function usdToMinNightAtomic(
  usdAmount: number,
  blockfrostClient: BlockfrostClient,
  orcfaxConfig: OrcfaxFeedConfig = ORCFAX_ADA_USD_PREPROD_CONFIG
): Promise<NightUsdThresholdResult> {
  const [twap, adaUsd] = await Promise.all([
    getNightAdaTwap(),
    getOrcfaxAdaUsdPrice(blockfrostClient, orcfaxConfig),
  ]);

  const adaUsdFrac = adaUsdToFraction(adaUsd.price.exponent, adaUsd.price.significand);

  // NIGHT_USD = (twap.priceScaled / twap.scale) * (adaUsdFrac.numerator / adaUsdFrac.denominator)
  // minNightWhole = usdAmount / NIGHT_USD
  //              = usdAmount * twap.scale * adaUsdFrac.denominator / (twap.priceScaled * adaUsdFrac.numerator)
  const usdScaled = BigInt(Math.round(usdAmount * Number(WORK_SCALE)));
  const numerator = usdScaled * twap.scale * adaUsdFrac.denominator;
  const denominator = twap.priceScaled * adaUsdFrac.numerator;

  if (denominator === 0n) {
    throw new Error('Computed a zero NIGHT/USD price — refusing to proceed with a divide-by-zero result');
  }

  // Result of the division is still scaled by WORK_SCALE and denominated in
  // whole NIGHT; convert to atomic units (STAR) before removing the scale,
  // so the final integer division rounds at atomic-unit precision rather
  // than whole-NIGHT precision.
  const minNightAtomicScaled = (numerator * NIGHT_ATOMIC_UNITS_PER_NIGHT) / denominator;
  const minNightAtomic = minNightAtomicScaled / WORK_SCALE;

  const nightUsdApprox = (Number(twap.priceScaled) / Number(twap.scale)) * adaUsd.price.asFloat;

  return {
    minNightAtomic,
    nightUsdApprox,
    oracleTimestampMs: adaUsd.timestampMs,
    twapSamplesUsed: twap.samplesUsed,
  };
}
