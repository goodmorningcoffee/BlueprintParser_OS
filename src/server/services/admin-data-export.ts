// GET /api/admin/data-export — the admin data export, format bp-dataset/1 (plan §3).
//
// One gzip-compressed NDJSON file, one object per line keyed by "t":
//   header · model* · (project · page* · annotation* · takeoffGroup* · takeoffItem* ·
//   qtoWorkflow* · annotationGroup*)* per project in projects.id order · error* · footer
// Pages are read in keyset batches of 25 by pages.id, annotations in batches of 1000 by
// annotations.id; every batch is its own short query, so a paused download holds no connection,
// no transaction and no snapshot (the header says the file is not a point-in-time snapshot).
//
// Scope: a company admin exports their own company only (another companyId → 403, never
// overridden); root exports every company or one (?companyId=<company publicId>). ?projects=
// with any id outside the scope → 404 for the whole request (fail closed).
//
// Duplicates: with skipDuplicates (default ON) every page whose duplicate mark carries hiddenAt
// is dropped, with every annotation on that (project, pageNumber) and those annotations' group
// memberships. The footer counts what was skipped.
//
// Never emitted: models.s3Path, user emails, chat, labeling sessions, project address/lat/long,
// projects.dataUrl and any other S3 key, webhook secrets. Assets are application-gateway paths;
// root may add short-lived presigned GET URLs (?presign=1) for CLI use.
//
// The frozen per-project bp-export/1 (services/export.ts) is NOT touched; the converter
// scripts/bp-dataset-split.mjs turns this file back into that shape.

import { z } from "zod";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  annotationGroupMembers,
  annotationGroups,
  annotations,
  companies,
  models,
  pages,
  projectMutationLeases,
  projects,
  qtoWorkflows,
  takeoffGroups,
  takeoffItems,
  users,
} from "@/lib/db/schema";
import type { AuthSession } from "@/lib/api-utils";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { getPresignedGetUrl } from "@/lib/s3";
import { isCanonicalProjectPath } from "@/lib/project-upload-authority";
import { classifyAnnotationData } from "@/types/shapes/annotation-data";
import { ApiError } from "@/server/api/envelope";
import { zPublicId } from "@/server/api/schemas";
import { projectAssetUrl } from "@/server/services/project-assets";
import {
  DATASET_SCHEMA_VERSION,
  annotationOrigin,
  datasetFilename,
  isHiddenDuplicate,
  ndjsonGzipStream,
  parseFlag,
  parseList,
  tryAcquireExportSlot,
} from "@/server/services/admin-data-export-stream";

export const PAGE_BATCH = 25;
export const ANNOTATION_BATCH = 1000;
const SMALL_BATCH = 500;
const MAX_EXPLICIT_PROJECTS = 500;
const PRESIGN_TTL_SECONDS = 60 * 60;

export const zDataExportQuery = z.object({
  companyId: zPublicId.optional(),
  projects: z.string().max(40_000).optional(),
  status: z.enum(["completed", "any"]).optional(),
  includeDemo: z.string().max(8).optional(),
  omit: z.string().max(200).optional(),
  skipDuplicates: z.string().max(8).optional(),
  presign: z.string().max(8).optional(),
});
export type DataExportQuery = z.infer<typeof zDataExportQuery>;

export interface DataExportOptions {
  status: "completed" | "any";
  includeDemo: boolean;
  textract: boolean;
  intelligence: boolean;
  skipDuplicates: boolean;
  presign: boolean;
}

interface ScopedProject {
  id: number;
  publicId: string;
  name: string;
  numPages: number | null;
  status: string;
  isDemo: boolean;
  createdAt: Date | null;
  dataUrl: string;
  companyId: number;
  companyPublicId: string;
  companyDataKey: string;
}

interface ExportPlan {
  scopeLabel: string;
  companyPublicId: string | null;
  projects: ScopedProject[];
  options: DataExportOptions;
  exporterPublicId: string | null;
}

interface Tally {
  counts: Record<string, number>;
  skipped: { pages: number; annotations: number; groupMembers: number; projects: number };
}

const pad4 = (n: number) => String(n).padStart(4, "0");

// ── request → plan ─────────────────────────────────────────────────────────────────────────────

export function parseExportOptions(q: DataExportQuery): DataExportOptions {
  const omit = new Set(parseList(q.omit).map((s) => s.toLowerCase()));
  return {
    status: q.status ?? "completed",
    includeDemo: parseFlag(q.includeDemo, false),
    textract: !omit.has("textract"),
    intelligence: !omit.has("intelligence"),
    skipDuplicates: parseFlag(q.skipDuplicates, true),
    presign: parseFlag(q.presign, false),
  };
}

async function resolvePlan(session: AuthSession, q: DataExportQuery): Promise<ExportPlan> {
  const isRoot = session.user.isRootAdmin === true;
  const options = parseExportOptions(q);
  if (options.presign && !isRoot) {
    throw new ApiError("FORBIDDEN", "Presigned links are root-only");
  }

  // Company scope. A company admin can name only their own company; root can name any.
  let companyIds: number[] | null;
  let companyPublicId: string | null = null;
  if (q.companyId) {
    const [company] = await db
      .select({ id: companies.id, publicId: companies.publicId })
      .from(companies)
      .where(eq(companies.publicId, q.companyId))
      .limit(1);
    if (!isRoot && (!company || company.id !== session.user.companyId)) {
      throw new ApiError("FORBIDDEN", "Company admins can export only their own company");
    }
    if (!company) throw new ApiError("NOT_FOUND", "Company not found");
    companyIds = [company.id];
    companyPublicId = company.publicId;
  } else if (isRoot) {
    companyIds = null;
  } else {
    companyIds = [session.user.companyId];
    const [own] = await db
      .select({ publicId: companies.publicId })
      .from(companies)
      .where(eq(companies.id, session.user.companyId))
      .limit(1);
    companyPublicId = own?.publicId ?? null;
  }

  const cols = {
    id: projects.id,
    publicId: projects.publicId,
    name: projects.name,
    numPages: projects.numPages,
    status: projects.status,
    isDemo: projects.isDemo,
    createdAt: projects.createdAt,
    dataUrl: projects.dataUrl,
    companyId: projects.companyId,
    companyPublicId: companies.publicId,
    companyDataKey: companies.dataKey,
  };
  const companyFilter = companyIds ? inArray(projects.companyId, companyIds) : undefined;

  const explicit = parseList(q.projects);
  let rows: ScopedProject[];
  if (explicit.length > 0) {
    const unique = Array.from(new Set(explicit));
    if (unique.length > MAX_EXPLICIT_PROJECTS) {
      throw new ApiError("VALIDATION", `At most ${MAX_EXPLICIT_PROJECTS} projects per export`);
    }
    if (unique.some((id) => !zPublicId.safeParse(id).success)) {
      throw new ApiError("VALIDATION", "Invalid project id");
    }
    rows = await db
      .select(cols)
      .from(projects)
      .innerJoin(companies, eq(companies.id, projects.companyId))
      .where(and(inArray(projects.publicId, unique), companyFilter))
      .orderBy(asc(projects.id));
    // Fail closed: one unknown or out-of-scope id refuses the whole request (no partial export,
    // and a foreign id is indistinguishable from a missing one).
    if (rows.length !== unique.length) throw new ApiError("NOT_FOUND", "Project not found");
  } else {
    rows = await db
      .select(cols)
      .from(projects)
      .innerJoin(companies, eq(companies.id, projects.companyId))
      .where(
        and(
          companyFilter,
          options.status === "completed" ? eq(projects.status, "completed") : undefined,
          options.includeDemo ? undefined : eq(projects.isDemo, false),
        ),
      )
      .orderBy(asc(projects.id));
  }

  const [me] = await db
    .select({ publicId: users.publicId })
    .from(users)
    .where(eq(users.id, session.user.dbId))
    .limit(1);

  return {
    scopeLabel: companyPublicId ?? (isRoot ? "all-companies" : "company"),
    companyPublicId,
    projects: rows,
    options,
    exporterPublicId: me?.publicId ?? null,
  };
}

// ── line producers ─────────────────────────────────────────────────────────────────────────────

async function safePresign(key: string): Promise<string | null> {
  try {
    return await getPresignedGetUrl(key, PRESIGN_TTL_SECONDS);
  } catch {
    return null;
  }
}

async function* modelLines(plan: ExportPlan, tally: Tally): AsyncGenerator<unknown> {
  const companyIds = Array.from(new Set(plan.projects.map((p) => p.companyId)));
  if (companyIds.length === 0) return;
  // name/type/config only — models.s3Path (WEIGHTS-2) is never selected.
  const rows = await db
    .select({
      companyPublicId: companies.publicId,
      name: models.name,
      type: models.type,
      config: models.config,
    })
    .from(models)
    .innerJoin(companies, eq(companies.id, models.companyId))
    .where(inArray(models.companyId, companyIds))
    .orderBy(asc(models.companyId), asc(models.id));
  for (const m of rows) {
    tally.counts.model++;
    yield { t: "model", ...m };
  }
}

async function* pageLines(
  p: ScopedProject,
  plan: ExportPlan,
  tally: Tally,
  hiddenPages: Set<number>,
  presign: boolean,
): AsyncGenerator<unknown> {
  const { options } = plan;
  let lastId = 0;
  for (;;) {
    const batch = await db
      .select({
        id: pages.id,
        pageNumber: pages.pageNumber,
        name: pages.name,
        drawingNumber: pages.drawingNumber,
        rawText: pages.rawText,
        csiCodes: pages.csiCodes,
        keynotes: pages.keynotes,
        textAnnotations: pages.textAnnotations,
        textractData: options.textract ? pages.textractData : sql<null>`null`,
        pageIntelligence: options.intelligence ? pages.pageIntelligence : sql<null>`null`,
        duplicateOf: sql<unknown>`(${pages.pageIntelligence} -> 'duplicateOf')`,
        error: pages.error,
      })
      .from(pages)
      .where(and(eq(pages.projectId, p.id), gt(pages.id, lastId)))
      .orderBy(asc(pages.id))
      .limit(PAGE_BATCH);
    if (batch.length === 0) return;
    lastId = batch[batch.length - 1].id;

    for (const pg of batch) {
      const duplicateOf = pg.duplicateOf ?? null;
      if (options.skipDuplicates && isHiddenDuplicate(duplicateOf)) {
        hiddenPages.add(pg.pageNumber);
        tally.skipped.pages++;
        continue;
      }
      const png = `pages/page_${pad4(pg.pageNumber)}.png`;
      const thumb = `thumbnails/page_${pad4(pg.pageNumber)}.png`;
      const assets: Record<string, string | null> = {
        png: projectAssetUrl(p.publicId, png),
        thumb: projectAssetUrl(p.publicId, thumb),
      };
      if (presign) {
        assets.pngPresigned = await safePresign(`${p.dataUrl}/${png}`);
        assets.thumbPresigned = await safePresign(`${p.dataUrl}/${thumb}`);
      }
      const line: Record<string, unknown> = {
        t: "page",
        projectPublicId: p.publicId,
        pageNumber: pg.pageNumber,
        name: pg.name,
        drawingNumber: pg.drawingNumber,
        rawText: pg.rawText,
        csiCodes: pg.csiCodes,
        keynotes: pg.keynotes,
        textAnnotations: pg.textAnnotations,
      };
      if (options.textract) line.textractData = pg.textractData;
      if (options.intelligence) line.pageIntelligence = pg.pageIntelligence;
      line.error = pg.error;
      line.duplicateOf = duplicateOf;
      line.assets = assets;
      tally.counts.page++;
      yield line;
    }
  }
}

async function* annotationLines(
  p: ScopedProject,
  tally: Tally,
  hiddenPages: Set<number>,
  skippedAnnotationIds: Set<number>,
): AsyncGenerator<unknown> {
  let lastId = 0;
  for (;;) {
    const batch = await db
      .select({
        id: annotations.id,
        pageNumber: annotations.pageNumber,
        name: annotations.name,
        minX: annotations.minX,
        minY: annotations.minY,
        maxX: annotations.maxX,
        maxY: annotations.maxY,
        threshold: annotations.threshold,
        source: annotations.source,
        data: annotations.data,
        note: annotations.note,
        creatorPublicId: users.publicId,
        createdAt: annotations.createdAt,
        updatedAt: annotations.updatedAt,
      })
      .from(annotations)
      .leftJoin(users, eq(users.id, annotations.creatorId))
      .where(and(eq(annotations.projectId, p.id), gt(annotations.id, lastId)))
      .orderBy(asc(annotations.id))
      .limit(ANNOTATION_BATCH);
    if (batch.length === 0) return;
    lastId = batch[batch.length - 1].id;

    for (const a of batch) {
      if (hiddenPages.has(a.pageNumber)) {
        skippedAnnotationIds.add(a.id);
        tally.skipped.annotations++;
        continue;
      }
      tally.counts.annotation++;
      yield {
        t: "annotation",
        id: a.id,
        projectPublicId: p.publicId,
        pageNumber: a.pageNumber,
        name: a.name,
        bbox: [a.minX, a.minY, a.maxX, a.maxY],
        threshold: a.threshold,
        source: a.source,
        origin: annotationOrigin(a.source),
        shapeKind: classifyAnnotationData(a.data),
        data: a.data,
        note: a.note,
        creatorPublicId: a.creatorPublicId ?? null,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      };
    }
  }
}

/** The row minus its internal projectId, with the project's publicId in front. */
function projectChild(t: string, projectPublicId: string, row: { projectId: number }) {
  const out: Record<string, unknown> = { t, projectPublicId };
  for (const [k, v] of Object.entries(row)) if (k !== "projectId") out[k] = v;
  return out;
}

async function* takeoffLines(p: ScopedProject, tally: Tally): AsyncGenerator<unknown> {
  for (let lastId = 0; ; ) {
    const batch = await db
      .select()
      .from(takeoffGroups)
      .where(and(eq(takeoffGroups.projectId, p.id), gt(takeoffGroups.id, lastId)))
      .orderBy(asc(takeoffGroups.id))
      .limit(SMALL_BATCH);
    if (batch.length === 0) break;
    lastId = batch[batch.length - 1].id;
    for (const g of batch) {
      tally.counts.takeoffGroup++;
      yield projectChild("takeoffGroup", p.publicId, g);
    }
  }
  for (let lastId = 0; ; ) {
    const batch = await db
      .select()
      .from(takeoffItems)
      .where(and(eq(takeoffItems.projectId, p.id), gt(takeoffItems.id, lastId)))
      .orderBy(asc(takeoffItems.id))
      .limit(SMALL_BATCH);
    if (batch.length === 0) break;
    lastId = batch[batch.length - 1].id;
    for (const item of batch) {
      tally.counts.takeoffItem++;
      yield projectChild("takeoffItem", p.publicId, item);
    }
  }
  for (let lastId = 0; ; ) {
    const batch = await db
      .select()
      .from(qtoWorkflows)
      .where(and(eq(qtoWorkflows.projectId, p.id), gt(qtoWorkflows.id, lastId)))
      .orderBy(asc(qtoWorkflows.id))
      .limit(SMALL_BATCH);
    if (batch.length === 0) break;
    lastId = batch[batch.length - 1].id;
    for (const w of batch) {
      tally.counts.qtoWorkflow++;
      yield projectChild("qtoWorkflow", p.publicId, w);
    }
  }
}

async function* annotationGroupLines(
  p: ScopedProject,
  tally: Tally,
  skippedAnnotationIds: Set<number>,
): AsyncGenerator<unknown> {
  for (let lastId = 0; ; ) {
    const batch = await db
      .select({
        id: annotationGroups.id,
        name: annotationGroups.name,
        csiCode: annotationGroups.csiCode,
        notes: annotationGroups.notes,
        color: annotationGroups.color,
        isActive: annotationGroups.isActive,
        creatorPublicId: users.publicId,
        createdAt: annotationGroups.createdAt,
        updatedAt: annotationGroups.updatedAt,
      })
      .from(annotationGroups)
      .leftJoin(users, eq(users.id, annotationGroups.createdBy))
      .where(and(eq(annotationGroups.projectId, p.id), gt(annotationGroups.id, lastId)))
      .orderBy(asc(annotationGroups.id))
      .limit(SMALL_BATCH);
    if (batch.length === 0) return;
    lastId = batch[batch.length - 1].id;

    const members = await db
      .select({
        groupId: annotationGroupMembers.groupId,
        annotationId: annotationGroupMembers.annotationId,
      })
      .from(annotationGroupMembers)
      .where(
        inArray(
          annotationGroupMembers.groupId,
          batch.map((g) => g.id),
        ),
      )
      .orderBy(asc(annotationGroupMembers.groupId), asc(annotationGroupMembers.annotationId));
    const byGroup = new Map<number, number[]>();
    for (const m of members) {
      if (skippedAnnotationIds.has(m.annotationId)) {
        tally.skipped.groupMembers++;
        continue;
      }
      const list = byGroup.get(m.groupId) ?? [];
      list.push(m.annotationId);
      byGroup.set(m.groupId, list);
    }
    for (const g of batch) {
      tally.counts.annotationGroup++;
      yield {
        t: "annotationGroup",
        projectPublicId: p.publicId,
        ...g,
        creatorPublicId: g.creatorPublicId ?? null,
        memberAnnotationIds: byGroup.get(g.id) ?? [],
      };
    }
  }
}

async function* projectLines(
  p: ScopedProject,
  plan: ExportPlan,
  tally: Tally,
): AsyncGenerator<unknown> {
  // Re-read at stream time: the project may have been deleted or started a job since the
  // request resolved. A project under ANY active mutation lease is skipped, not half-exported.
  const [current] = await db
    .select({
      status: projects.status,
      projectIntelligence: plan.options.intelligence ? projects.projectIntelligence : sql<null>`null`,
      projectSummary: projects.projectSummary,
      stagingManifest: projects.stagingManifest,
    })
    .from(projects)
    .where(eq(projects.id, p.id))
    .limit(1);
  if (!current) {
    tally.skipped.projects++;
    tally.counts.error++;
    yield { t: "error", projectPublicId: p.publicId, code: "GONE", message: "Project no longer exists; skipped" };
    return;
  }
  const [lease] = await db
    .select({ kind: projectMutationLeases.kind })
    .from(projectMutationLeases)
    .where(
      and(eq(projectMutationLeases.projectId, p.id), eq(projectMutationLeases.status, "active")),
    )
    .limit(1);
  if (lease) {
    tally.skipped.projects++;
    tally.counts.error++;
    yield {
      t: "error",
      projectPublicId: p.publicId,
      code: "BUSY",
      message: "Project has an active job; skipped",
    };
    return;
  }

  // Presigned links only for completed, unleased projects on a canonical storage path — the
  // same preconditions the asset gateway enforces before it serves a byte.
  const presign =
    plan.options.presign &&
    current.status === "completed" &&
    isCanonicalProjectPath(p.companyDataKey, p.dataUrl);

  const assets: Record<string, string | null> = {
    pdf: projectAssetUrl(p.publicId, "original.pdf"),
  };
  if (presign) assets.pdfPresigned = await safePresign(`${p.dataUrl}/original.pdf`);

  const projectLine: Record<string, unknown> = {
    t: "project",
    publicId: p.publicId,
    name: p.name,
    companyPublicId: p.companyPublicId,
    numPages: p.numPages,
    status: current.status,
    isDemo: p.isDemo,
    createdAt: p.createdAt,
    stagingFiles: (current.stagingManifest ?? []).map((f) => f.filename),
  };
  if (plan.options.intelligence) projectLine.projectIntelligence = current.projectIntelligence;
  projectLine.projectSummary = current.projectSummary;
  projectLine.assets = assets;
  tally.counts.project++;
  yield projectLine;

  const hiddenPages = new Set<number>();
  const skippedAnnotationIds = new Set<number>();
  yield* pageLines(p, plan, tally, hiddenPages, presign);
  yield* annotationLines(p, tally, hiddenPages, skippedAnnotationIds);
  yield* takeoffLines(p, tally);
  yield* annotationGroupLines(p, tally, skippedAnnotationIds);
}

async function* datasetLines(plan: ExportPlan, startedAt: number): AsyncGenerator<unknown> {
  const tally: Tally = {
    counts: {
      model: 0,
      project: 0,
      page: 0,
      annotation: 0,
      takeoffGroup: 0,
      takeoffItem: 0,
      qtoWorkflow: 0,
      annotationGroup: 0,
      error: 0,
    },
    skipped: { pages: 0, annotations: 0, groupMembers: 0, projects: 0 },
  };
  yield {
    t: "header",
    schemaVersion: DATASET_SCHEMA_VERSION,
    exportedAt: new Date(startedAt).toISOString(),
    scope: {
      companyPublicId: plan.companyPublicId,
      allCompanies: plan.companyPublicId === null,
      projectCount: plan.projects.length,
    },
    options: plan.options,
    exporterPublicId: plan.exporterPublicId,
    note: "origin is a label, not proof; the file is not a point-in-time snapshot",
  };
  yield* modelLines(plan, tally);
  for (const p of plan.projects) {
    try {
      yield* projectLines(p, plan, tally);
    } catch (err) {
      // No client text in logs: the error class only, never its message.
      logger.warn("admin data export: project failed", {
        tag: "admin-data-export",
        projectId: p.id,
        errName: err instanceof Error ? err.name : typeof err,
      });
      tally.skipped.projects++;
      tally.counts.error++;
      yield {
        t: "error",
        projectPublicId: p.publicId,
        code: "PROJECT_FAILED",
        message: "Project export failed part-way; its lines above are incomplete",
      };
    }
  }
  yield {
    t: "footer",
    counts: tally.counts,
    skipped: tally.skipped,
    durationMs: Date.now() - startedAt,
  };
}

// ── entry point ────────────────────────────────────────────────────────────────────────────────

export async function exportAdminDataset(
  req: Request,
  session: AuthSession,
  query: DataExportQuery,
): Promise<Response> {
  const plan = await resolvePlan(session, query);

  const release = tryAcquireExportSlot(session.user.isRootAdmin === true ? "root" : "company");
  if (!release) {
    throw new ApiError("RATE_LIMITED", "Another data export is already running; try again later");
  }
  try {
    const startedAt = Date.now();
    audit("admin.data_export", {
      userId: session.user.dbId,
      companyId: session.user.companyId,
      details: {
        scope: plan.companyPublicId ?? "all-companies",
        projects: plan.projects.length,
        options: plan.options,
      },
    });
    const body = ndjsonGzipStream(() => datasetLines(plan, startedAt), {
      onDone: release,
      signal: req.signal,
      deadlineLine: () => ({
        t: "error",
        code: "DEADLINE",
        message: "Export stopped at its time limit; the file is incomplete (no footer)",
      }),
    });
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson",
        "Content-Disposition": `attachment; filename="${datasetFilename(plan.scopeLabel, new Date(startedAt))}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    release();
    throw err;
  }
}
