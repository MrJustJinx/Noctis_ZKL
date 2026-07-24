// ============================================================================
// Noctis Protocol — Real Cardano transaction submitter for
// bonding_curve_tier_b.ak's AnchorDvAllocationRoot (T112)
// ============================================================================
// T112 (2026-07-19, Tier B cross-chain audit) added a new governor-signed
// redeemer closing the gap where dv_allocation_root had no on-chain write
// path at all: AnchorDvAllocationRoot { dv_allocation_root: ByteArray },
// constructor index 12 of 14 (confirmed against the freshly-regenerated
// contracts/cardano/plutus.json, not assumed from the .ak source's
// declaration order). Governor-signed, gated on curve_state == Inactive.
//
// Same governor-signing pattern already proven in tier-a-curve-submitter.ts's
// activateCurve (single-process build->sign->submit via
// CML.PrivateKey.from_extended_bytes(), selectWallet.fromAddress() for real
// base-address coin selection since a payment-only key can't reconstruct a
// stake credential it never had) — reused verbatim here, not re-derived.
// Unlike ActivateCurve, this redeemer has no interval.contains/
// validity_range check at all (confirmed directly in bonding_curve_tier_b.ak
// — no timestamp field on this redeemer), so no validity-range dance is
// needed here.
//
// What IS real here: Data encoding (verified against the freshly-regenerated
// blueprint), UTXO lookup, transaction construction, and signing/submission
// calls are all built against Lucid Evolution's real, installed API.
//
// What is NOT tested: an actual end-to-end submission against a live Cardano
// node. Needs a funded governor wallet and a deployed bonding_curve_tier_b
// UTXO on preprod/mainnet, neither of which exist in this dev environment.
// Flagged explicitly, same honest boundary as every other submitter in this
// codebase.
// ============================================================================

import { Blockfrost, CML, Data, Lucid, validatorToAddress } from '@lucid-evolution/lucid';
import type { LucidEvolution, SpendingValidator, UTxO, Network as LucidNetwork } from '@lucid-evolution/lucid';
import { BondingCurveTierBDatumSchema, type BondingCurveTierBDatumData } from './tier-a-schemas.js';

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/** Same conversion as tier-a-curve-submitter.ts's extendedHexToBech32PrivateKey — see that file's own comment for the full reasoning (WeldPress_CardanoWalletPHP's raw 64-byte kL||kR format -> Lucid's bech32 ed25519e_sk...). */
function extendedHexToBech32PrivateKey(extendedHex: string): string {
  const bytes = fromHex(extendedHex);
  if (bytes.length !== 64) {
    throw new Error(`Expected a 64-byte extended private key (kL||kR), got ${bytes.length} bytes.`);
  }
  return CML.PrivateKey.from_extended_bytes(bytes).to_bech32();
}

/** AnchorDvAllocationRoot — constructor index 12 of 14 real redeemer variants (confirmed against the fresh blueprint, 2026-07-19). */
const AnchorDvAllocationRootRedeemerShape = Data.Object({ dv_allocation_root: Data.Bytes() });
type AnchorDvAllocationRootRedeemerData = Data.Static<typeof AnchorDvAllocationRootRedeemerShape>;
const AnchorDvAllocationRootRedeemerSchema =
  AnchorDvAllocationRootRedeemerShape as unknown as AnchorDvAllocationRootRedeemerData;

export interface CardanoDvAllocationAnchorSubmitterConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  /** bonding_curve_tier_b.ak's compiled PlutusV3 script CBOR — plutus.json's `validators[].compiledCode` for `bonding_curve_tier_b.bonding_curve_tier_b.spend`. One shared, unparameterized script address across every Tier B launch. */
  compiledScriptCbor: string;
  launchIdHex: string;
}

export class CardanoDvAllocationAnchorSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private validator: SpendingValidator;
  private scriptAddress: string;

  constructor(private config: CardanoDvAllocationAnchorSubmitterConfig) {
    this.validator = { type: 'PlutusV3', script: config.compiledScriptCbor };
    this.scriptAddress = validatorToAddress(config.network, this.validator);
    this.lucidPromise = Lucid(new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId), config.network);
  }

  /** Same "match launch_id inside the datum" pattern as every other shared-address submitter in this codebase. */
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

  /**
   * Anchors the real, governor-computed dv_allocation_root (see
   * dv-allocation-tree.ts's buildDvAllocationTree) before ActivateCurve can
   * run. Freely re-callable while curve_state is still Inactive (the
   * on-chain redeemer's own gate) — a mistaken root can be corrected any
   * number of times before public trading opens.
   *
   * The governor's plaintext key material exists only for the lifetime of
   * this one Node process (passed via stdin by the PHP caller, which
   * decrypts it the same way it already does for every other
   * platform-wallet signing operation) — never logged, never persisted,
   * never returned.
   */
  async anchorDvAllocationRoot(
    governorPrivateKeyExtendedHex: string,
    governorAddress: string,
    dvAllocationRootHex: string
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const curveUtxo = await this.findCurveUtxo(lucid);
    const currentDatum = Data.from<BondingCurveTierBDatumData>(curveUtxo.datum!, BondingCurveTierBDatumSchema);

    if (currentDatum.curve_state !== 'Inactive') {
      throw new Error(`Curve is not Inactive (state: ${currentDatum.curve_state}) — cannot anchor dv_allocation_root anymore.`);
    }

    const bech32Key = extendedHexToBech32PrivateKey(governorPrivateKeyExtendedHex);
    const governorUtxos = await lucid.utxosAt(governorAddress);
    lucid.selectWallet.fromAddress(governorAddress, governorUtxos);

    const newDatum: BondingCurveTierBDatumData = {
      ...currentDatum,
      dv_allocation_root: dvAllocationRootHex,
      dv_settled: true,
    };

    const redeemer: AnchorDvAllocationRootRedeemerData = { dv_allocation_root: dvAllocationRootHex };

    const tx = await lucid
      .newTx()
      .collectFrom(
        [curveUtxo],
        Data.to<AnchorDvAllocationRootRedeemerData>(redeemer, AnchorDvAllocationRootRedeemerSchema)
      )
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.scriptAddress,
        { kind: 'inline', value: Data.to<BondingCurveTierBDatumData>(newDatum, BondingCurveTierBDatumSchema) },
        curveUtxo.assets
      )
      .addSigner(governorAddress)
      .complete();

    const signed = await tx.sign.withPrivateKey(bech32Key).complete();
    const txHash = await signed.submit();
    return { txHash };
  }
}

export { fromHex };
