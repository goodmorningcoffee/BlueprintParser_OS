// SQL predicates for "not a hidden duplicate" (admin data tools, feature 2). A page is hidden
// iff pages.page_intelligence.duplicateOf.hiddenAt is set; restore deletes the whole mark, so
// the page reappears. Used by every project-wide read surface (search, chat context, LLM tools).
// A request naming one page (page chat, a tool call with pageNumber) still sees it: direct
// navigation to a hidden page works.
//
// Columns are passed in, so this module never imports the DB layer (check:architecture).

import { sql, type AnyColumn, type SQL } from "drizzle-orm";

/** `pageIntelligence` is pages.page_intelligence: true when that page row is not hidden. */
export function visiblePage(pageIntelligence: AnyColumn): SQL {
  return sql`(${pageIntelligence} #>> '{duplicateOf,hiddenAt}') IS NULL`;
}

/** For rows keyed by (project_id, page_number), e.g. annotations: their page is not hidden. */
export function onVisiblePage(projectId: AnyColumn, pageNumber: AnyColumn): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM pages hp WHERE hp.project_id = ${projectId} AND hp.page_number = ${pageNumber} AND (hp.page_intelligence #>> '{duplicateOf,hiddenAt}') IS NOT NULL)`;
}
