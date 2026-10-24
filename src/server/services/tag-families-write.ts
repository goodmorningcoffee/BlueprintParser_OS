// [tag-mapping v2 2026-10-24] The project's tag families (lib/shape-ensemble/families.ts) from its
// pages' `pageIntelligence.shapes` summaries → `projects.projectIntelligence.tagFamilies` (other keys
// untouched — mergeProjectIntelligence). Read by tag mapping and the knowledge graph
// (services/project-graph.ts loadTagFamilies via storedTagFamilies).
// ONE writer, two callers, both under their own durable lease:
//   • yolo/load (services/yolo.ts) passes the pages' in-memory next intelligence;
//   • the intelligence reprocess (services/reprocess.ts) passes nothing — the summaries are read
//     back from the pages it just wrote (only the `shapes` key, never a whole page row).

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { pages, projects } from "@/lib/db/schema";
import { mergeProjectIntelligence } from "@/lib/intelligence-merge";
import { tagFamiliesFromStoredPages, type TagFamiliesSummary } from "@/lib/shape-ensemble";
import { type ProjectWriteCapability, withProjectWrite } from "@/server/api/project-write-capability";

export type ShapePage = { pageNumber: number; pageIntelligence: unknown };

/** All the project's pages, each carrying only its stored `shapes` summary (null when absent). */
export async function loadProjectShapePages(projectId: number): Promise<ShapePage[]> {
  const rows = await db
    .select({ pageNumber: pages.pageNumber, shapes: sql<unknown>`${pages.pageIntelligence}->'shapes'` })
    .from(pages)
    .where(eq(pages.projectId, projectId))
    .orderBy(pages.pageNumber);
  return rows.map((r) => ({ pageNumber: r.pageNumber, pageIntelligence: r.shapes == null ? null : { shapes: r.shapes } }));
}

/** Recompute and persist the project's tag families; `shapePages` absent → read from the DB. */
export async function writeProjectTagFamilies(
  writeCapability: ProjectWriteCapability,
  projectId: number,
  shapePages?: readonly ShapePage[],
): Promise<TagFamiliesSummary> {
  const tagFamilies = tagFamiliesFromStoredPages(shapePages ?? (await loadProjectShapePages(projectId)));
  await withProjectWrite(writeCapability, projectId, async (tx) => {
    const [current] = await tx.select({ pi: projects.projectIntelligence }).from(projects).where(eq(projects.id, projectId));
    await tx.update(projects)
      .set({ projectIntelligence: mergeProjectIntelligence(current?.pi, { tagFamilies }) })
      .where(eq(projects.id, projectId));
  });
  return tagFamilies;
}
