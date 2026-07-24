# Roadmap — Noctis Protocol

Rolling task list. Tracks ordered by build sequence — A must precede B, B precedes C, etc. Items within a track ship independently.

**Status tags:** `Proposed` / `In flight` / `Blocked on <X>` / `Shipped <date>` 
**Scope tags:** S = < 4h / M = < 2d / L = < 1wk / XL = > 1wk

---

## TL;DR

**Updated 2026-07-14 — T66 Staking Rewards Pool shipped across all 3 tiers.** Tracks B/C/D/E are built, tested, and audited. T2 (cross-PSM atomicity) is effectively settled, not a blocker — the SDK confirms the 10-minute settlement window is the only implementable option regardless of the protocol-level answer, so nothing further was waiting on it. Contract-level work is essentially done; what's left is mostly external (preprod devnet stability, an independent professional audit, Tier C's remaining ecosystem blockers).

- **Track A** — WordPress public site (noctis.zone) — *in progress, mobile audit + production deploy remain*
- **Track B** — Cardano L1 contracts (Aiken) — *built: 8 validators, 161 tests*
- **Track C** — Midnight PSM contracts (Compact) — *built: 8 PSMs, 214 tests, full ZK proving keys*
- **Track D** — Integration + API layer — *built: real Blockfrost/Midnight SDK/wallet/eligibility-checker/price-oracle code*
- **Track E** — Security + audit — *two internal adversarial passes done (T53-T63) + four hardening passes (T50-T52, T64); independent professional audit still needed before mainnet*
- **Track F** — Tier C (Midnight native) — *still blocked on T17 (token standard not yet ratified) and T18 (no graduation DEX); T19/T21 substantially resolved*

Suggested order (updated): **A** (finish) → **preprod devnet + DUST measurement (T5)** → **independent audit** → **mainnet** → **F** (once T17/T18 clear).

---

## Track A — WordPress public site (noctis.zone)

The public-facing marketing and launch interface. WordPress PHP + vanilla JS. No build step.

### A1. Home page ✅
**Status:** Shipped 2026-06-09. Mobile-responsive.

Hero section, stat blocks, CTA buttons, nav, footer (Community + Protocol columns only).

---

### A2. Launches index page ✅
**Status:** Shipped 2026-06-09. Mobile-responsive.

Launch card grid, status filter tabs (dropdown on mobile), search, tier filter, sort, ZK badge modal.

---

### A3. DV Registration page ✅
**Status:** Shipped 2026-06-09. Mobile-responsive.

Registration form, eligibility checklist, allocation tracker, NIGHT bond display, countdown timer.

---

### A4. How It Works page
**Status:** Shipped (desktop). Mobile audit pending.

---

### A5. Transparency page
**Status:** Shipped (desktop). Mobile audit pending. 10 collapsible sections — wallet addresses, fee split, treasury, LP positions, rug protection, ZK certs, team, audits, changelog, open issues.

---

### A6. Create Launch wizard
**Status:** Shipped (desktop). Mobile audit pending. 6-step wizard — project info, token config, tier selection, DarkVeil settings, vesting + DEX, review + pay. **Tier C fully wired (2026-06-09):** third tier card, `#cw-tier-c-config` panel, DEX field hidden for Tier C, NIGHT-denominated review, pay summary shows current launch fee per CLAUDE.md constants. **Staking opt-in added (T66, 2026-07-14):** Step 5 gets a toggle (25% fixed allocation) + forced 3/4/5-year runway selection, live supply bar updates, review line item — same "no default" forced-choice pattern as vesting.

---

### A7. Mobile audit — How It Works, Transparency, Create Launch
**Status:** Proposed · **Scope:** M · **Touches:** `assets/css/main.css`, page templates

Complete the mobile pass on the three remaining pages. Same pattern as A1-A3.

---

### A8. Production deployment to noctis.zone
**Status:** Proposed · **Blocked on:** domain DNS setup, hosting environment · **Scope:** S

Point noctis.zone DNS to hosting. Deploy theme. Smoke test all pages on live URL. Add SSL.

---

### A9. Dynamic launch data (Blockfrost integration)
**Status:** Proposed · **Blocked on:** D1 · **Scope:** L

Replace mock launch data (phantom, nightshade, eclipse, void) with live data from Blockfrost + chain indexer. Launch cards populate from on-chain state, not PHP arrays.

---

## Track B — Cardano L1 contracts (Aiken)

**Built.** 8 validators, 161 tests, all compile clean (`aiken check`), `plutus.json` blueprint current.

### B1. LP Escrow Contract ✅
**Status:** Shipped. 365-day LP lock, no `withdraw` ever. DEX whitelist is no longer hardcoded (T30, 2026-07-10) — a multisig-gated `ProposeDexChange` requires a 72h public notice window before `ExecuteDexChange` can apply it, replacing the original single-governor-signature design. `HarvestFees` (T13) lets ongoing trading fees reach the fee recipient without touching the locked position. `SealLock`/`Graduate` (T49) move real value, verified, not trusted. `TriggerCTO`/`DissolveCTO` (T51) redirect fee-harvest authority post-CTO-vote.

---

### B2. ZK Anchor Contract ✅
**Status:** Shipped. Receives ZK proof bundles + (for Tier B) a `dv_allocation_root` Merkle root (T46) so the Cardano curve can verify DarkVeil claims without publishing the full registrant roster.

---

### B3. CTO Governance Contract ✅
**Status:** Shipped. Anchor mechanism is an open relay (T31) — any token holder can submit the anchor transaction, no platform-only relay bottleneck.

---

### B4. Bonding Curve (Tier A, linear) + Bonding Curve Tier B (quadratic) ✅
**Status:** Shipped. Tier B's entire public bonding curve — plus its real DarkVeil settlement via `ClaimDarkVeilTokens` — moved here from Midnight entirely (T24, T46), since the public phase needs no privacy and Cardano can enforce quadratic-curve payment + ADA settlement natively. `Graduate`/`ClaimBuyback`/`ExpireCurve` (T29/T48/T49) give every stalled or graduated curve a real resolution path.

---

### B5. Vesting Contract (Tier A) ✅
**Status:** Shipped — Tier A had no vesting mechanism at all until this was added (2026-07-09).

---

### B6. N-Hop Challenge Contract ✅
**Status:** Shipped 2026-07-12 (T9). Tier B only — a Sybil-registration challenge window, designed from CLAUDE.md's 5 constants (no fuller spec existed anywhere). Lives on Cardano since the ADA reporter bond can't be Midnight-native; triggers post-claim, not post-registration, for privacy reasons.

---

### B7. Staking Rewards Pool Contract (Tier A + B) ✅
**Status:** Shipped 2026-07-14 (T66). New optional per-launch feature — real on-chain stake custody via one pool-state UTXO per launch plus one position UTXO per stake action (staking itself needs no validator redeemer; only spending a position does). `Graduate` on both curve contracts extended to seed the pool alongside LP.

---

## Track C — Midnight PSM contracts (Compact)

**Built.** 8 PSMs, 214 tests, full ZK proving-key generation (`compact compile`, not just `--skip-zk`). T2/T3 don't gate this anymore — see the TL;DR note above.

### C1. Eligibility Gate PSM (Tier B — merged with DarkVeil, Phase 2 2026-07-11) ✅
**Status:** Shipped. ZK proof verification for allowlist membership; the former standalone DarkVeil PSM (registration, NIGHT bonds, commitment/reveal buying, ratio-based bond refunds) is merged into this same file — Compact has no cross-contract call mechanism, so two contracts could never have shared one cumulative cap. Real Tier B settlement happens on Cardano instead (see B4).

---

### C2. Bonding Curve PSM (Tier C only — merged with Eligibility Gate + DarkVeil, T25) ✅
**Status:** Shipped. NIGHT-denominated quadratic price discovery, 5% cap, fee routing, graduation, DarkVeil registration/buying — all one contract for the same cross-contract-call reason as C1.

---

### C3. Creator Fee Escrow PSM ✅
**Status:** Shipped, with a real architectural finding: this contract never actually holds a real fee for either tier (T51) — Tier B's accrues on the Cardano curve contract (T46), Tier C's accrues inline in C2. `depositFees` is real and tested, just never invoked in the shipped design.

---

### C4. Vesting PSM ✅
**Status:** Shipped, split out of Creator Escrow (2026-07-09) — mixing day-based vesting math with a growing fee accumulator was a real bug, not just mislabeling. Timestamps bound to real chain time (T50, 2026-07-12).

---

### C5. Treasury PSM ✅
**Status:** Shipped. ADA/NIGHT balances split (T6, was a real bug — summed into one meaningless combined number before) with real mark-to-market floor/warning checks.

---

### C6. CTO Governance PSM ✅
**Status:** Shipped. Vote weight verified via a governor-published balance-snapshot Merkle tree ( caller-supplied weight). `hasClaimableBalance` (T36, 2026-07-12) gates `SilenceLockTrigger` so a zero-volume launch can't trigger a CTO vote over nothing.

---

### C7. Staking Rewards Pool PSM (Tier C only) ✅
**Status:** Shipped 2026-07-14 (T66), with a real architectural finding along the way: `bonding_curve.compact` never mints the Tier C launch token as a real coin (tracked only in an internal ledger map), and Compact still has no cross-contract call mechanism — so this PSM can't take real on-chain custody of a stake the way B7 does on Cardano. Two independent verification passes confirmed `mintUnshieldedToken`/`tokenType` ARE real, executable stdlib primitives, which solves reward *minting* — the payout mints live to the staker, real NIGHT claim fee via `receiveUnshielded`/`sendUnshielded` — but not stake custody. Governor-attested stake (same trust model as the allowlist/balance-snapshot trees elsewhere) chosen over merging into the already-audited C2.

---

## Track D — Integration + API layer

**Built.** Real code against verified SDK versions, not scaffolding.

### D1. Blockfrost API client + eligibility checks ✅
**Status:** Shipped. `integration/blockfrost-client.ts` + new `integration/eligibility-checker.ts` (2026-07-12, T8/T65) — real off-chain wallet-age and no-direct-ADA-flow checks feeding the allowlist Merkle tree. NIGHT balance check (#2) confirmed achievable via `midnight-indexer` but not yet built; stake-key check (#4) genuinely blocked on missing cross-chain proof infrastructure.

---

### D2. Oracle price integration ✅
**Status:** Shipped. `integration/orcfax-client.ts` + `minswap-client.ts` + `night-price-oracle.ts` (T65, 2026-07-13) — real ADA/USD datum reads and NIGHT/ADA TWAP, combined into a NIGHT/USD conversion. `integration/ada-price-oracle.ts` (T66, 2026-07-14) adds the ADA-side equivalent for the staking claim fee, reusing the Orcfax client directly (no Minswap triangulation needed). None of these are wired into the live WordPress UI yet — `treasury.compact`'s floor checks and the staking claim fee both still take a pre-converted rate as an argument.

---

### D3. Wallet connection layer ✅
**Status:** Shipped, rewritten against the real `@midnight-ntwrk/dapp-connector-api@4.0.1` (T47, 2026-07-10) — `window.midnight` is a UUID-keyed dictionary, not one object; `.connect(networkId)` replaced `.enable`.

---

### D4. Midnight SDK wrapper ✅
**Status:** Shipped, `integration/midnight-client.ts` rewritten against real `@midnight-ntwrk/midnight-js-contracts@4.1.1`.

---

## Track E — Security + audit

### E1. Smart contract security audit ✅ (internal) / pending (independent)
**Status:** Two full internal adversarial passes complete — Phase 1 (T53-T59, 7 Critical/High findings) and Phase 2 (T60-T63, 4 findings), plus four hardening passes (T50-T52, T64, 2026-07-12). Full writeup in `docs/SECURITY_MODEL.md` and internal tracking. **An independent, professional audit still hasn't happened and remains required before mainnet** — internal review, however thorough, isn't a substitute.

---

### E2. Formal verification
**Status:** Not formally done as a separate mathematical proof exercise, but the properties CLAUDE.md calls out are covered by real, adversarial test coverage instead: bonding curve pricing (floor-rounding double-inequality, T39), LP migration/graduation atomicity (real value-movement checks, T48/T49), Merkle proof soundness (tampered-proof rejection tests, T42/T64).

---

### E3. Preprod deployment + DUST cost measurement
**Status:** Blocked on a stable Midnight devnet, not on contract readiness. Two real attempts (2026-07-10): first blocked by a WSL DNS issue (fixed via `networkingMode=mirrored`); second reached a healthy devnet but hit a reproducible `midnight-node:0.22.5` crash (`txpool-background` task failure) after ~3 minutes. Next step: try a different node image tag. Resolves T5.

---

## Track F — Tier C (Midnight + DarkVeil) — partially blocked

**Updated 2026-07-12.** Two of five original blockers have real progress; two remain genuinely open.

| Issue | Question | Status |
|---|---|---|
| T17 | Midnight fungible token standard — native layer or PSM-only? | De-risked, not resolved — `tokenType`/`mintUnshieldedToken`/`mintShieldedToken` are real, compiler-verified primitives, but the MIPs behind them (MIP-0004, MIP-0011) aren't ratified yet |
| T18 | Tier C graduation target — no confirmed live Midnight DEX | Still open — NorthStar DEX is a preprod-live candidate, mainnet timing unconfirmed |
| T19 | Trade fee currency conversion (NIGHT → stablecoin) | Substantially clearer — the only bridge found is one-way (Cardano→Midnight, NIGHT-only); a bidirectional version is reportedly in development, ETA a few months |
| T20 | Midnight LP Escrow PSM design | Still blocked on T17+T18 |
| T21 | ZK cert relayer (Tier C → Cardano L1) | Resolved — Option B (platform relayer) built for real, including real Cardano-side transaction submission via Lucid Evolution |

Do not scaffold Tier C contract work until T17/T18 clear. When they do, the build order is: token standard confirmation → Midnight Token PSM → Midnight LP Escrow PSM → integrate into the existing C2 merge.

---

## Post-MVP backlog (closed as GitHub issues, tracked here instead)

Matches CLAUDE.md's own "Post-MVP: architect now, implement after launch" classification — never meant to be active pre-launch work, so these were closed as GitHub issues (2026-07-22) rather than left open indefinitely. Revisit after mainnet, not before.

- **T10** — Blockfrost compliance hook (sanctions screening, wallet risk scoring). Architecture already supports this as a hookable module; the modules themselves are the deferred part.
- **T12** — Platform governance (NIGHT holder voting on protocol parameters). Team controls parameters at launch with public disclosure until this ships.
- **T16** — Community-wide yield mechanism (a single protocol-level pool NIGHT holders lock into for overall fee revenue share). Distinct from the per-launch Staking Rewards Pool (T66, shipped — see B7/C7 above), which is narrower and already live.

---

## What we are NOT doing (anti-patterns)

- **No Next.js / React on the public site.** WordPress PHP + vanilla JS only.
- **No platform token.** Revenue in ADA and NIGHT only.
- **No partial graduation.** 100% bonding curve sell-through only — no partial.
- **No withdraw on LP.** It does not exist. Do not build a disabled version either.
- ~~**No staking infrastructure in V1.**~~ Partially superseded (T66, 2026-07-14) — this was scoped against a *platform-wide* yield mechanism (a single protocol pool NIGHT holders lock into for overall fee revenue share), which stays deferred. A narrower, *per-launch* opt-in staking rewards pool (creator-funded from that launch's own supply, not a protocol-wide mechanism) shipped instead — see B7/C7 above.
- **No Tier C contract work until T17 and T18 are resolved.** T19/T21 have real progress (see Track F); premature scaffolding against the remaining two still creates tech debt against an unstable spec.

---

## Shipped

*(Move items here as they land with date. Keeps the active list lean.)*

### T66 — Staking Rewards Pool, all 3 tiers (2026-07-14)
New optional per-launch feature: 25% of supply, manual staking, daily pro-rata rewards over a 3-5 year runway, $1 flat claim fee. Full spec → WordPress (all 3 tiers, home card, How It Works, Create Wizard) → contracts (B7/C7 above) rollout in one session. Tier C build surfaced a real architecture split from Tier A/B (governor-attested stake vs. real on-chain custody) — see C7's status note. `integration/ada-price-oracle.ts` new. 45 new tests (24 Cardano, 21 Midnight), zero regressions. Full detail in internal tracking.

### Tracks B/C/D/E — all contract, integration, and internal-audit work (2026-07-09 → 2026-07-12)
7 Cardano/Aiken validators (137 tests) + 7 Midnight/Compact PSMs (187 tests, full ZK proving keys) + real integration layer (Blockfrost, Midnight SDK, wallet connection, off-chain eligibility checks, ZK cert relayer + Cardano anchor submitter) + two internal security audit passes (11 Critical/High findings fixed) + four hardening passes. Full detail in internal tracking's T22-T65 entries and `docs/SECURITY_MODEL.md`. See the rewritten Track B/C/D/E sections above for the per-item breakdown — moved here as one consolidated entry rather than one row per T-number, since that level of detail already lives in the tracking docs.

### A1 — Home page (2026-06-09)
Full desktop + mobile implementation. Nav (logo, links, wallet connect, hamburger on mobile), hero (Noctis logo above heading on mobile, stat blocks, CTA buttons), features section, footer (Community + Protocol columns). Mobile-responsive.

### A2 — Launches index page (2026-06-09)
Launch card grid with status indicators, tier badges, progress bars, ZK certificate modal. Filter bar: status filter (tabs on desktop, dropdown on mobile), search, tier filter, sort. Mobile-responsive.

### A3 — DV Registration page (2026-06-09)
Full layout: registration form, eligibility checklist, allocation tracker, NIGHT bond display, timer. Mobile layout stacked vertically with doubled placeholder logo. Mobile-responsive.

### A5 — Transparency page — Tier C updated (2026-06-09)
Tier C section added: DUST/NIGHT stats, active Tier C launches table, PSM status. Stats grid updated to 9 launches (2A/5B/2C). ZK cert description updated for Tier C relayer. Ops wallet text updated for launch fee split percentage + NIGHT receipt.

### A6 — Create Launch wizard — Tier C (2026-06-09)
Third tier card (Tier C, violet) added. Config panel for Midnight-native launches. DEX selection hidden for Tier C. Pay summary shows current launch fee split (40% ops / 60% treasury). JS fully wired.

### A — Tier C sample launches × 4 (2026-06-09)
Four Tier C mock launches live: Abyss ($ABYS, DV Active), Spectre ($SPCT, DV Active), Cipher ($CPHR, DV Registration), Nocturne ($NTRN, DV Registration). Full detail pages with NIGHT-denominated UI. Appear on Launches page and in DarkVeil nav dropdown.

### A — DarkVeil page sample shortcuts (2026-06-09)
Bottom CTA section redesigned to show 3 sample cards per state group (Registration + Active). Tier B + Tier C samples side by side.

### A — Nav dropdown — DarkVeil grouped shortcuts (2026-06-09)
DarkVeil nav item expanded to 6 items in two labelled groups (REGISTRATION OPEN / DARKVEIL ACTIVE). Tier C items violet-tinted. Mobile menu updated to match.

### Offline preview builder — updated (2026-06-09)
`build-offline.py` now covers 12 pages (added 4 Tier C launch pages). Output `noctis-preview.html` is 3,573 KB. Originally shipped as 8-page builder on 2026-06-09; `build-offline.py` — Python script that fetches pages from local dev server, inlines all local CSS/JS/images as base64 data URIs, outputs single self-contained HTML file using site nav for page switching via postMessage.
