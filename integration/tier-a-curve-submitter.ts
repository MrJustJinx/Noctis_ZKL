// ============================================================================
// Noctis Protocol — Tier A Preprod Milestone, Phase 4
// Real Cardano transaction submitter for bonding_curve.ak's ActivateCurve
// and BuyTokens redeemers.
// ============================================================================
// Same class of gap as darkveil-claim-submitter.ts/cardano-anchor-submitter.ts:
// Anvil's REST API only does native-script minting and plain payments (T85's
// own findings this session reconfirm this — nothing about Anvil's real
// behavior suggests a custom-Plutus-redeemer-spend path exists there either).
// Every action past mint needs Lucid Evolution's collectFrom/
// attach.SpendingValidator.
//
// Two different signing shapes, because bonding_curve.ak's redeemers have two
// different signer types:
//
//   - BuyTokens is buyer-signed. buyTokens() below mirrors
//     darkveil-claim-submitter.ts's buyer-signed pattern exactly — for THIS
//     session's CLI-driven Phase 4 verification it signs via
//     lucid.selectWallet.fromSeed(mnemonic) (the 4 funded test-buyer wallets'
//     mnemonics, recorded locally in .env.tier-a-test-wallets.local exactly
//     for this purpose), not a browser WalletApi — that's the real
//     production path, deferred to the Launch Wizard wallet-connect task per
//     the milestone plan ("isolate tx-logic correctness from UI-wiring
//     correctness").
//
//   - ActivateCurve is governor-signed, but the governor's raw key material
//     (WeldPress_Settings-encrypted, `payment_skey_extended` — a raw 64-byte
//     kL||kR BIP32-Ed25519 extended key, no separate chaincode) is NOT a
//     format Lucid Evolution's fromPrivateKey()/fromSeed() can consume
//     directly as-is (those expect a bech32 ed25519_sk string or a BIP-39
//     mnemonic respectively), and the governor's mnemonic was only ever
//     shown once, off-platform, to the human operator (T82) — this codebase
//     never has access to it.
//
//     A two-phase build(Lucid)/sign(PHP via WeldPress)/submit(Lucid) design
//     was tried first (avoiding ever holding the governor's raw key outside
//     PHP) but failed twice in a row against real Preprod: (1) WeldPress's
//     own lightweight CBOR parser doesn't support the indefinite-length
//     arrays Lucid's default toCBOR() produces ("Indefinite lengths not
//     supported"); (2) switching to canonical (definite-length) CBOR fixed
//     that, but reconstructing a TxSignBuilder in a SEPARATE process via
//     lucid.fromTx()+assemble()+complete() then failed on-chain with
//     ScriptIntegrityHashMismatch — something about re-parsing an
//     already-built tx into a fresh Lucid instance changes what gets
//     committed to the script integrity hash, even though the CBOR itself
//     round-trips losslessly.
//
//     Real fix, used by activateCurve() below: CML.PrivateKey.
//     from_extended_bytes() accepts the raw 64-byte kL||kR format directly
//     — no conversion needed beyond the decrypt PHP already does for every
//     other platform-wallet signing operation — converted to bech32 via
//     CML's own to_bech32() so TxSignBuilder.sign.withPrivateKey() (real,
//     same established pattern as cardano-anchor-submitter.ts's relayer
//     signing) can sign directly. Coin selection/build still uses
//     selectWallet.fromAddress(governorAddress, utxos) — fromPrivateKey()
//     alone can only derive an enterprise (payment-only) address, which
//     isn't where the governor's real funds sit (a base address, needing a
//     stake credential fromPrivateKey() has no way to reconstruct from a
//     payment-only key) — confirmed by a real "insufficient funds" failure
//     against a wallet that actually holds 1,000 real Preprod ADA. Combining
//     fromAddress() for building with sign.withPrivateKey() for signing, all
//     in ONE continuous process, avoids every failure mode above at once.
//     This pattern generalizes to every other governor-signed custom-
//     redeemer spend this project will eventually need (ClaimTreasuryFees,
//     ClaimOpsFees, CancelCurve, TriggerCTO, DissolveCTO, Graduate's governor
//     path if ever needed) — built once here, reusable.
//
// Datum schema reused from ./tier-a-schemas.ts (Phase 3) — same shared
// module Phase 2's reader and Phase 3's genesis-datum encoder already use,
// so this file can never drift from either.
// ============================================================================

import {
  Blockfrost,
  Constr,
  Data,
  Lucid,
  toUnit,
  validatorToAddress,
  getAddressDetails,
  CML,
} from '@lucid-evolution/lucid';
import type {
  LucidEvolution,
  SpendingValidator,
  UTxO,
  Network as LucidNetwork,
  WalletApi,
} from '@lucid-evolution/lucid';
import {
  BondingCurveDatumSchema,
  loadValidator,
} from './tier-a-schemas.js';
import type { BondingCurveDatumData } from './tier-a-schemas.js';

// ============================================================================
// On-chain fee-bps constants — mirror bonding_curve.ak's own creator_bps/
// treasury_bps/ops_bps/bps_denominator (lines 246-252) exactly.
// ============================================================================
const CREATOR_BPS = 100n;
const TREASURY_BPS = 60n;
const OPS_BPS = 40n;
const BPS_DENOMINATOR = 10_000n;

/**
 * Mirrors verify_fee_slice's real EXACT-equality formula (bonding_curve.ak
 * line 277-279, Tier A — not the floor-based Tier B version): claimed_fee
 * must satisfy claimed_fee * bps_denominator == gross_payment * bps exactly.
 * gross_payment is always claimed_price * token_amount (also exact, see
 * verify_price), so bps division here is exact whenever gross_payment is a
 * multiple of bps_denominator/gcd(bps,bps_denominator) — callers should
 * choose token_amount accordingly (this module throws if not, rather than
 * silently submitting a claim the contract will reject).
 */
function exactFeeSlice(grossPayment: bigint, bps: bigint): bigint {
  const numerator = grossPayment * bps;
  if (numerator % BPS_DENOMINATOR !== 0n) {
    throw new Error(
      `gross_payment ${grossPayment} * bps ${bps} is not exactly divisible by ${BPS_DENOMINATOR} — ` +
        `verify_fee_slice requires exact equality on Tier A (not floor-rounded like Tier B). ` +
        `Choose a token_amount whose gross_payment is a multiple of ${BPS_DENOMINATOR}.`
    );
  }
  return numerator / BPS_DENOMINATOR;
}

/**
 * Mirrors verify_price's real cross-multiplication formula (bonding_curve.ak
 * line 269-272): claimed_price * curve_supply == base_price * curve_supply +
 * (max_price - base_price) * sold. Returns the unique claimed_price an
 * honest buyer must submit at the given `sold` point — this IS the linear
 * curve's real price, not an approximation, since curve_supply always
 * divides the RHS evenly when base_price/max_price/curve_supply are the
 * real deployed values (verified per-launch by the caller if in doubt).
 */
function curvePriceAt(datum: BondingCurveDatumData, sold: bigint): bigint {
  const priceRange = datum.max_price - datum.base_price;
  const numerator = datum.base_price * datum.curve_supply + priceRange * sold;
  if (numerator % datum.curve_supply !== 0n) {
    throw new Error(
      `Linear curve price at sold=${sold} is not an exact integer (numerator ${numerator} not divisible by curve_supply ${datum.curve_supply}) — ` +
        `verify_price requires exact equality; this shouldn't happen for a correctly-deployed curve.`
    );
  }
  return numerator / datum.curve_supply;
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/**
 * Converts a raw 64-byte BIP32-Ed25519 extended private key (kL||kR, no
 * separate chaincode — WeldPress_CardanoWalletPHP::generateWallet()'s own
 * `payment_skey_extended` format) into the bech32 `ed25519e_sk...` string
 * Lucid Evolution's selectWallet.fromPrivateKey()/sign.withPrivateKey()
 * consume. Uses CML.PrivateKey.from_extended_bytes()/.to_bech32() directly
 * (both real, confirmed against the installed @anastasia-labs/cardano-
 * multiplatform-lib-nodejs package's own .d.ts) — CML is re-exported from
 * @lucid-evolution/lucid itself (`export { CML }`), no separate dependency.
 */
function extendedHexToBech32PrivateKey(extendedHex: string): string {
  const bytes = fromHex(extendedHex);
  if (bytes.length !== 64) {
    throw new Error(`Expected a 64-byte extended private key (kL||kR), got ${bytes.length} bytes.`);
  }
  return CML.PrivateKey.from_extended_bytes(bytes).to_bech32();
}

// ============================================================================
// SUBMITTER
// ============================================================================

export interface LucidTierACurveSubmitterConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  /** bonding_curve.ak's compiled PlutusV3 script CBOR — plutus.json's
   *  validators[].compiledCode for bonding_curve.bonding_curve.spend. One
   *  shared, unparameterized script address across every Tier A launch. */
  compiledScriptCbor: string;
  launchIdHex: string;
}

export class LucidTierACurveSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private validator: SpendingValidator;
  private scriptAddress: string;

  constructor(private config: LucidTierACurveSubmitterConfig) {
    this.validator = { type: 'PlutusV3', script: config.compiledScriptCbor };
    this.scriptAddress = validatorToAddress(config.network, this.validator);
    this.lucidPromise = Lucid(
      new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId),
      config.network
    );
  }

  /** Same "match launch_id inside the datum" pattern as every other shared-
   *  address submitter in this codebase (zk_anchor, bonding_curve_tier_b). */
  private async findCurveUtxo(lucid: LucidEvolution): Promise<UTxO> {
    const utxos = await lucid.utxosAt(this.scriptAddress);
    for (const utxo of utxos) {
      if (!utxo.datum) continue;
      let decoded: BondingCurveDatumData;
      try {
        decoded = Data.from<BondingCurveDatumData>(utxo.datum, BondingCurveDatumSchema);
      } catch {
        continue;
      }
      if (decoded.launch_id === this.config.launchIdHex) return utxo;
    }
    throw new Error(`No bonding_curve UTXO found for launch_id ${this.config.launchIdHex} at ${this.scriptAddress}`);
  }

  async readCurveDatum(): Promise<BondingCurveDatumData> {
    const lucid = await this.lucidPromise;
    const utxo = await this.findCurveUtxo(lucid);
    return Data.from<BondingCurveDatumData>(utxo.datum!, BondingCurveDatumSchema);
  }

  // --------------------------------------------------------------------------
  // ActivateCurve — governor-signed, single-phase (revised 2026-07-17)
  // --------------------------------------------------------------------------
  // The original design here was a two-phase build(Lucid)/sign(PHP via
  // WeldPress)/submit(Lucid) split, avoiding the need for this codebase to
  // ever hold the governor's raw key material outside PHP. Two real,
  // sequential failures killed that design:
  //   1. WeldPress_CardanoTransactionSignerPHP's own lightweight CBOR parser
  //      doesn't support indefinite-length arrays ("Indefinite lengths not
  //      supported") — Lucid's default toCBOR() output uses them. Worked
  //      around once via toCBOR({canonical:true})...
  //   2. ...but reconstructing a TxSignBuilder in a SEPARATE process via
  //      lucid.fromTx(unsignedTxCbor) + assemble() + complete() then failed
  //      on-chain with ScriptIntegrityHashMismatch — something about
  //      re-parsing an already-built tx into a fresh Lucid instance in a
  //      different process changes what gets committed to the script
  //      integrity hash, even though the CBOR bytes round-trip losslessly.
  //      Not worth chasing further given a simpler, equally-safe
  //      alternative exists.
  // Real fix: sign directly with CML.PrivateKey.from_extended_bytes(), which
  // accepts EXACTLY the raw 64-byte (kL+kR) format
  // WeldPress_CardanoWalletPHP::generateWallet() already stores as
  // `payment_skey_extended` — no format conversion needed on the PHP side
  // beyond the decrypt it already does for every other platform-wallet
  // signing operation. Converted to bech32 via CML's own to_bech32() so
  // TxSignBuilder's sign.withPrivateKey() (real, confirmed via cardano-
  // anchor-submitter.ts's own established relayer-signed pattern) can
  // consume it directly for the SIGNING step — one continuous
  // build->sign->submit in a single process, no reconstruction boundary for
  // a hash mismatch to occur across, and WeldPress's CBOR parser never
  // enters the picture at all for this operation.
  //
  // Coin selection/wallet address, separately: selectWallet.fromPrivateKey()
  // was tried first and failed with a real "insufficient funds" error even
  // though the governor wallet holds 1,000 real Preprod ADA — root cause,
  // confirmed by reasoning through WeldPress's own address construction
  // (CardanoWalletPHP.php): fromPrivateKey() only has a PAYMENT key to work
  // with, so Lucid can only derive an enterprise address from it, not the
  // real BASE address (payment+stake) the governor's actual funds sit at —
  // a payment-only key can't reconstruct a stake credential it never had.
  // Fixed by using selectWallet.fromAddress(governorAddress, utxos) for
  // coin selection/build (the real base address, real UTxOs — same pattern
  // already proven in this file's earlier two-phase attempt) while signing
  // separately via tx.sign.withPrivateKey() below — combining the address-
  // correctness half of the first attempt with the single-process-signing
  // half of the second, without either one's failure mode.
  //
  // The governor's plaintext key material exists only for the lifetime of
  // this one Node process (passed via stdin by the PHP caller, which
  // decrypts it the same way it already does for the mint flow's policy-
  // wallet signing) — never logged, never persisted, never returned.

  async activateCurve(
    governorPrivateKeyExtendedHex: string,
    governorAddress: string,
    currentTimestampMs: number
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const curveUtxo = await this.findCurveUtxo(lucid);
    const currentDatum = Data.from<BondingCurveDatumData>(curveUtxo.datum!, BondingCurveDatumSchema);

    if (currentDatum.curve_state !== 'Inactive') {
      throw new Error(`Curve is not Inactive (state: ${currentDatum.curve_state}) — cannot activate.`);
    }

    const bech32Key = extendedHexToBech32PrivateKey(governorPrivateKeyExtendedHex);
    const governorUtxos = await lucid.utxosAt(governorAddress);
    lucid.selectWallet.fromAddress(governorAddress, governorUtxos);

    const currentTimestamp = BigInt(currentTimestampMs);
    const newDatum: BondingCurveDatumData = {
      ...currentDatum,
      curve_state: 'Active',
      activated_at: currentTimestamp,
    };

    // Redeemer: ActivateCurve is constructor index 0 of 12 — a plain
    // Data.Object naturally serializes at index 0 (see darkveil-claim-
    // submitter.ts's own note re: Data.Object's default), so no raw Constr
    // is needed here (unlike BuyTokens at index 1, below).
    const ActivateCurveRedeemerShape = Data.Object({ current_timestamp: Data.Integer() });
    type ActivateCurveRedeemerData = Data.Static<typeof ActivateCurveRedeemerShape>;
    const ActivateCurveRedeemerSchema = ActivateCurveRedeemerShape as unknown as ActivateCurveRedeemerData;
    const redeemer: ActivateCurveRedeemerData = { current_timestamp: currentTimestamp };

    // interval.contains(self.validity_range, current_timestamp) on-chain —
    // the tx's own validity range must actually contain the stamped
    // timestamp, so set both explicitly rather than rely on Lucid defaults.
    // ActivateCurve is governor-signed and NOT T90-width-bound (confirmed
    // directly in bonding_curve.ak — no validity_range_is_narrow call in
    // this clause), so a legitimately backdated currentTimestampMs (Phase 7
    // stall-testing, per this milestone's own approved precedent) is
    // supported here too — but the range must ALSO overlap the REAL
    // current chain time, or Cardano's own ledger (not just the script)
    // rejects the tx as outside its validity interval regardless of what
    // the script allows. Spanning min(claimed, real-now) to
    // max(claimed, real-now) satisfies both interval.contains(range,
    // current_timestamp) and the ledger's real "does this range cover the
    // actual current slot" check, whether currentTimestampMs is honest
    // (the normal case) or deliberately backdated (Phase 7 only).
    const realNowMs = Date.now();
    const validFrom = Math.min(currentTimestampMs, realNowMs) - 60_000;
    const validTo = Math.max(currentTimestampMs, realNowMs) + 60_000;

    const tx = await lucid
      .newTx()
      .collectFrom([curveUtxo], Data.to<ActivateCurveRedeemerData>(redeemer, ActivateCurveRedeemerSchema))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.scriptAddress,
        { kind: 'inline', value: Data.to<BondingCurveDatumData>(newDatum, BondingCurveDatumSchema) },
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
  // BuyTokens — buyer-signed. Two public entry points sharing one core:
  //   - buyTokens(mnemonic, ...): this session's CLI-driven verification
  //     path (Phase 4), signs via lucid.selectWallet.fromSeed().
  //   - buyTokensWithWallet(walletApi, ...): the real production path (the
  //     Tier A buy widget, integration/widget/tier-a-buy-widget-entry.ts),
  //     signs via lucid.selectWallet.fromAPI(walletApi) — the same real,
  //     installed WalletApi type and fromAPI() call darkveil-claim-
  //     submitter.ts already proved out for Tier B's buyer-signed claim flow.
  // --------------------------------------------------------------------------

  /**
   * `skipClientCapCheck` (default false): deliberately bypasses the
   * client-side wallet-cap guard below so the REAL on-chain
   * `new_total_purchases <= datum.wallet_cap` check (bonding_curve.ak) can
   * be verified directly, not just this client's own honesty — used once,
   * for real, to produce genuine on-chain evidence of cap enforcement
   * (Tier A Preprod Milestone Phase 4's own checkpoint requires a real
   * failed tx/validator error, not "the client also happens to agree").
   * Never pass true from any real buy flow.
   */
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

  /** Real production path — see class-level comment above. */
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
    const currentDatum = Data.from<BondingCurveDatumData>(curveUtxo.datum!, BondingCurveDatumSchema);

    if (currentDatum.curve_state !== 'Active') {
      throw new Error(`Curve is not Active (state: ${currentDatum.curve_state}) — cannot buy.`);
    }

    const remaining = currentDatum.curve_supply - currentDatum.tokens_sold;
    if (tokenAmount <= 0n || tokenAmount > remaining) {
      throw new Error(`token_amount out of range (remaining: ${remaining}).`);
    }

    const claimedPrice = curvePriceAt(currentDatum, currentDatum.tokens_sold);
    const grossPayment = claimedPrice * tokenAmount;
    const claimedCreatorFee = exactFeeSlice(grossPayment, CREATOR_BPS);
    const claimedTreasuryFee = exactFeeSlice(grossPayment, TREASURY_BPS);
    const claimedOpsFee = exactFeeSlice(grossPayment, OPS_BPS);
    const feeTotal = claimedCreatorFee + claimedTreasuryFee + claimedOpsFee;
    const netPayment = grossPayment - feeTotal;

    const buyerKeyHashHex = buyerKeyHashFromAddress(buyerAddress);
    if (buyerKeyHashHex === currentDatum.creator_pub_key_hash) {
      throw new Error('T32: the creator cannot buy from their own curve.');
    }

    const priorPurchases =
      currentDatum.per_address_purchases.find(([vkh]) => vkh === buyerKeyHashHex)?.[1] ?? 0n;
    const newTotalPurchases = priorPurchases + tokenAmount;
    if (newTotalPurchases > currentDatum.wallet_cap && !skipClientCapCheck) {
      throw new Error(
        `5% wallet cap exceeded: ${newTotalPurchases} > ${currentDatum.wallet_cap} (prior: ${priorPurchases}).`
      );
    }

    const newTokensSold = currentDatum.tokens_sold + tokenAmount;
    const nextState: BondingCurveDatumData['curve_state'] =
      newTokensSold === currentDatum.curve_supply ? 'Graduated' : currentDatum.curve_state;

    // Mirrors bonding_curve.ak's own update_purchases exactly: an EXISTING
    // key is updated IN PLACE (same position), only a genuinely new key gets
    // appended at the end. A naive filter-then-append (tried first) instead
    // moves an existing buyer's entry to the end of the list on their 2nd+
    // purchase — the on-chain `new_datum == expected_datum` check is a full
    // structural equality including list order, so that mismatch failed
    // real validation on-chain ("the validator crashed / exited
    // prematurely") the first time a repeat buyer was tested for real.
    const buyerAlreadyPresent = currentDatum.per_address_purchases.some(([vkh]) => vkh === buyerKeyHashHex);
    const newPurchases: Array<[string, bigint]> = buyerAlreadyPresent
      ? currentDatum.per_address_purchases.map(([vkh, amount]) =>
          vkh === buyerKeyHashHex ? [vkh, newTotalPurchases] : [vkh, amount]
        )
      : [...currentDatum.per_address_purchases, [buyerKeyHashHex, newTotalPurchases]];

    const newDatum: BondingCurveDatumData = {
      ...currentDatum,
      tokens_sold: newTokensSold,
      total_raised: currentDatum.total_raised + netPayment,
      creator_fees_accrued: currentDatum.creator_fees_accrued + claimedCreatorFee,
      treasury_fees_accrued: currentDatum.treasury_fees_accrued + claimedTreasuryFee,
      ops_fees_accrued: currentDatum.ops_fees_accrued + claimedOpsFee,
      per_address_purchases: newPurchases,
      curve_state: nextState,
    };

    // Redeemer: BuyTokens is constructor index 1 of 12 — raw Constr needed
    // since Data.Object always serializes at index 0 (same reasoning as
    // darkveil-claim-submitter.ts's own ClaimDarkVeilTokens construction).
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
        { kind: 'inline', value: Data.to<BondingCurveDatumData>(newDatum, BondingCurveDatumSchema) },
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
  // SellTokens (T106) — the reverse of BuyTokens. Seller-signed, same two-
  // signing-shape pattern (mnemonic for this session's CLI verification,
  // WalletApi for the real production path).
  // --------------------------------------------------------------------------

  /** CLI-driven verification path — see class-level comment above. */
  async sellTokens(
    sellerMnemonic: string,
    tokenAmount: bigint
  ): Promise<{ txHash: string; netProceeds: bigint; claimedPrice: bigint }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromSeed(sellerMnemonic);
    const sellerAddress = await lucid.wallet().address();
    return this.sellTokensCore(lucid, sellerAddress, tokenAmount);
  }

  /** Real production path — see class-level comment above. */
  async sellTokensWithWallet(
    walletApi: WalletApi,
    tokenAmount: bigint
  ): Promise<{ txHash: string; netProceeds: bigint; claimedPrice: bigint }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const sellerAddress = await lucid.wallet().address();
    return this.sellTokensCore(lucid, sellerAddress, tokenAmount);
  }

  private async sellTokensCore(
    lucid: LucidEvolution,
    sellerAddress: string,
    tokenAmount: bigint
  ): Promise<{ txHash: string; netProceeds: bigint; claimedPrice: bigint }> {
    const curveUtxo = await this.findCurveUtxo(lucid);
    const currentDatum = Data.from<BondingCurveDatumData>(curveUtxo.datum!, BondingCurveDatumSchema);

    if (currentDatum.curve_state !== 'Active') {
      throw new Error(`Curve is not Active (state: ${currentDatum.curve_state}) — cannot sell.`);
    }
    if (tokenAmount <= 0n) {
      throw new Error('token_amount must be positive.');
    }

    const sellerKeyHashHex = buyerKeyHashFromAddress(sellerAddress);
    const priorPurchases =
      currentDatum.per_address_purchases.find(([vkh]) => vkh === sellerKeyHashHex)?.[1] ?? 0n;
    if (tokenAmount > priorPurchases) {
      throw new Error(
        `Cannot sell more than this wallet is tracked as having bought via this contract: ` +
          `${tokenAmount} > ${priorPurchases} (T106 — per_address_purchases scope limit).`
      );
    }

    const newSold = currentDatum.tokens_sold - tokenAmount;
    if (newSold < 0n) {
      throw new Error(`new_sold would go negative (${newSold}) — this shouldn't happen given the prior check.`);
    }

    // T106: prices at the POST-sell tokens_sold — the low edge of the range
    // being removed, symmetric with BuyTokens pricing at the PRE-buy
    // tokens_sold (low edge of the range being added). See
    // bonding_curve.ak's own SellTokens doc comment for the full reasoning.
    const claimedPrice = curvePriceAt(currentDatum, newSold);
    const grossProceeds = claimedPrice * tokenAmount;
    const claimedCreatorFee = exactFeeSlice(grossProceeds, CREATOR_BPS);
    const claimedTreasuryFee = exactFeeSlice(grossProceeds, TREASURY_BPS);
    const claimedOpsFee = exactFeeSlice(grossProceeds, OPS_BPS);
    const feeTotal = claimedCreatorFee + claimedTreasuryFee + claimedOpsFee;
    const netProceeds = grossProceeds - feeTotal;

    const newTotalPurchases = priorPurchases - tokenAmount;
    const newPurchases: Array<[string, bigint]> = currentDatum.per_address_purchases.map(([vkh, amount]) =>
      vkh === sellerKeyHashHex ? [vkh, newTotalPurchases] : [vkh, amount]
    );

    const newDatum: BondingCurveDatumData = {
      ...currentDatum,
      tokens_sold: newSold,
      // T106: subtract the FULL grossProceeds (not netProceeds) — see
      // bonding_curve.ak's own SellTokens doc comment for the invariant
      // this preserves (total_raised can legitimately go negative on a
      // round-trip sell; that's correct, not a bug).
      total_raised: currentDatum.total_raised - grossProceeds,
      creator_fees_accrued: currentDatum.creator_fees_accrued + claimedCreatorFee,
      treasury_fees_accrued: currentDatum.treasury_fees_accrued + claimedTreasuryFee,
      ops_fees_accrued: currentDatum.ops_fees_accrued + claimedOpsFee,
      per_address_purchases: newPurchases,
    };

    // Redeemer: SellTokens is constructor index 5 of 13 (freshly
    // regenerated plutus.json, T106, 2026-07-19) — raw Constr, same
    // reasoning as BuyTokens above (Data.Object always serializes at
    // index 0).
    const redeemer = new Constr(5, [
      tokenAmount,
      claimedPrice,
      grossProceeds,
      claimedCreatorFee,
      claimedTreasuryFee,
      claimedOpsFee,
      sellerKeyHashHex,
    ]);

    const tokenUnit = toUnit(currentDatum.token_policy_id, currentDatum.token_asset_name);
    const continuingAssets = { ...curveUtxo.assets };
    continuingAssets.lovelace = (continuingAssets.lovelace ?? 0n) - netProceeds;
    continuingAssets[tokenUnit] = (continuingAssets[tokenUnit] ?? 0n) + tokenAmount;

    const tx = await lucid
      .newTx()
      .collectFrom([curveUtxo], Data.to(redeemer))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.scriptAddress,
        { kind: 'inline', value: Data.to<BondingCurveDatumData>(newDatum, BondingCurveDatumSchema) },
        continuingAssets
      )
      .pay.ToAddress(sellerAddress, { lovelace: netProceeds })
      .addSigner(sellerAddress)
      .complete();

    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash, netProceeds, claimedPrice };
  }

  // --------------------------------------------------------------------------
  // ExpireCurve — permissionless (T29/T90), Phase 7. No extra_signatories
  // check exists on-chain (the deadline check itself is the authorization,
  // same idiom as lp_escrow.ak's ExecuteDexChange) — this session still
  // needs SOME real wallet to pay the tx fee, so it reuses the governor's
  // key for that purpose only, same convention already used for
  // ExecuteDexChange in tier-a-dex-change-submitter.ts. T90 requires a
  // real, narrow (<=600,000ms), honest-"now" validity range — no
  // backdating here (unlike ActivateCurve, which legitimately backdates
  // `activated_at` itself to make this reachable without a real 90-day
  // wait).
  // --------------------------------------------------------------------------

  /**
   * currentTimestampMs is deliberately NOT a caller-supplied parameter —
   * unlike ActivateCurve's legitimately-backdatable timestamp, ExpireCurve
   * MUST be honest (permissionless, T90-width-bound) — computed via
   * Date.now() here, immediately before building the tx, not earlier in
   * the call chain (e.g. PHP, before the child-process spawn + several
   * Blockfrost round trips for UTXO queries), which real-world testing
   * showed can go stale by the time the tx actually reaches a block: a
   * transaction whose declared validity range has already elapsed by
   * submission time gets silently dropped rather than erroring — first
   * real attempt at this session accepted the submission (Blockfrost's
   * `/tx/submit` returned a real txHash, no thrown error) but the tx never
   * landed in a block (confirmed via a real /txs/{hash} 404 and the
   * curve's own UTXO still sitting at its pre-ExpireCurve state).
   */
  async expireCurve(
    governorPrivateKeyExtendedHex: string,
    governorAddress: string
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const curveUtxo = await this.findCurveUtxo(lucid);
    const currentDatum = Data.from<BondingCurveDatumData>(curveUtxo.datum!, BondingCurveDatumSchema);

    if (currentDatum.curve_state !== 'Active') {
      throw new Error(`Curve is not Active (state: ${currentDatum.curve_state}) — cannot expire.`);
    }

    const bech32Key = extendedHexToBech32PrivateKey(governorPrivateKeyExtendedHex);
    const governorUtxos = await lucid.utxosAt(governorAddress);
    lucid.selectWallet.fromAddress(governorAddress, governorUtxos);

    const newDatum: BondingCurveDatumData = { ...currentDatum, curve_state: 'Cancelled' };

    // Computed as late as possible — right before building — to minimize
    // the gap between "what we claim now is" and "when this actually
    // lands in a block." See method header for why this matters here.
    const currentTimestampMs = Date.now();

    // BondingCurveRedeemer: ExpireCurve is variant 7 of 13 (T111 — the
    // T106 SellTokens insertion at index 5 shifted every constructor from
    // CancelCurve onward by one; re-verified directly against the
    // freshly-regenerated plutus.json, not assumed from the old count).
    const redeemer = new Constr(7, [BigInt(currentTimestampMs)]);

    // T90 caps width at 600,000ms — use a generous 240s buffer on each
    // side (480,000ms total, comfortably under the cap) so real-world
    // build/sign/submit latency can't push the tx stale before inclusion.
    const validFrom = currentTimestampMs - 240_000;
    const validTo = currentTimestampMs + 240_000;

    const tx = await lucid
      .newTx()
      .collectFrom([curveUtxo], Data.to(redeemer))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.scriptAddress,
        { kind: 'inline', value: Data.to<BondingCurveDatumData>(newDatum, BondingCurveDatumSchema) },
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
  // ClaimBuyback — buyer-signed, Phase 7. Same two-entry-point split as
  // BuyTokens above (mnemonic for CLI verification, WalletApi for the real
  // production path — not wired to a widget this phase since the milestone
  // plan doesn't call for buyback UI, only real proven transactions).
  // --------------------------------------------------------------------------

  async claimBuyback(
    buyerMnemonic: string,
    tokenAmount: bigint
  ): Promise<{ txHash: string; share: bigint }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromSeed(buyerMnemonic);
    const buyerAddress = await lucid.wallet().address();
    return this.claimBuybackCore(lucid, buyerAddress, tokenAmount);
  }

  async claimBuybackWithWallet(
    walletApi: WalletApi,
    tokenAmount: bigint
  ): Promise<{ txHash: string; share: bigint }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const buyerAddress = await lucid.wallet().address();
    return this.claimBuybackCore(lucid, buyerAddress, tokenAmount);
  }

  private async claimBuybackCore(
    lucid: LucidEvolution,
    buyerAddress: string,
    tokenAmount: bigint
  ): Promise<{ txHash: string; share: bigint }> {
    const curveUtxo = await this.findCurveUtxo(lucid);
    const currentDatum = Data.from<BondingCurveDatumData>(curveUtxo.datum!, BondingCurveDatumSchema);

    if (currentDatum.curve_state !== 'Cancelled') {
      throw new Error(`Curve is not Cancelled (state: ${currentDatum.curve_state}) — cannot claim buyback.`);
    }
    if (tokenAmount <= 0n || tokenAmount > currentDatum.tokens_sold) {
      throw new Error(`token_amount out of range (tokens_sold: ${currentDatum.tokens_sold}).`);
    }

    const buyerKeyHashHex = buyerKeyHashFromAddress(buyerAddress);
    // T111 fix (2026-07-19, full-suite security audit): total_raised can
    // legitimately go negative after SellTokens (T106) round-trip
    // activity — mirrors bonding_curve.ak's own effective_total_raised
    // floor exactly (see that redeemer's own doc comment for the full
    // reasoning). Left unguarded here, a negative total_raised produced a
    // negative share, which the contract's own fixed checks now reject —
    // this floor keeps the off-chain-computed value consistent with what
    // the fixed contract will actually accept.
    const effectiveTotalRaised = currentDatum.total_raised > 0n ? currentDatum.total_raised : 0n;
    // Mirrors bonding_curve.ak's own real-division share formula exactly —
    // Aiken's Int is arbitrary-precision, no ZK-circuit division
    // restriction, so this is the exact on-chain value, not an
    // approximation.
    const share = (effectiveTotalRaised * tokenAmount) / currentDatum.tokens_sold;

    const tokenUnit = toUnit(currentDatum.token_policy_id, currentDatum.token_asset_name);
    const newDatum: BondingCurveDatumData = {
      ...currentDatum,
      tokens_sold: currentDatum.tokens_sold - tokenAmount,
      total_raised: currentDatum.total_raised - share,
    };
    const newCurveAssets = {
      ...curveUtxo.assets,
      lovelace: (curveUtxo.assets.lovelace ?? 0n) - share,
      [tokenUnit]: (curveUtxo.assets[tokenUnit] ?? 0n) + tokenAmount,
    };

    // BondingCurveRedeemer: ClaimBuyback is variant 8 of 13 (T111 — see
    // ExpireCurve's own comment above for why this shifted).
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
        { kind: 'inline', value: Data.to<BondingCurveDatumData>(newDatum, BondingCurveDatumSchema) },
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

/**
 * Derive a Cardano base address's payment-credential key hash — the same
 * value Blockfrost's /addresses/{address} endpoint returns as `payment`
 * (already used server-side via np_anvil_parse_address, T-Phase3).
 */
function buyerKeyHashFromAddress(address: string): string {
  const details = getAddressDetails(address);
  const hash = details.paymentCredential?.hash;
  if (!hash) {
    throw new Error(`Could not derive a payment-credential key hash from address ${address}.`);
  }
  return hash;
}

export { fromHex, toHex, exactFeeSlice, curvePriceAt, loadValidator, extendedHexToBech32PrivateKey };
