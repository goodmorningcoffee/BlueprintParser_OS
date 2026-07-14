/**
 * backfill-summaries.ts
 *
 * One-time script to compute ProjectSummaries for all existing projects
 * that were processed before the chunking feature was added.
 *
 * Usage:
 *   npx tsx scripts/backfill-summaries.ts
 *
 * Or via the admin reprocess endpoint (which now includes summary computation).
 */

import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { computeProjectSummaries } from "@/lib/project-analysis";
import { assertProjectWritable } from "@/server/api/project-write-capability";

async function main() {
  console.log("[backfill] Starting summary backfill...");

  const allProjects = await db
    .select({
      id: projects.id,
      publicId: projects.publicId,
      companyId: projects.companyId,
      isDemo: projects.isDemo,
      lifecycleEpoch: projects.lifecycleEpoch,
      name: projects.name,
      status: projects.status,
      updatedAt: projects.updatedAt,
      projectIntelligence: projects.projectIntelligence,
    })
    .from(projects)
    .where(and(eq(projects.status, "completed"), eq(projects.isDemo, false)));

  console.log(`[backfill] Found ${allProjects.length} completed projects`);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const project of allProjects) {
    const pi = project.projectIntelligence as Record<string, unknown> | null;
    if (pi?.summaries) {
      skipped++;
      console.log(`[backfill] Skipping "${project.name}" (already has summaries)`);
      continue;
    }

    try {
      await computeProjectSummaries(project.id, assertProjectWritable(project));
      updated++;
      console.log(`[backfill] Computed summaries for "${project.name}" (${updated}/${allProjects.length})`);
    } catch (err) {
      failed++;
      console.error(`[backfill] FAILED for "${project.name}":`, err);
    }
  }

  console.log(`\n[backfill] Done. Updated: ${updated}, Skipped: ${skipped}, Failed: ${failed}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill] Fatal error:", err);
  process.exit(1);
});
