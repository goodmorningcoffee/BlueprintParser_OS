// [fix 2026-10-24 admin-ui T1b, from admin_data_tools/DOUBLE_BACK] The recompute reprocess does
// after writing pages — project analysis over the VISIBLE pages (hidden duplicates excluded,
// lib/page-dedup visiblePage) followed by the project summaries. Shared by
// page-permanent-delete.ts (after deleting rows) and page-duplicates-apply.ts (after hiding or
// restoring: a hidden page leaves the analysis, a restored one re-enters it). Hide/restore used
// to leave projects.project_intelligence / project_summary describing the pre-hide page set.

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { pages, projects } from "@/lib/db/schema";
import { mergeProjectIntelligence } from "@/lib/intelligence-merge";
import { visiblePage } from "@/lib/page-dedup";
import { analyzeProject, computeProjectSummaries } from "@/lib/project-analysis";
import { withProjectWrite, type ProjectWriteCapability } from "@/server/api/project-write-capability";

export async function recomputeProject(projectId: number, capability: ProjectWriteCapability): Promise<void> {
  const visible = await db
    .select({ pageNumber: pages.pageNumber, drawingNumber: pages.drawingNumber, pageIntelligence: pages.pageIntelligence, csiCodes: pages.csiCodes })
    .from(pages)
    .where(and(eq(pages.projectId, projectId), visiblePage(pages.pageIntelligence)))
    .orderBy(pages.pageNumber);
  const { intelligence, summary } = analyzeProject(visible.map((p) => ({
    pageNumber: p.pageNumber, drawingNumber: p.drawingNumber, pageIntelligence: p.pageIntelligence ?? null, csiCodes: p.csiCodes,
  })));
  await withProjectWrite(capability, projectId, async (tx) => {
    const [current] = await tx.select({ pi: projects.projectIntelligence }).from(projects).where(eq(projects.id, projectId));
    await tx
      .update(projects)
      .set({ projectIntelligence: mergeProjectIntelligence(current?.pi, intelligence as Record<string, unknown>), projectSummary: summary })
      .where(eq(projects.id, projectId));
  });
  await computeProjectSummaries(projectId, capability);
}
