// @vitest-environment node
// [refactor jul23 P4.1 U10] Direct nets for log-mode region-data observation at the two CLIENT
// region sinks: observeRegionData wired into promoteRegion (Parser-Save + server-binder) and
// observeRegionDataBatch wired into updatePageIntelligence (INCOMING patch only).
//
// U10's landed contract (RD-U10 — LOG-MODE ONLY, no v-gate, no schema change):
//   • a drifted region blob persists byte-identical (Verdict 2 / the d120d42 freeze) AND emits
//     exactly ONE structured "[shape-registry]" warn per (sink,kind); a valid blob is silent.
//   • the PATCH sink observes the INCOMING parsedRegions ONLY — NEVER merged.parsedRegions — so
//     a legacy-drifted STORED row this request does not write is never false-flagged (recon §2b).
//   • unknown/extra keys survive verbatim (the region schemas are `.loose()`) and never warn.
//
// Mutation probes (run at commit, restore from cp backups — never `git checkout --`):
//   • unwire observeRegionData in regions.ts (data → undefined)        → net (a-drift) warn RED;
//   • unwire observeRegionDataBatch in pages.ts (incoming → [])         → net (b) aggregation RED;
//   • make pages.ts observe merged.parsedRegions instead of the incoming array
//     (move the call inside the tx, over `merged`)                      → net (c) incoming-only RED.
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});
// Reuse the regions-promote scaffold: binders + detectors + summaries + mergeCsiCodes mocked so
// the WIRING (not their internals) is what these nets exercise. The Parser-Save promote path and
// the PATCH path never call the binders/detectors, but mocking them keeps the promote path
// deterministic and matches the frozen scaffold verbatim. db.transaction runs against the real DB.
vi.mock("@/lib/project-analysis", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/project-analysis")>();
  return { ...orig, computeProjectSummaries: vi.fn() };
});
vi.mock("@/lib/csi-utils", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/csi-utils")>();
  return { ...orig, mergeCsiCodes: vi.fn() };
});
vi.mock("@/lib/text-region-classifier", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/text-region-classifier")>();
  return { ...orig, parseNotesFromRegion: vi.fn() };
});
vi.mock("@/lib/specnote-parser", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/specnote-parser")>();
  return { ...orig, bindSpecSectionsInRegion: vi.fn() };
});
vi.mock("@/lib/csi-detect", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/csi-detect")>();
  return { ...orig, detectCsiFromGrid: vi.fn(), detectCsiCodes: vi.fn() };
});

import { POST as PROMOTE_REGION } from "@/app/api/regions/promote/route";
import { PATCH as PATCH_INTELLIGENCE } from "@/app/api/pages/intelligence/route";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { mergeCsiCodes } from "@/lib/csi-utils";
import { computeProjectSummaries } from "@/lib/project-analysis";
import { parseNotesFromRegion } from "@/lib/text-region-classifier";
import { bindSpecSectionsInRegion } from "@/lib/specnote-parser";
import { detectCsiFromGrid, detectCsiCodes } from "@/lib/csi-detect";
import { asUser, createPage, createWorld, makeReq, readJson } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const SENTINEL = "__freezeSentinel";

const promote = async (body: unknown) =>
  readJson(await PROMOTE_REGION(makeReq("/api/regions/promote", { body })));
const patchIntelligence = async (body: unknown) =>
  readJson(
    await PATCH_INTELLIGENCE(makeReq("/api/pages/intelligence", { method: "PATCH", body })),
  );

/** Only the observation module's entries — logger.warn is shared by many subsystems. */
const shapeRegistryWarns = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(
    (c) => typeof c[0] === "string" && (c[0] as string).startsWith("[shape-registry]"),
  );

/** Read back the persisted page state (after the tx) — mirrors regions-promote.route.test.ts:61-70. */
const pageState = async (pageId: number) => {
  const [r] = await db
    .select({ pi: pages.pageIntelligence, csi: pages.csiCodes })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1);
  const pi = (r?.pi ?? {}) as Record<string, any>;
  return { pi, csi: (r?.csi ?? []) as any[], regions: (pi.parsedRegions ?? []) as any[] };
};

// A valid grid-shaped blob (classify → "grid"; zGridRegionData passes — headers+rows suffice,
// the rest are optional). The Parser-Save path stores this verbatim.
const VALID_GRID = {
  headers: ["Mark", "Type"],
  rows: [{ Mark: "D1", Type: "Door" }],
  tagColumn: "Mark",
  tableName: "Door Schedule",
  rowCount: 1,
  columnCount: 2,
};

// A DRIFTED keynote blob: classify → "keynote" (keynotes[] present), but zKeynoteRegionData
// requires isPageSpecific:boolean → the missing field is the drift. This is the exact real
// legacy-keynote shape recon §2b identified reaching the column via Parser-Save verbatim.
const DRIFTED_KEYNOTE = {
  keynotes: [{ key: "A1", description: "Aluminum storefront door" }],
  // isPageSpecific OMITTED — the drift the log-mode canary exists to surface.
};

beforeEach(() => {
  vi.mocked(mergeCsiCodes).mockReset().mockImplementation((e: any, i: any) => [...(e ?? []), ...(i ?? [])]);
  vi.mocked(computeProjectSummaries).mockReset().mockResolvedValue(null as any);
  vi.mocked(parseNotesFromRegion).mockReset();
  vi.mocked(bindSpecSectionsInRegion).mockReset();
  vi.mocked(detectCsiFromGrid).mockReset().mockReturnValue([] as any);
  vi.mocked(detectCsiCodes).mockReset().mockReturnValue([] as any);
});
afterEach(() => vi.restoreAllMocks());

describe.skipIf(!dbUp)("[P4.1 U10] observeRegionData at promoteRegion (sink=regions.promote)", () => {
  it("(a) VALID grid Parser-Save persists verbatim with ZERO shape-registry warns", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1);
    asUser(user);
    const warn = vi.spyOn(logger, "warn");
    const { status } = await promote({
      publicId: project.publicId,
      pageNumber: 1,
      type: "schedule",
      overrides: { bbox: [0.1, 0.2, 0.3, 0.4], data: VALID_GRID, regionId: "grid-ok" },
    });
    expect(status).toBe(200);
    const st = await pageState(page.id);
    expect(st.regions).toHaveLength(1);
    expect(st.regions[0].data).toEqual(VALID_GRID);
    expect(shapeRegistryWarns(warn)).toHaveLength(0);
  });

  it("(a-drift) DRIFTED keynote Parser-Save STILL persists byte-identical (log-only) and emits exactly ONE warn kind=keynote sink=regions.promote", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1);
    asUser(user);
    const warn = vi.spyOn(logger, "warn");
    const { status } = await promote({
      publicId: project.publicId,
      pageNumber: 1,
      type: "keynote",
      overrides: { bbox: [0, 0, 1, 1], data: DRIFTED_KEYNOTE, regionId: "kn-drift" },
    });
    expect(status).toBe(200); // ← Verdict-2: log-mode NEVER rejects a v0 region write
    const st = await pageState(page.id);
    expect(st.regions).toHaveLength(1);
    expect(st.regions[0].data).toEqual(DRIFTED_KEYNOTE); // persisted unchanged, drift and all
    const calls = shapeRegistryWarns(warn);
    expect(calls).toHaveLength(1);
    const ctx = calls[0][1] as Record<string, unknown>;
    expect(ctx.sink).toBe("regions.promote");
    expect(ctx.kind).toBe("keynote");
    expect(ctx.issueCount).toBe(1);
    expect(ctx.issues).toEqual(
      expect.arrayContaining([expect.stringContaining("isPageSpecific")]),
    );
    // Paths+codes only — never the user-authored keynote description (log hygiene).
    expect(JSON.stringify(ctx)).not.toContain("Aluminum");
  });

  it("(d) sentinel + unknown keys on a promoted region survive verbatim and do NOT warn (the .loose() contract)", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1);
    asUser(user);
    const warn = vi.spyOn(logger, "warn");
    const withSentinel = { ...VALID_GRID, [SENTINEL]: "preserve", legacyExtra: 99 };
    const { status } = await promote({
      publicId: project.publicId,
      pageNumber: 1,
      type: "schedule",
      overrides: { bbox: [0, 0, 1, 1], data: withSentinel, regionId: "grid-loose" },
    });
    expect(status).toBe(200);
    const st = await pageState(page.id);
    expect(st.regions[0].data).toEqual(withSentinel); // unknown keys round-trip byte-identical
    expect((st.regions[0].data as Record<string, unknown>)[SENTINEL]).toBe("preserve");
    expect(shapeRegistryWarns(warn)).toHaveLength(0); // .loose() tolerates the extras → no drift
  });
});

describe.skipIf(!dbUp)("[P4.1 U10] observeRegionDataBatch at updatePageIntelligence (sink=pages.intelligence)", () => {
  it("(b) PATCH with TWO same-kind drifted regions → 200 + exactly ONE aggregated warn (rowCount=2, failedCount=2)", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1);
    asUser(user);
    const warn = vi.spyOn(logger, "warn");
    const { status } = await patchIntelligence({
      publicId: project.publicId,
      pageNumber: 1,
      intelligence: {
        parsedRegions: [
          { id: "k1", data: { keynotes: [{ key: "A", description: "a" }] } }, // drifted (no isPageSpecific)
          { id: "k2", data: { keynotes: [{ key: "B", description: "b" }] } }, // drifted (no isPageSpecific)
        ],
      },
    });
    expect(status).toBe(200); // log-only: both regions persist
    expect((await pageState(page.id)).regions).toHaveLength(2);
    const calls = shapeRegistryWarns(warn);
    expect(calls).toHaveLength(1); // ← aggregation: ONE warn for two same-kind drifts, not two
    const ctx = calls[0][1] as Record<string, unknown>;
    expect(ctx.sink).toBe("pages.intelligence");
    expect(ctx.kind).toBe("keynote");
    expect(ctx.rowCount).toBe(2);
    expect(ctx.failedCount).toBe(2);
  });

  it("(c) PATCH OMITTING parsedRegions against a page whose STORED intelligence holds a drifted region → 200 + ZERO region warns (incoming-only, never merged)", async () => {
    const { user, project } = await createWorld();
    const page = await createPage(project.id, 1, {
      pageIntelligence: {
        parsedRegions: [
          { id: "stored-drift", data: { keynotes: [{ key: "X", description: "x" }] } }, // drifted, already stored
        ],
      } as any,
    });
    asUser(user);
    const warn = vi.spyOn(logger, "warn");
    // A real omit-parsedRegions path (rejectedTextRegionIds-only dismiss — types/index.ts:631-635).
    const { status } = await patchIntelligence({
      publicId: project.publicId,
      pageNumber: 1,
      intelligence: { rejectedTextRegionIds: ["ignore-me"] },
    });
    expect(status).toBe(200);
    const st = await pageState(page.id);
    // Shallow merge preserves the stored region (this request never wrote parsedRegions)…
    expect(st.regions).toHaveLength(1);
    expect(st.pi.rejectedTextRegionIds).toEqual(["ignore-me"]);
    // …and CRUCIALLY it is NOT re-flagged: observation reads the INCOMING patch, never `merged`.
    // A merged-observing bug would surface the stored drift here as a false canary.
    expect(shapeRegistryWarns(warn)).toHaveLength(0);
  });
});
