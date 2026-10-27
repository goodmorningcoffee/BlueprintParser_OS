// @vitest-environment node
// [table pipeline WP-2.E, K47] Loader parity: the ONE page-evidence loader (`loadPageEvidence` +
// `toClassifierPageInput`) hands the classifier engine the same input as each of the four hand-rolled
// loaders, on pages built from the synthetic fixtures:
//   1. Admin › Reprocess "Classifiers"   reprocessClassifiersScope        (reprocess-classifiers.ts)
//   2. Admin › Classifiers preview       previewClassifierRecipe          (classifier-preview.ts)
//   3. Admin › Reprocess "Intelligence"  POST /api/admin/reprocess        (reprocess.ts) — it omits
//      `channelKind` (K47); the loader carries it, so parity is asserted "plus channelKind"
//   4. YOLO load's post-enrichment       enrichPageAfterYolo              (yolo-post-enrichment.ts), fed a
//      page selected the way yoloLoad selects it (yolo.ts — the S3/SageMaker route itself is not driven)
// Each loader's input is captured at the classifier engine's door (computeClassifierProposals /
// runClassifierEngine wrapped, passthrough). The engine reads only `textractData.words/tables`, so
// the intelligence reprocess's full textractData is compared on those two keys.
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});
const capture = vi.hoisted(() => ({ proposals: [] as Array<Record<string, unknown>>, engine: [] as Array<Record<string, unknown>>, engineOn: false }));
vi.mock("@/server/services/classifier-proposals-write", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/server/services/classifier-proposals-write")>();
  return {
    ...orig,
    computeClassifierProposals: (...args: Parameters<typeof orig.computeClassifierProposals>) => {
      capture.proposals.push(args[0] as unknown as Record<string, unknown>);
      return orig.computeClassifierProposals(...args);
    },
  };
});
vi.mock("@/lib/classifier-engine", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/classifier-engine")>();
  return {
    ...orig,
    runClassifierEngine: (...args: Parameters<typeof orig.runClassifierEngine>) => {
      if (capture.engineOn) capture.engine.push(args[0] as unknown as Record<string, unknown>);
      return orig.runClassifierEngine(...args);
    },
  };
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { POST as reprocessPOST } from "@/app/api/admin/reprocess/route";
import { db } from "@/lib/db";
import { annotations, pages } from "@/lib/db/schema";
import { BUILT_IN_RECIPES } from "@/lib/classifier-engine";
import { computePageZones } from "@/lib/page-zones";
import { classifyRegionsV2 } from "@/lib/region-classifier-v2";
import type { AuthSession } from "@/lib/api-utils";
import type { CsiCode, KeynoteShapeData, TextractPageData } from "@/types";
import { assertProjectWritable } from "@/server/api/project-write-capability";
import { previewClassifierRecipe } from "@/server/services/classifier-preview";
import { classifierRecipesFor } from "@/server/services/classifier-proposals-write";
import { loadPageEvidence, toClassifierPageInput } from "@/server/services/parse-engine/evidence";
import { reprocessClassifiersScope } from "@/server/services/reprocess-classifiers";
import type { ReprocessStream } from "@/server/services/reprocess-stream";
import { enrichPageAfterYolo } from "@/server/services/yolo-post-enrichment";
import { asUser, createPage, createUser, createWorld, makeReq, type FixtureUser } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const FIXTURES = [
  "syn-sched-shapes-hex",              // yolo_primitive tag column
  "syn-sched-shapes-classical-dotted", // classical shapes → pages.keynotes
  "syn-sched-textract-header-row",     // a stored Textract table
  "syn-keynote-shapes",
  "syn-notes-two-column",              // no shapes: only the yolo_medium box
];

interface Fixture {
  id: string;
  page: { words: TextractPageData["words"]; lines: TextractPageData["lines"]; tables?: TextractPageData["tables"] };
  shapes?: { label: string; bbox: [number, number, number, number]; source: "yolo" | "classical"; confidence: number; text?: string }[];
  region: [number, number, number, number];
}
const loadFixture = (id: string): Fixture =>
  JSON.parse(readFileSync(join(process.cwd(), "src/lib/parse-engine/__fixtures__", `${id}.synthetic.json`), "utf8")) as Fixture;

const CSI: CsiCode[] = [{ code: "08 71 00", description: "QX HARDWARE", trade: "", division: "08", triggers: [{ text: "qx", bbox: [0.1, 0.1, 0.02, 0.01], tier: 1 }] }];

function seedFor(f: Fixture, n: number) {
  const dets = [
    { name: "tables", minX: f.region[0], minY: f.region[1], maxX: f.region[2], maxY: f.region[3], confidence: 0.9, modelName: "yolo_medium" },
    ...(n === 1 ? [{ name: "grid", minX: f.region[0], minY: f.region[1], maxX: f.region[2], maxY: f.region[3], confidence: 0.6, modelName: "yolo_primitive" }] : []),
    ...(f.shapes ?? []).filter((s) => s.source === "yolo").map((s) => ({ name: s.label, minX: s.bbox[0], minY: s.bbox[1], maxX: s.bbox[2], maxY: s.bbox[3], confidence: s.confidence, modelName: "yolo_primitive" })),
  ];
  const keynotes: KeynoteShapeData[] = (f.shapes ?? []).filter((s) => s.source === "classical").map((s) => ({ shape: s.label, text: s.text ?? "", bbox: s.bbox }));
  const ocr = { words: f.page.words, ...(f.page.tables?.length ? { tables: f.page.tables } : {}) };
  const zones = computePageZones(dets);
  const csiCodes = n === 2 ? CSI : [];
  const regionsV2 = classifyRegionsV2({ pageNumber: n, detections: dets, zones, textractData: ocr, csiCodes });
  return { dets, keynotes, ocr, zones, csiCodes, regionsV2 };
}

const byPage = (inputs: Array<Record<string, unknown>>) => new Map(inputs.map((i) => [i.pageNumber as number, i]));
/** The classifier engine reads only words/tables of textractData; compare those (sorted detections: DB order is not part of the contract). */
function norm(input: Record<string, unknown>): Record<string, unknown> {
  const { tagger: _t, ...rest } = input;
  const td = rest.textractData as { words?: unknown; tables?: unknown } | null | undefined;
  const dets = (rest.detections as Array<Record<string, unknown>>).map((d) => JSON.stringify(d, Object.keys(d).sort())).sort();
  return {
    ...rest,
    textractData: td ? { words: td.words, ...(td.tables ? { tables: td.tables } : {}) } : td,
    detections: dets,
  };
}

function sessionOf(u: FixtureUser): AuthSession {
  return { user: { companyId: u.companyId, dbId: u.id, username: u.username, role: u.role, canRunModels: u.canRunModels, isRootAdmin: u.isRootAdmin, email: u.email } } as AuthSession;
}

describe.skipIf(!dbUp)("page-evidence loader parity with the four classifier loaders (K47)", () => {
  it("toClassifierPageInput(loadPageEvidence) equals each hand-rolled loader's input, plus channelKind", async () => {
    const { company, project } = await createWorld();
    const admin = await createUser(company.id, { role: "admin" });
    const seeds = FIXTURES.map((id, i) => ({ n: i + 1, f: loadFixture(id) }));
    for (const { n, f } of seeds) {
      const s = seedFor(f, n);
      await createPage(project.id, n, {
        drawingNumber: `QX-10${n}`,
        rawText: "",
        textractData: { ...f.page, lines: f.page.lines } as never,
        keynotes: s.keynotes.length ? (s.keynotes as never) : null,
        csiCodes: s.csiCodes as never,
        pageIntelligence: {
          pageZones: s.zones, regionsV2: s.regionsV2,
          parsedRegions: n === 3 ? [{ id: "pr-x", type: "schedule", bbox: [f.region[0], f.region[1], f.region[2] - f.region[0], f.region[3] - f.region[1]], data: {} }] : undefined,
          ...(n % 2 === 1 ? { channels: { v: 1, kind: n === 1 ? "vector" : "scanned" } } : {}),
        } as never,
      });
      await db.insert(annotations).values(s.dets.map((d) => ({
        projectId: project.id, pageNumber: n, name: d.name, minX: d.minX, minY: d.minY, maxX: d.maxX, maxY: d.maxY, source: "yolo", data: { confidence: d.confidence, modelName: d.modelName },
      })) as never);
    }

    // the one loader
    const ours = new Map<number, Record<string, unknown>>();
    for (const { n } of seeds) {
      const ev = await loadPageEvidence(null, project.id, n);
      expect(ev).not.toBeNull();
      ours.set(n, toClassifierPageInput(ev!) as unknown as Record<string, unknown>);
    }
    expect([...ours.values()].map((i) => i.channelKind)).toEqual(["vector", null, "scanned", null, "scanned"]);

    // 1. reprocess-classifiers
    capture.proposals.length = 0;
    const fake: ReprocessStream = { send: () => {}, debug: () => {}, isClosed: () => false, close: () => {}, debugEnabled: false };
    await reprocessClassifiersScope({ projects: [{ id: project.id, name: "set" }], withReprocessLease: (id, op) => op(assertProjectWritable({ ...project, id })), stream: fake, overlay: undefined });
    const scope = byPage(capture.proposals);

    // 2. classifier preview (built-in schedules recipe)
    capture.engine.length = 0;
    capture.engineOn = true;
    await previewClassifierRecipe(sessionOf(admin), { projectId: project.publicId, pages: seeds.map((s) => s.n), recipe: BUILT_IN_RECIPES[0] });
    capture.engineOn = false;
    const preview = byPage(capture.engine);

    // 4. post-YOLO enrichment, page selected as yoloLoad selects it
    capture.proposals.length = 0;
    const rows = await db.select({ id: pages.id, pageNumber: pages.pageNumber, rawText: pages.rawText, drawingNumber: pages.drawingNumber, pageIntelligence: pages.pageIntelligence, csiCodes: pages.csiCodes })
      .from(pages).where(eq(pages.projectId, project.id));
    const yolo = await db.select().from(annotations).where(and(eq(annotations.projectId, project.id), eq(annotations.source, "yolo")));
    for (const page of rows) {
      const [ocr] = await db.select({
        words: sql<TextractPageData["words"] | null>`${pages.textractData}->'words'`,
        tables: sql<TextractPageData["tables"] | null>`${pages.textractData}->'tables'`,
        keynotes: pages.keynotes,
      }).from(pages).where(eq(pages.id, page.id));
      const yoloDets = yolo.filter((a) => a.pageNumber === page.pageNumber).map((a) => {
        const data = a.data as { confidence?: number; modelName?: string } | null;
        return { name: a.name, minX: a.minX, minY: a.minY, maxX: a.maxX, maxY: a.maxY, confidence: data?.confidence ?? 0, modelName: data?.modelName };
      });
      const textractData = Array.isArray(ocr?.words) ? { words: ocr.words, ...(ocr.tables ? { tables: ocr.tables } : {}) } : null;
      enrichPageAfterYolo(
        { pageNumber: page.pageNumber, rawText: page.rawText, pageIntelligence: page.pageIntelligence, csiCodes: page.csiCodes, textractData, keynotes: ocr?.keynotes ?? null, drawingNumber: page.drawingNumber },
        yoloDets,
        { rules: [], heatmapEnabled: false, ensembleEnabled: false, sheetNumbers: rows.map((r) => r.drawingNumber), classifierRecipes: classifierRecipesFor(undefined) },
      );
    }
    const postYolo = byPage(capture.proposals);

    // 3. intelligence reprocess (route; drains the stream)
    capture.proposals.length = 0;
    asUser(admin);
    const res = await reprocessPOST(makeReq("/api/admin/reprocess?scope=intelligence", { method: "POST" }) /* no body: every project of the (fresh) company */);
    expect(res.status).toBe(200);
    await res.text();
    const intel = byPage(capture.proposals);

    for (const { n, f } of seeds) {
      const mine = norm(ours.get(n)!);
      expect(norm(scope.get(n)!), `${f.id}: reprocess-classifiers`).toEqual(mine);
      expect(norm(preview.get(n)!), `${f.id}: classifier preview`).toEqual(mine);
      expect(norm(postYolo.get(n)!), `${f.id}: post-YOLO enrichment`).toEqual(mine);
      const fromIntel = norm(intel.get(n)!);
      expect(fromIntel.channelKind, `${f.id}: the intelligence reprocess omits channelKind (K47)`).toBeUndefined();
      expect({ ...fromIntel, channelKind: mine.channelKind }, `${f.id}: intelligence reprocess`).toEqual(mine);
    }
  }, 120_000);

  it("returns null for a missing page and reads only the requested page's YOLO rows, in id order", async () => {
    const { project } = await createWorld();
    await createPage(project.id, 1, { textractData: { lines: [], words: [] } as never });
    await createPage(project.id, 2, { textractData: { lines: [], words: [] } as never });
    await db.insert(annotations).values([
      { projectId: project.id, pageNumber: 1, name: "circle", minX: 0.1, minY: 0.1, maxX: 0.12, maxY: 0.12, source: "yolo", data: { confidence: 0.5, modelName: "yolo_primitive" } },
      { projectId: project.id, pageNumber: 2, name: "tables", minX: 0.1, minY: 0.1, maxX: 0.5, maxY: 0.5, source: "yolo", data: { confidence: 0.9, modelName: "yolo_medium" } },
      { projectId: project.id, pageNumber: 1, name: "hexagon", minX: 0.2, minY: 0.2, maxX: 0.22, maxY: 0.22, source: "yolo", data: { confidence: 0.6, modelName: "yolo_primitive" } },
      { projectId: project.id, pageNumber: 1, name: "user box", minX: 0.3, minY: 0.3, maxX: 0.4, maxY: 0.4, source: "user", data: {} },
    ] as never);
    expect(await loadPageEvidence(undefined, project.id, 9)).toBeNull();
    const ev = await loadPageEvidence(undefined, project.id, 1);
    expect(ev!.sources.detections.map((d) => d.name)).toEqual(["circle", "hexagon"]);
    expect(ev!.shapes.map((s) => s.cls)).toEqual(["circle", "hexagon"]);
    // inside a caller's transaction
    const inTx = await db.transaction(async (tx) => loadPageEvidence(tx, project.id, 1));
    expect(inTx!.evidenceHash).toBe(ev!.evidenceHash);
  });
});
