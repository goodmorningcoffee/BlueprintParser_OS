// [feat 2026-10-23 page-permanent-delete] Page counts for the project lists — VISIBLE pages only.
// A hidden duplicate (pages.page_intelligence.duplicateOf.hiddenAt) is out of the page list,
// search, chat and AI tools, so the list's "N pages" must not count it either. Query shapes are
// the ones projects.ts kept verbatim (listProjects: one GROUP BY via db.execute; listDemoProjects:
// one db.execute count per demo project — its route test pins a throw there as a 500) with the
// visibility predicate added; the queries moved here because projects.ts sits at its line ceiling.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { visiblePage } from "@/lib/page-dedup";

/** project id → visible page count, for every project that has a visible page. */
export async function visiblePageCountsByProject(): Promise<Record<number, number>> {
  const result = await db.execute(sql`
    SELECT project_id, COUNT(*)::int AS cnt FROM pages WHERE ${visiblePage(pages.pageIntelligence)} GROUP BY project_id
  `);
  const counts: Record<number, number> = {};
  for (const row of result.rows as { project_id: number; cnt: number }[]) counts[row.project_id] = row.cnt;
  return counts;
}

/** Visible page count of one project (0 when it has none). */
export async function visiblePageCount(projectId: number): Promise<number> {
  const result = await db.execute(sql`
    SELECT COUNT(*)::int AS cnt FROM pages WHERE project_id = ${projectId} AND ${visiblePage(pages.pageIntelligence)}
  `);
  return (result.rows[0] as { cnt?: number } | undefined)?.cnt || 0;
}
