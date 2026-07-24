import { describe, it, expect } from 'vitest';
import { hashDvLeaf, hashDvNode, buildDvAllocationTree, verifyDvMerkleProof } from '../dv-allocation-tree.js';

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex').toUpperCase();
}

describe('hashDvLeaf / hashDvNode — ground truth', () => {
  it('matches real values extracted from a live aiken check run against bonding_curve_tier_b.ak', () => {
    // Ground truth captured 2026-07-19 via a temporary `trace`-based Aiken
    // test (removed after use — see dv-allocation-tree.ts's own header
    // comment for the exact source values traced: hash_dv_leaf(#"aa", 100,
    // #"01"), hash_dv_leaf(#"bb", 200, #"02"), hash_dv_node(leaf0, leaf1)).
    const leaf0 = hashDvLeaf(new Uint8Array([0xaa]), 100n, new Uint8Array([0x01]));
    const leaf1 = hashDvLeaf(new Uint8Array([0xbb]), 200n, new Uint8Array([0x02]));
    const node = hashDvNode(leaf0, leaf1);

    expect(hex(leaf0)).toBe('E77EF6077DD8FE98C5A33022218E5EB21E055EE0335B61AEF50A05D2C726DDE1');
    expect(hex(leaf1)).toBe('13F8526E384BEE96FCE7E774030057412CD2648286A757BF33366900E70FBF7D');
    expect(hex(node)).toBe('D823C9ABF2238F0CA733D78F60AD2C75661DB04CBE73A23FDA034D8780B2FAF3');
  });
});

describe('buildDvAllocationTree', () => {
  const entry = (b: number, amount: bigint, s: number) => ({
    vkh: new Uint8Array([b]),
    dvAmount: amount,
    salt: new Uint8Array([s]),
  });

  it('single entry — root equals the leaf, empty proof', () => {
    const entries = [entry(0xaa, 100n, 0x01)];
    const tree = buildDvAllocationTree(entries);
    const leaf = hashDvLeaf(entries[0].vkh, entries[0].dvAmount, entries[0].salt);
    expect(hex(tree.root)).toBe(hex(leaf));
    expect(tree.getProof(0)).toEqual([]);
    expect(verifyDvMerkleProof(tree.root, leaf, tree.getProof(0))).toBe(true);
  });

  it('two entries — matches the same ground-truth root as the direct hashDvNode call', () => {
    const entries = [entry(0xaa, 100n, 0x01), entry(0xbb, 200n, 0x02)];
    const tree = buildDvAllocationTree(entries);
    expect(hex(tree.root)).toBe('D823C9ABF2238F0CA733D78F60AD2C75661DB04CBE73A23FDA034D8780B2FAF3');
    for (let i = 0; i < entries.length; i++) {
      const leaf = hashDvLeaf(entries[i].vkh, entries[i].dvAmount, entries[i].salt);
      expect(verifyDvMerkleProof(tree.root, leaf, tree.getProof(i))).toBe(true);
    }
  });

  it('odd entry count (3) — self-pairing round-trips correctly for every leaf', () => {
    const entries = [entry(0x01, 10n, 0xa1), entry(0x02, 20n, 0xa2), entry(0x03, 30n, 0xa3)];
    const tree = buildDvAllocationTree(entries);
    for (let i = 0; i < entries.length; i++) {
      const leaf = hashDvLeaf(entries[i].vkh, entries[i].dvAmount, entries[i].salt);
      expect(verifyDvMerkleProof(tree.root, leaf, tree.getProof(i))).toBe(true);
    }
  });

  it('larger, non-power-of-two count (7) — every leaf round-trips', () => {
    const entries = Array.from({ length: 7 }, (_, i) => entry(0x10 + i, BigInt(100 + i), 0x50 + i));
    const tree = buildDvAllocationTree(entries);
    for (let i = 0; i < entries.length; i++) {
      const leaf = hashDvLeaf(entries[i].vkh, entries[i].dvAmount, entries[i].salt);
      expect(verifyDvMerkleProof(tree.root, leaf, tree.getProof(i))).toBe(true);
    }
  });

  it('a proof for one leaf does not verify against a different leaf (no cross-leaf forgery)', () => {
    const entries = [entry(0x01, 10n, 0xa1), entry(0x02, 20n, 0xa2), entry(0x03, 30n, 0xa3)];
    const tree = buildDvAllocationTree(entries);
    const wrongLeaf = hashDvLeaf(entries[1].vkh, entries[1].dvAmount, entries[1].salt);
    expect(verifyDvMerkleProof(tree.root, wrongLeaf, tree.getProof(0))).toBe(false);
  });

  it('rejects an empty entry list', () => {
    expect(() => buildDvAllocationTree([])).toThrow();
  });

  it('rejects an out-of-range proof index', () => {
    const tree = buildDvAllocationTree([entry(0xaa, 1n, 0x01)]);
    expect(() => tree.getProof(1)).toThrow();
    expect(() => tree.getProof(-1)).toThrow();
  });
});
