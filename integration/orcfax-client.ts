// ============================================================================
// Noctis Protocol — Orcfax ADA/USD Datum Reader (T65 check #2 / Oracle Strategy)
// ============================================================================
//
// Reads Orcfax's real ADA-USD price feed directly from its on-chain datum via
// Blockfrost — no NIGHT feed exists (see ORACLE STRATEGY in CLAUDE.md), so
// this only ever reads ADA/USD; NIGHT/USD is derived elsewhere by combining
// this with Minswap's NIGHT/ADA TWAP (see night-price-oracle.ts).
//
// Verified against orcfax/datum-demo (github.com/orcfax/datum-demo,
// read_datum.py) rather than guessed: query all UTXOs at the feed's known
// oracle script address, keep only ones carrying a token under the feed's
// auth policy (proves the UTXO is a genuine Orcfax publication, not a
// lookalike), pick the one with the latest validity timestamp, decode its
// CBOR datum.
//
// Datum shape (confirmed by decoding the exact example bytes from that
// demo's own docstring with the real `cbor` npm package, not assumed from
// the Python source alone):
//   Top-level: CBOR tag 121, wrapping a 4-element array:
//     [0] a CBOR map (byte-string keys, not text-string -- Orcfax encodes
//         all keys as CBOR major-type-2 byte strings) with fields
//         including `name` (e.g. "ADA-USD|USD-ADA") and `value` (below).
//     [1] a statement identifier (not needed here).
//     [2] tag 122, wrapping [validFrom timestamp ms, ...] -- used to pick
//         the freshest UTXO.
//     [3] (unused here).
//   `value` is a 2-element array, each a CBOR tag 124 wrapping
//     [significand, exponent], computing significand * 10^exponent.
//
// CRITICAL, verified-not-guessed detail: the exponent (and potentially the
// significand) arrive as a raw unsigned 64-bit magnitude even when
// semantically negative -- e.g. a real exponent of -5 is encoded as
// 18446744073709551611 (2^64 - 5). Recovering the true value needs
// `BigInt.asIntN(64, raw)`. This matches why the Python demo does a
// `numpy.uint64().astype(numpy.int64)` reinterpretation -- confirmed this
// is a real requirement of Orcfax's format, not defensive paranoia, by
// decoding the demo's own real example datum bytes and cross-checking the
// two ADA-USD/USD-ADA values are reciprocals of each other once the fix is
// applied (they were not, before).
// ============================================================================

import cbor from 'cbor';
import type { BlockfrostClient } from './blockfrost-client.js';

export interface OrcfaxFeedConfig {
  /** The feed's oracle script address (holds the datum-bearing UTXO). */
  oracleAddress: string;
  /** Policy ID of the auth token that proves a UTXO is a genuine Orcfax publication. */
  authPolicy: string;
  /** The feed's own name field, e.g. "ADA-USD|USD-ADA" -- used to locate the right value index. */
  feedName: string;
  /** Which side of the pair to read, matching one segment of feedName split on "|". */
  wantedLabel: string;
}

// Real, confirmed-live PREPROD config (github.com/orcfax/datum-demo,
// read_datum.py) -- safe to use against preprod/testnet, e.g. for local
// testing. There is currently no known-good MAINNET equivalent: Orcfax's
// docs describe a different-looking discovery mechanism (a
// FactStatementPointer registry) that this module does not implement,
// since the working real-world example (this demo) uses a fixed address +
// auth-policy check instead, and no mainnet address/policy pair for that
// simpler pattern was found via public research. Do not use this config
// against mainnet -- it is a real, different Cardano address than
// mainnet's ADA-USD feed.
export const ORCFAX_ADA_USD_PREPROD_CONFIG: OrcfaxFeedConfig = {
  oracleAddress: 'addr_test1wrtcecfy7np3sduzn99ffuv8qx2sa8v977l0xql8ca7lgkgmktuc0',
  authPolicy: '104d51dd927761bf5d50d32e1ede4b2cff477d475fe32f4f780a4b21',
  feedName: 'ADA-USD|USD-ADA',
  wantedLabel: 'ADA-USD',
};

export interface OracleValue {
  significand: bigint;
  exponent: bigint;
  asFloat: number;
}

export interface OrcfaxAdaUsdResult {
  price: OracleValue;
  /** Milliseconds since epoch -- compare against ORACLE_STALENESS_MIN (10 min). */
  timestampMs: number;
}

function toSigned64(value: unknown): bigint {
  const big = typeof value === 'bigint' ? value : BigInt(value as number);
  return BigInt.asIntN(64, big);
}

function decodeTaggedNumber(tagged: cbor.Tagged): OracleValue {
  if (tagged.tag !== 124) {
    throw new Error(`expected Orcfax rational-number tag 124, got tag ${tagged.tag}`);
  }
  const [rawSignificand, rawExponent] = tagged.value as [unknown, unknown];
  const significand = toSigned64(rawSignificand);
  const exponent = toSigned64(rawExponent);
  return {
    significand,
    exponent,
    asFloat: Number(significand) * Math.pow(10, Number(exponent)),
  };
}

/** Recursively converts CBOR Maps (Buffer keys) into plain objects with string keys. */
function normalizeDatum(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) {
      const key = Buffer.isBuffer(k) ? k.toString('utf8') : String(k);
      obj[key] = normalizeDatum(v);
    }
    return obj;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeDatum);
  }
  return value;
}

function unitMatchesPolicy(unit: string, policyId: string): boolean {
  return unit.startsWith(policyId);
}

/**
 * Read the real, current ADA/USD price from Orcfax's on-chain datum. Throws
 * if no UTXO at the configured address carries the auth token, or if the
 * datum doesn't match the expected shape -- never silently returns a
 * fabricated price.
 */
export async function getOrcfaxAdaUsdPrice(
  blockfrostClient: BlockfrostClient,
  config: OrcfaxFeedConfig = ORCFAX_ADA_USD_PREPROD_CONFIG
): Promise<OrcfaxAdaUsdResult> {
  const utxos = await blockfrostClient.getAddressUtxos(config.oracleAddress);

  const authentic = utxos.filter(
    (utxo) =>
      utxo.inline_datum !== null &&
      utxo.amount.some((a) => unitMatchesPolicy(a.unit, config.authPolicy))
  );

  if (authentic.length === 0) {
    throw new Error(
      `No authentic Orcfax UTXO found at ${config.oracleAddress} (auth policy ${config.authPolicy})`
    );
  }

  let latest: { timestampMs: number; datum: Record<string, unknown> } | null = null;

  for (const utxo of authentic) {
    const raw = cbor.decodeFirstSync(Buffer.from(utxo.inline_datum as string, 'hex'));
    if (!(raw instanceof cbor.Tagged) || raw.tag !== 121) {
      continue;
    }
    const [datumMapRaw, , validity] = raw.value as [unknown, unknown, cbor.Tagged];
    if (!(validity instanceof cbor.Tagged) || validity.tag !== 122) {
      continue;
    }
    const timestampMs = Number((validity.value as unknown[])[0]);
    const datum = normalizeDatum(datumMapRaw) as Record<string, unknown>;

    if (latest === null || timestampMs > latest.timestampMs) {
      latest = { timestampMs, datum };
    }
  }

  if (latest === null) {
    throw new Error(`No Orcfax UTXO at ${config.oracleAddress} had a decodable statement datum`);
  }

  const name = latest.datum.name as string;
  if (name !== config.feedName) {
    throw new Error(`Expected Orcfax feed name "${config.feedName}", got "${name}"`);
  }
  const labels = name.split('|');
  const index = labels.indexOf(config.wantedLabel);
  if (index === -1) {
    throw new Error(`"${config.wantedLabel}" not found in feed labels [${labels.join(', ')}]`);
  }

  const values = latest.datum.value as cbor.Tagged[];
  const price = decodeTaggedNumber(values[index]);

  return { price, timestampMs: latest.timestampMs };
}
