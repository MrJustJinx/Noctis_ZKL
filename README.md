# Noctis Protocol

**They can't front-run what they can't see.**

A three-tier token launchpad built on Cardano L1 and Midnight Network. Private buying phases powered by zero-knowledge proofs, identity-verified whale caps, permanent LP lock, and community rescue mechanics.

---

## Table of Contents

- [Three launch options](#three-launch-options)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [What's built](#whats-built)
- [What's next](#whats-next)
- [Protocol constants (key figures)](#protocol-constants-key-figures)
- [Domain + social](#domain--social)
- [License](#license)

---

## Three launch options

| | Tier A | Tier B | Tier C |
|---|---|---|---|
| **Name** | Cardano Only | Cardano + DarkVeil | Midnight + DarkVeil |
| **Token lives on** | Cardano L1 | Cardano L1 | Midnight Network |
| **DarkVeil phase** | No | Yes | Yes |
| **Trade currency** | ADA | ADA | NIGHT |
| **Privacy level** | None | High | Maximum |

**Tier A** — standard public bonding curve on Cardano. Linear curve, 5% per-address cap (soft — splits possible).

**Tier B** — DarkVeil private pre-sale on Midnight, followed by a quadratic public bonding curve. 5% cap enforced by ZK identity (stake key + graph checks). Token and LP graduate to a Cardano DEX.

**Tier C** — fully Midnight-native. Token, bonding curve, DarkVeil phase, and LP all live on Midnight. Cardano is only used for the ZK Fair Launch Certificate anchor. Priced in NIGHT. Maximum privacy. *(Build-blocked — see internal tracking)*

---

## Architecture

System overview and Midnight PSM flow diagrams, plus a full contract-to-tier reference table.

**[See ARCHITECTURE.md](ARCHITECTURE.md)**

---

## Tech stack

### Public site (noctis.zone)
- **WordPress** — PHP 8.x, custom theme, vanilla JS, no build step
- **No Next.js, no React, no npm** — by design

### Cardano L1 (smart contracts)
- **Language:** Aiken
- **Indexer:** Blockfrost (primary), Maestro / Koios (fallback)
- **Price oracle:** Orcfax (primary), Minswap TWAP (secondary)
- **Graduation DEX:** CSwap (default), Minswap / Splash / Spectrum (whitelist)

### Midnight Network (PSM contracts)
- **Language:** Compact
- **SDK:** Midnight SDK
- **ZK proofs:** Client-side via Midnight proof generation libraries

---

## What's built

> **Where the WordPress frontend actually lives (T70, 2026-07-22):** the "Full WordPress theme" item below is real and complete, but its code is **not tracked in this repository** — a deliberate project convention, not an oversight. The `noctis-platform`/`weldpress` plugins and the `noctis` theme live at a local Local-by-Flywheel site path outside this repo and keep their own `CHANGELOG.md` files instead of git history here (see internal tracking for the open question of how this code eventually ships to a real mainnet deployment). If you've only cloned this repository, you will not find the frontend here — this is expected, not a missing checkout.

- [x] Full WordPress theme — home, launches index, launch detail pages, DV registration, How It Works, Transparency, Create Launch wizard *(not tracked in this repo — see note above)*
- [x] Mobile-responsive — home page, launches page, DV registration page
- [x] Offline shareable preview — single-file `build-offline.py` builder, archived locally, not tracked in this repo
- [x] Platform spec — `CLAUDE.md` (three-tier protocol, all constants, open issues)
- [x] All 9 Cardano/Aiken validators (`bonding_curve.ak`, `bonding_curve_tier_b.ak`, `cto_governance.ak`, `cto_sybil_challenge.ak`, `lp_escrow.ak`, `vesting.ak`, `zk_anchor.ak`, `nhop_challenge.ak`, `staking_pool.ak`) — compile clean, 257 tests
- [x] All 8 Midnight/Compact PSMs (`bonding_curve.compact`, `eligibility_gate.compact`, `creator_escrow.compact`, `treasury.compact`, `vesting.compact`, `lp_escrow.compact`, `cto_governance.compact`, `staking_pool.compact`) — compile clean with full ZK proving keys, 256 tests
- [x] Integration layer — real Blockfrost client, off-chain DarkVeil eligibility checks, Midnight SDK wrapper, wallet connection, ZK cert relayer + Cardano anchor submitter, Orcfax/Minswap price oracles
- [x] **Tier A proven end-to-end on real Cardano Preprod** — mint → buy → graduate → LP lock → creator vesting claim → stall/expire/buyback, every step backed by a real, explorer-verifiable transaction (not simulated). See `TIER_A_PREPROD_MILESTONE.md` (local-only) for the full evidence trail.
- [x] Multiple full adversarial security review passes across both chains — every Aiken validator and every Compact PSM, plus a source/compiled-bytecode consistency pass. All findings resolved or explicitly accepted, each contract change covered by regression tests (257 Aiken checks / 256 Compact tests). Posture summary in `docs/SECURITY_MODEL.md`; full per-finding trail maintained internally and available to auditors on request
- [x] Staking Rewards Pool (T66) — optional per-launch feature, all 3 tiers, spec → WordPress → contracts → **real browser-wallet-signed stake/unstake/claim UI** (Tier A/B, 2026-07-22)
- [x] CTO Governance — both chains' contracts complete and audited; extensive off-chain backend built (voter identity, balance-snapshot builder, Midnight→Cardano relay, sybil-challenge, badge logic). **Not yet built:** the actual propose/vote-casting transaction layer — see What's next.
- [x] Cardano "van Rossem" hard fork (Protocol Version 11, 2026-07-18) reviewed — confirmed non-breaking for every deployed validator

## What's next

See [ROADMAP.md](ROADMAP.md) and internal tracking for the full current, itemized status — this list is a snapshot, not a substitute for those files.

1. CTO Governance vote-casting UI (propose/vote/execute) — the one genuinely unbuilt piece of an otherwise contract-complete, backend-complete feature
2. LP trading-fee harvest UI (Stream B) — contract complete (`HarvestFees`), no frontend yet, and the real per-DEX fee-collection mechanism is still unconfirmed for any DEX
3. Real Preprod verification of the new Staking UI (stake → bonding period → reward publish → claim → unstake, end-to-end with real tx hashes)
4. WordPress frontend: final polish + production deployment to noctis.zone
5. Preprod deployment + real DUST cost measurement (partially resolved, T5 — a lower-bound figure exists, full sizing still open)
6. Independent professional security audit (extensive internal review has run across many passes, but isn't a substitute — see `docs/SECURITY_MODEL.md`)
7. Tier C blockers: a ratified Midnight fungible token standard, a graduation-target DEX (T17/T18)
8. Mainnet launch

> **Keeping this file current:** this README, `ARCHITECTURE.md`, `architecture.html`, and `docs/PSM_ARCHITECTURE.md` all drift out of date quickly given how fast this project moves — update all four whenever a major milestone lands (a new feature ships, a security pass completes, a tier's build-blocked status changes), not just when someone happens to notice they're stale.

---

## Protocol constants (key figures)

| Constant | Value | Notes |
|---|---|---|
| Total supply | 1,000,000,000 | Hard cap |
| DV allocation | 10–20% (default 15%) | Creator-adjustable |
| Wallet cap | 5% | Cumulative across DV + public |
| NIGHT bond | $50 USD | Required for DV registration |
| Total trade fee | 2.0% | Split: 1.0% creator / 0.6% treasury / 0.4% ops |
| LP lock | 365 days | No withdraw ever |
| Creator vesting | 90–365 days | No default — forced active selection |

Full constants in [CLAUDE.md](CLAUDE.md).

---

## Domain + social

- **Website:** [noctis.zone](https://noctis.zone) *(domain secured — site not yet live)*
- **GitHub:** [github.com/MrJustJinx/Noctis_ZKL](https://github.com/MrJustJinx/Noctis_ZKL)
- **Twitter/X:** [@Noctis_Zone](https://x.com/Noctis_Zone)
- **Discord:** [discord.gg/FkFwHFN6Aq](https://discord.gg/FkFwHFN6Aq)

---

## License

Private. Internal use only.

---

*Built on Cardano + Midnight because privacy should be a default, not a feature.*
