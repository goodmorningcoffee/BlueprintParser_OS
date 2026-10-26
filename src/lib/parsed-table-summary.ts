/**
 * Identity of a `summaries.parsedTables[]` entry (K11, TP-1 WP-1.A).
 *
 * A summary entry is all a consumer has for a table on a page outside the loaded window, and it
 * used to carry no id: Auto-QTO re-found the region with `tableName === name || category ===
 * category`, so a click on a continuation schedule copied the FIRST same-category table's rows.
 * Summaries now carry `regionId`; this module is the one place that turns an entry back into its
 * region. Pure and client-safe (no server imports).
 */

type RegionLike = { id?: unknown; type?: unknown; category?: unknown; data?: unknown };

/** The display name a summary entry is built with (`computeProjectSummaries`). */
export function summaryTableName(region: RegionLike): string {
  const data = region.data as { tableName?: unknown } | null | undefined;
  const tableName = typeof data?.tableName === "string" ? data.tableName : "";
  const category = typeof region.category === "string" ? region.category : "";
  return tableName || category || "Unnamed Table";
}

/**
 * The region a summary entry names. With `regionId` the match is exact and nothing else is tried,
 * so a deleted region resolves to nothing rather than to a sibling. Without it (summaries computed
 * before TP-1) only a schedule/keynote region whose summary name equals the entry's name matches;
 * a category alone never does.
 */
export function findSummaryRegion<R extends RegionLike>(
  regions: readonly R[] | null | undefined,
  entry: { name: string; regionId?: string },
): R | undefined {
  if (!Array.isArray(regions)) return undefined;
  if (entry.regionId) return regions.find((region) => region.id === entry.regionId);
  return regions.find((region) =>
    (region.type === "schedule" || region.type === "keynote") &&
    summaryTableName(region) === entry.name);
}
