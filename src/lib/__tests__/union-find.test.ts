import { describe, it, expect } from "vitest";
import { UnionFind } from "@/lib/geom/union-find";

describe("UnionFind", () => {
  it("initializes each element as its own component", () => {
    const uf = new UnionFind(5);
    expect(uf.componentCount()).toBe(5);
    for (let i = 0; i < 5; i++) expect(uf.find(i)).toBe(i);
  });

  it("rejects negative size", () => {
    expect(() => new UnionFind(-1)).toThrow();
  });

  it("union merges two singletons", () => {
    const uf = new UnionFind(3);
    expect(uf.union(0, 1)).toBe(true);
    expect(uf.connected(0, 1)).toBe(true);
    expect(uf.connected(0, 2)).toBe(false);
    expect(uf.componentCount()).toBe(2);
  });

  it("union returns false when already connected", () => {
    const uf = new UnionFind(3);
    uf.union(0, 1);
    expect(uf.union(0, 1)).toBe(false);
    expect(uf.union(1, 0)).toBe(false);
  });

  it("transitive connectedness via chain of unions", () => {
    const uf = new UnionFind(4);
    uf.union(0, 1);
    uf.union(1, 2);
    uf.union(2, 3);
    expect(uf.connected(0, 3)).toBe(true);
    expect(uf.componentCount()).toBe(1);
  });

  it("components() returns disjoint member lists", () => {
    const uf = new UnionFind(6);
    uf.union(0, 1);
    uf.union(2, 3);
    uf.union(3, 4);
    const comps = uf.components().map((c) => [...c].sort((a, b) => a - b));
    comps.sort((a, b) => a[0] - b[0]);
    expect(comps).toEqual([[0, 1], [2, 3, 4], [5]]);
  });

  it("find is idempotent and path-compresses", () => {
    const uf = new UnionFind(5);
    uf.union(0, 1);
    uf.union(1, 2);
    uf.union(2, 3);
    uf.union(3, 4);
    const root = uf.find(4);
    for (let i = 0; i < 5; i++) expect(uf.find(i)).toBe(root);
  });

  it("zero-size structure has zero components", () => {
    const uf = new UnionFind(0);
    expect(uf.componentCount()).toBe(0);
    expect(uf.components()).toEqual([]);
  });
});
