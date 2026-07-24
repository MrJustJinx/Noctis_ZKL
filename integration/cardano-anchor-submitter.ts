// ============================================================================
// Noctis Protocol — Real Cardano transaction submitter for zk_anchor.ak
// ============================================================================
// T21 (2026-07-10): implements `CardanoTxSubmitter` (zk-cert-relayer.ts),
// previously left as an honestly-unimplemented interface because this repo
// had no Cardano transaction-building layer at all. Built with
// `@lucid-evolution/lucid` (confirmed real, published, actively maintained —
// npm shows 0.5.5 at time of writing, github.com/Anastasia-Labs/lucid-evolution)
// instead of the Anvil API: Anvil's documented endpoints (transactions/build
// for simple payments, OTC, marketplace, minting — see the anvil-api skill)
// and its live docs site (docs.ada-anvil.io) do not show a generic
// "spend an arbitrary Plutus validator with a custom redeemer" endpoint;
// Lucid Evolution's `collectFrom`/`attach.SpendingValidator` do this exactly,
// confirmed against the real installed package's .d.ts files, not assumed.
//
// The Data schemas below are hand-mirrored from `contracts/cardano/plutus.json`
// (Aiken's CIP-57 blueprint output for zk_anchor.ak) — field names, order, and
// constructor indices copied directly from the compiled schema, not the
// source file, so this stays correct even if a comment in the .ak file drifts.
//
// What IS real here: the Data encoding, UTXO lookup, transaction construction,
// and signing/submission calls are all built against Lucid Evolution's actual
// API — nothing here is a stub or a guess.
//
// What is NOT tested: an actual end-to-end submission against a live Cardano
// node. That needs a funded relayer key and a deployed zk_anchor UTXO on
// preprod/mainnet, neither of which exist in this session. Type-checked and
// structurally verified against the compiled Aiken blueprint; not yet
// exercised against a real chain. Flag this explicitly rather than claiming
// more than that.
// ============================================================================

import { Blockfrost, Data, Lucid, validatorToAddress } from '@lucid-evolution/lucid';
import type { LucidEvolution, SpendingValidator, UTxO, Network as LucidNetwork } from '@lucid-evolution/lucid';
import type { AnchorCertificateParams, CardanoTxSubmitter, CertificateType } from './zk-cert-relayer.js';

// ============================================================================
// DATA SCHEMAS — mirror contracts/cardano/plutus.json's zk_anchor definitions
// exactly (field names, order, constructor indices), not contracts/cardano/
// validators/zk_anchor.ak's source — the compiled blueprint is the actual
// on-chain contract, source comments can drift from it (as several PSMs in
// this repo already have this session — see internal tracking T30/T31/T35).
// ============================================================================

/**
 * zk_anchor/CertificateType — 4 no-field constructors, index order from the
 * blueprint (DarkVeilCert=0, FullZKCert=1, CtoVoteResult=2, GraduationCert=3).
 * Confirmed against a real Lucid Evolution example (spacebudz/lucid's own
 * test suite, same Data.Enum semantics carried into lucid-evolution's fork):
 * no-field variants are plain string literals via Data.Literal, NOT
 * `{ VariantName: {} }` wrapper objects — that was wrong in an earlier draft
 * of this file. Constructor index is positional (array order), not encoded
 * in the string itself, so this array's order must stay in sync with
 * zk_anchor.ak's actual enum declaration order.
 */
const CertificateTypeSchema = Data.Enum([
  Data.Literal('DarkVeilCert'),
  Data.Literal('FullZKCert'),
  Data.Literal('CtoVoteResult'),
  Data.Literal('GraduationCert'),
]);
// The resulting Data.Static type is exactly zk-cert-relayer.ts's own
// `CertificateType` union — no separate conversion table needed, a
// `CertificateType` value can be used directly as Data.

/** zk_anchor/ZkAnchorDatum — field order per plutus.json, constructor index 0. */
const ZkAnchorDatumShape = Data.Object({
  launch_id: Data.Bytes(),
  cert_type: CertificateTypeSchema,
  proof_bundle_hash: Data.Bytes(),
  proof_ipfs_cid: Data.Bytes(),
  anchor_timestamp: Data.Integer(),
  relayer_credential_hash: Data.Bytes(),
  governor_credential_hash: Data.Bytes(),
  metadata_hash: Data.Bytes(),
});
type ZkAnchorDatumData = Data.Static<typeof ZkAnchorDatumShape>;
// Data.to/Data.from's `type` parameter is typed as the STATIC value shape,
// not the TypeBox schema shape (confirmed against Lucid Evolution's own
// test suite pattern) — the schema object is cast to lie to the type
// checker; it's still the real runtime schema underneath, just typed as
// its own static output for calling Data.to/Data.from correctly.
const ZkAnchorDatumSchema = ZkAnchorDatumShape as unknown as ZkAnchorDatumData;

/**
 * zk_anchor/ZkAnchorRedeemer's `AnchorCertificate` variant only (constructor
 * index 0 of 5 total variants) — this submitter only ever CONSTRUCTS this
 * one variant, never decodes an arbitrary redeemer, so a plain Data.Object
 * (which already defaults to Constr index 0 per Data.Object's own doc
 * comment) is sufficient and exactly matches AnchorCertificate's real
 * field list — no need to model the other 4 variants (AddRelayer/
 * RemoveRelayer/QueryCertificate/UpdateIpfsCid) or wrap this in a full
 * Data.Enum just to construct one specific arm.
 */
const AnchorCertificateRedeemerShape = Data.Object({
  cert_type: CertificateTypeSchema,
  proof_bundle_hash: Data.Bytes(),
  proof_ipfs_cid: Data.Bytes(),
  metadata_hash: Data.Bytes(),
  timestamp: Data.Integer(),
});
type AnchorCertificateRedeemerData = Data.Static<typeof AnchorCertificateRedeemerShape>;
const AnchorCertificateRedeemerSchema = AnchorCertificateRedeemerShape as unknown as AnchorCertificateRedeemerData;

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

// ============================================================================
// SUBMITTER
// ============================================================================

export interface LucidAnchorSubmitterConfig {
  /** Blockfrost project ID — same credential this repo's blockfrost-client.ts already uses. */
  blockfrostProjectId: string;
  blockfrostUrl: string; // e.g. https://cardano-preprod.blockfrost.io/api/v0
  network: LucidNetwork; // 'Mainnet' | 'Preprod' | 'Preview' | 'Custom'
  /** zk_anchor.ak's compiled PlutusV3 script CBOR — plutus.json's `validators[].compiledCode`
   *  for the `zk_anchor.zk_anchor.spend` entry. Same hash for every launch (one shared
   *  script address; each launch gets its own UTXO there, distinguished by launch_id). */
  compiledScriptCbor: string;
  /** Relayer's private key (bech32 `ed25519_sk...`). Whoever operates the relayer
   *  (per CLAUDE.md's T21 "platform-operated relayer, address is public" design)
   *  controls this — not generated or stored here. */
  relayerPrivateKey: string;
  /** Which launch's anchor UTXO this submitter targets — matches
   *  NoctisLaunchManager's own "one instance per launch" pattern
   *  (midnight-client.ts) rather than taking launch_id per call, since
   *  CardanoTxSubmitter's interface (zk-cert-relayer.ts) has no room for
   *  it in submitAnchorCertificate's signature. */
  launchId: Uint8Array;
}

export class LucidAnchorSubmitter implements CardanoTxSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private validator: SpendingValidator;
  private scriptAddress: string;

  constructor(private config: LucidAnchorSubmitterConfig) {
    this.validator = { type: 'PlutusV3', script: config.compiledScriptCbor };
    this.scriptAddress = validatorToAddress(config.network, this.validator);
    this.lucidPromise = Lucid(
      new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId),
      config.network
    ).then((lucid) => {
      lucid.selectWallet.fromPrivateKey(config.relayerPrivateKey);
      return lucid;
    });
  }

  /**
   * Finds the anchor UTXO for a specific launch among all UTXOs sitting at
   * the shared zk_anchor script address, by matching `launch_id` in the
   * decoded datum — there is no per-launch script parameterization (the
   * compiled hash is identical across launches, confirmed against
   * plutus.json), so the datum is the only way to tell launches apart.
   */
  private async findAnchorUtxo(lucid: LucidEvolution, launchId: Uint8Array): Promise<UTxO> {
    const utxos = await lucid.utxosAt(this.scriptAddress);
    const launchIdHex = toHex(launchId);
    for (const utxo of utxos) {
      if (!utxo.datum) continue;
      let decoded: ZkAnchorDatumData;
      try {
        decoded = Data.from<ZkAnchorDatumData>(utxo.datum, ZkAnchorDatumSchema);
      } catch {
        continue; // Not a ZkAnchorDatum-shaped UTXO — skip rather than throw.
      }
      if (decoded.launch_id === launchIdHex) return utxo;
    }
    throw new Error(`No zk_anchor UTXO found for launch_id ${launchIdHex} at ${this.scriptAddress}`);
  }

  async submitAnchorCertificate(
    params: AnchorCertificateParams,
    relayerAddress: string
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const anchorUtxo = await this.findAnchorUtxo(lucid, this.config.launchId);

    const currentDatum = Data.from<ZkAnchorDatumData>(anchorUtxo.datum!, ZkAnchorDatumSchema);

    const newDatum: ZkAnchorDatumData = {
      ...currentDatum,
      cert_type: params.certType,
      proof_bundle_hash: toHex(params.proofBundleHash),
      proof_ipfs_cid: toHex(params.proofIpfsCid),
      anchor_timestamp: BigInt(params.timestamp),
      metadata_hash: toHex(params.metadataHash),
    };

    const redeemer: AnchorCertificateRedeemerData = {
      cert_type: params.certType,
      proof_bundle_hash: toHex(params.proofBundleHash),
      proof_ipfs_cid: toHex(params.proofIpfsCid),
      metadata_hash: toHex(params.metadataHash),
      timestamp: BigInt(params.timestamp),
    };

    const tx = await lucid
      .newTx()
      .collectFrom([anchorUtxo], Data.to<AnchorCertificateRedeemerData>(redeemer, AnchorCertificateRedeemerSchema))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.scriptAddress,
        { kind: 'inline', value: Data.to<ZkAnchorDatumData>(newDatum, ZkAnchorDatumSchema) },
        anchorUtxo.assets
      )
      .addSigner(relayerAddress)
      .complete();

    const signed = await tx.sign.withPrivateKey(this.config.relayerPrivateKey).complete();
    const txHash = await signed.submit();
    return { txHash };
  }
}

export { fromHex, toHex };
