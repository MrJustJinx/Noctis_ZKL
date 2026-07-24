# NOCTIS PROTOCOL — CLAUDE INSTRUCTION DOCUMENT
**Version 1 · For use with Claude in VS Code**

---

## HOW TO USE THIS FILE

Place this file as `CLAUDE.md` in the root of your Noctis project repository. The Claude VS Code plugin reads this file automatically and uses it as persistent context across all conversations in the project. Every session starts with the full platform spec loaded — you do not need to re-explain decisions already made.

When starting a new task, refer Claude to the relevant section. Example prompts:
- *"Using the spec in CLAUDE.md, build the DarkVeil registration page component"*
- *"Referring to the fee split in CLAUDE.md, build the revenue dashboard"*
- *"The treasury PSM spec is in CLAUDE.md — scaffold the contract interface"*

---

## PROJECT OVERVIEW

**Platform name:** Noctis 
**Tagline:** They can't front-run what they can't see. 
**Type:** Token launchpad — competitor to snek.fun on Cardano 
**Chains:** Cardano L1 (public) + Midnight Network (private execution) 
**Status:** Design complete. Moving to build phase. 
**Version:** Whitepaper v1 / Spec v1 

Noctis is a three-tier token launchpad. Tier A is a standard public launch on Cardano L1. Tier B adds a private buying phase (DarkVeil) powered by Midnight Network — the token and LP live on Cardano. Tier C is fully Midnight-native: the token, bonding curve, DarkVeil phase, and LP all live on Midnight; Cardano is only used for the ZK anchor certificate.

There is **no platform token**. Revenue flows in ADA and NIGHT only.

---

## TECH STACK (RECOMMENDED — NOT YET CONFIRMED)

> ⚠️ **OPEN ISSUE [T1]:** Final tech stack has not been confirmed. The recommendations below are based on the Cardano + Midnight ecosystem. Confirm each before scaffolding.

### Frontend
- **Framework:** Next.js 14+ (App Router)
- **Styling:** Tailwind CSS
- **Wallet connection:** `@meshsdk/react` (supports Eternl, Lace, Daedalus, Nami)
- **State management:** Zustand or Jotai
- **Charts/data:** Recharts
- **Theme:** Pure black `#000000` background, blue `#0000FE` / `#3366FF` accents, white text

### Cardano L1 (Smart Contracts)
- **Language:** Aiken (recommended) or Plutus V3
- **Indexer:** Blockfrost API (primary), Maestro or Koios as fallback
- **Price oracle:** Orcfax (ADA/USD only — no NIGHT feed on mainnet, see ORACLE STRATEGY), Minswap (NIGHT/ADA, TWAP computed client-side)
- **DEX integration:** CSwap (primary graduation DEX), Minswap, Splash, Spectrum (migration whitelist)

### Midnight Network (PSM Contracts)
- **Language:** Compact (Midnight's native language)
- **Framework:** Midnight SDK
- **ZK proofs:** Generated client-side by wallet software using Midnight proof generation libraries

> ⚠️ **OPEN ISSUE [T2]:** Cross-PSM atomicity between DarkVeil PSM and Bonding Curve PSM requires confirmation from Midnight engineering before finalising contract architecture. Specifically: does Midnight guarantee atomic state commitment across two separate PSM instances within the same transaction or block? If YES — settlement window can be minimal. If NO — a 10-minute settlement window must be built in between DarkVeil close and public curve open. Default to 10-minute window in all code until confirmed. **Confirmed 2026-07-09 at the SDK level:** `@midnight-ntwrk/midnight-js-contracts`'s only transaction-batching primitive (`withContractScopedTransaction`) is parameterized by a single contract type and cannot batch calls across two different PSMs — the 10-minute settlement window isn't just a conservative default, it's currently the only implementable option regardless of what Midnight engineering eventually confirms at the protocol level. This is also why Tier B's public bonding curve moved to Cardano/Aiken entirely (T24) rather than staying a second Midnight PSM needing this same cross-PSM handoff.

---

## PLATFORM CONSTANTS

These values are confirmed and should be treated as constants throughout the codebase.

```
TOTAL_SUPPLY = 1_000_000_000 // 1B tokens, hard cap
LP_RESERVE_PCT = 15 // % of total supply, platform-fixed
CREATOR_ALLOC_MAX = 10 // % max, platform-enforced
CREATOR_ALLOC_REC = 5..8 // % recommended range
DV_ALLOC_DEFAULT = 15 // % DarkVeil allocation, creator-adjustable
DV_ALLOC_MIN = 10 // % minimum
DV_ALLOC_MAX = 20 // % maximum
WALLET_CAP_PCT = 5 // % per-wallet cap across DV + public combined
NIGHT_BOND_USD = 50 // USD worth of NIGHT required for DV registration
WALLET_AGE_DAYS = 90 // Minimum wallet age for DV registration
DV_REGISTRATION_HRS = 48 // Registration window duration
DV_FREEZE_HRS = 2 // Hours before DV open that registration freezes
DV_BUYING_HRS = 24 // DarkVeil buying window duration
MIN_DV_PARTICIPANTS = 15 // Minimum absolute registrant count before buying opens (T37, 2026-07-13) — below this, DarkVeil cancels and the launch falls back to public-only
SETTLEMENT_WINDOW = 10 // Minutes between DV close and public curve open (default — see OPEN ISSUE T2)
MAX_CURVE_DURATION_DAYS = 90 // Max days a bonding curve can sit Active without reaching Graduated before anyone can force-cancel it (default — see OPEN ISSUE T29)
VESTING_MIN_DAYS = 90 // Minimum creator vesting
VESTING_MAX_DAYS = 365 // Maximum creator vesting
STAKING_ALLOC_PCT = 25 // % of total supply, optional per-launch toggle (T66, 2026-07-14) — fixed, not a creator-adjustable range
STAKING_DURATION_MIN_DAYS = 1095 // Minimum staking pool runway (3 years) — creator must actively select, no default
STAKING_DURATION_MAX_DAYS = 1825 // Maximum staking pool runway (5 years)
STAKING_BONDING_PERIOD_DAYS = 7 // A newly-staked position earns nothing until seasoned this long — anti-gaming, enforced off-chain via the governor's snapshot formula
STAKING_CLAIM_FEE_USD = 1 // Flat USD fee to claim accrued rewards — ADA (Tier A/B) or NIGHT (Tier C) at oracle spot price
STAKING_CLAIM_FEE_OPS_PCT = 40 // Ops wallet share of the claim fee (%) — same ratio as the launch fee split
STAKING_CLAIM_FEE_TREASURY_PCT = 60 // Treasury share of the claim fee (%)
LP_LOCK_DAYS = 365 // LP escrow lock duration
LP_MIGRATION_COOLDOWN= 90 // Days between LP migrations
CTO_MIN_DAYS_POSTGRD = 30 // Minimum days post-graduation before CTO vote
CTO_VOTE_WINDOW_HRS = 72 // CTO ballot window
CTO_QUORUM_PCT = 5 // % of total supply required to reach quorum
CTO_COOLDOWN_DAYS = 90 // Cooldown after any CTO vote
SILENCE_LOCK_DAYS = 90 // Creator silence before CTO can claim escrow
SILENCE_REMINDER_1 = 60 // Day of first reminder
SILENCE_REMINDER_2 = 80 // Day of final reminder
EMERGENCY_EXIT_DAYS = 180 // Platform unreachability before emergency exit
ORACLE_DIVERGENCE_MAX= 5 // % max divergence between Orcfax and Minswap TWAP
ORACLE_STALENESS_MIN = 10 // Minutes before Orcfax datum considered stale
NHOP_CHALLENGE_BOND = 25 // ADA bond for N-hop challenge submission
NHOP_MAX_HOPS = 5 // Maximum hops in N-hop challenge path
NHOP_LOOKBACK_DAYS = 180 // N-hop lookback window
NHOP_WINDOW_HRS = 72 // Challenge submission window after registration
NHOP_DEFENCE_HRS = 24 // Registrant defence window after challenge
SOCIAL_MIN_AGE_DAYS = 30 // Minimum age of project social accounts
TIER_A_FEE_USD = 10 // Tier A launch fee (USD — paid in ADA or NIGHT equiv. at market rate)
TIER_B_FEE_USD = 30 // Tier B launch fee (USD — paid in ADA or NIGHT equiv. at market rate)
TIER_C_FEE_USD = 50 // Tier C launch fee (USD — paid in ADA or NIGHT equiv. at market rate)
TIER_A_OPS_PCT = 40 // Ops wallet share of Tier A fee (%) — constant across tiers
TIER_A_TREASURY_PCT = 60 // Treasury share of Tier A fee (%) — constant across tiers
TIER_B_OPS_PCT = 40 // Ops wallet share of Tier B fee (%) — constant across tiers
TIER_B_TREASURY_PCT = 60 // Treasury share of Tier B fee (%) — constant across tiers
TIER_C_OPS_PCT = 40 // Ops wallet share of Tier C fee (%) — constant across tiers
TIER_C_TREASURY_PCT = 60 // Treasury share of Tier C fee (%) — constant across tiers
// NOTE: Launch fees are USD-denominated and accepted in ADA or NIGHT at the oracle spot price
// at time of launch creation. Tier C trade fees are denominated in NIGHT (not ADA). See T19.
```

---

## FEE SPLIT (2.0% TOTAL TRADE FEE)

The fee split percentage is the same across all tiers. The **denomination differs** for Tier C.

| Recipient | % of Trade | Tier A/B currency | Tier C currency | Notes |
|-----------|-----------|-------------------|-----------------|-------|
| Creator Fee Escrow | 1.0% | ADA | NIGHT | Monthly release via Midnight PSM |
| Platform Treasury | 0.6% | Stablecoin (USDM, T14) | NIGHT → Stablecoin | Tier C: NIGHT converted to stablecoin at Treasury PSM [T19] |
| Ops Wallet | 0.4% | ADA | NIGHT | Tier C: ops receives NIGHT; already holds NIGHT for DUST — net simpler |
| **TOTAL** | **2.0%** | | | |

**Fee split verification:** 1.0 + 0.6 + 0.4 = 2.0 ✓

**Tier A/B:** The ops wallet allocation covers team operational costs and funds periodic NIGHT purchases to maintain sufficient DUST. The platform treasury accumulates stablecoins — **confirmed 2026-07-10: USDM** (native Cardano stablecoin, no bridge risk — was already the documented default pending confirmation). No contract change needed: `treasury.compact` treats stablecoin conversion generically (an off-chain swap step), same "no code change needed" status as T23/T26. Still genuinely open, narrower than the stablecoin choice itself: the exact DEX swap mechanism from ADA → USDM, custody wallet format, and on-chain disclosure format — operational deployment details, not filed as their own T-number yet.

**Tier C:** All fees arrive in NIGHT. The Treasury PSM must convert NIGHT → stablecoin on a schedule. The conversion mechanism and minimum batch size are open issues [T19]. The ops wallet receives NIGHT directly — this is the same asset it already needs for DUST, which simplifies the ops cycle.

---

## THREE LAUNCH OPTIONS

Creators choose one of three tiers at launch creation. The choice is permanent — a launch cannot change tier after it goes live.

| | Tier A | Tier B | Tier C |
|---|---|---|---|
| **Name** | Cardano Only | Cardano + DarkVeil | Midnight + DarkVeil |
| **Launch fee** | $10 (ADA or NIGHT equiv.) | $30 (ADA or NIGHT equiv.) | $50 (ADA or NIGHT equiv.) |
| **Token lives on** | Cardano L1 | Cardano L1 | Midnight Network |
| **DarkVeil phase** | No | Yes | Yes |
| **Bonding curve** | Cardano L1 | Cardano L1 *(public phase; DarkVeil phase stays on Midnight — see T24)* | Midnight PSM |
| **Curve type** | Linear | Quadratic | Quadratic |
| **Trade currency** | ADA | ADA | NIGHT |
| **LP graduates to** | CSwap / Cardano DEX | CSwap / Cardano DEX | Midnight DEX (TBD) |
| **Whale cap** | 5% per address (weak) | 5% per ZK identity (strong) | 5% per ZK identity (strong) |
| **Cardano wallet required** | Yes | Yes | Yes (for DV eligibility proof) |
| **Midnight wallet required** | No | Yes (DV phase only) | Yes (full launch) |
| **Privacy level** | None — all buys public | High — DV private; curve state visible, identities hidden | Maximum — all activity on Midnight |

### Tier A — Cardano Only
- Launch fee: **$10 USD** (paid in ADA or NIGHT equivalent; ~40% → ops, ~60% → treasury)
- Chain: Cardano L1 only
- Curve: Linear (P = P₀ + k·x)
- Cap: 5% per address (weaker — whale can split wallets)
- No DarkVeil phase
- No Midnight dependency

### Tier B — Cardano + DarkVeil
- Launch fee: **$30 USD** (paid in ADA or NIGHT equivalent; ~40% → ops, ~60% → treasury)
- Chains: Midnight (DarkVeil registration + private buying only) + Cardano L1 (public bonding curve + anchor + escrow + LP)
- Token: Cardano native asset
- Curve: Quadratic public phase (P = P₀ + k·x²), flat P₀ during DarkVeil; priced in ADA
- **Public bonding curve runs on Cardano L1, not Midnight** (T24 resolution, 2026-07-09 — see `contracts/cardano/bonding_curve_tier_b.ak`). The public phase is public information by definition — nothing about price, amounts, or cap status needs Midnight's privacy once DarkVeil closes, and Cardano can already enforce real quadratic-curve payment natively (same pattern as Tier A). Only DarkVeil's private registration/buying phase stays on Midnight. Public-phase tokens mint directly to buyers as they buy, no separate distribution step.
- Cap: 5% per ZK identity (strong — stake key + graph checks) — the cumulative cap carries across DarkVeil and the public phase, tracked in one running list on the Cardano curve that starts EMPTY at deploy and only gains an entry once a specific wallet actually transacts (claims its DarkVeil allocation or buys publicly) — see T46 resolution below, not a deploy-time pre-seed of every registrant.
- Includes DarkVeil private phase — a buyer's private Midnight purchase is settled for real (paid for in ADA, tokens delivered) via a dedicated Cardano claim after DarkVeil closes; see T46 resolution below for the full mechanism.
- LP graduates to CSwap (or whitelisted Cardano DEX)
- All Midnight-side user gas (DarkVeil registration/buying only) paid by platform DUST — the public curve and the DarkVeil claim are both normal Cardano transactions, no DUST involved
- **Resolved (T46, 2026-07-11 — supersedes the T45 note below):** ALL Tier B creator fees — both the DarkVeil claim and public buys — now accrue in one place: the Cardano curve contract's own balance. The original T45 "Stream A1 (Midnight) / Stream A2 (Cardano)" split described an aspirational Stream A1 that never mechanically existed for Tier B (Compact could never enforce the ADA payment it would have required). See the CREATOR FEE ESCROW section for the corrected convention.

### Tier C — Midnight + DarkVeil
- Launch fee: **$50 USD** (paid in ADA or NIGHT equivalent; ~40% → ops, ~60% → treasury)
- Chain: Midnight Network only (DV + bonding curve + LP); Cardano L1 used only for ZK anchor
- Token: Midnight-native asset — does NOT exist on Cardano L1 unless creator bridges post-launch
- Curve: Quadratic public phase (P = P₀ + k·x²), flat P₀ during DarkVeil; **priced in NIGHT** (not ADA)
- Cap: 5% per ZK identity (same checks as Tier B — Cardano wallet age proof still required for DV eligibility)
- Includes DarkVeil private phase (NIGHT bonds, same 48h/24h sequence)
- Graduation: to Midnight DEX — **BLOCKER: no established Midnight DEX yet, see [T18]**
- LP: Midnight LP Escrow PSM (365-day lock equivalent; no Cardano LP Escrow contract)
- ZK Fair Launch Certificate: still anchored on Cardano L1 via a relayer/oracle for public trust
- Platform pays all user DUST — higher per-launch DUST budget than Tier B (entire curve on Midnight)
- **Privacy level:** Maximum. Buys, LP position, and token ownership all on Midnight private execution.

> ⚠️ **Tier C is design-complete but build-blocked pending resolution of [T17], [T18], [T19], and [T20].** Do not scaffold Tier C contracts until those issues are resolved. Tier A and B are unaffected.

---

## DARKVEIL FULL SPECIFICATION

DarkVeil is used by both Tier B and Tier C. The sequence and eligibility rules are identical. The only differences are noted inline.

### Sequence (fixed, unalterable by creator)
1. `T - 48h` — Registration opens
2. `T - 2h` — Registration freezes; base_slot = dv_supply / registered_count; cap applied
3. `T + 0` — DarkVeil 24h buying window opens at flat P₀
 - Tier B: P₀ denominated in ADA/token
 - Tier C: P₀ denominated in NIGHT/token
4. `T + 24h` — DarkVeil closes; settlement phase begins
5. `T + 24h + settlement` — NIGHT returns processed; ZK cert anchored on Cardano L1; curve opens
 - Tier B: Cardano public bonding curve opens
 - Tier C: Midnight bonding curve opens (priced in NIGHT)

> **T37 resolution (2026-07-13):** step 2's registration freeze now enforces a real minimum — `registered_count` must reach `MIN_DV_PARTICIPANTS` (15) before buying can open, or the governor must cancel DarkVeil instead (existing T22 failure path, fully refundable). This closes two griefing vectors a percentage-only check couldn't: (a) a creator's associates registering as ghosts to dilute `base_slot` for legitimate buyers, and (b) an attacker cheaply registering a majority of a tiny launch's participants purely to force DarkVeil to fail (bonds are refunded on failure, so the only real cost is gas). Enforced on-chain — `startBuying` in both `eligibility_gate.compact` (Tier B) and `bonding_curve.compact` (Tier C) rejects the Registration → Buying transition below the floor, a deploy-time `minDvParticipants` ledger field set from this constant. 6 new tests (3 per contract) pass; 193/193 total Compact tests pass (was 187).

### Registration Eligibility (all three required)
1. Wallet age ≥ 90 days on Cardano
2. NIGHT balance ≥ $50 USD at registration block (Minswap NIGHT/ADA TWAP × Orcfax ADA/USD — see ORACLE STRATEGY) — built 2026-07-13, blocked only on a confirmed mainnet Orcfax address, see [T65]
3. Registrant ≠ creator fee-paying wallet address
4. Registrant stake key ≠ creator stake key
5. No direct ADA flow from creator wallet in 90-day lookback

> **Architecture correction (T65, 2026-07-12):** checks #1 and #2 were previously described as verified via "a ZK proof against UTxO history" generated client-side. This isn't achievable with real Midnight capabilities — Compact has no cross-contract call mechanism (T2) and no bridge exists that lets a Midnight circuit read Cardano chain state (T19); a Midnight circuit cannot independently verify a claim about Cardano transaction history in zero-knowledge. Building check #1 for real (T65) confirmed this: it's implemented as an off-chain check (`integration/eligibility-checker.ts`'s `checkWalletAge`, querying Blockfrost directly), the same off-chain-computed-then-allowlist-gated pattern checks #1/#4/#5 all actually use. The real privacy mechanism is: the platform computes checks #1/#3/#4/#5 off-chain for every applicant (check #2 is the one remaining piece — see [T65]), only eligible wallets get a leaf in a Merkle tree, and the governor publishes just the tree's root. `verifyAllowlist`'s ZK proof genuinely proves *membership* in that published tree without revealing which leaf — but it does not, and cannot, independently re-verify wallet age, stake key, or NIGHT balance itself. This is the same trust model already used for `cto_governance.compact`'s balance-snapshot tree (a governor-published root, ZK-proven membership) — trust the governor's off-chain computation, not a false claim of trustless cross-chain verification. `eligibility_gate.compact`'s own PRIVACY ANALYSIS section already described this correctly; only this section's language was wrong.

> **T32 implementation status (2026-07-10):** check #3 is now implemented everywhere it applies — `eligibility_gate.compact`'s `registerForDarkVeil` (Tier B), `darkveil.compact`'s `revealBuyCommit` (Tier B), and `bonding_curve.compact`'s `registerForDarkVeil`/`revealBuyCommit`/`buyTokens` (Tier C, merged contract). Each contract now takes a `creatorPubKey` at deploy time and rejects a caller whose derived identity matches it. The same fix also closed a related, previously-undiscovered gap: Tier A/B's public curve `buyTokens` (Cardano/Aiken) never actually blocked the creator from buying their own curve either (wash-trading to force last-mile 100% sell-through) — fixed in the same pass.

> **T8 resolution (2026-07-13):** check #4 (stake key match) is now implemented — `integration/eligibility-checker.ts`'s `checkStakeKeyMatch`, comparing the `stake_address` Blockfrost decodes directly from the registrant's and creator's addresses (no signature needed; a Cardano base address encodes its stake credential in its own bytes). No contract change was needed — like checks #1/#5, this runs off-chain before the allowlist Merkle tree is built, so a registrant who fails it simply never gets a leaf. See [T8] below for why this was previously (incorrectly) thought to need real cross-chain proof machinery. Check #5 resolved the same way in the same file (`checkNoDirectAdaFlow`).

### NIGHT Bond Return Formula
```
NIGHT_returned = NIGHT_bonded × (tokens_purchased / tokens_allocated)
```
- Bought 100% of allocation → 100% NIGHT returned
- Bought 50% of allocation → 50% returned, 50% forfeited — split 60% treasury / 40% ops (T33, matches the D5 launch-fee-split ratio)
- Bought 0% (ghost) → 100% forfeited — split 60% treasury / 40% ops
- Phase failed (<50% participation) → 100% returned to all (no forfeiture — nothing to split)

> **T43/T33 implementation status (2026-07-10):** implemented for Tier C. `tokens_allocated` is `baseSlot` (the flat `dv_supply / registered_count` per-registrant allocation, set once by `closeDarkVeil`) and `tokens_purchased` is `dvTokensPurchased[buyer]` (DarkVeil-only, tracked separately from the buyer's combined balance). `claimRatioBondRefund` verifies a caller-supplied `claimedRefund` is the floor of the true value (same cross-multiplication pattern as `verifyPrice`/`verifyFeeSlice`, since Compact can't divide in-circuit) and pays out via `sendUnshielded`. The "phase failed → 100% returned to all" case is the pre-existing `claimBondRefund` circuit (also pays out for real, not just clears the ledger). **Forfeited-portion routing (T33, resolved 2026-07-10):** the same `claimRatioBondRefund` call now also pays the forfeited remainder (`bondAmount - claimedRefund`) directly to fixed treasury/ops addresses set at deploy, split 60/40 — no cross-contract call into `treasury.compact` needed, since `sendUnshielded` can target a real unshielded address directly regardless of which contract holds the funds. This is a different, simpler mechanism than the "relayer/governor-sweep" pattern used elsewhere for cross-contract-call limitations (T2/T25) — it works here specifically because the payout destinations are known, fixed real addresses, not another contract's circuit that needs to be invoked. Tier B unaffected — its DarkVeil bond mechanics don't route through this contract.

### ZK Fair Launch Certificate (anchored on Cardano L1)
Public after close:
- Creator wallet purchased 0 tokens during DarkVeil ✓
- No single wallet exceeded 5% cap ✓
- Total raised (ADA for Tier B; NIGHT for Tier C)
- Total tokens distributed
- Total NIGHT returned / forfeited
- Correct open/close timestamps
- Tier indicator (B or C)

Private forever:
- Individual wallet addresses
- Individual buy amounts

> **Tier C note:** The ZK cert is still anchored on Cardano L1 even though the launch is Midnight-native. A Midnight-to-Cardano relayer/oracle pushes the proof bundle after DarkVeil close. This preserves the public trust and marketing value of the certificate. See open issue [T21].
>
> **Tier B "individual buy amounts" note (T46, 2026-07-11):** between T24/T25 and T46, `bonding_curve_tier_b.ak`'s cap-tracking list was pre-seeded at deploy with every DarkVeil registrant's `(wallet, amount)` pair in plaintext, on Cardano — a direct violation of "Private forever: Individual buy amounts" above, even though the certificate itself never displayed it. T46's fix (Merkle-root allocation + private per-wallet `ClaimDarkVeilTokens`) closes the CARDANO side of this: no wallet's DarkVeil amount is published there unless and until that specific wallet claims, and even then only their own amount is revealed — never the full roster. Keep this invariant in mind before touching `bonding_curve_tier_b.ak`'s cap mechanism again: any redesign that publishes the full registrant list up front reopens this exact gap. **Scope note:** this does not change what's already true on the Midnight side — `revealBuyCommit` necessarily writes the buyer's amount into `eligibility_gate.compact`'s own on-chain ledger state at reveal time (inherent to any commit/reveal scheme; the contract can't enforce the cap or process the purchase otherwise), same as it did before this fix, for both tiers. T46 only stops that amount from being redundantly re-published, up front, for every registrant, on a second chain.

---

## CONTRACT ARCHITECTURE

### Midnight PSMs (Private Execution) — Tiers B and C

> **Bonding Curve PSM scope note (T24, 2026-07-09):** this PSM is **Tier C only** now. Tier B's public bonding curve moved to Cardano/Aiken (`contracts/cardano/bonding_curve_tier_b.ak`) — see the Cardano L1 table below and Tier B's description above. Tier B's DarkVeil phase (registration + private buying) still uses the other Midnight PSMs in this table exactly as before; only the public post-DarkVeil buying phase moved.
>
> **Eligibility Gate and DarkVeil PSMs have two shapes now (T25, 2026-07-10):** Compact has no working cross-contract call mechanism (verified against the real compiler — every call form tested fails with "contract types are not yet implemented"), so the 5% cumulative cap couldn't be enforced by having separate DarkVeil / Eligibility Gate / Bonding Curve PSMs call each other. For **Tier C**, all three are now MERGED into one deployed contract (`contracts/midnight/bonding_curve.compact`, despite the filename) with one shared `cumulativePurchases` ledger — `buyTokens` (public phase) AND `revealBuyCommit` (DarkVeil phase) both check and update the cap atomically against the same map. This also closed a previously-undiscovered gap: `revealBuyCommit` had ZERO payment enforcement for the actual token purchase, now fixed for Tier C via `receiveUnshielded` applied at reveal time (deliberately not submit time — see the contract's file header for the privacy reasoning). For **Tier B**, Eligibility Gate and DarkVeil are merged into one standalone contract (`eligibility_gate.compact`, Phase 2 2026-07-11 — the old standalone `darkveil.compact` was deleted, superseded) — Tier B has no Midnight-side bonding curve to merge with. Do not assume "Eligibility Gate PSM" or "DarkVeil PSM" always means the same deployed contract across tiers.
>
> **T46 resolution (2026-07-11):** Tier B's DarkVeil buy settlement — payment AND token delivery — moved to Cardano entirely, via a new `ClaimDarkVeilTokens` redeemer on `contracts/cardano/bonding_curve_tier_b.ak`. Investigation while designing this fix found the gap was bigger than originally scoped: `revealBuyCommit`'s missing payment check was never going to be fixable in Compact (ADA isn't a Midnight-native token — no bridge exists to move it inside a PSM, confirmed via T19's research), but more importantly, **no mechanism anywhere delivered tokens or charged ADA for a Tier B DarkVeil purchase at all** — the original `identity_purchases` pre-seed only ever fed the 5% cap check, never a real settlement. Fixing this also surfaced and fixed a real privacy violation in the same mechanism: that pre-seed published every registrant's `(wallet, DV-amount)` pair in plaintext on Cardano, directly contradicting the Fair Launch Certificate's "Private forever: Individual wallet addresses, Individual buy amounts" promise. Both are fixed together — see `bonding_curve_tier_b.ak`'s file header for the full mechanism (Merkle-root allocation + private per-wallet claim, nobody's amount visible unless and until that wallet claims). `revealBuyCommit` itself needed no change — it was already correct as a private commit/reveal of intent; it was never going to be the place real ADA changes hands.

| Contract | Used by | Purpose |
|----------|---------|---------|
| DarkVeil PSM | B + C | Registration, NIGHT bonds, private buying, ZK cert generation. Merged into `eligibility_gate.compact` for Tier B (Phase 2, 2026-07-11) and into the Bonding Curve PSM for Tier C (T25) — see notes above. Tier B's actual ADA payment/token delivery for a DV purchase happens on Cardano via `ClaimDarkVeilTokens`, not in this PSM — see T46 resolution above. |
| Bonding Curve PSM | **C only** | Price discovery, fee routing, graduation, cumulative 5% cap enforcement (both DarkVeil and public phases), NIGHT-denominated. Merged with Eligibility Gate + DarkVeil for Tier C (T25) — see note above. Tier B's version of the curve itself is a Cardano contract — see below. |
| Eligibility Gate PSM | B + C | ZK proof verification for all 5 registration checks. Merged with DarkVeil into one Tier B contract (Phase 2, 2026-07-11); merged into the Bonding Curve PSM for Tier C (T25) — see notes above. |
| Creator Fee Escrow PSM | B + C | 1.0% fee accumulation, monthly release, silence lock, CTO redirect. For **Tier B**, this PSM never actually accrued a real ADA fee for the DarkVeil phase — Compact could never enforce that ADA payment (T46), so "Stream A1" as originally described was aspirational, not implemented. With T46's resolution, **all** Tier B creator fees (DarkVeil claim + public buy) now accrue in one place: the Cardano curve contract's own balance (formerly "Stream A2") — see the CREATOR FEE ESCROW section's updated T45/T46 note. Tier C is unaffected — its whole curve stays on Midnight, so this PSM's fee accrual there is real. |
| Vesting PSM | B + C | Creator token cliff, linear release, CTO freeze |
| Treasury PSM | B + C | Fee routing, stablecoin accumulation, DUST delegation |
| Midnight LP Escrow PSM | **C only** | 365-day LP lock on Midnight DEX; equivalent of Cardano LP Escrow but on Midnight — **TBD: depends on Midnight DEX availability [T18]** |
| Midnight Token PSM | **C only** | Manages Midnight-native fungible token issuance and transfers — **TBD: depends on Midnight token standard confirmation [T17]** |
| Staking Rewards Pool PSM | **C only** | Optional per-launch staking pool (T66, 2026-07-14). `contracts/midnight/staking_pool.compact` — reward minting/claiming is real (`mintUnshieldedToken`, confirmed real and executable, 2026-07-14), but "staked amount" is governor-attested off-chain rather than custodied on-chain (Compact has no cross-contract calls to reach `bonding_curve.compact`'s own token ledger); see STAKING REWARDS section |

### Cardano L1 Contracts (Public Record)

| Contract | Used by | Purpose |
|----------|---------|---------|
| ZK Anchor Contract | B + C | Receives and stores ZK proof bundles from Midnight PSMs. For Tier B, the relayer now also anchors a `dv_allocation_root` (a Merkle root over each registrant's private allocation, not a plaintext list — T46, 2026-07-11) so the Cardano bonding curve can verify DarkVeil claims without ever publishing the full registrant roster — see Bonding Curve Contract (Tier B) below. |
| Bonding Curve Contract (Tier A) | **A only** | Linear pricing, weak per-address cap. `contracts/cardano/bonding_curve.ak` |
| Bonding Curve Contract (Tier B) | **B only** | Quadratic pricing, strong ZK-identity cap enforced via a running per-wallet list that starts empty and fills in only as wallets transact (claim their DarkVeil allocation or buy publicly). `contracts/cardano/bonding_curve_tier_b.ak` — see T24, T46 |
| LP Escrow Contract | **A + B** | 1-year LP lock, migration logic, fee routing, no withdraw |
| CTO Governance Contract | **A + B + C** | Vote proposals, private ballot anchoring, pass/fail enforcement |
| Staking Rewards Pool Contract | **A + B** | Optional per-launch staking pool (T66, 2026-07-14). `contracts/cardano/staking_pool.ak` — seeded at graduation alongside LP, governor-published Merkle root for reward claims, no on-chain division; see STAKING REWARDS section |

> **Tier C LP note:** Tier C does not use the Cardano LP Escrow contract. LP permanence is enforced by the Midnight LP Escrow PSM instead. The 365-day lock and no-withdraw invariant apply equally — it is the same policy, different execution environment.

> **Tier A note:** Tier A gets its own LP Escrow Contract and CTO Governance Contract — same invariants as Tier B, just without the Midnight/DarkVeil components. This was a gap in an earlier version of this table (previously read "B only" / "B + C"); the How It Works page has always promised "1-year LP lock at graduation" and "CTO governance protection" as core features on all three tiers, so the table was corrected to match, not the other way around.

### Data Flow — Tier B
```
DarkVeil eligibility (off-chain, T8/T65 — corrected 2026-07-12, see the
Registration Eligibility section above for why):
Platform
 → Blockfrost API (checks #1/#5: wallet age, no direct ADA flow from creator)
 → Off-chain eligibility computation for every applicant — NOT a client-side
 ZK proof; no mechanism exists for a Midnight circuit to verify Cardano
 chain history
 → Governor publishes an allowlist Merkle root on Midnight
 (eligibility_gate.compact) — only eligible wallets get a leaf

DarkVeil phase (Midnight):
User Wallet (Cardano + Midnight)
 → Midnight PSM: registerForDarkVeil — a real ZK proof of MEMBERSHIP in
 the published allowlist tree (not a proof of the underlying eligibility
 facts), execute private DarkVeil registration/buying
 → ZK Proof Bundle + cumulative DarkVeil allocation → Relayer
 → Cardano L1 ZK Anchor Contract (Fair Launch Cert + dv_allocation_root, [T21, T46])
 — the root replaces a plaintext per-registrant list; nobody's amount
 is published unless and until they claim (below)

DarkVeil claim (Cardano, T46 — 2026-07-11):
User Wallet (Cardano)
 → Cardano L1 Bonding Curve Contract, Tier B: ClaimDarkVeilTokens
 — buyer presents their own (dv_amount, salt, merkle_proof), pays the
 flat DarkVeil price in real ADA, receives their tokens; nobody
 else's allocation is ever revealed by this transaction

Public bonding curve phase (Cardano, T24 — 2026-07-09):
User Wallet (Cardano)
 → Cardano L1 Bonding Curve Contract, Tier B (contracts/cardano/bonding_curve_tier_b.ak)
 — cumulative cap list starts empty, gains an entry as each wallet
 transacts (claim above, or a public buy here); tokens mint
 directly to the buyer on every purchase, no separate distribution step
 → Graduation (100% sell-through) → LP deposited to Cardano DEX
```

### Data Flow — Tier C
```
DarkVeil eligibility (off-chain, T8/T65 — same correction as Tier B above):
Platform
 → Blockfrost API (checks #1/#5 against the registrant's Cardano wallet)
 → Off-chain eligibility computation — not a client-side ZK proof of
 Cardano history, no such mechanism exists
 → Governor publishes an allowlist Merkle root on Midnight

User Wallet (Midnight primary; Cardano for DV eligibility only)
 → Midnight PSM (ZK proof of allowlist MEMBERSHIP, execute private logic;
 token minted on Midnight)
 → Midnight LP Escrow PSM (LP locked on Midnight DEX at graduation)
 → ZK Proof Bundle → Relayer → Cardano L1 ZK Anchor Contract [see T21]
```

---

## CREATOR FEE ESCROW — IMPORTANT DISTINCTION

> ⚠️ This is a common source of confusion. Clarify in all code and UI.

**Stream A — Bonding Curve Escrow (pre-graduation only)**
- Accrues: 1.0% of bonding curve trades ONLY
- Closes: When bonding curve graduates (curve closes permanently)
- Amount: Fixed at graduation. Does NOT continue post-graduation.
- Payment: Monthly manual claim, ADA
- Gas: ~0.17 ADA deducted from escrow balance automatically

**Stream B — LP Trading Fees (post-graduation, ongoing)**
- Accrues: CSwap pool trading fees (~0.3% of DEX volume)
- Paid: Directly to fee_recipient, not via escrow
- Continues: Indefinitely while pool has volume
- Redirected to CTO wallet if governance vote passes

These are **two entirely different income mechanisms**. Do not conflate them in the UI.

> **Tier B, T45 resolution SUPERSEDED by T46 (2026-07-11):** T45 (2026-07-10) originally described Stream A splitting into two independently-claimable balances for Tier B — "Stream A1" accruing in the Midnight Creator Fee Escrow PSM for DarkVeil-phase fees, "Stream A2" accruing in the Cardano curve contract for public-phase fees. Investigating T46 (the DarkVeil ADA-payment gap) found that Stream A1 as described was never actually mechanically real for Tier B: Compact cannot receive or send ADA (no bridge exists — confirmed via T19's research), so there was never a working circuit that could have deposited a real ADA fee into that Midnight PSM for a Tier B DarkVeil buy. `eligibility_gate.compact`'s `revealBuyCommit` only ever updated private ledger counters, with zero payment enforcement of any kind.
>
> T46's fix settles Tier B DarkVeil purchases entirely on Cardano instead (a new `ClaimDarkVeilTokens` redeemer on `bonding_curve_tier_b.ak` — see the CONTRACT ARCHITECTURE section's T46 note), which means the 1.0% creator fee on a DarkVeil buy is charged and accrued there too, in the same `creator_fees_accrued` field public buys already use via `BuyTokens`. **There is no longer a Stream A1/A2 split for Tier B — there was never a real Stream A1 to split from.** All Tier B creator fees (DarkVeil claim + public buy) accrue as ONE balance, in `contracts/cardano/bonding_curve_tier_b.ak`, claimed via that contract's single `ClaimCreatorFees` redeemer — the same self-contained "curve contract accrues and gates its own claim" pattern Tier A already uses.
>
> Tier C is unaffected — its whole curve stays on Midnight, so its Stream A fee accrual there is real (Compact can enforce NIGHT payment natively) and stays a single balance. Tier A never had a Stream A1/A2 split to begin with (no DarkVeil phase). Do not build a two-balance fee UI for Tier B going forward — show one Bonding Curve Escrow balance, same as Tier A.

---

## LP ESCROW CONTRACT

### Key Invariants
- `withdraw` does not exist anywhere in the contract. Zero code paths return LP tokens to any wallet.
- `migrate` is only callable after `lock_expiry` (graduation + 365 days)
- Minimum 90 days between migrations
- Migration is atomic: remove from old DEX + deposit to new DEX in one transaction
- During migration, underlying ADA + tokens never appear in any wallet UTxO
- New LP tokens go directly back into escrow after migration

> **T13 resolution (2026-07-10):** a new `HarvestFees` redeemer lets Stream B trading fees reach `fee_recipient` (the creator, or the community wallet once CTO is triggered — same redirect rule as everywhere else) WITHOUT touching the locked LP position, closing the gap between this file's "no `withdraw`, ever" invariant and Stream B's "paid directly to fee_recipient" description — the fee payout has to route through this contract since the LP itself lives here, a script address, not a wallet. **Deliberately DEX-agnostic and narrow:** the redeemer only verifies its OWN two invariants (the locked `lp_token_amount` is byte-for-byte unchanged; the correct recipient actually receives the harvested lovelace in the same transaction) and does not model or verify any specific DEX's real harvest call — that remains genuinely unconfirmed per-DEX (CSwap/Minswap/Splash/Spectrum), the open sub-question T13 always had. Permissionless, same "the invariant is the authorization" idiom as `ExpireCurve`/`ExecuteDexChange`/`Graduate` — nobody can gain anything by calling it incorrectly since the LP position literally cannot move.

### Migration Whitelist (updatable — team multisig + 72h public notice)
- CSwap *(default graduation DEX)*
- Minswap
- Splash
- Spectrum

> **T30 resolution (2026-07-10):** the whitelist was previously described as "hardcoded, immutable" while `lp_escrow.ak`'s own file header already claimed "T30: Option B — multisig + 72h notice" — the header described the intended design, but the actual `AddDex`/`RemoveDex` redeemers only ever required one governor signature with immediate effect. Fixed for real: a new `ProposeDexChange` redeemer requires `multisig_threshold`-of-`multisig_signers` real signatures (the M/N split is a deployment-time choice, not hardcoded) and starts a 72-hour public notice clock; `ExecuteDexChange` applies the change once the notice period has elapsed — permissionless, since the proposal was already public for the full window (same "the deadline is the authorization" pattern as T29's `ExpireCurve`); `CancelPendingDexChange` lets the multisig withdraw a proposal before it takes effect. This is Option B from internal tracking, matching the user's confirmed choice — not yet Option C (on-chain protocol governance vote), which stays the eventual target once T12 governance ships.

### States
```
LOCKED → UNLOCKED (after 365 days)
UNLOCKED → MIGRATING (migrate called)
MIGRATING → UNLOCKED (migration confirmed)
```

---

## CTO GOVERNANCE

### Requirements for a CTO Vote
- Minimum 30 days post-graduation before any proposal
- 72-hour private ballot window via Midnight
- Minimum 5% of total token supply must participate (quorum)
- Yes votes must outnumber no votes
- 90-day cooldown after any vote (pass or fail)

### What a Passed Vote Does (automatically)
1. Creator fee escrow future payments → CTO wallet
2. LP trading fees → CTO wallet
3. Unvested creator tokens → frozen, redirected to community treasury (NOT burned)
4. Already-claimed fees and already-vested tokens: **unaffected**

> **CTO fee-redirect fix (2026-07-12):** item 1 above was previously unenforced everywhere — none of the three bonding curve contracts (`bonding_curve.ak` Tier A, `bonding_curve_tier_b.ak` Tier B, `bonding_curve.compact` Tier C) had any CTO concept at all, so a passed SilenceLockTrigger vote never actually redirected the bonding-curve trade fee, regardless of what `creator_escrow.compact`'s own CTO logic did (it holds no real fees for either tier — see T46's finding). Fixed by adding the same `cto_triggered`/community-wallet pattern `lp_escrow.ak` already used for Stream B (T13) to all three curve contracts: a governor-only `TriggerCTO`/`DissolveCTO` redeemer (or `triggerCTO`/`dissolveCTO` circuit for Tier C), and the creator-fee claim (`ClaimCreatorFees`/`withdrawFees`) now pays out to the community wallet once triggered, the creator otherwise. `integration/midnight-client.ts`'s `executeCtoProposal` now also calls `bondingCurve.triggerCTO` (Tier C only — Tier B's Cardano curve trigger is a separate, off-chain-orchestrated call, not wired into that helper). Item 2 (LP trading fees) was already correctly enforced via `lp_escrow.ak`'s T13 `HarvestFees`.

### Creator Vote Participation
The creator's own token allocation CAN vote in a CTO ballot — it is not excluded — but its weight is capped at `creatorVoteCap` (an absolute token amount, e.g. 2% of total supply, set at deploy). A creator holding more than the cap has any excess weight silently truncated to the cap for that vote; a creator holding less than the cap votes their real weight. Capped creator votes count toward both quorum and the yes/no tally like any other vote, but `creatorYesVotes`/`creatorNoVotes` are tracked as a SEPARATE public field on the proposal, so the community can always see how much of a "pass" or "fail" outcome came from the creator's own vote versus everyone else's.

> **T35 doc-sync note (2026-07-10):** `cto_governance.compact`'s `castVote` circuit has implemented exactly this — capped participation plus separate audit tracking — since T41's same-day fix (both changes shipped together, the `creatorVoteCap` field and its cap-then-track logic are explicitly commented `// T35` in the source). This matches internal tracking's own "Proposed approach" for T35 word for word ("creator tokens are not excluded from voting, but the ZK ballot proof reveals the creator-held token count separately"). internal tracking just never got updated to mark T35 resolved, and this section of CLAUDE.md never documented the decision at all — same pattern as T31's anchor mechanism. Documentation-sync fix only, no code change.

### Anchor Mechanism (who submits the Cardano L1 result)
**Resolved: Option C — open relay.** After the 72-hour Midnight ballot closes, ANY token holder can submit the anchor transaction to `cto_governance.ak` using the signed proof bundle — no special authorization required for that specific redeemer, by design. The contract only checks the proof bundle hash is present and the business rules (quorum, creator vote cap) hold. This avoids Option B's centralization risk (a platform-only relay could suppress or delay a legitimate community takeover by simply not anchoring).
> **T31 doc-sync note (2026-07-10):** `cto_governance.ak`'s own file header already stated "T31 Resolution: Open relay (Option C)" and the contract has fully implemented this since it was written — internal tracking just never got updated to match, and this section of CLAUDE.md never documented the decision at all. This is a documentation-sync fix, not a fresh design decision — the code was already correct.

---

## TEAM REVENUE SOURCES

| Source | Mechanism | Notes |
|--------|-----------|-------|
| Ops Wallet | 40% of the $10/$30/$50 USD launch fee (Tier A/B/C) + 0.4% of trade volume + 40% of forfeited DarkVeil bond NIGHT (Tier C, T33) | Public address, quarterly disclosure; also funds NIGHT purchases for DUST — corrected 2026-07-13, this line previously said "30/80 ADA per launch," a stale figure from before the launch fees were repriced to USD-denominated (see Launch Fee Repricing) |
| NIGHT Holdings | Market appreciation as ops buys NIGHT for DUST | Sellable under exceptional circumstances only |
| Treasury Balance | Accumulates USDM (T14) from 0.6% of trade volume + 60% of forfeited DarkVeil bond NIGHT (Tier C, T33) | Protocol liquidity reserve, not salary account |

### NIGHT Sell Policy (Team-held NIGHT only)
- Protocol treasury NIGHT: **never sold, ever**
- Team-held NIGHT: may be sold under exceptional circumstances only
- Requirements: Full team multi-sig, 72h public notice, max 20% of holdings per event, post-sale on-chain disclosure

### Budget Ceiling: Option C (confirmed)
No hard cap on ops wallet, treasury, or team wallet. All wallets grow naturally. Accountability via public addresses + quarterly spending disclosure.

### Founding NIGHT Reserve (T34 resolution, 2026-07-13)
Before the first Tier B/C launch, the Ops Wallet has no trade-volume income yet (the 0.4% ops slice only exists once launches are trading) but still needs NIGHT on hand to cover DUST for the very first DarkVeil phase. **Source (decided 2026-07-10):** a founder-provided bootstrap reserve, with an external funding route pursued as the eventual replacement. Funding specifics (exact amount, source, and replenishment plan) are deliberately kept in the local-only ops notes rather than this public spec. Funding the bootstrap from the first launch's own fee revenue was rejected outright, not just deprioritized — it's causally circular: the fees that would fund the NIGHT purchase don't exist until after the DV phase they'd need to fund has already happened.

**Sizing (2026-07-13):** T5's real per-transaction DUST cost (`v_fee`) remains genuinely unmeasured — the devnet needed to measure it is a documented environment-level blocker with no ETA (see [T5]). Rather than leave the funding decision stalled indefinitely on that, sized this with published constants and reasoned transaction counts instead of waiting for an exact figure:
- One DV phase's Midnight-side transaction count ≈ `4 × registrants + 4` (registration + buy-commit + reveal + bond-refund-claim per registrant, plus a handful of governor admin calls — the ZK cert anchor itself is a Cardano transaction, not DUST-consuming). At the T37 floor (15 registrants) that's ~64 transactions; a more realistic small launch (~75 registrants) is ~304.
- No real per-transaction DUST cost is published anywhere (checked directly against `docs.midnight.network/concepts/dust-architecture` — confirms the rate/decay/grace-period constants already in this document, nothing more). Bracketed rather than guessed a point value: even under a pessimistic cost assumption (Compact PSM calls costing meaningfully more than a comparable Cardano Plutus script call, itself just a rough order-of-magnitude anchor, not a Midnight-specific fact), a single DV phase is very unlikely to need more than a few hundred NIGHT.
- **Conclusion: the committed bootstrap reserve has substantial margin (likely 10-50x) over any plausible single-DV-phase cost under every scenario considered.** Treating this as confirmed-sufficient now rather than waiting on T5 — revisit only if T5's eventual real measurement produces a number that actually challenges this margin, which the scenario analysis above suggests is unlikely.

**Action:** the founding reserve is live as of this decision. Ongoing replenishment remains a separate, not-yet-executed pursuit — this resolution only covers "is the bootstrap amount enough," not the longer-term funding structure. See the local-only ops notes for amounts and source.

---

## SOCIAL CHANNEL REGISTRATION

### Project Channels (required for silence detection)
| Channel | Status | Min Age | Verified |
|---------|--------|---------|---------|
| Twitter/X | Required (at least one primary) | 30 days | On-chain tx with launch_id hash |
| Discord | Required (at least one primary) | 30 days | On-chain tx with launch_id hash |
| Telegram | Optional | None | Light verification |

### Personal Links (optional, trust signals only)
Twitter/X, Discord, LinkedIn, Telegram, Instagram, TikTok — displayed on launch card, no verification required, not monitored for silence.

### Silence Lock Conditions (BOTH required simultaneously)
1. No monthly fee claim for 90+ consecutive days (on-chain verifiable)
2. No public post on any verified primary project channel for 90+ days (off-chain, community-reported)

### Suspension Grace Period
- Twitter/X account suspended: **30 days** to register alternative or get reinstated

---

## ORACLE STRATEGY

| Oracle | Role | Used for |
|--------|------|---------|
| Orcfax | Primary price oracle | ADA/USD on-chain datum only — no NIGHT feed on mainnet, see correction below |
| Minswap | NIGHT/ADA price source | Real, live NIGHT-ADA pool (~$3.1M liquidity, confirmed 2026-07-13) — no native TWAP endpoint, computed client-side from `pools/:id/price/candlestick` |
| Blockfrost | Chain data API (not oracle) | UTxO history, token balances, delegation records |

> **Correction (2026-07-13, found while building T65 check #2):** this section previously described Orcfax as publishing a direct NIGHT/USD feed, with the price computed as `median(Orcfax_NIGHT_USD, Minswap_TWAP_NIGHT_ADA × Orcfax_ADA_USD)`. Checked against the real, live `orcfax/cer-feeds` GitHub repo's published feed lists: **no NIGHT/USD feed exists anywhere** — not on mainnet, not on ITN. Orcfax does publish a `NIGHT-ADA` feed, but only on the **preview** (testnet) network, not mainnet. `ADA-USD` is real and live on mainnet.
>
> **Real, achievable formula:** `NIGHT_USD = NIGHT_ADA_price × Orcfax_ADA_USD`, where `NIGHT_ADA_price` comes from Minswap's real NIGHT-ADA pool (30-min TWAP, computed client-side — Minswap's API has no native TWAP endpoint, only candlestick/timeseries data to average over). On mainnet today there is only ONE real NIGHT-denominated price source (Minswap) — Orcfax's NIGHT-ADA feed would provide a genuine second, independent source for the divergence check below, but only once it ships to mainnet. Until then, the "Divergence >5%" and "Minswap low liquidity" fallback rules below are aspirational for the NIGHT leg specifically — there's nothing to diverge against yet. The ADA/USD leg is unaffected; Orcfax's real mainnet feed covers it.
>
> This affects every place NIGHT/USD conversion was assumed to already work this way: T65 check #2 (NIGHT balance ≥ $50 USD), T6 (treasury NIGHT mark-to-market), and T19 (Tier C NIGHT fee → stablecoin conversion rate).

**Price calculation:** `NIGHT_USD = Minswap_TWAP_NIGHT_ADA × Orcfax_ADA_USD` (median against Orcfax's own NIGHT-ADA feed once it reaches mainnet — not yet possible)

**Fallback rules:**
- Orcfax ADA/USD stale (>10 min): no current substitute defined — open question, not yet a blocker since Orcfax's ADA/USD feed has been reliably live since Q1 2024
- Minswap low liquidity (<5,000 ADA pool depth): no fallback NIGHT source exists today — would block any NIGHT-USD-dependent check entirely
- Divergence >5%: not yet enforceable for the NIGHT leg (only one real source); still applies once Orcfax's NIGHT-ADA feed reaches mainnet
- Both unavailable >30 min: extend registration window by outage duration

**Blockfrost fallback order:** Blockfrost → Maestro → Koios → self-hosted node

---

## TOKENOMICS REFERENCE

### Graduation
- Requirement: 100% sell-through of bonding curve (no partial graduation)
- Default graduation DEX: CSwap
- Creator can override to any whitelisted DEX at launch configuration

### LP Seeding (at graduation)
- Tokens: 15% of total supply (150M for a 1B token launch)
- ADA: Paired at graduation price (balanced AMM pool)
- Example at grad price 0.0001 ADA/token: 15,000 ADA + 150M tokens (equal value both sides ✓)
- Immediately enters 1-year LP escrow lock

> **T27 resolution (2026-07-10):** LP ADA source — **Option A confirmed**: all net-of-fee ADA remaining in the bonding curve contract at graduation flows into the LP (`LP ADA = total raised × 0.98`, after the 2.0% running fee). Simplest option, matches the whitepaper's worked examples, and avoids needing a separate routing decision for "surplus" ADA the way Option B would have.
>
> **T49 resolution (2026-07-10):** the gap found while resolving T27 — no redeemer anywhere actually moved ADA/tokens from a graduated curve into the LP Escrow contract — is now closed. Both `bonding_curve.ak` and `bonding_curve_tier_b.ak` gained a permissionless `Graduate` redeemer (same "the condition is the authorization" idiom as `ExpireCurve`) that moves `total_raised` ADA and a new `lp_reserve_tokens` balance (15% of supply, held in the curve's own UTXO from deploy alongside the sellable `curve_supply`) to the launch's `lp_escrow_credential`, verified by real value movement, not a claim. `lp_escrow.ak`'s `SealLock` was reworked to match — governor signature replaced with a real value check (`lp_value_received`) — so a graduation transaction validates on evidence from both sides, not trust. Bonus fix found in the process: `BuyTokens` never verified the curve's own token reserve actually shrank on delivery (only that "some output" received tokens) — fixed via a new `curve_token_balance_decreased` check on both curve contracts, since a falsely-inflated `tokens_sold` could otherwise have triggered Graduated without real depletion. 101/101 Cardano contract tests pass. See internal tracking for full detail.

### Vesting
- No tokens release before graduation regardless of elapsed time
- Creator selects 90–365 days at launch creation (no default — forced active selection)
- Release: Linear daily (`total_allocation / vest_days` per day)
- ZK proof published: creator held 0 tokens at DarkVeil open

---

## STAKING REWARDS (OPTIONAL) — T66, confirmed 2026-07-14

An optional, per-launch feature available on all three tiers. At launch creation, a creator may opt to allocate a **fixed 25% of total supply** (`STAKING_ALLOC_PCT`) into a Staking Rewards Pool — in addition to the existing 15% LP reserve, up-to-10% creator allocation, and 10-20% DarkVeil allocation (B/C). Supply math is safe at every allocation's maximum simultaneously: 15 + 10 + 20 + 25 = 70%, leaving ≥30% for the public bonding curve — no overflow risk. If declined, the 25% simply isn't carved out and the public curve absorbs it instead, same as any other unused allocation headroom.

This is a narrower, different thing from T16's platform-wide yield mechanism (still deferred) — see T16's entry above for the distinction.

### Mechanism
1. **Manual staking, not automatic.** Holding the token alone earns nothing. A holder must actively stake through the Noctis platform to participate.
2. **Fixed linear daily emission.** `daily_emission = pool_balance / duration_days`. The creator selects a duration between `STAKING_DURATION_MIN_DAYS` (1095, 3 years) and `STAKING_DURATION_MAX_DAYS` (1825, 5 years) at launch creation — no default, forced active selection, same pattern as vesting.
3. **Pro-rata daily split.** Each day's emission splits among currently-staked holders in proportion to their staked balance.
4. **Bonding period.** A newly-staked position earns nothing for `STAKING_BONDING_PERIOD_DAYS` (7 days) after staking — anti-gaming, prevents stake-right-before-snapshot-then-claim-then-unstake. Enforced entirely off-chain (see Reward Accounting below); no separate on-chain check exists for it.
5. **Claiming.** Claimable from the holder's token profile on the Noctis platform. Costs a flat `STAKING_CLAIM_FEE_USD` ($1) fee, paid in ADA (Tier A/B) or NIGHT (Tier C) at oracle spot price — same USD→ADA/NIGHT conversion machinery as the DarkVeil NIGHT bond (see ORACLE STRATEGY). Fee splits `STAKING_CLAIM_FEE_OPS_PCT`/`STAKING_CLAIM_FEE_TREASURY_PCT` (40/60), matching the launch-fee ratio.
6. **Top-ups.** A creator can add more tokens to an existing pool at any time. A top-up adds to `pool_balance` without changing the daily emission rate — it extends the runway further into the future rather than accelerating payouts. There is no stored duration or end-date on-chain at all (see Reward Accounting) — a top-up is just "add to the balance."

### Reward accounting — off-chain computed, on-chain verified (no in-circuit division anywhere)
Compact has no in-circuit division, and no reward-per-share/accumulator primitive exists anywhere in this codebase. Rather than invent new on-chain division workarounds, this reuses the exact trust model already shipped for `cto_governance.compact`'s balance-snapshot Merkle tree and `eligibility_gate.compact`'s DarkVeil allowlist tree:

- **Staking/unstaking itself is fully trustless on-chain custody for Tier A/B** (Cardano) — a holder deposits/withdraws real tokens into/from their own position; no governor trust needed for custody. **Tier C is different** — see the Tier C tier-specific note below for why real on-chain stake custody isn't currently possible there, and what's governor-attested instead.
- **Reward accounting is governor-computed off-chain**, independently re-derivable by anyone from public, real on-chain stake/unstake events (amounts and timestamps are all public chain data — this is auditable, not a hidden computation). The governor periodically publishes a Merkle root of `(staker_identity, cumulative_accrued_reward_to_date)` leaves.
- **Claims are a ZK-proof-of-membership** against the current published root — the leaf is derived in-circuit from the caller's own identity, not supplied as a free witness (same security-audit discipline already applied to `verifyAllowlist`). The contract pays out `claimed_amount - already_withdrawn[caller]` and updates `already_withdrawn[caller]`, same checks-effects-interactions pattern as `claimBondRefund`.
- **The on-chain contract's only invariant is that cumulative claims never exceed `pool_balance`** — this self-limits depletion without needing any stored duration, end-timestamp, or rate field on-chain. The "3-5 year runway" is entirely an off-chain governor commitment, auditable via the published root sequence over time, not a literal on-chain enforcement.

### Pool seeding
The staking reserve seeds at **graduation**, in the same transaction as LP seeding — extends the existing `Graduate` redeemer (Tier A/B) rather than an earlier activation point. This avoids the edge case of a pre-graduation cancelled curve having already funded a pool for tokens that were never actually distributed.

### Tier-specific notes
- **Tier A / B (Cardano/Aiken):** new `contracts/cardano/staking_pool.ak` — ONE pool-state UTXO per launch (`reward_root`, `claimed_so_far: List<(VerificationKeyHash, Int)>`, real token balance held directly in the UTXO's own value — no separate stored balance field) plus one position UTXO per stake ACTION (`staker_vkh`, `staked_amount`, `stake_timestamp`) — avoids single-UTXO contention for the stake/unstake action specifically. Staking itself needs no validator redeemer at all (creating a script UTXO needs no approval, only spending one does); `Unstake`/`ClaimRewards` are real, permissionless, value-movement-verified redeemers. `bonding_curve.ak`/`bonding_curve_tier_b.ak` gain `staking_enabled: Bool` + `staking_pool_credential: Credential` + `staking_reserve_tokens: Int` datum fields (0/empty if declined) and a `staking_seeding_output_ok` check on `Graduate`, mirroring the existing `lp_seeding_output_ok` check. 6 new tests (3 per curve file), 161/161 Cardano tests total.
- **Tier C (Midnight/Compact):** new `contracts/midnight/staking_pool.compact` — a DIFFERENT design from Tier A/B's real-custody position model, forced by a real architectural constraint discovered while building it (2026-07-14): `bonding_curve.compact` never mints the Tier C launch token as a real Midnight coin — it tracks ownership purely as an internal ledger `balances: Map<Bytes<32>, Uint<128>>` — and Compact still has no cross-contract call mechanism (T2/T25), so a separate `staking_pool.compact` has no way to debit that map. Two independent `midnight-verify` agents (source-investigation against `LFDT-Minokawa/compact@main`, and live compile+execution) confirmed `tokenType`/`mintUnshieldedToken` are real, tested, working stdlib primitives — but that only solves half the problem: minting a *new* coin is real, taking custody of the *existing* launch token balance is not, without merging into `bonding_curve.compact` itself (same fix pattern as T25's original three-way merge). Presented to Jinx as a 3-way choice (merge into `bonding_curve.compact` / governor-attested stake / defer Tier C staking); **confirmed 2026-07-14: governor-attested stake**, over merging into the already-audited 1801-line/46-test `bonding_curve.compact`. Resulting design: `stakeSnapshotRoot` is a governor-published Merkle root over `(stakerKey, stakedAmount)` leaves, attested off-chain from `bonding_curve.compact`'s real public ledger events (same trust model as every other governor-published root on this platform — allowlist membership, CTO voting weight); reward *claiming* is fully real — `claimRewards` mints the payout directly to the staker via `mintUnshieldedToken`, and collects the NIGHT claim fee via `receiveUnshielded`/`sendUnshielded`. Stated plainly: the minted reward is a SEPARATE Midnight-native coin color from `bonding_curve.compact`'s internal launch-token ledger, not literally the same fungible unit — because that contract never minted a real coin for stakers to deposit in the first place. This is building ahead of Tier C's own token foundation, same T17 caveat that already applies to the rest of Tier C's "design-complete but build-blocked" status. 21 new tests, 214/214 total.

---

## OPEN ISSUES — BUILD BLOCKERS AND KNOWN GAPS

> These are the issues that need resolution before or during the build phase. Items marked 🔴 are blockers. Items marked 🟡 are important but not blockers. Items marked 🟢 are deferred post-MVP.

### 🔴 BLOCKER [T2] — Cross-PSM Atomicity
DarkVeil PSM closes and Bonding Curve PSM opens in the same sequence. This assumes Midnight guarantees atomic cross-PSM state commitment. **Must confirm with Midnight engineering before writing contract code.**
- If atomic guaranteed: settlement window can be minimal (ZK proof gen time only)
- If not atomic: 10-minute settlement window is mandatory
- **Default to 10-minute settlement window in all code until confirmed**
- Question to ask: *"Does Midnight's PSM framework guarantee atomic state commitment across two separate PSM instances within the same transaction or block?"*

### 🔴 BLOCKER [T3] — Midnight SDK Availability
Midnight mainnet availability and Compact language tooling maturity needs verification before building PSM contracts. Some features (e.g., cross-PSM state sync) may not yet be available.

### 🟡 IMPORTANT [T4] — Graduation FDV vs DEX FDV Distinction
The graduation FDV (bonding curve clearing price × total supply) is different from the post-graduation DEX market cap. Ensure all UI clearly distinguishes:
- **Grad FDV** = graduation price × 1B tokens (e.g., 100,000 ADA)
- **Current FDV** = DEX spot price × 1B tokens (can be 10× grad FDV after appreciation)

> **T4 resolution (2026-07-10):** already implemented on the live site — checked before treating this as still-open, same discipline as T30/T31/T35. The theme's `lp-chart-buy.php`/`lp-chart-buy-tier-b.php` render both FDV figures as two clearly labeled panels side by side (`GRADUATION FDV` marked "Fixed", `CURRENT FDV` marked "updates live"), and the post-graduation summary correctly shows only the fixed `GRADUATION FDV` while linking out to the DEX for live pricing. No unlabelled FDV figure exists anywhere on the site. Documentation-sync fix only, no code change.

### 🟡 IMPORTANT [T5] — DUST Generation Rate (pending preprod test)
The Ops Wallet purchases NIGHT periodically using ADA from the 0.20% ops slice. DUST is generated from held NIGHT to cover all Midnight user transaction fees.

**Confirmed from midnight-ledger spec (dust.md):**
```
night_dust_ratio = 5 DUST per NIGHT (max capacity)
generation_decay_rate = ~1 week to reach full capacity from zero
dust_grace_period = 3 hours
Sustainable spend rate = 0.714 DUST per NIGHT per day
```

**Unknown — requires preprod test:**
- `v_fee` (DUST cost per transaction) is not published. It has three components: base fee + computation weight + congestion weight (DUST/byte). Must be measured empirically.

**How to measure:** Deploy a minimal PSM on preprod, run a DV registration transaction, inspect the `v_fee` field in the resulting `DustSpend`. Repeat for a bonding curve buy and a NIGHT bond return. Use these three values as cost inputs.

**Sizing formula (apply once cost is known):**
```
NIGHT_sustained = (daily_tx_count × cost_per_tx_DUST) ÷ 0.714
NIGHT_peak = (peak_hour_txs × 24 × cost_per_tx_DUST) ÷ 0.714
```

**Estimated tx count for 100 Tier B launches (~180 days):**
- Average daily: ~3,300 txs → NIGHT_sustained = 3,300 × cost ÷ 0.714
- Peak (10 concurrent DV phases): ~12,000 txs/day → NIGHT_peak = 12,000 × cost ÷ 0.714
- Note: local dev wallets are seeded with 50,000 tNIGHT — scale is meaningful

**Tier C DUST premium:** Every Tier C trade (not just DV registration) is a Midnight transaction and consumes DUST. Tier C DUST cost per launch is significantly higher than Tier B. A separate per-launch DUST budget must be modelled once `v_fee` is known. Measure: DV registration tx, DV buy tx, bonding curve buy tx (Tier C), LP deposit tx, and ZK cert relay tx. Tier C budget = sum of all five × expected volume.

**Action:** Run preprod cost test before sizing the ops wallet NIGHT purchase policy. Implement separate per-launch DUST budget caps for Tier B and Tier C. If NIGHT holdings fall below safe level, Tier B and Tier C launches pause (separately configurable thresholds).

> **Partial resolution (2026-07-20):** after 4 local-devnet measurement attempts (full history in internal tracking), a real, node-confirmed, twice-reproduced `v_fee` was obtained for the single most expensive part of `registerForDarkVeil` (its 20-level Merkle-proof fold) via a minimal reproduction independently verified to match the real contract's own compiled prover-key size (37MB, identical both ways). Real result: `fees.paidFees = "1"` DUST atomic unit, with a full gas breakdown (`computeTime`/`readTime`/`bytesWritten`/`bytesDeleted`) available on every real transaction result going forward via the same `result.public.fees`/`result.public.partitionedTranscript[0].gas` fields. **Honest caveat, not smoothed over:** this measured cost was *lower* than a much simpler stand-in contract's measured cost (a plain Counter `increment`, "92") despite using far more real compute time — reproduced twice, not a fluke, but not independently explained either. Most likely a low-congestion/idle-single-user-devnet artifact in the real DUST fee formula's "congestion weight" term (per this section's own three-component `v_fee` model above), meaning **"1" should be read as a lower bound, not a mainnet-representative figure** — do not plug it directly into the sizing formula below as a confident point estimate. Still unmeasured: the bonding curve buy tx, NIGHT bond return tx, DV buy tx, LP deposit tx, and ZK cert relay tx this section's own "How to measure"/Tier C premium paragraphs ask for — this closes the empirical *methodology* gap (a real, repeatable measurement process now exists and a real devnet is running) more than it closes the full *sizing* question.

### 🟡 IMPORTANT [T6] — Treasury Stablecoin Floor
- Hard floor: equivalent of 10,000 ADA in stablecoin (exact USD value TBD)
- Warning threshold: equivalent of 25,000 ADA in stablecoin
- Below warning: operator alerted; stablecoin accumulation continues normally
- Below floor: Tier B and Tier C new launches pause pending treasury review
- Note: Tier C fees arrive in NIGHT and require conversion to stablecoin — conversion lag means the treasury floor calculation must account for NIGHT held but not yet converted (mark-to-market the NIGHT balance)

> **T6 resolution (2026-07-10):** built for real, on top of a genuine bug found in the process — `treasury.compact`'s `treasuryBalance` previously summed ADA-denominated and NIGHT-denominated deposits into ONE combined number with no unit conversion (e.g. 1000 lovelace + 500 NIGHT atomic units became a meaningless "1500"), which made a floor check impossible to compute correctly. Split into `adaBalance`/`nightBalance` (and their lifetime-counter equivalents); `withdrawFees` now takes a `currency` argument for the same reason, and NIGHT withdrawals now actually pay out via `sendUnshielded` (previously ledger-only — the governor's decrement was never matched by a real payment). New read-only circuits `getAdaEquivalentBalance`/`isBelowFloor`/`isBelowWarning` take an already-converted `nightPriceLovelacePerAtomicUnit` (computed off-chain from the existing Oracle Strategy) and do only multiplication on-chain, never division (Compact can't divide in-circuit). **These are advisory, not an on-chain gate** — this PSM has no "launch creation" circuit to attach a block to (deployment happens off-chain via the SDK/ops flow), and Compact still has no working cross-contract call mechanism (T2/T25) regardless. The off-chain launch-creation flow is expected to call `integration/midnight-client.ts`'s new `checkTreasuryHealth` helper before proceeding with a new Tier B/C launch — wiring that into the actual WordPress launch-creation UI is a separate follow-up, outside this session's tracked file scope.

### ✅ RESOLVED [T7] — Domain and Social Handles
- Domain: `noctis.zone` secured ✅ (2026-06-09)
- Twitter/X: secured ✅ — **[@Noctis_Zone](https://x.com/Noctis_Zone)** (not the `@NoctisProtocol`/`@NoctisLaunch` candidates this section previously proposed — confirmed by Jinx 2026-07-10, this CLAUDE.md section had drifted out of sync with internal tracking's already-current domain status)
- Discord: secured ✅ — **[discord.gg/FkFwHFN6Aq](https://discord.gg/FkFwHFN6Aq)** (confirmed 2026-07-10, resolves to a real active server named "Noctis")

All three items required before public announcement are done. One optional, non-blocking item remains: whether to register `noctis.fi`/`noctis.io` as defensive backup domains against squatting — a standalone decision for whenever Jinx wants to revisit it, not part of this requirement.

### ✅ RESOLVED [T8] — Eligibility Check 04 (Stake Key Match) + Check 05 (Tx Graph)
Originally filed post-MVP for both checks. **Check 05 resolved 2026-07-12:** implemented in `integration/eligibility-checker.ts`'s `checkNoDirectAdaFlow`, scanning each registrant's transactions in the 90-day lookback window for the creator's address on either side, via new `BlockfrostClient.getAddressTransactionsAll`/`getTxUtxos` wrappers.

**Check 04 resolved 2026-07-13** — reverses this entry's own earlier conclusion that it needed real cross-chain proof machinery (a wallet-signed attestation or a ZK proof binding a Midnight registration to a real Cardano stake key). That framing conflated two different things: *proving ownership* of a stake key (which would need a signature) versus *reading* the stake credential a Cardano base address already encodes in its own bytes (no signature needed — Blockfrost's `GET /addresses/{address}` exposes it directly as `stake_address`). The self-report safety already relied on for checks #1/#5 extends to #4 for free: the DarkVeil allocation Merkle leaf (`hash_dv_leaf` in `bonding_curve_tier_b.ak`) binds the registrant's `VerificationKeyHash`, and `ClaimDarkVeilTokens` requires that exact key to sign — so a registrant self-reporting an address they don't control could never actually claim from it. Implemented as `checkStakeKeyMatch` in the same `integration/eligibility-checker.ts` module, wired into `checkDarkVeilEligibility` alongside checks #1/#5. New `BlockfrostClient.getAddress` wrapper for the `/addresses/{address}` endpoint. Fails closed if the registrant's address has no stake credential (enterprise/Byron address — unusual enough for a real DV registrant to treat as ineligible rather than silently pass). Catches a specific, cheap evasion of check #3 (a creator registering from a second payment address sharing their known wallet's stake key) — not full sybil detection, which remains checks #5 and T9's job. 6 runtime sanity checks pass (temporary probe, deleted after use, same convention as the rest of this module). No contract changes needed — like checks #1/#5, this runs entirely off-chain before the allowlist Merkle tree is built.

### 🟡 IMPORTANT [T65] — DarkVeil Eligibility Checks #1/#2 Off-Chain Enforcement — one config gap remaining
**Found 2026-07-12 while investigating T8.** Checks #1 (wallet age ≥ 90 days) and #2 (NIGHT balance ≥ $50 USD) were treated as already-MVP by this document, but had **zero off-chain implementation anywhere in the codebase** — only the on-chain `verifyAllowlist` Merkle-membership circuit existed; nothing computed who should get a leaf in that tree in the first place. **Check #1 resolved 2026-07-12:** `checkWalletAge` in `integration/eligibility-checker.ts` (same new module as T8's check 05 fix) walks the registrant's full transaction history via `BlockfrostClient.getAddressTransactionsAll` and compares the earliest transaction's block time against current time; zero-transaction addresses are correctly never eligible.

**Check #2 — built 2026-07-13, one real config gap remains.** Four new modules, each independently verified against real sources before being wired together (not assumed from training data, per this session's own discipline given Midnight/Compact SDK unreliability):
- `integration/indexer-client.ts` — `getUnshieldedNightBalance` via `@midnightntwrk/wallet-sdk-indexer-client`'s `UnshieldedTransactions` subscription (note: unhyphenated `@midnightntwrk` scope — the current `midnightntwrk/midnight-wallet` monorepo; the older hyphenated `@midnight-ntwrk/wallet-sdk-indexer-client` traces to a legacy `artifacts` mirror). Checked the indexer's actual resolver source (`indexer-api/src/infra/api/v4/subscription/unshielded.rs`): opening with `transactionId: 0` genuinely replays an address's full history before live-tailing — confirmed real, not assumed, since GraphQL subscriptions don't replay by default. The pull-and-terminate-at-watermark consumption pattern (`Stream.toPull`, `Effect.scoped`) was verified against the real `effect` package with 4 mocked-stream test cases before use. Native NIGHT token type comes from `@midnight-ntwrk/ledger-v8`'s real `nativeToken` export.
- `integration/minswap-client.ts` — `getNightAdaTwap`, a real 30-min TWAP computed client-side from Minswap's live `price/timeseries` endpoint (confirmed real, live data fetched 2026-07-13 from the real NIGHT-ADA pool).
- `integration/orcfax-client.ts` — `getOrcfaxAdaUsdPrice`, a real CBOR datum reader verified against the exact example bytes in `orcfax/datum-demo`'s own docstring (not just the Python source) — including a critical, easy-to-miss detail: Orcfax encodes rational-number exponents as raw unsigned 64-bit magnitudes even when semantically negative (e.g. -5 encoded as 2⁶⁴-5), needing `BigInt.asIntN(64, ...)` to recover — confirmed by cross-checking the decoded ADA-USD and USD-ADA values are true reciprocals only once that fix was applied.
- `integration/night-price-oracle.ts` — combines the two into `usdToMinNightAtomic`, all-BigInt arithmetic verified against hand-calculated expected values (matched to within 1 atomic unit, a rounding-direction difference not a bug). NIGHT decimals (1 NIGHT = 1,000,000 STAR) sourced from Midnight's public tokenomics whitepaper/FAQ via web research, **not verified against SDK source** — flagged honestly, worth confirming before mainnet use.

**The one remaining gap:** no confirmed MAINNET Orcfax ADA-USD oracle address/auth-policy exists. `orcfax-client.ts` ships a verified, working **preprod** config (`ORCFAX_ADA_USD_PREPROD_CONFIG`) — real and tested against real example data — but Orcfax's own docs describe a different discovery mechanism for finding a feed's address (a FactStatementPointer registry) than what the working reference implementation (`datum-demo`) actually uses (a fixed address + auth-policy check), and no public source gives the mainnet equivalent of that simpler pattern. `checkDarkVeilEligibility` requires callers to supply a real `OrcfaxFeedConfig` explicitly (no silent preprod default) for exactly this reason. See internal tracking / [GitHub #67](https://github.com/MrJustJinx/Noctis_ZKL/issues/67) for full detail.

### 🟡 IMPORTANT [T69/T71] — Witness-Secret Persistence Across Sessions
**Found 2026-07-14** (T69, external finding via [GitHub #70](https://github.com/MrJustJinx/Noctis_ZKL/issues/70), JAlbertCode) **— answered against real Midnight source, general fix not yet built (T71).** DarkVeil's commit→reveal buy flow generates the commitment's "opening" (amount + nonce) client-side, needed again in a *separate* later transaction (reveal) that may happen in a different browser session entirely. Verified via `midnight-verify` against the real `midnight-dapp-connector-api`/`midnight-js` source (not assumed): witnesses execute locally in the dApp's own JS, never inside the wallet — the wallet is invoked only afterward, to turn an already-built proof preimage into a ZK proof, and its real API (checked at v4.0.1 through 4.1.0-beta.1) never exposes secret/private key material at all. The correct, first-party mechanism for persisting a witness secret across sessions is Midnight's own `PrivateStateProvider` interface (a real, encrypted, dApp-local store — AES-256-GCM, password-protected, `packages/level-private-state-provider`'s real implementation, IndexedDB in-browser), which also ships `exportPrivateStates`/`importPrivateStates` as a user-controlled backup/restore mechanism.

**The general gap (T71):** this isn't unique to the buy nonce — `contracts/midnight/witnesses.ts`/`integration/midnight-client.ts` currently model *every* Compact witness secret in this codebase (base user identity, DarkVeil registration nonce, buy nonce, governor/creator/community secrets) as a raw value passed straight into a constructor, correct for the local test simulator but with no real wiring anywhere showing how a production, wallet-connected session sources or persists any of it. Recommended fix: wire a real `PrivateStateProvider`-backed store as the actual source for every witness secret, plus surface `exportPrivateStates`/`importPrivateStates` as a user-facing backup flow — both non-custodial by construction and consistent with Midnight's own privacy design, not a platform-invented workaround. Explicitly do NOT derive nonces from a wallet-signed message (no such primitive exists) and do NOT cache any witness secret server-side. Not yet implemented — no live frontend exists yet to retrofit (confirmed: the WordPress theme has no DarkVeil private-buy widget or commitment-handling JS at all today). Full investigation trail in internal tracking's T69/T71 entry.

### ✅ RESOLVED [T9] — N-Hop Challenge Window
72-hour challenge window after DarkVeil registration, max 5 hops, 25 ADA reporter bond, NIGHT bounty.

**Resolved 2026-07-12 (Tier B):** no fuller spec than the CLAUDE.md constants existed anywhere — designed this session, confirming each real fork against the existing architecture. Lives on Cardano (new `contracts/cardano/nhop_challenge.ak`, same cross-chain reasoning as T24/T46 — the ADA bond can't be Midnight-native). Triggers post-CLAIM, not post-registration — the only privacy-preserving option, since a registrant's real wallet isn't publicly linked to their DarkVeil allocation until they claim (T46). NIGHT bounty payout is off-chain-orchestrated, since a Cardano script can't send NIGHT. Resolution is governor-adjudicated (same trust boundary as T36's `hasClaimableBalance`) — the contract only enforces the bond, the 24h defence window via real chain time, and the payout itself. 6 new tests, 137/137 total Cardano tests pass. **Tier C is unaffected** — already build-blocked independent of this feature (T17/T18).

### 🟢 POST-MVP [T10] — Blockfrost Compliance Hook
Eligibility gate is designed to be hookable for additional check modules (sanctions screening, wallet risk scoring). Architecture supports this from day one; modules themselves are post-MVP.

### 🟢 POST-MVP [T11] — Dynamic Treasury Floor
MVP: static 10,000 ADA floor. Post-MVP: dynamic floor proportional to number of active concurrent Tier B launches.

### 🟢 POST-MVP [T12] — Platform Governance
NIGHT holders voting on protocol parameter changes is not Version 1. Team controls parameters at launch with public disclosure.

### 🟢 POST-MVP [T16] — Community Yield Mechanism
A community yield mechanism is deferred to post-MVP. Candidates: NIGHT lockup for protocol fee share, launch participation rewards, points-based reward system. Architecture must support activation without redeploying core contracts. ~~**Do not build staking infrastructure in V1 — design contracts to be yield-module-pluggable.**~~

> **Partially superseded (T66, 2026-07-14):** the "no staking infrastructure in V1" line above was written against a *platform-wide* yield mechanism — a single protocol-level pool NIGHT holders lock into for a share of overall fee revenue. That's still deferred, unchanged. What's now built is a narrower, different thing: an optional, **per-launch** Staking Rewards Pool a creator opts into at launch creation for their own token specifically, funded from that launch's own supply allocation, not a protocol-wide mechanism. See the new `## STAKING REWARDS (OPTIONAL)` section below. T16 itself remains open for the platform-wide version.

---

## TIER C — OPEN ISSUES (BUILD BLOCKERS)

> All four issues below must be resolved before any Tier C contract work begins. Tier A and B are entirely unaffected.

### 🔴 BLOCKER [T17] — Midnight Fungible Token Standard
**Question:** Does Midnight have a published fungible token standard, or is token state managed entirely inside PSM contract logic?

On Cardano, native tokens are a first-class ledger primitive (multi-asset UTxO). On Midnight, it is not yet confirmed whether there is an equivalent — or whether a "token" for Tier C is simply a balance map inside a Compact PSM's private state.

**Implications:**
- If Midnight has a native token layer: token transfers, wallet display, and indexing all work automatically
- If tokens are PSM-only state: wallets and explorers won't display balances natively; a token display adapter layer is needed
- Either way, minting, burning, and transfer logic must be confirmed before Tier C contracts are designed

**Action:** Review Midnight SDK docs and Compact stdlib for any token/asset primitives. Ask Midnight engineering if a native fungible token standard is planned or exists.

### 🔴 BLOCKER [T18] — Tier C Graduation and DEX
**Question:** Where does a Midnight-native token graduate to, and when will a Midnight DEX exist?

Current Tier B graduates to CSwap (Cardano DEX). Tier C has no equivalent — there is no established Midnight DEX at time of writing.

**Options:**
- **Option A — Wait for Midnight DEX:** Tier C launches are held in a pre-graduation state until a whitelisted Midnight DEX is live. Creator and platform agree on a graduation target DEX when one is available. High delay risk.
- **Option B — Bridge at graduation:** Token is bridged from Midnight to Cardano at graduation. LP is seeded on a Cardano DEX as a wrapped/bridged version. This reintroduces bridge risk and partially defeats the Midnight-native purpose, but gives immediate liquidity.
- **Option C — Redefine graduation:** Graduation for Tier C means "bonding curve fully sold through and LP seeded in a Midnight LP Escrow PSM." The DEX component is deferred — LP is held in escrow until a Midnight DEX is designated. Platform lists the token on an internal discovery page in the interim.

**Default:** Option C until a Midnight DEX is confirmed. Architect Tier C LP Escrow PSM to be DEX-agnostic — it holds the assets and can be pointed at a DEX address when one is available.

**Action:** Confirm with Midnight ecosystem team whether any DEX is in development or planned. Do not implement Tier C graduation logic until this is resolved.

### 🟡 IMPORTANT [T19] — Tier C Trade Fee Currency and Conversion
**Question:** How does the platform convert NIGHT-denominated Tier C fees to stablecoin?

For Tier A/B: fees arrive in ADA, swapped on Cardano DEXes to stablecoin. For Tier C: fees arrive in NIGHT on Midnight. The conversion path is unclear.

**Sub-questions:**
1. Is there a NIGHT → stablecoin swap available on Midnight natively?
2. If not, does NIGHT need to be bridged to Cardano first, then swapped?
3. What is the minimum viable conversion batch size?
4. Does the Treasury PSM on Midnight hold NIGHT until a conversion threshold is reached, then bridge and convert?

**Default until confirmed:** Treasury PSM accumulates NIGHT fees. A manual conversion process (bridge → Cardano DEX swap → stablecoin) is performed by ops on a monthly schedule matching the Tier A/B batch cycle.

> **Research finding (2026-07-10):** the "bridge → Cardano DEX swap" default above has no bridge to actually use yet. The only protocol-level Cardano↔Midnight bridge found ([midnight-improvement-proposals#20](https://github.com/midnightntwrk/midnight-improvement-proposals/issues/20)) is unidirectional (Cardano → Midnight only, cNIGHT → mNIGHT) and NIGHT-only — there is no confirmed path for NIGHT fees to leave Midnight at all right now, in either direction back or onward to a stablecoin. Practically, this means treasury.compact's NIGHT balance (see T6's `nightBalance`/mark-to-market fix) should be expected to sit unconverted indefinitely until either a reverse-direction bridge ships or a Midnight-native NIGHT/stablecoin swap appears (watch T18's NorthStar DEX candidate).
>
> **Timeline update (2026-07-10, per Jinx):** a bidirectional version of the bridge is in development and expected live within a few months. Once it ships, this resolves the "no route off Midnight" half of T19 directly — Tier C's NIGHT fees could bridge to Cardano and swap through the existing Tier A/B stablecoin path, no new mechanism needed. Not yet independently confirmed against a public proposal/timeline as of this session, but this is Jinx's own expectation, not Claude speculation. Revisit T19 once the bridge is live rather than designing around it as an indefinite blocker.

### 🟡 IMPORTANT [T20] — Midnight LP Escrow PSM Design
**Question:** What does the Midnight equivalent of the Cardano LP Escrow contract look like?

The Cardano LP Escrow contract has: 365-day lock, no withdraw, migrate after expiry, whitelist of DEXes, migration atomicity. The same policy must apply to Tier C LP, but implemented as a Compact PSM.

**Complications:**
- DEX whitelist cannot be hardcoded against Midnight DEX addresses that don't yet exist
- Migration atomicity requires a Midnight DEX to support atomic remove/add operations
- LP token standard on Midnight TBD (see T17/T18)

**Approach:** Design the Midnight LP Escrow PSM with the same invariants as the Cardano version. Use a governor-updatable DEX whitelist until the Midnight DEX landscape is stable, then freeze it. The `withdraw` does not exist. The `migrate` function requires lock expiry + governor signature + whitelist membership.

### 🟡 IMPORTANT [T21] — ZK Cert Relayer (Tier C → Cardano L1)
**Question:** How does a Midnight-native launch's ZK Fair Launch Certificate get anchored on Cardano L1?

For Tier B, the Midnight PSM directly interacts with the Cardano ZK Anchor Contract (cross-chain call or bridge). For Tier C, same mechanism is needed — but the launch has no direct Cardano component beyond this one anchor.

**Options:**
- **Option A — Same as Tier B:** If Midnight SDK already supports posting proof bundles to Cardano L1, reuse the same ZK anchor mechanism. No extra infrastructure.
- **Option B — Platform-operated relayer:** After DarkVeil close, the platform's backend reads the proof bundle from the Midnight PSM and posts it to the Cardano ZK Anchor Contract. Trusted but centralised for this one step. Relayer address is public and disclosed.
- **Option C — Omit Cardano anchor for Tier C:** ZK cert stored on Midnight only. Less trust-verifiable externally. Not recommended — the certificate is a core marketing asset.

**Default:** Option A if supported, fall back to Option B. Do not use Option C.

> **T21 implementation status (2026-07-10):** Option A confirmed not available — every real Midnight SDK surface inspected this session (`@midnight-ntwrk/midnight-js-contracts` per T44/T2, `@midnight-ntwrk/dapp-connector-api` per T47) is entirely Midnight-side with no Cardano-aware primitive. Option B built in `integration/zk-cert-relayer.ts`: real, working cert fetching (`NoctisLaunchManager.getFairLaunchCert`) and real Blake2b-256 proof-bundle hashing (verified against `@noble/hashes/blake2.js`, runtime-tested). **Cardano transaction submission — resolved 2026-07-10:** `integration/cardano-anchor-submitter.ts`'s `LucidAnchorSubmitter` implements `CardanoTxSubmitter` for real using `@lucid-evolution/lucid` (Anvil's real docs site was checked and shows no generic arbitrary-validator-plus-custom-redeemer spend endpoint, so Lucid Evolution was used instead — confirmed real, published, actively maintained). Data schemas are hand-mirrored from `contracts/cardano/plutus.json`'s actual compiled CIP-57 blueprint for `zk_anchor`, not guessed from the `.ak` source. Full integration workspace typechecks clean. The one thing still not done: an actual submission against a live Cardano node, which needs a funded relayer key that doesn't exist in this dev environment — flagged explicitly rather than claimed as tested.

---

## SECURITY AUDIT REQUIREMENTS

Before mainnet deployment, the following must be audited:

### Priority 1 (Critical)
- DarkVeil PSM: double-registration, NIGHT bond re-entrancy, participation rate manipulation
- LP Escrow: migration atomicity failure, whitelist bypass, lock expiry manipulation
- Cross-contract ZK proof forgery: every downstream contract that accepts ZK proofs as authorisation

### Priority 2 (High)
- Bonding Curve PSM: curve math precision loss, fee routing rounding, graduation race condition
- CTO Governance: flash vote attack, quorum gaming, forged CTO_PASSED proof injection
- Vesting PSM: pre-graduation access, vest_days manipulation

### Priority 3 (Medium)
- Treasury PSM: DUST exhaustion under load, oracle manipulation
- Creator Fee Escrow: false emergency exit, epoch boundary double-claim

### Formal Verification Required
- Bonding curve integral formula (total ADA raised = theoretical value)
- LP migration atomicity (addLiquidity failure always reverts removeLiquidity)
- ZK proof soundness (no two distinct inputs produce the same valid proof output)

---

## FILE STRUCTURE (SUGGESTED)

```
noctis/
├── CLAUDE.md ← this file
├── README.md
├── apps/
│ ├── web/ ← Next.js frontend
│ │ ├── app/
│ │ │ ├── (public)/
│ │ │ │ ├── page.tsx ← Landing page
│ │ │ │ └── [launch]/ ← Individual launch page
│ │ │ ├── launch/
│ │ │ │ ├── create/ ← Launch wizard (Tier A + Tier B)
│ │ │ │ └── [id]/ ← Live launch view
│ │ │ ├── dashboard/ ← Creator dashboard
│ │ │ └── admin/ ← Internal ops (treasury, launches)
│ │ ├── components/
│ │ │ ├── darkveil/ ← DV registration, countdown, allocation
│ │ │ ├── bonding/ ← Curve chart, buy interface
│ │ │ ├── escrow/ ← Creator fee claims
│ │ │ ├── governance/ ← CTO vote UI
│ │ │ ├── lp/ ← LP position, migration
│ │ │ └── shared/ ← Wallet connect, layout, nav
│ │ └── lib/
│ │ ├── blockfrost.ts ← Blockfrost API client
│ │ ├── orcfax.ts ← Oracle price fetching
│ │ ├── midnight.ts ← Midnight SDK wrapper
│ │ ├── cardano.ts ← Cardano tx building
│ │ └── constants.ts ← All platform constants from this doc
├── contracts/
│ ├── midnight/ ← Compact PSM contracts
│ │ ├── darkveil.compact
│ │ ├── bonding_curve.compact
│ │ ├── eligibility_gate.compact
│ │ ├── creator_escrow.compact
│ │ ├── vesting.compact
│ │ └── treasury.compact
│ ├── cardano/ ← Aiken contracts
│ │ ├── bonding_curve.ak ← Tier A only, linear
│ │ ├── bonding_curve_tier_b.ak ← Tier B only, quadratic (T24, 2026-07-09)
│ │ ├── lp_escrow.ak
│ │ ├── cto_governance.ak
│ │ └── zk_anchor.ak
│ └── tests/
├── docs/
│ ├── noctis_whitepaper_v1.html
│ ├── noctis_whitepaper_v1.docx
│ └── noctis_presentation_v1.html
└── packages/
 ├── zk-proofs/ ← Client-side ZK proof generation
 └── types/ ← Shared TypeScript types
```

---

## KEY DESIGN PRINCIPLES FOR THE BUILD

1. **Midnight is invisible to the end user.** Users should never see "Midnight" language in the UI unless they are specifically interested. DUST fees are handled in the background. The privacy layer is a feature, not a complexity. Exception: Tier C users must be told they need a Midnight wallet — this is unavoidable, but frame it as "for maximum privacy."

2. **Two income streams for creators are distinct.** Never show them as one number. Always label: "Bonding Curve Escrow" (pre-graduation, fixed amount) vs "LP Trading Fees" (post-graduation, ongoing).

3. **The 5% cap is cumulative across DV + public.** Track per-identity across both phases combined. UI should show "X% used" across the whole launch, not per-phase.

4. **Graduation is 100% sell-through only.** No partial graduation. No progress bar that looks like it could graduate early.

5. **No withdraw button for LP exists.** Do not build one. Do not show it as greyed out. It does not exist — in either the Cardano LP Escrow or the Midnight LP Escrow PSM. **Distinct from T48's buyback:** `ClaimBuyback` (Tier A/B `bonding_curve.ak`/`bonding_curve_tier_b.ak`) only exists pre-graduation, on a curve that stalled and was force-cancelled before ever seeding an LP — it lets holders reclaim a pro-rata share of principal that was never going to become an LP in the first place. It does not touch LP tokens, does not exist on `lp_escrow.ak`, and does not apply to a launch that actually graduated. Do not generalize it into anything resembling LP withdrawal.

6. **Creator vesting has no default.** The launch wizard must force an active selection between 90 and 365 days. No pre-filled value.

7. **The ZK Fair Launch Certificate is a badge.** After every Tier B or Tier C DarkVeil close, generate and display it prominently. It is a marketing asset. Make it shareable. For Tier C, the certificate still appears on Cardano (via relayer) — display it the same way.

8. **Public wallet addresses day one.** Treasury, ops wallet, and team wallet addresses should be visible in the UI footer or a dedicated transparency page.

9. **Ops buys NIGHT; treasury holds stablecoins.** The ops wallet purchases NIGHT to maintain DUST for Midnight transaction fees. For Tier C, the ops wallet receives NIGHT directly from trade fees — it may need less open-market purchasing. The treasury accumulates USDM (T14).

10. **Tier C is the premium, high-privacy option.** Position it clearly: Tier A is public, Tier B adds a private pre-sale, Tier C is fully private from start to finish. The trade-off (Midnight wallet required, NIGHT-denominated, less DEX liquidity initially) must be clearly communicated during launch wizard Tier C selection — never hidden.

11. **Tier choice is permanent.** A launch cannot be upgraded or downgraded between tiers after it goes live. Make this irreversibility explicit in the launch wizard confirmation screen.

---

## WHITEPAPER REFERENCE

The complete Noctis whitepaper (Version 1) is the authoritative reference for all protocol decisions. It has been audited for mathematical correctness. Key verified figures:

- Fee split: 1.0 + 0.6 + 0.4 = **2.0% total** ✓
- Supply: 5 + 15 + 15 + 65 = **100%** ✓
- Tier A: **$10 USD** (ADA or NIGHT equiv.) — ~40% ops / ~60% treasury ✓
- Tier B: **$30 USD** (ADA or NIGHT equiv.) — ~40% ops / ~60% treasury ✓
- Tier C: **$50 USD** (ADA or NIGHT equiv.) — ~40% ops / ~60% treasury ✓
- Vesting: 50M ÷ 180 days = **277,778/day** = **~8,333,333/month** ✓
- LP seeding at 0.0001 ADA grad price: **15,000 ADA = 150M × 0.0001** (balanced AMM) ✓
- Creator curve escrow at ~22K ADA raised: **~110 ADA** ✓

---

## COMPETITIVE CONTEXT

Primary competitor: **snek.fun** (Cardano) 
Noctis wins on: front-run protection, whale cap, anti-rug mechanics, ZK fair launch proof, community rescue mechanism, LP permanence, 1% creator fee (double competitors), and uniquely — a fully private Midnight-native launch option (Tier C) with no comparable product anywhere in the ecosystem 
snek.fun wins on: lower launch cost (2–5 ADA vs Noctis's launch fee — see platform constants above), instant launch, brand recognition, lower trade fee (~1%)

**The 2.0% total fee vs lower competitor fees** is the main attack surface. Counter-framing: the 1.0% creator share is the highest on any Cardano launchpad — a direct creator incentive. The remaining 1.0% builds a stablecoin treasury and funds operations including free Midnight gas for users. Community yield distribution is on the roadmap as a post-MVP upgrade.

**Tier C is a unique market position.** No launchpad currently offers a fully Midnight-native token launch. This is not just a feature — it is a different product category: privacy-first token creation for projects that want zero on-chain Cardano footprint. The target creator is one who values privacy and is building within the Midnight ecosystem, not one who wants maximum Cardano liquidity from day one.

---

*NOCTIS PROTOCOL · CLAUDE INSTRUCTION DOCUMENT · VERSION 1* 
*They can't front-run what they can't see.*
