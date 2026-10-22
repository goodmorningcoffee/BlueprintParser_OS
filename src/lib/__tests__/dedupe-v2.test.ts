// Dedupe v2 (2026-10-22): the page-selection model (select-all bands / threshold) and the
// duplicate-PROJECT grouping (name, normalized name, text fingerprint, ETag single vs multipart,
// default keeper). Pure — no DB, no S3.
import { describe, expect, it } from "vitest";
import {
  defaultSelection,
  pairHide,
  selectAtLeast,
  selectBand,
  selectedUnits,
  selectionRequest,
  selectionUnits,
  type SelectableReport,
} from "@/lib/page-dedup/selection";
import type { DuplicateBlock, DuplicatePair, DuplicateTier } from "@/lib/page-dedup/types";
import {
  defaultKeeper,
  etagParts,
  fileKeys,
  groupProjects,
  matchLevel,
  normalizeProjectName,
  type ProjectFingerprint,
} from "@/lib/project-dedup";

const block = (id: string, tier: DuplicateBlock["tier"], minFull: number, length = 3): DuplicateBlock => ({
  id, start: 1, offset: 10, length, tier, label: tier === "near" ? "likely revision set" : "repeat set", minContent: minFull, minFull,
});
const pair = (page: number, canonical: number, tier: DuplicateTier, full: number, blockId: string | null = null): DuplicatePair => ({
  page, canonical, tier, content: full, full, sameNumber: true, identical: tier === "exact", blockId,
});

const report: SelectableReport = {
  bulkHold: null,
  blocks: [block("b1d10l3", "exact", 1), block("b4d10l3", "near", 0.93), block("b7d10l2", "run", 0.996, 2)],
  pairs: [
    pair(11, 1, "exact", 1, "b1d10l3"),
    pair(14, 4, "near", 0.93, "b4d10l3"),
    pair(30, 20, "exact", 1),
    pair(31, 21, "near", 0.97),
    pair(32, 22, "possible", 0.75),
    pair(33, 23, "possible", 0.72),
  ],
};

describe("page selection — units, defaults, select-all bands", () => {
  it("one unit per block and per lone pair; block pairs are not separate units", () => {
    const keys = selectionUnits(report).map((u) => u.key);
    expect(keys).toEqual(["b:b1d10l3", "b:b4d10l3", "b:b7d10l2", "p:30", "p:31", "p:32", "p:33"]);
  });

  it("exact is pre-selected, nothing below it is", () => {
    expect(defaultSelection(report)).toEqual({ "b:b1d10l3": true, "p:30": true });
  });

  it("a project on bulkHold pre-selects nothing", () => {
    expect(defaultSelection({ ...report, bulkHold: "shows a revised re-issue" })).toEqual({});
  });

  it("select all / none per tier band", () => {
    const near = selectBand(report, defaultSelection(report), "near", true);
    expect(selectedUnits(report, near).map((u) => u.key)).toEqual(["b:b1d10l3", "b:b4d10l3", "p:30", "p:31"]);
    const possible = selectBand(report, near, "possible", true);
    expect(selectedUnits(report, possible).filter((u) => u.tier === "possible")).toHaveLength(2);
    const cleared = selectBand(report, possible, "near", false);
    expect(selectedUnits(report, cleared).some((u) => u.tier === "near")).toBe(false);
    expect(selectedUnits(report, cleared).filter((u) => u.tier === "possible")).toHaveLength(2);
  });

  it("select all ≥ threshold adds by score (block minFull / pair full), keeps prior picks", () => {
    const sel = selectAtLeast(report, {}, 0.95);
    expect(selectedUnits(report, sel).map((u) => u.key)).toEqual(["b:b1d10l3", "b:b7d10l2", "p:30", "p:31"]);
    const more = selectAtLeast(report, { "p:33": true }, 0.95);
    expect(more["p:33"]).toBe(true);
  });

  it("request: default keep per tier (exact → earliest, others → latest), overrides respected", () => {
    const sel = selectBand(report, selectBand(report, defaultSelection(report), "near", true), "possible", true);
    const req = selectionRequest(report, sel, { "p:32": "earliest" });
    expect(req.blocks).toEqual([{ id: "b1d10l3", keep: "earliest" }, { id: "b4d10l3", keep: "latest" }]);
    expect(req.pairs).toEqual([
      { page: 30, keep: "earliest" }, { page: 31, keep: "latest" }, { page: 32, keep: "earliest" }, { page: 33, keep: "latest" },
    ]);
  });

  it("lone pair hide: earliest keeps the lower page, latest keeps the higher", () => {
    expect(pairHide({ page: 31, canonical: 21 }, "earliest")).toEqual({ page: 31, canonical: 21 });
    expect(pairHide({ page: 31, canonical: 21 }, "latest")).toEqual({ page: 21, canonical: 31 });
  });
});

const fp = (over: Partial<ProjectFingerprint> & { publicId: string }): ProjectFingerprint => ({
  companyId: 1, name: "Tower A", createdAt: "2026-01-01T00:00:00.000Z", pageCount: 10, textHash: null,
  uploadSizes: null, userWork: 0, fileKey: null, ...over,
});

describe("duplicate projects — tiers", () => {
  it("normalizes case and whitespace only", () => {
    expect(normalizeProjectName("  Tower\tA  ")).toBe("tower a");
    expect(normalizeProjectName("TOWER A")).toBe(normalizeProjectName("tower  a"));
    expect(normalizeProjectName("Tower-A")).not.toBe(normalizeProjectName("Tower A"));
  });

  it("name, normalized name, text fingerprint, upload sizes — strongest wins", () => {
    const a = fp({ publicId: "a" });
    expect(matchLevel(fp({ publicId: "b" }), a)).toBe("same-name");
    expect(matchLevel(fp({ publicId: "b", name: "tower  A" }), a)).toBe("similar-name");
    expect(matchLevel(fp({ publicId: "b", name: "Other" }), a)).toBeNull();
    const t1 = fp({ publicId: "c", name: "X", textHash: "h1" });
    expect(matchLevel(fp({ publicId: "d", name: "Y", textHash: "h1" }), t1)).toBe("same-text");
    // same hash but a different page count is not the same content
    expect(matchLevel(fp({ publicId: "d", name: "Y", textHash: "h1", pageCount: 11 }), t1)).toBeNull();
    expect(matchLevel(fp({ publicId: "e", name: "P", uploadSizes: "100,200" }), fp({ publicId: "f", name: "Q", uploadSizes: "100,200" }))).toBe("same-size");
    expect(matchLevel(fp({ publicId: "g", name: "P", fileKey: "k" }), fp({ publicId: "h", name: "P", fileKey: "k", textHash: "z" }))).toBe("identical-file");
    // never across companies
    expect(matchLevel(fp({ publicId: "i", companyId: 2 }), a)).toBeNull();
  });

  it("groups connected projects per company; singletons are dropped", () => {
    const rows = [
      fp({ publicId: "a", name: "Tower A" }),
      fp({ publicId: "b", name: "tower a " }),
      fp({ publicId: "c", name: "Renamed", textHash: "t", pageCount: 3 }),
      fp({ publicId: "d", name: "Tower A", textHash: "t", pageCount: 3 }),
      fp({ publicId: "e", name: "Unique" }),
      fp({ publicId: "f", name: "Tower A", companyId: 2 }),
    ];
    const groups = groupProjects(rows).map((g) => g.map((m) => m.publicId).sort());
    expect(groups).toEqual([["a", "b", "c", "d"]]);
  });

  it("default keeper: most user work, tie → oldest", () => {
    const old = fp({ publicId: "old", createdAt: "2025-01-01T00:00:00Z" });
    const worked = fp({ publicId: "worked", createdAt: "2026-05-01T00:00:00Z", userWork: 3 });
    const newer = fp({ publicId: "newer", createdAt: "2026-06-01T00:00:00Z" });
    expect(defaultKeeper([newer, old, worked]).publicId).toBe("worked");
    expect(defaultKeeper([newer, old]).publicId).toBe("old");
  });
});

describe("duplicate projects — ETag single vs multipart", () => {
  it("counts parts", () => {
    expect(etagParts('"d41d8cd98f00b204e9800998ecf8427e"')).toBe(1);
    expect(etagParts('"9b2cf535f27731c974343645a3985328-12"')).toBe(12);
  });

  it("single-part ETags of equal size are keyed (equal ⇒ identical, different ⇒ not)", () => {
    const { keys, needHash } = fileKeys([
      { publicId: "a", size: 500, eTag: '"aaa"' },
      { publicId: "b", size: 500, eTag: '"aaa"' },
      { publicId: "c", size: 500, eTag: '"ccc"' },
      { publicId: "d", size: 777, eTag: '"aaa"' },
    ]);
    expect(needHash).toEqual([]);
    expect(keys.get("a")).toBe(keys.get("b"));
    expect(keys.get("c")).not.toBe(keys.get("a"));
    expect(keys.has("d")).toBe(false); // a lone size is never identical to anything; nothing to read
  });

  it("multipart ETags compare only with the same part count; mixed layouts need a streamed hash", () => {
    const same = fileKeys([
      { publicId: "a", size: 900, eTag: '"x-3"' },
      { publicId: "b", size: 900, eTag: '"x-3"' },
    ]);
    expect(same.keys.get("a")).toBe(same.keys.get("b"));
    const mixed = fileKeys([
      { publicId: "a", size: 900, eTag: '"x-3"' },
      { publicId: "b", size: 900, eTag: '"y-2"' },
      { publicId: "c", size: 900, eTag: '"plain"' },
    ]);
    expect(mixed.keys.size).toBe(0);
    expect(mixed.needHash.sort()).toEqual(["a", "b", "c"]);
  });

  it("missing objects get no key", () => {
    const { keys, needHash } = fileKeys([
      { publicId: "a", size: null, eTag: null },
      { publicId: "b", size: 10, eTag: '"e"' },
    ]);
    expect(keys.size).toBe(0);
    expect(needHash).toEqual([]);
  });
});
