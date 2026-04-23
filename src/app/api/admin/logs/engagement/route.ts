import { NextResponse } from "next/server";
import { requireRootAdmin } from "@/lib/api-utils";
import { runInsightsQuery, type InsightsWindow } from "@/lib/admin-logs/cw-logs";
import { labelFor } from "@/lib/admin-logs/feature-map";
import { logger } from "@/lib/logger";

/**
 * GET /api/admin/logs/engagement?range=1h|24h|7d|30d
 *
 * "Does anyone love BP" signal. Returns top-10 features ranked by hit count
 * in the selected window, with unique-user counts. Routes not in the
 * `feature-map.ts` whitelist are summed into `unmappedHits` for context.
 */
export async function GET(req: Request) {
  const { error } = await requireRootAdmin();
  if (error) return error;

  const range = (new URL(req.url).searchParams.get("range") || "24h") as InsightsWindow["range"];
  if (!["1h", "24h", "7d", "30d"].includes(range)) {
    return NextResponse.json({ error: "range must be 1h|24h|7d|30d" }, { status: 400 });
  }

  // Single Insights query — group by method+path, count rows + distinct
  // sessionId (proxy for unique users since we cookie-session anons too).
  const queryString = `
    fields @timestamp, method, path, sessionId
    | filter tag = "visit"
    | filter ispresent(method) and ispresent(path)
    | stats count(*) as hits, count_distinct(sessionId) as uniqueUsers by method, path
    | sort hits desc
    | limit 200
  `;

  try {
    const rows = await runInsightsQuery(queryString, { range }, { limit: 200 });

    let unmappedHits = 0;
    const mapped: Array<{ feature: string; method: string; path: string; hits: number; uniqueUsers: number }> = [];
    for (const row of rows) {
      const method = row.method;
      const path = row.path;
      const hits = Number(row.hits || 0);
      const uniqueUsers = Number(row.uniqueUsers || 0);
      const feature = method && path ? labelFor(method, path) : null;
      if (feature) {
        mapped.push({ feature, method, path, hits, uniqueUsers });
      } else {
        unmappedHits += hits;
      }
    }

    // Re-sort + top 10
    mapped.sort((a, b) => b.hits - a.hits);
    const top10 = mapped.slice(0, 10);

    return NextResponse.json({
      range,
      top10,
      unmappedHits,
      totalMappedRoutes: mapped.length,
    });
  } catch (err) {
    logger.error("[admin/logs/engagement] query failed", err);
    return NextResponse.json({ error: "Engagement query failed" }, { status: 500 });
  }
}
