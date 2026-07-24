// ============================================================================
// Noctis Protocol — Real Cardano transaction submitter for Tier B's
// ClaimDarkVeilTokens (bonding_curve_tier_b.ak)
// ============================================================================
// T46/T69 (2026-07-15): the DarkVeil widget plan's Part B originally called
// for "mirror anvil-client.php's mint dispatcher" for this settlement step.
// That's not achievable: anvil-client.php's real dispatcher
// (np_rest_tx_build/np_rest_tx_submit) only covers native-script minting and
// plain payments — confirmed by reading its actual PHP source — and
// ClaimDarkVeilTokens needs to SPEND an existing Plutus-script UTXO with a
// custom redeemer, the exact gap T21 already found and solved for
// zk_anchor.ak via cardano-anchor-submitter.ts. This file follows that same
// precedent (Lucid Evolution), adapted for a buyer-initiated transaction
// instead of a relayer-operated one:
//   - cardano-anchor-submitter.ts signs with a fixed relayer private key,
//     since the relayer submits on the platform's behalf.
//   - This submitter signs via lucid.selectWallet.fromAPI(walletApi) — a
//     real, installed export (@lucid-evolution/core-types' WalletApi,
//     re-exported through @lucid-evolution/lucid's `export *`) — because the
//     BUYER pays gross_payment out of their own wallet and must be the one
//     signing, matching `list.has(self.extra_signatories, buyer_key_hash)`
//     on-chain. No private key is generated, stored, or handled here.
//
// SCHEMA STALENESS CAUGHT MID-SESSION (2026-07-15): contracts/cardano/
// plutus.json was last regenerated at commit 95492e2 (2026-07-12), which
// predates T66's 4 new staking datum fields added to bonding_curve_tier_b.ak
// at commit 9ff4575 (2026-07-14) — the compiled blueprint was missing
// staking_enabled/staking_pool_credential/staking_reserve_tokens/
// staking_seeded (23 fields vs. the real 28). Regenerated for real via
// `aiken build` (WSL) before writing the schema below — see that commit.
// Every field name/order/constructor-index below is taken from the
// FRESH, real compiled blueprint, not contracts/cardano/validators/
// bonding_curve_tier_b.ak's source comments (which can drift — same
// discipline as T21's anchor submitter and T30/T31/T35's doc-sync fixes).
//
// The ClaimDarkVeilTokens redeemer variant (constructor index 2 of 13) is
// built via the raw `Constr` class rather than `Data.Object`, because
// `Data.Object` always serializes at index 0 (see its own doc comment) and
// has no option to target a non-zero constructor index. Modeling the other
// 12 redeemer variants just to reach index 2 via `Data.Enum`'s positional
// indexing would be extra surface area this submitter never needs — it only
// ever CONSTRUCTS this one variant, never decodes an arbitrary redeemer
// (same "model only the arm you use" scoping as the anchor submitter's
// AnchorCertificateRedeemerShape, just via a different mechanism since that
// one variant happened to sit at index 0).
//
// What IS real here: Data encoding (verified against the real compiled
// blueprint), UTXO lookup, fee-floor arithmetic (mirrors verify_fee_slice's
// exact floor formula), datum transition (mirrors the ClaimDarkVeilTokens
// match arm's `expected_datum` field-for-field), transaction construction,
// and wallet-API-based signing/submission — all built against Lucid
// Evolution's real, installed API.
//
// What is NOT tested: an actual end-to-end submission against a live
// Cardano node/wallet. No funded buyer wallet or deployed
// bonding_curve_tier_b UTXO exists in this dev environment. Type-checked and
// structurally verified against the freshly-regenerated compiled blueprint;
// not yet exercised against a real chain. Flag this explicitly, same as
// T21's anchor submitter.
// ============================================================================

import {
  Blockfrost,
  Constr,
  Data,
  Lucid,
  toUnit,
  validatorToAddress,
  CredentialSchema,
} from '@lucid-evolution/lucid';
import type {
  LucidEvolution,
  SpendingValidator,
  UTxO,
  Network as LucidNetwork,
  WalletApi,
  CredentialData,
} from '@lucid-evolution/lucid';

// ============================================================================
// DATA SCHEMAS — mirror the FRESHLY-REGENERATED contracts/cardano/plutus.json
// (bonding_curve_tier_b definitions) exactly, not the .ak source comments.
// ============================================================================

/**
 * bonding_curve_tier_b/CurveState — 4 no-field constructors, real index
 * order from the blueprint: Inactive=0, Active=1, Graduated=2, Cancelled=3.
 * Same Data.Enum-of-literals, positional-index convention already verified
 * and used by cardano-anchor-submitter.ts's CertificateTypeSchema.
 */
const CurveStateSchema = Data.Enum([
  Data.Literal('Inactive'),
  Data.Literal('Active'),
  Data.Literal('Graduated'),
  Data.Literal('Cancelled'),
]);

/**
 * bonding_curve_tier_b/MerkleProofStep — single constructor (index 0),
 * fields `sibling` (Bytes) then `goes_left` (Bool) — real order from the
 * blueprint. Flat Data.Object is correct here since there's only one
 * constructor to model.
 */
const MerkleProofStepShape = Data.Object({
  sibling: Data.Bytes(),
  goes_left: Data.Boolean(),
});
type MerkleProofStepData = Data.Static<typeof MerkleProofStepShape>;
const MerkleProofStepSchema = MerkleProofStepShape as unknown as MerkleProofStepData;

/**
 * bonding_curve_tier_b/BondingCurveTierBDatum — single constructor (index
 * 0), 29 fields in the exact real order from the freshly-regenerated
 * blueprint (see file header re: the T66 staking-field staleness this
 * session caught). `lp_escrow_credential`/`staking_pool_credential` reuse
 * Lucid Evolution's own built-in CredentialSchema — its property names
 * (PubKeyCredential/ScriptCredential) differ from Aiken's
 * (VerificationKey/Script), but PlutusData encoding is purely structural
 * (Constr index + positional fields); CIP-57 titles are never encoded
 * on-chain, so the two are byte-for-byte compatible. Confirmed positionally:
 * Lucid's schema declares the pubkey variant first (index 0) then the
 * script variant (index 1), matching Aiken's VerificationKey=0/Script=1.
 */
const BondingCurveTierBDatumShape = Data.Object({
  launch_id: Data.Bytes(),
  creator_pub_key_hash: Data.Bytes(),
  governor_pub_key_hash: Data.Bytes(),
  base_price: Data.Integer(),
  max_price: Data.Integer(),
  curve_supply: Data.Integer(),
  curve_state: CurveStateSchema,
  activated_at: Data.Integer(),
  tokens_sold: Data.Integer(),
  total_raised: Data.Integer(),
  creator_fees_accrued: Data.Integer(),
  treasury_fees_accrued: Data.Integer(),
  ops_fees_accrued: Data.Integer(),
  wallet_cap: Data.Integer(),
  identity_purchases: Data.Array(Data.Tuple([Data.Bytes(), Data.Integer()])),
  dv_allocation_root: Data.Bytes(),
  dv_claimed: Data.Array(Data.Bytes()),
  // T112 (2026-07-19, Tier B cross-chain audit): whether
  // dv_allocation_root has been anchored to a real value yet — see
  // bonding_curve_tier_b.ak's own field comment for the full reasoning.
  dv_settled: Data.Boolean(),
  token_policy_id: Data.Bytes(),
  token_asset_name: Data.Bytes(),
  lp_escrow_credential: CredentialSchema,
  lp_reserve_tokens: Data.Integer(),
  lp_seeded: Data.Boolean(),
  community_pub_key_hash: Data.Bytes(),
  cto_triggered: Data.Boolean(),
  staking_enabled: Data.Boolean(),
  staking_pool_credential: CredentialSchema,
  staking_reserve_tokens: Data.Integer(),
  staking_seeded: Data.Boolean(),
});
type BondingCurveTierBDatumData = Data.Static<typeof BondingCurveTierBDatumShape>;
const BondingCurveTierBDatumSchema = BondingCurveTierBDatumShape as unknown as BondingCurveTierBDatumData;

// ============================================================================
// On-chain fee-floor / cap constants — mirror bonding_curve_tier_b.ak's own
// `creator_bps`/`treasury_bps`/`ops_bps`/`bps_denominator` (lines 213-219)
// exactly. If these ever drift from the contract, verify_fee_slice will
// reject every claim built by this file.
// ============================================================================
const CREATOR_BPS = 100n;
const TREASURY_BPS = 60n;
const OPS_BPS = 40n;
const BPS_DENOMINATOR = 10_000n;

/**
 * Mirrors verify_fee_slice's real floor formula (bonding_curve_tier_b.ak
 * line 299): claimed_fee must be the FLOOR of gross_payment * bps / 10000.
 * Computing it this way (not gross_payment * bps / BPS_DENOMINATOR via
 * float) guarantees the exact integer floor the on-chain check requires.
 */
function feeFloor(grossPayment: bigint, bps: bigint): bigint {
  return (grossPayment * bps) / BPS_DENOMINATOR;
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

// ============================================================================
// SUBMITTER
// ============================================================================

export interface DarkVeilClaimParams {
  /** The buyer's own private DarkVeil allocation — from the governor's
   *  published Merkle tree, surfaced to the buyer off-chain (T46 design).
   *  Never revealed to anyone but the buyer until this claim tx is submitted. */
  dvAmount: bigint;
  salt: Uint8Array;
  /** Merkle inclusion proof for hash_dv_leaf(buyerKeyHash, dvAmount, salt)
   *  against the anchored dv_allocation_root — same (sibling, direction)
   *  shape as every other Merkle proof in this codebase (T46/T9/staking). */
  merkleProof: Array<{ sibling: Uint8Array; goesLeft: boolean }>;
  /** Buyer's Cardano verification key hash — must match extra_signatories,
   *  and must be able to sign via the connected walletApi. */
  buyerKeyHash: Uint8Array;
}

export interface LucidDarkVeilClaimSubmitterConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  /** bonding_curve_tier_b.ak's compiled PlutusV3 script CBOR —
   *  plutus.json's `validators[].compiledCode` for the
   *  `bonding_curve_tier_b.bonding_curve_tier_b.spend` entry. The validator
   *  is unparameterized (confirmed against the source — `validator
   *  bonding_curve_tier_b { ... }` takes no arguments), so this is one
   *  shared script address across every Tier B launch, exactly like
   *  zk_anchor.ak — individual launches are told apart by `launch_id`
   *  inside the datum, not by address. */
  compiledScriptCbor: string;
  launchId: Uint8Array;
}

export class LucidDarkVeilClaimSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private validator: SpendingValidator;
  private scriptAddress: string;

  constructor(private config: LucidDarkVeilClaimSubmitterConfig) {
    this.validator = { type: 'PlutusV3', script: config.compiledScriptCbor };
    this.scriptAddress = validatorToAddress(config.network, this.validator);
    this.lucidPromise = Lucid(
      new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId),
      config.network
    );
  }

  /** Same "match launch_id inside the datum" pattern as
   *  cardano-anchor-submitter.ts's findAnchorUtxo — this script address is
   *  shared across every Tier B launch. */
  private async findCurveUtxo(lucid: LucidEvolution, launchId: Uint8Array): Promise<UTxO> {
    const utxos = await lucid.utxosAt(this.scriptAddress);
    const launchIdHex = toHex(launchId);
    for (const utxo of utxos) {
      if (!utxo.datum) continue;
      let decoded: BondingCurveTierBDatumData;
      try {
        decoded = Data.from<BondingCurveTierBDatumData>(utxo.datum, BondingCurveTierBDatumSchema);
      } catch {
        continue;
      }
      if (decoded.launch_id === launchIdHex) return utxo;
    }
    throw new Error(`No bonding_curve_tier_b UTXO found for launch_id ${launchIdHex} at ${this.scriptAddress}`);
  }

  /**
   * Buyer-initiated claim: connects the buyer's OWN wallet (via its real
   * CIP-30-style API object, same shape wallet-connection.ts already works
   * with for Midnight — here it's the Cardano wallet, e.g. via WeldPress)
   * to sign and pay for this transaction. No relayer key involved — the
   * buyer pays gross_payment and receives their tokens directly.
   */
  async claimDarkVeilTokens(walletApi: WalletApi, params: DarkVeilClaimParams): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);

    const curveUtxo = await this.findCurveUtxo(lucid, this.config.launchId);
    const currentDatum = Data.from<BondingCurveTierBDatumData>(curveUtxo.datum!, BondingCurveTierBDatumSchema);

    const buyerKeyHashHex = toHex(params.buyerKeyHash);
    const saltHex = toHex(params.salt);

    if (currentDatum.curve_state !== 'Active') {
      throw new Error(`Curve is not Active (state: ${currentDatum.curve_state}) — cannot claim.`);
    }
    if (currentDatum.dv_claimed.includes(buyerKeyHashHex)) {
      throw new Error('This wallet has already claimed its DarkVeil allocation.');
    }
    if (buyerKeyHashHex === currentDatum.creator_pub_key_hash) {
      throw new Error('T32: the creator cannot claim from their own launch.');
    }

    const remaining = currentDatum.curve_supply - currentDatum.tokens_sold;
    if (params.dvAmount <= 0n || params.dvAmount > remaining) {
      throw new Error(`dvAmount out of range (remaining: ${remaining}).`);
    }

    // Flat DarkVeil price (base_price) — NOT the quadratic public-phase
    // formula. Mirrors the ClaimDarkVeilTokens match arm exactly (line 639).
    const grossPayment = params.dvAmount * currentDatum.base_price;
    const claimedCreatorFee = feeFloor(grossPayment, CREATOR_BPS);
    const claimedTreasuryFee = feeFloor(grossPayment, TREASURY_BPS);
    const claimedOpsFee = feeFloor(grossPayment, OPS_BPS);
    const feeTotal = claimedCreatorFee + claimedTreasuryFee + claimedOpsFee;
    const netPayment = grossPayment - feeTotal;

    const priorPurchases =
      currentDatum.identity_purchases.find(([vkh]) => vkh === buyerKeyHashHex)?.[1] ?? 0n;
    const newTotalPurchases = priorPurchases + params.dvAmount;
    if (newTotalPurchases > currentDatum.wallet_cap) {
      throw new Error(
        `5% wallet cap exceeded: ${newTotalPurchases} > ${currentDatum.wallet_cap} (prior: ${priorPurchases}).`
      );
    }

    const newTokensSold = currentDatum.tokens_sold + params.dvAmount;
    const nextState: BondingCurveTierBDatumData['curve_state'] =
      newTokensSold === currentDatum.curve_supply ? 'Graduated' : currentDatum.curve_state;

    const otherPurchases = currentDatum.identity_purchases.filter(([vkh]) => vkh !== buyerKeyHashHex);

    const newDatum: BondingCurveTierBDatumData = {
      ...currentDatum,
      tokens_sold: newTokensSold,
      total_raised: currentDatum.total_raised + netPayment,
      creator_fees_accrued: currentDatum.creator_fees_accrued + claimedCreatorFee,
      treasury_fees_accrued: currentDatum.treasury_fees_accrued + claimedTreasuryFee,
      ops_fees_accrued: currentDatum.ops_fees_accrued + claimedOpsFee,
      identity_purchases: [...otherPurchases, [buyerKeyHashHex, newTotalPurchases]],
      dv_claimed: [buyerKeyHashHex, ...currentDatum.dv_claimed],
      curve_state: nextState,
    };

    // Redeemer: raw Constr at index 2 (ClaimDarkVeilTokens) — see file
    // header for why Data.Object can't be used for a non-zero index.
    const merkleProofConstr = params.merkleProof.map(
      (step) => new Constr(0, [toHex(step.sibling), new Constr(step.goesLeft ? 1 : 0, [])])
    );
    const redeemer = new Constr(2, [
      params.dvAmount,
      saltHex,
      merkleProofConstr,
      claimedCreatorFee,
      claimedTreasuryFee,
      claimedOpsFee,
      buyerKeyHashHex,
    ]);

    const tokenUnit = toUnit(currentDatum.token_policy_id, currentDatum.token_asset_name);
    const buyerAddress = await lucid.wallet().address();

    const continuingAssets = { ...curveUtxo.assets };
    continuingAssets.lovelace = (continuingAssets.lovelace ?? 0n) + grossPayment;
    continuingAssets[tokenUnit] = (continuingAssets[tokenUnit] ?? 0n) - params.dvAmount;

    const tx = await lucid
      .newTx()
      .collectFrom([curveUtxo], Data.to(redeemer))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.scriptAddress,
        { kind: 'inline', value: Data.to<BondingCurveTierBDatumData>(newDatum, BondingCurveTierBDatumSchema) },
        continuingAssets
      )
      .pay.ToAddress(buyerAddress, { [tokenUnit]: params.dvAmount })
      .addSigner(buyerAddress)
      .complete();

    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash };
  }
}

export { fromHex, toHex, feeFloor };
