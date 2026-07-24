# Pre-Launch Checklist — Noctis Protocol

Human sign-off gate. Three stages: website live, preprod contracts, mainnet.

**Sign-off format:** `[x] Description ✅ INITIALS DATE`  
**Rule:** Don't sign off without actually doing it. "Looks fine in the code" is not a sign-off.

---

## Stage 1 — Website live (noctis.zone)

### DNS + hosting

- [ ] Domain `noctis.zone` pointed to production server
- [ ] SSL certificate issued and auto-renewing
- [ ] Site loads at `https://noctis.zone` with no mixed-content warnings
- [ ] WordPress admin accessible at `/wp-admin/`
- [ ] Staging environment available at a separate subdomain

---

### Public pages — desktop

- [ ] **Home page** — hero renders, stat blocks correct, CTA buttons navigate correctly, nav links work, footer links work
- [ ] **Launches index** — card grid loads, filter tabs work (ALL/LIVE/DARKVEIL ACTIVE/UPCOMING/GRADUATED/DV FAILED), search works, tier filter works, sort works
- [ ] **Launch detail page (Tier B — e.g. /launch-phantom/)** — all sections render: header, progress bar, DV registration panel, bonding curve chart placeholder, LP info, creator info
- [ ] **DV Registration** — eligibility checklist renders, allocation display correct, NIGHT bond amount correct ($50 USD), registration form present
- [ ] **How It Works** — all step cards render, FAQ accordion opens/closes, guides link band renders above "Choose your tier" and every link resolves
- [ ] **How-To Guides (/how-to/)** — hero spacing clears the fixed nav, sticky quick-nav jumps to all 4 categories, every guide accordion opens/closes, all in-page links resolve
- [ ] **Staking (/staking/)** — discovery grid lists staking-enabled launches, search + status tabs + tier filter work, "My staking" gate shows until a wallet connects, then totals (projects / staked / rewards earned) and per-project rows populate and link to the right launch
- [ ] **Transparency page** — all 10 sections present, all default collapsed, expand/collapse works, wallet addresses placeholder text correct
- [ ] **Create Launch wizard** — all 6 steps accessible, Tier A vs Tier B selector works, DEX selector has no default (forced selection), vesting slider has no default, fee display matches CLAUDE.md's current launch fee constants

---

### Public pages — mobile (iPhone + Android)

- [ ] **Home page** — logo above heading, heading centred, stat blocks below CTA buttons, nav hamburger works, wallet connect hidden from nav, footer 2-col
- [ ] **Launches index** — status filter dropdown works, search full-width, filter bar has side padding, no horizontal scroll
- [ ] **Launch detail** — body stacks vertically (sidebar below main), no overflow
- [ ] **DV Registration** — stacked layout, logo visible, form usable
- [ ] **How It Works** — readable on mobile, no overflow
- [ ] **Transparency** — sections expand/collapse on mobile, no overflow
- [ ] **Create Launch wizard** — all steps usable on mobile, form fields don't overflow

---

### Navigation

- [ ] All nav links point to correct pages
- [ ] LAUNCH TOKEN button visible on desktop, in hamburger menu on mobile
- [ ] DarkVeil dropdown opens and shows correct sub-links
- [ ] Logo links to home page
- [ ] No 404s on any linked page

---

### Content

- [ ] Fee split figures correct on all pages (1.0% + 0.6% + 0.4% = 2.0%)
- [ ] Launch fees match CLAUDE.md's current `TIER_A/B/C_FEE_USD` constants on every page (USD-denominated, paid in ADA or NIGHT equivalent) — do not hardcode figures here, they're subject to change
- [ ] NIGHT bond amount correct ($50 USD)
- [ ] Wallet cap correct (5% per ZK identity)
- [ ] LP lock duration correct (365 days)
- [ ] No references to deprecated/removed reward mechanisms
- [ ] Three tiers correctly described (A: Cardano Only, B: Cardano + DarkVeil, C: Midnight + DarkVeil)

---

### Social + transparency

- [ ] Twitter/X handle registered and linked in footer
- [ ] Discord server created and linked in footer
- [ ] Transparency page placeholder wallet addresses replaced with real addresses
- [ ] `noctis.zone` links correctly from all social profiles

---

## Stage 2 — Preprod deployment (contracts)

*Tracks B (Cardano contracts) and C (Midnight PSMs) are built and internally tested (see ROADMAP.md) — this stage is about deploying to a live preprod/testnet environment, not initial construction.*

### Cardano preprod (Cardano testnet)

- [ ] Bonding Curve Contract (Tier A) deployed to preprod — note contract address
- [ ] Bonding Curve Tier B Contract deployed to preprod — note contract address; includes `ClaimDarkVeilTokens` (T46)
- [ ] Vesting Contract (Tier A) deployed to preprod — note contract address
- [ ] LP Escrow Contract deployed to preprod — note contract address
- [ ] ZK Anchor Contract deployed to preprod — note contract address
- [ ] CTO Governance Contract deployed to preprod — note contract address
- [ ] N-Hop Challenge Contract (Tier B) deployed to preprod — note contract address; test the 25 ADA bond, 72h post-claim window, 24h defense window with real chain time
- [ ] Staking Rewards Pool Contract (Tier A + B, T66) deployed to preprod — note contract address; test staking a position, `Unstake`, and a real Merkle-proven `ClaimRewards` payout for a launch that opted in
- [ ] Staking Rewards Pool: confirm `Graduate` on both curve contracts actually seeds the pool's UTXO with `staking_reserve_tokens` in the same transaction as LP, only when `staking_enabled` — and that it's a no-op (no separate output required) when the creator declined
- [ ] LP Escrow: confirm `withdraw()` does not exist in contract ABI
- [ ] LP Escrow: test `migrate()` — confirm requires lock expiry + whitelist membership, and that a whitelist change requires the full 72h `ProposeDexChange`/`ExecuteDexChange` notice window (T30)
- [ ] LP Escrow: test migration atomicity — confirm `addLiquidity` failure reverts `removeLiquidity`
- [ ] ZK Anchor: write a test proof bundle, confirm it's stored and publicly readable
- [ ] CTO Governance: test quorum check, 30-day lockout, 90-day cooldown, and that a passed vote actually redirects the bonding curve's creator fee (T51)

---

### Midnight preprod (Midnight testnet)

- [ ] T3 resolved (Midnight SDK/devnet maturity confirmed) before starting this section — see ROADMAP.md's Track E3, blocked on a stable devnet as of 2026-07-12
- [ ] Eligibility Gate PSM deployed (Tier B — merged with the former DarkVeil PSM, Phase 2 2026-07-11)
- [ ] Bonding Curve PSM deployed (Tier C only — merged with Eligibility Gate + DarkVeil, T25)
- [ ] Creator Fee Escrow PSM deployed
- [ ] Vesting PSM deployed
- [ ] Treasury PSM deployed
- [ ] LP Escrow PSM deployed (Tier C only — Midnight-native, currently unreachable in practice pending T18)
- [ ] CTO Governance PSM deployed
- [ ] Staking Rewards Pool PSM deployed (Tier C only, T66) — governor `publishStakeSnapshot`/`publishRewardRoot` calls, real `mintUnshieldedToken` payout to a staker on `claimRewards`; confirm the minted reward color is consistently reproducible (`tokenType(rewardDomainSep, thisContract)`) across separate calls

**DUST cost measurement (resolves T5):**
- [ ] DV registration tx: measure `v_fee` → record in internal tracking
- [ ] DV buy tx: measure `v_fee` → record
- [ ] Bonding curve buy tx: measure `v_fee` → record
- [ ] LP deposit tx: measure `v_fee` → record
- [ ] Calculate per-launch DUST budget (Tier B) → record in CLAUDE.md constants
- [ ] Calculate per-launch DUST budget (Tier C, if applicable) → record

---

### End-to-end Tier B flow (preprod)

- [ ] Creator creates Tier B launch via wizard → launch fee paid (per current `TIER_B_FEE_USD`) → launch created on-chain
- [ ] DV registration window opens → register with eligible wallet → NIGHT bond locked (Eligibility Gate PSM, Midnight)
- [ ] Registration freezes at T-2h → allocation per wallet (`baseSlot`) calculated correctly
- [ ] DarkVeil buying window opens → submit buy commitment (private, Midnight) → private state updated
- [ ] DarkVeil closes → relayer anchors `dv_allocation_root` on Cardano ZK Anchor Contract (Merkle root, not a plaintext registrant list, T46)
- [ ] Buyer calls `ClaimDarkVeilTokens` on the Cardano Bonding Curve Tier B contract → presents `(dv_amount, salt, merkle_proof)` → pays real ADA → receives tokens (T46 — this is where real Tier B DarkVeil settlement actually happens, not on Midnight)
- [ ] Ratio-based NIGHT bond refund correct for a partial buyer (`claimRatioBondRefund`, T63); ghost registrants forfeit fully, split 60/40 treasury/ops
- [ ] N-hop challenge: submit a test challenge against a claimed allocation within 72h, confirm the 24h defense window and governor-adjudicated resolution both work (T9)
- [ ] Public bonding curve opens on Cardano → buy tokens → price increases correctly
- [ ] Bonding curve graduates at 100% sell-through → `Graduate` redeemer seeds LP to CSwap (preprod), verified by real value movement (T49); if staking was enabled at launch creation, confirm the same transaction also seeds the staking pool (T66)
- [ ] LP enters escrow → 365-day lock confirmed → no withdraw() possible
- [ ] Creator fee escrow accumulating correctly (1.0% of trades) — **on the Cardano Bonding Curve Tier B contract itself, not a Midnight PSM** (T46/T51 — Creator Fee Escrow PSM never holds a real Tier B fee)
- [ ] Creator claims fee via `ClaimCreatorFees` on the Cardano curve contract → correct amount
- [ ] Vesting starts at graduation → daily release correct (`total_allocation / vest_days`), timestamp bound to real chain time (T50)

---

### End-to-end Tier A flow (preprod)

- [ ] Creator creates Tier A launch → launch fee paid (per current `TIER_A_FEE_USD`)
- [ ] Linear bonding curve active → buys increase price correctly
- [ ] 5% per-address cap enforced
- [ ] Graduation at 100% sell-through → LP seeded; if staking was enabled at launch creation, confirm the staking pool is seeded in the same transaction (T66)

---

## Stage 3 — Mainnet launch

*This stage requires completed security audit (Track E) and successful preprod sign-off (Stage 2).*

### Security audit

- [ ] Security audit report received for all Priority 1 contracts
- [ ] All Critical and High findings resolved or accepted with documented rationale
- [ ] Formal verification complete for bonding curve integral, LP migration atomicity, ZK proof soundness
- [ ] Audit report published on Transparency page

---

### Final mainnet checks

- [ ] All contract addresses set in WordPress theme constants (`constants.ts` / `lib/cardano.ts`)
- [ ] Orcfax oracle integration tested with live mainnet datums
- [ ] Blockfrost mainnet project ID set in environment
- [ ] Treasury, ops, and team wallet addresses set (public on Transparency page)
- [ ] NIGHT purchase policy confirmed: ops wallet has sufficient NIGHT for first 30 days
- [ ] DUST budget confirmed: sufficient NIGHT held to cover estimated first-30-day tx volume
- [ ] T6: Treasury stablecoin balance above 10,000 ADA floor before first Tier B launch
- [ ] T14 resolved: stablecoin selection confirmed as USDM (native Cardano, no bridge risk)
- [ ] Social handles registered: Twitter/X ✅, Discord ✅

---

## Final sign-off

- [ ] All Stage 1 items signed off
- [ ] All Stage 2 items signed off
- [ ] All Stage 3 items signed off
- [ ] **MJ sign-off**: ___ / ___
- [ ] **[Co-founder] sign-off**: ___ / ___

Once all sign-offs are on this line, we LAUNCH.
