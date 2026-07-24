// ============================================================================
// Noctis Protocol — DarkVeil widget: Tier B claim flow
// ============================================================================
// Thin wrapper around darkveil-claim-submitter.ts's real Lucid Evolution
// submitter. Unlike registration/buy-flow, this needs NO ContractProviders
// (it's a plain Cardano transaction) — just the buyer's own connected
// Cardano wallet API object.
//
// REAL GAP, flagged rather than papered over: dvAmount/salt/merkleProof
// come from a DIFFERENT Merkle tree than registration's allowlist —
// bonding_curve_tier_b.ak's dv_allocation_root, built by the governor/
// relayer AFTER DarkVeil closes, containing each buyer's actual purchased
// amount (see T46's design). No REST endpoint serves this proof to a buyer
// anywhere in this codebase yet — darkveil-registration.php's allowlist-
// proof endpoint is for the EARLIER registration-eligibility tree, not this
// one. Until that's built, callers must supply these three values from
// wherever they end up being served (or compute them locally if the buyer
// happens to hold the full DV registrant list, which defeats the privacy
// point of T46 — so in practice this really does need a dedicated
// endpoint, not a workaround). This module intentionally does not fetch
// anything to fill this gap.
// ============================================================================

import { LucidDarkVeilClaimSubmitter, type LucidDarkVeilClaimSubmitterConfig } from '../darkveil-claim-submitter.js';
import type { WalletApi } from '@lucid-evolution/lucid';

export interface ClaimTierBParams {
  dvAmount: bigint;
  salt: Uint8Array;
  merkleProof: Array<{ sibling: Uint8Array; goesLeft: boolean }>;
  buyerKeyHash: Uint8Array;
}

/**
 * `walletApi` is the raw CIP-30 API object (e.g. `await window.cardano[walletId].enable()`)
 * — the buyer signs and pays for this transaction themselves, no relayer
 * key involved.
 */
export async function claimTierBTokens(
  config: LucidDarkVeilClaimSubmitterConfig,
  walletApi: WalletApi,
  params: ClaimTierBParams
): Promise<{ txHash: string }> {
  const submitter = new LucidDarkVeilClaimSubmitter(config);
  return submitter.claimDarkVeilTokens(walletApi, {
    dvAmount: params.dvAmount,
    salt: params.salt,
    merkleProof: params.merkleProof,
    buyerKeyHash: params.buyerKeyHash,
  });
}
