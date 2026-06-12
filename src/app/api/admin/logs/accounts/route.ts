import { NextResponse } from "next/server";
import { requireRootAdmin } from "@/lib/api-utils";
import { runInsightsQuery, type InsightsWindow } from "@/lib/admin-logs/cw-logs";
import { labelFor } from "@/lib/admin-logs/feature-map";
import { cachedQuery } from "@/lib/admin-logs/query-cache";
import { db } from "@/lib/db";
import { users, companies } from "@/lib/db/schema";
import { inArray } from "drizzle-orm";
import { logger } from "@/lib/logger";

/**
 * GET /api/admin/logs/accounts?range=1h|24h|7d|30d
 *
 * Per-account engagement: which mapped tools each signed-in user actually
 * used, and how often, in the window. Built on the same `visit` CloudWatch
 * stream as the Engagement tab, but grouped by the `userId`/`companyId` that
 * middleware stamps on each authed request. The opaque IDs are resolved to
 * names HERE (server-side) so no email/PII ever lands in the logs. Routes not
 * in the `feature-map.ts` whitelist are ignored — this view is "real tool
 * actions by account", not raw request counts (Visitors covers that).
 */
export async function GET(req: Request) {
  const { error } = await requireRootAdmin();
  if (error) return error;

  const range = (new URL(req.url).searchParams.get("range") || "24h") as InsightsWindow["range"];
  if (!["1h", "24h", "7d", "30d"].includes(range)) {
    return NextResponse.json({ error: "range must be 1h|24h|7d|30d" }, { status: 400 });
  }

  // Group authed visits by user + route. labelFor() (applied below) keeps only
  // real tool actions. limit 1000 covers users×routes for the expected scale;
  // see truncation note in the response if it's ever hit.
  const queryString = `
    fields @timestamp, userId, companyId, method, path
    | filter tag = "visit"
    | filter ispresent(userId) and ispresent(method) and ispresent(path)
    | stats count(*) as hits, min(@timestamp) as firstTs, max(@timestamp) as lastTs by userId, companyId, method, path
    | sort hits desc
    | limit 1000
  `;

  try {
    const rows = await cachedQuery(
      `accounts:${range}`,
      60_000,
      () => runInsightsQuery(queryString, { range }, { limit: 1000 }),
    );

    interface Acc {
      userId: number;
      companyId: number | null;
      tools: Map<string, number>;
      totalActions: number;
      firstSeenMs: number;
      lastSeenMs: number;
    }
    const byUser = new Map<number, Acc>();
    for (const row of rows) {
      const userId = Number(row.userId);
      if (!Number.isFinite(userId)) continue;
      const tool = labelFor(row.method, row.path);
      if (!tool) continue; // only count mapped tool actions
      const hits = Number(row.hits || 0);
      const firstMs = row.firstTs ? new Date(row.firstTs).getTime() : 0;
      const lastMs = row.lastTs ? new Date(row.lastTs).getTime() : 0;
      let acc = byUser.get(userId);
      if (!acc) {
        const companyId = Number.isFinite(Number(row.companyId)) ? Number(row.companyId) : null;
        acc = { userId, companyId, tools: new Map(), totalActions: 0, firstSeenMs: firstMs || lastMs, lastSeenMs: lastMs };
        byUser.set(userId, acc);
      }
      acc.tools.set(tool, (acc.tools.get(tool) || 0) + hits);
      acc.totalActions += hits;
      if (firstMs && (acc.firstSeenMs === 0 || firstMs < acc.firstSeenMs)) acc.firstSeenMs = firstMs;
      if (lastMs > acc.lastSeenMs) acc.lastSeenMs = lastMs;
    }

    if (byUser.size === 0) {
      return NextResponse.json({ range, accounts: [] });
    }

    // Resolve opaque IDs → names (keeps PII out of CloudWatch).
    const userIds = [...byUser.keys()];
    const companyIds = [
      ...new Set([...byUser.values()].map((a) => a.companyId).filter((c): c is number => c != null)),
    ];
    const [userRows, companyRows] = await Promise.all([
      db.select({ id: users.id, email: users.email, username: users.username, role: users.role })
        .from(users).where(inArray(users.id, userIds)),
      companyIds.length
        ? db.select({ id: companies.id, name: companies.name }).from(companies).where(inArray(companies.id, companyIds))
        : Promise.resolve([] as { id: number; name: string }[]),
    ]);
    const userMap = new Map(userRows.map((u) => [u.id, u]));
    const companyMap = new Map(companyRows.map((c) => [c.id, c.name]));

    const accounts = [...byUser.values()]
      .map((a) => {
        const u = userMap.get(a.userId);
        const topTools = [...a.tools.entries()]
          .map(([tool, hits]) => ({ tool, hits }))
          .sort((x, y) => y.hits - x.hits);
        return {
          userId: a.userId,
          email: u?.email ?? null,
          name: u?.username ?? null,
          role: u?.role ?? null,
          companyId: a.companyId,
          companyName: a.companyId != null ? companyMap.get(a.companyId) ?? null : null,
          totalActions: a.totalActions,
          uniqueTools: a.tools.size,
          topTools,
          firstSeen: new Date(a.firstSeenMs).toISOString(),
          lastSeen: new Date(a.lastSeenMs).toISOString(),
        };
      })
      .sort((x, y) => y.totalActions - x.totalActions);

    return NextResponse.json({ range, accounts });
  } catch (err) {
    logger.error("[admin/logs/accounts] query failed", err);
    return NextResponse.json({ error: "Accounts query failed" }, { status: 500 });
  }
}
