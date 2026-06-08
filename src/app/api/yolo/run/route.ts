import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-utils";
import { assertDemoFeatureEnabled } from "@/lib/demo-features";
import { db } from "@/lib/db";
import { projects, models, modelAccess, processingJobs } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { startYoloJob } from "@/lib/yolo";
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
import { logger } from "@/lib/logger";

export async function POST(req: Request) {
  const { session, error } = await requireAuth();
  if (error) return error;
  if (!session.user.canRunModels) {
    return NextResponse.json({ error: "You don't have permission to run models. Ask your admin to enable it." }, { status: 403 });
  }

  // Check SageMaker toggle (persisted in S3) — always read fresh for safety
  const toggles = await getToggles(true);
  if (!toggles.sagemakerEnabled) {
    return NextResponse.json({ error: "SageMaker is disabled by admin. Enable it in Admin > Toggles." }, { status: 403 });
  }

  // Check YOLO job quota
  if (toggles.quotaEnabled) {
    const quota = await checkYoloQuota(session.user.companyId);
    if (!quota.allowed) {
      return NextResponse.json({ error: quota.message }, { status: 429 });
    }
  }

  const { projectId, modelId } = await req.json();

  if (!projectId || !modelId) {
    return NextResponse.json(
      { error: "projectId and modelId required" },
      { status: 400 }
    );
  }

  // Verify project
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
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // A YOLO run submits a Processing job over the project's whole /pages/ prefix,
  // so it is charged the project's full page count. We need a known count to
  // meter; reject early if absent (unprocessed project). The actual cap check +
  // page reservation happens atomically just before the job starts (below).
  const pagesToCharge = project.numPages ?? 0;
  if (pagesToCharge <= 0) {
    return NextResponse.json(
      { error: "Project page count is unknown. Reprocess the project before running models." },
      { status: 400 }
    );
  }

  // Runtime kill-switch — admin can disable YOLO on demo projects via the
  // Demo Features panel. Root admin bypass intentional for infra ops.
  if (project.isDemo && !session.user.isRootAdmin) {
    const gate = await assertDemoFeatureEnabled(project.companyId, "yoloRun");
    if (gate) return gate;
  }

  // Get model
  const [model] = await db
    .select()
    .from(models)
    .where(eq(models.id, modelId))
    .limit(1);

  if (!model) {
    return NextResponse.json({ error: "Model not found" }, { status: 404 });
  }

  // Verify model access: must be owned by company OR have an enabled model_access row
  const companyId = (session.user as any).companyId;
  if (model.companyId !== companyId) {
    const [access] = await db
      .select()
      .from(modelAccess)
      .where(and(eq(modelAccess.modelId, modelId), eq(modelAccess.companyId, companyId), eq(modelAccess.enabled, true)))
      .limit(1);
    if (!access) {
      return NextResponse.json({ error: "Model not found" }, { status: 404 });
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

  try {
    // Verify page PNGs exist from processing (stored at {dataUrl}/pages/)
    // SageMaker reads from this path directly — no rasterization needed
    try {
      await s3Client.send(new HeadObjectCommand({
        Bucket: S3_BUCKET,
        Key: `${project.dataUrl}/pages/page_0001.png`,
      }));
    } catch {
      return NextResponse.json(
        { error: "Page images not found. The project needs to be processed first (or reprocessed if it was uploaded before the image pipeline was added)." },
        { status: 400 }
      );
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
        return NextResponse.json({ error: cap.message }, { status: 429 });
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
      const msg = err instanceof Error ? err.message : "unknown";
      return NextResponse.json(
        { error: `Failed to start SageMaker job: ${msg}` },
        { status: 500 }
      );
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

    return NextResponse.json({ jobName, status: "running" });
  } catch (err) {
    logger.error("YOLO job start failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to start YOLO" },
      { status: 500 }
    );
  }
}
