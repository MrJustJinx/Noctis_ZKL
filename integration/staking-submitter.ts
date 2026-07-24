// ============================================================================
// Noctis Protocol — Staking Rewards Pool (T66) real Cardano submitter
// ============================================================================
// contracts/cardano/validators/staking_pool.ak — one shared validator
// address for Tier A AND Tier B (not tier-specific like bonding_curve vs
// bonding_curve_tier_b). Two datum shapes share the address: Pool (one per
// launch, real depleting reward-token UTXO value) and Position (one per
// stake action). See tier-a-schemas.ts's StakingDatumSchema/
// StakingPoolDatumSchema/StakingPositionDatumSchema for the verified field
// order/constructor indices (confirmed against a freshly-regenerated
// plutus.json, round-tripped through a real Data.to/Data.from encode/
// decode cycle before use — not assumed from .ak source alone).
//
// Constructor indices, StakingPoolRedeemer (verified against plutus.json):
//   Unstake=0 (no fields), ClaimRewards=1 (staker_vkh, claimed_cumulative_
//   amount, merkle_proof), TopUpPool=2 (amount), PublishRewardRoot=3
//   (new_root), QueryState=4 (hardened to always-False per T109, never
//   constructed here).
//
// Staking itself (first or additional stake) needs NO redeemer — creating
// a script UTXO is permissionless on Cardano, same as any deposit. Only
// spending an existing Position/Pool UTXO needs a redeemer.
//
// ClaimRewards is deliberately PERMISSIONLESS on-chain (no signature
// check) — "the proof is the authorization," same idiom as Graduate/
// ExpireCurve elsewhere in this codebase. The staker's own wallet is the
// practical caller in every method below, but nothing on-chain requires
// that; a relayer could submit on a staker's behalf without changing where
// funds land (T93/T115/T117's payment-credential-only check guarantees
// payout always reaches the real staker_vkh's address regardless of who
// signs/submits the transaction).
//
// Two signing shapes, same split as every other Tier A/B submitter in
// this codebase:
//   - Extended-key signing (topUpPool, publishRewardRoot): the creator/
//     governor platform-wallet custody scheme only ever persists an
//     encrypted extended skey, never a mnemonic — see tier-a-claims-
//     submitter.ts's own header for why.
//   - WalletApi signing (stakeWithWallet, unstakeWithWallet,
//     claimRewardsWithWallet): the real holder-facing production path,
//     lucid.selectWallet.fromAPI(walletApi) + sign.withWallet().
// ============================================================================

import { Blockfrost, Constr, Data, Lucid, validatorToAddress, getAddressDetails, CML } from '@lucid-evolution/lucid';
import type {
  LucidEvolution,
  SpendingValidator,
  UTxO,
  Network as LucidNetwork,
  WalletApi,
  TxSignBuilder,
} from '@lucid-evolution/lucid';
import {
  StakingDatumSchema,
  StakingPoolDatumSchema,
  StakingPositionDatumSchema,
  type StakingDatumData,
  type StakingPoolDatumData,
  type StakingPositionDatumData,
} from './tier-a-schemas.js';

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

function extendedHexToBech32PrivateKey(extendedHex: string): string {
  const bytes = fromHex(extendedHex);
  if (bytes.length !== 64) {
    throw new Error(`Expected a 64-byte extended private key (kL||kR), got ${bytes.length} bytes.`);
  }
  return CML.PrivateKey.from_extended_bytes(bytes).to_bech32();
}

/** Same pattern as tier-a-curve-submitter.ts's buyerKeyHashFromAddress. */
function keyHashFromAddress(address: string): string {
  const details = getAddressDetails(address);
  const hash = details.paymentCredential?.hash;
  if (!hash) {
    throw new Error(`Could not derive a payment-credential key hash from address ${address}.`);
  }
  return hash;
}

/** Minimum lovelace to include alongside a real launch token in a Position/
 *  Pool UTXO — same conservative floor value this codebase's own
 *  staking_pool.ak tests use throughout (2 ADA), not a computed min-UTxO
 *  (Lucid Evolution's own coin selection tops this up further if the real
 *  protocol parameter requires more for the actual datum size). */
const MIN_UTXO_LOVELACE = 2_000_000n;

export interface StakingConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  stakingPoolScriptCbor: string;
  launchIdHex: string;
}

export interface StakingPosition {
  utxo: UTxO;
  datum: StakingPositionDatumData;
}

export class StakingSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private validator: SpendingValidator;
  private address: string;

  constructor(private config: StakingConfig) {
    this.validator = { type: 'PlutusV3', script: config.stakingPoolScriptCbor };
    this.address = validatorToAddress(config.network, this.validator);
    this.lucidPromise = Lucid(new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId), config.network);
  }

  private async allUtxos(lucid: LucidEvolution): Promise<UTxO[]> {
    return lucid.utxosAt(this.address);
  }

  private decodeDatum(utxo: UTxO): StakingDatumData | null {
    if (!utxo.datum) return null;
    try {
      return Data.from<StakingDatumData>(utxo.datum, StakingDatumSchema);
    } catch {
      return null;
    }
  }

  /** The one Pool UTXO for this launch — thrown if staking was never enabled/seeded (Graduate's staking_seeded check, T66). */
  async findPoolUtxo(lucid: LucidEvolution): Promise<{ utxo: UTxO; datum: StakingPoolDatumData }> {
    const utxos = await this.allUtxos(lucid);
    for (const utxo of utxos) {
      const decoded = this.decodeDatum(utxo);
      if (decoded && 'Pool' in decoded) {
        const pool = decoded.Pool[0];
        if (pool.launch_id === this.config.launchIdHex) return { utxo, datum: pool };
      }
    }
    throw new Error(`No staking Pool UTXO found for launch_id ${this.config.launchIdHex} — staking may not be enabled for this launch.`);
  }

  /** Live on-chain pool state — panel calls this directly, same "readCurveDatum()" convention as tier-a-claims-submitter.ts. */
  async readPoolDatum(): Promise<StakingPoolDatumData> {
    const lucid = await this.lucidPromise;
    const { datum } = await this.findPoolUtxo(lucid);
    return datum;
  }

  /** Every real Position UTXO belonging to one staker, for this launch — the panel's "your stakes" list. */
  async findPositions(stakerAddress: string): Promise<StakingPosition[]> {
    const lucid = await this.lucidPromise;
    const stakerVkh = keyHashFromAddress(stakerAddress);
    const utxos = await this.allUtxos(lucid);
    const out: StakingPosition[] = [];
    for (const utxo of utxos) {
      const decoded = this.decodeDatum(utxo);
      if (decoded && 'Position' in decoded) {
        const pos = decoded.Position[0];
        if (pos.launch_id === this.config.launchIdHex && pos.staker_vkh === stakerVkh) {
          out.push({ utxo, datum: pos });
        }
      }
    }
    return out;
  }

  // --------------------------------------------------------------------
  // Stake — plain deposit, no redeemer, no spend
  // --------------------------------------------------------------------

  private async stakeCore(
    lucid: LucidEvolution,
    stakerAddress: string,
    amount: bigint,
    stakeTimestampMsOverride?: number
  ): Promise<TxSignBuilder> {
    if (amount <= 0n) throw new Error('Stake amount must be positive.');
    const { datum: pool } = await this.findPoolUtxo(lucid);
    const stakerVkh = keyHashFromAddress(stakerAddress);
    const tokenUnit = pool.token_policy_id + pool.token_asset_name;

    const positionDatum: StakingDatumData = {
      Position: [
        {
          launch_id: this.config.launchIdHex,
          staker_vkh: stakerVkh,
          staked_amount: amount,
          // Real POSIX ms — matches this codebase's now-consistent
          // millisecond convention (T87/T89/T90). Not independently
          // re-verified on-chain (staking_pool.ak's own file header: the
          // governor's off-chain reward formula is the only consumer,
          // and it's the staker's OWN wallet signing this deposit — the
          // same self-attested-timestamp trust boundary CLAUDE.md already
          // documents for this field), so a caller-supplied override is
          // safe to accept — unlike backdating a GOVERNOR-trusted action
          // (ActivateCurve etc.), a staker backdating their own stake
          // only ever costs THEM real bonding-period eligibility sooner,
          // never anyone else's funds. Exists so a real Preprod
          // verification pass can test bonding-period accrual without a
          // literal 7-day wait, same precedent already established for
          // ExpireCurve/SealLock/StartVesting.
          stake_timestamp: BigInt(stakeTimestampMsOverride ?? Date.now()),
        },
      ],
    };

    return lucid
      .newTx()
      .pay.ToContract(
        this.address,
        { kind: 'inline', value: Data.to<StakingDatumData>(positionDatum, StakingDatumSchema) },
        { lovelace: MIN_UTXO_LOVELACE, [tokenUnit]: amount }
      )
      .addSigner(stakerAddress)
      .complete();
  }

  /** Real production path. */
  async stakeWithWallet(walletApi: WalletApi, amount: bigint): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const stakerAddress = await lucid.wallet().address();
    const tx = await this.stakeCore(lucid, stakerAddress, amount);
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  /** CLI-driven verification path — mnemonic-based, same pattern as tier-a-curve-submitter.ts's buyTokens() (a test-wallet convenience, not the production signing shape). `stakeTimestampMsOverride` lets a real Preprod verification pass backdate a position's bonding-period clock without a literal 7-day wait — see stakeCore's own comment for why this is safe. */
  async stake(stakerMnemonic: string, amount: bigint, stakeTimestampMsOverride?: number): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromSeed(stakerMnemonic);
    const stakerAddress = await lucid.wallet().address();
    const tx = await this.stakeCore(lucid, stakerAddress, amount, stakeTimestampMsOverride);
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  // --------------------------------------------------------------------
  // Unstake — full withdrawal of one position, staker-signed
  // --------------------------------------------------------------------

  private async unstakeCore(lucid: LucidEvolution, stakerAddress: string, position: StakingPosition): Promise<TxSignBuilder> {
    const stakerVkh = keyHashFromAddress(stakerAddress);
    if (position.datum.staker_vkh !== stakerVkh) {
      throw new Error('This position does not belong to the connected wallet.');
    }

    // Unstake: Constr 0, no fields.
    const unstakeRedeemer = new Constr(0, []);

    return lucid
      .newTx()
      .collectFrom([position.utxo], Data.to(unstakeRedeemer))
      .attach.SpendingValidator(this.validator)
      .pay.ToAddress(stakerAddress, position.utxo.assets)
      .addSigner(stakerAddress)
      .complete();
  }

  /** Real production path. */
  async unstakeWithWallet(walletApi: WalletApi, position: StakingPosition): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const stakerAddress = await lucid.wallet().address();
    const tx = await this.unstakeCore(lucid, stakerAddress, position);
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  /** CLI-driven verification path — mnemonic-based. */
  async unstake(stakerMnemonic: string, position: StakingPosition): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromSeed(stakerMnemonic);
    const stakerAddress = await lucid.wallet().address();
    const tx = await this.unstakeCore(lucid, stakerAddress, position);
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  // --------------------------------------------------------------------
  // ClaimRewards — permissionless, Merkle-proof-of-membership
  // --------------------------------------------------------------------

  /**
   * @param claimedCumulativeAmount  The staker's TOTAL earned as of the
   *   currently-published reward_root (not a delta) — from
   *   staking-reward-tree-builder.ts's published snapshot. The contract
   *   pays out (claimedCumulativeAmount - already-claimed-so-far).
   * @param merkleProof  This staker's inclusion proof against the current
   *   reward_root, from the same snapshot.
   */
  private async claimRewardsCore(
    lucid: LucidEvolution,
    stakerAddress: string,
    claimedCumulativeAmount: bigint,
    merkleProof: Array<{ sibling: string; goesLeft: boolean }>
  ): Promise<TxSignBuilder> {
    const { utxo: poolUtxo, datum: pool } = await this.findPoolUtxo(lucid);
    const stakerVkh = keyHashFromAddress(stakerAddress);

    const alreadyClaimed = pool.claimed_so_far.find(([vkh]) => vkh === stakerVkh)?.[1] ?? 0n;
    if (claimedCumulativeAmount <= alreadyClaimed) {
      throw new Error(`claimedCumulativeAmount (${claimedCumulativeAmount}) must exceed already-claimed (${alreadyClaimed}).`);
    }
    const payout = claimedCumulativeAmount - alreadyClaimed;
    const tokenUnit = pool.token_policy_id + pool.token_asset_name;

    const newClaimedSoFar: Array<[string, bigint]> = pool.claimed_so_far.some(([vkh]) => vkh === stakerVkh)
      ? pool.claimed_so_far.map(([vkh, amt]) => (vkh === stakerVkh ? ([vkh, claimedCumulativeAmount] as [string, bigint]) : [vkh, amt]))
      : [...pool.claimed_so_far, [stakerVkh, claimedCumulativeAmount]];

    const newPoolDatum: StakingDatumData = { Pool: [{ ...pool, claimed_so_far: newClaimedSoFar }] };
    const newPoolAssets = { ...poolUtxo.assets, [tokenUnit]: (poolUtxo.assets[tokenUnit] ?? 0n) - payout };

    // ClaimRewards: Constr 1, fields (staker_vkh, claimed_cumulative_amount, merkle_proof).
    // MerkleProofStep: Constr 0, fields (sibling, goes_left) — goes_left is
    // a real Aiken Bool, encoded as Constr 1=True/0=False (no fields
    // either way), same pattern darkveil-claim-submitter.ts already
    // established for the structurally identical bonding_curve_tier_b.ak
    // MerkleProofStep — NOT a raw JS boolean, which Data.to can't encode.
    const claimRedeemer = new Constr(1, [
      stakerVkh,
      claimedCumulativeAmount,
      merkleProof.map((step) => new Constr(0, [step.sibling, new Constr(step.goesLeft ? 1 : 0, [])])),
    ]);

    return lucid
      .newTx()
      .collectFrom([poolUtxo], Data.to(claimRedeemer))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.address,
        { kind: 'inline', value: Data.to<StakingDatumData>(newPoolDatum, StakingDatumSchema) },
        newPoolAssets
      )
      .pay.ToAddress(stakerAddress, { [tokenUnit]: payout })
      .complete();
  }

  /** Real production path — permissionless on-chain, but the connected wallet is the practical caller (see class header). */
  async claimRewardsWithWallet(
    walletApi: WalletApi,
    claimedCumulativeAmount: bigint,
    merkleProof: Array<{ sibling: string; goesLeft: boolean }>
  ): Promise<{ txHash: string; payout: bigint }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const stakerAddress = await lucid.wallet().address();
    const { datum: pool } = await this.findPoolUtxo(lucid);
    const stakerVkh = keyHashFromAddress(stakerAddress);
    const alreadyClaimed = pool.claimed_so_far.find(([vkh]) => vkh === stakerVkh)?.[1] ?? 0n;

    const tx = await this.claimRewardsCore(lucid, stakerAddress, claimedCumulativeAmount, merkleProof);
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash, payout: claimedCumulativeAmount - alreadyClaimed };
  }

  /** CLI-driven verification path — mnemonic-based. */
  async claimRewards(
    stakerMnemonic: string,
    claimedCumulativeAmount: bigint,
    merkleProof: Array<{ sibling: string; goesLeft: boolean }>
  ): Promise<{ txHash: string; payout: bigint }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromSeed(stakerMnemonic);
    const stakerAddress = await lucid.wallet().address();
    const { datum: pool } = await this.findPoolUtxo(lucid);
    const stakerVkh = keyHashFromAddress(stakerAddress);
    const alreadyClaimed = pool.claimed_so_far.find(([vkh]) => vkh === stakerVkh)?.[1] ?? 0n;

    const tx = await this.claimRewardsCore(lucid, stakerAddress, claimedCumulativeAmount, merkleProof);
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash, payout: claimedCumulativeAmount - alreadyClaimed };
  }

  // --------------------------------------------------------------------
  // TopUpPool — creator-only
  // --------------------------------------------------------------------

  private async topUpPoolCore(lucid: LucidEvolution, creatorAddress: string, amount: bigint): Promise<TxSignBuilder> {
    if (amount <= 0n) throw new Error('Top-up amount must be positive.');
    const { utxo: poolUtxo, datum: pool } = await this.findPoolUtxo(lucid);
    if (keyHashFromAddress(creatorAddress) !== pool.creator_pub_key_hash) {
      throw new Error('Only the launch creator can top up the staking pool.');
    }
    const tokenUnit = pool.token_policy_id + pool.token_asset_name;
    const newPoolAssets = { ...poolUtxo.assets, [tokenUnit]: (poolUtxo.assets[tokenUnit] ?? 0n) + amount };

    // TopUpPool: Constr 2, field (amount).
    const topUpRedeemer = new Constr(2, [amount]);

    return lucid
      .newTx()
      .collectFrom([poolUtxo], Data.to(topUpRedeemer))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.address,
        { kind: 'inline', value: Data.to<StakingDatumData>({ Pool: [pool] }, StakingDatumSchema) },
        newPoolAssets
      )
      .addSigner(creatorAddress)
      .complete();
  }

  /** CLI-driven path — creator platform-wallet custody only ever persists an extended skey, never a mnemonic (same reasoning as tier-a-claims-submitter.ts). */
  async topUpPool(creatorPrivateKeyExtendedHex: string, creatorAddress: string, amount: bigint): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const bech32Key = extendedHexToBech32PrivateKey(creatorPrivateKeyExtendedHex);
    const creatorUtxos = await lucid.utxosAt(creatorAddress);
    lucid.selectWallet.fromAddress(creatorAddress, creatorUtxos);

    const tx = await this.topUpPoolCore(lucid, creatorAddress, amount);
    const signed = await tx.sign.withPrivateKey(bech32Key).complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  /** Real production path (browser-connected creator wallet). */
  async topUpPoolWithWallet(walletApi: WalletApi, amount: bigint): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);
    const creatorAddress = await lucid.wallet().address();
    const tx = await this.topUpPoolCore(lucid, creatorAddress, amount);
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  // --------------------------------------------------------------------
  // PublishRewardRoot — governor-only, automated (WP-Cron)
  // --------------------------------------------------------------------

  private async publishRewardRootCore(lucid: LucidEvolution, governorAddress: string, newRootHex: string): Promise<TxSignBuilder> {
    const { utxo: poolUtxo, datum: pool } = await this.findPoolUtxo(lucid);
    if (keyHashFromAddress(governorAddress) !== pool.governor_pub_key_hash) {
      throw new Error('Only the governor can publish a new reward root.');
    }

    const newPoolDatum: StakingDatumData = { Pool: [{ ...pool, reward_root: newRootHex }] };

    // PublishRewardRoot: Constr 3, field (new_root).
    const publishRedeemer = new Constr(3, [newRootHex]);

    return lucid
      .newTx()
      .collectFrom([poolUtxo], Data.to(publishRedeemer))
      .attach.SpendingValidator(this.validator)
      .pay.ToContract(
        this.address,
        { kind: 'inline', value: Data.to<StakingDatumData>(newPoolDatum, StakingDatumSchema) },
        poolUtxo.assets
      )
      .addSigner(governorAddress)
      .complete();
  }

  /** Governor-signed, automated (WP-Cron → CLI → this method). Same extended-key custody reasoning as topUpPool. */
  async publishRewardRoot(governorPrivateKeyExtendedHex: string, governorAddress: string, newRootHex: string): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    const bech32Key = extendedHexToBech32PrivateKey(governorPrivateKeyExtendedHex);
    const governorUtxos = await lucid.utxosAt(governorAddress);
    lucid.selectWallet.fromAddress(governorAddress, governorUtxos);

    const tx = await this.publishRewardRootCore(lucid, governorAddress, newRootHex);
    const signed = await tx.sign.withPrivateKey(bech32Key).complete();
    const txHash = await signed.submit();
    return { txHash };
  }
}

export { extendedHexToBech32PrivateKey, keyHashFromAddress };
