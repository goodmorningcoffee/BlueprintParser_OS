// [refactor jun17 P1.3] PROJECTS service — P1.3 core family 4/7.
//
// The two CORE projects route files (projects[/route] = POST create + GET list, [id] = GET/PUT/DELETE)
// are now thin `defineRoute` shells; ALL behavior lives here. The six leaf sub-routes
// (projects/[id]/{pages,export,thumbnail/[page],map-tags-batch} + projects/export-index)
// are NOT in this family's scope (plan §P1.3 enumerates only `projects(+[id])`; classify-regions was DELETED in P4.4 as a P5-flagged
// dead-code candidate) — they stay on the legacy pattern until a later P1.5 chunk.
//
// Behavior is preserved EXACTLY against the characterization tests: the EXISTING
// projects-id.route.test.ts (GET/PUT/DELETE) gains a non-uuid→400 case + envelope-code assertions; a NEW
// projects.route.test.ts freezes POST create + GET list (no P0.3 char file existed for the collection).
// Sanctioned diffs ONLY (the family-1/2/3 recipe):
//   (a) the error envelope flips {error:string} → {error:{code,message}} (the shell does this);
//   (b) a non-uuid [id] param that legacy fed to the pg uuid column (→ unhandled 500) becomes a clean 400
//       via zPublicId in loadProjectWithRootBypass (POST has no publicId param — n/a there);
//   (c) the legacy per-handler unhandled throws + DELETE's `catch{apiError(err.message,500)}` leak block are
//       DROPPED — any unexpected error propagates to the shell's outer catch (logs server-side, generic
//       leak-free INTERNAL 500). The SFN try/catch inside create is NOT a leak block — it ABSORBS the error
//       and still returns 200; it survives verbatim.
//   (d) a malformed/empty JSON body that legacy let `req.json()` throw on (→ 500) now gets a shell 400.
//       Corner: a malformed POST body + signed-out caller now 400s (shell body-parse precedes auth) where
//       legacy 401'd — a subset of (d), accepted.
//   (e) [refactor jul11 P2.2⑨] yoloTags-only PUTs now validate the top-level array and reject
//       demo projects for every owner/root. This closes the server half of the existing client
//       demo-never-writes invariant; name/address/classCsiOverrides policy is unchanged.
//
// Recipe shape (S008 §B / S009 / S010 / S011 precedent):
//   • [id] GET/PUT/DELETE use `auth:"session"` + a MANUAL full-row lookup (loadProjectWithRootBypass) —
//     NOT declarative auth:{project:{param}} and NOT resolveProjectOrThrow. Two reasons: (1) the lightweight
//     ProjectAccessRow omits projectIntelligence/address/jobId that GET/PUT/DELETE read, so declarative
//     would force a 2nd full-row query; (2) projects/[id] DOES allow root cross-company bypass
//     (isRootAdmin ? eq(publicId) : and(publicId,companyId)) — this is the MIRROR of qto-GET, which used a
//     manual lookup to DENY root bypass. The shell's auth:"session" 401s signed-out callers BEFORE the
//     lookup, preserving 401-before-404.
//   • POST create + GET list use `auth:"session"` (legacy was auth-FIRST: requireAuth before req.json),
//     UNLIKE the validate-before-auth create POSTs of families 1-3. zLooseBody lets the handler receive the
//     parsed body and run its own imperative field validation (preserving the exact legacy messages), with
//     every field 400/404/429/413 firing AFTER the shell's 401.
//
// Frozen quirks deliberately kept (do NOT "fix" them) — see each function.
// `allowDemo`: GET [id] and the collection GET/POST pass NONE (auth:"session"), so a non-owner signed-in
// user gets 404 on a demo project. PUT/DELETE DO pass allowDemo:true — see updateProject's gate note.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  projects,
  pages,
  processingJobs,
  projectAssetDeletions,
  companies,
  chatMessages,
  takeoffItems,
  takeoffGroups,
} from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { processProject } from "@/lib/processing";
import { headS3Object } from "@/lib/s3";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { processingStartInput } from "@/server/services/processing-start-input";
import { checkUploadQuota } from "@/lib/quotas";
import { deleteProjectFully } from "@/lib/project-delete";
import { visiblePageCount, visiblePageCountsByProject } from "@/server/services/project-page-counts";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { ApiError, notFound } from "@/server/api/envelope";
import {
  isCanonicalProjectPath,
  projectUploadStagingKey,
} from "@/lib/project-upload-authority";
import {
  assertProjectWritable,
  type ProjectWriteCapability,
} from "@/server/api/access";
import {
  withProjectMutationLease,
  lockProjectStorageRoot,
  withProjectWrite,
} from "@/server/api/project-write-capability";
import { zPublicId } from "@/server/api/schemas";
import type { AuthSession, ProjectAccessRow } from "@/lib/api-utils";
import type { StagingFile } from "@/types";
import {
  projectAssetBaseUrl,
  projectAssetUrl,
} from "@/server/services/project-assets";

// Verbatim from legacy projects/route.ts:13-14.
const PROJECT_AGGREGATE_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const PROJECT_MAX_FILES = 30;

/**
 * Shared [id] prologue: parse the publicId (non-uuid → clean 400 — sanctioned diff b), then look up the
 * FULL project row with the legacy root-bypass WHERE. A full `db.select()` (not resolveProjectOrThrow) is
 * required because the lightweight ProjectAccessRow omits projectIntelligence/address/jobId that the three
 * [id] handlers read. Root admins reach ANY company's project (frozen); a non-root cross-company caller
 * gets 404 (no existence leak, never 403). Signed-out callers never reach here — the shell's auth:"session"
 * 401s first. Returns the full row or throws notFound().
 */
async function loadProjectWithRootBypass(
  idParam: string,
  session: AuthSession,
) {
  const parsed = zPublicId.safeParse(idParam);
  if (!parsed.success) throw new ApiError("VALIDATION", "Invalid project id");

  const [project] = await db
    .select()
    .from(projects)
    .where(
      session.user.isRootAdmin
        ? eq(projects.publicId, parsed.data)
        : and(
            eq(projects.publicId, parsed.data),
            eq(projects.companyId, session.user.companyId),
          ),
    )
    .limit(1);

  if (!project) throw notFound();
  return project;
}

// ── GET /api/projects/[id] ─────────────────────────────────────────────────────────
//
/**
 * Viewer-bootstrap payload. Returns a NextResponse (not a plain object) so the Cache-Control header
 * survives — the shell passes any Response straight through (defineRoute returns `result` when it is a
 * Response, before the kind gate). Frozen quirks: `.catch(()=>[])` swallowers on takeoffItems +
 * takeoffGroups ONLY (pages + chatMessages have none — asymmetry preserved); both `summaries` (pi.summaries)
 * and the full `projectIntelligence` exposed as separate `|| null` keys; `dbId` (numeric) exposed alongside
 * `id` (publicId); Cache-Control `private, no-store`.
 */
export async function getProject(
  idParam: string,
  session: AuthSession,
): Promise<Response> {
  const project = await loadProjectWithRootBypass(idParam, session);

  // Fetch page list, takeoff items, takeoff groups, and chat history in parallel (all independent, need
  // only project.id). The takeoff `.catch(()=>[])` swallowers are FROZEN legacy behavior.
  const [
    projectPages,
    projectTakeoffItems,
    projectTakeoffGroups,
    projectChats,
  ] = await Promise.all([
    db
      .select({
        pageNumber: pages.pageNumber,
        name: pages.name,
        drawingNumber: pages.drawingNumber,
      })
      .from(pages)
      .where(eq(pages.projectId, project.id))
      .orderBy(pages.pageNumber),
    db
      .select()
      .from(takeoffItems)
      .where(eq(takeoffItems.projectId, project.id))
      .orderBy(takeoffItems.sortOrder)
      .catch(() => [] as any[]),
    db
      .select()
      .from(takeoffGroups)
      .where(eq(takeoffGroups.projectId, project.id))
      .orderBy(takeoffGroups.sortOrder)
      .catch(() => [] as any[]),
    db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.projectId, project.id))
      .orderBy(chatMessages.createdAt),
  ]);

  const assetBaseUrl = projectAssetBaseUrl(project.publicId);
  const pdfUrl = projectAssetUrl(project.publicId, "original.pdf");

  // Extract summaries + graph from projectIntelligence (computed during processing)
  const pi = project.projectIntelligence as Record<string, unknown> | null;
  const summaries = (pi?.summaries as Record<string, unknown>) || null;
  const projectIntelligence = pi || null;

  const response = NextResponse.json({
    id: project.publicId,
    dbId: project.id,
    name: project.name,
    assetBaseUrl,
    pdfUrl,
    numPages: project.numPages,
    status: project.status,
    address: project.address,
    summaries,
    projectIntelligence,
    pages: projectPages.map((p) => ({
      pageNumber: p.pageNumber,
      name: p.name,
      drawingNumber: p.drawingNumber,
    })),
    takeoffItems: projectTakeoffItems.map((t) => ({
      id: t.id,
      name: t.name,
      shape: t.shape,
      color: t.color,
      size: t.size,
      notes: t.notes,
      sortOrder: t.sortOrder,
      groupId: t.groupId,
    })),
    takeoffGroups: projectTakeoffGroups.map((g) => ({
      id: g.id,
      name: g.name,
      kind: g.kind,
      color: g.color,
      csiCode: g.csiCode,
      sortOrder: g.sortOrder,
    })),
    chatMessages: projectChats.map((c) => ({
      id: c.id,
      role: c.role,
      content: c.content,
      model: c.model,
    })),
  });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

// ── GET /api/demo/projects/[id] ─────────────────────────────────────────────────────
//
/**
 * PUBLIC demo project-by-id bootstrap. [refactor jun18 P1.4 demo fold] folded from the demo mirror route
 * (app/api/demo/projects/[id]/route.ts), which is now a thin `defineRoute({auth:"none"})` shell.
 *
 * DELIBERATELY ISOLATED from getProject above — the two share NOTHING and must NOT be coupled by a future
 * reader. getDemoProject has NO session, NO companyId scope, NO root-bypass; its SOLE gate is
 * `WHERE isDemo = true` (a public read — every caller, signed-out / owner / cross-company, gets the same
 * 200). loadProjectWithRootBypass must NOT be reused (it requires a session for companyId scoping and has
 * no isDemo path). To keep the paths from drifting together: this returns ONLY the 11 demo fields — it must
 * NEVER add getProject's authed-only `address`/`takeoffItems`/`takeoffGroups`/`chatMessages`, and must NEVER
 * drop the demo-only `demoConfig`. Cache-Control is `public, no-store` (added by the P2 authority pass;
 * the legacy demo route set none) — getProject sets `private, no-store`. Both are pinned by route tests.
 *
 * Returns a NextResponse — originally only for byte-identical passthrough faithfulness to the legacy body
 * (the shell forwards any Response before its kind gate, in defineRoute's routeHandler), since a plain
 * object envelopes identically. It is now load-bearing: only a Response can carry the Cache-Control above.
 *
 * Sanctioned diffs (the P1.3/P1.4 family recipe): (a) the 404 envelope flips {error:"Not found"} →
 * {error:{code,message}} (the shell does it — the thrown notFound() is a NOT_FOUND ApiError); (b) a non-uuid
 * id that legacy fed straight to the pg uuid column (no try/catch → unhandled throw) becomes a clean 400
 * "Invalid project id" via zPublicId; (c) the legacy route had no try/catch on the main SELECT, so an
 * unexpected DB error (raw 500) now routes to the shell's leak-free INTERNAL 500. The demoConfig try/catch
 * below is NOT a leak block — it is a deliberate silent {} fallback — so it survives VERBATIM.
 *
 * Frozen quirks: demoConfig defaults to {} on a missing company / absent pipelineConfig.demo (and swallows
 * ANY error from that lookup); `summaries` (pi.summaries) and the full `projectIntelligence` are separate
 * `|| null` keys; the page list is lightweight {pageNumber,name,drawingNumber} ORDER BY pageNumber. The two
 * follow-up reads stay SEQUENTIAL (page list, then the company lookup) — NOT parallelized (a non-sanctioned
 * perf change; legacy ran them in order).
 */
export async function getDemoProject(idParam: string): Promise<Response> {
  // sanctioned diff (b) — clean 400 instead of the legacy pg-uuid-cast throw.
  const parsed = zPublicId.safeParse(idParam);
  if (!parsed.success) throw new ApiError("VALIDATION", "Invalid project id");

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.publicId, parsed.data), eq(projects.isDemo, true)))
    .limit(1);

  // sanctioned diff (a) — the shell flips this NOT_FOUND ApiError to {error:{code,message}}
  // (legacy returned {error:"Not found"} at 404).
  if (!project) throw notFound();

  // Lightweight page list (detail data comes via /pages?from=N&to=M). ORDER BY pageNumber.
  const projectPages = await db
    .select({
      pageNumber: pages.pageNumber,
      name: pages.name,
      drawingNumber: pages.drawingNumber,
    })
    .from(pages)
    .where(eq(pages.projectId, project.id))
    .orderBy(pages.pageNumber);

  const assetBaseUrl = projectAssetBaseUrl(project.publicId);
  const pdfUrl = projectAssetUrl(project.publicId, "original.pdf");

  const pi = project.projectIntelligence as Record<string, unknown> | null;
  const summaries = (pi?.summaries as Record<string, unknown>) || null;

  // Company demo feature config. FROZEN: a deliberate silent-swallow {} fallback (NOT a leak block — it
  // exposes no message) — kept verbatim so a missing company / DB blip yields demoConfig:{} rather than 500.
  let demoConfig: Record<string, boolean> = {};
  try {
    const [company] = await db
      .select({ pipelineConfig: companies.pipelineConfig })
      .from(companies)
      .where(eq(companies.id, project.companyId))
      .limit(1);
    demoConfig =
      (company?.pipelineConfig?.demo as Record<string, boolean>) || {};
  } catch {
    /* ignore */
  }

  const response = NextResponse.json({
    id: project.publicId,
    dbId: project.id,
    name: project.name,
    assetBaseUrl,
    pdfUrl,
    numPages: project.numPages,
    status: project.status,
    summaries,
    projectIntelligence: pi || null,
    demoConfig,
    pages: projectPages.map((p) => ({
      pageNumber: p.pageNumber,
      name: p.name,
      drawingNumber: p.drawingNumber,
    })),
  });
  response.headers.set("Cache-Control", "public, no-store");
  return response;
}

// ── GET /api/demo/projects ─────────────────────────────────────────────────────────
//
/**
 * List the public demo gallery — every isDemo=true project, oldest-first. The WIRE BODY is a BARE ARRAY of
 * EXACTLY 5 public fields per item {id, name, numPages, status, thumbnailUrl}, in a Cache-Control-bearing NextResponse.
 *
 * DELIBERATELY ISOLATED from listProjects (the authed company/root list) — exactly as getDemoProject is from
 * getProject: NO session param, NO companyId scope, NO root-bypass; the SOLE gate is WHERE isDemo=true (a
 * public read). It must NEVER acquire a session param and must NEVER add listProjects's authed-only fields
 * (companyId/companyName/pagesProcessed/dataUrl/isDemo/createdAt) onto this UNAUTHENTICATED endpoint — that
 * would be a data-exposure regression (pinned NEGATIVELY in demo-projects.route.test.ts as exactly 5 keys).
 *
 * Frozen quirks (do NOT "fix"): the per-project page count uses an N+1 loop (one COUNT(*) per project), NOT
 * listProjects's single GROUP BY — a known inefficiency kept VERBATIM (replacing it is a non-sanctioned perf
 * change). `numPages` falsy-coalesces live-count → numPages column → 0; `thumbnailUrl` is non-null ONLY when
 * status==="completed". NO try/catch (legacy had none) — an unexpected DB error becomes the shell's leak-free
 * INTERNAL 500, which is the SOLE sanctioned diff vs the legacy raw 500.
 */
export async function listDemoProjects() {
  const demoProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.isDemo, true))
    .orderBy(projects.createdAt);

  // Actual VISIBLE page counts — N+1 loop, FROZEN (do NOT collapse to listProjects's GROUP BY).
  // [2026-10-23] hidden duplicates excluded; the query lives in project-page-counts.ts (ceiling).
  const pageCounts: Record<number, number> = {};
  for (const proj of demoProjects) {
    pageCounts[proj.id] = await visiblePageCount(proj.id);
  }

  const payload = demoProjects.map((p) => ({
    id: p.publicId,
    name: p.name,
    numPages: pageCounts[p.id] || p.numPages || 0,
    status: p.status,
    thumbnailUrl:
      p.status === "completed" ? projectAssetUrl(p.publicId, "thumbnail.png") : null,
  }));
  const response = NextResponse.json(payload);
  response.headers.set("Cache-Control", "public, no-store");
  return response;
}

// ── PUT /api/projects/[id] ─────────────────────────────────────────────────────────
//
/**
 * Partial update of name/address + a MERGE into projectIntelligence (classCsiOverrides/yoloTags overlaid,
 * all other PI keys preserved). The single loadProjectWithRootBypass fetch IS the PI read (no re-read).
 * Frozen quirks: NO name/address field validation; `updatedAt` set UNCONDITIONALLY; UPDATE WHERE by numeric
 * PK (eq(projects.id, project.id)) despite the lookup-by-publicId. No try/catch (legacy had none — an
 * unexpected throw becomes the shell's generic INTERNAL 500).
 */
export async function updateProject(
  idParam: string,
  body: Record<string, unknown>,
  session: AuthSession | null,
  accessProject: ProjectAccessRow,
): Promise<{ success: true }> {
  // The route resolves with allowDemo:true so every caller role reaches this single policy gate.
  // Private projects cannot reach the handler without a scoped session.
  const writeCapability = assertProjectWritable(accessProject);
  if (!session) throw new ApiError("UNAUTHORIZED", "Unauthorized");
  const project = await loadProjectWithRootBypass(idParam, session);

  if (body.yoloTags !== undefined && !Array.isArray(body.yoloTags)) {
    throw new ApiError("VALIDATION", "yoloTags must be an array");
  }

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.address !== undefined) updates.address = body.address;

  // Merge into projectIntelligence (preserving existing data)
  if (body.classCsiOverrides !== undefined || body.yoloTags !== undefined) {
    const existingPi =
      (project.projectIntelligence as Record<string, unknown>) || {};
    const merged = { ...existingPi };
    if (body.classCsiOverrides !== undefined)
      merged.classCsiOverrides = body.classCsiOverrides;
    if (body.yoloTags !== undefined) merged.yoloTags = body.yoloTags;
    updates.projectIntelligence = merged;
  }

  updates.updatedAt = new Date();

  await withProjectWrite(writeCapability, project.id, async (tx) => {
    await tx.update(projects).set(updates).where(eq(projects.id, project.id));
  });

  return { success: true };
}

// ── DELETE /api/projects/[id] ──────────────────────────────────────────────────────
//
/**
 * Delete a project end-to-end via the P0-G4 transactional deleteProjectFully (DB rows in ONE tx, S3 purge
 * after commit). deleteProjectFully is the single source of truth and is NOT touched here. Frozen: audit()
 * is un-awaited, runs only on the success path AFTER the delete, with `details.projectId = idParam` (the
 * publicId STRING, not the numeric id). The legacy `catch{ apiError(err.message,500) }` leak block is
 * DROPPED (sanctioned diff c) — a throw from deleteProjectFully propagates to the shell's leak-free 500.
 */
export async function deleteProject(
  idParam: string,
  session: AuthSession | null,
  accessProject: ProjectAccessRow,
): Promise<{ success: true }> {
  const writeCapability = assertProjectWritable(accessProject);
  if (!session) throw new ApiError("UNAUTHORIZED", "Unauthorized");
  const project = await loadProjectWithRootBypass(idParam, session);

  await deleteProjectFully(
    {
      id: project.id,
      dataUrl: project.dataUrl,
      jobId: project.jobId,
      name: project.name,
    },
    writeCapability,
  );

  audit("project_deleted", {
    userId: session.user.dbId,
    companyId: session.user.companyId,
    details: { projectId: idParam, projectName: project.name },
  });

  return { success: true };
}

// ── POST /api/projects ─────────────────────────────────────────────────────────────
//
/**
 * Create a project: validate the staging manifest, enforce the company-prefix dataUrl tenancy guard + the
 * upload quota, insert the row, then trigger processing (SFN in prod / processProject fire-and-forget in
 * dev). Order is auth-FIRST (the shell 401s before this handler runs), then field validation. Frozen quirks:
 *   • checkUploadQuota(companyId, role, isRootAdmin, dbId) — root EXEMPT + per-user overrides (owner ruling 2026-10-21).
 *   • stagingFiles must be the exact isolated keys issued for this project path; the legacy
 *     staging-less/direct-final path is disabled because its reusable signer crossed publication.
 *   • the "Staged file missing" error interpolates the human `filename`, not the stagingKey.
 *   • the aggregate-cap message computes MB as bytes/(1024*1024) = 2048 → "Project exceeds 2048 MB cap"; 413.
 *   • the dataUrl-prefix message is verbatim (em-dash + the trailing-slash predicate are load-bearing — this
 *     is the cross-tenant-deletion guard).
 *   • the verified staging manifest is persisted before processing begins.
 *   • the SFN try/catch ABSORBS failures (sets the DB row to status:"error", logs, does NOT re-throw → still
 *     200); it is NOT a leak block and survives verbatim.
 *   • response `id` = publicId (uuid string, not numeric); `status` = the in-memory `.returning()` row value
 *     = "uploading" EVEN AFTER the SFN runs — the SFN catch mutates the DB row, not the in-memory object.
 */
export async function createProject(
  body: Record<string, unknown>,
  session: AuthSession,
): Promise<{ id: string; name: string; status: string }> {
  const { name, dataUrl, stagingFiles } = body as {
    name?: unknown;
    dataUrl?: unknown;
    stagingFiles?: unknown;
  };

  if (!name || !dataUrl) {
    throw new ApiError("VALIDATION", "Name and dataUrl required");
  }

  // SECURITY: accept only the canonical, non-nesting project root format minted by
  // generateProjectPath(). A mere company-prefix check lets a private project alias
  // `${publishedDemo.dataUrl}/pages` and later erase that public demo subtree on delete.
  // companyId comes from the SESSION, never the body.
  const [callerCompany] = await db
    .select({ dataKey: companies.dataKey })
    .from(companies)
    .where(eq(companies.id, session.user.companyId))
    .limit(1);
  if (!callerCompany) {
    throw new ApiError("NOT_FOUND", "Company not found");
  }
  if (
    typeof dataUrl !== "string" ||
    !isCanonicalProjectPath(callerCompany.dataKey, dataUrl)
  ) {
    throw new ApiError(
      "VALIDATION",
      "Invalid dataUrl — must be inside your company prefix (use /api/s3/staging-credentials to obtain one)",
    );
  }

  // Upload quota: root admins exempt, per-user/company overrides apply (owner ruling 2026-10-21).
  const quota = await checkUploadQuota(
    session.user.companyId,
    session.user.role, session.user.isRootAdmin, session.user.dbId,
  );
  if (!quota.allowed) {
    throw new ApiError(
      "RATE_LIMITED",
      quota.message ?? "Daily upload limit reached",
    );
  }

  // Direct-final upload credentials are disabled. Requiring the exact isolated staging manifest
  // also prevents a credential minted before that change from creating a new mutable-final project.
  if (!Array.isArray(stagingFiles) || stagingFiles.length === 0) {
    throw new ApiError("VALIDATION", "stagingFiles must be a non-empty array");
  }
  if (stagingFiles.length > PROJECT_MAX_FILES) {
    throw new ApiError(
      "VALIDATION",
      `Maximum ${PROJECT_MAX_FILES} files per project`,
    );
  }
  for (const [index, sf] of (
    stagingFiles as Array<{
      filename?: unknown;
      stagingKey?: unknown;
    }>
  ).entries()) {
    if (
      !sf ||
      typeof sf.filename !== "string" ||
      sf.filename.length === 0 ||
      sf.filename.length > 255 ||
      typeof sf.stagingKey !== "string" ||
      sf.stagingKey !== projectUploadStagingKey(dataUrl, sf.filename, index)
    ) {
      throw new ApiError(
        "VALIDATION",
        "Each stagingFile needs its exact issued stagingKey",
      );
    }
  }

  // Confirm every staged upload landed + collect sizes. Parallel HeadObject keeps the common case fast
  // (~one AWS RTT per file, overlapped).
  const heads = await Promise.all(
    (stagingFiles as Array<{ filename: string; stagingKey: string }>).map(
      async (sf) => {
        const head = await headS3Object(sf.stagingKey);
        return { ...sf, head };
      },
    ),
  );
  for (const h of heads) {
    if (!h.head.exists) {
      throw new ApiError(
        "VALIDATION",
        `Staged file missing in S3: ${h.filename}`,
      );
    }
    if (!h.head.versionId || h.head.versionId === "null") {
      throw new ApiError(
        "CONFLICT",
        `Staged file is not version-pinned: ${h.filename}`,
      );
    }
  }

  const totalBytes = heads.reduce((sum, h) => sum + (h.head.size ?? 0), 0);
  if (totalBytes > PROJECT_AGGREGATE_MAX_BYTES) {
    throw new ApiError(
      "VALIDATION",
      `Project exceeds ${PROJECT_AGGREGATE_MAX_BYTES / (1024 * 1024)} MB cap (got ${Math.round(
        totalBytes / (1024 * 1024),
      )} MB)`,
      413,
    );
  }

  const stagingManifest: StagingFile[] = heads.map((h) => ({
    filename: h.filename,
    stagingKey: h.stagingKey,
    size: h.head.size ?? 0,
    versionId: h.head.versionId!,
  }));

  const project = await db.transaction(async (tx) => {
    // Serialize root creation against deletion before consulting the permanent tombstone. Without
    // this lock, an INSERT could snapshot "no tombstone", wait on the projects.data_url unique row
    // that a concurrent delete removes, and then reuse a retired public asset path.
    await lockProjectStorageRoot(tx, dataUrl);
    const [retiredRoot] = await tx
      .select({ id: projectAssetDeletions.id })
      .from(projectAssetDeletions)
      .where(eq(projectAssetDeletions.storageRoot, dataUrl))
      .limit(1);
    if (retiredRoot) {
      throw new ApiError("CONFLICT", "Project storage root has been retired");
    }

    const [inserted] = await tx
      .insert(projects)
      .values({
        name: name as string,
        dataUrl,
        status: "uploading",
        authorId: session.user.dbId,
        companyId: session.user.companyId,
        stagingManifest,
      })
      .returning();
    if (!inserted) throw new Error("Failed to create project");
    return inserted;
  });

  // INSERT defaults isDemo=false; mint the same capability required by every internal
  // project-processing mutation sink before handing work to either execution mode.
  const writeCapability: ProjectWriteCapability =
    assertProjectWritable(project);

  // Trigger processing pipeline. The SFN try/catch ABSORBS failures (still returns 200); it is NOT a leak
  // block and is reproduced verbatim from the legacy route.
  if (process.env.STEP_FUNCTION_ARN) {
    // Production: start Step Functions execution (ECS task processes in background)
    try {
      const executionName = `proj-${project.id}-${Date.now()}`;
      const expectedExecutionArn = `${process.env.STEP_FUNCTION_ARN.replace(":stateMachine:", ":execution:")}:${executionName}`;
      await withProjectMutationLease(
        writeCapability,
        { kind: "processing-start", idempotencyKey: executionName },
        async () => {
          // Persist a provider-addressable running intent before StartExecution. An SDK timeout can
          // follow AWS acceptance; in that ambiguous state the row must remain a publication/delete
          // blocker until the worker webhook or provider-aware reconciliation confirms terminal.
          const pendingJobId = await withProjectWrite(
            writeCapability,
            project.id,
            async (tx) => {
              const [job] = await tx
                .insert(processingJobs)
                .values({
                  projectId: project.id,
                  stepFunctionArn: process.env.STEP_FUNCTION_ARN,
                  executionId: expectedExecutionArn,
                  status: "running",
                })
                .returning({ id: processingJobs.id });
              if (!job)
                throw new Error("Failed to create processing job intent");
              await tx
                .update(projects)
                .set({ status: "processing", jobId: executionName })
                .where(eq(projects.id, project.id));
              return job.id;
            },
          );

          const sfnClient = new SFNClient({
            region: process.env.AWS_REGION || "us-east-1",
          });
          let sfnResponse: { executionArn?: string };
          try {
            sfnResponse = await sfnClient.send(
              new StartExecutionCommand({
                stateMachineArn: process.env.STEP_FUNCTION_ARN,
                name: executionName,
                input: await processingStartInput(project), // + the root upload compute preset
              }),
            );
          } catch (error) {
            await withProjectWrite(writeCapability, project.id, async (tx) => {
              await tx
                .update(processingJobs)
                .set({ error: "Step Functions start outcome unknown" })
                .where(eq(processingJobs.id, pendingJobId));
            }).catch((intentError) => {
              logger.error(
                "Processing job intent uncertainty update failed:",
                intentError,
              );
            });
            throw error;
          }

          // The deterministic ARN is already durable; retain the provider response if it differs.
          if (
            sfnResponse.executionArn &&
            sfnResponse.executionArn !== expectedExecutionArn
          ) {
            await withProjectWrite(writeCapability, project.id, async (tx) => {
              await tx
                .update(processingJobs)
                .set({ executionId: sfnResponse.executionArn })
                .where(eq(processingJobs.id, pendingJobId));
            });
          }
        },
      );
    } catch (err) {
      logger.error("Step Functions start failed:", err);
      await withProjectWrite(writeCapability, project.id, async (tx) => {
        await tx
          .update(projects)
          .set({
            status: "error",
            processingError:
              err instanceof Error ? err.message : "Failed to start processing",
          })
          .where(eq(projects.id, project.id));
      });
    }
  } else if (
    process.env.NODE_ENV !== "production" ||
    process.env.DEV_PROCESSING_ENABLED === "true"
  ) {
    // Dev mode: call processing logic directly (fire-and-forget)
    processProject(project.id, writeCapability).catch((err) =>
      logger.error("Processing failed:", err),
    );
  }

  // status = the in-memory `.returning()` value ("uploading") even after the SFN branch updates the DB row.
  return { id: project.publicId, name: project.name, status: project.status };
}

// ── GET /api/projects ──────────────────────────────────────────────────────────────
//
/**
 * List projects visible to the caller (root admin sees ALL companies; else companyId-scoped), oldest-first.
 * Returns a BARE ARRAY (the shell passes it through unwrapped). Frozen quirks: the pages-COUNT round-trip is
 * SKIPPED when there are no projects; company-name lookup runs ONLY for root admins; `numPages` falsy-
 * coalesces `pageCounts[id] || p.numPages || 0`; `pagesProcessed` is `pageCounts[id] || null` (so a live
 * 0-page count → null, diverging from numPages for the same project); `thumbnailUrl` is non-null ONLY when
 * status==="completed"; `companyId`/`companyName` are `undefined` for non-root (dropped by JSON.stringify),
 * not null.
 */
export async function listProjects(session: AuthSession) {
  const allProjects = await db
    .select()
    .from(projects)
    .where(
      session.user.isRootAdmin
        ? undefined
        : eq(projects.companyId, session.user.companyId),
    )
    .orderBy(projects.createdAt);

  // Visible page counts in a single query (skipped entirely when there are no projects).
  // [2026-10-23] hidden duplicates excluded; the query lives in project-page-counts.ts (ceiling).
  const pageCounts: Record<number, number> =
    allProjects.length > 0 ? await visiblePageCountsByProject() : {};

  // For root admin: fetch company names for grouping
  let companyNames: Record<number, string> = {};
  if (session.user.isRootAdmin) {
    const allCompanies = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies);
    for (const c of allCompanies) companyNames[c.id] = c.name;
  }

  return allProjects.map((p) => ({
    id: p.publicId,
    name: p.name,
    numPages: pageCounts[p.id] || p.numPages || 0,
    status: p.status,
    pagesProcessed: pageCounts[p.id] || null,
    thumbnailUrl:
      p.status === "completed" ? projectAssetUrl(p.publicId, "thumbnail.png") : null,
    isDemo: p.isDemo,
    createdAt: p.createdAt,
    companyId: session.user.isRootAdmin ? p.companyId : undefined,
    companyName: session.user.isRootAdmin
      ? companyNames[p.companyId]
      : undefined,
  }));
}
