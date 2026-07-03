// [refactor jul3 P1.5] Export service — the two download-tooling routes' behavior.
//
// `projects/[id]/export` + `projects/export-index` are now thin `defineRoute` shells; ALL
// behavior lives here. No P0.3 char file existed — the NEW projects-export.route.test.ts +
// projects-export-index.route.test.ts written WITH this migration ARE the freeze.
//
// ⚠️ Both endpoints are the ingest contract for EXTERNAL headless / gaussian-fingerprint
// tooling (ZERO first-party consumers — verified by the S022 sweep). The 200 bodies are
// BYTE-IDENTICAL to legacy; only error paths carry the sanctioned envelope flips.
//
// Two shapes:
//   • exportProject = ACCESS-FIRST via resolveProjectOrThrow({allowDemo:true}) — demo projects
//     export WITHOUT auth (frozen); unknown → 404 BEFORE auth (engine order); root bypass.
//     Shell auth:"none" + service-resolved (the searchProjectPages recipe).
//   • exportIndex = AUTH-FIRST requireAuth → shell auth:"session". Scope: root admin → ALL
//     projects (every company — frozen); member → own company only.
//
// Sanctioned diffs ONLY (success bodies byte-identical):
//   A envelope flips {error:string} → {error:{code,message}} on 401/404.
//   B leak-drop: neither legacy route had a try/catch → an unexpected throw was a raw leaky 500;
//     now the shell's generic INTERNAL 500. (safePresign's per-key catch→null is KEPT — non-fatal
//     by design.)
//   C (export only) non-uuid id: legacy fed it into the pg uuid cast inside resolveProjectAccess
//     → raw 500 (S003 class); now a clean 400 "Invalid project id" via zPublicId. NB this fires
//     BEFORE auth resolution (legacy's cast also fired regardless of auth state — same class as
//     every prior C).
//
// Frozen quirks (do NOT "fix"):
//   FQ-1 exportedAt = a fresh `new Date().toISOString()` per request (non-deterministic field —
//        the char test pins type, not value).
//   FQ-2 ?omit fields are set to UNDEFINED → JSON.stringify DROPS the key entirely (NOT null) —
//        external parsers may distinguish absent-vs-null; pinned by key-set assertions.
//   FQ-3 parsePagesParam: "lo-hi" tolerates a SWAPPED range ("3-1" === "1-3"); junk parts are
//        silently dropped; an all-junk param yields NULL (no filter → all pages).
//   FQ-4 safePresign catch → null URL (per-key, non-fatal, still 200).
//   FQ-5 the PADDED page_NNNN.png key convention (String(n).padStart(4,"0")) — the engine's
//        real key shape (contrast labeling's [LB-1] unpadded bug, preserved separately).
//   FQ-6 exportIndex richness = parsedRegions*5 + qtoWorkflows*5 + (symbolSearch>0?3:0) +
//        userAnnotations*1 — yolo and shapeParse deliberately contribute ZERO (info-only);
//        output sorted richness DESC; yoloModels = DISTINCT data->>'modelName', sorted, nulls
//        skipped; empty project list early-returns {projects:[]}.

import { db } from "@/lib/db";
import { projects, pages, annotations, models, qtoWorkflows } from "@/lib/db/schema";
import { eq, and, inArray, sql, desc } from "drizzle-orm";
import { ApiError } from "@/server/api/envelope";
import { resolveProjectOrThrow } from "@/server/api/access";
import { zPublicId } from "@/server/api/schemas";
import { getPresignedGetUrl } from "@/lib/s3";
import type { AuthSession } from "@/lib/api-utils";

// ── GET /api/projects/[id]/export ──────────────────────────────────────────────────────────────

interface ExportPageImage {
  pngKey: string;
  pngUrl: string | null;
  thumbKey: string;
  thumbUrl: string | null;
}

export async function exportProject(req: Request, idParam: string) {
  const url = new URL(req.url);

  // [diff C] non-uuid → clean 400 (legacy: pg uuid-cast 500 inside the access engine).
  const parsed = zPublicId.safeParse(idParam);
  if (!parsed.success) {
    throw new ApiError("VALIDATION", "Invalid project id");
  }

  // ACCESS-FIRST, allowDemo (demo projects export signed-out; unknown → 404 before auth; root
  // bypass) — the same engine legacy called via resolveProjectAccess.
  const { project } = await resolveProjectOrThrow({ publicId: parsed.data }, { allowDemo: true });

  const omit = new Set(
    (url.searchParams.get("omit") ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const pagesFilter = parsePagesParam(url.searchParams.get("pages"));

  // Heavy project-level fields (resolveProjectAccess intentionally excludes these)
  const [proj] = await db
    .select({
      projectIntelligence: projects.projectIntelligence,
      projectSummary: projects.projectSummary,
    })
    .from(projects)
    .where(eq(projects.id, project.id))
    .limit(1);

  let pageRows = await db
    .select()
    .from(pages)
    .where(eq(pages.projectId, project.id))
    .orderBy(pages.pageNumber);
  if (pagesFilter) pageRows = pageRows.filter((p) => pagesFilter.has(p.pageNumber));

  const annRows = await db
    .select()
    .from(annotations)
    .where(eq(annotations.projectId, project.id));

  const modelRows = await db
    .select({ name: models.name, type: models.type, config: models.config })
    .from(models)
    .where(eq(models.companyId, project.companyId));

  // Presigned S3 URLs (24h). page_NNNN.png is the engine's 4-digit zero-padded key (FQ-5).
  const EXPIRES = 24 * 60 * 60;
  const pad = (n: number) => String(n).padStart(4, "0");
  const wantImages = !omit.has("images");

  const pdfKey = `${project.dataUrl}/original.pdf`;
  const pdfUrl = wantImages ? await safePresign(pdfKey, EXPIRES) : null;

  const imageByPage = new Map<number, ExportPageImage>();
  if (wantImages) {
    await Promise.all(
      pageRows.map(async (p) => {
        const pngKey = `${project.dataUrl}/pages/page_${pad(p.pageNumber)}.png`;
        const thumbKey = `${project.dataUrl}/thumbnails/page_${pad(p.pageNumber)}.png`;
        const [pngUrl, thumbUrl] = await Promise.all([
          safePresign(pngKey, EXPIRES),
          safePresign(thumbKey, EXPIRES),
        ]);
        imageByPage.set(p.pageNumber, { pngKey, pngUrl, thumbKey, thumbUrl });
      }),
    );
  }

  // The bp-export/1 bundle — byte-identical to legacy (the shell json-envelopes it at 200).
  return {
    schemaVersion: "bp-export/1",
    exportedAt: new Date().toISOString(), // FQ-1
    project: {
      publicId: project.publicId,
      name: project.name,
      dataUrl: project.dataUrl,
      numPages: project.numPages,
      status: project.status,
      projectIntelligence: proj?.projectIntelligence ?? null,
      projectSummary: proj?.projectSummary ?? null,
    },
    models: modelRows,
    assets: { pdfKey, pdfUrl },
    pages: pageRows.map((p) => ({
      pageNumber: p.pageNumber,
      name: p.name,
      drawingNumber: p.drawingNumber,
      rawText: p.rawText,
      csiCodes: p.csiCodes,
      keynotes: p.keynotes,
      textAnnotations: p.textAnnotations,
      textractData: omit.has("textract") ? undefined : p.textractData, // FQ-2: undefined-dropped
      pageIntelligence: omit.has("intelligence") ? undefined : p.pageIntelligence,
      error: p.error,
      image: imageByPage.get(p.pageNumber) ?? null,
    })),
    annotations: annRows.map((a) => ({
      id: a.id,
      name: a.name,
      // MinMax normalized 0-1, matching ClientAnnotation/YoloDetection convention
      bbox: [a.minX, a.minY, a.maxX, a.maxY] as [number, number, number, number],
      pageNumber: a.pageNumber,
      threshold: a.threshold,
      source: a.source,
      data: a.data,
      note: a.note,
    })),
  };
}

async function safePresign(key: string, expiresIn: number): Promise<string | null> {
  // FQ-4: per-key failure → null, never fatal.
  try {
    return await getPresignedGetUrl(key, expiresIn);
  } catch {
    return null;
  }
}

/** Parse "1-50", "1,2,3", "1-10,20" into a Set of page numbers. Null if absent. (FQ-3) */
function parsePagesParam(raw: string | null): Set<number> | null {
  if (!raw) return null;
  const set = new Set<number>();
  for (const part of raw.split(",")) {
    const t = part.trim();
    const range = t.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const lo = Math.min(+range[1], +range[2]);
      const hi = Math.max(+range[1], +range[2]);
      for (let i = lo; i <= hi; i++) set.add(i);
    } else if (/^\d+$/.test(t)) {
      set.add(+t);
    }
  }
  return set.size ? set : null;
}

// ── GET /api/projects/export-index ─────────────────────────────────────────────────────────────

export async function exportIndex(session: AuthSession) {
  const user = session.user as { companyId: number; isRootAdmin?: boolean };

  const cols = {
    id: projects.id,
    publicId: projects.publicId,
    name: projects.name,
    numPages: projects.numPages,
    status: projects.status,
    createdAt: projects.createdAt,
  };
  // Frozen scopes: root admin → ALL projects (every company); member → own company only.
  const projRows = user.isRootAdmin
    ? await db.select(cols).from(projects).orderBy(desc(projects.createdAt))
    : await db
        .select(cols)
        .from(projects)
        .where(eq(projects.companyId, user.companyId))
        .orderBy(desc(projects.createdAt));

  if (projRows.length === 0) return { projects: [] };
  const ids = projRows.map((p) => p.id);

  // annotation counts by source per project
  const annAgg = await db
    .select({
      projectId: annotations.projectId,
      source: annotations.source,
      n: sql<number>`count(*)::int`,
    })
    .from(annotations)
    .where(inArray(annotations.projectId, ids))
    .groupBy(annotations.projectId, annotations.source);

  // distinct YOLO model names per project
  const modelAgg = await db
    .select({
      projectId: annotations.projectId,
      modelName: sql<string | null>`(${annotations.data} ->> 'modelName')`,
    })
    .from(annotations)
    .where(and(inArray(annotations.projectId, ids), eq(annotations.source, "yolo")))
    .groupBy(annotations.projectId, sql`(${annotations.data} ->> 'modelName')`);

  // parsedRegions: total + pages-with-any, summed over pageIntelligence JSONB
  const prAgg = await db
    .select({
      projectId: pages.projectId,
      parsedRegions: sql<number>`COALESCE(SUM(CASE WHEN jsonb_typeof(${pages.pageIntelligence} -> 'parsedRegions') = 'array' THEN jsonb_array_length(${pages.pageIntelligence} -> 'parsedRegions') ELSE 0 END), 0)::int`,
      pagesWithParsedRegions: sql<number>`(COUNT(*) FILTER (WHERE jsonb_typeof(${pages.pageIntelligence} -> 'parsedRegions') = 'array' AND jsonb_array_length(${pages.pageIntelligence} -> 'parsedRegions') > 0))::int`,
    })
    .from(pages)
    .where(inArray(pages.projectId, ids))
    .groupBy(pages.projectId);

  // QTO workflows (tag-mapping / Auto-QTO) per project
  const qtoAgg = await db
    .select({ projectId: qtoWorkflows.projectId, n: sql<number>`count(*)::int` })
    .from(qtoWorkflows)
    .where(inArray(qtoWorkflows.projectId, ids))
    .groupBy(qtoWorkflows.projectId);

  // ── fold aggregates into per-project maps ──
  const bySource = new Map<number, Record<string, number>>();
  for (const r of annAgg) {
    const m = bySource.get(r.projectId) ?? {};
    m[r.source] = r.n;
    bySource.set(r.projectId, m);
  }
  const modelNames = new Map<number, Set<string>>();
  for (const r of modelAgg) {
    if (!r.modelName) continue;
    const s = modelNames.get(r.projectId) ?? new Set<string>();
    s.add(r.modelName);
    modelNames.set(r.projectId, s);
  }
  const pr = new Map(prAgg.map((r) => [r.projectId, r]));
  const qto = new Map(qtoAgg.map((r) => [r.projectId, r.n]));

  const out = projRows.map((p) => {
    const src = bySource.get(p.id) ?? {};
    const parsedRegions = pr.get(p.id)?.parsedRegions ?? 0;
    const pagesWithParsedRegions = pr.get(p.id)?.pagesWithParsedRegions ?? 0;
    const symbolSearch = src["symbol-search"] ?? 0;
    const shapeParse = src["shape-parse"] ?? 0;
    const yolo = src["yolo"] ?? 0;
    const userAnnotations = src["user"] ?? 0;
    const qtoWorkflowsCount = qto.get(p.id) ?? 0;

    // FQ-6: prioritize *user-initiated* per-plan work. parsedRegions + QTO are the gold
    // (a human committed each). shape-parse & yolo run automatically → info only.
    const richness =
      parsedRegions * 5 +
      qtoWorkflowsCount * 5 +
      (symbolSearch > 0 ? 3 : 0) +
      userAnnotations * 1;

    return {
      publicId: p.publicId,
      name: p.name,
      numPages: p.numPages,
      status: p.status,
      createdAt: p.createdAt,
      coverage: {
        yolo,
        yoloModels: Array.from(modelNames.get(p.id) ?? []).sort(),
        shapeParse,
        symbolSearch,
        userAnnotations,
        parsedRegions,
        pagesWithParsedRegions,
        qtoWorkflows: qtoWorkflowsCount,
      },
      richness,
    };
  });

  out.sort((a, b) => b.richness - a.richness);
  return { projects: out };
}
