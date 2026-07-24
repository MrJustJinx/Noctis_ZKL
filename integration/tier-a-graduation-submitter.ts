// ============================================================================
// Noctis Protocol — Tier A Preprod Milestone, Phase 5
// Real Cardano transaction submitter for graduation: bonding_curve.ak's
// Graduate + lp_escrow.ak's SealLock + vesting.ak's StartVesting.
// ============================================================================
// T91 finding (2026-07-17): the original design fired all 3 redeemers in
// ONE transaction (see finding #5 in TIER_A_PREPROD_MILESTONE.md's header).
// A real Preprod submission against T90-patched bytecode (bonding_curve.ak
// and lp_escrow.ak both grew — T90's validity_range_is_narrow helper is
// compiled into the shared `spend` entry point every redeemer shares, not
// just ExpireCurve/ExecuteDexChange) came in at 16387 bytes — 3 over
// Cardano's real 16384-byte tx size cap. Investigated true CIP-33 reference
// scripts as the fix (deploy each validator once, reference it instead of
// re-embedding); ruled out after reading @lucid-evolution/lucid's own
// bundled source directly (both the installed 0.5.5 and the latest 0.6.0
// tarball) — `collectFrom`'s witness-building always calls
// `PlutusScriptWitness.new_script(script)` unconditionally, never
// `new_ref(hash)`, regardless of any `readFrom`-supplied reference input.
// `readFrom` in this library only adds a reference input for reading a
// UTXO's datum; it does not let `collectFrom` skip re-embedding the script.
// Real fix: split into two transactions. Verified directly against both
// contracts (not assumed) that this is safe:
//   - Graduate's own checks (graduation_funds_left_curve,
//     lp_seeding_output_ok, staking_seeding_output_ok) only inspect the
//     CURRENT transaction's own inputs/outputs — lp_seeding_output_ok looks
//     for a correctly-valued output at lp_escrow's address in Graduate's
//     OWN tx, it does not require lp_escrow's SealLock redeemer to also
//     fire in the same tx.
//   - StartVesting (vesting.ak) checks ONLY the governor signature and its
//     own datum's `vesting_state == NotStarted` — zero reference to
//     bonding_curve.ak or lp_escrow.ak state of any kind.
// So: TX1 = Graduate + SealLock (bonding_curve + lp_escrow scripts, the two
// that ARE coupled via lp_seeding_output_ok / lp_value_received's shared
// lp_ada value). TX2 = StartVesting alone (fully independent). TX2 is built
// only after TX1 is confirmed (lucid.awaitTx) so its fee/collateral input
// selection sees TX1's real spent/change UTxOs, not a stale pre-TX1 set.
// ============================================================================
// Graduate and SealLock are both PERMISSIONLESS (no extra_signatories check
// at all — "the correctness of the resulting real value movement is the
// authorization", same idiom as ExpireCurve/ExecuteDexChange). StartVesting
// is the only one of the three that requires a signature
// (governor_pub_key_hash), so this whole flow still needs the governor's
// key — same CML.PrivateKey.from_extended_bytes() +
// selectWallet.fromAddress() pattern tier-a-curve-submitter.ts's
// activateCurve() already established and proved on real Preprod (T86),
// reused here rather than re-derived.
//
// Timestamp units — DELIBERATELY DIFFERENT from ActivateCurve's convention,
// confirmed by reading each contract's own redeemer logic (not assumed):
//   - Graduate takes NO timestamp parameter at all (bare variant).
//   - SealLock's `timestamp` / vesting's `start_timestamp` are NEVER checked
//     against interval.contains(self.validity_range, ...) — unlike
//     ActivateCurve/ExpireCurve, neither lp_escrow.ak nor vesting.ak binds
//     these fields to the transaction's real Cardano validity range at all.
//     They're used purely in later day-arithmetic (`lock_duration`'s own
//     "31536000 = 365 days" comment, vesting.ak's `vest_days * 86400`) —
//     both unambiguously SECONDS-denominated. Passing ms here (mirroring
//     ActivateCurve) would silently make every future vesting/lock-expiry
//     calculation ~1000x wrong. See internal tracking's [T87] entry — found
//     while researching exactly this question — for the real, confirmed-via-
//     on-chain-evidence case that ActivateCurve/ExpireCurve's OWN
//     `activated_at`/`current_timestamp` fields are ms (because THEY
//     actually call interval.contains against Cardano's real ms-scale
//     validity range) — a cross-contract convention difference, not an
//     inconsistency in any single file.
//
// Value-movement invariants this transaction must satisfy (verified against
// each contract's own helper functions directly, see file headers of
// bonding_curve.ak/lp_escrow.ak):
//   - graduation_funds_left_curve: curve's continuing lovelace = input
//     lovelace - lp_ada; curve's continuing token qty = input token qty -
//     (lp_reserve_tokens + staking_reserve_tokens).
//   - lp_seeding_output_ok / lp_value_received: lp_escrow's continuing
//     lovelace = input lovelace + lp_ada; continuing token qty EXACTLY
//     lp_token_amount (== lp_reserve_tokens, set at genesis — T-Phase3).
//   - curve_own_output_clean / lp_own_output_clean: both continuing outputs
//     capped at 2 native assets (lovelace + at most one token unit) — a
//     zero-quantity token entry must be OMITTED from the assets map
//     entirely (Cardano's real ledger has no explicit-zero multi-asset
//     entries), not included as 0.
//   - vesting has NO value-movement check in StartVesting at all — its
//     continuing output just re-pays the exact same assets already there.
// ============================================================================

import {
  Blockfrost,
  Constr,
  Data,
  Lucid,
  validatorToAddress,
  CML,
} from '@lucid-evolution/lucid';
import type {
  LucidEvolution,
  SpendingValidator,
  UTxO,
  Network as LucidNetwork,
  Assets,
} from '@lucid-evolution/lucid';
import {
  BondingCurveDatumSchema,
  VestingDatumSchema,
  LpEscrowDatumSchema,
  loadValidator,
  type BondingCurveDatumData,
  type VestingDatumData,
  type LpEscrowDatumData,
} from './tier-a-schemas.js';

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/** Same conversion tier-a-curve-submitter.ts's activateCurve() already
 *  proved on real Preprod (T86) — reused verbatim rather than re-derived. */
function extendedHexToBech32PrivateKey(extendedHex: string): string {
  const bytes = fromHex(extendedHex);
  if (bytes.length !== 64) {
    throw new Error(`Expected a 64-byte extended private key (kL||kR), got ${bytes.length} bytes.`);
  }
  return CML.PrivateKey.from_extended_bytes(bytes).to_bech32();
}

/** Cardano's real ledger has no explicit-zero multi-asset entries — a
 *  computed-to-zero token quantity must be dropped from the assets map
 *  entirely, not passed through as 0. */
function pruneZero(assets: Assets): Assets {
  const out: Assets = {};
  for (const [unit, qty] of Object.entries(assets)) {
    if ((qty as bigint) !== 0n) out[unit] = qty as bigint;
  }
  return out;
}

export interface TierAGraduationConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  bondingCurveScriptCbor: string;
  lpEscrowScriptCbor: string;
  vestingScriptCbor: string;
  launchIdHex: string;
}

export class TierAGraduationSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private bondingCurveValidator: SpendingValidator;
  private lpEscrowValidator: SpendingValidator;
  private vestingValidator: SpendingValidator;
  private bondingCurveAddress: string;
  private lpEscrowAddress: string;
  private vestingAddress: string;

  constructor(private config: TierAGraduationConfig) {
    this.bondingCurveValidator = { type: 'PlutusV3', script: config.bondingCurveScriptCbor };
    this.lpEscrowValidator = { type: 'PlutusV3', script: config.lpEscrowScriptCbor };
    this.vestingValidator = { type: 'PlutusV3', script: config.vestingScriptCbor };
    this.bondingCurveAddress = validatorToAddress(config.network, this.bondingCurveValidator);
    this.lpEscrowAddress = validatorToAddress(config.network, this.lpEscrowValidator);
    this.vestingAddress = validatorToAddress(config.network, this.vestingValidator);
    this.lucidPromise = Lucid(
      new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId),
      config.network
    );
  }

  private async findUtxo<T extends { launch_id: string }>(
    lucid: LucidEvolution,
    address: string,
    schema: unknown
  ): Promise<{ utxo: UTxO; datum: T }> {
    const utxos = await lucid.utxosAt(address);
    for (const utxo of utxos) {
      if (!utxo.datum) continue;
      try {
        const decoded = Data.from<T>(utxo.datum, schema as never);
        if (decoded.launch_id === this.config.launchIdHex) {
          return { utxo, datum: decoded };
        }
      } catch {
        continue;
      }
    }
    throw new Error(`No UTXO found for launch_id ${this.config.launchIdHex} at ${address}`);
  }

  /**
   * TX1 of the graduation flow — Graduate (bonding_curve) + SealLock
   * (lp_escrow). See file header (T91) for why this is now separate from
   * StartVesting. Independently retriable: safe to call again only if the
   * curve is still Graduated/not-yet-lp_seeded (checked below) — if a prior
   * call already landed on-chain, this throws instead of double-spending.
   *
   * @param lockSealTimestampSeconds  POSIX SECONDS — becomes lp_escrow's
   *   lock_timestamp (real-day-arithmetic field, see file header —
   *   deliberately NOT the same units as ActivateCurve's ms-scale
   *   current_timestamp).
   */
  async graduateAndSealLp(
    governorPrivateKeyExtendedHex: string,
    governorAddress: string,
    lockSealTimestampSeconds: number
  ): Promise<{ txHash: string; lpAda: bigint; lpReserveTokens: bigint; stakingReserveTokens: bigint }> {
    const lucid = await this.lucidPromise;

    const { utxo: curveUtxo, datum: curveDatum } = await this.findUtxo<BondingCurveDatumData>(
      lucid,
      this.bondingCurveAddress,
      BondingCurveDatumSchema
    );
    const { utxo: lpUtxo, datum: lpDatum } = await this.findUtxo<LpEscrowDatumData>(
      lucid,
      this.lpEscrowAddress,
      LpEscrowDatumSchema
    );

    if (curveDatum.curve_state !== 'Graduated') {
      throw new Error(`Curve is not Graduated (state: ${curveDatum.curve_state}) — cannot call Graduate yet.`);
    }
    if (curveDatum.lp_seeded || curveDatum.staking_seeded) {
      throw new Error('Curve already lp_seeded/staking_seeded — Graduate already ran for this launch.');
    }
    if (lpDatum.lock_timestamp !== 0n) {
      throw new Error('lp_escrow already sealed (lock_timestamp != 0) — SealLock already ran for this launch.');
    }

    // T111 fix (2026-07-19, full-suite security audit): total_raised can
    // legitimately go negative or zero after heavy SellTokens (T106)
    // activity before a curve's final buy pushes it to 100% sold — the
    // fixed contract now requires total_raised > 0 as a hard precondition
    // for Graduate (see that redeemer's own doc comment for why a
    // zero/negative-backed "Graduated" LP would be worse than just
    // blocking graduation). Fail fast here with a clear message rather
    // than building a transaction the contract will reject.
    if (curveDatum.total_raised <= 0n) {
      throw new Error(
        `total_raised (${curveDatum.total_raised}) is not positive — Graduate requires real, positive backing for the LP (T111). This curve likely saw heavy net selling before reaching 100% sold.`
      );
    }
    const lpAda = curveDatum.total_raised;
    const tokensLeaving = curveDatum.lp_reserve_tokens + curveDatum.staking_reserve_tokens;
    const tokenUnit = curveDatum.token_policy_id + curveDatum.token_asset_name;

    // ---- bonding_curve's own continuing output (Graduate) ----
    const newCurveAssets = pruneZero({
      lovelace: (curveUtxo.assets.lovelace ?? 0n) - lpAda,
      [tokenUnit]: (curveUtxo.assets[tokenUnit] ?? 0n) - tokensLeaving,
    });
    const newCurveDatum: BondingCurveDatumData = {
      ...curveDatum,
      total_raised: 0n,
      lp_seeded: true,
      staking_seeded: true,
    };

    // ---- lp_escrow's own continuing output (SealLock) ----
    const newLpAssets = pruneZero({
      lovelace: (lpUtxo.assets.lovelace ?? 0n) + lpAda,
      [tokenUnit]: lpDatum.lp_token_amount,
    });
    const newLpDatum: LpEscrowDatumData = {
      ...lpDatum,
      lock_timestamp: BigInt(lockSealTimestampSeconds),
      lp_state: 'Locked',
    };

    // Redeemer constructor indices — read directly from each contract's own
    // `pub type ...Redeemer { ... }` declaration order (not the match-arm
    // order, which happens to match here but isn't the source of truth):
    //   BondingCurveRedeemer: Graduate is variant 9 of 13 (bare, no fields;
    //   T111 — shifted from 8, see tier-a-curve-submitter.ts's
    //   ExpireCurve comment for why).
    //   LpEscrowRedeemer: SealLock is variant 0 of 9.
    const graduateRedeemer = new Constr(9, []);
    const sealLockRedeemer = new Constr(0, [BigInt(lockSealTimestampSeconds), lpAda]);

    const bech32Key = extendedHexToBech32PrivateKey(governorPrivateKeyExtendedHex);
    const governorUtxos = await lucid.utxosAt(governorAddress);
    lucid.selectWallet.fromAddress(governorAddress, governorUtxos);

    const tx = await lucid
      .newTx()
      .collectFrom([curveUtxo], Data.to(graduateRedeemer))
      .collectFrom([lpUtxo], Data.to(sealLockRedeemer))
      .attach.SpendingValidator(this.bondingCurveValidator)
      .attach.SpendingValidator(this.lpEscrowValidator)
      .pay.ToContract(
        this.bondingCurveAddress,
        { kind: 'inline', value: Data.to<BondingCurveDatumData>(newCurveDatum, BondingCurveDatumSchema) },
        newCurveAssets
      )
      .pay.ToContract(
        this.lpEscrowAddress,
        { kind: 'inline', value: Data.to<LpEscrowDatumData>(newLpDatum, LpEscrowDatumSchema) },
        newLpAssets
      )
      .addSigner(governorAddress)
      // Multi-script (2 different Plutus validators in one tx) — forcing
      // provider (Blockfrost) evaluation instead of the local WASM/Aiken
      // evaluator, same reasoning as before (rule out a local-evaluator-
      // specific issue with multiple distinct scripts in one transaction).
      .complete({ localUPLCEval: false });

    const signed = await tx.sign.withPrivateKey(bech32Key).complete();
    const txHash = await signed.submit();

    return {
      txHash,
      lpAda,
      lpReserveTokens: curveDatum.lp_reserve_tokens,
      stakingReserveTokens: curveDatum.staking_reserve_tokens,
    };
  }

  /**
   * TX2 of the graduation flow — StartVesting (vesting.ak). Fully
   * independent of Graduate/SealLock (verified — see file header), so this
   * can be called any time after mint, and independently retried if it
   * fails without needing to touch the curve/lp_escrow state at all.
   *
   * @param vestStartTimestampSeconds  POSIX SECONDS.
   */
  async startVesting(
    governorPrivateKeyExtendedHex: string,
    governorAddress: string,
    vestStartTimestampSeconds: number
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;

    const { utxo: vestingUtxo, datum: vestingDatum } = await this.findUtxo<VestingDatumData>(
      lucid,
      this.vestingAddress,
      VestingDatumSchema
    );

    if (vestingDatum.vesting_state !== 'NotStarted') {
      throw new Error(`Vesting is not NotStarted (state: ${vestingDatum.vesting_state}) — StartVesting already ran.`);
    }

    const newVestingDatum: VestingDatumData = {
      ...vestingDatum,
      vesting_state: 'Vesting',
      vest_start_timestamp: BigInt(vestStartTimestampSeconds),
    };

    // VestingRedeemer: StartVesting is variant 0 of 8 (T111 -- ClaimCancelledAllocation added since this count was first written).
    const startVestingRedeemer = new Constr(0, [BigInt(vestStartTimestampSeconds)]);

    const bech32Key = extendedHexToBech32PrivateKey(governorPrivateKeyExtendedHex);
    const governorUtxos = await lucid.utxosAt(governorAddress);
    lucid.selectWallet.fromAddress(governorAddress, governorUtxos);

    const tx = await lucid
      .newTx()
      .collectFrom([vestingUtxo], Data.to(startVestingRedeemer))
      .attach.SpendingValidator(this.vestingValidator)
      .pay.ToContract(
        this.vestingAddress,
        { kind: 'inline', value: Data.to<VestingDatumData>(newVestingDatum, VestingDatumSchema) },
        vestingUtxo.assets
      )
      .addSigner(governorAddress)
      .complete();

    const signed = await tx.sign.withPrivateKey(bech32Key).complete();
    const txHash = await signed.submit();

    return { txHash };
  }

  /**
   * Convenience wrapper: runs graduateAndSealLp() then startVesting() in
   * sequence, waiting for TX1 to confirm before building TX2 so TX2's fee/
   * collateral UTXO selection sees real post-TX1 governor state. If TX2
   * fails, TX1's hash is NOT lost — it's included in the thrown error so a
   * caller can tell graduation already landed and only StartVesting needs a
   * retry (via startVesting() directly).
   *
   * @param lockSealTimestampSeconds  POSIX SECONDS — used for both
   *   lp_escrow's lock_timestamp and vesting's vest_start_timestamp.
   */
  async graduate(
    governorPrivateKeyExtendedHex: string,
    governorAddress: string,
    lockSealTimestampSeconds: number
  ): Promise<{
    graduateSealLockTxHash: string;
    startVestingTxHash: string;
    lpAda: bigint;
    lpReserveTokens: bigint;
    stakingReserveTokens: bigint;
  }> {
    const lucid = await this.lucidPromise;

    const step1 = await this.graduateAndSealLp(
      governorPrivateKeyExtendedHex,
      governorAddress,
      lockSealTimestampSeconds
    );

    await lucid.awaitTx(step1.txHash);

    let step2TxHash: string;
    try {
      const step2 = await this.startVesting(
        governorPrivateKeyExtendedHex,
        governorAddress,
        lockSealTimestampSeconds
      );
      step2TxHash = step2.txHash;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `graduateAndSealLp succeeded (txHash: ${step1.txHash}) but startVesting failed: ${message}. ` +
          `Retry with startVesting() directly — do not re-run graduate().`
      );
    }

    return {
      graduateSealLockTxHash: step1.txHash,
      startVestingTxHash: step2TxHash,
      lpAda: step1.lpAda,
      lpReserveTokens: step1.lpReserveTokens,
      stakingReserveTokens: step1.stakingReserveTokens,
    };
  }
}

export { loadValidator };
