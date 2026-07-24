// ============================================================================
// Noctis Protocol — Real Cardano transaction submitter for
// contracts/cardano/validators/cto_governance.ak's AnchorVoteResult
// ============================================================================
// The Midnight-to-Cardano half of CTO governance's relay (item #15): once a
// proposal finalizes on Midnight's cto_governance.compact, its result needs
// to be anchored on cto_governance.ak so Cardano-side TriggerCTO/DissolveCTO
// checks (T95's cto_vote_verified() reference-input pattern, already built
// this session in bonding_curve.ak/bonding_curve_tier_b.ak/lp_escrow.ak/
// vesting.ak) have real evidence to check against.
//
// Same "T31: open relay" design already implemented in cto_governance.ak —
// confirmed directly from its AnchorVoteResult and{} block (read 2026-07-19,
// this session): no signer/extra_signatories check exists anywhere in that
// redeemer. relayer_credential_hash is a self-attested audit field, not an
// enforced authorization — this submitter still needs a real wallet to pay
// the transaction fee/collateral, just not as a validator-required signer.
//
// Datum/redeemer schemas below are hand-mirrored from a FRESHLY REGENERATED
// contracts/cardano/plutus.json (`aiken build`, 2026-07-19 — the checked-in
// copy was stale relative to this session's own T95/T96 datum changes
// before this), field names/order/constructor indices read directly from
// the blueprint's real JSON, not from cto_governance.ak's source comments —
// same discipline cardano-anchor-submitter.ts already established (this
// codebase has drifted on exactly this point before: T30/T31/T35).
//
// What IS real here: the Data encoding, UTXO lookup, transaction
// construction, and the new-datum state-transition logic (mirrored line-
// for-line from the validator's own and{} block, since the validator checks
// new_datum == expected_datum exactly) are all built against Lucid
// Evolution's real, installed API.
//
// What is NOT tested: an actual end-to-end submission against a live
// Cardano node — needs a funded relayer key and a deployed cto_governance
// anchor UTXO, neither of which exist in this dev environment. Same honest
// boundary as cardano-anchor-submitter.ts.
// ============================================================================

import { Blockfrost, Data, Lucid, validatorToAddress, CredentialSchema } from '@lucid-evolution/lucid';
import type { LucidEvolution, SpendingValidator, UTxO, Network as LucidNetwork } from '@lucid-evolution/lucid';

// ============================================================================
// DATA SCHEMAS — mirror the fresh contracts/cardano/plutus.json exactly
// ============================================================================

const CtoAnchorStateSchema = Data.Enum([
  Data.Literal('PreCTO'),
  Data.Literal('CTOTriggered'),
  Data.Literal('CTODissolved'),
]);

export const ProposalTypeSchema = Data.Enum([
  Data.Literal('SilenceLockTrigger'),
  Data.Literal('FundAllocation'),
  Data.Literal('DexMigration'),
  Data.Literal('WhitelistUpdate'),
  Data.Literal('DissolveCTOProposal'),
]);
export type ProposalTypeData = Data.Static<typeof ProposalTypeSchema>;

const ProposalOutcomeSchema = Data.Enum([Data.Literal('Passed'), Data.Literal('Failed')]);
export type ProposalOutcomeData = Data.Static<typeof ProposalOutcomeSchema>;

const ExecutionStatusSchema = Data.Enum([
  Data.Literal('PendingExecution'),
  Data.Literal('Executed'),
  Data.Literal('Expired'),
]);

/** target_dex_credential/active_proposal/last_executed_proposal are all real Option<T> fields on-chain — Data.Nullable is Lucid Evolution's own real Option encoding, already used elsewhere in this codebase (tier-a-schemas.ts's pending_dex_change). */
const ProposalAnchorShape = Data.Object({
  proposal_type: ProposalTypeSchema,
  description_hash: Data.Bytes(),
  proof_bundle_hash: Data.Bytes(),
  yes_votes: Data.Integer(),
  no_votes: Data.Integer(),
  voter_count: Data.Integer(),
  creator_yes_votes: Data.Integer(),
  creator_no_votes: Data.Integer(),
  outcome: ProposalOutcomeSchema,
  start_timestamp: Data.Integer(),
  end_timestamp: Data.Integer(),
  anchor_timestamp: Data.Integer(),
  execution_status: ExecutionStatusSchema,
  target_dex_credential: Data.Nullable(CredentialSchema),
  allocation_amount: Data.Integer(),
  allocation_recipient_hash: Data.Bytes(),
  relayer_credential_hash: Data.Bytes(),
});
type ProposalAnchorData = Data.Static<typeof ProposalAnchorShape>;
const ProposalAnchorSchema = ProposalAnchorShape as unknown as ProposalAnchorData;

/**
 * T111 fix (2026-07-19, full-suite security audit): CtoGovernanceDatum
 * gained 4 new fields for the bonded-challenge-window fix — see
 * cto_governance.ak's own doc comment on `pending_relayer_bond` for the
 * full mechanism. Re-verified against the freshly-regenerated plutus.json.
 */
const CtoGovernanceDatumShape = Data.Object({
  launch_id: Data.Bytes(),
  cto_state: CtoAnchorStateSchema,
  community_wallet_hash: Data.Bytes(),
  governor_credential_hash: Data.Bytes(),
  total_supply: Data.Integer(),
  quorum_bps: Data.Integer(),
  creator_vote_cap_bps: Data.Integer(),
  active_proposal: Data.Nullable(ProposalAnchorShape),
  proposal_count: Data.Integer(),
  last_executed_proposal: Data.Nullable(ProposalAnchorShape),
  pending_relayer_bond: Data.Integer(),
  pending_relayer_key_hash: Data.Bytes(),
  treasury_pub_key_hash: Data.Bytes(),
  ops_pub_key_hash: Data.Bytes(),
});
type CtoGovernanceDatumData = Data.Static<typeof CtoGovernanceDatumShape>;
const CtoGovernanceDatumSchema = CtoGovernanceDatumShape as unknown as CtoGovernanceDatumData;

/**
 * AnchorVoteResult — constructor index 0 of 8 real redeemer variants
 * (verified against the fresh blueprint, 2026-07-19 — T111 added
 * VoidPendingProposal/ReclaimRelayerBond, neither implemented by this
 * submitter yet). A plain Data.Object (defaults to Constr index 0) is
 * sufficient since this submitter only ever constructs this one variant —
 * same reasoning cardano-anchor-submitter.ts already established for
 * zk_anchor's AnchorCertificate.
 *
 * T111 fix: gained a trailing `relayer_bond` field — AnchorVoteResult now
 * requires a real ADA bond (>= 25 ADA, `min_relayer_bond` in
 * cto_governance.ak) paid into the contract's own continuing output, to
 * close the "forge a vote result for free" gap. See submitVoteResult's
 * own comment below for how the payment itself is constructed.
 */
const AnchorVoteResultRedeemerShape = Data.Object({
  proposal_type: ProposalTypeSchema,
  description_hash: Data.Bytes(),
  proof_bundle_hash: Data.Bytes(),
  yes_votes: Data.Integer(),
  no_votes: Data.Integer(),
  voter_count: Data.Integer(),
  creator_yes_votes: Data.Integer(),
  creator_no_votes: Data.Integer(),
  outcome: ProposalOutcomeSchema,
  start_timestamp: Data.Integer(),
  end_timestamp: Data.Integer(),
  anchor_timestamp: Data.Integer(),
  target_dex_credential: Data.Nullable(CredentialSchema),
  allocation_amount: Data.Integer(),
  allocation_recipient_hash: Data.Bytes(),
  relayer_credential_hash: Data.Bytes(),
  relayer_bond: Data.Integer(),
});
type AnchorVoteResultRedeemerData = Data.Static<typeof AnchorVoteResultRedeemerShape>;
const AnchorVoteResultRedeemerSchema = AnchorVoteResultRedeemerShape as unknown as AnchorVoteResultRedeemerData;

/** T111: same fixed figure as cto_governance.ak's own `min_relayer_bond`. */
export const MIN_RELAYER_BOND_LOVELACE = 25_000_000n;

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

// ============================================================================
// PARAMS — one Midnight proposal's finalized result, ready to anchor
// ============================================================================

export interface VoteResultParams {
  proposalType: ProposalTypeData;
  descriptionHash: Uint8Array;
  proofBundleHash: Uint8Array;
  yesVotes: bigint;
  noVotes: bigint;
  voterCount: bigint;
  creatorYesVotes: bigint;
  creatorNoVotes: bigint;
  outcome: ProposalOutcomeData;
  startTimestamp: bigint;
  endTimestamp: bigint;
  anchorTimestamp: bigint;
  // Real Lucid Evolution CredentialSchema-derived shape (verified against
  // the installed package's own .d.ts — "PubKeyCredential", not
  // "PublicKeyCredential" or "VerificationKeyCredential" as one might guess).
  targetDexCredential: { PubKeyCredential: [string] } | { ScriptCredential: [string] } | null;
  allocationAmount: bigint;
  allocationRecipientHash: string; // hex VerificationKeyHash
  relayerCredentialHash: string; // hex VerificationKeyHash — self-attested (T31, no signature enforced)
  /** T111: real ADA bond, >= MIN_RELAYER_BOND_LOVELACE, paid into the contract's own continuing output — see submitVoteResult's own comment. */
  relayerBondLovelace: bigint;
}

// ============================================================================
// SUBMITTER
// ============================================================================

export interface CardanoCtoAnchorSubmitterConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  /** cto_governance.ak's compiled PlutusV3 script CBOR — plutus.json's `validators[].compiledCode` for `cto_governance.cto_governance.spend`. One fixed address shared by every launch (CLAUDE.md's Contract Architecture table). */
  compiledScriptCbor: string;
  /** Relayer's private key — pays the fee/collateral. AnchorVoteResult itself is permissionless (T31), so this key is never required as a validator-checked signer, only as the transaction's real payer. */
  relayerPrivateKey: string;
  launchId: Uint8Array;
}

export class CardanoCtoAnchorSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private validator: SpendingValidator;
  private scriptAddress: string;

  constructor(private config: CardanoCtoAnchorSubmitterConfig) {
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

  private async findAnchorUtxo(lucid: LucidEvolution, launchId: Uint8Array): Promise<UTxO> {
    const utxos = await lucid.utxosAt(this.scriptAddress);
    const launchIdHex = toHex(launchId);
    for (const utxo of utxos) {
      if (!utxo.datum) continue;
      let decoded: CtoGovernanceDatumData;
      try {
        decoded = Data.from<CtoGovernanceDatumData>(utxo.datum, CtoGovernanceDatumSchema);
      } catch {
        continue;
      }
      if (decoded.launch_id === launchIdHex) return utxo;
    }
    throw new Error(`No cto_governance anchor UTXO found for launch_id ${launchIdHex} at ${this.scriptAddress}`);
  }

  /**
   * Submits AnchorVoteResult for one finalized Midnight proposal.
   * Requires the anchor's active_proposal to currently be null (the
   * validator's own datum.active_proposal == None check) — callers must
   * ensure ClearProposal has run since any prior anchor before calling
   * this again, same as the validator itself requires.
   *
   * T111 fix: AnchorVoteResult no longer mutates cto_state/
   * community_wallet_hash directly — that's ExecuteProposal's job now,
   * once the 24h challenge window has elapsed unvoided (see
   * cardano-cto-execute-proposal-submitter.ts, TODO — not yet built;
   * ExecuteProposal/VoidPendingProposal/ReclaimRelayerBond have no
   * submitter in this codebase yet). This call now also requires posting
   * a real ADA bond (>= MIN_RELAYER_BOND_LOVELACE) into the contract's
   * own continuing output, closing the "forge a vote result for free" gap.
   */
  async submitVoteResult(params: VoteResultParams): Promise<{ txHash: string }> {
    if (params.relayerBondLovelace < MIN_RELAYER_BOND_LOVELACE) {
      throw new Error(
        `relayerBondLovelace (${params.relayerBondLovelace}) is below the required floor (${MIN_RELAYER_BOND_LOVELACE})`
      );
    }

    const lucid = await this.lucidPromise;
    const anchorUtxo = await this.findAnchorUtxo(lucid, this.config.launchId);
    const currentDatum = Data.from<CtoGovernanceDatumData>(anchorUtxo.datum!, CtoGovernanceDatumSchema);

    const proposalAnchor: ProposalAnchorData = {
      proposal_type: params.proposalType,
      description_hash: toHex(params.descriptionHash),
      proof_bundle_hash: toHex(params.proofBundleHash),
      yes_votes: params.yesVotes,
      no_votes: params.noVotes,
      voter_count: params.voterCount,
      creator_yes_votes: params.creatorYesVotes,
      creator_no_votes: params.creatorNoVotes,
      outcome: params.outcome,
      start_timestamp: params.startTimestamp,
      end_timestamp: params.endTimestamp,
      anchor_timestamp: params.anchorTimestamp,
      execution_status: 'PendingExecution',
      target_dex_credential: params.targetDexCredential,
      allocation_amount: params.allocationAmount,
      allocation_recipient_hash: params.allocationRecipientHash,
      relayer_credential_hash: params.relayerCredentialHash,
    };

    // Mirrors AnchorVoteResult's own state-transition logic line-for-line
    // (cto_governance.ak, read 2026-07-19) — the validator checks
    // `new_datum == expected_datum` exactly, so this MUST match it exactly.
    // T111: cto_state/community_wallet_hash are untouched here — only the
    // pending-bond fields and the proposal record change.
    const newDatum: CtoGovernanceDatumData = {
      ...currentDatum,
      active_proposal: proposalAnchor,
      proposal_count: currentDatum.proposal_count + 1n,
      pending_relayer_bond: params.relayerBondLovelace,
      pending_relayer_key_hash: params.relayerCredentialHash,
    };

    const redeemerData: AnchorVoteResultRedeemerData = {
      proposal_type: params.proposalType,
      description_hash: toHex(params.descriptionHash),
      proof_bundle_hash: toHex(params.proofBundleHash),
      yes_votes: params.yesVotes,
      no_votes: params.noVotes,
      voter_count: params.voterCount,
      creator_yes_votes: params.creatorYesVotes,
      creator_no_votes: params.creatorNoVotes,
      outcome: params.outcome,
      start_timestamp: params.startTimestamp,
      end_timestamp: params.endTimestamp,
      anchor_timestamp: params.anchorTimestamp,
      target_dex_credential: params.targetDexCredential,
      allocation_amount: params.allocationAmount,
      allocation_recipient_hash: params.allocationRecipientHash,
      relayer_credential_hash: params.relayerCredentialHash,
      relayer_bond: params.relayerBondLovelace,
    };

    // T111: the bond is real lovelace added to the continuing output's
    // value on top of whatever the anchor UTXO already held — matches
    // cto_governance.ak's bond_received check
    // (own_output.lovelace == own_input.lovelace + relayer_bond).
    const continuingAssets = {
      ...anchorUtxo.assets,
      lovelace: (anchorUtxo.assets.lovelace ?? 0n) + params.relayerBondLovelace,
    };

    const tx = await lucid
      .newTx()
      .collectFrom([anchorUtxo], Data.to<AnchorVoteResultRedeemerData>(redeemerData, AnchorVoteResultRedeemerSchema))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.scriptAddress,
        { kind: 'inline', value: Data.to<CtoGovernanceDatumData>(newDatum, CtoGovernanceDatumSchema) },
        continuingAssets
      )
      .complete();

    const signed = await tx.sign.withPrivateKey(this.config.relayerPrivateKey).complete();
    const txHash = await signed.submit();
    return { txHash };
  }
}

export { toHex };
