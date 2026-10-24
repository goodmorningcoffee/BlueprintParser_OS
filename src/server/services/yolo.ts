// [refactor jul6 S031] YOLO family route contracts (status/run/load), folded from the
// legacy fat routes (git show 77b83db^:src/app/api/yolo/*/route.ts). ENGINES/INFRA
// BYTE-UNTOUCHED: lib/yolo, lib/compute-usage, lib/toggles, the classifier cascade
// (heuristic-engine, table-classifier, composite-classifier, yolo-heatmap, ensemble/*,
// auto-detect), project-analysis, s3, email, audit, admin-logs. Char file:
// __tests__/yolo.route.test.ts (YQ-1..YQ-5). Frozen highlights:
//   • YQ-1 THREE root-admin semantics — run's lookup has NO root bypass (cross-company
//     root → 404), run's demo "yoloRun" gate IS root-bypassed, run's SageMaker cap IS
//     root-bypassed (post-hoc usage record). Never unify.
//   • YQ-2 load: signed-out → 403 "Admin only" (NOT 401) — S020-credentials class, hence
//     auth:"none" shell + the manual check below (the service calls auth() itself).
//   • YQ-3 run gate order AUTH→TOGGLES(fresh S3)→QUOTA(quota.message, NO || fallback)
//     →fields. The shell parses the raw body pre-auth (diff-E ordering note: malformed
//     bodies now 400 before auth; parseable-body gate order unchanged).
//   • YQ-4/YQ-5 quirks as pinned (same-404 model privacy, config.yaml regen, cap→abuse+
//     audit+throttled-SES, reservation rollback, ledger-failure swallow, file-loop fallback
//     chains, PI spread-merge, csi merge, soft-fail cascade). P2 replaces load's raw per-row
//     pg writer with one lifecycle-locked replacement transaction; DB errors remain in-band.
//   • Sanctioned diff B: status's fixed "Failed to check status" + run's outer
//     err.message leak → shell generic INTERNAL 500; run's "Failed to start SageMaker
//     job: <msg>" → ApiError INTERNAL "Failed to start SageMaker job" (suffix dropped —
//     UQ-2/symbol-search truncation precedent). load has NO outer catch to retire (its
//     errors are in-band by design).

import { auth } from "@/lib/auth";
import type { AuthSession } from "@/lib/api-utils";
import { assertDemoFeatureEnabled } from "@/lib/demo-features";
import { db } from "@/lib/db";
import {
  projects,
  models,
  modelAccess,
  processingJobs,
  pages,
  annotations,
  companies,
} from "@/lib/db/schema";
import { eq, and, or, isNull, isNotNull, sql } from "drizzle-orm";
import { createYoloJobName, startYoloJob, getYoloJobStatus } from "@/lib/yolo";
import { startFailureAnswer, startFailureRowPatch } from "@/server/services/yolo-start-failure";
import { isCanonicalModelStoragePath } from "@/lib/model-storage-authority";
import { yoloRunConfigYaml } from "@/lib/yolo-config-yaml";
import { s3Client, S3_BUCKET, uploadToS3 } from "@/lib/s3";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { checkYoloQuota } from "@/lib/quotas";
import {
  reserveSagemakerPages,
  releaseReservation,
  stampReservationJob,
  recordComputeUsage,
  shouldSendCapAlert,
} from "@/lib/compute-usage";
import { recordAbuseEvent } from "@/lib/admin-logs/record-abuse";
import { sendAlertEmail } from "@/lib/email";
import { audit } from "@/lib/audit";
import { getToggles } from "@/lib/toggles";
import { getEffectiveRules } from "@/lib/heuristic-engine";
import { resolvePipelineToggles } from "@/lib/pipeline-toggles";
import type { CsiCode, TextractPageData } from "@/types";
import { mergeCsiCodes } from "@/lib/csi-utils";
import { computeProjectSummaries } from "@/lib/project-analysis";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { logger } from "@/lib/logger";
import { ApiError, notFound } from "@/server/api/envelope";
import { assertProjectWritable } from "@/server/api/access";
// [refactor jul23 P4.1 U7] log-mode shape observation at the yolo-load persistence sink.
import { observeAnnotationDataBatch } from "./annotation-data-observe";
import {
  withProjectMutationLease,
  withProjectWrite,
} from "@/server/api/project-write-capability";
import { trustedClientIp } from "@/lib/trusted-client-ip";
import { assertDemoYoloTargetReadOnly } from "@/server/services/yolo-demo-target";
import { enrichPageAfterYolo } from "./yolo-post-enrichment";

// yolo/load's OWN S3 client (legacy constructed one; kept verbatim)
const loadS3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  ...(process.env.AWS_ACCESS_KEY_ID && {
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  }),
});

// ── GET /api/yolo/status ──────────────────────────────────────────────────────
export async function yoloStatus(
  req: Request,
  session: AuthSession,
): Promise<unknown> {
  const url = new URL(req.url);
  const jobName = url.searchParams.get("jobName");

  if (!jobName) {
    throw new ApiError("VALIDATION", "jobName required");
  }

  // A SageMaker job name is a provider-global capability. Require the durable YOLO intent to
  // belong to a project in this session's company before disclosing any provider state.
  const [job] = await db
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .innerJoin(projects, eq(processingJobs.projectId, projects.id))
    .where(
      and(
        eq(processingJobs.executionId, jobName),
        isNotNull(processingJobs.modelConfig),
        eq(projects.companyId, session.user.companyId),
      ),
    )
    .limit(1);
  if (!job) throw notFound();

  // [S031 diff B] legacy caught here → fixed "Failed to check status" 500; retired —
  // an SFN failure now propagates to the shell's generic INTERNAL 500.
  const status = await getYoloJobStatus(jobName);
  return status;
}

// ── POST /api/yolo/run ────────────────────────────────────────────────────────
export async function yoloRun(
  rawBody: Record<string, unknown>,
  req: Request,
): Promise<unknown> {
  const { projectId, modelId } = rawBody as {
    projectId?: string;
    modelId?: number;
  };
  await assertDemoYoloTargetReadOnly(projectId);
  const session = (await auth()) as unknown as AuthSession | null;
  if (!session?.user) throw new ApiError("UNAUTHORIZED", "Unauthorized");

  if (!session.user.canRunModels) {
    throw new ApiError(
      "FORBIDDEN",
      "You don't have permission to run models. Ask your admin to enable it.",
    );
  }

  // Check SageMaker toggle (persisted in S3) — always read fresh for safety
  const toggles = await getToggles(true);
  if (!toggles.sagemakerEnabled) {
    throw new ApiError(
      "FORBIDDEN",
      "SageMaker is disabled by admin. Enable it in Admin > Toggles.",
    );
  }

  // Check YOLO job quota (root exempt + per-user/company overrides — owner ruling 2026-10-21)
  if (toggles.quotaEnabled) {
    const quota = await checkYoloQuota(session.user.companyId, session.user.isRootAdmin, session.user.dbId);
    if (!quota.allowed) {
      // NO || fallback (YQ-3, frozen); message typed optional but always set on denial
      throw new ApiError("RATE_LIMITED", quota.message as string);
    }
  }

  if (!projectId || !modelId) {
    throw new ApiError("VALIDATION", "projectId and modelId required");
  }

  // Verify project — company-scoped, NO root bypass (YQ-1a, frozen)
  const [project] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.publicId, projectId),
        eq(projects.companyId, session.user.companyId),
      ),
    )
    .limit(1);

  if (!project) {
    throw new ApiError("NOT_FOUND", "Project not found");
  }
  const writeCapability = assertProjectWritable(project);

  // A YOLO run submits a Processing job over the project's whole /pages/ prefix,
  // so it is charged the project's full page count. We need a known count to
  // meter; reject early if absent (unprocessed project). The actual cap check +
  // page reservation happens atomically just before the job starts (below).
  const pagesToCharge = project.numPages ?? 0;
  if (pagesToCharge <= 0) {
    throw new ApiError(
      "VALIDATION",
      "Project page count is unknown. Reprocess the project before running models.",
    );
  }

  return withProjectMutationLease(
    writeCapability,
    { kind: "yolo-run", idempotencyKey: `${project.id}:${modelId}` },
    async () => {
      // Runtime kill-switch — admin can disable YOLO on demo projects via the
      // Demo Features panel. Root admin bypass intentional for infra ops. (YQ-1b)
      if (project.isDemo && !session.user.isRootAdmin) {
        const gate = await assertDemoFeatureEnabled(
          project.companyId,
          "yoloRun",
        );
        if (gate) return gate; // flat 403 passthrough — does NOT flip
      }

      // Get model
      const [model] = await db
        .select()
        .from(models)
        .where(eq(models.id, modelId))
        .limit(1);

      if (!model) {
        throw new ApiError("NOT_FOUND", "Model not found");
      }

      // Verify model access: must be owned by company OR have an enabled model_access row
      const companyId = session.user.companyId;
      if (model.companyId !== companyId) {
        // Accept a company-wide grant (user_id NULL) OR a grant to this specific user.
        const [access] = await db
          .select()
          .from(modelAccess)
          .where(
            and(
              eq(modelAccess.modelId, modelId),
              eq(modelAccess.companyId, companyId),
              eq(modelAccess.enabled, true),
              or(
                isNull(modelAccess.userId),
                eq(modelAccess.userId, session.user.dbId),
              ),
            ),
          )
          .limit(1);
        if (!access) {
          throw new ApiError("NOT_FOUND", "Model not found"); // same msg — no existence leak (YQ-4)
        }
      }

      // A model path is a server-write capability. Legacy/corrupt rows must never redirect the
      // config upload or SageMaker input into a project (especially a published demo) prefix.
      if (!isCanonicalModelStoragePath(model.name, model.s3Path)) {
        throw new ApiError(
          "CONFLICT",
          "Model storage path requires reconciliation",
        );
      }

      // Regenerate config.yaml from DB config so admin changes take effect (lib/yolo-config-yaml; TWIN in models.ts).
      const configYaml = yoloRunConfigYaml(model.config, model.name);
      await uploadToS3(
        `${model.s3Path}/config.yaml`,
        Buffer.from(configYaml),
        "text/yaml",
      );

      // [S031 diff B] the legacy outer try/catch (err.message leak) is RETIRED — the shell
      // owns unexpected 500s. The controlled returns below became ApiError throws (diff A).

      // Verify page PNGs exist from processing (stored at {dataUrl}/pages/)
      // SageMaker reads from this path directly — no rasterization needed
      try {
        await s3Client.send(
          new HeadObjectCommand({
            Bucket: S3_BUCKET,
            Key: `${project.dataUrl}/pages/page_0001.png`,
          }),
        );
      } catch {
        throw new ApiError(
          "VALIDATION",
          "Page images not found. The project needs to be processed first (or reprocessed if it was uploaded before the image pipeline was added).",
        );
      }

      // ── SageMaker page cap — the money gate ──────────────────────────────
      // Atomically check the per-company net cap AND optional per-user sub-cap and
      // RESERVE the pages (advisory-locked, so concurrent runs can't both slip
      // past). Root admin bypasses the block (god-mode); its usage is recorded
      // below for visibility, but is NOT isolated per reserved tenant (future work).
      let reservationId: number | undefined;
      if (!session.user.isRootAdmin) {
        const cap = await reserveSagemakerPages(
          session.user.companyId,
          session.user.dbId,
          project.id,
          pagesToCharge,
        );
        if (!cap.allowed) {
          // Use the same append-mode ALB trust boundary as middleware. Left-hand XFF hops are
          // caller-controlled and must not poison durable abuse telemetry.
          const ip = trustedClientIp(req.headers.get("x-forwarded-for"));
          // Drive the root Logs/alert badge + an audit-log entry (always — cheap).
          recordAbuseEvent({
            eventType: "SAGEMAKER_CAP_HIT",
            ip,
            path: "/api/yolo/run",
            details: {
              companyId: session.user.companyId,
              userId: session.user.dbId,
              projectId,
              capHit: cap.capHit,
              pagesToCharge,
              companyUsed: cap.companyUsed,
              companyLimit: cap.companyLimit,
              userUsed: cap.userUsed,
              userLimit: cap.userLimit,
            },
          });
          audit("yolo_cap_hit", {
            userId: session.user.dbId,
            companyId: session.user.companyId,
            details: {
              projectId,
              capHit: cap.capHit,
              pagesToCharge,
              companyUsed: cap.companyUsed,
              companyLimit: cap.companyLimit,
            },
          });
          // Optional SES alert — best-effort, throttled per company to avoid spam.
          if (
            process.env.ROOT_ADMIN_EMAIL &&
            (await shouldSendCapAlert(session.user.companyId)) // [P5.4-C] now async (runtime_counters)
          ) {
            try {
              await sendAlertEmail(
                process.env.ROOT_ADMIN_EMAIL,
                "BlueprintParser — SageMaker page cap hit",
                `<p>A YOLO run was blocked by the <b>${cap.capHit}</b> SageMaker page cap.</p>
               <ul>
                 <li>Company #${session.user.companyId}: ${cap.companyUsed}/${cap.companyLimit} pages used</li>
                 ${cap.userLimit !== null ? `<li>User #${session.user.dbId}: ${cap.userUsed}/${cap.userLimit} pages used</li>` : ""}
                 <li>Blocked run needed ${pagesToCharge} pages (project ${projectId})</li>
               </ul>
               <p>Raise the limit or reset the counter in Admin &rarr; Usage.</p>`,
              );
            } catch (mailErr) {
              logger.error("Cap-hit alert email failed:", mailErr);
            }
          }
          // cap.message is typed optional but is always set on denial (legacy serialized it
          // directly); cast keeps byte-faithfulness without inventing a fallback string.
          throw new ApiError("RATE_LIMITED", cap.message as string);
        }
        reservationId = cap.reservationId;
      }

      // Allocate and persist the provider identity before contacting SageMaker. The AWS SDK can
      // time out after CreateProcessingJob was accepted; the durable running intent then remains a
      // fail-closed publication blocker and gives operators an exact identity to reconcile.
      const jobName = createYoloJobName(model.name);
      let pendingJobId: number;
      try {
        pendingJobId = await withProjectWrite(
          writeCapability,
          project.id,
          async (tx) => {
            const [job] = await tx
              .insert(processingJobs)
              .values({
                projectId: project.id,
                executionId: jobName,
                status: "running",
                modelConfig: { modelId: model.id, modelName: model.name },
              })
              .returning({ id: processingJobs.id });
            if (!job) throw new Error("Failed to create YOLO job intent");
            return job.id;
          },
        );
      } catch (err) {
        if (reservationId !== undefined) {
          await releaseReservation(reservationId).catch((releaseError) => {
            logger.error(
              "compute_usage reservation rollback failed:",
              releaseError,
            );
          });
        }
        throw err;
      }

      // Start SageMaker job
      try {
        await startYoloJob(project.dataUrl, model.s3Path, model.name, jobName);
      } catch (err) {
        // Refused (AWS-confirmed) → row closed as failed + reservation released; else the intent stays.
        const { refused, set } = startFailureRowPatch(err);
        const retired = await withProjectWrite(writeCapability, project.id, async (tx) => {
          await tx.update(processingJobs).set(set).where(eq(processingJobs.id, pendingJobId));
          return refused;
        }).catch((jobError) => (logger.error("YOLO job intent update failed:", jobError), false));
        if (retired && reservationId !== undefined) await releaseReservation(reservationId).catch((e) => logger.error("compute_usage reservation rollback failed:", e));
        throw startFailureAnswer(err, "YOLO");
      }

      // Persist metered usage — source of truth for the page caps + Usage
      // dashboard. Non-root: the pages were reserved pre-job, so just attach the
      // jobId. Root: bypassed the cap, so record the usage row now (visibility).
      // Defensive: a ledger hiccup must not fail an already-started job.
      try {
        if (reservationId !== undefined) {
          await stampReservationJob(reservationId, jobName);
        } else {
          await recordComputeUsage({
            companyId: session.user.companyId,
            userId: session.user.dbId,
            projectId: project.id,
            resource: "sagemaker",
            pages: pagesToCharge,
            jobId: jobName,
          });
        }
      } catch (usageErr) {
        logger.error(
          "compute_usage persist failed (job already started):",
          usageErr,
        );
      }

      audit("yolo_job_started", {
        userId: session.user.dbId,
        companyId: session.user.companyId,
        details: { projectId, modelId, jobName, pages: pagesToCharge },
      });

      return { jobName, status: "running" };
    },
  );
}

// ── POST /api/yolo/load ───────────────────────────────────────────────────────
export async function yoloLoad(
  rawBody: Record<string, unknown>, asSession?: AuthSession, // set ONLY by the running-jobs catch-up (admin-route session)
): Promise<unknown> {
  const { projectId, modelId, modelName } = rawBody as {
    projectId?: string;
    modelId?: number;
    modelName?: string;
  };

  await assertDemoYoloTargetReadOnly(projectId);

  // YQ-2: signed-out gets the SAME 403 as a non-admin (legacy quirk, S020 class) —
  // the service resolves auth itself; auth:"admin" in the shell would 401 first.
  const session = asSession ?? ((await auth()) as unknown as AuthSession | null);
  if (
    !session?.user ||
    (session.user.role !== "admin" && !session.user.isRootAdmin)
  ) {
    throw new ApiError("FORBIDDEN", "Admin only");
  }

  const [project] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.publicId, projectId as string),
        eq(projects.companyId, session.user.companyId),
      ),
    )
    .limit(1);

  if (!project) {
    throw new ApiError("NOT_FOUND", "Project not found");
  }
  const writeCapability = assertProjectWritable(project);

  return withProjectMutationLease(
    writeCapability,
    { kind: "yolo-load", idempotencyKey: `model:${String(modelId)}` },
    async () => {
      // Get model for class names
      const [model] = await db
        .select()
        .from(models)
        .where(eq(models.id, modelId as number))
        .limit(1);

      // Extract class-level CSI codes and keywords from model config
      // (unknown modelId deliberately PROCEEDS with empty config — YQ-5, frozen)
      const classCsiCodes = model?.config?.classCsiCodes || {};
      const classKeywords = model?.config?.classKeywords || {};

      const outputPrefix = `${project.dataUrl}/yolo-output/${modelName}/`;
      // [fix 2026-10-23 page-permanent-delete] A permanently deleted page may leave its
      // page_NNNN.json behind (S3 delete is best-effort); with page rows present, a file whose
      // page has no row is skipped so the deleted page's annotations never come back. A project
      // with NO page rows at all (legacy) keeps the old behaviour: every file loads.
      const pageRowSet = new Set((await db.select({ n: pages.pageNumber }).from(pages).where(eq(pages.projectId, project.id))).map((r) => r.n));
      let filesSkippedNoPage = 0; // logged below; the response shape is frozen (yolo.route.test.ts)

      // List all JSON result files
      const listed = await loadS3Client.send(
        new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: outputPrefix }),
      );

      if (!listed.Contents || listed.Contents.length === 0) {
        throw new ApiError("NOT_FOUND", "No results found");
      }

      // Collect all detections first, then batch insert
      const allValues: Array<{
        name: string;
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
        pageNumber: number;
        threshold: number;
        data: Record<string, unknown>;
        source: string;
        projectId: number;
      }> = [];

      let filesProcessed = 0;

      for (const obj of listed.Contents) {
        if (!obj.Key?.endsWith(".json") || obj.Key.endsWith("_manifest.json"))
          continue;

        const getObj = await loadS3Client.send(
          new GetObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key }),
        );
        const body = await getObj.Body?.transformToString();
        if (!body) continue;

        try {
          const result = JSON.parse(body);
          const detections = result.detections || [];

          const filename = obj.Key.split("/").pop() || "";
          const pageMatch = filename.match(/page_(\d+)/);
          const pageNumber = pageMatch ? parseInt(pageMatch[1]) : 0;
          if (pageNumber === 0) continue;
          if (pageRowSet.size > 0 && !pageRowSet.has(pageNumber)) { filesSkippedNoPage++; continue; }

          filesProcessed++;

          for (const det of detections) {
            const [x1, y1, x2, y2] = det.bbox_normalized ||
              det.bbox || [0, 0, 0, 0];

            const className = det.class_name || `class_${det.class_id}`;
            allValues.push({
              name: className,
              minX: x1,
              minY: y1,
              maxX: x2,
              maxY: y2,
              pageNumber,
              threshold: det.confidence,
              data: {
                modelId: modelId,
                modelName: modelName,
                classId: det.class_id,
                confidence: det.confidence,
                csiCodes: classCsiCodes[className] || [],
                keywords: classKeywords[className] || [],
              },
              source: "yolo",
              projectId: project.id,
            });
          }
        } catch (err) {
          logger.error(`Failed to parse ${obj.Key}:`, err);
        }
      }

      if (filesSkippedNoPage > 0) logger.info(`[YOLO-LOAD] skipped ${filesSkippedNoPage} result file(s) whose page has no row (permanently deleted)`);
      if (allValues.length === 0) {
        return {
          success: false,
          detectionsLoaded: 0,
          filesProcessed,
          error: "No detections found in result files", // in-band 200 error — never flips (YQ-5)
        };
      }

      // [refactor jul23 P4.1 U7] Log-mode observe of the yolo-detection blobs about to be
      // persisted (the exact array, mapped pre-tx). gate:false PERMANENTLY (RD-U7a): a throw
      // here would poison the whole load — these blobs are fixed-key literals that never
      // stamp v, so the gate is moot; the flag makes "log+skip permanent" explicit.
      observeAnnotationDataBatch(
        allValues.map((v) => v.data),
        "yolo.load",
        { gate: false },
      );

      let totalInserted = 0;
      let deletedPrevious = 0;
      let firstError: string | null = null;

      try {
        await withProjectWrite(writeCapability, project.id, async (tx) => {
          const deleted = await tx
            .delete(annotations)
            .where(
              and(
                eq(annotations.projectId, project.id),
                eq(annotations.source, "yolo"),
                sql`(${annotations.data}->>'modelId' = ${String(modelId)} OR ${annotations.data}->>'modelName' = ${String(modelName)})`, // [fix 2026-10-22] S3 is read by NAME: a re-registered model (new id) replaces, not doubles
              ),
            )
            .returning({ id: annotations.id });
          deletedPrevious = deleted.length;

          // Keep parameter counts bounded for projects with many detections while preserving one
          // atomic replacement transaction for the project/model pair.
          const chunkSize = 500;
          for (let offset = 0; offset < allValues.length; offset += chunkSize) {
            const chunk = allValues.slice(offset, offset + chunkSize);
            await tx.insert(annotations).values(
              chunk.map((value) => ({
                ...value,
                source: "yolo" as const,
                creatorId: session.user.dbId,
              })),
            );
            totalInserted += chunk.length;
          }
        });
      } catch (err: any) {
        if (err instanceof ApiError) throw err;
        // in-band pg-error leak at 200 — pinned verbatim; P1-ledger in-band-leak candidate
        const dbError = err?.cause ?? err;
        firstError = `pg error: ${dbError?.message || dbError} (code: ${dbError?.code || "?"}, detail: ${dbError?.detail || "none"})`;
        logger.error("[YOLO-LOAD] Database error:", err);
      }

      // ─── Post-YOLO: Run heuristic engine with YOLO data ───
      if (totalInserted > 0) {
        try {
          // Fetch YOLO annotations + page data for heuristic re-evaluation.
          // `data` field is kept so we can extract modelName for the composite
          // region classifier (used to detect yolo_medium ∩ yolo_primitive
          // drawings agreement).
          const yoloAnns = await db
            .select({
              name: annotations.name,
              minX: annotations.minX,
              minY: annotations.minY,
              maxX: annotations.maxX,
              maxY: annotations.maxY,
              pageNumber: annotations.pageNumber,
              data: annotations.data,
            })
            .from(annotations)
            .where(
              and(
                eq(annotations.projectId, project.id),
                eq(annotations.source, "yolo"),
              ),
            );

          const projectPages = await db
            .select({
              id: pages.id,
              pageNumber: pages.pageNumber,
              rawText: pages.rawText,
              pageIntelligence: pages.pageIntelligence,
              csiCodes: pages.csiCodes,
              textractData: pages.textractData, // [regions v2] OCR words + Textract tables for the shadow classifier
            })
            .from(pages)
            .where(eq(pages.projectId, project.id));

          // Fetch company heuristic config + Stage 2d pipeline toggles.
          // Absent flags → legacy defaults (heatmap + ensemble on).
          // [refactor jul9 P2-A S1] Stage 2c (auto-table-detector → autoTableProposals)
          // removed here: the STORED key had zero readers repo-wide (U1-F1); the
          // auto-detect-tables route computes proposals on demand from ensembleRegions.
          let companyHeuristics: any[] | undefined;
          let heatmapEnabled = true;
          let ensembleEnabled = true;
          let ensembleConfig: ReturnType<typeof resolvePipelineToggles>["ensembleConfig"];
          try {
            const [company] = await db
              .select({ pipelineConfig: companies.pipelineConfig })
              .from(companies)
              .where(eq(companies.id, project.companyId))
              .limit(1);
            companyHeuristics = company?.pipelineConfig?.heuristics;
            // [fix 2026-10-24 T1a] top level, else the Pipeline tab's legacy nested copy.
            const toggles = resolvePipelineToggles(company?.pipelineConfig);
            heatmapEnabled = !toggles.disabledSteps.has("yolo-heatmap");
            ensembleEnabled = !toggles.disabledSteps.has("ensemble");
            ensembleConfig = toggles.ensembleConfig;
          } catch {
            /* use defaults */
          }

          const rules = getEffectiveRules(companyHeuristics);

          // Group YOLO detections by page. Include modelName so the composite
          // region classifier can detect cross-model drawings agreement.
          const yoloByPage = new Map<
            number,
            Array<{
              name: string;
              minX: number;
              minY: number;
              maxX: number;
              maxY: number;
              confidence: number;
              modelName?: string;
            }>
          >();
          for (const a of yoloAnns) {
            if (!yoloByPage.has(a.pageNumber)) yoloByPage.set(a.pageNumber, []);
            const data = a.data as {
              confidence?: number;
              modelName?: string;
            } | null;
            yoloByPage.get(a.pageNumber)!.push({
              name: a.name,
              minX: a.minX,
              minY: a.minY,
              maxX: a.maxX,
              maxY: a.maxY,
              confidence: data?.confidence ?? 0,
              modelName: data?.modelName,
            });
          }

          // Run heuristics + composite classifier per page with YOLO data
          for (const page of projectPages) {
            const yoloDets = yoloByPage.get(page.pageNumber);
            if (!yoloDets?.length) continue;

            // [fix 2026-10-24 T1a] heuristics → tables → composite → heatmap → ensemble live in
            // yolo-post-enrichment.ts (unit-tested); it gets the page's REAL csiCodes.
            const { updated, pageChanged } = enrichPageAfterYolo(
              {
                pageNumber: page.pageNumber,
                rawText: page.rawText,
                pageIntelligence: page.pageIntelligence,
                csiCodes: page.csiCodes,
                textractData: page.textractData as TextractPageData | null,
              },
              yoloDets,
              { rules, heatmapEnabled, ensembleEnabled, ensembleConfig },
            );

            // Merge YOLO CSI codes from model class config into page-level csiCodes.
            // [refactor jul23 P4.1 U9] Unified onto mergeCsiCodes (was a hand-rolled
            // raw-code dedupe loop). mergeCsiCodes builds byte-identical placeholder
            // objects for {code, description:"From YOLO class config"} — division defaults
            // to code.substring(0,2), trade to "" — so this is an identity swap (pinned by
            // the pre-swap equivalence net in csi-utils.test.ts), and yolo now inherits the
            // separator-strip-only dedupe key for free instead of maintaining a parallel
            // raw-code dedupe. Write-guard preserved verbatim: only persist when NEW codes
            // were actually added (newCsi.length > existing.length).
            let mergedCsiCodes: CsiCode[] | undefined;
            const allYoloCsi = new Set<string>();
            for (const codes of Object.values(classCsiCodes)) {
              for (const code of codes) allYoloCsi.add(code);
            }
            if (allYoloCsi.size > 0) {
              const existingPageCsi = (page.csiCodes || []) as CsiCode[];
              const newCsi = mergeCsiCodes(
                existingPageCsi,
                [...allYoloCsi].map((code) => ({
                  code,
                  description: "From YOLO class config",
                })),
              );
              if (newCsi.length > existingPageCsi.length) {
                mergedCsiCodes = newCsi;
              }
            }

            if (pageChanged || mergedCsiCodes) {
              await withProjectWrite(
                writeCapability,
                project.id,
                async (tx) => {
                  await tx
                    .update(pages)
                    .set({
                      ...(pageChanged ? { pageIntelligence: updated } : {}),
                      ...(mergedCsiCodes ? { csiCodes: mergedCsiCodes } : {}),
                    })
                    .where(eq(pages.id, page.id));
                },
              );
            }
          }
          logger.info(
            `[YOLO-LOAD] Post-YOLO heuristic engine ran on ${projectPages.length} pages`,
          );
        } catch (err) {
          logger.error("[YOLO-LOAD] Post-YOLO heuristic engine failed:", err);
        }
      }

      // Recompute project summaries (annotation counts changed after YOLO load)
      try {
        await computeProjectSummaries(project.id, writeCapability);
        logger.info(`[YOLO-LOAD] Project summaries recomputed`);
      } catch (err) {
        logger.error("[YOLO-LOAD] Summary recomputation failed:", err);
      }

      return {
        success: totalInserted > 0,
        detectionsLoaded: totalInserted,
        deletedPrevious,
        filesProcessed,
        ...(firstError && { error: firstError }),
      };
    },
  );
}
