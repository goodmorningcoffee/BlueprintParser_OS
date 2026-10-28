/**
 * Standalone processing worker for Step Functions / ECS tasks.
 *
 * Reads PROJECT_ID from env, runs the same processProject() pipeline
 * that the web container uses, writes results directly to the database,
 * and exits with code 0 (success) or 1 (failure).
 *
 * Step Functions watches the exit code to determine task success/failure.
 */
import { processProject } from "@/lib/processing";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { assertProjectWritable } from "@/server/api/project-write-capability";
import { notifyProcessingWebhook } from "@/lib/processing-webhook-notify";
import { parseEngineMode, readParseEngineFlags } from "@/server/services/parse-engine/flags";

async function main() {
  const projectId = parseInt(process.env.PROJECT_ID || "", 10);
  if (!projectId || isNaN(projectId)) {
    console.error("PROJECT_ID environment variable required");
    process.exit(1);
  }

  const [project] = await db
    .select({
      id: projects.id,
      publicId: projects.publicId,
      companyId: projects.companyId,
      isDemo: projects.isDemo,
      lifecycleEpoch: projects.lifecycleEpoch,
      updatedAt: projects.updatedAt,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw new Error(`Project ${projectId} not found`);

  console.log(`[worker] Processing project ${projectId}...`);
  // [table-pipeline WP-3.J] tools.notesAuto for the A03/A12 notes stages (read here; lib never reads app_settings).
  const notesAuto = parseEngineMode(await readParseEngineFlags(), "notesAuto");
  const result = await processProject(projectId, assertProjectWritable(project), { notesAuto });
  console.log(
    `[worker] Done: ${result.pagesProcessed} pages processed, ${result.pageErrors} errors, ${result.processingTime}s`
  );

  // Webhook notification, retried (res.ok checked). Success path only — see the helper's header.
  const webhookUrl = process.env.WEBHOOK_URL;
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (webhookUrl && webhookSecret) {
    const totalPages = result.pagesProcessed + result.pageErrors;
    await notifyProcessingWebhook({
      url: webhookUrl,
      secret: webhookSecret,
      body: {
        projectId,
        // [refactor jun13 P0.5-G1] pages stay empty (processProject already
        // wrote them to the DB) but real counts ride along for logging. No
        // `error` field on purpose: processing.ts wrote the real
        // processingError; omitting it means the webhook leaves it untouched.
        pages: [],
        pagesProcessed: result.pagesProcessed,
        pageErrors: result.pageErrors,
        status:
          totalPages > 0 && result.pageErrors === totalPages
            ? "error"
            : "completed",
        processingTime: result.processingTime,
      },
    });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[worker] Fatal error:", err);
    process.exit(1);
  });
