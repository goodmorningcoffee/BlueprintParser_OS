/**
 * union-find.ts
 *
 * Textbook Union-Find (disjoint-set union) with path compression and
 * union-by-rank. Used by text-region-classifier Stage D to merge
 * cluster candidates whose bboxes overlap by IoU or containment.
 *
 * Inspired by Docling's LayoutPostprocessor merge pass (docling-project/docling,
 * MIT). Not a port — classical data structure, single-file clean implementation.
 */

export class UnionFind {
  private parent: Int32Array;
  private rank: Int32Array;

  constructor(size: number) {
    if (size < 0) throw new Error("UnionFind size must be non-negative");
    this.parent = new Int32Array(size);
    this.rank = new Int32Array(size);
    for (let i = 0; i < size; i++) this.parent[i] = i;
  }

  /** Return the representative of the set containing `x`. Path-compresses. */
  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[x] !== root) {
      const next = this.parent[x];
      this.parent[x] = root;
      x = next;
    }
    return root;
  }

  /** Merge the sets containing `a` and `b`. Returns true if a merge happened. */
  union(a: number, b: number): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    if (this.rank[ra] < this.rank[rb]) {
      this.parent[ra] = rb;
    } else if (this.rank[ra] > this.rank[rb]) {
      this.parent[rb] = ra;
    } else {
      this.parent[rb] = ra;
      this.rank[ra]++;
    }
    return true;
  }

  /**
   * Enumerate all connected components as an array of member-index arrays.
   * Indices within each component are sorted ascending; components themselves
   * are returned in order of first appearance.
   */
  components(): number[][] {
    const byRoot = new Map<number, number[]>();
    for (let i = 0; i < this.parent.length; i++) {
      const r = this.find(i);
      if (!byRoot.has(r)) byRoot.set(r, []);
      byRoot.get(r)!.push(i);
    }
    return [...byRoot.values()];
  }

  /** True iff `a` and `b` are in the same component. */
  connected(a: number, b: number): boolean {
    return this.find(a) === this.find(b);
  }

  /** Total number of distinct components. */
  componentCount(): number {
    let count = 0;
    for (let i = 0; i < this.parent.length; i++) {
      if (this.parent[i] === i) count++;
    }
    return count;
  }
}
