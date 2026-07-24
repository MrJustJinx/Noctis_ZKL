// ============================================================================
// Noctis Protocol — ADA/USD -> Lovelace Conversion (T66)
// ============================================================================
//
// Converts a USD amount into minimum lovelace, using Orcfax's real ADA/USD
// datum directly -- no Minswap triangulation needed (unlike
// night-price-oracle.ts's NIGHT/USD path, which has no direct feed and must
// triangulate through ADA). Used for Tier A/B's ADA-denominated STAKING_CLAIM_FEE_USD
// ($1 flat claim fee, CLAUDE.md's STAKING REWARDS section) -- Tier C's
// equivalent fee is NIGHT-denominated and already covered by
// night-price-oracle.ts's usdToMinNightAtomic.
// ============================================================================

import type { BlockfrostClient } from './blockfrost-client.js';
import { getOrcfaxAdaUsdPrice, ORCFAX_ADA_USD_PREPROD_CONFIG, type OrcfaxFeedConfig } from './orcfax-client.js';
import { adaUsdToFraction } from './night-price-oracle.js';

export const LOVELACE_PER_ADA = 1_000_000n;

// Internal working precision for the USD -> lovelace conversion, kept as an
// integer scale throughout (no intermediate float division) except for the
// final display-only `adaUsdApprox` figure -- same discipline as
// night-price-oracle.ts's usdToMinNightAtomic.
const WORK_SCALE = 1_000_000_000_000_000_000n; // 10^18

export interface AdaUsdThresholdResult {
  /** Minimum lovelace needed to reach the USD amount. */
  minLovelace: bigint;
  /** Display-only approximate ADA/USD price (float, not used in the conversion itself). */
  adaUsdApprox: number;
  /** Orcfax datum's own validity timestamp -- compare against ORACLE_STALENESS_MIN (10 min). */
  oracleTimestampMs: number;
}

/**
 * Computes the minimum lovelace needed to be worth `usdAmount` USD, using a
 * real Orcfax ADA/USD datum. Throws rather than fabricating a value if the
 * real source is unavailable -- staleness itself is the caller's call
 * (ORACLE_STALENESS_MIN), this function surfaces `oracleTimestampMs` for
 * that decision, same convention as usdToMinNightAtomic.
 */
export async function usdToMinAdaLovelace(
  usdAmount: number,
  blockfrostClient: BlockfrostClient,
  orcfaxConfig: OrcfaxFeedConfig = ORCFAX_ADA_USD_PREPROD_CONFIG
): Promise<AdaUsdThresholdResult> {
  const adaUsd = await getOrcfaxAdaUsdPrice(blockfrostClient, orcfaxConfig);
  const adaUsdFrac = adaUsdToFraction(adaUsd.price.exponent, adaUsd.price.significand);

  if (adaUsdFrac.numerator === 0n) {
    throw new Error('Orcfax ADA/USD price is zero — refusing to proceed with a divide-by-zero result');
  }

  // ADA_USD = adaUsdFrac.numerator / adaUsdFrac.denominator
  // minAdaWhole = usdAmount / ADA_USD = usdAmount * adaUsdFrac.denominator / adaUsdFrac.numerator
  const usdScaled = BigInt(Math.round(usdAmount * Number(WORK_SCALE)));
  const numerator = usdScaled * adaUsdFrac.denominator;
  const denominator = adaUsdFrac.numerator;

  // Result is still scaled by WORK_SCALE and denominated in whole ADA;
  // convert to lovelace before removing the scale, so the final integer
  // division rounds at lovelace precision rather than whole-ADA precision.
  const minLovelaceScaled = (numerator * LOVELACE_PER_ADA) / denominator;
  const minLovelace = minLovelaceScaled / WORK_SCALE;

  return {
    minLovelace,
    adaUsdApprox: adaUsd.price.asFloat,
    oracleTimestampMs: adaUsd.timestampMs,
  };
}
