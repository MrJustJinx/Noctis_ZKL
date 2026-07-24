// ============================================================================
// Compact runtime type-descriptor helpers
// ============================================================================
//
// Every `persistentHash<T>(value)` call inside a `.compact` circuit compiles
// down to `__compactRuntime.persistentHash(descriptor, value)`, where
// `descriptor` is a hand-generated CompactType implementing
// `alignment()` / `fromValue()` / `toValue()` for T — see e.g.
// `contracts/midnight/compiled/darkveil/contract/index.js`'s
// `_BuyCommitInput_0`/`_NullifierInput_0`/`_CertHashInput_0` classes.
//
// Those descriptor classes are compiler-generated per-contract and are NOT
// exported from the compiled module (only `export circuit` functions reach
// the public `Circuits<PS>` type) — so they can't be imported directly.
// This file reproduces the same construction pattern using ONLY confirmed
// public exports from `@midnight-ntwrk/compact-runtime`
// (`persistentHash`, `CompactTypeBytes`, `CompactTypeVector`,
// `CompactTypeUnsignedInteger`), so that off-chain code can compute
// byte-identical hashes to what each PSM's `pure circuit` helpers compute
// on-chain. `tests/hash-parity.test.ts` proves this by calling a real
// compiled circuit and checking it accepts a value computed here.
//
// If you add a helper for a new struct, verify it the same way: find (or
// add) an `export circuit` that internally calls the corresponding
// `pure circuit`, feed it the witness inputs, and confirm it doesn't throw.
// ============================================================================

import {
  persistentHash,
  CompactTypeBytes,
  CompactTypeVector,
  CompactTypeUnsignedInteger,
  type CompactType,
} from '@midnight-ntwrk/compact-runtime';

/** `Bytes<32>` — used for every key, launch ID, commitment, and nullifier in these PSMs. */
export const bytes32Type: CompactType<Uint8Array> = new CompactTypeBytes(32);

/**
 * `Uint<bits>` — matches the compiler's own encoding exactly:
 * `CompactTypeUnsignedInteger(2^bits - 1, bits / 8)`, confirmed against
 * compiled output (`Uint<128>` → `CompactTypeUnsignedInteger(2n**128n - 1n, 16)`,
 * `Uint<64>` → `CompactTypeUnsignedInteger(2n**64n - 1n, 8)`).
 */
export function uintType(bits: 8 | 16 | 32 | 64 | 128): CompactType<bigint> {
  const maxValue = 2n ** BigInt(bits) - 1n;
  return new CompactTypeUnsignedInteger(maxValue, bits / 8);
}

/**
 * `pad(32, s)` — Compact's stdlib domain-separator helper. Confirmed from
 * compiled output: UTF-8 bytes of `s`, right-padded with zero bytes to a
 * fixed 32-byte length. Throws if `s` doesn't fit.
 */
export function pad32(s: string): Uint8Array {
  const encoded = new TextEncoder().encode(s);
  if (encoded.length > 32) {
    throw new Error(`pad32: "${s}" is ${encoded.length} bytes, exceeds 32`);
  }
  const out = new Uint8Array(32);
  out.set(encoded);
  return out;
}

/**
 * Builds a `CompactType` for a struct, given its fields **in declaration
 * order** (Compact concatenates alignment/value bytes in the order fields
 * are declared in the `struct`, not necessarily the order used in a struct
 * literal at the call site — confirmed against compiled `_BuyCommitInput_0`
 * etc.). This generalizes the hand-rolled per-struct classes the compiler
 * emits into one reusable helper.
 */
export function structType<T extends object>(
  fields: ReadonlyArray<readonly [keyof T & string, CompactType<any>]>,
): CompactType<T> {
  return {
    alignment() {
      return fields
        .map(([, type]) => type.alignment())
        .reduce((acc, a) => acc.concat(a));
    },
    fromValue(value) {
      const result = {} as T;
      for (const [name, type] of fields) {
        result[name] = type.fromValue(value);
      }
      return result;
    },
    toValue(value: T) {
      return fields
        .map(([name, type]) => type.toValue(value[name]))
        .reduce((acc, v) => acc.concat(v));
    },
  };
}

/** A 2-element `Vector<2, Bytes<32>>` — the shape every `deriveXxxKey` helper hashes (`[pad32(domain), secretBytes]`). */
export const domainKeyVectorType: CompactType<Uint8Array[]> = new CompactTypeVector(2, bytes32Type);

/** Hashes `[pad32(domain), secretBytes]` — the exact pattern every PSM's `deriveUserPublicKey`/`deriveGovernorKey` uses. */
export function hashDomainKey(domain: string, secretBytes: Uint8Array): Uint8Array {
  return persistentHash(domainKeyVectorType, [pad32(domain), secretBytes]);
}

export { persistentHash };
