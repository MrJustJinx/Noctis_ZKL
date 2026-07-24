// ============================================================================
// Noctis Protocol — T74: Tier B public bonding curve, real Lucid submitter
// ============================================================================
// bonding_curve_tier_b.ak's BuyTokens (and every other post-mint redeemer)
// is a custom-Plutus-redeemer spend — Anvil's REST API can't do this (T74's
// own finding, confirmed against T85's Anvil research). Same category of
// gap as darkveil-claim-submitter.ts (T46) and tier-a-curve-submitter.ts
// (Tier A's own Phase 4), both already fixed via Lucid Evolution. This is
// the identical treatment for Tier B's public curve.
//
// Real differences from Tier A's curve, verified directly against
// bonding_curve_tier_b.ak's real source before writing this (not assumed
// from Tier A's shape):
//   - QUADRATIC pricing (P = P0 + k*x^2), not linear — verify_price's real
//     formula: claimed_price is the FLOOR of
//     (base_price*curve_supply^2 + price_range*sold^2) / curve_supply^2.
//   - Fee slices are FLOOR-rounded (verify_fee_slice), not exact-equality
//     like Tier A (T39) — claimed_fee = floor(gross_payment*bps/10000).
//   - The purchases field is `identity_purchases` (shared with
//     ClaimDarkVeilTokens — a buyer may already have a non-zero prior
//     balance from a DarkVeil claim before ever calling BuyTokens), not
//     `per_address_purchases`.
//   - No SellTokens exists for Tier B (Tier A only, T106).
//   - ClaimCreatorFees takes a SECOND `platform_claim_fee` arg (T108,
//     2026-07-21 — this session's own fix, ported from Tier A's T107 for
//     parity) — same real value-conservation discipline as Tier A's
//     identical redeemer, at real constructor index 3 (verified directly
//     against a freshly-regenerated plutus.json, not assumed).
//
// Constructor indices below are all read directly from a freshly-
// regenerated contracts/cardano/plutus.json (T108, 2026-07-21) — this
// file's own established convention (see tier-a-curve-submitter.ts's own
// comments) is to never trust .ak source order alone.
//
// Two signing shapes, same reasoning as tier-a-curve-submitter.ts's own
// header: ActivateCurve/ClaimTreasuryFees/ClaimOpsFees are governor-signed
// (CML.PrivateKey.from_extended_bytes() + selectWallet.fromAddress(), same
// pattern proven there); BuyTokens/ClaimCreatorFees(as creator)/ClaimBuyback
// are buyer/creator-signed (mnemonic for CLI verification, WalletApi for
// the real production path).
//
// HONEST SCOPE NOTE: like every other Lucid submitter in this codebase,
// this typechecks and builds but has NOT been exercised against a live
// Preprod launch — no Tier B eligibility_gate/bonding_curve_tier_b
// deployment has been minted with current bytecode yet (see the earlier
// Tier A/B redeploy-status assessment this session).
// ============================================================================

import {
  Blockfrost,
  Constr,
  Data,
  Lucid,
  toUnit,
  validatorToAddress,
  getAddressDetails,
} from '@lucid-evolution/lucid';
import type { LucidEvolution, SpendingValidator, UTxO, Network as LucidNetwork, WalletApi } from '@lucid-evolution/lucid';
import { loadValidator, extendedHexToBech32PrivateKey } from './tier-a-curve-submitter.js';
import { BondingCurveTierBDatumSchema } from './tier-a-schemas.js';
import type { BondingCurveTierBDatumData } from './tier-a-schemas.js';

// ============================================================================
// On-chain fee-bps constants — mirror bonding_curve_tier_b.ak's own
// creator_bps/treasury_bps/ops_bps/bps_denominator exactly.
// ============================================================================
const CREATOR_BPS = 100n;
const TREASURY_BPS = 60n;
const OPS_BPS = 40n;
const BPS_DENOMINATOR = 10_000n;

// T108 (2026-07-21): platform_claim_fee split — mirrors bonding_curve_tier_b.ak's
// platform_fee_ops_bps/platform_fee_treasury_bps/min_platform_claim_fee_lovelace
// exactly (ported from Tier A's T107 for parity).
const PLATFORM_FEE_OPS_BPS = 4_000n;
const MIN_PLATFORM_CLAIM_FEE_LOVELACE = 200_000n;

/**
 * Mirrors verify_fee_slice's real FLOOR formula (bonding_curve_tier_b.ak):
 * claimed_fee*bps_denominator <= gross*bps < (claimed_fee+1)*bps_denominator.
 * Unlike Tier A's exact-equality version, this always has a valid answer —
 * floor division, no remainder-must-be-zero constraint.
 */
function floorFeeSlice(gross: bigint, bps: bigint): bigint {
  return (gross * bps) / BPS_DENOMINATOR;
}

/**
 * Mirrors verify_price's real quadratic cross-multiplication formula
 * (bonding_curve_tier_b.ak): claimed_price is the FLOOR of
 * (base_price*curve_supply^2 + price_range*sold^2) / curve_supply^2.
 */
function curvePriceAtQuadratic(datum: BondingCurveTierBDatumData, sold: bigint): bigint {
  const priceRange = datum.max_price - datum.base_price;
  const supplySquared = datum.curve_supply * datum.curve_supply;
  const soldSquared = sold * sold;
  const numerator = datum.base_price * supplySquared + priceRange * soldSquared;
  return numerator / supplySquared;
}

function buyerKeyHashFromAddress(address: string): string {
  const details = getAddressDetails(address);
  const hash = details.paymentCredential?.hash;
  if (!hash) {
    throw new Error(`Could not derive a payment-credential key hash from address ${address}.`);
  }
  return hash;
}

// ============================================================================
// SUBMITTER
// ============================================================================

export interface LucidTierBCurveSubmitterConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  /** bonding_curve_tier_b.ak's compiled PlutusV3 script CBOR — one shared,
   *  unparameterized script address across every Tier B launch. */
  compiledScriptCbor: string;
  launchIdHex: string;
}

export class LucidTierBCurveSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private validator: SpendingValidator;
  private scriptAddress: string;

  constructor(private config: LucidTierBCurveSubmitterConfig) {
    this.validator = { type: 'PlutusV3', script: config.compiledScriptCbor };
    this.scriptAddress = validatorToAddress(config.network, this.validator);
    this.lucidPromise = Lucid(new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId), config.network);
  }

  private async findCurveUtxo(lucid: LucidEvolution): Promise<UTxO> {
    const utxos = await lucid.utxosAt(this.scriptAddress);
    for (const utxo of utxos) {
      if (!utxo.datum) continue;
      let decoded: BondingCurveTierBDatumData;
      try {
        decoded = Data.from<BondingCurveTierBDatumData>(utxo.datum, BondingCurveTierBDatumSchema);
      } catch {
        continue;
      }
      if (decoded.launch_id === this.config.launchIdHex) return utxo;
    }
    throw new Error(`No bonding_curve_tier_b UTXO found for launch_id ${this.config.launchIdHex} at ${this.scriptAddress}`);
  }

  async readCurveDatum(): Promise<BondingCurveTierBDatumData> {
    const lucid = await this.lucidPromise;
    const utxo = await this.findCurveUtxo(lucid);
    return Data.from<BondingCurveTierBDatumData>(utxo.datum!, BondingCurveTierBDatumSchema);
  }

  // --------------------------------------------------------------------------
  // ActivateCurve — governor-signed. Same design as tier-a-curve-submitter.ts's
  // activateCurve() (see that file's class-level comment for the full
  // key-format/coin-selection reasoning) — constructor index 0, identical
  // between tiers.
  // --------------------------------------------------------------------------

  async activateCurve(
    governorPrivateKeyExtendedHex: string,
    governorAddress: string,
    currentTimestampMs: number
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const curveUtxo = await this.findCurveUtxo(lucid);
    const currentDatum = Data.from<BondingCurveTierBDatumData>(curveUtxo.datum!, BondingCurveTierBDatumSchema);

    if (currentDatum.curve_state !== 'Inactive') {
      throw new Error(`Curve is not Inactive (state: ${currentDatum.curve_state}) — cannot activate.`);
    }

    const bech32Key = extendedHexToBech32PrivateKey(governorPrivateKeyExtendedHex);
    const governorUtxos = await lucid.utxosAt(governorAddress);
    lucid.selectWallet.fromAddress(governorAddress, governorUtxos);

    const currentTimestamp = BigInt(currentTimestampMs);
    const newDatum: BondingCurveTierBDatumData = { ...currentDatum, curve_state: 'Active', activated_at: currentTimestamp };

    const redeemer = new Constr(0, [currentTimestamp]);

    const realNowMs = Date.now();
    const validFrom = Math.min(currentTimestampMs, realNowMs) - 60_000;
    const validTo = Math.max(currentTimestampMs, realNowMs) + 60_000;

    const tx = await lucid
      .newTx()
      .collectFrom([curveUtxo], Data.to(redeemer))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.scriptAddress,
        { kind: 'inline', value: Data.to<BondingCurveTierBDatumData>(newDatum, BondingCurveTierBDatumSchema) },
        curveUtxo.assets
      )
      .validFrom(validFrom)
      .validTo(validTo)
      .addSigner(governorAddress)
      .complete();

    const signed = await tx.sign.withPrivateKey(bech32Key).complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  // --------------------------------------------------------------------------
  // BuyTokens — buyer-signed, constructor index 1. T74's own literal scope.
  // --------------------------------------------------------------------------

  /** Same skipClientCapCheck escape hatch as Tier A's — never pass true from a real buy flow. */
  async buyTokens(
    buyerMnemonic: string,
    tokenAmount: bigint,
    skipClientCapCheck = false
  ): Promise<{ txHash: string; grossPayment: bigint; claimedPrice: bigint }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromSeed(buyerMnemonic);
    const buyerAddress = await lucid.wallet().address();
    return this.buyTokensCore(lucid, buyerAddress, tokenAmount, skipClientCapCheck);
  }

  async buyTokensWithWallet(
    walletApi: WalletApi,
    tokenAmount: bigint,
    skipClientCapCheck = false
  ): Promise<{ txHash: string; grossPayment: bigint; claimedPrice: bigint }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const buyerAddress = await lucid.wallet().address();
    return this.buyTokensCore(lucid, buyerAddress, tokenAmount, skipClientCapCheck);
  }

  private async buyTokensCore(
    lucid: LucidEvolution,
    buyerAddress: string,
    tokenAmount: bigint,
    skipClientCapCheck: boolean
  ): Promise<{ txHash: string; grossPayment: bigint; claimedPrice: bigint }> {
    const curveUtxo = await this.findCurveUtxo(lucid);
    const currentDatum = Data.from<BondingCurveTierBDatumData>(curveUtxo.datum!, BondingCurveTierBDatumSchema);

    if (currentDatum.curve_state !== 'Active') {
      throw new Error(`Curve is not Active (state: ${currentDatum.curve_state}) — cannot buy.`);
    }

    const remaining = currentDatum.curve_supply - currentDatum.tokens_sold;
    if (tokenAmount <= 0n || tokenAmount > remaining) {
      throw new Error(`token_amount out of range (remaining: ${remaining}).`);
    }

    const claimedPrice = curvePriceAtQuadratic(currentDatum, currentDatum.tokens_sold);
    const grossPayment = claimedPrice * tokenAmount;
    const claimedCreatorFee = floorFeeSlice(grossPayment, CREATOR_BPS);
    const claimedTreasuryFee = floorFeeSlice(grossPayment, TREASURY_BPS);
    const claimedOpsFee = floorFeeSlice(grossPayment, OPS_BPS);
    const feeTotal = claimedCreatorFee + claimedTreasuryFee + claimedOpsFee;
    const netPayment = grossPayment - feeTotal;

    const buyerKeyHashHex = buyerKeyHashFromAddress(buyerAddress);
    if (buyerKeyHashHex === currentDatum.creator_pub_key_hash) {
      throw new Error('T32: the creator cannot buy from their own curve.');
    }

    // identity_purchases — shared with ClaimDarkVeilTokens; may already be
    // non-zero if this buyer already claimed a DarkVeil allocation.
    const priorPurchases = currentDatum.identity_purchases.find(([vkh]) => vkh === buyerKeyHashHex)?.[1] ?? 0n;
    const newTotalPurchases = priorPurchases + tokenAmount;
    if (newTotalPurchases > currentDatum.wallet_cap && !skipClientCapCheck) {
      throw new Error(`5% wallet cap exceeded: ${newTotalPurchases} > ${currentDatum.wallet_cap} (prior: ${priorPurchases}).`);
    }

    const newTokensSold = currentDatum.tokens_sold + tokenAmount;
    const nextState: BondingCurveTierBDatumData['curve_state'] =
      newTokensSold === currentDatum.curve_supply ? 'Graduated' : currentDatum.curve_state;

    // Mirrors update_purchases exactly (in-place update on an existing key,
    // append only for a genuinely new one) — same T86(B)-class bug this
    // codebase already found once for Tier A avoided here by construction.
    const buyerAlreadyPresent = currentDatum.identity_purchases.some(([vkh]) => vkh === buyerKeyHashHex);
    const newPurchases: Array<[string, bigint]> = buyerAlreadyPresent
      ? currentDatum.identity_purchases.map(([vkh, amount]) => (vkh === buyerKeyHashHex ? [vkh, newTotalPurchases] : [vkh, amount]))
      : [...currentDatum.identity_purchases, [buyerKeyHashHex, newTotalPurchases]];

    const newDatum: BondingCurveTierBDatumData = {
      ...currentDatum,
      tokens_sold: newTokensSold,
      total_raised: currentDatum.total_raised + netPayment,
      creator_fees_accrued: currentDatum.creator_fees_accrued + claimedCreatorFee,
      treasury_fees_accrued: currentDatum.treasury_fees_accrued + claimedTreasuryFee,
      ops_fees_accrued: currentDatum.ops_fees_accrued + claimedOpsFee,
      identity_purchases: newPurchases,
      curve_state: nextState,
    };

    const redeemer = new Constr(1, [
      tokenAmount,
      claimedPrice,
      grossPayment,
      claimedCreatorFee,
      claimedTreasuryFee,
      claimedOpsFee,
      buyerKeyHashHex,
    ]);

    const tokenUnit = toUnit(currentDatum.token_policy_id, currentDatum.token_asset_name);
    const continuingAssets = { ...curveUtxo.assets };
    continuingAssets.lovelace = (continuingAssets.lovelace ?? 0n) + grossPayment;
    continuingAssets[tokenUnit] = (continuingAssets[tokenUnit] ?? 0n) - tokenAmount;

    const tx = await lucid
      .newTx()
      .collectFrom([curveUtxo], Data.to(redeemer))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.scriptAddress,
        { kind: 'inline', value: Data.to<BondingCurveTierBDatumData>(newDatum, BondingCurveTierBDatumSchema) },
        continuingAssets
      )
      .pay.ToAddress(buyerAddress, { [tokenUnit]: tokenAmount })
      .addSigner(buyerAddress)
      .complete();

    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash, grossPayment, claimedPrice };
  }

  // --------------------------------------------------------------------------
  // ClaimCreatorFees — creator-or-community-wallet-signed, constructor
  // index 3. T108 (2026-07-21): now takes a real platform_claim_fee paid
  // INTO the curve alongside `amount` paid out — see that redeemer's own
  // .ak comment for the full two-directional value-conservation check this
  // must satisfy.
  // --------------------------------------------------------------------------

  /**
   * CLI-driven verification path — signs with a decrypted extended key
   * (CML.PrivateKey.from_extended_bytes() + sign.withPrivateKey()), the
   * SAME pattern Tier A's claimCreatorFees() (tier-a-claims-submitter.ts)
   * uses for its own policy-wallet-as-creator-stand-in — the platform
   * wallet custody scheme (anvil-client.php) only ever persists an
   * extended skey, never a mnemonic, so this is the only signing shape
   * that actually works against a real provisioned wallet, not a design
   * choice made for this file alone.
   *
   * `signerAddress` must be whichever address bonding_curve_tier_b.ak's
   * active_fee_recipient currently resolves to (creator_pub_key_hash, or
   * community_pub_key_hash once cto_triggered) — the contract itself
   * checks this via extra_signatories, this submitter doesn't re-derive it.
   */
  async claimCreatorFees(
    signerPrivateKeyExtendedHex: string,
    signerAddress: string,
    amount: bigint,
    platformClaimFeeLovelace: bigint = MIN_PLATFORM_CLAIM_FEE_LOVELACE
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const bech32Key = extendedHexToBech32PrivateKey(signerPrivateKeyExtendedHex);
    const signerUtxos = await lucid.utxosAt(signerAddress);
    lucid.selectWallet.fromAddress(signerAddress, signerUtxos);

    const tx = await this.claimCreatorFeesCore(lucid, signerAddress, amount, platformClaimFeeLovelace);
    const signed = await tx.sign.withPrivateKey(bech32Key).complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  /** Real production path — creator's own connected browser wallet. */
  async claimCreatorFeesWithWallet(
    walletApi: WalletApi,
    amount: bigint,
    platformClaimFeeLovelace: bigint = MIN_PLATFORM_CLAIM_FEE_LOVELACE
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const signerAddress = await lucid.wallet().address();

    const tx = await this.claimCreatorFeesCore(lucid, signerAddress, amount, platformClaimFeeLovelace);
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  private async claimCreatorFeesCore(
    lucid: LucidEvolution,
    signerAddress: string,
    amount: bigint,
    platformClaimFeeLovelace: bigint
  ) {
    if (platformClaimFeeLovelace < MIN_PLATFORM_CLAIM_FEE_LOVELACE) {
      throw new Error(`platform_claim_fee ${platformClaimFeeLovelace} is below the on-chain floor ${MIN_PLATFORM_CLAIM_FEE_LOVELACE}.`);
    }

    const curveUtxo = await this.findCurveUtxo(lucid);
    const currentDatum = Data.from<BondingCurveTierBDatumData>(curveUtxo.datum!, BondingCurveTierBDatumSchema);

    if (amount > currentDatum.creator_fees_accrued) {
      throw new Error(`amount ${amount} exceeds creator_fees_accrued ${currentDatum.creator_fees_accrued}.`);
    }

    const opsShare = floorFeeSlice(platformClaimFeeLovelace, PLATFORM_FEE_OPS_BPS);
    const treasuryShare = platformClaimFeeLovelace - opsShare;

    const newDatum: BondingCurveTierBDatumData = {
      ...currentDatum,
      creator_fees_accrued: currentDatum.creator_fees_accrued - amount,
      treasury_fees_accrued: currentDatum.treasury_fees_accrued + treasuryShare,
      ops_fees_accrued: currentDatum.ops_fees_accrued + opsShare,
    };

    const redeemer = new Constr(3, [amount, platformClaimFeeLovelace]);

    const continuingAssets = { ...curveUtxo.assets };
    continuingAssets.lovelace = (continuingAssets.lovelace ?? 0n) - amount + platformClaimFeeLovelace;

    return lucid
      .newTx()
      .collectFrom([curveUtxo], Data.to(redeemer))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.scriptAddress,
        { kind: 'inline', value: Data.to<BondingCurveTierBDatumData>(newDatum, BondingCurveTierBDatumSchema) },
        continuingAssets
      )
      .pay.ToAddress(signerAddress, { lovelace: amount })
      .addSigner(signerAddress)
      .complete();
  }

  // --------------------------------------------------------------------------
  // ClaimTreasuryFees / ClaimOpsFees — governor-signed, indices 4/5. T108
  // (2026-07-21): now require a real payout, same lovelace_paid_from_curve
  // check both use — this submitter builds it directly (single-direction,
  // simpler than ClaimCreatorFees' two-way check).
  // --------------------------------------------------------------------------

  private async claimGovernorFees(
    governorPrivateKeyExtendedHex: string,
    governorAddress: string,
    amount: bigint,
    field: 'treasury_fees_accrued' | 'ops_fees_accrued',
    constructorIndex: 4 | 5
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const curveUtxo = await this.findCurveUtxo(lucid);
    const currentDatum = Data.from<BondingCurveTierBDatumData>(curveUtxo.datum!, BondingCurveTierBDatumSchema);

    if (amount > currentDatum[field]) {
      throw new Error(`amount ${amount} exceeds ${field} ${currentDatum[field]}.`);
    }

    const bech32Key = extendedHexToBech32PrivateKey(governorPrivateKeyExtendedHex);
    const governorUtxos = await lucid.utxosAt(governorAddress);
    lucid.selectWallet.fromAddress(governorAddress, governorUtxos);

    const newDatum: BondingCurveTierBDatumData = { ...currentDatum, [field]: currentDatum[field] - amount };
    const redeemer = new Constr(constructorIndex, [amount]);

    const continuingAssets = { ...curveUtxo.assets };
    continuingAssets.lovelace = (continuingAssets.lovelace ?? 0n) - amount;

    const tx = await lucid
      .newTx()
      .collectFrom([curveUtxo], Data.to(redeemer))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.scriptAddress,
        { kind: 'inline', value: Data.to<BondingCurveTierBDatumData>(newDatum, BondingCurveTierBDatumSchema) },
        continuingAssets
      )
      .pay.ToAddress(governorAddress, { lovelace: amount })
      .addSigner(governorAddress)
      .complete();

    const signed = await tx.sign.withPrivateKey(bech32Key).complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  async claimTreasuryFees(governorPrivateKeyExtendedHex: string, governorAddress: string, amount: bigint): Promise<{ txHash: string }> {
    return this.claimGovernorFees(governorPrivateKeyExtendedHex, governorAddress, amount, 'treasury_fees_accrued', 4);
  }

  async claimOpsFees(governorPrivateKeyExtendedHex: string, governorAddress: string, amount: bigint): Promise<{ txHash: string }> {
    return this.claimGovernorFees(governorPrivateKeyExtendedHex, governorAddress, amount, 'ops_fees_accrued', 5);
  }

  // --------------------------------------------------------------------------
  // ExpireCurve — permissionless (T29/T90), constructor index 7. Same
  // honest-"now" discipline as Tier A's (see tier-a-curve-submitter.ts's
  // own method header for the full T94 timing-bug lesson this avoids).
  // --------------------------------------------------------------------------

  async expireCurve(governorPrivateKeyExtendedHex: string, governorAddress: string): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const curveUtxo = await this.findCurveUtxo(lucid);
    const currentDatum = Data.from<BondingCurveTierBDatumData>(curveUtxo.datum!, BondingCurveTierBDatumSchema);

    if (currentDatum.curve_state !== 'Active') {
      throw new Error(`Curve is not Active (state: ${currentDatum.curve_state}) — cannot expire.`);
    }

    const bech32Key = extendedHexToBech32PrivateKey(governorPrivateKeyExtendedHex);
    const governorUtxos = await lucid.utxosAt(governorAddress);
    lucid.selectWallet.fromAddress(governorAddress, governorUtxos);

    const newDatum: BondingCurveTierBDatumData = { ...currentDatum, curve_state: 'Cancelled' };

    const currentTimestampMs = Date.now();
    const redeemer = new Constr(7, [BigInt(currentTimestampMs)]);

    const validFrom = currentTimestampMs - 240_000;
    const validTo = currentTimestampMs + 240_000;

    const tx = await lucid
      .newTx()
      .collectFrom([curveUtxo], Data.to(redeemer))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.scriptAddress,
        { kind: 'inline', value: Data.to<BondingCurveTierBDatumData>(newDatum, BondingCurveTierBDatumSchema) },
        curveUtxo.assets
      )
      .validFrom(validFrom)
      .validTo(validTo)
      .complete();

    const signed = await tx.sign.withPrivateKey(bech32Key).complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  // --------------------------------------------------------------------------
  // ClaimBuyback — buyer-signed, constructor index 8. T93/T115 fix
  // (2026-07-22): buyback_share_paid now compares only the payment
  // credential, not the full address (contract-side fix) — pays the
  // buyer's own real wallet address directly below, same as every other
  // payout in this file.
  // --------------------------------------------------------------------------

  async claimBuyback(buyerMnemonic: string, tokenAmount: bigint): Promise<{ txHash: string; share: bigint }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromSeed(buyerMnemonic);
    const buyerAddress = await lucid.wallet().address();
    return this.claimBuybackCore(lucid, buyerAddress, tokenAmount);
  }

  async claimBuybackWithWallet(walletApi: WalletApi, tokenAmount: bigint): Promise<{ txHash: string; share: bigint }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const buyerAddress = await lucid.wallet().address();
    return this.claimBuybackCore(lucid, buyerAddress, tokenAmount);
  }

  private async claimBuybackCore(lucid: LucidEvolution, buyerAddress: string, tokenAmount: bigint): Promise<{ txHash: string; share: bigint }> {
    const curveUtxo = await this.findCurveUtxo(lucid);
    const currentDatum = Data.from<BondingCurveTierBDatumData>(curveUtxo.datum!, BondingCurveTierBDatumSchema);

    if (currentDatum.curve_state !== 'Cancelled') {
      throw new Error(`Curve is not Cancelled (state: ${currentDatum.curve_state}) — cannot claim buyback.`);
    }
    if (tokenAmount <= 0n || tokenAmount > currentDatum.tokens_sold) {
      throw new Error(`token_amount out of range (tokens_sold: ${currentDatum.tokens_sold}).`);
    }

    const buyerKeyHashHex = buyerKeyHashFromAddress(buyerAddress);
    const effectiveTotalRaised = currentDatum.total_raised > 0n ? currentDatum.total_raised : 0n;
    const share = (effectiveTotalRaised * tokenAmount) / currentDatum.tokens_sold;

    const tokenUnit = toUnit(currentDatum.token_policy_id, currentDatum.token_asset_name);
    const newDatum: BondingCurveTierBDatumData = {
      ...currentDatum,
      tokens_sold: currentDatum.tokens_sold - tokenAmount,
      total_raised: currentDatum.total_raised - share,
    };
    const newCurveAssets = {
      ...curveUtxo.assets,
      lovelace: (curveUtxo.assets.lovelace ?? 0n) - share,
      [tokenUnit]: (curveUtxo.assets[tokenUnit] ?? 0n) + tokenAmount,
    };

    const redeemer = new Constr(8, [tokenAmount, buyerKeyHashHex]);

    // T93/T115 fix (2026-07-22): buyback_share_paid now compares only the
    // payment credential (contract-side fix), so the buyer's own real
    // wallet address works directly — no more deriving/paying to a bare
    // enterprise address as a workaround.
    const tx = await lucid
      .newTx()
      .collectFrom([curveUtxo], Data.to(redeemer))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.scriptAddress,
        { kind: 'inline', value: Data.to<BondingCurveTierBDatumData>(newDatum, BondingCurveTierBDatumSchema) },
        newCurveAssets
      )
      .pay.ToAddress(buyerAddress, { lovelace: share })
      .addSigner(buyerAddress)
      .complete();

    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash, share };
  }
}

export { floorFeeSlice, curvePriceAtQuadratic, loadValidator };
