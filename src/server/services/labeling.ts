// [refactor jul3 P1.5] Labeling service — the four /api/labeling routes' behavior.
//
// The three live labeling route files (sessions [GET list], sessions/[id] [DELETE], create [POST])
// are thin `defineRoute` shells; ALL live behavior lives here. The former credentials route is a
// 410 tombstone: a shared provider bootstrap identity must never cross the browser boundary. No P0.3 char file
// existed — the NEW src/app/api/__tests__/labeling-{sessions,sessions-id,credentials}.route.test.ts
// written WITH this migration ARE the freeze. The create path now also has boundary integration
// coverage for versioned S3 snapshots, grants, tiling, and Label Studio compensation.
//
// Access shapes — three DIFFERENT ones, deliberately NOT unified, and NONE use
// resolveProjectOrThrow (its engine root-bypasses; swapping it in would silently GRANT root
// admins cross-company access on list/delete — the R1 char cases catch exactly that):
//   • listLabelingSessions = AUTH-FIRST (shell auth:"session") + MANUAL and(publicId, companyId)
//     project lookup — NO isRootAdmin bypass, NO isDemo carve-out (qto-GET precedent: root
//     cross-company → 404, no existence leak).
//   • deleteLabelingSession = AUTH-FIRST + DIRECT lookup on the sessions table's DENORMALIZED
//     companyId column (no project join, no bypass). parseInt(id) verbatim — see FQ-2.
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
//   FQ-3 security repair: delete retires the Label Studio project before the DB row and propagates
//        provider failure so publication/project deletion remain blocked and retryable.
//   FQ-5 create: demo kill-switch bypass predicate is isRootAdmin (create gate) but the rate-limit
//        bypass predicate is role==="admin" — TWO DIFFERENT predicates; a member-role root admin
//        bypasses the demo gate but NOT the rate limit. Do NOT unify.
//   FQ-6 create rate limit counts a ROLLING 24h window (NOW() - INTERVAL '1 day'), not a calendar
//        day, despite the "/day" message.
//   FQ-7 was retired by the P2 close review: page selections are now strict finite integers inside
//        the project range, so malformed requests cannot mint broken page_NaN tasks.
//   FQ-8 create demo gate returns the assertDemoFeatureEnabled NextResponse VERBATIM (shell
//        Response-passthrough) — that module still speaks the legacy {error:string} envelope and
//        owns it until IT migrates.
//   [LB-1] retired by the P2 close review: sources use canonical padded page keys and imported
//        tasks receive revocable app URLs backed by unique immutable snapshot objects.

import { randomUUID } from "node:crypto";

import { db } from "@/lib/db";
import {
  projects,
  labelingSessions,
  labelStudioAssetGrants,
  labelStudioProjectIntents,
} from "@/lib/db/schema";
import { eq, and, inArray, sql } from "drizzle-orm";
import { ApiError, notFound } from "@/server/api/envelope";
import { zPublicId } from "@/server/api/schemas";
import { auth } from "@/lib/auth";
import {
  configuredLabelStudioProvider,
  createProject,
  deleteProject,
  importTasks,
  type LabelStudioProviderBinding,
} from "@/lib/label-studio";
import {
  copyS3ObjectVersion,
  downloadFromS3,
  uploadS3VersionedSnapshot,
} from "@/lib/s3";
import { logger } from "@/lib/logger";
import type { AuthSession } from "@/lib/api-utils";
import { assertProjectWritable } from "@/server/api/access";
import {
  withProjectMutationLease,
  withProjectWrite,
} from "@/server/api/project-write-capability";
import {
  activateLabelStudioAssetGrants,
  createLabelStudioGrantSecret,
  deleteIntentLabelStudioAssetGrants,
  labelStudioAssetUrl,
  requireVersionedSource,
  revokeIntentLabelStudioAssetGrants,
  revokeSessionLabelStudioAssetGrants,
  withLabelStudioSnapshotLock,
  type PreparedLabelStudioGrant,
} from "@/lib/label-studio-asset-grant";
import { reconcileLabelStudioSessionRetirement } from "@/lib/label-studio-session-retirement";

const DEFAULT_LABEL_CONFIG = `<View>
  <Image name="image" value="$image" zoomControl="true" rotateControl="true"/>
</View>`;

const LABEL_STUDIO_REQUEST_LEASE_SECONDS = 2 * 60 * 60;
const LABEL_STUDIO_INTENT_ERROR_LENGTH = 4_000;

interface LabelingTaskSpec {
  pageNumber: number;
  row?: number;
  col?: number;
}

interface PreparedLabelingTask {
  grant: PreparedLabelStudioGrant;
  meta: Record<string, number>;
}

function canonicalPageAsset(pageNumber: number): string {
  return `pages/page_${String(pageNumber).padStart(4, "0")}.png`;
}

function selectLabelingPages(
  selection: unknown,
  rawRange: unknown,
  numPages: number,
): number[] {
  if (selection === "current") {
    if (typeof rawRange !== "string" || !/^[0-9]+$/.test(rawRange)) {
      throw new ApiError("VALIDATION", "Invalid page range");
    }
    const page = Number(rawRange);
    if (!Number.isSafeInteger(page) || page < 1 || page > numPages) {
      throw new ApiError("VALIDATION", "Invalid page range");
    }
    return [page];
  }
  if (selection === "range") {
    if (typeof rawRange !== "string") {
      throw new ApiError("VALIDATION", "Invalid page range");
    }
    const match = /^([0-9]+)-([0-9]+)$/.exec(rawRange);
    if (!match) throw new ApiError("VALIDATION", "Invalid page range");
    const start = Number(match[1]);
    const requestedEnd = Number(match[2]);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(requestedEnd) ||
      start < 1 ||
      start > numPages ||
      requestedEnd < start
    ) {
      throw new ApiError("VALIDATION", "Invalid page range");
    }
    const end = Math.min(requestedEnd, numPages);
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }
  return Array.from({ length: numPages }, (_, index) => index + 1);
}

function labelStudioIntentError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    LABEL_STUDIO_INTENT_ERROR_LENGTH,
  );
}

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
    .where(
      and(
        eq(projects.publicId, parsed.data),
        eq(projects.companyId, session.user.companyId),
      ),
    )
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

// ── GET /api/demo/labeling/sessions ────────────────────────────────────────────────────────────
//
/** [refactor jul3 P1.5] PUBLIC demo twin of listLabelingSessions — DELIBERATELY ISOLATED (the
 *  projects.ts getDemoProject/listDemoProjects doctrine): no session param, no companyId scope;
 *  SOLE gate `and(publicId, isDemo=true)`. Do NOT parameterize the authed fn to serve both.
 *  Frozen twin divergences (legacy design, do NOT harmonize): a MISS (unknown uuid OR non-demo
 *  project) returns **[] at 200 — NOT 404** (the demo/projects/[id]/pages twin 404s instead);
 *  the map is the 5-field PUBLIC SUBSET {id, labelStudioUrl, taskType, pageRange, taskCount}
 *  with taskCount HARDCODED 0 ("Not stored in DB, cosmetic only" — legacy comment) and must
 *  NEVER grow the authed 8-field shape (labelStudioProjectId/labels/status/createdAt stay
 *  absent: data-minimization on an UNAUTHENTICATED endpoint, pinned NEGATIVELY by the char
 *  test's strict key-set). Sanctioned diffs: A (envelope flip on the 400, message verbatim),
 *  B (leak-drop: legacy had no catch → raw 500, now the shell's generic INTERNAL 500),
 *  C (non-uuid projectId → clean 400 "Invalid project id", was a pg uuid-cast 500, gated AFTER
 *  the required-400). Success bodies byte-identical. */
export async function listDemoLabelingSessions(
  projectId: string | null,
): Promise<
  Array<{
    id: number;
    labelStudioUrl: string | null;
    taskType: string | null;
    pageRange: string | null;
    taskCount: number;
  }>
> {
  if (!projectId) {
    throw new ApiError("VALIDATION", "projectId required");
  }
  // [diff C] non-uuid → clean 400 (legacy: pg uuid-cast 500), AFTER the required-400.
  const parsed = zPublicId.safeParse(projectId);
  if (!parsed.success) {
    throw new ApiError("VALIDATION", "Invalid project id");
  }

  // Only allow demo projects — a miss (unknown OR non-demo) is [] at 200, NOT 404 (frozen quirk).
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.publicId, parsed.data), eq(projects.isDemo, true)))
    .limit(1);

  if (!project) {
    return [];
  }

  const sessions = await db
    .select()
    .from(labelingSessions)
    .where(eq(labelingSessions.projectId, project.id));

  // The 5-field PUBLIC subset — taskCount hardcoded 0 (not stored in DB, cosmetic only).
  return sessions.map((s) => ({
    id: s.id,
    labelStudioUrl: s.labelStudioUrl,
    taskType: s.taskType,
    pageRange: s.pageRange,
    taskCount: 0,
  }));
}

/** DELETE /api/labeling/sessions/[id] — company-scoped via the DENORMALIZED companyId, no bypass. */
export async function deleteLabelingSession(
  idParam: string,
): Promise<{ success: true }> {
  // FQ-2: parseInt verbatim — "5abc"→5 (tolerated), "abc"→NaN → pg int-cast throw → shell 500.
  const sessionId = parseInt(idParam);

  // A public demo target must be denied before auth so every caller role observes the same
  // immutable-resource policy. Unknown/private IDs retain the legacy auth result below.
  const [preflightRecord] = await db
    .select({ projectId: labelingSessions.projectId })
    .from(labelingSessions)
    .where(eq(labelingSessions.id, sessionId))
    .limit(1);
  if (preflightRecord) {
    const [target] = await db
      .select({
        id: projects.id,
        publicId: projects.publicId,
        companyId: projects.companyId,
        isDemo: projects.isDemo,
        lifecycleEpoch: projects.lifecycleEpoch,
        updatedAt: projects.updatedAt,
      })
      .from(projects)
      .where(eq(projects.id, preflightRecord.projectId))
      .limit(1);
    if (target?.isDemo) assertProjectWritable(target);
  }

  const session = (await auth()) as unknown as AuthSession | null;
  if (!session?.user) throw new ApiError("UNAUTHORIZED", "Unauthorized");

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

  const [targetProject] = await db
    .select({
      id: projects.id,
      publicId: projects.publicId,
      companyId: projects.companyId,
      isDemo: projects.isDemo,
      lifecycleEpoch: projects.lifecycleEpoch,
      updatedAt: projects.updatedAt,
    })
    .from(projects)
    .where(eq(projects.id, record.projectId))
    .limit(1);
  if (!targetProject) throw notFound();
  const writeCapability = assertProjectWritable(targetProject);

  // Revoke every imported bearer and durably enqueue retirement before provider I/O. Provider
  // DELETE is idempotent, so its short reclaimable session lease can be retried safely after a
  // timeout or worker crash; the session row remains a publication/project-deletion blocker.
  await withProjectWrite(writeCapability, targetProject.id, async (tx) => {
    const [retiring] = await tx
      .update(labelingSessions)
      .set({
        status: "retiring",
        retirementNextAttemptAt: sql`CURRENT_TIMESTAMP`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(
          eq(labelingSessions.id, sessionId),
          eq(labelingSessions.projectId, targetProject.id),
          eq(labelingSessions.companyId, session.user.companyId),
        ),
      )
      .returning({ id: labelingSessions.id });
    if (!retiring) throw notFound();
    await revokeSessionLabelStudioAssetGrants(tx, sessionId);
    const [grantWitness] = await tx
      .select({ id: labelStudioAssetGrants.id })
      .from(labelStudioAssetGrants)
      .where(
        and(
          eq(labelStudioAssetGrants.labelingSessionId, sessionId),
          eq(labelStudioAssetGrants.state, "revoked"),
        ),
      )
      .limit(1);
    if (!grantWitness) {
      throw new Error("Label Studio session has no revoked asset grants");
    }
  });

  const retirement = await reconcileLabelStudioSessionRetirement(sessionId);
  if (retirement === "unavailable") {
    const [remaining] = await db
      .select({ id: labelingSessions.id })
      .from(labelingSessions)
      .where(eq(labelingSessions.id, sessionId))
      .limit(1);
    if (remaining) {
      throw new ApiError(
        "CONFLICT",
        "Label Studio session retirement already in progress",
      );
    }
  }

  return { success: true };
}

/**
 * POST /api/labeling/create — create Label Studio project(s) from a BP project's page images.
 * HEAVY path (sharp/S3/Label Studio), covered with provider/S3 boundary integration fixtures.
 * Returns the demo-gate NextResponse verbatim via the shell's Response passthrough (FQ-8).
 */
export async function createLabelingSessions(
  body: Record<string, unknown>,
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
  const { projectId, pagesPerProject, pageSelection, pageRange, tiling } =
    body as {
      projectId?: unknown;
      pagesPerProject?: unknown;
      pageSelection?: unknown;
      pageRange?: unknown;
      tiling?: unknown;
    };

  // Only valid, existing demo IDs are preflighted here. Missing/invalid/private targets continue
  // through the historical auth/validation sequence; demos get the canonical all-role 403.
  const preflightId = zPublicId.safeParse(projectId);
  if (preflightId.success) {
    const [target] = await db
      .select({
        id: projects.id,
        publicId: projects.publicId,
        companyId: projects.companyId,
        isDemo: projects.isDemo,
        lifecycleEpoch: projects.lifecycleEpoch,
        updatedAt: projects.updatedAt,
      })
      .from(projects)
      .where(eq(projects.publicId, preflightId.data))
      .limit(1);
    if (target?.isDemo) assertProjectWritable(target);
  }

  const session = (await auth()) as unknown as AuthSession | null;
  if (!session?.user) throw new ApiError("UNAUTHORIZED", "Unauthorized");

  if (!projectId) {
    throw new ApiError("VALIDATION", "projectId required");
  }
  // [diff C] non-uuid (or non-string) projectId → clean 400 (legacy: pg uuid-cast 500).
  const parsedId = zPublicId.safeParse(projectId);
  if (!parsedId.success) {
    throw new ApiError("VALIDATION", "Invalid project id");
  }

  const safePagesPerProject = Math.max(
    2,
    Math.min((pagesPerProject as number) || 10, 50),
  );

  // Verify project ownership — WITH the isRootAdmin bypass (root: publicId-only), the legacy
  // contrast to list/delete's strict company scoping.
  const [project] = await db
    .select()
    .from(projects)
    .where(
      session.user.isRootAdmin
        ? eq(projects.publicId, parsedId.data)
        : and(
            eq(projects.publicId, parsedId.data),
            eq(projects.companyId, session.user.companyId),
          ),
    )
    .limit(1);

  if (!project) {
    throw notFound("Project not found"); // distinct from list/delete's bare "Not found"
  }

  const writeCapability = assertProjectWritable(project);

  return withProjectMutationLease(
    writeCapability,
    { kind: "labeling-session-create", idempotencyKey: String(project.id) },
    async (mutationLease) => {
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
          throw new ApiError(
            "RATE_LIMITED",
            "Daily labeling limit reached (10 projects/day)",
          );
        }
      }

      // Capture one immutable provider identity before creating any durable witness. Numeric Label
      // Studio project IDs are meaningful only inside this exact persistent provider instance.
      let labelStudioProvider: LabelStudioProviderBinding;
      try {
        if (!process.env.LABEL_STUDIO_API_KEY)
          throw new Error("missing API key");
        labelStudioProvider = configuredLabelStudioProvider();
      } catch {
        throw new ApiError(
          "VALIDATION",
          "Label Studio not configured. Set LABEL_STUDIO_URL, LABEL_STUDIO_INSTANCE_ID, and LABEL_STUDIO_API_KEY.",
          503,
        );
      }

      // Every task must bind to a real canonical page. The old permissive parseInt flow minted
      // page_NaN and unpadded keys that Label Studio could never load.
      const numPages = project.numPages || 1;
      const pageNumbers = selectLabelingPages(
        pageSelection,
        pageRange,
        numPages,
      );
      const taskSpecs: LabelingTaskSpec[] = tiling
        ? pageNumbers.flatMap((pageNumber) =>
            Array.from({ length: 9 }, (_, tile) => ({
              pageNumber,
              row: Math.floor(tile / 3),
              col: tile % 3,
            })),
          )
        : pageNumbers.map((pageNumber) => ({ pageNumber }));

      // Preserve the historical chunk size contract (tiling counts each tile as one task).
      const chunks: LabelingTaskSpec[][] = [];
      for (let i = 0; i < taskSpecs.length; i += safePagesPerProject) {
        chunks.push(taskSpecs.slice(i, i + safePagesPerProject));
      }

      const lsUrl = labelStudioProvider.baseUrl;
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
        const chunkPages = [
          ...new Set(chunk.map((task) => task.pageNumber)),
        ].sort((a, b) => a - b);
        const range =
          chunkPages.length === 1
            ? String(chunkPages[0])
            : `${chunkPages[0]}-${chunkPages[chunkPages.length - 1]}`;

        const title =
          chunks.length === 1
            ? project.name
            : `${project.name} (pages ${range})`;

        // Snapshot every task to a never-reused current object before provider CREATE. Source
        // versions and every copy/upload are captured while a parent SHARE lock excludes the two
        // supported page-image writers. A crash can leave only private orphan bytes; project-prefix
        // deletion already purges them, and no grant row exists yet.
        const preparedTasks = await withLabelStudioSnapshotLock(
          project,
          async (storageRoot): Promise<PreparedLabelingTask[]> => {
            const prepared = new Array<PreparedLabelingTask>(chunk.length);
            const byPage = new Map<
              number,
              Array<{ spec: LabelingTaskSpec; index: number }>
            >();
            chunk.forEach((spec, index) => {
              const group = byPage.get(spec.pageNumber) ?? [];
              group.push({ spec, index });
              byPage.set(spec.pageNumber, group);
            });
            const sharp = tiling ? (await import("sharp")).default : undefined;

            await Promise.all(
              [...byPage.entries()].map(async ([pageNumber, entries]) => {
                const sourceKey = `${storageRoot}/${canonicalPageAsset(pageNumber)}`;
                const sourceVersion = await requireVersionedSource(sourceKey);
                if (!tiling) {
                  const entry = entries[0];
                  const grant = createLabelStudioGrantSecret();
                  const snapshotVersionId = await copyS3ObjectVersion(
                    sourceKey,
                    sourceVersion,
                    `${storageRoot}/${grant.snapshotAsset}`,
                  );
                  prepared[entry.index] = {
                    grant: { ...grant, snapshotVersionId },
                    meta: { pageNumber },
                  };
                  return;
                }

                const buffer = await downloadFromS3(sourceKey, sourceVersion);
                const metadata = await sharp!(buffer).metadata();
                const tileW = Math.floor((metadata.width || 3000) / 3);
                const tileH = Math.floor((metadata.height || 2000) / 3);
                await Promise.all(
                  entries.map(async ({ spec, index }) => {
                    const grant = createLabelStudioGrantSecret();
                    const tileBuffer = await sharp!(buffer)
                      .extract({
                        left: spec.col! * tileW,
                        top: spec.row! * tileH,
                        width: tileW,
                        height: tileH,
                      })
                      .png()
                      .toBuffer();
                    const snapshotVersionId = await uploadS3VersionedSnapshot(
                      `${storageRoot}/${grant.snapshotAsset}`,
                      tileBuffer,
                    );
                    prepared[index] = {
                      grant: { ...grant, snapshotVersionId },
                      meta: {
                        pageNumber,
                        row: spec.row!,
                        col: spec.col!,
                      },
                    };
                  }),
                );
              }),
            );
            return prepared;
          },
        );

        // Commit an application-generated provider identity before POST. A timed-out POST may have
        // committed remotely, so the marker is retained until exact provider search can disprove an
        // orphan; automatic recovery never repeats CREATE.
        const intentId = randomUUID();
        const marker = `bp-labeling-intent:${intentId}`;
        const requestLease = mutationLease.token;
        await withProjectWrite(writeCapability, project.id, async (tx) => {
          const [inserted] = await tx
            .insert(labelStudioProjectIntents)
            .values({
              id: intentId,
              projectId: project.id,
              companyId: project.companyId,
              lifecycleEpoch: project.lifecycleEpoch,
              marker,
              providerBaseUrl: labelStudioProvider.baseUrl,
              providerInstanceId: labelStudioProvider.instanceId,
              state: "creating",
              leaseToken: requestLease,
              leaseExpiresAt: sql`CURRENT_TIMESTAMP + (${LABEL_STUDIO_REQUEST_LEASE_SECONDS} * INTERVAL '1 second')`,
              nextAttemptAt: sql`CURRENT_TIMESTAMP`,
            })
            .returning({ id: labelStudioProjectIntents.id });
          if (!inserted)
            throw new Error("Failed to create Label Studio provider intent");
        });

        const markCreateUncertain = async (error: unknown): Promise<void> => {
          // Clear only the request lease. The marker remains the sole safe recovery authority when
          // the provider response is ambiguous or its returned numeric ID cannot be durably owned.
          await withProjectWrite(writeCapability, project.id, async (tx) => {
            const updated = await tx
              .update(labelStudioProjectIntents)
              .set({
                state: "create_uncertain",
                leaseToken: null,
                leaseExpiresAt: null,
                nextAttemptAt: sql`CURRENT_TIMESTAMP`,
                lastError: labelStudioIntentError(error),
                updatedAt: sql`CURRENT_TIMESTAMP`,
              })
              .where(
                and(
                  eq(labelStudioProjectIntents.id, intentId),
                  eq(labelStudioProjectIntents.projectId, project.id),
                  eq(
                    labelStudioProjectIntents.lifecycleEpoch,
                    project.lifecycleEpoch,
                  ),
                  eq(labelStudioProjectIntents.leaseToken, requestLease),
                ),
              )
              .returning({ id: labelStudioProjectIntents.id });
            if (updated.length !== 1) {
              throw new Error("Label Studio provider intent lease was lost");
            }
          });
        };

        let lsProject: Awaited<ReturnType<typeof createProject>>;
        try {
          lsProject = await createProject(
            labelStudioProvider,
            title,
            DEFAULT_LABEL_CONFIG,
            marker,
          );
        } catch (error) {
          // Any transport/provider failure is conservatively ambiguous. Clear only the request lease;
          // the outer project mutation lease still prevents the reconciler racing this stack unwind.
          await markCreateUncertain(error).catch((persistError) => {
            // The original durable row remains request-leased and becomes recoverable when its lease
            // expires. Never hide the provider error behind best-effort diagnostic persistence.
            logger.error(
              "[LABELING] Failed to mark ambiguous Label Studio create:",
              persistError,
            );
          });
          throw error;
        }

        const projectUrl = `${lsUrl}/projects/${lsProject.id}`;

        const persistKnownProvider = async (options: {
          releaseLease: boolean;
          insertGrants?: boolean;
          error?: unknown;
        }): Promise<void> => {
          await withProjectWrite(writeCapability, project.id, async (tx) => {
            const updated = await tx
              .update(labelStudioProjectIntents)
              .set({
                providerProjectId: lsProject.id,
                state: "cleanup_pending",
                leaseToken: options.releaseLease ? null : requestLease,
                leaseExpiresAt: options.releaseLease
                  ? null
                  : sql`CURRENT_TIMESTAMP + (${LABEL_STUDIO_REQUEST_LEASE_SECONDS} * INTERVAL '1 second')`,
                nextAttemptAt: sql`CURRENT_TIMESTAMP`,
                consecutiveFailures: options.error
                  ? sql`${labelStudioProjectIntents.consecutiveFailures} + 1`
                  : 0,
                lastError:
                  options.error === undefined
                    ? null
                    : labelStudioIntentError(options.error),
                updatedAt: sql`CURRENT_TIMESTAMP`,
              })
              .where(
                and(
                  eq(labelStudioProjectIntents.id, intentId),
                  eq(labelStudioProjectIntents.projectId, project.id),
                  eq(
                    labelStudioProjectIntents.lifecycleEpoch,
                    project.lifecycleEpoch,
                  ),
                  eq(labelStudioProjectIntents.leaseToken, requestLease),
                ),
              )
              .returning({ id: labelStudioProjectIntents.id });
            if (updated.length !== 1) {
              throw new Error("Label Studio provider intent lease was lost");
            }
            if (options.insertGrants) {
              await tx.insert(labelStudioAssetGrants).values(
                preparedTasks.map(({ grant }) => ({
                  id: grant.id,
                  projectId: project.id,
                  companyId: project.companyId,
                  lifecycleEpoch: project.lifecycleEpoch,
                  provisioningIntentId: intentId,
                  labelingSessionId: null,
                  tokenHash: grant.tokenHash,
                  snapshotVersionId: grant.snapshotVersionId,
                  state: "provisioning",
                })),
              );
            }
          });
        };

        const removeCompensatedIntent = async (): Promise<void> => {
          await withProjectWrite(writeCapability, project.id, async (tx) => {
            await deleteIntentLabelStudioAssetGrants(tx, intentId);
            const deleted = await tx
              .delete(labelStudioProjectIntents)
              .where(
                and(
                  eq(labelStudioProjectIntents.id, intentId),
                  eq(labelStudioProjectIntents.projectId, project.id),
                  eq(
                    labelStudioProjectIntents.lifecycleEpoch,
                    project.lifecycleEpoch,
                  ),
                  eq(labelStudioProjectIntents.leaseToken, requestLease),
                ),
              )
              .returning({ id: labelStudioProjectIntents.id });
            if (deleted.length !== 1) {
              throw new Error("Label Studio provider intent lease was lost");
            }
          });
        };

        const compensateKnownProvider = async (): Promise<void> => {
          // Imported URLs are bearer capabilities. Revoke their database authority before any
          // provider DELETE that can fail or time out. A DB failure must not suppress the provider
          // delete attempt: provisioning admission also requires the exact outer mutation-lease
          // row, so unwinding this operation fail-closes every bearer even if revocation cannot be
          // persisted. The durable intent remains for the worker to revoke and reconcile later.
          let revocationError: unknown;
          try {
            await withProjectWrite(writeCapability, project.id, async (tx) => {
              await revokeIntentLabelStudioAssetGrants(tx, intentId);
            });
          } catch (error) {
            revocationError = error;
            logger.error(
              "[LABELING] Failed to revoke orphan Label Studio asset grants:",
              error,
            );
          }
          try {
            await deleteProject(labelStudioProvider, lsProject.id);
          } catch (cleanupError) {
            // Make the known provider identity immediately retryable. If this write itself fails, the
            // pre-POST marker and expiring request lease still preserve eventual discovery.
            await persistKnownProvider({
              releaseLease: true,
              error: cleanupError,
            }).catch((persistError) => {
              logger.error(
                "[LABELING] Failed to retain Label Studio cleanup identity:",
                persistError,
              );
            });
            logger.error(
              "[LABELING] Failed to compensate orphan Label Studio project:",
              cleanupError,
            );
            return;
          }

          if (revocationError !== undefined) {
            // Provider deletion succeeded, but retain the known identity until the reconciler can
            // durably revoke/delete its local grant witnesses. A replayed provider 404 is the
            // expected idempotent acknowledgement.
            await persistKnownProvider({
              releaseLease: true,
              error: revocationError,
            }).catch((persistError) => {
              logger.error(
                "[LABELING] Failed to retain provider identity after grant revocation failure:",
                persistError,
              );
            });
            return;
          }

          await removeCompensatedIntent().catch(async (cleanupError) => {
            // Provider deletion is idempotent. A retained known-provider row is safe for the worker to
            // replay, whereas dropping the blocker without proving the DB commit would lose evidence.
            logger.error(
              "[LABELING] Failed to remove compensated provider intent:",
              cleanupError,
            );
            await persistKnownProvider({
              releaseLease: true,
              error: cleanupError,
            }).catch((persistError) => {
              logger.error(
                "[LABELING] Failed to retain compensated provider identity:",
                persistError,
              );
            });
          });
        };

        let providerIdentityPersisted = false;
        try {
          // Persist the returned numeric identity before importing tasks. If this commit is ambiguous,
          // the retained marker is the only safe recovery authority; a colliding ID may belong to an
          // existing session and must never be imported into or compensation-deleted.
          await persistKnownProvider({
            releaseLease: false,
            insertGrants: true,
          });
          providerIdentityPersisted = true;
          await importTasks(
            labelStudioProvider,
            lsProject.id,
            preparedTasks.map(({ grant, meta }) => ({
              data: { image: labelStudioAssetUrl(grant.id, grant.token) },
              meta,
            })),
          );
        } catch (error) {
          if (providerIdentityPersisted) {
            await compensateKnownProvider();
          } else {
            await markCreateUncertain(error).catch((persistError) => {
              // A lost commit acknowledgement may mean the known identity is already durable. In
              // that case this downgrade is rejected and the cleanup_pending witness remains safe.
              logger.error(
                "[LABELING] Failed to retain ambiguous provider identity marker:",
                persistError,
              );
            });
          }
          throw error;
        }

        let record: typeof labelingSessions.$inferSelect | undefined;
        let finalizationError: unknown;
        try {
          record = await withProjectWrite(
            writeCapability,
            project.id,
            async (tx) => {
              const [inserted] = await tx
                .insert(labelingSessions)
                .values({
                  projectId: project.id,
                  companyId: project.companyId,
                  labelStudioProjectId: lsProject.id,
                  providerBaseUrl: labelStudioProvider.baseUrl,
                  providerInstanceId: labelStudioProvider.instanceId,
                  labelStudioUrl: projectUrl,
                  taskType: "generic",
                  labels: null,
                  pageRange: range,
                  tilingEnabled: !!tiling,
                  tileGrid: tiling ? 3 : null,
                  status: "active",
                  provisioningIntentId: intentId,
                })
                .returning();
              if (!inserted)
                throw new Error("Failed to activate labeling session");

              await activateLabelStudioAssetGrants(
                tx,
                intentId,
                inserted.id,
                preparedTasks.map(({ grant }) => grant.id),
              );

              const deleted = await tx
                .delete(labelStudioProjectIntents)
                .where(
                  and(
                    eq(labelStudioProjectIntents.id, intentId),
                    eq(labelStudioProjectIntents.projectId, project.id),
                    eq(
                      labelStudioProjectIntents.lifecycleEpoch,
                      project.lifecycleEpoch,
                    ),
                    eq(labelStudioProjectIntents.leaseToken, requestLease),
                    eq(
                      labelStudioProjectIntents.providerProjectId,
                      lsProject.id,
                    ),
                  ),
                )
                .returning({ id: labelStudioProjectIntents.id });
              if (deleted.length !== 1) {
                throw new Error("Label Studio provider intent lease was lost");
              }
              return inserted;
            },
          );
        } catch (error) {
          finalizationError = error;
        }

        if (!record) {
          // A COMMIT acknowledgement can be lost. Audit both durable witnesses before deciding whether
          // the provider belongs to an active session; blindly compensating here could delete a
          // successfully activated project.
          let activated: typeof labelingSessions.$inferSelect | undefined;
          let pending:
            typeof labelStudioProjectIntents.$inferSelect | undefined;
          let grantWitnesses: Array<
            typeof labelStudioAssetGrants.$inferSelect
          > = [];
          try {
            await db.transaction(async (tx) => {
              [activated] = await tx
                .select()
                .from(labelingSessions)
                .where(eq(labelingSessions.provisioningIntentId, intentId))
                .limit(1);
              [pending] = await tx
                .select()
                .from(labelStudioProjectIntents)
                .where(eq(labelStudioProjectIntents.id, intentId))
                .limit(1);
              grantWitnesses = await tx
                .select()
                .from(labelStudioAssetGrants)
                .where(
                  inArray(
                    labelStudioAssetGrants.id,
                    preparedTasks.map(({ grant }) => grant.id),
                  ),
                );
            });
          } catch (auditError) {
            logger.error(
              "[LABELING] Failed to audit ambiguous session activation:",
              auditError,
            );
            throw finalizationError;
          }

          if (
            activated &&
            !pending &&
            activated.projectId === project.id &&
            activated.companyId === project.companyId &&
            activated.labelStudioProjectId === lsProject.id &&
            grantWitnesses.length === preparedTasks.length &&
            grantWitnesses.every(
              (grant) =>
                grant.state === "active" &&
                grant.labelingSessionId === activated!.id &&
                grant.provisioningIntentId === null,
            )
          ) {
            record = activated;
          } else if (!activated && pending) {
            await compensateKnownProvider();
            throw finalizationError;
          } else if (!activated && !pending && grantWitnesses.length === 0) {
            // Neither witness is impossible for the atomic finalization transaction. Re-establish a
            // cleanup identity before touching the provider so an additional failure cannot orphan it.
            await withProjectWrite(writeCapability, project.id, async (tx) => {
              await tx.insert(labelStudioProjectIntents).values({
                id: intentId,
                projectId: project.id,
                companyId: project.companyId,
                lifecycleEpoch: project.lifecycleEpoch,
                marker,
                providerProjectId: lsProject.id,
                providerBaseUrl: labelStudioProvider.baseUrl,
                providerInstanceId: labelStudioProvider.instanceId,
                state: "cleanup_pending",
                leaseToken: requestLease,
                leaseExpiresAt: sql`CURRENT_TIMESTAMP + (${LABEL_STUDIO_REQUEST_LEASE_SECONDS} * INTERVAL '1 second')`,
                nextAttemptAt: sql`CURRENT_TIMESTAMP`,
              });
            });
            await compensateKnownProvider();
            throw finalizationError;
          } else {
            logger.error(
              "[LABELING] Contradictory Label Studio activation witnesses; preserving provider and blockers",
              { intentId, providerProjectId: lsProject.id },
            );
            throw finalizationError;
          }
        }

        sessions.push({
          id: record.id,
          labelStudioProjectId: lsProject.id,
          labelStudioUrl: projectUrl,
          pageRange: range,
          taskCount: chunk.length,
        });
      }

      return { success: true, sessions };
    },
  );
}
