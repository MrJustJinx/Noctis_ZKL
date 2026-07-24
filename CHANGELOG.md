# Changelog — Noctis Protocol

Running log of what shipped each session. Most recent first.

---

## 2026-07-24 (latest) — Tier B graduation + mint path, stale-schema fix, and a pre-v1 repo audit

### Tier B is now wired end-to-end on the Cardano side
- **Tier B graduation submitter** — `tier-b-graduation-submitter.ts` + `graduate-tier-b-launch` CLI + `np_graduate_tier_b_launch()`, mirroring the Preprod-proven Tier A flow (Graduate + SealLock + StartVesting, T91 two-transaction split, seconds-scale timestamps). Tier B's `Graduate` arm was verified structurally identical to Tier A's, and its redeemer index re-derived from its own enum, before porting. `lp_escrow`/`vesting` are shared validators.
- **Tier B mint path** — the genesis builder took a `tier` parameter, so a Tier B launch finally builds a real `BondingCurveTierBDatum` at the `bonding_curve_tier_b.ak` address. Previously *every* mint built a Tier A datum regardless of tier, which silently made a Tier B launch uncreatable. Verified against the contract that DarkVeil claims draw from the same `curve_supply` — no separate carve-out at genesis.
- **T119's schema half resolved** — all four shared datum shapes in `tier-a-schemas.ts` were stale against the real contracts (missing `cto_governance_credential`/`cto_governance_nft`, and vesting's `last_claimed_allocation_timestamp`). Left unfixed this would have broken **minting and graduation** against current bytecode, not just CTO. Field order re-verified against each `.ak` datum; encode + round-trip decode confirmed. Remaining T119 work is minting the governance thread NFT at deploy.

### Pre-v1 repo audit
- **Secrets sweep — clean.** No API/Blockfrost keys, private keys, seeds, mnemonics, or emails in any tracked file. The long hex strings present are all public on-chain data (tx hashes, launch ids, a Minswap pool id). All security-audit and milestone docs confirmed correctly gitignored, and `git add -A` stages nothing unintended.
- **Personal financial information redacted** from four tracked docs (CLAUDE.md, CHANGELOG.md, internal tracking, internal tracking) — the founding-reserve decision named an individual's personal holdings and amount. Generalised to a founder-provided bootstrap reserve; engineering conclusions (sizing margin) kept, specifics moved to local-only ops notes.
- **Stale docs corrected** — ARCHITECTURE and this changelog had no record of the Tier B work; internal tracking noted the T119 schema sync as still outstanding after it was fixed; PRE_LAUNCH_CHECKLIST predated the new `/how-to/` and `/staking/` pages. All updated. Advertised test counts re-checked against source and confirmed accurate (257 Aiken test blocks).

## 2026-07-14 — T66: Staking Rewards Pool, new optional feature across all 3 tiers, spec → WordPress → contracts

New optional per-launch feature: a creator can allocate a fixed 25% of total supply into a staking rewards pool. Holders manually stake to earn a daily pro-rata share over a creator-chosen 3-5 year runway, claimable for a flat $1 fee (ADA on Tier A/B, NIGHT on Tier C). Superseded T16's "no staking in V1" note for this narrower per-launch case (T16 itself stays open for a future platform-wide mechanism).

### New: CLAUDE.md spec, docs, GitHub issue #72
Added 5 new platform constants (`STAKING_ALLOC_PCT`, `STAKING_DURATION_MIN/MAX_DAYS`, `STAKING_BONDING_PERIOD_DAYS`, `STAKING_CLAIM_FEE_USD` + split) and a full `## STAKING REWARDS (OPTIONAL)` section covering mechanism, reward accounting design, pool seeding, and tier-specific notes. internal tracking/ARCHITECTURE.md/docs/PSM_ARCHITECTURE.md updated to match, including a mid-session correction once the Tier C design changed (see below).

### New: WordPress site — all 3 tiers, home page, How It Works, Create Wizard
`inc/data/tiers.php`/`features.php` (new 6th "Built Different" card), a new How It Works staking section, and a Create Wizard Step 5 toggle (25% allocation + 3/4/5-year runway selection, live supply bar update). Verified live via curl + zero PHP warnings.

### New: contracts/cardano/staking_pool.ak (Tier A + B)
Real on-chain stake custody — one pool-state UTXO per launch, one position UTXO per stake action (staking itself needs no validator redeemer; only spending a position does). Permissionless, value-verified `ClaimRewards`/`Unstake`. `bonding_curve.ak`/`bonding_curve_tier_b.ak`'s `Graduate` redeemer extended to seed the pool alongside LP. 24 new tests, 161/161 Cardano total (was 137).

### New: contracts/midnight/staking_pool.compact (Tier C) — real architecture finding mid-build
Governor-Merkle-snapshot reward accounting, same trust model as `cto_governance.compact`'s balance-snapshot tree. A real constraint surfaced while building this: `bonding_curve.compact` never mints the Tier C launch token as a real Midnight coin (tracked only in an internal ledger map), and Compact still has no cross-contract call mechanism — so a separate contract can't take real custody of a stake the way the Cardano side does. Two independent verification passes (source-investigation against `LFDT-Minokawa/compact@main`, and live compile+execute) confirmed `mintUnshieldedToken`/`tokenType` ARE real, executable stdlib primitives — but that only solves reward minting, not stake custody. Presented as a 3-way choice; chose governor-attested stake over merging into the already-audited 1801-line `bonding_curve.compact`. Reward *claiming* is fully real: mints the payout live via `mintUnshieldedToken`, collects the NIGHT claim fee via `receiveUnshielded`/`sendUnshielded`. 21 new tests, 214/214 Midnight total (was 193).

### New: integration/ada-price-oracle.ts
`usdToMinAdaLovelace` for the Tier A/B ADA-side claim fee, reusing `getOrcfaxAdaUsdPrice` directly (no Minswap triangulation needed, unlike the NIGHT path). Typechecks clean against the existing 4-pre-existing-error baseline.

### Doc-sync fix (same session): CLAUDE.md/internal tracking/ARCHITECTURE.md/internal tracking corrected after the Tier C pivot
The docs were originally written assuming Tier C would mirror Tier A/B's real on-chain custody (using `tokenType`/`mintUnshieldedToken` as described in the approved plan). Once the actual constraint was found mid-build, all four docs were corrected to describe what was actually built and user-confirmed — including a stale internal tracking row that still read "in progress" after the feature had fully shipped, caught when the user asked directly.

### Refreshed: the two living architecture Artifacts + architecture.html now tracked in git
The "Contract & Code Checklist" status dashboard and the tier-by-tier architecture flowchart (previously dated 2026-07-06, showing tested/audited validators as still "planned") were both brought fully current — real contract/PSM node-by-node status, T66 additions in every relevant lane, corrected test counts. `architecture.html` (offline copy of the flowchart) is now committed to the repo for the first time, at the user's request.

---

## 2026-07-12 — Full documentation audit: whitepaper v2, docs corrected against T22-T65, 3 obsolete files removed

Prompted by a direct ask to check GitHub for stale/missing info against everything changed over the preceding several days (T22 through T65), and to bring the whitepaper and spec documents in line with the actual current contract code. Dispatched 5 parallel research agents to audit every tracked doc file against CLAUDE.md and the real contract source; applied every confirmed finding directly. Documentation only — no contract or integration code changed in this pass.

### New: noctis_v2/noctis_whitepaper_v2.html
- `noctis_v1/` (whitepaper, presentation, old CLAUDE.md snapshot) left fully untouched as the historical v1 record, per instruction.
- New v2 whitepaper created as a copy with real fixes applied: removed the Bitcoin Reserve entirely (a fee-model destination removed from the live model on 2026-07-06, but still described in v1 as one of "four destinations" receiving 0.20%) — fee split is now correctly described as three destinations (1.0% creator / 0.6% treasury / 0.4% ops).
- Fixed the "How the Team Gets Paid" section's launch-fee split, which varied per tier (60/40, 53/47, 56/44) and had Tier A's ratio backwards — the real split is a uniform 40% ops / 60% treasury across all three tiers (D5, 2026-07-06).
- Fixed the N-hop challenge window's described trigger timing — v1 said "72 hours after any DarkVeil registration"; the real, just-built mechanism (T9) triggers 72 hours after a claim, not registration, for privacy reasons (a registrant's real wallet isn't linked to DarkVeil until they claim). Updated the Roadmap section to reflect the mechanism is now built, not just planned.
- Updated Tier C's roadmap gating: the ZK cert relayer requirement is resolved (a real relayer + Cardano-side submission exist, T21); the token-standard requirement is de-risked but not fully resolved (real primitives exist and compile, but the formal MIP standards aren't ratified yet, T17).

### Removed: 3 obsolete docs (redundant + built on a retracted claim)
- `docs/INTEGRATION_GUIDE.md`, `docs/DEEP_DIVE_ANALYSIS.md`, `docs/AI_COUSIN_MEMORY_INGESTION.md` — all three landed in one 2026-07-09 commit and were never touched again. All three built their central technical content on "transaction merging" as a real Compact primitive — this was formally retracted as fabricated after real probe contracts were compiled against the compiler and every cross-contract call form failed. `INTEGRATION_GUIDE.md`'s code samples called a nonexistent SDK method and referenced the deleted `darkveil.compact`; `DEEP_DIVE_ANALYSIS.md`'s proposed resolutions for T2/T24/T25 are all superseded by different, later, formally-recorded resolutions; `AI_COUSIN_MEMORY_INGESTION.md`'s 8-PSM table and persona framing were never adopted in practice. Nothing unique or still-valuable was found in any of the three (confirmed by direct comparison against the docs that supersede them) — same precedent as the earlier removal of `CONTRIBUTING.md`/`build-offline.py`. Recoverable via git history if ever needed.

### Rewritten: docs/SECURITY_MODEL.md
- Was dated 2026-07-08, before both internal security audit passes (T53-T63, 2026-07-11) and four hardening passes (T50-T52, T64, 2026-07-12) — its "Status: Pre-audit" framing was backwards, and its Incident Response runbook told operators to withdraw fees from a cancelled curve, which now fails on-chain by design (T61 fixed exactly that as a double-drain bug). Also cited a circuit (`checkAndUpdateCap`) that was removed as dead code, and a contract/set (`ObfuscatedOrderbook`/`usedVerifications`) that never existed in this codebase at all — only ever a pattern-inspiration credit in a file header comment, misread as a real component.
- Full rewrite: post-audit framing, corrected threat model (fee custody is per-tier now, not a fixed PSM), corrected cap-enforcement description (inline now, not a standalone circuit), added the N-hop challenge contract (T9) as a new attack-vector/economic-security/incident-response entry, added the off-chain DarkVeil eligibility model correction (checks are Blockfrost-computed + governor-published allowlist, never a client-side ZK proof of Cardano history), added an Audit History section summarizing all 11 Phase 1/2 findings plus the four hardening passes.

### Fixed: docs/PSM_ARCHITECTURE.md (912 lines, largest architecture doc)
- Removed the standalone "4.3 DarkVeil PSM" section — it was presented as a contract still separate from Eligibility Gate despite the rest of the document correctly describing the Phase 2 merge; folded its accurate circuit descriptions into a corrected 4.1.
- Fully rewrote Creator Escrow (4.3) — was still describing pre-2026-07-09 vesting circuits that were split into their own contract; added the T51 finding that this PSM never actually holds a real fee for either tier.
- Added a new Vesting PSM section (4.4) — was completely missing despite being a real, separately-deployed contract.
- Fully rewrote Treasury PSM (4.5) — was describing a single undifferentiated balance the document's own Section 11 already contradicted; updated to the real ADA/NIGHT split (T6).
- Added a new CTO Governance PSM section (4.6) — the single largest gap in the document; this PSM wasn't described anywhere despite being one of the 7 real Midnight contracts.
- Added missing `triggerCTO`/`dissolveCTO` circuits to the Midnight LP Escrow PSM section, plus a callout explaining the T51 CTO fee-redirect fix that affects every fee-bearing contract.
- Added a new N-Hop Challenge Contract subsection and a new "real off-chain DarkVeil eligibility checks" subsection to Section 14 (Cardano Integration).
- Fixed the Privacy Flow diagram and Domain Separation table, which still depicted "DarkVeil PSM" as a contract separate from Eligibility Gate/Bonding Curve, and were missing Vesting and CTO Governance's domain tags entirely (verified the added tags against the real contracts' `persistentHash` calls before adding them).

### Fixed: ARCHITECTURE.md
- Corrected a wrong "Tier C only" label on the ratio-based DarkVeil bond refund — Tier B has had this since T63 (2026-07-11), not just Tier C.
- Added `nhop_challenge.ak` to the Contract-to-Tier Reference table (was completely absent).
- Added a callout for the CTO fee-redirect enforcement (creator fees redirect to the community wallet on a passed CTO vote) and the chain-time-binding of vesting/LP-lock timestamps.
- Updated the footer's stale counts (6→7 Aiken contracts, 234→137 real Aiken tests, added the 187 Compact + 11 zk-proofs counts, date 2026-07-11→2026-07-12).

### Fixed: README.md, ROADMAP.md, PRE_LAUNCH_CHECKLIST.md
- README: Discord line was "TBD" — it's been live and confirmed since 2026-07-10 (`discord.gg/FkFwHFN6Aq`). "What's built"/"What's next" described substantial contract/integration/audit work as not-yet-started; rewritten to reflect that Tracks B/C/D/E are built and tested, and what's left is mostly external (preprod devnet, independent audit, Tier C's remaining blockers).
- ROADMAP: this file had the most drift of any doc audited — every Track B/C/D/E item was still marked `Proposed`/`Blocked on T2, T3` despite all 7 Aiken validators and all 7 Compact PSMs being built, tested, and internally audited. Rewrote the TL;DR and every Track B/C/D/E entry to their real shipped status, added a consolidated "Tracks B/C/D/E" entry to the Shipped section (previously only had 2026-06-09 frontend items despite ~2 months of substantial backend work landing since), and corrected the "No Tier C until T17-T21" anti-pattern note (T19/T21 have real progress now, only T17/T18 still gate new work).
- PRE_LAUNCH_CHECKLIST: fixed a stale "11 sections" claim on the Transparency page (real count is 10, since the Bitcoin Reserve section was removed 2026-07-06); added missing preprod deployment items for `bonding_curve.ak`/`bonding_curve_tier_b.ak`/`vesting.ak`/`nhop_challenge.ak` and the Midnight LP Escrow/CTO Governance PSMs (2 of 7 real PSMs had no deployment checklist item at all); rewrote the Tier B end-to-end flow to include the real `ClaimDarkVeilTokens` claim step and the N-hop challenge test (both entirely missing before); fixed T14's wording from an unresolved "USDM or USDCx" either/or to the actual confirmed choice (USDM).

### Fixed: contracts/midnight/README.md
- Added the T64 Merkle-depth-reduction (32→20) mention to both contracts that use it (`eligibility_gate.compact`, `bonding_curve.compact`, `cto_governance.compact`'s balance-snapshot tree) — the file was touched on T64's own date but never actually mentioned T64's headline change.
- Added `nhop_challenge.ak` to the Tier B architecture diagram (was completely unreferenced despite being a same-day, 2026-07-12 addition).
- Fixed a directly self-contradicting claim in the Cross-PSM Communication section: it said "neither Tier B's Cardano curve nor Tier C's `bonding_curve.compact` has any CTO-awareness at all" — true when written, but T51 (same day) fixed exactly this, and the file's own architecture diagram already correctly showed CTO_GOVERNANCE.COMPACT triggering each dependent contract. The prose contradicted the diagram within the same file.

---

## 2026-07-12 — Privacy/governance architecture audit: CLAUDE.md corrected, no code changes

### CLAUDE.md's Registration Eligibility section + both Data Flow diagrams
- Audited whether CLAUDE.md's described privacy/governance mechanisms still match real Midnight/Cardano ZK capabilities, prompted directly by building T65's `checkWalletAge`.
- Found CLAUDE.md described check #1 (wallet age) as verified via "a ZK proof against UTxO history" generated client-side and verified by a Midnight circuit. This was never achievable: Compact has no cross-contract call mechanism (T2) and no bridge lets a Midnight circuit read Cardano chain state (T19) — a Midnight circuit cannot independently verify a claim about Cardano transaction history in zero-knowledge.
- Confirmed the actual code was never wrong: `eligibility_gate.compact`'s own PRIVACY ANALYSIS section only ever claimed ZK *membership* proof ("allowlist membership is proven via ZK without revealing which entry"), never claimed to verify the underlying eligibility facts. Only CLAUDE.md's higher-level architecture language overclaimed the mechanism.
- The whitepaper (`noctis_v1/noctis_whitepaper_v1.html`) doesn't repeat the claim — it just says "90 days of on-chain activity," no mechanism specified — so it needed no fix. Per Jinx, the whitepaper is a separate, already-known pending sync task, not addressed this session.
- Fixed CLAUDE.md's Registration Eligibility section (added an architecture-correction note) and both Tier B/Tier C Data Flow diagrams (replaced the fictional "ZK Proof Generator (client-side, Cardano history)" step with the real flow: off-chain eligibility computation → governor-published allowlist Merkle root → real ZK proof of membership in that tree).
- Documentation-only fix, same category as the T4/T31/T35 doc-sync corrections — no contract or integration code changed.

---

## 2026-07-12 — T9 resolved: N-hop challenge window (Tier B)

### New contract: contracts/cardano/validators/nhop_challenge.ak
- No fuller spec than CLAUDE.md's 5 constants + one sentence existed anywhere (checked this repo and `HISTORY_ARCHIVE.md`). Designed this session from that alone, with Jinx confirming each real design fork.
- **Tier B only** — Tier C is already fully build-blocked (T17/T18/T19/T20), independent of this feature.
- **Lives on Cardano, not Midnight** — the reporter bond is ADA-denominated, same cross-chain mismatch T24/T46 already solved by moving Tier B's public curve to Cardano entirely. Standalone validator, no changes needed to `bonding_curve_tier_b.ak`.
- **Triggers post-claim, not post-registration** (reinterpreting the constant's literal name) — a registrant's real Cardano wallet is never publicly linked to their DarkVeil participation until they call `ClaimDarkVeilTokens` (T46). Triggering at registration would require deanonymizing every registrant just to make them challengeable. A registrant who never claims is correctly never exposed to a challenge — consistent with internal tracking's existing description of T9 as "post-fact detection," not real-time prevention.
- **NIGHT bounty paid off-chain-orchestrated** — a Cardano script can't send NIGHT directly. The contract returns the challenger's ADA bond on a successful challenge; ops separately sends the NIGHT bounty on Midnight afterward, same pattern used everywhere else this session for cross-chain/cross-contract actions.
- **Resolution is governor-adjudicated** (upheld/rejected) — neither the N-hop transaction-graph evidence nor the submission timing can be independently verified inside a script, same trust boundary as T36's `hasClaimableBalance`. On-chain enforcement stays narrow: hold the bond, enforce the 24h defense window via real chain time (not a caller-supplied claim), pay out correctly (challenger's bond back in full on upheld; 60/40 treasury/ops split on rejection, same ratio as T33's forfeiture split).
- One UTXO per challenge, no continuing datum — resolution is a terminal spend, so there's no "already resolved" state to track on-chain.
- 6 new tests, 137/137 total Cardano tests pass (was 131). T37 (ghost registration) updated to note this mitigation is now real, not just planned — though it remains post-fact only (can't prevent Vector A's dilution, doesn't address Vector B at all).

---

## 2026-07-12 — T8 (check 05) and T65 (check 01) resolved: real off-chain DarkVeil eligibility checks

### New module: integration/eligibility-checker.ts
- **T8, check 05** (no direct ADA flow from creator, 90-day lookback): `checkNoDirectAdaFlow` scans each of the registrant's transactions in the lookback window and fetches real inputs/outputs (new `BlockfrostClient.getTxUtxos`) to check whether the creator's address appears on either side — a genuine per-transaction participant check against public Cardano chain data, not a heuristic.
- **T65, check 01** (wallet age >= 90 days): `checkWalletAge` walks the registrant's full transaction history (new `BlockfrostClient.getAddressTransactionsAll`, real `/addresses/{address}/transactions` endpoint) and compares the earliest transaction's block time.
- **Bonus finding while investigating T8:** checks #1/#2, treated as already-MVP by CLAUDE.md, had ZERO off-chain implementation anywhere in this codebase — only on-chain Merkle-membership verification existed, nothing computed who should get a leaf in the allowlist tree. Filed separately as T65 rather than silently expanding T8's scope.
- **Check #2 (NIGHT balance) investigated, confirmed achievable but not built:** real evidence found in `midnight-indexer`'s GraphQL schema — `unshieldedTransactions(address)` lets a backend independently verify unshielded balance (not wallet self-report). Needs a new indexer GraphQL client + a real Orcfax/Minswap oracle client, neither of which exists yet. Scoped as follow-up (tracked under T65), not built this session.
- **Check #4 (stake key match) investigated, found genuinely blocked:** no way to independently verify a registrant's real Cardano stake key without real cross-chain proof machinery — a witness self-report would be security theater, not a real gate. Needs actual Midnight wallet SDK work. Moved from Post-MVP to Important in internal tracking since it's a real blocker, not "do it later."
- 15 runtime sanity checks pass (temporary probe script, deleted after use — this workspace has no vitest setup, typecheck is the established bar, matching `cardano-anchor-submitter.ts`/`zk-cert-relayer.ts`'s convention). Integration workspace typechecks clean (same 4 pre-existing, unrelated `wallet-connection.ts` errors).

---

## 2026-07-12 — T36 resolved: silence-lock zero-volume edge case

### T36 — fix landed on cto_governance.compact, not the originally-planned contract
- The original plan targeted `creator_escrow.compact`'s `checkCreatorSilence`, but per T51 that PSM no longer holds real fees for either tier (Tier B accrues on Cardano since T46, Tier C accrues inline in `bonding_curve.compact`) — its `lastClaimTimestamp` is vestigial and not wired into anything real. The actual, currently-enforced silence gate lives in `cto_governance.compact`'s `createProposal` (`SilenceLockTrigger` branch, checking `lastCreatorActivity`/`silenceThreshold`).
- Added a new governor-attested `hasClaimableBalance: Boolean` ledger field — same trust boundary already accepted for `lastCreatorActivity` (that contract can't query the curve contract's real balance directly, no cross-contract calls, T2/T25). Set at deploy via a new constructor arg; refreshed together with `lastCreatorActivity` via the same `updateCreatorActivity(timestamp, hasClaimableBalance)` call, since both facts come from the same off-chain observation.
- `createProposal`'s `SilenceLockTrigger` branch now additionally asserts `hasClaimableBalance` — a zero-volume launch can never have a CTO vote triggered over nothing, regardless of elapsed silence time.
- `integration/midnight-client.ts`'s `deployCtoGovernance` takes the new constructor arg; new `updateCreatorActivity()` wrapper added next to the existing `updateBalanceSnapshot()`.
- 2 new tests (rejects zero-balance SilenceLockTrigger; allows it once governor attests a real balance). 187/187 Compact tests pass (was 185), no regressions elsewhere.

---

## 2026-07-12 — T17 research: Midnight fungible token standard, real progress found

### Documentation only, no code changes
- Investigated T17 (blocker: does Midnight have a native fungible token standard, or is a Tier C token necessarily PSM-internal balance state?) against the real `midnightntwrk/midnight-ledger` and `midnight-improvement-proposals` repos, not training data.
- Found the "PSM-only, no alternative" assumption is outdated: `coin-structure`'s `TokenType` is a generic enum (NIGHT is just its reserved zero-domain case), and any contract can derive its own custom token type. Confirmed the corresponding Compact stdlib primitives (`tokenType`, `mintUnshieldedToken`, `mintShieldedToken`) are real — compiled minimal probe contracts against our own installed compiler (v0.31.1), not just read docs or a MIP draft.
- Two MIPs cover this (MIP-0004 Draft, MIP-0011 Proposed) — neither ratified yet, and OpenZeppelin's reference implementation (`compact-contracts` v0.3.0-alpha) is explicitly experimental. T17 stays open but is meaningfully de-risked: a real, ledger-native, wallet-visible Tier C token is achievable today if we choose to build against the pre-1.0 primitives, rather than defaulting to a custom balance-map adapter layer.
- Updated internal tracking's T17 row with the full finding.

---

## 2026-07-12 — Phase 6: Merkle proof depth reduction (32→20) and stale-file-header sweep

### T64 — two explicitly user-approved follow-ups from Phase 5's deferred list
- Reduced the fixed Merkle proof depth from 32 to 20 levels across all 3 witness declarations (`eligibility_gate.compact`, `bonding_curve.compact`, `cto_governance.compact`) and both off-chain tree builders (`packages/zk-proofs/src/eligibility-gate.ts`, `cto-governance.ts`). A real capacity decision (2^N leaves max), not just a performance tweak, so it was put to Jinx rather than picked unilaterally — chose 20 levels: 1,048,576 max registrants/voters, 37.5% fewer in-circuit hash operations per proof than 32.
- Caught and fixed a real test bug while updating the depth-20 test suite: `allowlist-merkle.test.ts`'s "tampered sibling in the padding levels" test hardcoded `i === 31` (the old array's last index) — silently out-of-bounds and a no-op against the new 20-element array, meaning the tamper assertion would keep passing without actually testing anything. Fixed to `i === 19`.
- Completed the stale-file-header sweep deferred from T52: found and fixed 7 genuinely stale claims — `eligibility_gate.compact` still described T46 as unresolved (fixed 2026-07-11) and never documented T51's registration-linkage fix; `bonding_curve.compact` still implied the T51-removed `checkAndUpdateCap` was active; `cto_governance.compact` didn't clarify it can only flip its own state (no cross-contract calls); `creator_escrow.compact`/`treasury.compact` didn't mention their `depositFees` circuits are never actually invoked by either tier's current architecture; `bonding_curve_tier_b.ak` referenced the now-deleted `darkveil.compact`; `contracts/midnight/README.md`'s contract table and architecture diagram still showed the retired standalone `darkveil.compact` and "8 PSMs" (now 7), and the diagram depicted 4 standalone PSMs calling each other — never accurate post-merge; `.npmrc`'s example compile command still listed `darkveil`.
- 185 Compact tests pass (unchanged), 11 zk-proofs tests pass (unchanged), 131 Aiken tests pass (unchanged) — no regressions. Integration workspace typechecks with only the same 4 pre-existing, unrelated `wallet-connection.ts` errors.

---

## 2026-07-12 — GitHub issue tracker paper-trail sync

### Documentation only, no code changes
- Closed [#48](https://github.com/MrJustJinx/Noctis_ZKL/issues/48) (T46) on GitHub — it had been sitting open despite being resolved in-repo since 2026-07-11.
- Filed and closed GitHub issues for T50/T51/T52 (Phases 3–5's findings), which had never been filed at all: [#52](https://github.com/MrJustJinx/Noctis_ZKL/issues/52), [#53](https://github.com/MrJustJinx/Noctis_ZKL/issues/53), [#54](https://github.com/MrJustJinx/Noctis_ZKL/issues/54).
- Retroactively assigned T53–T63 to the 11 Critical/High findings from Phase 1's audit-compact pass (7 items, commit `4bd8b37`) and Phase 2's 10-category review follow-up (4 items, commit `aecfd6a`) — these were fixed directly in the same pass as found and never individually T-numbered at the time. Filed and closed as GitHub issues [#55](https://github.com/MrJustJinx/Noctis_ZKL/issues/55)–[#65](https://github.com/MrJustJinx/Noctis_ZKL/issues/65), with full write-ups added to internal tracking and summary rows in internal tracking.
- All 20 issues touched in this pass were already resolved in-repo before filing — every GitHub issue was created and closed the same session, none reflect new work.

---

## 2026-07-12 (latest) — Phase 5: payout-address sanity checks, pure modifiers, privacy analysis sync

### T52 — hygiene pass across all 7 Compact contracts
- Added an empty/all-zero recipient-address guard to all 9 circuits taking a caller-supplied `recipientAddr` (bond/fee refund claims across `bonding_curve.compact`, `eligibility_gate.compact`, `creator_escrow.compact`, `treasury.compact`) — a fat-fingered destination would previously silently burn the claim, since `sendUnshielded` doesn't reject a zero address itself.
- Extended the same guard to all 4 `triggerCTO` circuits — an empty community wallet would silently make every future CTO-redirected claim un-routable, a larger blast radius than a single claimant's mistake. Aiken's `TriggerCTO` redeemers already had this check from T51.
- Marked `verifyFeeSlice`/`verifyRatioRefund` (both tiers) and `treasury.compact`'s `computeAdaEquivalent` as `pure circuit` — parameter-only, no ledger/witness access. Checked each candidate's body first; `verifyPrice` and `verifyAllowlist` were correctly left non-pure (they read ledger state / call a witness).
- Fixed stale content in `bonding_curve.compact`'s PRIVACY ANALYSIS section: removed a reference to the already-deleted `getAllowlistLeaf` witness, added the T51 CTO fields (`ctoTriggered`/`communityWallet`) to the on-chain inventory.
- Audited every `export ledger` field across all 7 contracts for miscategorization (should-be-`sealed` fields that never actually change) — found none; documented as checked.
- 11 new regression tests across 6 test files. 185 Compact tests pass (was 174), 0 failures.
- Deferred to a future pass: full stale-file-header sweep, Merkle-proof depth reduction for the 32-level allowlist/balance-snapshot proofs.

---

## 2026-07-12 (latest) — Phase 4: orphaned code, DV-registration linkage, and a CTO fee-redirect gap across all 3 tiers

### T51 — cleanup items plus a significant CTO governance gap found along the way
- Removed orphaned `checkAndUpdateCap` from `eligibility_gate.compact` (Tier B) — nothing called it, `revealBuyCommit` already enforces the same cap inline. Ported its boundary-condition test coverage onto `revealBuyCommit` instead of losing it.
- Fixed DarkVeil-registration-not-linked-to-buying in both tiers: `submitBuyCommit` let any wallet submit a private buy commitment with zero proof of prior registration, bypassing the wallet-age/allowlist/NIGHT-bond eligibility gate. Fixed by requiring the caller to recompute their own registration nullifier and prove it's already public in `registrationNullifiers` — proves registration without revealing which registrant.
- Corrected stale "transaction merging" comments across `creator_escrow.compact`, `treasury.compact`, `cto_governance.compact`, `lp_escrow.compact`, `vesting.compact`, and `contracts/midnight/README.md` — Compact has no cross-contract call mechanism (T2/T25); these are always separate, off-chain-sequenced transactions.
- **Found while fixing those comments:** CTO governance never actually redirected bonding-curve creator fees in ANY tier. `bonding_curve.ak` (A), `bonding_curve_tier_b.ak` (B), and `bonding_curve.compact` (C) all had zero CTO awareness — a creator could keep claiming trade fees regardless of a passed CTO vote. `creator_escrow.compact`/`treasury.compact`'s own CTO-redirect logic was disconnected too — neither tier's curve deposits into them anymore (T45/T46 moved fee accrual onto the curve contracts directly).
- Fixed by mirroring `lp_escrow.ak`'s already-proven T13 `HarvestFees` pattern onto all three curve contracts: `cto_triggered`/community-wallet fields, governor-only `TriggerCTO`/`DissolveCTO`, and the creator-fee claim redirects to the community wallet once triggered. `integration/midnight-client.ts`'s `executeCtoProposal` now also triggers Tier C's bonding curve.
- 174 Compact tests pass (was 168), 262 Aiken tests pass (was 234) — 0 failures. Integration workspace typechecks clean.

---

## 2026-07-12 — Phase 3: vesting/LP-lock timestamps bound to chain time

### T50 — vesting.compact + lp_escrow.compact trusted caller-supplied timestamps outright
- `claimVested`'s `currentTimestamp` was entirely creator-supplied with no binding to real chain time — the creator could claim their whole token allocation on day one, no governor involvement needed. Fixed via `blockTimeGte(currentTimestamp)` (can't claim a time that hasn't happened yet)
- Tracing the fix further found `startVesting`'s `startTimestamp` anchor had the identical gap one level up: a governor setting an artificially old anchor would inflate every later `claimVested` call's elapsed time regardless of how honest `currentTimestamp` was. Fixed with a symmetric ±1-hour window (`blockTimeGte`/`blockTimeLte`) — not exact equality, since block time is approximate
- Same anchor-forgery shape existed in `lp_escrow.compact`'s `sealLock` (governor sets `lockTimestamp`) — same ±1-hour window fix
- `lp_escrow.compact`'s `migrateLp`/`isLockExpired` had their `currentTimestamp` parameter removed entirely rather than just bounded — a pure deadline comparison doesn't need a caller-supplied value at all, same idiom as `bonding_curve.compact`'s `expireCurve`
- `disclose()` placement caught by the compiler on first attempt: goes on the raw parameter passed into `blockTimeGte`/`blockTimeLte`, not around the boolean result
- Test suites rewritten to pin simulator block time via `nextContextAtTime` instead of arbitrary small timestamps (which would now fail the new bounds) — 32/32 tests pass across `vesting.test.ts`/`lp_escrow.test.ts` (10 new anchor-forgery regression tests), 170/170 total Compact tests pass
- internal tracking updated — filed and resolved as T50

---

## 2026-07-11 (latest) — T46 resolved: Tier B DarkVeil settlement + a privacy fix found in the same investigation

### T46 — Tier B DarkVeil had zero ADA payment or token delivery, on either chain
- Investigating the original T46 scope ("Compact can't enforce Tier B's ADA payment") found the real gap was bigger: no mechanism anywhere — Midnight or Cardano — actually delivered tokens or charged ADA for a Tier B DarkVeil purchase. The pre-seeded `identity_purchases` cap list only ever fed the 5% cap check; it was never wired to a real settlement
- Same investigation surfaced a second, independent problem: that pre-seed published every DarkVeil registrant's `(wallet, amount)` pair in plaintext on Cardano at deploy time, regardless of whether the wallet ever transacted again — a direct violation of CLAUDE.md's "Private forever: Individual buy amounts" promise. Flagged mid-fix (Jinx: "DarkVeil ... should always be privacy focused") before building anything further on the leaky mechanism
- Fixed both together via a new permissionless `ClaimDarkVeilTokens` redeemer on `contracts/cardano/bonding_curve_tier_b.ak`: a Merkle root (`dv_allocation_root`) replaces the plaintext list, anchored once at DarkVeil close; a buyer claims by presenting their own privately-known `(dv_amount, salt, merkle_proof)`, pays the flat DarkVeil price in real ADA, receives their tokens, and is nullified against double-claim (`dv_claimed`). Nobody's DarkVeil amount is published on Cardano unless and until that wallet claims — and even then, only their own amount
- `identity_purchases` (the cumulative 5%-cap tracker) now starts empty at deploy instead of being pre-seeded — it gains an entry per wallet only as that wallet actually transacts (claim or public buy), same cap enforcement, no upfront disclosure
- `revealBuyCommit` (Tier B's merged `eligibility_gate.compact`) needed no change — it was already correct as a private commit/reveal of intent; the ADA/token settlement was never going to happen there
- Follow-on doc correction: T45's "Stream A1 (Midnight) / Stream A2 (Cardano)" fee split for Tier B described a Stream A1 that never actually accrued a real fee (Compact couldn't enforce the ADA payment it would have needed). All Tier B creator fees now accrue as one balance on the Cardano curve contract, same pattern as Tier A
- `contracts/cardano/bonding_curve_tier_b.ak`: 37 tests (was 26), 11 new — 4 Merkle-proof helper unit tests, 1 salt-binding test, 6 full validator-level `ClaimDarkVeilTokens` tests (success, double-claim, wrong-salt, creator-claim, payment-not-received, cap-breach). 234/234 total Cardano contract tests pass
- CLAUDE.md, ARCHITECTURE.md, docs/PSM_ARCHITECTURE.md, internal tracking, internal tracking all updated to match — T46 moved to Resolved, T45 marked superseded

---

## 2026-07-10 — Documentation consistency pass: ARCHITECTURE.md + PSM_ARCHITECTURE.md

### Docs — brought both architecture references current against T24/T25/T29/T30/T48/T49/T13/T21/T32/T33/T43/T45/T46
- `ARCHITECTURE.md`: added a new "Graduation Flow (Tier A/B — LP Seeding)" section with a full ASCII diagram of the T49 `Graduate` → `SealLock` → Locked flow (permissionless idiom, the bonus `BuyTokens` token-sourcing fix); fixed the stale claim that graduation "doesn't actually move funds yet" (T49 resolved that); added T13's `HarvestFees` mention; updated the ZK Anchor Contract row for T21's real Cardano tx-submission capability; updated test counts (134 Compact / 106 Aiken)
- `docs/PSM_ARCHITECTURE.md`: this document predated T24 (Tier B's bonding curve moving off Midnight onto Cardano/Aiken) and T25 (Tier C's three-way PSM merge) entirely, and contained one actively false technical claim — that Compact supports "transaction merging" as a native cross-PSM mechanism. It doesn't; this session's own T25 research confirmed no cross-contract call mechanism of any kind exists in Compact, only compile-time contract merging (`include`/`module`). Rewrote: system topology diagram (per-tier now, not one shared Midnight box), Tier B/C flow descriptions, the "Six PSMs" framing (now tier-dependent — Tier B keeps 2 standalone Midnight PSMs, Tier C merges 3 into 1), the Bonding Curve PSM section (now correctly Tier-C-only), the LP Escrow PSM section (now correctly Tier-C-only, Tier A/B use the Cardano contract), Section 5 in full (retracted the false claim, explained what T24/T25 actually did and why), the bonding curve math section's Tier B curve-environment claim, the graduation subsection (T49's real mechanism), the LP lock section (T30's real multisig+72h whitelist governance), the fee accumulator table (T45's Stream A1/A2 split, T6's currency-split treasury), the end-to-end Tier B data flow diagram, the DarkVeil failure-path section (T22's real "converts to public" resolution, not discretionary cancellation), a new stalled-curve-timeout-and-buyback subsection (T29 + T48, didn't exist before), and the glossary's "transaction merging" entry
- Both files were edited for correctness against the actual current contracts, not just re-described from memory — closes the "flag if asked to touch it again" deferral noted after the previous session's batch-2 work

---

## 2026-07-10 — T5 devnet attempt #2: DNS fixed for real, hit a node-software crash

### T5 — real fix for the DNS blocker, found a deeper node-stability issue
- Fixed the WSL DNS-resolution timeout from the earlier attempt for real (not a workaround): WSL2's `networkingMode=mirrored`, set via `%USERPROFILE%\.wslconfig` (Windows-side, no WSL root needed) plus `wsl --shutdown` to apply. Confirmed: the same DNS lookup that was timing out now resolves in under a second — a legitimate, reusable fix for future WSL+Docker work in this environment
- With DNS fixed, the devnet image pull completed and all three containers (node/indexer/proof-server) came up healthy — confirmed via `docker ps` and direct HTTP 200s against all three health endpoints
- Set up a real funded-wallet test using the `midnight-wallet` plugin's `managing-test-wallets` skill (genuine HD-derived keys, `WalletFacade`, pinned SDK versions) and got as far as wallet sync against the live node
- The devnet died mid-sync, twice, reproducibly within ~3 minutes of startup. `docker logs midnight-node` showed the exact cause: the node produces blocks completely normally, then `Essential task 'txpool-background' failed. Shutting down service.` — a Substrate-internal crash in the `midnight-node:0.22.5` image itself, not a networking or config issue. Confirmed reproducible on a fresh restart
- Left a clean stopped devnet, not a crash-looping one. Next attempt should try a different node image tag before repeating the wallet-funding/DUST/contract-deploy sequence — DNS is already solved, no need to redo that part

### GitHub sync
- Commented #6 (T5) with both findings

---

## 2026-07-10 — T44 re-checked against newer SDK releases

### T44 — compact-js invariance workaround still needed
- Downloaded real tarballs for `compact-js` 2.5.3 (latest stable) and 2.5.5-rc.7 (latest pre-release) — `CompiledContract<in out C, ...>` still declares `C` invariant in both, byte-for-byte same signature as the pinned 2.5.1. The `compact-adapter.ts` workaround stays necessary
- `midnight-js-contracts`/`midnight-js-protocol` already at latest (4.1.1), nothing to bump
- Separate finding: 2.5.3 currently can't even be installed — `npm install` 404s on an unpublished peer dependency (`@midnight-ntwrk/ledger-v9@^0.1.0-alpha.1`), confirmed via a clean scratch install. Staying pinned at 2.5.1 is correct right now, not just unaddressed inertia

### GitHub sync
- Commented #46 (T44) with the re-check findings

---

## 2026-07-10 — T7 fully resolved: Discord secured

### T7 — Discord server secured, closing out domain + social handles
- Jinx: [discord.gg/FkFwHFN6Aq](https://discord.gg/FkFwHFN6Aq) — confirmed live via fetch, resolves to a real active server named "Noctis"
- All three original "register before public announcement" items now done: domain (`noctis.zone`), Twitter/X (`@Noctis_ZKL`), Discord
- Left open as a separate, optional, non-blocking decision: whether to register `noctis.fi`/`noctis.io` as defensive backup domains — was always a "consider," not part of the original requirement
- Updated CLAUDE.md (moved to RESOLVED), internal tracking, internal tracking

### GitHub sync
- Closed #8 (T7) with resolution comment

---

## 2026-07-10 — T19 timeline update from Jinx

### T19 — bidirectional bridge expected in a few months
- Jinx: a bidirectional version of the Cardano↔Midnight bridge is in development, expected live within a few months
- Once live, resolves the "no route off Midnight for NIGHT fees" half of T19 directly — Tier C fees could bridge to Cardano and swap through the existing Tier A/B stablecoin path, no new mechanism needed
- Not yet independently confirmed against a public proposal — recorded as Jinx's own expectation, not verified fact. Revisit in ~Q4 2026 rather than treating as an indefinite blocker
- Updated CLAUDE.md, internal tracking, internal tracking

### GitHub sync
- Commented #12 (T19) with the timeline update

---

## 2026-07-10 — T34 decided, T5 real-devnet attempt blocked by environment networking

### T34 — Initial NIGHT bootstrapping source decided
- Decided: primarily pursue an external funding route, with a founder-provided bootstrap reserve as fallback/supplement (amounts and source kept in local-only ops notes)
- Option B (funding from the first launch's own fee revenue) explicitly rejected — chicken-and-egg risk, the first launch's own DarkVeil phase needs DUST before its fee has converted
- Exact quantity still depends on T5's real DUST cost measurement — this decides the source, not the amount

### T5 — real devnet measurement attempted, blocked by environment networking (not a code gap)
- Generated a real local Midnight devnet Docker Compose file (node 0.22.5 / indexer 4.2.1 / proof-server 8.1.0) via the midnight-tooling plugin's version resolver
- Installed `jq` locally without root (static binary to `~/.local/bin`) after discovering `sudo` requires a password unavailable in this session
- Image pull failed 4 times at the same DNS-resolution-timeout pattern (WSL's internal resolver `10.255.255.254` timing out reaching Docker's registry CDN) — a different blob each attempt, ruling out one bad layer; genuine network/environment limitation, not fixable without root access to `/etc/resolv.conf`
- Documented as a real attempt with a real blocker, not silently left theoretical

### GitHub sync
- Commented #32 (T34) with the decision, #6 (T5) with the attempt/blocker

---

## 2026-07-10 — T4: FDV labeling — already resolved on the live site, doc-sync only

### T4 — Graduation FDV vs Current FDV distinction
- Checked the live WordPress theme before treating this as still-open (same discipline as T30/T31/T35) — `lp-chart-buy.php`/`lp-chart-buy-tier-b.php` already show GRADUATION FDV and CURRENT FDV as two clearly labeled panels side by side, with an explicit `<!-- issue T4 -->` comment marking the intent
- Post-graduation summary correctly shows only the fixed GRADUATION FDV and links out to the DEX for live pricing, rather than trying to show a figure Noctis doesn't own post-graduation
- No launch-card or archive template shows FDV at all, so there's no unlabelled figure anywhere
- No code change. Added the resolution to CLAUDE.md's T4 section

### GitHub sync
- Closed #5 (T4) with resolution comment

---

## 2026-07-10 — T7/T19/T21 research pass, T21's Cardano submission built for real

### T7 — Twitter/X confirmed secured
- [@Noctis_ZKL](https://x.com/Noctis_ZKL) (matches the GitHub org name), not the `@NoctisProtocol`/`@NoctisLaunch` candidates originally proposed — confirmed directly by Jinx. Discord still needed

### T19 — NIGHT→stablecoin conversion research: narrows the problem, doesn't solve it
- Found the only protocol-level Cardano↔Midnight bridge (midnight-improvement-proposals#20): unidirectional (Cardano→Midnight only, cNIGHT→mNIGHT), NIGHT-only, ~12h finality
- This means the previous "bridge NIGHT back to Cardano then swap" default has no bridge to actually use — the only bridge that exists goes the wrong direction. Treasury PSM's NIGHT balance should be expected to sit unconverted indefinitely until a reverse bridge or Midnight-native stablecoin swap exists

### T21 — Cardano transaction submission built for real
- New `integration/cardano-anchor-submitter.ts`, `LucidAnchorSubmitter implements CardanoTxSubmitter`, using `@lucid-evolution/lucid` (confirmed real/published/maintained; Anvil's real docs site checked first, no generic custom-redeemer spend endpoint found)
- Data schemas hand-mirrored from `contracts/cardano/plutus.json`'s real compiled CIP-57 blueprint for `zk_anchor`, not the `.ak` source
- Two real mistakes caught by `tsc` and fixed against verified Lucid Evolution examples, not guessed: no-field Aiken enum variants are `Data.Literal` string literals, not `{Variant: {}}` wrapper objects; `Data.to`/`Data.from`'s schema argument needs an `as unknown as StaticType` cast (confirmed against Lucid Evolution's own test suite)
- Full integration workspace typechecks clean, zero new errors
- Not done: an actual submission against a live node — needs a funded relayer key that doesn't exist in this session, flagged explicitly rather than claimed as tested

### GitHub sync
- Commented #8 (T7), updated #12 (T19), closed #14 (T21)

---

## 2026-07-10 — T35: creator CTO vote — already resolved in code, doc-sync only

### T35 — Creator token participation in CTO governance vote
- Investigated before asking the user to decide (same discipline as T30/T31) — found `cto_governance.compact`'s `castVote` already implements this file's own "Proposed approach" exactly: creator votes are capped at `creatorVoteCap` (not excluded, not unlimited), and `creatorYesVotes`/`creatorNoVotes` are tracked as a separate public field for community audit
- Implemented alongside T41's same-day fix (2026-07-09) — the source is already commented `// T35` at both the cap and the audit-tracking lines — but internal tracking/CLAUDE.md never got updated to reflect it, same class of drift as T31's anchor mechanism
- No code change. Added a new "Creator Vote Participation" subsection to CLAUDE.md's CTO GOVERNANCE section (previously undocumented there at all)

### GitHub sync
- Closed #33 (T35) with resolution comment

---

## 2026-07-10 — T6 + T13: treasury floor check + LP fee harvest

### T6 — Treasury ADA/stablecoin floor, built on top of a real currency-mixing bug
- Found while implementing: `treasury.compact`'s `treasuryBalance` summed ADA and NIGHT deposits into ONE combined number with no unit conversion — 1000 lovelace + 500 NIGHT atomic units became a meaningless "1500." The existing test suite's own "SAME shared treasury... both currencies" test exercised this and treated it as correct
- Split into `adaBalance`/`nightBalance` (+ lifetime counters split the same way); `withdrawFees` now takes a `currency` arg
- Bonus fix: `withdrawFees` never actually paid out NIGHT via `sendUnshielded` — ledger-only decrement before this, same "claim without real value movement" class of bug as T29/T43/T33
- New read-only circuits `getAdaEquivalentBalance`/`isBelowFloor`/`isBelowWarning` — take an off-chain-computed `nightPriceLovelacePerAtomicUnit` so only multiplication is needed on-chain (Compact can't divide in-circuit), using the same 124-bit-ceiling operand-width handling as `bonding_curve.compact`'s `verifyPrice`
- Advisory, not an on-chain gate — no launch-creation circuit exists to attach a block to, and Compact has no cross-contract calls (T2/T25) regardless. New `checkTreasuryHealth()` helper in `integration/midnight-client.ts` is the intended off-chain call site; wiring it into the actual WordPress launch-creation flow is a separate follow-up
- Bonus doc fix: `NoctisMidnightClient`'s class comment claimed no PSM is ever shared across launches — true for 7 of 8, false for treasury (its own header always said "single shared pool"). Corrected
- Tests: `treasury.compact` 15 (was 9). 134/134 total Compact PSM tests pass

### T13 — LP fee harvest, DEX-agnostic
- New permissionless `HarvestFees { harvested_amount }` redeemer on `lp_escrow.ak` (CLAUDE.md's Stream B — "paid directly to fee_recipient" — has to route through this contract since the LP itself is locked at a script address, not a wallet)
- Verifies only what it CAN verify regardless of which DEX is involved: the locked `lp_token_amount` is byte-for-byte unchanged (`lp_position_untouched` — the whole point, so this can never become a backdoor withdraw()), and the correct recipient actually receives the harvested lovelace (`fee_recipient_paid`, redirects to the community wallet once CTO triggered, same rule as `is_authorized`)
- Deliberately does NOT model any specific DEX's real harvest call — CSwap/Minswap/Splash/Spectrum's actual fee-harvest APIs remain genuinely unconfirmed, same external-research category as T18's DEX search
- Tests: `lp_escrow.ak` 26 (was 21, +5). 106/106 total Cardano contract tests pass

### GitHub sync
- Closed #7 (T6), #9 (T13) with resolution comments

---

## 2026-07-10 — T49: graduation → LP seeding mechanism built

### T49 — Graduate redeemer implemented on both Tier A/B curve contracts
- New permissionless `Graduate` redeemer on `bonding_curve.ak`/`bonding_curve_tier_b.ak` — same "the condition is the authorization" idiom as `ExpireCurve`, verified by real value movement rather than a signature
- Two new datum fields: `lp_escrow_credential` (this launch's own LP Escrow address, fixed at deploy so Graduate can't be redirected) and `lp_reserve_tokens` (15% of TOTAL_SUPPLY, held in the curve's UTXO from deploy alongside the sellable `curve_supply`, untouched by BuyTokens/ClaimBuyback); `lp_seeded: Bool` guards double-seeding
- Two new helpers (`graduation_funds_left_curve`, `lp_seeding_output_ok`) mirror T48's buyback helpers — verify the curve's balance actually shrinks by `total_raised`/`lp_reserve_tokens` AND that an output at `lp_escrow_credential` actually receives them
- Curve is not fully consumed by Graduate — fee accumulators stay claimable after, matching CLAUDE.md's Stream A description

### `lp_escrow.ak` — SealLock reworked to close the loop
- Previously governor-signature-only with no value check at all. Now takes `seeded_ada: Int`, is itself permissionless, and verifies real arrival via new `lp_value_received` helper (continuing output must actually hold `seeded_ada` more lovelace + exactly `lp_token_amount` of the launch token)
- A real graduation tx spends both the curve UTXO (`Graduate`) and the LP escrow UTXO (`SealLock`) together — each script verifies its own half independently

### Bonus fix found while designing this
- `BuyTokens`'s `token_delivered` check never verified the curve's OWN reserve actually shrank — only that "some output" received tokens. Matters now that `lp_reserve_tokens` sits in the same UTXO: a self-supplied fake "delivery" could inflate `tokens_sold` (falsely triggering Graduated) without real depletion, letting Graduate try to pay out a reserve that was never backed
- Fixed via new `curve_token_balance_decreased` check on both curve contracts, applied to BuyTokens alongside `payment_received`/`token_delivered`

### Tests
- `bonding_curve.ak` 35 (was 29, +6). `bonding_curve_tier_b.ak` 26 (was 22, +4). `lp_escrow.ak` 21 (was 19, +2, plus existing SealLock tests reworked for the new signature). 101/101 total Cardano contract tests pass

### GitHub sync
- Closed #51 (T49) with resolution comment

---

## 2026-07-10 — Group B design forks: T14/T27/T30/T31/T48 resolved, T49 filed

### T14 — Stablecoin selection: USDM confirmed
- No contract change needed — `treasury.compact` handles conversion generically. DEX swap mechanism/custody format/disclosure format remain open operational details

### T27 — LP seeding ADA source: Option A confirmed (all net-of-fee curve ADA)
- Matches the whitepaper's worked examples exactly
- Real gap found while resolving this: **no code anywhere actually performs the graduation-to-LP transfer** — `Graduated` is just a `curve_state` flag, no `Graduate`/`SeedLp` redeemer exists on any contract. Split out as new blocker **T49** (#51) rather than silently declared resolved

### T48 — Stranded Tier A/B curve principal: pro-rata buyback implemented
- New `ClaimBuyback { token_amount, buyer_key_hash }` on `bonding_curve.ak` and `bonding_curve_tier_b.ak` — holder returns tokens, receives `total_raised * token_amount / tokens_sold` computed with real on-chain division (Aiken's `Int` is arbitrary-precision — no floor-check pattern needed, unlike every equivalent Compact circuit this session)
- Two new helpers (`buyback_tokens_returned`, `buyback_share_paid`) verify real asset movement both directions, same discipline as `payment_received`/`token_delivered`
- Confirmed via cross-multiplication that decrementing `tokens_sold`/`total_raised` on each claim keeps every subsequent buyer's ADA-per-token ratio exactly constant — claim order never disadvantages anyone
- Explicitly documented as distinct from LP withdrawal (CLAUDE.md's "no `withdraw()` for LP, ever" is unaffected — this only exists pre-graduation, on curves that never reached LP seeding)
- Tests: `bonding_curve.ak` 29 (was 24, +5). `bonding_curve_tier_b.ak` 22 (was 19, +3)

### T30 — LP whitelist governance: multisig + 72h notice implemented for real
- Found along the way: `lp_escrow.ak`'s own file header already claimed "T30: Option B — multisig + 72h notice" since the file was rewritten, but the actual `AddDex`/`RemoveDex` redeemers only ever required one governor signature with immediate effect — the header described the intended design, the code never built it
- Replaced both redeemers with `ProposeDexChange` (requires `multisig_threshold`-of-`multisig_signers` real signatures, M/N is a deployment-time choice not hardcoded) → 72h wait (`dex_change_notice_period`) → `ExecuteDexChange` (permissionless once due — same "deadline is the authorization" idiom as T29's `ExpireCurve`) → or `CancelPendingDexChange` (multisig-gated withdrawal)
- Tests: `lp_escrow.ak` 19 (was 11, +8)

### T31 — CTO governance anchor mechanism: already resolved, just undocumented
- `cto_governance.ak`'s file header has said "T31 Resolution: Open relay (Option C)" since it was first written, and the code already implements it — `AnchorVoteResult` requires no special authorization beyond the proof bundle hash and business-rule checks
- Documentation-sync fix only — internal tracking/CLAUDE.md just never reflected a decision the code had already made

### Doc sweep
- CLAUDE.md: Migration Whitelist section, CTO Governance section (new Anchor Mechanism subsection), Graduation/LP Seeding section, Key Design Principle #5 (explicit T48-vs-withdraw distinction), Fee Split table, Team Revenue Sources table — all updated to match
- Removed the now-resolved `[T14]` open-issue block from CLAUDE.md entirely (this repo's convention: resolved items get merged into the living spec text, not kept struck-through, unlike internal tracking's audit-trail tables)

### GitHub sync
- Closed #10 (T14), #26 (T27), #28 (T30), #29 (T31), #50 (T48) with resolution comments
- Filed and labeled #51 (T49) as a new blocker

---

## 2026-07-10 — T33 resolved: forfeited NIGHT actually routed, 60% treasury / 40% ops

### The decision
- Offered three options: ops wallet only (this file's own old proposed default), treasury only (CLAUDE.md's literal wording), or a 60/40 split matching D5's launch-fee-split ratio. User chose the split — reuses an existing precedent instead of an all-or-nothing choice

### Implementation, Tier C only (`contracts/midnight/bonding_curve.compact`)
- Two new sealed ledger fields, `treasuryAddr`/`opsAddr` — real unshielded addresses, not derived identities, fixed at deploy same as `governorKey`/`creatorKey`
- `claimRatioBondRefund` gained a third param, `claimedTreasuryShare`, verified as the floor of `forfeited * 6000/10000` by reusing the existing `verifyFeeSlice` helper (previously only used for the 2% trade fee slices — generic enough to reuse directly). `opsShare` computed on-chain as the exact remainder, not caller-supplied, so no NIGHT is lost to a second independent floor-rounding
- Both shares now actually get paid via `sendUnshielded` in the same circuit call as the buyer's own refund — no sweep circuit, no cross-contract call, since `sendUnshielded` can target a fixed real address directly regardless of which contract holds the funds
- Deliberately NOT reusing `BONDING_CURVE_TREASURY_BPS`/`OPS_BPS` in `integration/midnight-client.ts` — those are 0.6%/0.4% of a trade's gross payment, a 100x-different meaning from 60%/40% of a forfeited bond. New `FORFEITED_BOND_TREASURY_BPS` constant and `computeForfeitedTreasuryShare()` helper instead

### Every "forfeited to treasury" claim across the project, fixed to match
- CLAUDE.md's NIGHT Bond Return Formula section and TEAM REVENUE SOURCES table
- `docs/PSM_ARCHITECTURE.md`'s NIGHT Bond section and Cross-PSM Communication table
- The live WordPress theme (`template-parts/darkveil/dv-guide.php`, `template-parts/transparency/transparency-content.php`) and their `offline-preview/` mirrors — all previously said forfeitures went 100% to treasury as a flat, specific claim

### Tests
- `bonding_curve.compact`: 47 (was 46) — 1 new test rejecting an incorrect treasury share independently of an otherwise-correct refund claim

---

## 2026-07-10 — T21 partially resolved: ZK cert relayer scaffolded (Option B), Option A ruled out

### Option A ruled out
- Every real Midnight SDK surface inspected this whole session — `@midnight-ntwrk/midnight-js-contracts` (T44/T2), `@midnight-ntwrk/dapp-connector-api` (T47) — is entirely Midnight-side, nothing Cardano-aware. Not a fresh confirmation exercise, just consistent with everything already verified

### Option B scaffolded — real parts real, missing parts honestly stubbed
- New `integration/zk-cert-relayer.ts`: `assembleProofBundle()`/`computeProofBundleHash()`/`computeMetadataHash()` — deterministic JSON canonicalization + Blake2b-256, matching `zk_anchor.ak`'s "Blake2b-256" datum comment exactly. Verified against the real, installed `@noble/hashes/blake2.js` (extracted the actual npm package before writing this) and runtime-tested outside the type system too — produces a real 32-byte hash, confirmed against a known test vector
- New `NoctisLaunchManager.getFairLaunchCert()` client method, same eligibilityGate-or-bondingCurve-style fallback as every other DarkVeil method
- `IpfsPinner` — pluggable interface, no vendor hardcoded (same category of undecided operational choice as T14's stablecoin selection)
- `CardanoTxSubmitter` — deliberately left as a documented interface stub, not faked. This repo has no Cardano transaction-building layer (no cardano-serialization-lib/Lucid/MeshJS), and the `anvil-api` skill's documented endpoints don't cover an arbitrary Plutus-script spend with a custom redeemer — writing a call against an API shape that doesn't exist would've been worse than an honest stub

### Two real bugs found and fixed along the way, in `integration/midnight-client.ts`
- `closeDarkVeil(closeTimestamp, baseSlot)` always passed both args regardless of which handle was connected — but T43's `baseSlot` only exists on Tier C's merged contract; Tier B's standalone `darkveil.compact` still takes one arg (confirmed against the compiled circuit's real arity). Would have broken the first real Tier B DarkVeil close. Fixed to branch on which handle is actually connected
- `claimRatioBondRefund` fell back to `eligibilityGate` the same way every other DV method does — but that circuit doesn't exist on Tier B's contract at all (T43 was Tier C only). Fixed to be Tier C-only with a clear error instead of a confusing runtime failure

### Not yet possible
- Real Cardano transaction submission for the anchor — needs a Plutus-script-spending tx builder added to this repo first (or a confirmed Anvil endpoint that covers it)

---

## 2026-07-10 — T32 resolved: creator locked out of their own launch entirely (0%, all tiers)

### The decision: 0% everywhere, not a "last N%" carve-out
- internal tracking's T32 proposed two options: block only the final N% of graduation sell-through, or a flat 0% creator purchase limit. Chose 0% — simpler (no new state tracking how close to graduation a purchase is) and closes all three listed harms (price manipulation isn't limited to the last N%), not just graduation acceleration

### Implemented across every contract that can accept a buy or DarkVeil registration
- `bonding_curve.ak` (Tier A): `BuyTokens` rejects `buyer_key_hash == datum.creator_pub_key_hash`
- `bonding_curve_tier_b.ak` (Tier B): same check
- `eligibility_gate.compact` (Tier B): `registerForDarkVeil` rejects the creator's identity — this is also CLAUDE.md's DarkVeil eligibility check #3 ("Registrant != creator"), which had never actually been implemented despite being listed as one of three required checks. One fix closes both
- `darkveil.compact` (Tier B): `revealBuyCommit` gets the same check, at zero extra disclosure (caller is already bound to the tx via the commitment-ownership proof)
- `bonding_curve.compact` (Tier C, merged): all three of `registerForDarkVeil`, `revealBuyCommit`, `buyTokens` get the check
- Every contract gained a `creatorPubKey`/`creator_pub_key_hash`-comparable field; Compact contracts got a new sealed `creatorKey` ledger field set once at deploy

### Bonus finding while fixing Tier A
- `bonding_curve.ak`'s `BuyTokens` now binds `buyer_key_hash` to the actual transaction signer (a required signature), matching Tier B, which already did. This binds the buyer identity that both the wallet cap and the creator-participation block rely on, via `list.has(self.extra_signatories, buyer_key_hash)`

### Tests
- `bonding_curve.ak`: 24 (was 22). `bonding_curve_tier_b.ak`: 19 (was 18). `eligibility_gate.compact`: +1. `darkveil.compact`: +1. `bonding_curve.compact`: 46 (was 45)
- `integration/midnight-client.ts`: `deployEligibilityGate`/`deployDarkVeil`/`deployBondingCurve` all take a new `creatorPubKey` arg (three different domain-derived values, not one shared value — see each contract's own identity domain)

---

## 2026-07-10 — T29 partially resolved: permissionless bonding-curve timeout across all 3 tiers

### The gap: 100% sell-through with no forced exit
- Graduation requires full sell-through with no timeout — a poorly-marketed or abandoned curve could stall forever, `CancelCurve` was governor-only with no deadline
- Added `activated_at`/`curveActivatedAt` (stamped at activation) and a new **permissionless** `ExpireCurve`/`expireCurve` action to all three bonding curve contracts: `bonding_curve.ak` (Tier A), `bonding_curve_tier_b.ak` (Tier B), `bonding_curve.compact` (Tier C) — once Active for more than `MAX_CURVE_DURATION_DAYS = 90` (new CLAUDE.md constant, same status as T2's settlement-window default) without reaching Graduated, anyone can force it to Cancelled. No signature needed — the deadline check is the authorization
- Aiken side reuses `cto_governance.ak`'s existing `current_timestamp` + `interval.contains(self.validity_range, ...)` idiom exactly, including its permissionless `ExpireProposal` precedent
- For Tier C this fully closes the loop: `claimCurveRefund` (T24) already existed and gates on `curveState == Cancelled` — the timeout is what makes it reachable without depending on the governor

### What's still open, split out as T48
- Tier A/B deliver tokens atomically at purchase — there's no buyer-side escrow to refund the way Tier C has. Once `ExpireCurve` cancels a stalled Tier A/B curve, the ADA principal already raised has literally no redeemer that extracts it. Whether that becomes a pro-rata buyback, routes to treasury, or stays permanently locked is a real disposition decision, filed separately as T48 rather than decided here

### Tests
- `bonding_curve.ak`: 22 (was 19), 3 new. `bonding_curve_tier_b.ak`: 18 (was 16), 2 new. `bonding_curve.compact`: 45 (was 42), 3 new
- `integration/midnight-client.ts`: new `expireCurve(timestamp)` method alongside the existing `cancelCurve`/`claimCurveRefund`

---

## 2026-07-10 — T47 resolved: Midnight wallet detection rewritten against the real DApp Connector API

### The flagged-but-unconfirmed gap, confirmed and fixed
- `integration/wallet-connection.ts` assumed `window.midnight` is a single wallet object with `.enable()`/`.getPublicKey()`/`.getAddress()`/`.getNetwork()` — a stale v3 API shape that was never verified against real Midnight tooling
- Verified two independent ways against the real, published `@midnight-ntwrk/dapp-connector-api@4.0.1`: cloned the spec + Lace wallet source, and extracted the actual npm package's `.d.ts` files directly
- Real shape: `window.midnight?: { [uuid: string]: InitialAPI }` — a dictionary keyed by a random per-session UUID (CAIP-372-style), not one object. `.enable()`/`.isEnabled()` were removed in v4.0.0, replaced by `.connect(networkId)`. The connected API has no `getPublicKey`/`getAddress`/`getNetwork` — real methods are `getShieldedAddresses()`, `getUnshieldedAddress()`, `getConnectionStatus()`, `submitTransaction()`, `signData()`

### Fixed to match
- `detectMidnightWallet()` → `detectMidnightWallets()` (plural), enumerates `window.midnight` the same way `detectCardanoWallets()` already correctly enumerates `window.cardano`
- `connectMidnightWallet(walletId, networkId?)` now calls `wallet.connect(networkId)`, reads real shielded/unshielded addresses back, and reads the actual connected network from `getConnectionStatus()` rather than trusting the hint it passed in
- `MidnightWalletConnection` now carries `shieldedAddress`/`shieldedCoinPublicKey`/`shieldedEncryptionPublicKey`/`unshieldedAddress`/`walletRdns` (the stable wallet identifier) instead of the nonexistent `publicKey`/`address`
- `WalletManager`/`UseWalletReturn` updated to match (wallet list instead of a single nullable wallet, `walletId` param on connect)
- No other code in the repo referenced the old shape — confirmed via grep — so this was a clean rewrite, not a migration
- `npx tsc --noEmit` on the file: same 4 pre-existing, unrelated Cardano-side errors as before this change, zero new ones

### Filed and closed
- GitHub issue [#49](https://github.com/MrJustJinx/Noctis_ZKL/issues/49), closed same day with the resolution summary — see T47 in internal tracking

---

## 2026-07-10 — T43 fully resolved: ratio-based NIGHT bond refund implemented (Tier C)

### The formula CLAUDE.md always specified, finally implemented
- `NIGHT_returned = NIGHT_bonded × tokens_purchased / tokens_allocated` was never built — root cause was nothing tracking `tokens_allocated` (`base_slot = dv_supply / registered_count`)
- Realized `base_slot` is a FLAT per-capita split — same value for every registrant — so it only needed one new sealed ledger field (`baseSlot`), not a per-user map. Set once by `closeDarkVeil` (now takes a `baseSlot_` param, computed off-chain by the governor once the final registrant count is known)
- Added `dvTokensPurchased: Map<Bytes<32>, Uint<128>>`, updated by `revealBuyCommit`, kept separate from `balances` (which also accrues public-phase purchases) so the ratio isn't polluted by a buyer who also bought publicly
- New `claimRatioBondRefund(recipientAddr, claimedRefund)` circuit — `claimedRefund` computed off-chain (real division is fine there), verified on-chain as the floor of the true ratio via a new `verifyRatioRefund` helper, same cross-multiplication double-inequality pattern as `verifyPrice`/`verifyFeeSlice` (T39). One formula covers every case CLAUDE.md describes — full refund, ghost forfeiture, partial — no special-casing

### Real payout, not just bookkeeping
- `claimBondRefund` (the pre-existing full-refund circuit for cancelled/failed launches) previously only cleared the `lockedBonds` ledger entry — never actually paid the NIGHT back. Both it and the new `claimRatioBondRefund` now call `sendUnshielded` for real, matching the pattern `claimCurveRefund` already established

### Honestly flagged, not fixed
- The forfeited portion of a partial refund isn't routed to treasury yet — same T2/T25-class limitation (no real cross-contract call into `treasury.compact`). Documented in the contract's own comment rather than silently assumed solved
- Tier B unaffected — its DarkVeil bond mechanics don't change

### Test suite grew accordingly
- `contracts/midnight/tests/bonding_curve.test.ts`: 42 tests (was 33) — 9 new covering full refund, 50% partial, ghost (0%), floor-rounding at a non-exact division, rejecting over/under claims, double-claim rejection, and wrong-phase rejection
- `integration/midnight-client.ts`: `closeDarkVeil` takes the new `baseSlot` param; new `claimBondRefund`/`claimRatioBondRefund` client methods; new `computeRatioBondRefund()` off-chain helper

---

## 2026-07-10 — T45 decided: Tier B creator fees stay two separately labeled balances

### Extends an existing convention, not a new one
- CLAUDE.md already established "never merge Bonding Curve Escrow and LP Trading Fees into one number" (Stream A vs Stream B). T45 asked the same question one level deeper: now that T24 split Tier B's Stream A itself across two chains (DarkVeil-phase fees on Midnight, public-phase fees on Cardano), does the dashboard show two balances or try to unify them?
- Decided: two balances, same convention — "Stream A1" (Midnight, Creator Fee Escrow PSM) and "Stream A2" (Cardano, `bonding_curve_tier_b.ak`'s own `creator_fees_accrued`, claimed via `ClaimCreatorFees`)
- Documentation-only resolution — both accumulators already existed and were already independently claimable from earlier work; this just fixes the labeling convention in CLAUDE.md's CREATOR FEE ESCROW section so no future UI work invents something else (e.g. an oracle-dependent unified-balance display)

---

## 2026-07-10 — T25 closed for good: darkveil.compact merged in too, cap now genuinely cumulative

### The remaining gap from this morning's merge, closed
- Extended the same-day eligibility_gate + bonding_curve merge to a 3-way merge, folding `darkveil.compact` in too — `contracts/midnight/bonding_curve.compact` is now 30 circuits (was 17 after the first merge, 10 before any merge)
- `revealBuyCommit` (where a DarkVeil buyer's purchase amount becomes known) now checks and updates `cumulativePurchases` inline, the same way `buyTokens` does — DarkVeil purchases finally count toward the 5% cumulative cap, closing the exact gap flagged this morning
- `activateCurve`'s new `phase == Public` gate (from the first merge) now composes correctly with DarkVeil's own sub-phase transitions (`startRegistration`/`startBuying`/`closeDarkVeil`/`cancelDarkVeil`), all in the same contract

### Real finding, bigger than originally scoped: darkveil.compact had zero payment enforcement, any tier
- Checked every circuit in the file — `revealBuyCommit` verified the claimed price and allocation but never called `receiveUnshielded` or checked the buyer paid anything, for the actual token purchase, in ANY tier. Bigger than T40 (which fixed *fee* deposits, not the purchase price itself)
- Fixed for Tier C: `receiveUnshielded` wired into `revealBuyCommit`, deliberately at REVEAL time rather than submit time — checking payment at submit would require disclosing the amount early, defeating the whole point of DarkVeil's commit/reveal privacy. Reveal is when the amount is already meant to become public by design, so this costs no additional disclosure
- Reviewed explicitly against the privacy/selective-disclosure gold standard (Jinx's standing instruction from earlier today) before landing, not after — documented in the contract's own file header and PRIVACY ANALYSIS section, not just the commit message
- **Not fixed for Tier B (ADA)** — same root cause as T24, ADA isn't a Midnight-native token, so `receiveUnshielded` doesn't apply. Unlike T24's public-curve fix, DarkVeil can't just move to Cardano either — Cardano can't do private commit/reveal. Filed as a new, separate, unresolved issue (T46) rather than guessed at

### Identity unification extended to all three merged sources
- `darkveil.compact` had its own third identity domain (`"noctis:darkveil:user:pk:v1"`), on top of the two eligibility_gate/bonding_curve already unified this morning — now all three collapse to the one shared identity, required for `cumulativePurchases` to mean the same thing everywhere it's touched

### Test suite grew accordingly
- `contracts/midnight/tests/bonding_curve.test.ts`: 33 tests (was 25 this morning, 19 before any merge) — new coverage includes a DarkVeil reveal + a later public buy sharing the same cumulative cap entry, a tight-cap DarkVeil rejection test, commit/cancel/close lifecycle tests, and a payment-wiring regression test (same simulator caveat as every other `receiveUnshielded` test in this repo — proves the call is wired in, not that a live network rejects a missing payment)
- `integration/midnight-client.ts` updated to match: `deployBondingCurve`'s constructor grew to 13 args; `registerForDarkVeil`/`submitDarkVeilBuyCommit`/new `revealDarkVeilBuyCommit`/`closeDarkVeil` all fall back from their standalone-PSM client fields to `bondingCurve` for Tier C, since it has no separate `eligibilityGate` or `darkveil` deployment any more

---

## 2026-07-10 — T25 resolved: eligibility_gate + bonding_curve merged for Tier C

### Real finding first: Compact has no working cross-contract calls
- Investigated whether one deployed Compact contract can call another's circuit or read its ledger on-chain — it can't. The compiler has stubbed-in syntax for it, but every call form tested fails with `contract types are not yet implemented`, verified against the installed compactc, not assumed
- This rules out all three original options internal tracking listed for T25 (a third shared PSM, a live cross-PSM query, a snapshot published between contracts) — none were ever buildable on-chain
- What DOES work, confirmed by compiling it: folding two `.compact` sources into one deployed contract with one shared ledger (`include`/`module`)

### eligibility_gate + bonding_curve merged into one PSM, Tier C only
- `contracts/midnight/bonding_curve.compact` now contains both files' circuits/ledger (17 circuits, was 10) — `buyTokens` checks and updates `cumulativePurchases` against `walletCap` directly, inline, atomically, no cross-contract call needed
- Tier B is unaffected — it keeps `eligibility_gate.compact` standalone (DarkVeil-only; its bonding curve already moved to Cardano via T24), so the two tiers now use genuinely different shapes of "the eligibility gate"
- Unified the two files' previously-different identity derivations (`"noctis:user:pk:v1"` vs `"noctis:curve:user:pk:v1"`) into one — necessary, not a shortcut: `cumulativePurchases` was always meant to link one identity's activity across both phases (CLAUDE.md says so explicitly), so the two-domain split was a latent bug that would have silently defeated cumulative tracking regardless of cross-contract calls
- Reviewed against Jinx's standing instruction that every Midnight change must meet the privacy/selective-disclosure gold standard, not just correctness — confirmed the identity unification is required by the feature itself, not a privacy regression; witness-vs-ledger placement carried forward unchanged from both source files
- `activateCurve` now also asserts `phase == Public` before letting the curve activate — wasn't possible before the merge, since `phase` lived in a different contract
- Test suite rewritten: 25 tests (was 19), including new regression tests proving the cap is enforced atomically inside `buyTokens` and that `checkAndUpdateCap`/`buyTokens` share the same map entry for the same identity
- `integration/midnight-client.ts` updated to match: `deployBondingCurve`/`connectBondingCurve` take the merged 9-arg constructor; `registerForDarkVeil()` falls back to the `bondingCurve` handle when `eligibilityGate` isn't connected (Tier C has no separate one); `buyTokens()` no longer makes a second `checkAndUpdateCap` call since the cap is now enforced inside the first one

### Known remaining gap, not fixed by this change
- This makes PUBLIC-phase cap enforcement real. It does NOT yet make the cap truly cumulative across DarkVeil + public — `darkveil.compact`'s `revealBuyCommit` (where a DV purchase amount becomes known) never writes to `cumulativePurchases`, and it's a separate contract with the same no-cross-contract-call limitation
- Found alongside this: `darkveil.compact` has ZERO payment enforcement anywhere in the file, for the actual token purchase, in any tier — bigger than T40 originally scoped (T40 covered fee deposits, not the purchase price itself). Both findings tie together and are being brought back for discussion before further changes to `darkveil.compact`

---

## 2026-07-09 — Repo cleanup: two stale/superseded files archived locally

### `CONTRIBUTING.md` and `build-offline.py` removed from GitHub tracking
- `CONTRIBUTING.md` was actively misleading, not just old — it said "contracts are not yet scaffolded" (8 Compact PSMs + 5 Aiken validators exist with tests) and described a `dev` → `main` PR-review branch workflow that isn't how work has actually been happening (direct pushes to `main` all session)
- `build-offline.py` (full single-file offline preview, all pages) confirmed still distinct from `build-docs.py` (GitHub Pages preview, public pages only) rather than a pure duplicate — kept anyway per explicit confirmation that the offline-preview capability isn't needed going forward
- Both moved to a new local-only `archive/` folder (gitignored, same "local reference, never pushed" pattern as `HISTORY_ARCHIVE.md`) rather than deleted outright
- `README.md`'s feature checklist and `build-docs.py`'s header comment updated to point at the new location instead of implying either file is still in the repo; `ROADMAP.md`/`CHANGELOG.md`'s existing dated history entries about `build-offline.py` left untouched (chronological record, not a current-state claim — same precedent as the T15/BTC-Reserve cleanup)

---

## 2026-07-09 — T24 resolved: Tier B's public bonding curve moves to Cardano/Aiken

### Architecture change, not just a bug fix
- Traced a "how do tokens cross from Midnight to Cardano at graduation" question down to its real root: ADA can't be custodied by a Midnight PSM at all (`receiveUnshielded`/`sendUnshielded` only work with Midnight-native tokens — confirmed `nativeToken()` returns NIGHT specifically). That's bigger than a payment-enforcement gap (T40) — it's a question of where Tier B's ADA can live in the first place, including for refunds
- Decided against bridging (Cardano escrow + relayer attesting back into Midnight on every buy) in favor of moving Tier B's entire public bonding curve phase to Cardano/Aiken — the public phase is public information by definition, and Cardano already proved it can do real quadratic-curve math and real payment enforcement natively (Tier A's `bonding_curve.ak`, same session). Only DarkVeil's private phase stays on Midnight
- New `contracts/cardano/bonding_curve_tier_b.ak` — quadratic pricing (same formula/`k` as Tier C's Midnight curve), real payment enforcement (`payment_received`, same pattern as Tier A), and a cap-tracking list **pre-seeded at deploy** from DarkVeil's final per-registrant allocation (anchored via the same platform-relayer pattern already used for the ZK Fair Launch Certificate, T21) — no new on-chain identity cryptography needed, since DarkVeil's wallet-age eligibility check already required each registrant's real Cardano key. 16 new tests, all passing
- This one architecture decision resolves three tracked issues as direct consequences, not three separate fixes: **T24** (the original cross-chain distribution question disappears — token and payment now live in the same place), **T40** (Tier B's remaining self-reported ADA path closed, reusing Tier A's proven payment check), **T25** (cross-PSM cumulative cap tracking becomes a one-time relayer anchor instead of a live cross-PSM call that T2 confirmed doesn't exist in the current SDK)

### bonding_curve.compact scoped down to Tier C only
- Removed the `Currency` enum and `currency` field entirely — Tier B no longer deploys this contract, so the dead self-reported `Currency.Ada` branch is gone rather than left sitting unused
- `receiveUnshielded` is now unconditional (every remaining deployment is NIGHT-denominated)
- New `claimCurveRefund()` circuit for Tier C's failure path (T29) — pays back a buyer's NIGHT via the real, compiler-verified `sendUnshielded(color, amount, recipient: Either<ContractAddress, UserAddress>)` builtin (confirmed via a fresh probe compile this session, not assumed from documentation), mirroring `claimBondRefund`'s double-claim-prevention pattern but actually moving the NIGHT instead of only clearing a ledger entry
- Updated the stale `buyTokens` comment claiming the 5% cap "happens via transaction merging with the eligibility gate PSM" — T2 already confirmed that mechanism doesn't exist; this is now flagged as Tier C's own open gap (re-scoped T25) rather than left describing something that was never real
- 19 tests (was 14 combined Ada/Night tests — net includes 4 new refund tests, plus the redundant Ada-path test collapsed into the single NIGHT-only path)

### New follow-up filed: T45
- Tier B's creator now has two fee-accumulation points (DarkVeil-phase fees on Midnight via Creator Fee Escrow PSM, public-phase fees directly in the new Cardano curve contract, mirroring Tier A's "Stream A" pattern) — whether the dashboard shows two labeled balances or unifies them is undecided. Not blocking; flagged so nobody builds a single combined claim UI assuming one balance

### integration/midnight-client.ts updated to match
- `deployBondingCurve` drops the removed `currency` constructor arg; added `claimCurveRefund()` to `NoctisLaunchManager`; doc comments across the bonding-curve methods now note Tier C-only scope and point Tier B callers to the Cardano tx-building path instead

---

## 2026-07-09 — integration/midnight-client.ts rewritten against the real Midnight SDK

### Full rewrite, no more fictional API
- Replaced `integration/midnight-client.ts`'s entire previous shape (`sdk.deploy()`, `contract.call(name, argsRecord)`, `sdk.createMergedTransaction()`) — none of those methods exist on any real `@midnight-ntwrk` package — with the real `deployContract`/`findDeployedContract`/`.callTx.<circuitName>(...args)` API from `@midnight-ntwrk/midnight-js-contracts@4.1.1`
- Chose `midnight-js-contracts@4.1.1` (last stable, pre-beta release) over the `5.0.0-beta.4` line: the beta line needs `compact-runtime@0.18.0-rc.1`, which no publicly installable `compactc` version (`compact list` tops out at 0.31.1) currently produces output for. `4.1.1` depends on exactly `compact-runtime@0.16.0`, matching this repo's whole verified toolchain — confirmed via `npm view` and by checking the actually-resolved installed version
- All 8 PSMs now have real typed `deployX()`/`connectX()` methods on `NoctisMidnightClient`, using real per-PSM constructor arguments and witness shapes cross-referenced from each `contracts/midnight/compiled/<psm>/contract/index.d.ts`
- Fixed the concrete circuit-argument bugs the old fictional client had baked in: `registerForDarkVeil` (was called with `{nullifier,commitment,timestamp}`, real signature is one arg `bondCommitment: Bytes<32>`), `buyTokens` (was missing all 3 fee arguments — now computes and passes `claimedCreatorFee`/`claimedTreasuryFee`/`claimedOpsFee` at 1.0%/0.6%/0.4% via a new `computeBondingCurveFees()` helper matching T39's floor-rounding check), `checkAndUpdateCap` (was hardcoding the caller's key to all-zero bytes — now derives it via `deriveUserPublicKey`, with that function's existing "simplified, not real persistentHash yet" caveat carried forward rather than hidden)

### Two real SDK-shape gaps found and worked around/documented
- **T44 (new):** `@midnight-ntwrk/compact-js@2.5.1`'s `CompiledContract<in out C,...>` is invariant in `C`, and every raw `compactc`-generated contract class carries an extra `impureCircuits` field beyond what compact-js's own `Contract<PS,W>` interface declares — this blocks `deployContract`/`findDeployedContract` outright when passed a raw compiled class. Every fix tried that preserves per-circuit `.callTx` typing reintroduces the same invariance failure on a different field. The only combination that compiles (`integration/compact-adapter.ts`'s `asEffectContract<PS>()`) widens `C` enough that `.callTx` becomes untyped — verified empirically that a bogus circuit name with wrong argument types produces zero TypeScript errors. Every `.callTx` call site in the new client was hand-verified against real compiled signatures to compensate.
- **T2 confirmed at the SDK level:** `withContractScopedTransaction`, the SDK's only transaction-batching primitive, is parameterized by a single contract type `C` — there is no cross-PSM atomic transaction primitive in `midnight-js-contracts@4.1.1`'s public API at all. All cross-PSM operations (buy + cap check, graduation, CTO execution, cancellation) are implemented as sequential, non-atomic calls, each documented with what a partial failure leaves in an inconsistent state and how to retry.
- Also fixed along the way: `contracts/midnight/witnesses.ts`'s witness factory functions returned bare `() => value` getters, which never matched any compiled contract's real `Witnesses<PS>` type (`(context) => [PS, value]` tuples) — this would have failed at runtime the first time any of these witnesses were actually wired to a deployed contract, never caught before because nothing previously exercised this path against the real SDK. Also converted the 8 witness `interface` declarations to `type` aliases — TypeScript's `Record<string,V>` assignability quirk (interfaces never satisfy an index-signature target even with identical shape; type aliases do) was silently blocking `withWitnesses()` calls.
- Removed `witnesses.ts`'s `*Calls` object-literal helpers and `merged*` cross-PSM helper functions — built on the same fictional `contract.call()`/`contract.createCall()` shape, made redundant by the real typed `.callTx` API and the T2 finding above.
- All 93 Compact tests and 10 zk-proofs tests still pass unaffected (only `integration/` and `witnesses.ts` touched — no `.compact` source changes this round).

---

## 2026-07-09 — T40 Aiken-side fix: bonding_curve.ak now checks real ADA payment

### Tier A's bonding curve validator checks lovelace, not just token delivery
- `bonding_curve.ak`'s `BuyTokens` redeemer checked `token_delivered` (buyer receives tokens) but never checked the buyer actually paid — the same class of gap T40 fixed on the Midnight/Compact side
- New `payment_received` predicate: the validator's own continuing output's lovelace value must equal the input's value plus the claimed `gross_payment`, exactly
- Unlike the Compact-side fix, this is fully and rigorously testable locally — Aiken's test harness validates real `Transaction`/`Output`/`Value` objects directly against the validator, no simulator gap the way `@midnight-ntwrk/compact-runtime` has
- 2 new tests (payment not received at all; underpayment by 1 lovelace), 1 existing test tightened to isolate its one intended failure cause now that payment is also checked
- 49 Aiken tests total (was 47), all passing. `aiken build` clean, all 10 validators still register in `plutus.json`
- Closes out the Aiken-side counterpart flagged in T40's original writeup. T40 itself stays open, scoped down to Midnight's ADA-denominated `buyTokens` path (blocked on T24)

---

## 2026-07-09 — T42 fixed: real Merkle allowlist verification

### eligibility_gate.compact's allowlist check is real now
- `verifyAllowlist()` was a placeholder accepting any non-zero leaf; replaced with real 32-level Merkle inclusion proof verification
- Used `fold` (Compact's loop replacement — no for/while loops). Its real signature is `fold(callback, init, vector)` with an explicit return-type annotation on the callback — one community reference had the argument order backwards, costing several failed compiles before finding the correct signature elsewhere
- Witness shape changed: `getMerkleProof` now returns `Vector<32, MerkleProofEntry>` (`{sibling, goesLeft}` per level) instead of `Vector<32, Bytes<32>>`, which had no way to express hash direction
- Fixed-depth convention (real tree padded to exactly 32 levels with a fixed sibling) implemented identically on both sides: on-chain in the circuit, off-chain in a new `buildAllowlistTree` helper in `packages/zk-proofs/src/eligibility-gate.ts`
- Verified adversarially: a real proof is accepted, and tampering with any sibling, any direction bit, the leaf, or presenting a proof against the wrong root/wrong leaf are all confirmed rejected — 8 new tests in `packages/zk-proofs/tests/allowlist-merkle.test.ts`
- Chose the original Merkle-root design over a simpler on-chain-`Set` alternative to preserve the stated privacy property (only a root goes on-chain), despite the higher implementation risk of hand-rolled ZK circuit logic — confirmed by direct ask before implementing
- Compact suite: 93 tests; zk-proofs package: 10 tests (was 2). `eligibility_gate.compact` recompiles clean with full ZK proving keys (7 circuits)

---

## 2026-07-09 — T22/T23/T26 decided, DV-failure bond-refund gate fixed

### Three design decisions resolved
- **T22 (DarkVeil failure path):** if DV fails (<50% participation), the launch converts to a Tier A-equivalent public launch — bonding curve opens immediately from the same P₀, no partial refund, no restart cooldown.
- **T23 (NIGHT bond amount):** exactly $50 USD worth of NIGHT, fixed at lockup/registration price. Confirmed explicitly: never re-priced at release — any return pays back a fraction of the original locked quantity, not a re-conversion at current price.
- **T26 (bonding curve parameters):** creator sets a target graduation FDV; platform derives grad price, k, and P₀ bounds off-chain. No contract change needed — `bonding_curve.compact`'s constructor already takes pre-computed values, matching this decision as-is.

### Found while implementing T22, partially fixed
Wiring up "DV fails → launch converts to Public" surfaced that `eligibility_gate.compact`'s `claimBondRefund()` only allowed a refund when `phase == Cancelled` — under the new decision the phase moves to `Public`, not `Cancelled`, so DV registrants on a converted launch would have had no way to reclaim their bond at all. Fixed with a new `dvFailed: Boolean` field + governor-only `markDarkVeilFailed()` circuit, independent of `phase`. Also surfaced that CLAUDE.md's ratio-based partial bond return formula (`NIGHT_returned = bonded × purchased/allocated`) isn't implemented anywhere — no contract tracks the per-user allocation it needs. That part stays open (T43) pending its own design pass.

Full Compact suite: 93 tests (was 90), all passing. `eligibility_gate.compact` recompiles clean with full ZK proving keys (7 circuits, was 6).

---

## 2026-07-09 (latest) — T39 + T40 fixed: real floor-rounded pricing, real NIGHT payment enforcement

### T39 fixed: bonding curve price/fee verification now works for arbitrary purchases
- `verifyPrice`/`verifyFeeSlice` replaced their exact-equality Field cross-multiplication (only solvable at "lucky" checkpoints) with a floor-rounding double inequality (`claimed*d <= numerator < (claimed+1)*d`), which always has exactly one valid answer
- This required leaving Field arithmetic behind entirely, which meant discovering — empirically, by bisecting against the real compiler — that Compact's non-Field multiplication has a hard ceiling: the *result* type must be `Uint<124>` or narrower, independent of operand widths or how much headroom the target type has (`Uint<63>*Uint<63>->Uint<126>` fails, `Uint<62>*Uint<62>->Uint<124>` succeeds; this isn't documented anywhere, found by testing)
- Every width in the fix (curveSupply/sold/tokenAmount ≤ 2^40, prices ≤ 2^44) was sized to respect that ceiling
- Regression tests prove the exact previously-broken cases now succeed: sold=10 (true price 100.09) accepts the floor (100), correctly rejects 101; gross=1090 accepts the floor fee, rejects floor+1

### T40 fixed (NIGHT path): buyTokens/bond-locking/fee-deposit now require real payment
- Confirmed `receiveUnshielded(color, amount)` and `nativeToken()` are real Compact stdlib builtins (checked against official Midnight docs and empirically verified against the real compiler and runtime — inspected the actual low-level transcript `receiveUnshielded` generates to confirm it's a genuine ledger-enforced constraint, not a no-op)
- Wired into `eligibility_gate.compact`'s DarkVeil bond locking (both tiers, NIGHT-denominated), `bonding_curve.compact`'s `buyTokens` (Tier C only, currency-gated), and both `creator_escrow.compact`'s and `treasury.compact`'s `depositFees` — the latter two previously had **zero access control and zero payment check of any kind**
- `creator_escrow.compact` needed a new per-launch `currency` field (didn't have one); `treasury.compact` needed `currency` as a call *argument* instead, since it's a single shared pool across every launch and both currencies, not per-launch like the others
- Tier A/B's ADA-denominated path stays self-reported — ADA isn't a Midnight-native unshielded token; ties to T24's open cross-chain question. Filed as the remaining scope of #42 rather than closed.
- Full Compact suite now 90 tests, all passing; all touched files recompile clean with full ZK proving keys

---

## 2026-07-09 (latest) — packages/zk-proofs + packages/types scaffolded, security audit pass, 3 more findings

### New: packages/zk-proofs/ — verified off-chain hash helpers
- Reimplements every PSM's witness-derived key/commitment/nullifier `pure circuit` (darkveil, eligibility_gate, cto_governance) in TypeScript, using the real `persistentHash`/`CompactType*` builtins from `@midnight-ntwrk/compact-runtime` — not a guessed hash function
- Verified byte-for-byte parity against the real compiled circuits (not assumed): a vitest suite drives the actual `registerForDarkVeil`/`castVote`/`hasVoted` circuits and confirms this package's independently-computed keys/nullifiers match what the on-chain circuits derived internally
- While grounding this package's design, discovered that only `export circuit` functions are exposed on a compiled contract's `Circuits<PS>` type — the `pure circuit` helpers (`deriveUserPublicKey`, `computeBuyCommit`, etc.) are compiler-internal and not directly callable, which is why a client-side reimplementation is necessary in the first place

### New: packages/types/ — shared TypeScript types
- Launch tier, per-PSM lifecycle state unions (hand-mirrored from each `.compact` source's enums, since the compiled output is gitignored and can't be imported cross-package), and the fee-split basis-point constants

### Security audit pass against CLAUDE.md's Priority 1/2/3 + Formal Verification checklist
Found 3 new issues while reading all 8 Compact PSMs and the Tier A Aiken contracts against the checklist (on top of building the zk-proofs package, which surfaced two of these directly):

- **Value-backing enforcement across the PSMs.** Every PSM must enforce that a claimed payment/fee/bond is backed by real currency movement, not just a ledger counter. `treasury.compact`/`creator_escrow.compact`'s `depositFees` must enforce access control and payment, so a claimable balance always corresponds to value actually received. `bonding_curve.compact`'s `buyTokens` (and the parallel Aiken `bonding_curve.ak` redeemer) only check internal consistency between self-reported numbers, never that real value changed hands. Needs a design decision on how Midnight's transaction model is meant to tie a claim to real coin movement, not a quick patch.
- **[T41, fixed] `cto_governance.compact`'s `creatorVoteCapBps` was declared but never assigned anywhere** — defaulted to 0, silently zeroing every creator-flagged vote's weight instead of capping it at the intended 2%. Fixed the same way as T38's `walletCap`: replaced with a validated constructor argument (`creatorVoteCap`, an absolute amount) instead of an on-chain bps calculation. 4 new regression tests; full suite now at 83 tests, all passing.
- **[T42, open] `eligibility_gate.compact`'s allowlist Merkle verification is an unimplemented placeholder** — `verifyAllowlist()` accepts any non-zero leaf value; the Merkle proof witness is fetched but never checked against `allowlistRoot`. Already had a self-documenting TODO in source; now has a tracked issue.

All three filed as GitHub issues (#42, #43 closed, #44) and mirrored into internal tracking.

---

## 2026-07-09 — Compact PSM simulation test suite + critical walletCap fix

### 79-test vitest suite against all 8 Midnight PSMs
- Verified the real `@midnight-ntwrk/compact-runtime` API (v0.16.0) end-to-end with a working proof-of-concept before writing any test — same discipline as the earlier Aiken lesson: nothing gets written against a guessed API
- `contracts/midnight/tests/` — one file per PSM (treasury, bonding_curve, eligibility_gate, darkveil, creator_escrow, vesting, lp_escrow, cto_governance) plus a shared `helpers.ts`, exercising each compiled circuit with real constructor + multi-call state threading, not just type-checking
- `npx vitest run`: 8 files, 79 tests, 0 failures

### Fixed: eligibility_gate.compact walletCap was 100x too large
- The constructor computed `walletCap = totalSupply * maxWalletPercent` with **no division** — for a 1B supply and a 5% cap this produced `5,000,000,000` instead of `50,000,000`, a cap larger than the entire token supply
- Impact: the core 5% anti-whale cap was silently unenforceable — no purchase could ever hit a cap 5x bigger than all tokens that exist
- Fix: `walletCap` is now taken directly as a constructor argument (computed correctly off-chain, same pattern used elsewhere for Field-precision-sensitive values), and the dead `computeWalletCap()` helper (confirmed zero call sites) was deleted
- Regression tests cover both the fix and the exact purchase size the bug would have wrongly let through

### Found, not yet fixed: bonding_curve.compact price/fee precision issue
- `verifyPrice` and `verifyFeeSlice` both use exact-equality Field cross-multiplication (`claimedX * denominator == numerator`) — this has no valid integer solution unless the true value happens to be an exact integer, which only holds for "lucky" checkpoint values divisible by specific constants
- For realistic buy amounts this means most purchases can't construct a passing `claimedPrice`/`claimedFee` at all
- Documented via dedicated "IMPORTANT FINDING" tests rather than worked around — this touches core curve/fee economics and needs a real design decision (bounded range check vs. a different verification pattern), not a quick patch

### New: vesting.compact (Tier A) + contracts/cardano/validators/vesting.ak
- Tier A previously had no vesting mechanism at all; added an Aiken validator mirroring the Compact `vesting.compact` design, using plain integer division (no Field-circuit restriction on Cardano) — 6 new tests, 47 Aiken tests total across 5 files, all passing
- `ARCHITECTURE.md` and `AI_COUSIN_MEMORY_INGESTION.md` updated to reflect the corrected 8-PSM / 5-Aiken-contract shape

---

## 2026-07-09 (later) — Aiken contracts actually compile now

### All 4 Cardano Aiken contracts rewritten to real syntax
- None of the 4 `.ak` files (bonding_curve, lp_escrow, zk_anchor, cto_governance) landed earlier today actually compiled — they were written against a fictional Aiken API (`fn spend(...) -> Void`, `ctx: ScriptContext`, `Ed25519.verify(...)`, `Blake2b_224.hash(...)`, `require(...)`) that doesn't exist in any real Aiken version. Same root cause as the earlier Compact bugs: nobody had ever run a compiler against this code.
- Installed Aiken v1.1.23 (via WSL — no native Windows binary) and bisected a silent compiler crash down to a single bad import to find this
- Also discovered Aiken requires validator files to live in a `validators/` subdirectory — files at the project root are silently never scanned, so `aiken build` was "succeeding" with 0 validators registered even before the content was touched
- Rewrote all 4 to the real spend-handler signature and swapped manual signature verification for checking `self.extra_signatories` (the ledger already verifies those signatures before the script runs)
- Fixed `aiken.toml` to the current manifest format (the old `[dependencies]` map syntax doesn't parse) and pinned `aiken-lang/stdlib` v3.1.0
- All 4 validators now compile clean (`aiken build` + `aiken check`) and correctly register in `plutus.json` — 8 entries (spend + auto else per validator)

---

## 2026-07-09 — First smart contracts land on main + GitHub Issues sync

### Smart contracts (from bytewizard42i/Noctis_ZKL_johns-copy fork, reviewed and fixed)
- Reviewed the fork's 3 open PRs and pulled their cumulative work into a local branch for review — nothing merged into the fork itself, its push URL stays disabled
- Compile-validated all 7 Midnight PSMs with a real `compactc` (v0.31.0, via WSL — no native Windows binary exists): 4 of 7 failed to compile as originally scaffolded, traced to the original scaffold commit that predates every PR (no PR ever re-verified those 4 files after its own scope)
- Fixed: Field-overflow casts on `Uint<128>` multiplication, `Uint<128>` width-narrowing on addition, `disclose()` placed on the wrong expression in two files (a real privacy/soundness bug, not just a type error), a missing `>` in a `Set<Bytes<32>>` declaration, and a fee-split math bug in `bonding_curve.compact` that made `buyTokens` unpayable for any real purchase (missing `/10000` divisor)
- Rewrote `bonding_curve.compact` from linear to quadratic pricing with a shared `k` across Tier B/C, matching CLAUDE.md's original spec (an earlier deep-dive doc had shipped a flattened-to-linear deviation without confirming)
- Wrote `contracts/cardano/bonding_curve.ak` from scratch for Tier A's linear curve — didn't exist anywhere before
- All 7 Midnight PSMs now compile clean (`--skip-zk`); Aiken contracts and the TS integration layer are not yet compile/review-verified (no Aiken toolchain available; `integration/*.ts` not yet reviewed in depth)
- Landed on `main`: 7 Midnight PSMs, 4 Aiken contracts, `witnesses.ts`, the integration layer (`blockfrost-client.ts`, `midnight-client.ts`, `wallet-connection.ts`), and supporting docs (`docs/PSM_ARCHITECTURE.md`, `DEEP_DIVE_ANALYSIS.md`, `SECURITY_MODEL.md`, `INTEGRATION_GUIDE.md`, `AI_COUSIN_MEMORY_INGESTION.md`) — deliberately excluded the fork's own `FUTURE_ROADMAP.md` and its versions of README/PRE_LAUNCH_CHECKLIST/ROADMAP/CLAUDE.md, since main's copies of those were independently maintained today and are more current

### New: ARCHITECTURE.md
- System overview and Midnight PSM flow diagrams (generated programmatically for guaranteed alignment) plus a contract-to-tier reference table
- Corrected real content errors found while building it: Bonding Curve PSM was mislabeled "linear" (now quadratic, matching the fix above), Creator Fee Escrow and Vesting were conflated into one box (now split — CLAUDE.md explicitly flags this as "a common source of confusion")

### GitHub Issues sync
- Closed #11 (T15, Bitcoin Reserve Custody) as obsolete — the BTC reserve mechanism it depended on was removed from the fee model on 2026-07-06
- Filed 15 new open issues (T22–T27, T29–T37) and 4 closed audit-trail issues (T28, D1, D2, D5) that existed in internal tracking but were never mirrored to GitHub
- Updated #4 (T18) with the NorthStar DEX research from 2026-07-04 that GitHub hadn't seen
- internal tracking now cross-link every ID to its GitHub issue number

### Stale content cleanup
- Removed hardcoded 50/150/250 ADA launch fee figures from README.md, PRE_LAUNCH_CHECKLIST.md, and ROADMAP.md — fees are USD-denominated now and change over time, so these now point at CLAUDE.md's constants instead
- Removed README.md's "What's in this repo" file-tree section — redundant with GitHub's own repo page
- Added a Table of Contents to README.md
- Committed CLAUDE.md's pending LP Escrow/CTO Governance tier-scope fix (A+B / A+B+C) that had sat uncommitted since 2026-07-06

---

## 2026-07-06 — Fee model finalized + local WordPress site sync

### Fee split confirmed
- Trade fee: **2.0% total** — 1.0% Creator Fee Escrow, 0.6% Platform Treasury, 0.4% Ops Wallet
- Launch fee ops/treasury split standardized at a constant **60% Treasury / 40% Ops across all three tiers**
- `CLAUDE.md` platform constants: `TIER_X_OPS_PCT = 40`, `TIER_X_TREASURY_PCT = 60` for A/B/C

### Local WordPress site (`Local Sites\noctis`) synced to current spec
- Plugin: overview/treasury admin pages, launch reference page, and platform constants brought in line
- Theme: transparency page, How It Works page, all 8 sample launch data files, and the live buy widgets updated
- Sample HTML sites rebuilt: `docs/index.html` (GitHub Pages, 5 pages) and `offline-preview/noctis-preview.html` (local preview, 12 pages)

---

## 2026-07-04 — NorthStar DEX research (T18) + issue register cleanup

### T18 — NorthStar DEX identified as Tier C graduation candidate
- NorthStar DEX (northstardex.com / [@NorthStarDEX](https://x.com/NorthStarDEX)) confirmed as the only known Midnight-native DEX candidate
- Features: AMM, non-custodial trading, LP management, token creation; native token NSTAR with revenue sharing
- Was live on Preprod testnet as of March 2026; Midnight mainnet (Kūkolu) launched March 31, 2026
- internal tracking T18 updated with candidate details and 6 open integration questions
- internal tracking T18 updated with candidate note and contact pointer

### Issue register cleanup
- T28 marked ✅ resolved (whitepaper sync completed this session)
- T22 Option A: stale "150 ADA" fee reference corrected to generic "launch fee"
- T28 added to internal tracking resolved table

---

## 2026-07-04 — Whitepaper sync (T28) + launch fee repricing

### Whitepaper — remaining conflict fixes
All remaining conflicts between the live whitepaper and current spec resolved:
- **CTO cooldown:** Corrected from "30-day cooldown" to "90-day cooldown" (CLAUDE.md constant: `CTO_COOLDOWN_DAYS = 90`)
- **DUST attribution:** Corrected "treasury accumulates DUST" → ops wallet holds NIGHT / generates DUST; treasury accumulates stablecoins separately
- **Security section:** Updated "enforced by ZK proof in Tier B" → "Tier B and Tier C"
- **Supply section:** "paired with raised ADA" → "raised funds (ADA for A/B, NIGHT for Tier C)"
- **Curves section:** "raised ADA is used to seed LP" → "raised funds are used"
- **DarkVeil ZK cert:** "how much ADA was raised" → "how much was raised (ADA for Tier B, NIGHT for Tier C)"; added Tier C relayer note
- **Tiers + Team sections:** Updated all fee amounts from fixed ADA to USD (see below)

### Launch fee repricing — $10/$30/$50 USD
All three launch fees changed from fixed ADA amounts to USD-denominated prices, payable in ADA or NIGHT equivalent at the current oracle spot price.

| Tier | Old fee | New fee |
|------|---------|---------|
| Tier A | 50 ADA | $10 USD |
| Tier B | 150 ADA | $30 USD |
| Tier C | 250 ADA | $50 USD |

**Files updated:**
- `CLAUDE.md` — constants renamed: `TIER_X_FEE_ADA` → `TIER_X_FEE_USD`; split constants changed from ADA amounts to percentages
- `noctis_v1/noctis_whitepaper_v1.html` — all fee references in Tiers, Team sections
- `inc/data/tiers.php` — `fee` field per tier
- `template-parts/create/create-wizard.php` — tier card fee badges
- `assets/js/create.js` — `fee` variable + pay summary (now shows `$N USD` with percentage split)
- `template-parts/how-it-works/hiw-content.php` — tier comparison cards + step-by-step walkthrough
- `inc/data/steps.php` — step 01 description
- `template-parts/transparency/transparency-content.php` — ops wallet purpose description

---

## 2026-07-04 — Protocol gap analysis + issue register expansion

### Gap analysis — logic and tokenomics review
Full cross-document audit of CLAUDE.md, the live whitepaper, and all tracked issues. Compared GitHub repo state against the current spec. No code changes — documentation and issue register only.

### internal tracking — 16 new issues added (T22–T37)
**New blockers (🔴) — block contract design:**
- T22: DarkVeil failure path — launch state machine undefined when <50% participation
- T23: NIGHT bond amount — eligibility check vs bond quantity distinction; exact NIGHT locked undefined
- T24: Tier B cross-chain token settlement — minting "at graduation" from Midnight PSM to Cardano buyers undefined
- T25: Cross-PSM cumulative cap tracking — 5% cap across DV+public requires cross-PSM identity data; mechanism undefined
- T26: Bonding curve parameter specification — P₀, k, graduation price derivation not specified; PSM and formal verification blocked

**New important (🟡) — resolve before mainnet:**
- T27: LP seeding ADA source — which ADA funds the LP at graduation; affects treasury inflow model
- T28: Whitepaper out of sync — live whitepaper shows wrong fee %, two tiers; must update before public announcement
- T29: Stuck bonding curve — no timeout or refund if 100% sell-through never reached; buyer ADA locked in PSM indefinitely
- T30: LP whitelist vs DEX upgrades — hardcoded whitelist conflicts with DEX contract versioning; governance path needed
- T31: CTO governance anchor — undefined who submits Cardano L1 anchor; platform relay = platform can veto legitimate vote
- T32: Creator wash trading — no prohibition on creator buying own public curve; last-mile graduation manipulation enabled
- T33: Forfeited NIGHT routing — ghost/partial NIGHT forfeitures not in fee routing table; conversion policy undefined
- T34: Initial NIGHT bootstrapping — pre-launch NIGHT reserve source undefined; ops wallet needs NIGHT before first Tier B launch
- T35: Creator tokens in CTO vote — spec silent; creates conflict-of-interest gap in governance

**New post-MVP (🟢):**
- T36: Silence lock edge case — zero-volume launches trigger fee-condition through market failure, not abandonment
- T37: Ghost registration attack vectors — slot dilution and DV failure griefing documented

### internal tracking — rebuilt
- Blockers table expanded: T2, T3, T17, T18 + new T22-T26 (9 total)
- Important table expanded: T4-T7, T13-T15, T19-T21 + new T27-T35 (21 total)
- Post-MVP table: added T36, T37
- Next ID updated: T38, D5
- Resolved section: D3 and D4 notes updated to reflect superseded status

---

## 2026-06-09 — Tier C full UI implementation (website + offline preview)

### WordPress theme — Tier C additions (theme v0.4.1)

**New launch tiers section (home page)**
- Tiers grid expanded from 2 cards to 3 — added Tier C "Midnight Launch" card with violet (#8844DD) MAXIMUM PRIVACY badge, full 9-feature list, Midnight wallet requirement note
- Grid CSS: `.tiers-grid--three` responsive at 900px (2-col) and 680px (1-col)

**Four new Tier C sample launches**
- `launch-abyss.php` — DV Active, $ABYS, 318 registered, 20% DV alloc, 365-day vesting, NIGHT-denominated
- `launch-spectre.php` — DV Active, $SPCT, 521 registered, 14% DV alloc, 270-day vesting, NIGHT-denominated
- `launch-cipher.php` — DV Registration, $CPHR, 74 registered, 15% DV alloc, 180-day vesting, NIGHT-denominated
- `launch-nocturne.php` — DV Registration, $NTRN, 203 registered, 15% DV alloc, 365-day vesting, NIGHT-denominated
- WordPress pages created: launch-abyss (ID 33), launch-cipher (ID 34), launch-spectre (ID 35), launch-nocturne (ID 36)

**All existing launch fee splits updated**
- Nightshade, Phantom, Eclipse, Void fee splits standardized to the current 2.0% structure: Creator 1.0% / Treasury 0.6% / Ops 0.4%

**Launch detail pages — Tier C support**
- `lp-header.php` — NIGHT raised label; "Midnight-native · NIGHT-denominated" tag for Tier C
- `lp-dv-active.php` — Midnight notice banner, violet privacy banner dot, NIGHT/ADA dynamic currency, Tier C-specific post-close step copy
- `lp-dv-registration.php` — Midnight notice banner, dynamic currency, ZK proof copy without Cardano qualifier
- `lp-sidebar.php` — "TRADE FEES — 2.0% TOTAL (NIGHT)" title for Tier C; total row updated to 2.00%
- `card.php` — NIGHT/ADA dynamic labels for DV active committed and curve live raised
- New page templates: `page-launch-tier-c-dv-active.php`, `page-launch-tier-c-dv-active-spectre.php`, `page-launch-tier-c-dv-registration.php`, `page-launch-tier-c-dv-registration-nocturne.php`

**Create wizard — Tier C**
- Third tier card (violet, `data-tier="c"`) with MAXIMUM PRIVACY badge in step 5
- `#cw-tier-c-config` panel: Midnight notice, DV date picker, DV alloc slider
- JS: show/hide correct config panel per tier; DEX field hidden for Tier C (Midnight graduation); DV alloc + supply bar active for Tier B and Tier C; DV date wired for both tiers; validation skips Cardano DEX for Tier C; review shows NIGHT-denominated copy + Midnight DEX label; pay summary 250 ADA / 140 ops / 110 treasury for Tier C

**Transparency page**
- Hero: "2 Tier C launches live" pill
- Stats grid: 9 total launches (2A / 5B / 2C); "Total NIGHT raised" stat; DV registrants updated
- ZK certs section updated for Tier C relayer
- New Midnight Network section: DUST/NIGHT stats table, active Tier C launches table, platform PSM status table
- Ops wallet note updated: 30/80/140 ADA per tier + receives NIGHT from Tier C fees

**DarkVeil page — sample shortcuts**
- CTA section at page bottom redesigned: grouped by state with 3 sample cards per group
- Registration Open: Phantom (Tier B), Cipher (Tier C), Nocturne (Tier C)
- DarkVeil Active: Nightshade (Tier B), Abyss (Tier C), Spectre (Tier C)

**Navigation dropdown**
- DarkVeil nav item expanded from 2 items to 6 items in two labelled groups
- Group headings: REGISTRATION OPEN / DARKVEIL ACTIVE
- Tier C items styled with violet tint; mobile menu updated to match

**Offline preview**
- `build-offline.py` updated: added launch-abyss, launch-spectre, launch-cipher, launch-nocturne to PAGES + LABELS
- `noctis-preview.html` rebuilt: 12 pages, 3,573 KB

---

## 2026-06-09 — Tier C spec, repo setup, mobile polish

### Protocol spec
- Added Tier C (Midnight + DarkVeil) to CLAUDE.md — three tiers now fully documented
- Renamed "Two Launch Tiers" to "Three Launch Options"; added comparison table
- Added open issues T17-T21 (all Tier C blockers) to CLAUDE.md and internal tracking
- Fee split table updated to show Tier A/B (ADA) vs Tier C (NIGHT) denomination
- ZK Fair Launch Certificate section updated for Tier C relayer requirement
- Contract architecture section expanded with Tier C PSMs and data flow diagrams
- DarkVeil spec updated with Tier B/C variant notes
- Key Design Principles expanded to 11 items (added Tier C positioning, tier permanence)
- Competitive context updated: Tier C is a unique market position with no current competitor

### Domain
- `noctis.zone` secured. T7 partially resolved (social handles still outstanding).

### GitHub repo
- `MrJustJinx/Noctis_ZKL` initialized with: README.md, ROADMAP.md, CHANGELOG.md, PRE_LAUNCH_CHECKLIST.md, CONTRIBUTING.md, internal tracking
- GitHub Issues created for all open protocol issues (T2-T21)
- Labels created: `blocker`, `important`, `post-mvp`, `tier-c`, `frontend`, `contracts`

### WordPress theme — desktop fix
- Hero logo (`hero-logo-img`) hidden on desktop (`display: none`); restored on mobile via `≤680px` breakpoint override
- Offline preview rebuilt after CSS fix

---

## 2026-06-09 — Mobile responsiveness

### Home page (mobile) — DONE
- Nav: logo scales to 90px on mobile; grid collapses to 2-col (logo left, LAUNCH TOKEN + hamburger right); wallet connect hidden, moved into hamburger menu
- Hero: Noctis logo (360px, negative margins to trim transparent PNG dead space) above eyebrow + heading; heading centred via `margin: auto` on `.redact-line` spans; heading font `clamp(3.9rem, 7.5vw, 6.3rem)`; CTA buttons equal-width side-by-side; stat blocks moved below buttons
- Footer: Platform column removed; only Community and Protocol remain (2-col layout on mobile)

### Launches page (mobile) — DONE
- Header padding fixed: `.launches-header` and `.launches-filterbar-inner` were using `padding: X 0` shorthand, zeroing container horizontal padding — changed to `padding-top`/`padding-bottom` only
- Status filter: desktop tabs hidden; `<select>` dropdown added to PHP template, wired to existing `applyFilters()` JS
- Filter bar stacked: tier filter first, search second, sort third (via CSS `order`)
- Search expands to full width on mobile

### DV Registration page (mobile) — DONE
- Body layout stacks vertically (sidebar below main content)
- Logo placeholder doubled in size on mobile (`min-width: 128px; max-height: 160px`)
- LP header padding fixed (same shorthand issue as launches header)
- Cascade bug fixed: `.lp-body--wide` responsive override was being overridden by a later global rule; fixed by moving the media query directly after the global rule

### Offline HTML preview
- `build-offline.py` created — fetches all 8 pages, inlines CSS/JS/images as base64, outputs single `noctis-preview.html`
- Tab bar removed from combined file; site's own nav drives page switching via postMessage interceptor injected into each page

---

## 2026-06-08 — Fee structure redesign + spec update

- Total trade fee: **2.0%** — Creator Fee Escrow 1.0%, Platform Treasury 0.6% (stablecoin, USDM default), Ops Wallet 0.4% (ADA; purchases NIGHT for DUST)
- Added open issues T14 (stablecoin selection), T16 (community yield mechanism, post-MVP)
- CLAUDE.md, internal tracking, WordPress theme all updated to reflect the fee structure

---

## 2026-06-07 — Platform spec and WordPress foundation

### Protocol spec (CLAUDE.md)
- CLAUDE.md created — full platform specification document
- internal tracking created — open issues register
- All platform constants defined
- DarkVeil full specification documented
- Contract architecture documented (Midnight PSMs + Cardano L1 contracts)
- Creator fee escrow distinction documented (Stream A vs Stream B)
- LP escrow invariants documented (no withdraw(), migration atomicity, whitelist)
- CTO governance rules documented
- Oracle strategy documented (Orcfax + Minswap TWAP + fallback rules)
- Security audit requirements listed

### WordPress theme (noctis.zone)
- Theme scaffolded: `assets/css/main.css`, `assets/js/` structure
- Home page: hero, features, nav, footer
- Launches index: card grid, filter bar, ZK modal
- Launch detail page: LP progress, bonding curve, DV registration panel
- DV Registration page: eligibility, allocation, NIGHT bond
- How It Works page: step cards, FAQ
- Transparency page: 11-section collapsible layout
- Create Launch wizard: 6-step flow with wallet mock
- Design system: pure black `#000000` bg, blue `#0000FE`/`#3366FF` accents, Montserrat + Inter fonts

### Design decisions resolved
- D1: Creator LP DEX choice — no default (forced active selection)
- D2: LP Fee Escrow architecture — DEX fees route through escrow, not direct
