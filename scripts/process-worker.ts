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

async function main() {
  const projectId = parseInt(process.env.PROJECT_ID || "", 10);
  if (!projectId || isNaN(projectId)) {
    console.error("PROJECT_ID environment variable required");
    process.exit(1);
  }

  console.log(`[worker] Processing project ${projectId}...`);
  const result = await processProject(projectId);
  console.log(
    `[worker] Done: ${result.pagesProcessed} pages processed, ${result.pageErrors} errors, ${result.processingTime}s`
  );

  // Optional webhook notification (for Step Functions status tracking)
  const webhookUrl = process.env.WEBHOOK_URL;
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (webhookUrl && webhookSecret) {
    const totalPages = result.pagesProcessed + result.pageErrors;
    await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${webhookSecret}`,
        "x-webhook-timestamp": `${Date.now()}`,
      },
      body: JSON.stringify({
        projectId,
        pages: [],
        status:
          totalPages > 0 && result.pageErrors === totalPages
            ? "error"
            : "completed",
        processingTime: result.processingTime,
      }),
    }).catch((err: unknown) =>
      console.warn("[worker] Webhook notification failed:", err)
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[worker] Fatal error:", err);
    process.exit(1);
  });
