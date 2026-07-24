// Noctis Protocol — esbuild build script.
// Node-platform CLI bundles only (for PHP's proc_open-invoked one-shot
// checks). Run: node build.mjs [--watch]
//
// T80 (2026-07-17): the browser widget bundles (DarkVeil, Tier A buy) moved
// OFF esbuild entirely, to webpack.widgets.config.cjs — esbuild's WASM
// handling cannot correctly link wasm-bindgen's `--target bundler` output
// that several Lucid Evolution/Midnight transitive deps ship, which broke
// window.NoctisDarkVeil/window.NoctisTierABuy at runtime with no build-time
// error. Run `npm run build:widgets` for those. This file no longer builds
// or references either widget.
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

const cliConfig = {
  entryPoints: [join(__dirname, 'cli/check-night-balance.ts')],
  outfile: join(__dirname, 'cli/dist/check-night-balance.mjs'),
  bundle: true,
  platform: 'node',
  // ESM output (not CJS): @midnight-ntwrk/ledger-v8's WASM loader resolves
  // its .wasm file's path via a real `import.meta.url` — under esbuild's
  // CJS output, import.meta has no equivalent and gets shimmed to
  // `undefined`, breaking that path resolution (found the hard way: same
  // TypeError as a raw `fileURLToPath(undefined)` call). ESM output keeps
  // import.meta.url real and correct.
  //
  // The tradeoff: `cbor` (a CJS-only package) has a dynamic (non-static)
  // require() call esbuild can't safely convert for ESM output, and throws
  // "Dynamic require of 'stream' is not supported" if bundled. Rather than
  // bundle it, `cbor` is left external below — Node's own ESM/CJS interop
  // resolves a plain `import` of a CJS package via real node_modules
  // resolution at runtime (walking up from this file's real location, i.e.
  // finding integration/node_modules/cbor regardless of invocation cwd),
  // with no esbuild shim involved for it at all.
  external: ['cbor'],
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

const allowlistTreeCliConfig = {
  entryPoints: [join(__dirname, 'cli/build-allowlist-tree.ts')],
  outfile: join(__dirname, 'cli/dist/build-allowlist-tree.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

// T112/T76 (2026-07-19): pure off-chain crypto, no Lucid/Midnight WASM
// dependency — same simple ESM shape as allowlistTreeCliConfig above.
const buildDvAllocationTreeCliConfig = {
  entryPoints: [join(__dirname, 'cli/build-dv-allocation-tree.ts')],
  outfile: join(__dirname, 'cli/dist/build-dv-allocation-tree.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

const getDvAllocationProofCliConfig = {
  entryPoints: [join(__dirname, 'cli/get-dv-allocation-proof.ts')],
  outfile: join(__dirname, 'cli/dist/get-dv-allocation-proof.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

const verifyCtoVoterRegistrationCliConfig = {
  entryPoints: [join(__dirname, 'cli/verify-cto-voter-registration.ts')],
  outfile: join(__dirname, 'cli/dist/verify-cto-voter-registration.mjs'),
  bundle: true,
  platform: 'node',
  // ESM, not CJS — found the hard way (real runtime error, not assumed):
  // this CLI is the first in this codebase to mix BOTH Midnight
  // (witnesses.ts's deriveUserPublicKey, transitively needing
  // @midnight-ntwrk/ledger-v8's WASM loader, which needs a real
  // import.meta.url — the same reasoning cliConfig above documents) AND
  // Cardano/Lucid Evolution (verifyData/getAddressDetails, transitively
  // needing CML's WASM loader, which readTierALaunchStateCliConfig's own
  // comment says needs a real bare __dirname instead). Tried CJS first
  // (matching the other Lucid-only CLIs) — failed at runtime with
  // `fileURLToPath(undefined)` inside midnight-ledger-wasm's loader
  // (import.meta.url shimmed to undefined under CJS). ESM alone then
  // failed the OTHER way — `ReferenceError: __dirname is not defined`
  // inside CML's own loader, once esbuild had inlined/relocated it into
  // the single bundle file. Neither format alone satisfies both. Fixed by
  // marking CML external (same idiom as cbor below) — Node's own native
  // ESM/CJS interop then resolves it fresh from its real node_modules
  // location at runtime, where __dirname is genuinely still valid,
  // instead of esbuild concatenating it into a context where it isn't.
  // Externalizing individual WASM-bearing packages kept surfacing the same
  // class of error against a NEW transitive package each time (CML, then
  // bip39, then @lucid-evolution/uplc, then @subsquid/util-internal-hex —
  // each doing its own dynamic require() of a Node builtin esbuild's ESM
  // shim can't handle). This CLI is the first in this codebase mixing
  // Midnight's + Cardano's FULL dependency trees in one bundle, and
  // whack-a-moling individual package names has no clear end. Switched
  // strategy entirely: `packages: 'external'` (a real, documented esbuild
  // option) stops bundling ANY node_modules dependency at all — only this
  // CLI's own local relative imports (../cto-voter-registration.js etc.)
  // get bundled; every real npm package resolves natively via Node's own
  // module resolution at runtime, where its own __dirname/import.meta.url
  // context is always correct regardless of format. This sidesteps the
  // whole class of conflict in one step rather than chasing it package by
  // package. WASM_FILES copying (below) still applies unchanged — those
  // packages' own real file locations in node_modules are what matters now
  // that they're not relocated by bundling.
  packages: 'external',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

const checkCtoBadgeStatusCliConfig = {
  entryPoints: [join(__dirname, 'cli/check-cto-badge-status.ts')],
  outfile: join(__dirname, 'cli/dist/check-cto-badge-status.mjs'),
  bundle: true,
  platform: 'node',
  // ESM, same reasoning as cliConfig above — this touches Midnight packages
  // (indexer-public-data-provider, the compiled cto_governance contract's
  // ledger()), same WASM/import.meta.url class as check-night-balance.ts.
  external: ['cbor'],
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

const readTierALaunchStateCliConfig = {
  entryPoints: [join(__dirname, 'cli/read-tier-a-launch-state.ts')],
  outfile: join(__dirname, 'cli/dist/read-tier-a-launch-state.cjs'),
  bundle: true,
  platform: 'node',
  // CJS, not ESM — unlike cliConfig (which needs import.meta.url for real
  // for @midnight-ntwrk/ledger-v8's WASM loading), this script is pure
  // Cardano/Lucid Evolution with no Midnight dependency. Found the hard way
  // (real runtime error, not assumed): @anastasia-labs/cardano-multiplatform-
  // lib-nodejs (a Lucid Evolution transitive dep) references a bare
  // `__dirname` internally to locate its own WASM file — a CJS-only global
  // that doesn't exist under ESM output and that esbuild does not shim for
  // bundled (not external) dependencies. CJS format provides it natively.
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

const buildGenesisDatumsCliConfig = {
  entryPoints: [join(__dirname, 'cli/build-tier-a-genesis-datums.ts')],
  outfile: join(__dirname, 'cli/dist/build-tier-a-genesis-datums.cjs'),
  bundle: true,
  platform: 'node',
  // CJS for the same reason as readTierALaunchStateCliConfig above (a Lucid
  // Evolution transitive dep needs a real bare __dirname).
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

const activateCurveCliConfig = {
  entryPoints: [join(__dirname, 'cli/activate-tier-a-curve.ts')],
  outfile: join(__dirname, 'cli/dist/activate-tier-a-curve.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs', // same __dirname/CML-WASM reasoning as readTierALaunchStateCliConfig
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

// T74 (2026-07-21): one consolidated action-dispatched CLI for Tier B's
// public curve (activate/buy/claim-*-fees/expire/claim-buyback) — same
// __dirname/CML-WASM CJS reasoning as activateCurveCliConfig above (Lucid
// Evolution's own bundled CML dependency needs a real __dirname at runtime,
// which ESM output doesn't provide the same way).
const tierBCurveActionCliConfig = {
  entryPoints: [join(__dirname, 'cli/tier-b-curve-action.ts')],
  outfile: join(__dirname, 'cli/dist/tier-b-curve-action.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

// T66 staking UI (2026-07-22): one consolidated action-dispatched CLI for
// staking_pool.ak (stake/unstake/claim-rewards/top-up/publish-reward-root/
// read-pool/read-positions/build-reward-snapshot/get-reward-proof), same
// pattern as tierBCurveActionCliConfig above.
const stakeActionCliConfig = {
  entryPoints: [join(__dirname, 'cli/stake-action.ts')],
  outfile: join(__dirname, 'cli/dist/stake-action.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

const anchorDvAllocationRootCliConfig = {
  entryPoints: [join(__dirname, 'cli/anchor-dv-allocation-root-tier-b.ts')],
  outfile: join(__dirname, 'cli/dist/anchor-dv-allocation-root-tier-b.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs', // same __dirname/CML-WASM reasoning as readTierALaunchStateCliConfig
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

const buyCurveCliConfig = {
  entryPoints: [join(__dirname, 'cli/buy-tier-a-curve.ts')],
  outfile: join(__dirname, 'cli/dist/buy-tier-a-curve.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

const sellCurveCliConfig = {
  entryPoints: [join(__dirname, 'cli/sell-tier-a-curve.ts')],
  outfile: join(__dirname, 'cli/dist/sell-tier-a-curve.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

const expireCurveCliConfig = {
  entryPoints: [join(__dirname, 'cli/expire-tier-a-curve.ts')],
  outfile: join(__dirname, 'cli/dist/expire-tier-a-curve.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

const claimBuybackCliConfig = {
  entryPoints: [join(__dirname, 'cli/claim-buyback-tier-a.ts')],
  outfile: join(__dirname, 'cli/dist/claim-buyback-tier-a.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

const graduateLaunchCliConfig = {
  entryPoints: [join(__dirname, 'cli/graduate-tier-a-launch.ts')],
  outfile: join(__dirname, 'cli/dist/graduate-tier-a-launch.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs', // same __dirname/CML-WASM reasoning as readTierALaunchStateCliConfig
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

const graduateTierBLaunchCliConfig = {
  entryPoints: [join(__dirname, 'cli/graduate-tier-b-launch.ts')],
  outfile: join(__dirname, 'cli/dist/graduate-tier-b-launch.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs', // same __dirname/CML-WASM reasoning as readTierALaunchStateCliConfig
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

const startVestingCliConfig = {
  entryPoints: [join(__dirname, 'cli/start-vesting-tier-a.ts')],
  outfile: join(__dirname, 'cli/dist/start-vesting-tier-a.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs', // same __dirname/CML-WASM reasoning as readTierALaunchStateCliConfig
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

const proposeDexChangeCliConfig = {
  entryPoints: [join(__dirname, 'cli/propose-dex-change-tier-a.ts')],
  outfile: join(__dirname, 'cli/dist/propose-dex-change-tier-a.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs', // same __dirname/CML-WASM reasoning as readTierALaunchStateCliConfig
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

const executeDexChangeCliConfig = {
  entryPoints: [join(__dirname, 'cli/execute-dex-change-tier-a.ts')],
  outfile: join(__dirname, 'cli/dist/execute-dex-change-tier-a.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs', // same __dirname/CML-WASM reasoning as readTierALaunchStateCliConfig
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

const migrateLpToMinswapCliConfig = {
  entryPoints: [join(__dirname, 'cli/migrate-lp-to-minswap-tier-a.ts')],
  outfile: join(__dirname, 'cli/dist/migrate-lp-to-minswap-tier-a.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs', // same __dirname/CML-WASM reasoning as readTierALaunchStateCliConfig
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

const claimVestedCliConfig = {
  entryPoints: [join(__dirname, 'cli/claim-vested-tier-a.ts')],
  outfile: join(__dirname, 'cli/dist/claim-vested-tier-a.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs', // same __dirname/CML-WASM reasoning as readTierALaunchStateCliConfig
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

const claimCreatorFeesCliConfig = {
  entryPoints: [join(__dirname, 'cli/claim-creator-fees-tier-a.ts')],
  outfile: join(__dirname, 'cli/dist/claim-creator-fees-tier-a.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs', // same __dirname/CML-WASM reasoning as readTierALaunchStateCliConfig
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

const readTradeHistoryCliConfig = {
  entryPoints: [join(__dirname, 'cli/read-tier-a-trade-history.ts')],
  outfile: join(__dirname, 'cli/dist/read-tier-a-trade-history.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs', // same __dirname/CML-WASM reasoning as readTierALaunchStateCliConfig
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

const checkCtoCreatorActivityCliConfig = {
  entryPoints: [join(__dirname, 'cli/check-cto-creator-activity-tier-a.ts')],
  outfile: join(__dirname, 'cli/dist/check-cto-creator-activity-tier-a.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs', // same __dirname/CML-WASM reasoning as readTierALaunchStateCliConfig
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

// T76 (2026-07-20): governor-side reader for eligibility_gate.compact's
// dvTokensPurchased map — touches Midnight packages (ledger()/indexer
// provider), same real-import.meta.url/WASM reasoning as
// checkCtoBadgeStatusCliConfig above.
const readDvPurchasesCliConfig = {
  entryPoints: [join(__dirname, 'cli/read-dv-purchases.ts')],
  outfile: join(__dirname, 'cli/dist/read-dv-purchases.mjs'),
  bundle: true,
  platform: 'node',
  external: ['cbor'],
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

// T73 (2026-07-21): server-side wallet + ContractProviders assembly
// (midnight-server-wallet.ts) for the governor allowlist-root publisher —
// depends on @midnight-ntwrk/wallet-sdk-* (HD derivation, WalletFacade)
// plus midnight-js-contracts, same WASM dependency (ledger-v8) as
// readDvPurchasesCliConfig, no package-specific WASM of its own.
const publishAllowlistRootCliConfig = {
  entryPoints: [join(__dirname, 'cli/publish-allowlist-root.ts')],
  outfile: join(__dirname, 'cli/dist/publish-allowlist-root.mjs'),
  bundle: true,
  platform: 'node',
  external: ['cbor'],
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

// T76: pure Lucid Evolution address parsing (getAddressDetails) — CJS for
// the same __dirname/CML-WASM reasoning as readTierALaunchStateCliConfig.
const resolveAddressVkhCliConfig = {
  entryPoints: [join(__dirname, 'cli/resolve-address-payment-key-hashes.ts')],
  outfile: join(__dirname, 'cli/dist/resolve-address-payment-key-hashes.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

// Midnight unshielded address derivation from a wallet seed — uses the wallet
// SDK (HD + unshielded keystore), so ESM output + external cbor, same as
// check-night-balance's cliConfig (the WASM/import.meta reasoning above).
const deriveMidnightAddressCliConfig = {
  entryPoints: [join(__dirname, 'cli/derive-midnight-address.ts')],
  outfile: join(__dirname, 'cli/dist/derive-midnight-address.mjs'),
  bundle: true,
  platform: 'node',
  external: ['cbor'],
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
  // A transitive dep does a dynamic require('assert'). esbuild's ESM output
  // can't convert that; shim a real require() from import.meta.url so the
  // bundle resolves Node built-ins/CJS deps at runtime.
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
};

// Midnight wallet NIGHT balance (+ derived DUST capacity) — address derivation
// + a public-indexer NIGHT-balance query (getUnshieldedNightBalance), same
// WASM/ESM+banner needs as check-night-balance.
const midnightWalletBalanceCliConfig = {
  entryPoints: [join(__dirname, 'cli/midnight-wallet-balance.ts')],
  outfile: join(__dirname, 'cli/dist/midnight-wallet-balance.mjs'),
  bundle: true,
  platform: 'node',
  external: ['cbor'],
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
};

// Several packages load a WASM binary via a readFileSync relative to their
// own module location at runtime — esbuild bundles the *reference* to that
// read, not the binary itself, so each has to be copied next to every CLI
// bundle's output by hand. Found the hard way, three times now: ledger-v8's
// midnight_ledger_wasm_bg.wasm (nativeToken(), used by check-night-balance.ts),
// onchain-runtime-v3's midnight_onchain_runtime_wasm_bg.wasm
// (persistentHash(), used by build-allowlist-tree.ts via packages/zk-proofs),
// and @anastasia-labs/cardano-multiplatform-lib-nodejs's own
// cardano_multiplatform_lib_bg.wasm (a Lucid Evolution transitive dep, used
// by read-tier-a-launch-state.ts). Every one of the three bundles built
// clean each time; only a real run surfaced the missing file.
const WASM_FILES = [
  'node_modules/@midnight-ntwrk/ledger-v8/midnight_ledger_wasm_bg.wasm',
  'node_modules/@midnight-ntwrk/onchain-runtime-v3/midnight_onchain_runtime_wasm_bg.wasm',
  'node_modules/@anastasia-labs/cardano-multiplatform-lib-nodejs/cardano_multiplatform_lib_bg.wasm',
  'node_modules/@lucid-evolution/uplc/dist/node/uplc_tx_bg.wasm',
  'node_modules/@emurgo/cardano-message-signing-nodejs/cardano_message_signing_bg.wasm',
];

async function copyWasmFiles() {
  const { copyFileSync, mkdirSync, existsSync } = await import('node:fs');
  const destDirs = new Set([
    dirname(cliConfig.outfile),
    dirname(allowlistTreeCliConfig.outfile),
    dirname(readTierALaunchStateCliConfig.outfile),
    dirname(buildGenesisDatumsCliConfig.outfile),
    dirname(activateCurveCliConfig.outfile),
    dirname(buyCurveCliConfig.outfile),
    dirname(sellCurveCliConfig.outfile),
    dirname(graduateLaunchCliConfig.outfile),
    dirname(graduateTierBLaunchCliConfig.outfile),
    dirname(startVestingCliConfig.outfile),
    dirname(proposeDexChangeCliConfig.outfile),
    dirname(executeDexChangeCliConfig.outfile),
    dirname(migrateLpToMinswapCliConfig.outfile),
    dirname(claimVestedCliConfig.outfile),
    dirname(claimCreatorFeesCliConfig.outfile),
    dirname(expireCurveCliConfig.outfile),
    dirname(claimBuybackCliConfig.outfile),
    dirname(readTradeHistoryCliConfig.outfile),
    dirname(checkCtoCreatorActivityCliConfig.outfile),
    dirname(checkCtoBadgeStatusCliConfig.outfile),
    dirname(verifyCtoVoterRegistrationCliConfig.outfile),
    dirname(buildDvAllocationTreeCliConfig.outfile),
    dirname(getDvAllocationProofCliConfig.outfile),
    dirname(anchorDvAllocationRootCliConfig.outfile),
    dirname(readDvPurchasesCliConfig.outfile),
    dirname(publishAllowlistRootCliConfig.outfile),
    dirname(tierBCurveActionCliConfig.outfile),
    dirname(resolveAddressVkhCliConfig.outfile),
    dirname(stakeActionCliConfig.outfile),
  ]);
  for (const destDir of destDirs) {
    mkdirSync(destDir, { recursive: true });
    for (const rel of WASM_FILES) {
      const src = join(__dirname, rel);
      if (existsSync(src)) {
        copyFileSync(src, join(destDir, rel.split('/').pop()));
      } else {
        console.warn(`WARNING: ${src} not found — a CLI bundle depending on it will fail at runtime.`);
      }
    }
  }
}

async function run() {
  const configs = [
    cliConfig, allowlistTreeCliConfig, readTierALaunchStateCliConfig, buildGenesisDatumsCliConfig,
    activateCurveCliConfig, buyCurveCliConfig, sellCurveCliConfig, graduateLaunchCliConfig, graduateTierBLaunchCliConfig, startVestingCliConfig,
    proposeDexChangeCliConfig, executeDexChangeCliConfig, migrateLpToMinswapCliConfig,
    claimVestedCliConfig, claimCreatorFeesCliConfig, expireCurveCliConfig, claimBuybackCliConfig,
    readTradeHistoryCliConfig, checkCtoCreatorActivityCliConfig, checkCtoBadgeStatusCliConfig,
    verifyCtoVoterRegistrationCliConfig, buildDvAllocationTreeCliConfig, getDvAllocationProofCliConfig,
    anchorDvAllocationRootCliConfig, readDvPurchasesCliConfig, publishAllowlistRootCliConfig,
    tierBCurveActionCliConfig, resolveAddressVkhCliConfig, stakeActionCliConfig,
    deriveMidnightAddressCliConfig, midnightWalletBalanceCliConfig,
  ];

  if (watch) {
    const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    await copyWasmFiles();
    console.log('Watching for changes...');
  } else {
    await Promise.all(configs.map((c) => esbuild.build(c)));
    await copyWasmFiles();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
