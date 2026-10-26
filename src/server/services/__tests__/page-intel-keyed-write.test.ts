// @vitest-environment node
// [TP-1 WP-1.B 2026-10-26] K02: the keyed page-intelligence write shared by YOLO load and the
// intelligence reprocess. Pure part: the delta and the SQL it renders. DB part (skips without
// Postgres; bp-suite sets BP_REQUIRE_TEST_DB=1): the write runs over the LIVE row, so a key written
// after the loop's snapshot survives, and YOLO CSI is unioned with the live page CSI.
import { describe, expect, inject, it } from "vitest";
import { eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { REPROCESS_COMPUTED_KEYS } from "@/lib/intelligence-merge";
import { assertProjectWritable } from "@/server/api/project-write-capability";
import {
  isEmptyDelta,
  keyedPageIntelligenceSql,
  pageIntelligenceDelta,
  reprocessPageIntelligenceDelta,
  writeComputedPageIntelligence,
} from "@/server/services/page-intel-keyed-write";
import { createPage, createWorld } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

describe("pageIntelligenceDelta", () => {
  it("YOLO shape: a spread of the snapshot → only changed keys are set, deleted keys cleared, carried keys untouched", () => {
    const user = [{ id: "r1" }];
    const snapshot = { parsedRegions: user, heuristicInferences: [{ rule: "old" }], pageZones: { z: 1 } };
    const next: Record<string, unknown> = { ...snapshot, pageZones: { z: 2 }, ensembleRegions: [1] };
    delete next.heuristicInferences;
    expect(pageIntelligenceDelta(snapshot, next)).toEqual({
      set: { pageZones: { z: 2 }, ensembleRegions: [1] },
      clear: ["heuristicInferences"],
    });
  });

  it("an unchanged spread is an empty delta (no write)", () => {
    const snapshot = { parsedRegions: [{ id: "r1" }], shapes: { s: 1 } };
    const delta = pageIntelligenceDelta(snapshot, { ...snapshot });
    expect(delta).toEqual({ set: {}, clear: [] });
    expect(isEmptyDelta(delta)).toBe(true);
  });

  it("reprocess shape: every computed key is set or cleared; carried user/unknown keys are left to the live row", () => {
    const parsedRegions = [{ id: "user" }];
    const snapshot = { parsedRegions, someFutureKey: { keep: 1 }, classifiedTables: [{ stale: true }], yoloHeatmap: { stale: true }, evidence: { e: 1 } };
    // what the loop builds: carryNonComputedIntelligence(snapshot) + fresh computed keys
    const next = { parsedRegions, someFutureKey: snapshot.someFutureKey, textRegions: [{ id: "t" }], evidence: snapshot.evidence };
    const delta = reprocessPageIntelligenceDelta(snapshot, next);
    expect(delta.set).toEqual({ textRegions: [{ id: "t" }], evidence: { e: 1 } }); // computed: rewritten even when identical
    expect(delta.set).not.toHaveProperty("parsedRegions");
    expect(delta.set).not.toHaveProperty("someFutureKey");
    expect(delta.clear).toEqual(REPROCESS_COMPUTED_KEYS.filter((k) => k !== "textRegions" && k !== "evidence").sort());
  });

  it("undefined values are clears (JSON drops them, so the old whole write dropped them too)", () => {
    expect(pageIntelligenceDelta({ classification: "x" }, { classification: undefined })).toEqual({ set: {}, clear: ["classification"] });
  });

  it("a null / array / scalar snapshot counts as {}", () => {
    for (const snapshot of [null, undefined, [1], "x"]) {
      expect(pageIntelligenceDelta(snapshot, { a: 1 })).toEqual({ set: { a: 1 }, clear: [] });
    }
  });
});

describe("keyedPageIntelligenceSql", () => {
  const render = (delta: Parameters<typeof keyedPageIntelligenceSql>[0]) => new PgDialect().sqlToQuery(keyedPageIntelligenceSql(delta));

  it("renders (live - ARRAY[clear]::text[]) || set::jsonb over the live column, every value bound", () => {
    const { sql, params } = render({ set: { a: [1] }, clear: ["b", "c"] });
    expect(sql).toBe(
      `((CASE WHEN jsonb_typeof("pages"."page_intelligence") = 'object' THEN "pages"."page_intelligence" ELSE '{}'::jsonb END) - ARRAY[$1::text, $2::text]::text[]) || $3::jsonb`,
    );
    expect(params).toEqual(["b", "c", JSON.stringify({ a: [1] })]);
  });

  it("omits the subtraction when nothing is cleared", () => {
    const { sql, params } = render({ set: { a: 1 }, clear: [] });
    expect(sql).toBe(
      `(CASE WHEN jsonb_typeof("pages"."page_intelligence") = 'object' THEN "pages"."page_intelligence" ELSE '{}'::jsonb END) || $1::jsonb`,
    );
    expect(params).toEqual([JSON.stringify({ a: 1 })]);
  });
});

describe.skipIf(!dbUp)("writeComputedPageIntelligence (DB)", () => {
  const read = async (pageId: number) => {
    const [row] = await db.select({ pi: pages.pageIntelligence, csi: pages.csiCodes }).from(pages).where(eq(pages.id, pageId));
    return { pi: row.pi as Record<string, unknown>, csi: (row.csi ?? []) as Array<{ code: string; description: string }> };
  };

  it("a user write that lands after the snapshot read survives the loop's write", async () => {
    const { project } = await createWorld();
    const page = await createPage(project.id, 1, {
      pageIntelligence: { parsedRegions: [{ id: "A" }], heuristicInferences: [{ rule: "old" }], textRegions: [{ id: "t" }] } as never,
    });
    const snapshot = (await read(page.id)).pi;
    // the loop computes from its snapshot …
    const next: Record<string, unknown> = { ...snapshot, heuristicInferences: [{ rule: "new" }] };
    delete next.textRegions;
    // … while a promote and a proposal verdict land on the live row
    await db.update(pages).set({
      pageIntelligence: { ...snapshot, parsedRegions: [{ id: "A" }, { id: "B" }], proposalVerdicts: { p1: { verdict: "confirm" } } } as never,
    }).where(eq(pages.id, page.id));

    const written = await writeComputedPageIntelligence(assertProjectWritable(project), project.id, page.id, pageIntelligenceDelta(snapshot, next));
    expect(written).toEqual({ intelligence: true, csiCodes: false });
    const { pi } = await read(page.id);
    expect(pi.parsedRegions).toEqual([{ id: "A" }, { id: "B" }]); // the promote survived
    expect(pi.proposalVerdicts).toEqual({ p1: { verdict: "confirm" } }); // the verdict survived
    expect(pi.heuristicInferences).toEqual([{ rule: "new" }]); // the loop's key was written
    expect(pi).not.toHaveProperty("textRegions"); // the loop's clear was applied
  });

  it("a NULL live page_intelligence starts from {}", async () => {
    const { project } = await createWorld();
    const page = await createPage(project.id, 1);
    await writeComputedPageIntelligence(assertProjectWritable(project), project.id, page.id, { set: { pageZones: { z: 1 } }, clear: ["gone"] });
    expect((await read(page.id)).pi).toEqual({ pageZones: { z: 1 } });
  });

  it("CSI: YOLO codes are unioned with the LIVE page CSI (a commit's recompute is kept, the snapshot is not resurrected)", async () => {
    const { project } = await createWorld();
    const page = await createPage(project.id, 1, {
      csiCodes: [{ code: "09 00 00", description: "snapshot code", division: "09", trade: "" }] as never,
    });
    // a commit recomputes the page CSI while the YOLO loop runs
    await db.update(pages).set({ csiCodes: [{ code: "23 00 00", description: "commit code", division: "23", trade: "" }] as never }).where(eq(pages.id, page.id));
    const written = await writeComputedPageIntelligence(
      assertProjectWritable(project), project.id, page.id, { set: {}, clear: [] },
      [{ code: "08 11 00", description: "From YOLO class config" }],
    );
    expect(written).toEqual({ intelligence: false, csiCodes: true });
    expect((await read(page.id)).csi.map((c) => c.code)).toEqual(["23 00 00", "08 11 00"]);
  });

  it("CSI write guard: nothing new for the live row → no write at all", async () => {
    const { project } = await createWorld();
    const page = await createPage(project.id, 1, {
      csiCodes: [{ code: "08 11 00", description: "already there", division: "08", trade: "" }] as never,
      pageIntelligence: { keep: 1 } as never,
    });
    const written = await writeComputedPageIntelligence(
      assertProjectWritable(project), project.id, page.id, { set: {}, clear: [] },
      [{ code: "08 11 00", description: "From YOLO class config" }],
    );
    expect(written).toEqual({ intelligence: false, csiCodes: false });
    const after = await read(page.id);
    expect(after.csi).toEqual([{ code: "08 11 00", description: "already there", division: "08", trade: "" }]);
    expect(after.pi).toEqual({ keep: 1 });
  });

  it("is bound to the project: a page id from another project is not written", async () => {
    const a = await createWorld();
    const b = await createWorld();
    const foreign = await createPage(b.project.id, 1, { pageIntelligence: { owner: "b" } as never });
    await writeComputedPageIntelligence(assertProjectWritable(a.project), a.project.id, foreign.id, { set: { owner: "a" }, clear: [] });
    expect((await read(foreign.id)).pi).toEqual({ owner: "b" });
  });
});
