// @vitest-environment node
// GOLDEN (Q10): the admin dataset (bp-dataset/1) run through scripts/bp-dataset-split.mjs must
// reproduce the frozen per-project bp-export/1 download (GET /api/projects/[id]/export) for the
// same seeded project — byte-identical once the documented, deliberate differences are aligned:
//   • exportedAt (fresh per request in both);
//   • S3 keys are never in the dataset → project.dataUrl, assets.pdfKey, image.pngKey/thumbKey null;
//   • hidden duplicate pages and their annotations are dropped (unless --keep-duplicates);
//   • omit=intelligence: projectIntelligence is not in the dataset → null (the live export keeps it).
// Presigned URLs line up because both paths sign the same keys through the mocked signer.
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const s3Mocks = vi.hoisted(() => ({ getPresignedGetUrl: vi.fn() }));
vi.mock("@/lib/s3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/s3")>()),
  getPresignedGetUrl: s3Mocks.getPresignedGetUrl,
}));

import { GET as datasetGET } from "@/app/api/admin/data-export/route";
import { GET as legacyGET } from "@/app/api/projects/[id]/export/route";
import { db } from "@/lib/db";
import { annotations, models } from "@/lib/db/schema";
import { asUser, createCompany, createPage, createProject, createUser, makeReq, params, readJson } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const SCRIPT = path.resolve(process.cwd(), "scripts/bp-dataset-split.mjs");

interface LegacyPage {
  pageNumber: number;
  image: { pngKey: string | null; thumbKey: string | null } | null;
}
interface LegacyBundle {
  exportedAt: string;
  project: { dataUrl: string | null; projectIntelligence: unknown };
  assets: { pdfKey: string | null };
  pages: LegacyPage[];
  annotations: { id: number; pageNumber: number }[];
}

async function convert(gz: ArrayBuffer, publicId: string, extra: string[] = []) {
  const dir = await mkdtemp(path.join(tmpdir(), "bp-golden-"));
  try {
    const input = path.join(dir, "in.ndjson.gz");
    await writeFile(input, Buffer.from(gz));
    const res = spawnSync(process.execPath, [SCRIPT, input, "--out", path.join(dir, "out"), ...extra], { encoding: "utf8" });
    expect(res.status, res.stderr).toBe(0);
    return await readFile(path.join(dir, "out", `${publicId}.json`), "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The live bundle with the deliberate differences aligned to the converter's output. */
function align(legacy: LegacyBundle, exportedAt: string, dropPages: number[]): LegacyBundle {
  const drop = new Set(dropPages);
  return {
    ...legacy,
    exportedAt,
    project: { ...legacy.project, dataUrl: null },
    assets: { ...legacy.assets, pdfKey: null },
    pages: legacy.pages
      .filter((p) => !drop.has(p.pageNumber))
      .map((p) => ({ ...p, image: p.image ? { ...p.image, pngKey: null, thumbKey: null } : null })),
    annotations: legacy.annotations.filter((a) => !drop.has(a.pageNumber)).sort((a, b) => a.id - b.id),
  };
}

describe.skipIf(!dbUp)("bp-dataset-split golden vs bp-export/1", () => {
  it("converter output === live per-project export (duplicates dropped by default, kept on request)", async () => {
    const company = await createCompany();
    const root = await createUser(company.id, { isRootAdmin: true });
    const project = await createProject(company.id, root.id, { projectIntelligence: { synthetic: "PI-G" } as never });
    await createPage(project.id, 2, {
      drawingNumber: "A-2",
      rawText: "synthetic page two",
      csiCodes: [{ code: "08 11 13", description: "synthetic", trade: "Openings" }] as never,
      keynotes: [] as never,
      textAnnotations: { annotations: [] } as never,
      textractData: { lines: [], words: [{ text: "two", bbox: [0, 0, 1, 1] }] } as never,
      pageIntelligence: { classification: { discipline: "A" } } as never,
    });
    await createPage(project.id, 1, { rawText: "synthetic page one", error: null });
    await createPage(project.id, 3, {
      rawText: "synthetic page one",
      pageIntelligence: {
        duplicateOf: { pageNumber: 1, tier: "exact", score: 1, scannedAt: "2026-10-21T00:00:00Z", hiddenAt: "2026-10-21T00:00:00Z" },
      } as never,
    });
    await db.insert(models).values([
      { companyId: company.id, name: "m-a", type: "yolo", s3Path: "s3://weights/a.pt", config: { classes: ["a"] } as never },
      { companyId: company.id, name: "m-b", type: "yolo", s3Path: "s3://weights/b.pt", config: null },
    ]);
    const base = { minX: 0.1, minY: 0.2, maxX: 0.3, maxY: 0.4, projectId: project.id };
    await db.insert(annotations).values([
      { ...base, name: "door", pageNumber: 2, source: "yolo", threshold: 0.5, data: { modelId: 1, classId: 0, modelName: "m-a" } as never },
      { ...base, name: "markup", pageNumber: 1, source: "user", note: "n", data: {} as never },
      { ...base, name: "copy", pageNumber: 3, source: "yolo", data: { modelId: 1, classId: 0 } as never },
      { ...base, name: "count", pageNumber: 2, source: "takeoff", data: { type: "count-marker" } as never },
    ]);
    s3Mocks.getPresignedGetUrl.mockImplementation(async (key: string) => `https://signed.test/${key}`);
    asUser(root);

    const legacy = await readJson(
      await legacyGET(makeReq(`/api/projects/${project.publicId}/export`, { method: "GET" }), params({ id: project.publicId })),
    );
    expect(legacy.status).toBe(200);
    expect(legacy.body.pages).toHaveLength(3); // the frozen export never drops duplicates

    const qs = `?companyId=${company.publicId}&projects=${project.publicId}&presign=1`;
    const ds = await datasetGET(makeReq(`/api/admin/data-export${qs}`, { method: "GET" }));
    expect(ds.status).toBe(200);
    const converted = await convert(await ds.arrayBuffer(), project.publicId);
    const parsed = JSON.parse(converted) as LegacyBundle;
    const expected = align(legacy.body as LegacyBundle, parsed.exportedAt, [3]);
    expect(parsed).toEqual(expected);
    expect(converted).toBe(JSON.stringify(expected)); // same key order → byte-identical

    // skipDuplicates=0 + --keep-duplicates → every page, exactly as the live export.
    const all = await datasetGET(makeReq(`/api/admin/data-export${qs}&skipDuplicates=0`, { method: "GET" }));
    const keptRaw = await convert(await all.arrayBuffer(), project.publicId, ["--keep-duplicates"]);
    const kept = JSON.parse(keptRaw) as LegacyBundle;
    expect(keptRaw).toBe(JSON.stringify(align(legacy.body as LegacyBundle, kept.exportedAt, [])));

    // skipDuplicates=0 without --keep-duplicates: the converter itself filters the marked page.
    const unfiltered = await datasetGET(makeReq(`/api/admin/data-export${qs}&skipDuplicates=0`, { method: "GET" }));
    const filteredRaw = await convert(await unfiltered.arrayBuffer(), project.publicId);
    const filtered = JSON.parse(filteredRaw) as LegacyBundle;
    expect(filteredRaw).toBe(JSON.stringify(align(legacy.body as LegacyBundle, filtered.exportedAt, [3])));

    // omit options, each against the live export with the same omit.
    for (const omit of ["textract", "intelligence", "textract,intelligence"]) {
      const live = await readJson(
        await legacyGET(makeReq(`/api/projects/${project.publicId}/export?omit=${omit}`, { method: "GET" }), params({ id: project.publicId })),
      );
      expect(live.status).toBe(200);
      const liveBody = live.body as LegacyBundle;
      expect(liveBody.project.projectIntelligence).toEqual({ synthetic: "PI-G" });
      const dsOmit = await datasetGET(makeReq(`/api/admin/data-export${qs}&omit=${omit}`, { method: "GET" }));
      const omitRaw = await convert(await dsOmit.arrayBuffer(), project.publicId);
      const omitted = JSON.parse(omitRaw) as LegacyBundle;
      const want = align(liveBody, omitted.exportedAt, [3]);
      // the one documented difference: the dataset does not carry projectIntelligence under omit=intelligence
      if (omit.includes("intelligence")) want.project = { ...want.project, projectIntelligence: null };
      expect(omitRaw, omit).toBe(JSON.stringify(want));
    }
  });
});
