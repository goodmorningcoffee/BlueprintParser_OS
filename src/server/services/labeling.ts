// [refactor jul3 P1.5] Labeling service — the four /api/labeling routes' behavior.
//
// The four labeling route files (sessions [GET list], sessions/[id] [DELETE], credentials [GET],
// create [POST]) are now thin `defineRoute` shells; ALL behavior lives here. No P0.3 char file
// existed — the NEW src/app/api/__tests__/labeling-{sessions,sessions-id,credentials}.route.test.ts
// written WITH this migration ARE the freeze (create is NOT integration-tested: sharp/S3/Label-
// Studio deps — its port is review-verified only; flag for the P1 phase review).
//
// Access shapes — three DIFFERENT ones, deliberately NOT unified, and NONE use
// resolveProjectOrThrow (its engine root-bypasses; swapping it in would silently GRANT root
// admins cross-company access on list/delete — the R1 char cases catch exactly that):
//   • listLabelingSessions = AUTH-FIRST (shell auth:"session") + MANUAL and(publicId, companyId)
//     project lookup — NO isRootAdmin bypass, NO isDemo carve-out (qto-GET precedent: root
//     cross-company → 404, no existence leak).
//   • deleteLabelingSession = AUTH-FIRST + DIRECT lookup on the sessions table's DENORMALIZED
//     companyId column (no project join, no bypass). parseInt(id) verbatim — see FQ-2.
//   • getLabelingCredentials = shell auth:"none" + the service calls auth() ITSELF: the legacy
//     gate returns 403 "Admin only" for a SIGNED-OUT caller (NOT 401). defineRoute auth:"admin"
//     would 401 a null session before the role check — wrong status. First service to import
//     auth() directly; flagged for P1 phase-review sign-off.
//   • createLabelingSessions = AUTH-FIRST + ownership lookup WITH the isRootAdmin ternary bypass
//     (root: publicId-only) — the CONTRAST with list/delete is legacy-faithful, not an oversight.
//
// Sanctioned diffs ONLY (success paths byte-identical):
//   A envelope flips {error:string} → {error:{code,message}} (the shell renders); every legacy
//     message string preserved byte-for-byte ("projectId required", "Not found", "Admin only",
//     "Project not found", "Daily labeling limit reached (10 projects/day)", both 503 texts).
//   B (create only) the legacy catch that returned 500 {error:`Failed to create Label Studio
//     project: ${err.message}`} — an err.message leak of unbounded provenance — is DROPPED: the
//     chunk loop now throws to the shell's outer catch (server-side log + generic INTERNAL 500).
//     The legacy OUTSIDE-the-try throws (downloadFromS3 etc. → raw framework 500) converge on the
//     same generic 500.
//   C non-uuid projectId (list + create): legacy fed it straight into the pg uuid column →
//     unhandled cast 500 (S003 class); now a clean 400 "Invalid project id" via zPublicId,
//     gated AFTER the projectId-required 400 so the missing-field message wins.
//   E (create only) malformed JSON body: legacy uncaught SyntaxError → framework 500; now the
//     shell's BAD_REQUEST 400 (fires at shell step 1, so it now PRECEDES the 401 — accepted
//     ordering shift, no consumer distinguishes).
//   E2 inherited P1.1 shell body-parse semantics (the annotation-groups diff-6 / projects diff-4
//     sanction class, caught by the S020 DETECTOR): (delete) METHODS_WITH_BODY includes DELETE,
//     so a NON-EMPTY malformed-JSON DELETE body now 400s BAD_REQUEST before auth where legacy
//     never read the body (empty body unaffected; no client sends one). (create) an EMPTY body:
//     legacy authed SyntaxError 500 → shell VALIDATION 400 after auth; a non-object valid-JSON
//     body: legacy destructured to undefined → 400 "projectId required", now the shell's zod
//     VALIDATION 400 — STATUS preserved, message drifts (cosmetic; the S013 pages precedent).
//   NaN [id] is NOT diff-D'd: parseInt("abc")=NaN → pg int-cast throw → the shell's leak-free
//     INTERNAL 500 (deterministic; qto-workflows/annotations/takeoff-items precedent).
//
// Frozen quirks (do NOT "fix") — FQ tags at the sites below:
//   FQ-1 list returns a BARE ARRAY mapped to EXACTLY 8 fields (drops companyId/projectId/
//        tilingEnabled/tileGrid/updatedAt), NO orderBy.
//   FQ-2 delete uses parseInt (NOT Number): trailing garbage tolerated ("5abc"→5→404), only a
//        leading non-digit reaches the NaN-500. Swapping to Number() would flip "5abc" 404→500.
//   FQ-3 delete SWALLOWS a Label Studio deleteProject failure (log only) and still deletes the
//        DB row + returns {success:true}; no affected-rows check (TOCTOU no-op).
//   FQ-4 credentials: ONE combined gate — signed-out AND non-admin both get 403 "Admin only";
//        the OR arm means a role:"member" root admin passes.
//   FQ-5 create: demo kill-switch bypass predicate is isRootAdmin (create gate) but the rate-limit
//        bypass predicate is role==="admin" — TWO DIFFERENT predicates; a member-role root admin
//        bypasses the demo gate but NOT the rate limit. Do NOT unify.
//   FQ-6 create rate limit counts a ROLLING 24h window (NOW() - INTERVAL '1 day'), not a calendar
//        day, despite the "/day" message.
//   FQ-7 create page-selection: "current" → [parseInt(pageRange)] with NO NaN guard; "range" with
//        no "-" → end=undefined → NaN → empty loop → 200 {success:true,sessions:[]} and ZERO
//        writes; else → 1..numPages.
//   FQ-8 create demo gate returns the assertDemoFeatureEnabled NextResponse VERBATIM (shell
//        Response-passthrough) — that module still speaks the legacy {error:string} envelope and
//        owns it until IT migrates.
//   [LB-1] create builds UNPADDED `page_${n}.png` S3 keys (both the tiling download and the
//        non-tiling CloudFront URL, plus the tile keys) — the rest of the codebase pads with
//        String(n).padStart(4,"0") (e.g. services/pages.ts thumbnail path). This is a KNOWN BUG
//        deliberately PRESERVED by the refactor's zero-behavior-change rule. Do NOT pad.

import { db } from "@/lib/db";
import { projects, labelingSessions } from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { ApiError, notFound } from "@/server/api/envelope";
import { zPublicId } from "@/server/api/schemas";
import { auth } from "@/lib/auth";
import { createProject, deleteProject, importTasks } from "@/lib/label-studio";
import { getS3Url, downloadFromS3, uploadToS3 } from "@/lib/s3";
import { assertDemoFeatureEnabled } from "@/lib/demo-features";
import { logger } from "@/lib/logger";
import type { AuthSession } from "@/lib/api-utils";

const DEFAULT_LABEL_CONFIG = `<View>
  <Image name="image" value="$image" zoomControl="true" rotateControl="true"/>
</View>`;

/** GET /api/labeling/sessions — list a project's labeling sessions (company-scoped, no bypass). */
export async function listLabelingSessions(
  projectId: string | null,
  session: AuthSession,
): Promise<
  Array<{
    id: number;
    labelStudioProjectId: number;
    labelStudioUrl: string | null;
    taskType: string | null;
    labels: string[] | null;
    pageRange: string | null;
    status: string;
    createdAt: Date | null;
  }>
> {
  if (!projectId) {
    throw new ApiError("VALIDATION", "projectId required");
  }
  // [diff C] non-uuid → clean 400 (legacy: pg uuid-cast 500). AFTER the required-400 so the
  // missing-field message wins.
  const parsed = zPublicId.safeParse(projectId);
  if (!parsed.success) {
    throw new ApiError("VALIDATION", "Invalid project id");
  }

  // MANUAL and(publicId, companyId) — NO root bypass, NO demo carve-out (root cross-co → 404).
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.publicId, parsed.data), eq(projects.companyId, session.user.companyId)))
    .limit(1);

  if (!project) {
    throw notFound(); // "Not found"
  }

  const sessions = await db
    .select()
    .from(labelingSessions)
    .where(eq(labelingSessions.projectId, project.id));

  // FQ-1: bare array, EXACTLY these 8 fields, no orderBy.
  return sessions.map((s) => ({
    id: s.id,
    labelStudioProjectId: s.labelStudioProjectId,
    labelStudioUrl: s.labelStudioUrl,
    taskType: s.taskType,
    labels: s.labels,
    pageRange: s.pageRange,
    status: s.status,
    createdAt: s.createdAt,
  }));
}

/** DELETE /api/labeling/sessions/[id] — company-scoped via the DENORMALIZED companyId, no bypass. */
export async function deleteLabelingSession(
  idParam: string,
  session: AuthSession,
): Promise<{ success: true }> {
  // FQ-2: parseInt verbatim — "5abc"→5 (tolerated), "abc"→NaN → pg int-cast throw → shell 500.
  const sessionId = parseInt(idParam);

  const [record] = await db
    .select()
    .from(labelingSessions)
    .where(
      and(
        eq(labelingSessions.id, sessionId),
        eq(labelingSessions.companyId, session.user.companyId),
      ),
    )
    .limit(1);

  if (!record) {
    throw notFound(); // "Not found"
  }

  // FQ-3: Label Studio failure is swallowed — DB cleanup proceeds regardless.
  try {
    await deleteProject(record.labelStudioProjectId);
  } catch (err) {
    logger.error("[LABELING] Failed to delete LS project:", err);
    // Continue with DB cleanup even if LS API fails
  }

  await db.delete(labelingSessions).where(eq(labelingSessions.id, sessionId));

  return { success: true };
}

/** GET /api/labeling/credentials — Label Studio login for admins; env-sourced, never hardcoded. */
export async function getLabelingCredentials(): Promise<{ email: string; password: string }> {
  // FQ-4: the service resolves auth ITSELF (shell is auth:"none") to preserve the legacy ONE
  // combined gate: signed-out → 403 "Admin only" (NOT 401). auth:"admin" would 401 a null session.
  const session = await auth();
  if (!session?.user || (session.user.role !== "admin" && !session.user.isRootAdmin)) {
    throw new ApiError("FORBIDDEN", "Admin only");
  }

  const email = process.env.LABEL_STUDIO_ADMIN_EMAIL;
  const password = process.env.LABEL_STUDIO_ADMIN_PASSWORD;

  if (!email || !password) {
    // VALIDATION + statusOverride 503 (projects.ts VALIDATION+413 precedent): a NON-INTERNAL code
    // so the shell forwards the message verbatim; INTERNAL would scrub it to the generic text.
    throw new ApiError("VALIDATION", "Label Studio not configured", 503);
  }

  return { email, password };
}

/**
 * POST /api/labeling/create — create Label Studio project(s) from a BP project's page images.
 * HEAVY path (sharp/S3/Label Studio) — NOT integration-tested; port review-verified only.
 * Returns the demo-gate NextResponse verbatim via the shell's Response passthrough (FQ-8).
 */
export async function createLabelingSessions(
  body: Record<string, unknown>,
  session: AuthSession,
): Promise<
  | Response
  | {
      success: true;
      sessions: Array<{
        id: number;
        labelStudioProjectId: number;
        labelStudioUrl: string;
        pageRange: string;
        taskCount: number;
      }>;
    }
> {
  const { projectId, pagesPerProject, pageSelection, pageRange, tiling } = body as {
    projectId?: unknown;
    pagesPerProject?: unknown;
    pageSelection?: unknown;
    pageRange?: unknown;
    tiling?: unknown;
  };

  if (!projectId) {
    throw new ApiError("VALIDATION", "projectId required");
  }
  // [diff C] non-uuid (or non-string) projectId → clean 400 (legacy: pg uuid-cast 500).
  const parsedId = zPublicId.safeParse(projectId);
  if (!parsedId.success) {
    throw new ApiError("VALIDATION", "Invalid project id");
  }

  const safePagesPerProject = Math.max(2, Math.min((pagesPerProject as number) || 10, 50));

  // Verify project ownership — WITH the isRootAdmin bypass (root: publicId-only), the legacy
  // contrast to list/delete's strict company scoping.
  const [project] = await db
    .select()
    .from(projects)
    .where(
      session.user.isRootAdmin
        ? eq(projects.publicId, parsedId.data)
        : and(eq(projects.publicId, parsedId.data), eq(projects.companyId, session.user.companyId)),
    )
    .limit(1);

  if (!project) {
    throw notFound("Project not found"); // distinct from list/delete's bare "Not found"
  }

  // Runtime kill-switch — admin can disable labeling on demo projects via the Demo Features
  // panel. Full admin ownership bypasses intentionally. FQ-8: the gate's NextResponse (legacy
  // {error:string} envelope, owned by demo-features.ts) is returned VERBATIM via passthrough.
  if (project.isDemo && !session.user.isRootAdmin) {
    const gate = await assertDemoFeatureEnabled(project.companyId, "labeling");
    if (gate) return gate;
  }

  // Rate limit: max 10 labeling sessions per company per day (admin bypasses).
  // FQ-5: bypass predicate here is role==="admin" (NOT isRootAdmin — different from the demo
  // gate above). FQ-6: rolling 24h window despite the "/day" wording.
  if (session.user.role !== "admin") {
    const todayCount = await db.execute(
      sql`SELECT COUNT(*)::int AS cnt FROM labeling_sessions
          WHERE company_id = ${session.user.companyId}
            AND created_at > NOW() - INTERVAL '1 day'`,
    );
    if (((todayCount.rows[0] as { cnt?: number })?.cnt ?? 0) >= 10) {
      throw new ApiError("RATE_LIMITED", "Daily labeling limit reached (10 projects/day)");
    }
  }

  // Check Label Studio env vars are configured (VALIDATION+503, message verbatim — see FQ-4 note).
  if (!process.env.LABEL_STUDIO_URL || !process.env.LABEL_STUDIO_API_KEY) {
    throw new ApiError(
      "VALIDATION",
      "Label Studio not configured. Set LABEL_STUDIO_URL and LABEL_STUDIO_API_KEY.",
      503,
    );
  }

  // Determine which pages to include. FQ-7: "current" has no NaN guard; a "range" without "-"
  // yields an empty loop → 200 with zero sessions.
  const numPages = project.numPages || 1;
  let pageNumbers: number[] = [];

  if (pageSelection === "current" && pageRange) {
    pageNumbers = [parseInt(pageRange as string)];
  } else if (pageSelection === "range" && pageRange) {
    const [start, end] = (pageRange as string).split("-").map(Number);
    for (let i = start; i <= Math.min(end, numPages); i++) pageNumbers.push(i);
  } else {
    for (let i = 1; i <= numPages; i++) pageNumbers.push(i);
  }

  // Build tasks — either direct CloudFront URLs or tiled images
  let tasks: Array<{ data: { image: string }; meta: Record<string, number> }>;

  if (tiling) {
    const sharp = (await import("sharp")).default;
    tasks = [];
    // Process in batches of 5 for performance
    const batchSize = 5;
    for (let b = 0; b < pageNumbers.length; b += batchSize) {
      const batch = pageNumbers.slice(b, b + batchSize);
      const batchResults = await Promise.all(
        batch.map(async (pageNum) => {
          // [LB-1] UNPADDED page key (bug preserved — see header; the repo convention pads to 4).
          const key = `${project.dataUrl}/pages/page_${pageNum}.png`;
          const buffer = await downloadFromS3(key);
          const metadata = await sharp(buffer).metadata();
          const tileW = Math.floor((metadata.width || 3000) / 3);
          const tileH = Math.floor((metadata.height || 2000) / 3);
          const tileTasks: typeof tasks = [];

          for (let row = 0; row < 3; row++) {
            for (let col = 0; col < 3; col++) {
              const tileBuffer = await sharp(buffer)
                .extract({ left: col * tileW, top: row * tileH, width: tileW, height: tileH })
                .png()
                .toBuffer();
              const tileKey = `${project.dataUrl}/tiles/page_${pageNum}_r${row}_c${col}.png`;
              await uploadToS3(tileKey, tileBuffer, "image/png");
              const url = getS3Url(project.dataUrl, `tiles/page_${pageNum}_r${row}_c${col}.png`);
              tileTasks.push({ data: { image: url }, meta: { pageNumber: pageNum, row, col } });
            }
          }
          return tileTasks;
        }),
      );
      tasks.push(...batchResults.flat());
    }
  } else {
    tasks = pageNumbers.map((pageNum) => ({
      // [LB-1] UNPADDED page key (bug preserved — see header).
      data: { image: getS3Url(project.dataUrl, `pages/page_${pageNum}.png`) },
      meta: { pageNumber: pageNum },
    }));
  }

  // Split into chunks based on pagesPerProject
  const chunks: (typeof tasks)[] = [];
  for (let i = 0; i < tasks.length; i += safePagesPerProject) {
    chunks.push(tasks.slice(i, i + safePagesPerProject));
  }

  const lsUrl = process.env.LABEL_STUDIO_URL.replace(/\/$/, "");
  const sessions: Array<{
    id: number;
    labelStudioProjectId: number;
    labelStudioUrl: string;
    pageRange: string;
    taskCount: number;
  }> = [];

  // [diff B] legacy wrapped this loop in try/catch returning 500 {error:`Failed to create Label
  // Studio project: ${err.message}`} — an err.message leak. Now any throw propagates to the
  // shell's outer catch (server-side log with route+requestId, generic INTERNAL 500).
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    // Determine page range for this chunk
    const chunkPages = [...new Set(chunk.map((t) => t.meta.pageNumber))].sort((a, b) => a - b);
    const range =
      chunkPages.length === 1
        ? String(chunkPages[0])
        : `${chunkPages[0]}-${chunkPages[chunkPages.length - 1]}`;

    const title = chunks.length === 1 ? project.name : `${project.name} (pages ${range})`;

    // Create LS project with default image-only config
    const lsProject = await createProject(title, DEFAULT_LABEL_CONFIG);

    // Import tasks with CloudFront URLs
    await importTasks(lsProject.id, chunk);

    const projectUrl = `${lsUrl}/projects/${lsProject.id}`;

    // Store session record
    const [record] = await db
      .insert(labelingSessions)
      .values({
        projectId: project.id,
        companyId: project.companyId,
        labelStudioProjectId: lsProject.id,
        labelStudioUrl: projectUrl,
        taskType: "generic",
        labels: null,
        pageRange: range,
        tilingEnabled: !!tiling,
        tileGrid: tiling ? 3 : null,
        status: "active",
      })
      .returning();

    sessions.push({
      id: record.id,
      labelStudioProjectId: lsProject.id,
      labelStudioUrl: projectUrl,
      pageRange: range,
      taskCount: chunk.length,
    });
  }

  return { success: true, sessions };
}
