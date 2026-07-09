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
//     audit+throttled-SES, reservation rollback, ledger-failure swallow; load's raw pg
//     Pool via dynamic import("pg") KEPT VERBATIM incl. the in-band firstError leak AT
//     200 [P1-ledger candidate], file-loop fallback chains, PI spread-merge, csi merge,
//     soft-fail cascade).
//   • Sanctioned diff B: status's fixed "Failed to check status" + run's outer
//     err.message leak → shell generic INTERNAL 500; run's "Failed to start SageMaker
//     job: <msg>" → ApiError INTERNAL "Failed to start SageMaker job" (suffix dropped —
//     UQ-2/symbol-search truncation precedent). load has NO outer catch to retire (its
//     errors are in-band by design).

import { auth } from "@/lib/auth";
import type { AuthSession } from "@/lib/api-utils";
import { assertDemoFeatureEnabled } from "@/lib/demo-features";
import { db } from "@/lib/db";
import { projects, models, modelAccess, processingJobs, pages, annotations, companies } from "@/lib/db/schema";
import { eq, and, or, isNull } from "drizzle-orm";
import { startYoloJob, getYoloJobStatus } from "@/lib/yolo";
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
import { getEffectiveRules, runHeuristicEngine } from "@/lib/heuristic-engine";
import { classifyTables } from "@/lib/table-classifier";
import { classifyPageRegions } from "@/lib/composite-classifier";
import { computeYoloHeatmap } from "@/lib/spatial/yolo-heatmap";
import { reduceRegionVotes } from "@/lib/ensemble/region-ensemble";
import { collectAllVotes } from "@/lib/ensemble/vote-adapters";
import type { ClassifiedTable } from "@/types";
import { computeProjectSummaries } from "@/lib/project-analysis";
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { logger } from "@/lib/logger";
import { ApiError } from "@/server/api/envelope";

/** YOLO classes aggregated by Layer 2 heatmap. Generic multi-class density —
 *  not notes-specific; used by LLM context + Stage 2b ensemble reducer. */
const HEATMAP_CLASSES = ["text_box", "vertical_area", "horizontal_area"] as const;

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
export async function yoloStatus(req: Request): Promise<unknown> {
  const url = new URL(req.url);
  const jobName = url.searchParams.get("jobName");

  if (!jobName) {
    throw new ApiError("VALIDATION", "jobName required");
  }
  // [S031 diff B] legacy caught here → fixed "Failed to check status" 500; retired —
  // an SFN failure now propagates to the shell's generic INTERNAL 500.
  const status = await getYoloJobStatus(jobName);
  return status;
}

// ── POST /api/yolo/run ────────────────────────────────────────────────────────
export async function yoloRun(rawBody: Record<string, unknown>, session: AuthSession, req: Request): Promise<unknown> {
  if (!session.user.canRunModels) {
    throw new ApiError("FORBIDDEN", "You don't have permission to run models. Ask your admin to enable it.");
  }

  // Check SageMaker toggle (persisted in S3) — always read fresh for safety
  const toggles = await getToggles(true);
  if (!toggles.sagemakerEnabled) {
    throw new ApiError("FORBIDDEN", "SageMaker is disabled by admin. Enable it in Admin > Toggles.");
  }

  // Check YOLO job quota
  if (toggles.quotaEnabled) {
    const quota = await checkYoloQuota(session.user.companyId);
    if (!quota.allowed) {
      // NO || fallback (YQ-3, frozen); message typed optional but always set on denial
      throw new ApiError("RATE_LIMITED", quota.message as string);
    }
  }

  const { projectId, modelId } = rawBody as { projectId?: string; modelId?: number };

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
        eq(projects.companyId, session.user.companyId)
      )
    )
    .limit(1);

  if (!project) {
    throw new ApiError("NOT_FOUND", "Project not found");
  }

  // A YOLO run submits a Processing job over the project's whole /pages/ prefix,
  // so it is charged the project's full page count. We need a known count to
  // meter; reject early if absent (unprocessed project). The actual cap check +
  // page reservation happens atomically just before the job starts (below).
  const pagesToCharge = project.numPages ?? 0;
  if (pagesToCharge <= 0) {
    throw new ApiError("VALIDATION", "Project page count is unknown. Reprocess the project before running models.");
  }

  // Runtime kill-switch — admin can disable YOLO on demo projects via the
  // Demo Features panel. Root admin bypass intentional for infra ops. (YQ-1b)
  if (project.isDemo && !session.user.isRootAdmin) {
    const gate = await assertDemoFeatureEnabled(project.companyId, "yoloRun");
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
      .where(and(
        eq(modelAccess.modelId, modelId),
        eq(modelAccess.companyId, companyId),
        eq(modelAccess.enabled, true),
        or(isNull(modelAccess.userId), eq(modelAccess.userId, session.user.dbId))
      ))
      .limit(1);
    if (!access) {
      throw new ApiError("NOT_FOUND", "Model not found"); // same msg — no existence leak (YQ-4)
    }
  }

  // Regenerate config.yaml from DB config before running — ensures admin changes take effect
  const conf = model.config?.confidence ?? 0.10;
  const iouVal = model.config?.iou ?? 0.60;
  const imgSize = model.config?.imageSize ?? 1280;
  const classList = model.config?.classes ?? [];

  const configYaml = `model_file: model.pt
confidence_threshold: ${conf}
iou_threshold: ${iouVal}
image_size: ${imgSize}
device: auto
half_precision: true
max_detections: ${model.config?.maxDetections ?? 2000}
save_annotated: false
classes:
${classList.map((c: string) => `  - ${c}`).join("\n")}
`;
  await uploadToS3(`${model.s3Path}/config.yaml`, Buffer.from(configYaml), "text/yaml");

  // [S031 diff B] the legacy outer try/catch (err.message leak) is RETIRED — the shell
  // owns unexpected 500s. The controlled returns below became ApiError throws (diff A).

  // Verify page PNGs exist from processing (stored at {dataUrl}/pages/)
  // SageMaker reads from this path directly — no rasterization needed
  try {
    await s3Client.send(new HeadObjectCommand({
      Bucket: S3_BUCKET,
      Key: `${project.dataUrl}/pages/page_0001.png`,
    }));
  } catch {
    throw new ApiError("VALIDATION", "Page images not found. The project needs to be processed first (or reprocessed if it was uploaded before the image pipeline was added).");
  }

  // ── SageMaker page cap — the money gate ──────────────────────────────
  // Atomically check the per-company net cap AND optional per-user sub-cap and
  // RESERVE the pages (advisory-locked, so concurrent runs can't both slip
  // past). Root admin bypasses the block (god-mode); its usage is recorded
  // below for visibility. Reserved-tenant isolation for root lands in slice 4.
  let reservationId: number | undefined;
  if (!session.user.isRootAdmin) {
    const cap = await reserveSagemakerPages(
      session.user.companyId,
      session.user.dbId,
      project.id,
      pagesToCharge
    );
    if (!cap.allowed) {
      // [DR003 FIX-1] legacy parity RESTORED: the shell now passes req through, so the
      // abuse row records the real client IP again (x-forwarded-for, first hop, trimmed).
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
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
        details: { projectId, capHit: cap.capHit, pagesToCharge, companyUsed: cap.companyUsed, companyLimit: cap.companyLimit },
      });
      // Optional SES alert — best-effort, throttled per company to avoid spam.
      if (process.env.ROOT_ADMIN_EMAIL && shouldSendCapAlert(session.user.companyId)) {
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
               <p>Raise the limit or reset the counter in Admin &rarr; Usage.</p>`
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

  // Start SageMaker job
  let jobName: string;
  try {
    jobName = await startYoloJob(
      project.dataUrl,
      model.s3Path,
      model.name
    );
  } catch (err) {
    // Roll back the reservation so a job that never started isn't charged.
    if (reservationId !== undefined) {
      try {
        await releaseReservation(reservationId);
      } catch (relErr) {
        logger.error("compute_usage reservation rollback failed:", relErr);
      }
    }
    logger.error("YOLO job start failed:", err);
    // [S031 sanction] legacy leaked `Failed to start SageMaker job: ${msg}` — suffix
    // dropped; the surviving message SURFACES at 500 (S024 pin class).
    throw new ApiError("INTERNAL", "Failed to start SageMaker job");
  }

  // Track job
  await db.insert(processingJobs).values({
    projectId: project.id,
    executionId: jobName,
    status: "running",
    modelConfig: { modelId: model.id, modelName: model.name },
  });

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
    logger.error("compute_usage persist failed (job already started):", usageErr);
  }

  audit("yolo_job_started", {
    userId: session.user.dbId,
    companyId: session.user.companyId,
    details: { projectId, modelId, jobName, pages: pagesToCharge },
  });

  return { jobName, status: "running" };
}

// ── POST /api/yolo/load ───────────────────────────────────────────────────────
export async function yoloLoad(rawBody: Record<string, unknown>): Promise<unknown> {
  // YQ-2: signed-out gets the SAME 403 as a non-admin (legacy quirk, S020 class) —
  // the service resolves auth itself; auth:"admin" in the shell would 401 first.
  const session = (await auth()) as unknown as AuthSession | null;
  if (!session?.user || (session.user.role !== "admin" && !session.user.isRootAdmin)) {
    throw new ApiError("FORBIDDEN", "Admin only");
  }

  const { projectId, modelId, modelName } = rawBody as {
    projectId?: string; modelId?: number; modelName?: string;
  };

  const [project] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.publicId, projectId as string),
        eq(projects.companyId, session.user.companyId)
      )
    )
    .limit(1);

  if (!project) {
    throw new ApiError("NOT_FOUND", "Project not found");
  }

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

  // List all JSON result files
  const listed = await loadS3Client.send(
    new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: outputPrefix })
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
    if (!obj.Key?.endsWith(".json") || obj.Key.endsWith("_manifest.json")) continue;

    const getObj = await loadS3Client.send(
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key })
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

      filesProcessed++;

      for (const det of detections) {
        const [x1, y1, x2, y2] = det.bbox_normalized || det.bbox || [0, 0, 0, 0];

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

  if (allValues.length === 0) {
    return {
      success: false,
      detectionsLoaded: 0,
      filesProcessed,
      error: "No detections found in result files", // in-band 200 error — never flips (YQ-5)
    };
  }

  // Use raw pg Pool to bypass Drizzle entirely
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
  });

  let totalInserted = 0;
  let deletedPrevious = 0;
  let firstError: string | null = null;

  try {
    const client = await pool.connect();

    // Delete previous detections for this project+model to prevent duplicates
    try {
      const delResult = await client.query(
        `DELETE FROM annotations WHERE project_id = $1 AND source = 'yolo' AND data->>'modelId' = $2`,
        [project.id, String(modelId)]
      );
      deletedPrevious = delResult.rowCount || 0;
    } catch (delErr: any) {
      logger.warn("[YOLO-LOAD] Delete previous failed (non-fatal):", delErr?.message);
    }
    try {
      for (const v of allValues) {
        await client.query(
          `INSERT INTO annotations (name, min_x, max_x, min_y, max_y, page_number, threshold, data, source, project_id, creator_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
          [v.name, v.minX, v.maxX, v.minY, v.maxY, v.pageNumber, v.threshold, JSON.stringify(v.data), v.source, v.projectId, session.user.dbId]
        );
        totalInserted++;
      }
    } finally {
      client.release();
    }
  } catch (err: any) {
    // in-band pg-error leak at 200 — pinned verbatim; P1-ledger in-band-leak candidate
    firstError = `pg error: ${err?.message || err} (code: ${err?.code || "?"}, detail: ${err?.detail || "none"})`;
    logger.error("[YOLO-LOAD] Raw pg error:", err);
  } finally {
    await pool.end();
  }

  // ─── Post-YOLO: Run heuristic engine with YOLO data ───
  if (totalInserted > 0) {
    try {
      // Fetch YOLO annotations + page data for heuristic re-evaluation.
      // `data` field is kept so we can extract modelName for the composite
      // region classifier (used to detect yolo_medium ∩ yolo_primitive
      // drawings agreement).
      const yoloAnns = await db
        .select({ name: annotations.name, minX: annotations.minX, minY: annotations.minY, maxX: annotations.maxX, maxY: annotations.maxY, pageNumber: annotations.pageNumber, data: annotations.data })
        .from(annotations)
        .where(and(eq(annotations.projectId, project.id), eq(annotations.source, "yolo")));

      const projectPages = await db
        .select({ id: pages.id, pageNumber: pages.pageNumber, rawText: pages.rawText, pageIntelligence: pages.pageIntelligence, csiCodes: pages.csiCodes })
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
      let ensembleConfig: any;
      try {
        const [company] = await db
          .select({ pipelineConfig: companies.pipelineConfig })
          .from(companies)
          .where(eq(companies.id, project.companyId))
          .limit(1);
        companyHeuristics = company?.pipelineConfig?.heuristics;
        const disabledSteps = new Set(company?.pipelineConfig?.disabledSteps ?? []);
        heatmapEnabled = !disabledSteps.has("yolo-heatmap");
        ensembleEnabled = !disabledSteps.has("ensemble");
        ensembleConfig = company?.pipelineConfig?.ensemble?.config;
      } catch { /* use defaults */ }

      const rules = getEffectiveRules(companyHeuristics);

      // Group YOLO detections by page. Include modelName so the composite
      // region classifier can detect cross-model drawings agreement.
      const yoloByPage = new Map<number, Array<{ name: string; minX: number; minY: number; maxX: number; maxY: number; confidence: number; modelName?: string }>>();
      for (const a of yoloAnns) {
        if (!yoloByPage.has(a.pageNumber)) yoloByPage.set(a.pageNumber, []);
        const data = (a.data as { confidence?: number; modelName?: string } | null);
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

        const existing = (page.pageIntelligence || {}) as Record<string, unknown>;
        const updated: Record<string, unknown> = { ...existing };
        let pageChanged = false;

        // Existing: re-run heuristic engine with YOLO data
        const inferences = runHeuristicEngine(rules, {
          rawText: page.rawText || "",
          yoloDetections: yoloDets,
          textRegions: existing.textRegions as unknown,
          csiCodes: existing.csiCodes as unknown,
          pageNumber: page.pageNumber,
        } as Parameters<typeof runHeuristicEngine>[1]);

        if (inferences.length > 0) {
          updated.heuristicInferences = inferences;
          pageChanged = true;

          // Reclassify tables (OCR-keyword classifier) with YOLO-enriched heuristics
          const textRegions = (existing.textRegions as unknown[] | undefined) ?? [];
          if (textRegions.length > 0) {
            const classified = classifyTables({
              textRegions: textRegions as Parameters<typeof classifyTables>[0]["textRegions"],
              heuristicInferences: inferences,
              csiCodes: existing.csiCodes as Parameters<typeof classifyTables>[0]["csiCodes"],
              pageNumber: page.pageNumber,
            });
            if (classified.length > 0) updated.classifiedTables = classified;
          }
        }

        // NEW (QTO SHIP 1): composite region classifier — Layer 1 of the QTO
        // rebuild. Combines yolo class signals with OCR header keywords to
        // produce exclusion (tables, title_block) and inclusion (drawings)
        // zones. Runs regardless of heuristic inferences because a page can
        // have a tables bbox without any heuristic rule firing.
        try {
          const regions = classifyPageRegions({
            pageNumber: page.pageNumber,
            yoloAnnotations: yoloDets.map((d) => ({
              name: d.name,
              bbox: [d.minX, d.minY, d.maxX, d.maxY],
              modelName: d.modelName,
            })),
            textRegions: existing.textRegions as Parameters<typeof classifyPageRegions>[0]["textRegions"],
            parsedRegions: existing.parsedRegions as Parameters<typeof classifyPageRegions>[0]["parsedRegions"],
            legacyClassifiedTables: (updated.classifiedTables ?? existing.classifiedTables) as ClassifiedTable[] | undefined,
          });
          const hasRegions = regions.tables.length > 0
            || regions.titleBlocks.length > 0
            || regions.drawings.length > 0;
          if (hasRegions) {
            updated.classifiedRegions = regions;
            pageChanged = true;
          }
        } catch (err) {
          logger.error(`[YOLO-LOAD] classifyPageRegions failed for page ${page.pageNumber}:`, err);
        }

        // Stage 2a Layer 2: YOLO density heatmap — aggregates text_box +
        // vertical_area + horizontal_area into confident-region bboxes.
        // Universal spatial signal consumed by LLM context + Stage 2b ensemble.
        // Gated on pipelineConfig.heatmap.
        if (heatmapEnabled) {
          try {
            const heatmap = computeYoloHeatmap(page.pageNumber, yoloDets, {
              classes: [...HEATMAP_CLASSES],
            });
            if (heatmap.confidentRegions.length > 0
              || Object.values(heatmap.classContributions).some((v) => v > 0)) {
              updated.yoloHeatmap = heatmap;
              pageChanged = true;
            }
          } catch (err) {
            logger.error(`[YOLO-LOAD] computeYoloHeatmap failed for page ${page.pageNumber}:`, err);
          }
        }

        // Stage 2b: ensemble reducer — cross-signal agreement; suppresses
        // keyword-only false positives (the 2026-04-22 door-schedule screenshot bug).
        if (ensembleEnabled) {
          try {
            const votes = collectAllVotes({
              classifiedTables: updated.classifiedTables as ClassifiedTable[] | undefined,
              classifiedRegionsTables: (updated.classifiedRegions as any)?.tables,
              yoloHeatmap: updated.yoloHeatmap as any,
              parsedRegions: (existing.parsedRegions as any) ?? undefined,
            });
            if (votes.length > 0) {
              const ensembleRegions = reduceRegionVotes(page.pageNumber, votes, ensembleConfig);
              if (ensembleRegions.length > 0) {
                updated.ensembleRegions = ensembleRegions;
                pageChanged = true;
              }
            }
          } catch (err) {
            logger.error(`[YOLO-LOAD] ensemble reducer failed for page ${page.pageNumber}:`, err);
          }
        }

        if (pageChanged) {
          await db.update(pages).set({ pageIntelligence: updated }).where(eq(pages.id, page.id));
        }

        // Merge YOLO CSI codes from model class config into page-level csiCodes
        const allYoloCsi = new Set<string>();
        for (const codes of Object.values(classCsiCodes)) {
          for (const code of codes) allYoloCsi.add(code);
        }
        if (allYoloCsi.size > 0) {
          const existingPageCsi = (page.csiCodes || []) as any[];
          const existingSet = new Set(existingPageCsi.map((c: any) => c.code));
          const newCsi = [...existingPageCsi];
          for (const code of allYoloCsi) {
            if (!existingSet.has(code)) {
              newCsi.push({ code, description: "From YOLO class config", division: code.substring(0, 2), trade: "" });
            }
          }
          if (newCsi.length > existingPageCsi.length) {
            await db.update(pages).set({ csiCodes: newCsi }).where(eq(pages.id, page.id));
          }
        }
      }
      logger.info(`[YOLO-LOAD] Post-YOLO heuristic engine ran on ${projectPages.length} pages`);
    } catch (err) {
      logger.error("[YOLO-LOAD] Post-YOLO heuristic engine failed:", err);
    }
  }

  // Recompute project summaries (annotation counts changed after YOLO load)
  try {
    await computeProjectSummaries(project.id);
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
}
