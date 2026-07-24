// ============================================================================
// Noctis Protocol — Tier A shared Lucid Evolution Data schemas
// ============================================================================
// Single source of truth for bonding_curve/vesting/lp_escrow's real datum
// shapes, shared by read-tier-a-launch-state.ts (Phase 2, decode) and
// build-tier-a-genesis-datums.ts (Phase 3, encode) — extracted here
// 2026-07-17 specifically to avoid the two ever drifting apart, the same
// class of bug T66 found for real once already in this project (a stale
// plutus.json producing a wrong-shaped transaction).
//
// Every field name/order/constructor-index mirrors contracts/cardano/
// plutus.json's real definitions as of 2026-07-17 (bonding_curve/
// BondingCurveDatum, vesting/VestingDatum, lp_escrow/LpEscrowDatum + their
// *State enums) — not .ak source comments, which can drift. Re-verify
// against a freshly-regenerated plutus.json if any of the 3 .ak files
// change after this date.
//
// Credential fields (lp_escrow_credential, staking_pool_credential, and
// lp_escrow's dex_whitelist/multisig entries) use Lucid Evolution's own
// built-in CredentialSchema — verified positionally compatible with
// Aiken's Credential (VerificationKeyCredential=0, ScriptCredential=1 on
// both sides; CIP-57 titles are never encoded on-chain, only Constr index +
// positional fields matter) — same confirmed-compatible pattern
// darkveil-claim-submitter.ts already established for Tier B.
// ============================================================================

import { Data, CredentialSchema } from '@lucid-evolution/lucid';

export const CurveStateSchema = Data.Enum([
  Data.Literal('Inactive'),
  Data.Literal('Active'),
  Data.Literal('Graduated'),
  Data.Literal('Cancelled'),
]);

export const BondingCurveDatumShape = Data.Object({
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
  per_address_purchases: Data.Array(Data.Tuple([Data.Bytes(), Data.Integer()])),
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
  // T-CTO-ENFORCE + T119 (2026-07-23): added to the on-chain datum after this
  // schema was first written. cto_governance_nft is a PolicyId (bytes).
  cto_governance_credential: CredentialSchema,
  cto_governance_nft: Data.Bytes(),
});
export type BondingCurveDatumData = Data.Static<typeof BondingCurveDatumShape>;
export const BondingCurveDatumSchema = BondingCurveDatumShape as unknown as BondingCurveDatumData;

// Tier B's bonding_curve_tier_b.ak datum is a genuinely different shape
// from Tier A's above (no per_address_purchases; adds identity_purchases/
// dv_allocation_root/dv_claimed for the T46 DarkVeil-claim mechanism) —
// verified directly against BondingCurveTierBDatum's real field order
// before writing this, not assumed from Tier A's shape.
export const BondingCurveTierBDatumShape = Data.Object({
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
  // T-CTO-ENFORCE + T119 (2026-07-23): added to the on-chain datum after this
  // schema was first written. cto_governance_nft is a PolicyId (bytes).
  cto_governance_credential: CredentialSchema,
  cto_governance_nft: Data.Bytes(),
});
export type BondingCurveTierBDatumData = Data.Static<typeof BondingCurveTierBDatumShape>;
export const BondingCurveTierBDatumSchema = BondingCurveTierBDatumShape as unknown as BondingCurveTierBDatumData;

export const VestingStateSchema = Data.Enum([
  Data.Literal('NotStarted'),
  Data.Literal('Vesting'),
  Data.Literal('FullyClaimed'),
  Data.Literal('CTOFrozen'),
  Data.Literal('Cancelled'),
]);

export const VestingDatumShape = Data.Object({
  launch_id: Data.Bytes(),
  creator_pub_key_hash: Data.Bytes(),
  governor_pub_key_hash: Data.Bytes(),
  token_allocation: Data.Integer(),
  vest_days: Data.Integer(),
  vesting_state: VestingStateSchema,
  claimed_tokens: Data.Integer(),
  vest_start_timestamp: Data.Integer(),
  cto_triggered: Data.Boolean(),
  community_treasury_wallet: Data.Bytes(),
  token_policy_id: Data.Bytes(),
  token_asset_name: Data.Bytes(),
  // T-CTO-ENFORCE + T119 (2026-07-23): added after this schema was first
  // written. cto_governance_nft is a PolicyId (bytes);
  // last_claimed_allocation_timestamp starts at 0 at genesis.
  cto_governance_credential: CredentialSchema,
  cto_governance_nft: Data.Bytes(),
  last_claimed_allocation_timestamp: Data.Integer(),
});
export type VestingDatumData = Data.Static<typeof VestingDatumShape>;
export const VestingDatumSchema = VestingDatumShape as unknown as VestingDatumData;

export const LpStateSchema = Data.Enum([
  Data.Literal('Locked'),
  Data.Literal('Migrated'),
  Data.Literal('Cancelled'),
]);

export const LpEscrowDatumShape = Data.Object({
  launch_id: Data.Bytes(),
  lock_timestamp: Data.Integer(),
  lock_duration: Data.Integer(),
  lp_state: LpStateSchema,
  governor_pub_key_hash: Data.Bytes(),
  community_wallet_hash: Data.Bytes(),
  cto_triggered: Data.Boolean(),
  fee_recipient_pub_key_hash: Data.Bytes(),
  dex_whitelist: Data.Array(CredentialSchema),
  multisig_signers: Data.Array(Data.Bytes()),
  multisig_threshold: Data.Integer(),
  pending_dex_change: Data.Nullable(Data.Any()),
  lp_token_policy_id: Data.Bytes(),
  lp_token_name: Data.Bytes(),
  lp_token_amount: Data.Integer(),
  // T-CTO-ENFORCE + T119 (2026-07-23): added after this schema was first
  // written. cto_governance_nft is a PolicyId (bytes).
  cto_governance_credential: CredentialSchema,
  cto_governance_nft: Data.Bytes(),
});
export type LpEscrowDatumData = Data.Static<typeof LpEscrowDatumShape>;
export const LpEscrowDatumSchema = LpEscrowDatumShape as unknown as LpEscrowDatumData;

// staking_pool.ak (T66, shared by Tier A + B — one validator, not tier-
// specific like bonding_curve vs bonding_curve_tier_b). Field order/
// constructor indices verified directly against a freshly-regenerated
// plutus.json's real `definitions` block, not assumed from .ak source
// comments (same discipline this file's own header describes) — StakingDatum:
// Pool=0, Position=1; StakingPoolRedeemer: Unstake=0, ClaimRewards=1,
// TopUpPool=2, PublishRewardRoot=3, QueryState=4 (hardened to always-False
// per T109, never constructed by this submitter).
export const StakingPoolDatumShape = Data.Object({
  launch_id: Data.Bytes(),
  governor_pub_key_hash: Data.Bytes(),
  creator_pub_key_hash: Data.Bytes(),
  token_policy_id: Data.Bytes(),
  token_asset_name: Data.Bytes(),
  reward_root: Data.Bytes(),
  claimed_so_far: Data.Array(Data.Tuple([Data.Bytes(), Data.Integer()])),
});
export type StakingPoolDatumData = Data.Static<typeof StakingPoolDatumShape>;
export const StakingPoolDatumSchema = StakingPoolDatumShape as unknown as StakingPoolDatumData;

export const StakingPositionDatumShape = Data.Object({
  launch_id: Data.Bytes(),
  staker_vkh: Data.Bytes(),
  staked_amount: Data.Integer(),
  stake_timestamp: Data.Integer(),
});
export type StakingPositionDatumData = Data.Static<typeof StakingPositionDatumShape>;
export const StakingPositionDatumSchema = StakingPositionDatumShape as unknown as StakingPositionDatumData;

// StakingDatum wraps the two shapes above — Lucid Evolution's Data.Enum
// requires each variant to be an Object/Tuple/Literal, so this is
// constructed with Data.Object per-variant matching Aiken's own
// single-field-constructor wrapping (Pool(StakingPoolDatum) is Constr 0
// with ONE field, the nested datum — not the nested fields spliced in).
const StakingDatumShape = Data.Enum([
  Data.Object({ Pool: Data.Tuple([StakingPoolDatumShape]) }),
  Data.Object({ Position: Data.Tuple([StakingPositionDatumShape]) }),
]);
export type StakingDatumData = Data.Static<typeof StakingDatumShape>;
export const StakingDatumSchema = StakingDatumShape as unknown as StakingDatumData;

export const MerkleProofStepShape = Data.Object({
  sibling: Data.Bytes(),
  goes_left: Data.Boolean(),
});
export type MerkleProofStepData = Data.Static<typeof MerkleProofStepShape>;

// ============================================================================
// Shared helpers
// ============================================================================

export interface PlutusBlueprintValidator {
  title: string;
  compiledCode: string;
}

export function loadValidator(
  blueprint: { validators: PlutusBlueprintValidator[] },
  title: string
): { type: 'PlutusV3'; script: string } {
  const entry = blueprint.validators.find((v) => v.title === title);
  if (!entry) {
    throw new Error(`Validator "${title}" not found in plutus.json — has the blueprint drifted or not been regenerated?`);
  }
  return { type: 'PlutusV3', script: entry.compiledCode };
}
