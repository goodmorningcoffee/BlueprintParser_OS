// @vitest-environment node
// [table pipeline WP-2.D1, K05/K19/K40] Pure tag-ops semantics (no DB). The DB-backed route test
// (`app/api/__tests__/tag-ops.route.test.ts`) covers the lock, concurrency and demo refusal.
import { describe, expect, it } from "vitest";
import { applyTagOpsToRows, parseTagOps, type StoredYoloTag, type TagOp } from "@/server/services/tag-ops";

let seq = 0;
function tag(over: Partial<StoredYoloTag> = {}): StoredYoloTag {
  seq += 1;
  return {
    id: `t${seq}`,
    name: "QX-1",
    tagText: "QX-1",
    yoloClass: "",
    yoloModel: "",
    source: "schedule",
    scope: "project",
    instances: [{ pageNumber: 1, annotationId: -1, bbox: [0.1, 0.1, 0.12, 0.12], confidence: 1 }],
    ...over,
  };
}

/** Keynote keys 1..9 of one sheet, as the keynote auto-map produces them (page scope). */
function sheetKeys(page: number): StoredYoloTag[] {
  return Array.from({ length: 9 }, (_, i) =>
    tag({
      id: `keynote-${page}-${i + 1}-${seq}`,
      name: String(i + 1),
      tagText: String(i + 1),
      source: "keynote",
      scope: "page",
      pageNumber: page,
      instances: [{ pageNumber: page, annotationId: -1, bbox: [0.1 * i, 0.5, 0.1 * i + 0.02, 0.52], confidence: 1 }],
    }),
  );
}

const upsertsByKey = (tags: StoredYoloTag[]): TagOp[] => tags.map((t) => ({ op: "upsert", tag: t, match: "key" }));

describe("applyTagOpsToRows", () => {
  it("[K05] sheet 3 keys 1..9 then sheet 7 keys 1..9 → 18 tags; re-mapping sheet 3 keeps 18 and the ids", () => {
    const a = applyTagOpsToRows([], upsertsByKey(sheetKeys(3)));
    const b = applyTagOpsToRows(a.rows, upsertsByKey(sheetKeys(7)));
    expect(b.rows).toHaveLength(18);
    expect(new Set(b.rows.map((r) => r.pageNumber))).toEqual(new Set([3, 7]));
    const again = applyTagOpsToRows(b.rows, upsertsByKey(sheetKeys(3)));
    expect(again.rows).toHaveLength(18);
    expect(again.rows.map((r) => r.id)).toEqual(b.rows.map((r) => r.id));
    expect(again.removed).toEqual([]);
  });

  it("upsert by id replaces in place; an unknown id appends", () => {
    const a = tag();
    const b = tag();
    const out = applyTagOpsToRows([a, b], [
      { op: "upsert", tag: { ...a, description: "edited" } },
      { op: "upsert", tag: tag({ tagText: "QX-2" }) },
    ]);
    expect(out.rows.map((r) => r.id)).toEqual([a.id, b.id, out.rows[2].id]);
    expect(out.rows[0].description).toBe("edited");
    expect(out.tags.map((r) => r.id)).toEqual([a.id, out.rows[2].id]);
  });

  it("upsert by id never dedupes by key (two client rows with the same text stay two)", () => {
    const a = tag();
    const out = applyTagOpsToRows([a], [{ op: "upsert", tag: tag() }]);
    expect(out.rows).toHaveLength(2);
  });

  it("remove by id; a missing id is skipped, not an error", () => {
    const a = tag();
    const b = tag();
    const out = applyTagOpsToRows([a, b], [
      { op: "remove", id: a.id },
      { op: "remove", id: "gone" },
    ]);
    expect(out.rows).toEqual([b]);
    expect(out.removed).toEqual([a.id]);
    expect(out.skipped).toEqual([{ index: 1, reason: "tag not found" }]);
  });

  it("an upsert then a remove of the same id reports only the removal", () => {
    const a = tag();
    const out = applyTagOpsToRows([], [{ op: "upsert", tag: a }, { op: "remove", id: a.id }]);
    expect(out.rows).toEqual([]);
    expect(out.tags).toEqual([]);
    expect(out.removed).toEqual([a.id]);
  });

  describe("replace-for-region (K40)", () => {
    const r1 = (t: StoredYoloTag): StoredYoloTag => ({ ...t, links: { regionId: "pr-1" } });
    const r2 = (t: StoredYoloTag): StoredYoloTag => ({ ...t, links: { regionId: "pr-2" } });

    it("a remap clears the 0-hit tags of that region only", () => {
      const keep = r1(tag({ tagText: "QX-1" }));
      const stale = r1(tag({ tagText: "QX-2" }));
      const otherZero = r2(tag({ tagText: "QX-2", instances: [] }));
      const legacyZero = tag({ tagText: "QX-9", instances: [] });
      const out = applyTagOpsToRows([keep, stale, otherZero, legacyZero], [{
        op: "replace-for-region",
        regionId: "pr-1",
        tags: [
          { ...tag({ tagText: "QX-1" }), description: "remapped" },
          tag({ tagText: "QX-2", instances: [] }),
        ],
      }]);
      expect(out.rows.map((r) => r.tagText)).toEqual(["QX-1", "QX-2", "QX-9"]);
      expect(out.rows[0]).toMatchObject({ id: keep.id, description: "remapped", links: { regionId: "pr-1" } });
      expect(out.rows[1]).toBe(otherZero);
      expect(out.rows[2]).toBe(legacyZero);
      expect(out.removed).toEqual([stale.id]);
      expect(out.replacedRegionIds).toEqual(["pr-1"]);
    });

    it("two schedules that share tag text keep two tags", () => {
      const out1 = applyTagOpsToRows([], [{ op: "replace-for-region", regionId: "pr-1", tags: [tag({ tagText: "1" })] }]);
      const out2 = applyTagOpsToRows(out1.rows, [{ op: "replace-for-region", regionId: "pr-2", tags: [tag({ tagText: "1" })] }]);
      expect(out2.rows).toHaveLength(2);
      expect(out2.rows.map((r) => r.links?.regionId)).toEqual(["pr-1", "pr-2"]);
    });

    it("retireIds removes the named legacy rows only (never a row linked to another region)", () => {
      const legacy = tag({ tagText: "QX-1" });
      const foreign = r2(tag({ tagText: "QX-1" }));
      const unrelated = tag({ tagText: "QX-5" });
      const out = applyTagOpsToRows([legacy, foreign, unrelated], [{
        op: "replace-for-region",
        regionId: "pr-1",
        tags: [tag({ tagText: "QX-1" })],
        retireIds: [legacy.id, foreign.id],
      }]);
      expect(out.rows.map((r) => r.id)).toEqual([foreign.id, unrelated.id, out.rows[2].id]);
      expect(out.rows[2].links).toEqual({ regionId: "pr-1" });
      expect(out.removed).toEqual([legacy.id]);
    });

    it("incoming duplicates of one key collapse to one row", () => {
      const out = applyTagOpsToRows([], [{
        op: "replace-for-region",
        regionId: "pr-1",
        tags: [tag({ tagText: "qx-1" }), tag({ tagText: "QX-1", description: "second wins" })],
      }]);
      expect(out.rows).toHaveLength(1);
      expect(out.rows[0].description).toBe("second wins");
    });
    it("[MED-1] an incoming id held by another region's row gets a fresh id; that row is untouched", () => {
      const x = r1(tag({ id: "X", tagText: "1" }));
      const out = applyTagOpsToRows([x], [{ op: "replace-for-region", regionId: "pr-2", tags: [tag({ id: "X", tagText: "2" })] }]);
      expect(out.rows).toHaveLength(2);
      expect(out.rows[0]).toBe(x);
      expect(out.rows[1]).toMatchObject({ id: "X~2", tagText: "2", links: { regionId: "pr-2" } });
      expect(out.tags.map((r) => r.id)).toEqual(["X~2"]);
      expect(out.removed).toEqual([]);
    });

    it("[MED-1] an incoming id held by an unlinked surviving row is minted too; a retired row's id may be reused", () => {
      const legacy = tag({ id: "L", tagText: "QX-1" });
      const retiredRow = tag({ id: "R", tagText: "QX-3" });
      const out = applyTagOpsToRows([legacy, retiredRow], [{
        op: "replace-for-region",
        regionId: "pr-1",
        tags: [tag({ id: "L", tagText: "QX-2" }), tag({ id: "R", tagText: "QX-3" })],
        retireIds: [retiredRow.id],
      }]);
      expect(out.rows.map((r) => [r.id, r.tagText, r.links?.regionId])).toEqual([
        ["L", "QX-1", undefined],
        ["L~2", "QX-2", "pr-1"],
        ["R", "QX-3", "pr-1"],
      ]);
      expect(out.removed).toEqual([]);
    });

    it("[MED-1] an incoming id that is another incoming key's matched prior id is minted, never merged", () => {
      const y = r1(tag({ id: "Y", tagText: "QX-1" }));
      const out = applyTagOpsToRows([y], [{
        op: "replace-for-region",
        regionId: "pr-1",
        tags: [tag({ id: "Y", tagText: "QX-2" }), tag({ id: "Z", tagText: "QX-1" })],
      }]);
      expect(out.rows.map((r) => [r.id, r.tagText])).toEqual([["Y", "QX-1"], ["Y~2", "QX-2"]]);
      expect(new Set(out.rows.map((r) => r.id)).size).toBe(2);
    });

    it("[LOW-3] a remap keeps the review status of a hit at the same place; an explicit status wins", () => {
      const at = (x: number, status?: "auto" | "confirmed" | "rejected") => ({
        pageNumber: 1, annotationId: -1, bbox: [x, 0.1, x + 0.02, 0.12] as [number, number, number, number], confidence: 1,
        ...(status ? { status } : {}),
      });
      const prior = r1(tag({ tagText: "QX-1", instances: [at(0.1, "confirmed"), at(0.3, "rejected"), at(0.5, "confirmed")] }));
      const out = applyTagOpsToRows([prior], [{
        op: "replace-for-region",
        regionId: "pr-1",
        tags: [tag({ tagText: "QX-1", instances: [at(0.1000001), at(0.3), at(0.5, "auto"), at(0.7)] })],
      }]);
      expect(out.rows[0].instances.map((i) => (i as { status?: string }).status)).toEqual(["confirmed", "rejected", "auto", undefined]);
    });
  });

  describe("[LOW-2] malformed stored rows are carried through, never matched", () => {
    const broken = [null, { id: "nt", name: "x", source: "schedule", scope: "project", instances: [] }] as unknown as StoredYoloTag[];

    it("every op still applies and the bad rows survive unchanged", () => {
      const a = tag({ tagText: "QX-1", links: { regionId: "pr-1" } });
      const out = applyTagOpsToRows([...broken, a], [
        { op: "upsert", tag: tag({ tagText: "QX-1" }), match: "key" },
        { op: "replace-for-region", regionId: "pr-1", tags: [tag({ tagText: "QX-2" })] },
        { op: "set-instance-status", tagId: "nt", instance: { id: "x" }, status: "confirmed" },
        { op: "add-instance", tagId: "nt", instance: { pageNumber: 1, bbox: [0, 0, 1, 1] } },
      ]);
      expect(out.rows.slice(0, 2)).toEqual(broken);
      expect(out.skipped).toEqual([{ index: 2, reason: "tag not found" }, { index: 3, reason: "tag not found" }]);
    });

    it("upsert and remove by id still replace or delete a bad row that has an id", () => {
      const fixed = applyTagOpsToRows(broken, [{ op: "upsert", tag: tag({ id: "nt" }) }]);
      expect(fixed.rows[1]).toMatchObject({ id: "nt", tagText: "QX-1" });
      const gone = applyTagOpsToRows(broken, [{ op: "remove", id: "nt" }]);
      expect(gone.rows).toEqual([null]);
      expect(gone.removed).toEqual(["nt"]);
    });
  });

  describe("instance ops", () => {
    const withHit = () =>
      tag({ instances: [{ pageNumber: 2, annotationId: 5, bbox: [0.1, 0.2, 0.3, 0.4], confidence: 0.9 }] });

    it("set-instance-status by page + bbox (jitter-tolerant) and by id", () => {
      const a = withHit();
      const out = applyTagOpsToRows([a], [
        { op: "set-instance-status", tagId: a.id, instance: { pageNumber: 2, bbox: [0.100001, 0.2, 0.3, 0.4] }, status: "rejected" },
      ]);
      expect(out.rows[0].instances[0]).toMatchObject({ annotationId: 5, status: "rejected" });
      const added = applyTagOpsToRows(out.rows, [
        { op: "add-instance", tagId: a.id, instance: { pageNumber: 3, bbox: [0.5, 0.5, 0.6, 0.6] } },
      ]);
      const id = (added.rows[0].instances[1] as { id?: string }).id!;
      const byId = applyTagOpsToRows(added.rows, [
        { op: "set-instance-status", tagId: a.id, instance: { id }, status: "rejected" },
      ]);
      expect(byId.rows[0].instances[1]).toMatchObject({ id, status: "rejected" });
    });

    it("add-instance appends a confirmed manual hit; the same place again confirms instead of duplicating", () => {
      const a = withHit();
      const out = applyTagOpsToRows([a], [
        { op: "add-instance", tagId: a.id, instance: { pageNumber: 3, bbox: [0.5, 0.5, 0.6, 0.6] } },
        { op: "add-instance", tagId: a.id, instance: { pageNumber: 2, bbox: [0.1, 0.2, 0.3, 0.4] } },
      ]);
      expect(out.rows[0].instances).toEqual([
        { pageNumber: 2, annotationId: 5, bbox: [0.1, 0.2, 0.3, 0.4], confidence: 0.9, status: "confirmed" },
        { pageNumber: 3, annotationId: -1, bbox: [0.5, 0.5, 0.6, 0.6], confidence: 1, id: "i:3:5000,5000,6000,6000", status: "confirmed" },
      ]);
    });

    it("a missing tag or instance is skipped and nothing is touched", () => {
      const a = withHit();
      const out = applyTagOpsToRows([a], [
        { op: "set-instance-status", tagId: "gone", instance: { id: "x" }, status: "confirmed" },
        { op: "set-instance-status", tagId: a.id, instance: { id: "x" }, status: "confirmed" },
        { op: "add-instance", tagId: "gone", instance: { pageNumber: 1, bbox: [0, 0, 1, 1] } },
      ]);
      expect(out.rows).toEqual([a]);
      expect(out.tags).toEqual([]);
      expect(out.skipped).toEqual([
        { index: 0, reason: "tag not found" },
        { index: 1, reason: "instance not found" },
        { index: 2, reason: "tag not found" },
      ]);
    });
  });

  it("never mutates its input rows", () => {
    const a = tag();
    const frozen = JSON.stringify([a]);
    applyTagOpsToRows([a], [
      { op: "upsert", tag: { ...a, name: "x" } },
      { op: "add-instance", tagId: a.id, instance: { pageNumber: 9, bbox: [0, 0, 1, 1] } },
      { op: "replace-for-region", regionId: "pr-1", tags: [tag()] },
    ]);
    expect(JSON.stringify([a])).toBe(frozen);
  });
});

describe("parseTagOps", () => {
  const ok = tag();

  it("accepts every op shape", () => {
    const ops = parseTagOps({
      ops: [
        { op: "upsert", tag: ok },
        { op: "upsert", tag: ok, match: "key" },
        { op: "remove", id: "t" },
        { op: "replace-for-region", regionId: "pr-1", tags: [ok], retireIds: ["a"] },
        { op: "set-instance-status", tagId: "t", instance: { id: "i" }, status: "confirmed" },
        { op: "set-instance-status", tagId: "t", instance: { pageNumber: 1, bbox: [0, 0, 1, 1] }, status: "auto" },
        { op: "add-instance", tagId: "t", instance: { pageNumber: 1, bbox: [0, 0, 1, 1], annotationId: 3, confidence: 0.5 } },
      ],
    });
    expect(ops.map((o) => o.op)).toEqual([
      "upsert", "upsert", "remove", "replace-for-region", "set-instance-status", "set-instance-status", "add-instance",
    ]);
  });

  const bad: [string, unknown][] = [
    ["no ops", {}],
    ["empty ops", { ops: [] }],
    ["unknown op", { ops: [{ op: "wipe" }] }],
    ["upsert of a malformed tag", { ops: [{ op: "upsert", tag: { ...ok, source: "legend" } }] }],
    ["upsert with an empty id", { ops: [{ op: "upsert", tag: { ...ok, id: "" } }] }],
    ["bad match", { ops: [{ op: "upsert", tag: ok, match: "text" }] }],
    ["remove without id", { ops: [{ op: "remove" }] }],
    ["replace without regionId", { ops: [{ op: "replace-for-region", tags: [] }] }],
    ["replace with non-array tags", { ops: [{ op: "replace-for-region", regionId: "r", tags: {} }] }],
    ["bad status", { ops: [{ op: "set-instance-status", tagId: "t", instance: { id: "i" }, status: "maybe" }] }],
    ["page 0", { ops: [{ op: "add-instance", tagId: "t", instance: { pageNumber: 0, bbox: [0, 0, 1, 1] } }] }],
    ["NaN bbox", { ops: [{ op: "add-instance", tagId: "t", instance: { pageNumber: 1, bbox: [0, 0, 1, Number.NaN] } }] }],
    ["too many ops", { ops: Array.from({ length: 2_001 }, () => ({ op: "remove", id: "t" })) }],
  ];
  for (const [name, body] of bad) {
    it(`refuses: ${name}`, () => {
      expect(() => parseTagOps(body as Record<string, unknown>)).toThrow();
    });
  }
});
