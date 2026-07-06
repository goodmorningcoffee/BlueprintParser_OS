// [refactor jul6 S038] ADMIN B3 — the 5 root-admin log-read contracts (alert-count,
// security, accounts, engagement, visitors), folded from the legacy routes (git show
// 124b61a:src/app/api/admin/logs/... at the freeze). Char: __tests__/admin-logs.route.test.ts
// (ALERT/SEC/ACC/ENG/VIS).
//
// SHARED SHAPE: all 5 are requireRootAdmin GET-only reads (the shell provides auth:"root";
// none scope by companyId — root cross-company views). No request body → ZERO E-class.
// Sanctioned diffs at the shell boundary:
//   • A — flat auth errors → envelope (defineRoute auth:"root" is byte-identical to legacy
//     requireRootAdmin: 401 "Unauthorized" / 403 "Root admin only"); the ?range 400 literal
//     stays byte-verbatim here as ApiError("VALIDATION", ...).
//   • B — the 4 fixed catch-500 literals ("Accounts/Engagement/Visitor query failed" +
//     security's "Security query failed") are RETIRED: the service lets the error propagate
//     and the shell renders a generic INTERNAL 500 (no err.message leak either way; S032
//     "CSI detection failed" precedent). The real cause is logged server-side by defineRoute.
// PRESERVED per-route (frozen): alert-count's internal try/catch → 200 graceful fallback
// (a SUCCESS "fail quietly" path, NOT an error → stays in-service) · security's fire-and-
// forget mark-seen UPDATE side-effect · each CW route's range-validation-BEFORE-query order.

import { runInsightsQuery, oldestLogTimestampMs, type InsightsWindow } from "@/lib/admin-logs/cw-logs";
import { ALL_FEATURE_LABELS, labelFor } from "@/lib/admin-logs/feature-map";
import { cachedQuery } from "@/lib/admin-logs/query-cache";
import { db } from "@/lib/db";
import { abuseEvents, manualIpBans, users, companies } from "@/lib/db/schema";
import { desc, gte, inArray, isNull, sql } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { ApiError } from "@/server/api/envelope";

/** Shared ?range parse+validate; throws the byte-verbatim legacy 400 literal (diff A). */
function parseRange(req: Request): InsightsWindow["range"] {
  const range = (new URL(req.url).searchParams.get("range") || "24h") as InsightsWindow["range"];
  if (!["1h", "24h", "7d", "30d"].includes(range)) {
    throw new ApiError("VALIDATION", "range must be 1h|24h|7d|30d");
  }
  return range;
}

// ── alert-count ─────────────────────────────────────────────────────────────

export async function getAlertCount(): Promise<unknown> {
  try {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(abuseEvents)
      .where(isNull(abuseEvents.seenAt));

    const [latest] = await db
      .select({ createdAt: abuseEvents.createdAt })
      .from(abuseEvents)
      .where(isNull(abuseEvents.seenAt))
      .orderBy(desc(abuseEvents.createdAt))
      .limit(1);

    return {
      unseen: row?.n ?? 0,
      latestEventAt: latest?.createdAt ?? null,
    };
  } catch {
    // Fail quietly — if the DB hiccups we don't want to light up the badge.
    // [PRESERVED] this is a 200 SUCCESS fallback, not an error — stays in-service.
    return { unseen: 0, latestEventAt: null };
  }
}

// ── security ────────────────────────────────────────────────────────────────

export async function getSecurityLog(): Promise<unknown> {
  const now = Date.now();
  const day = new Date(now - 24 * 3600 * 1000);
  const week = new Date(now - 7 * 24 * 3600 * 1000);

  // [B] no try/catch here — on error the shell renders a generic INTERNAL 500
  // (legacy returned a fixed "Security query failed" literal, no err leak; retired).
  const [events, bans, countLast24h, countLast7d, byType] = await Promise.all([
    db.select().from(abuseEvents).orderBy(desc(abuseEvents.createdAt)).limit(500),
    db.select().from(manualIpBans).orderBy(desc(manualIpBans.createdAt)),
    db.select({ n: sql<number>`count(*)::int` }).from(abuseEvents).where(gte(abuseEvents.createdAt, day)),
    db.select({ n: sql<number>`count(*)::int` }).from(abuseEvents).where(gte(abuseEvents.createdAt, week)),
    db
      .select({
        type: abuseEvents.eventType,
        n: sql<number>`count(*)::int`,
      })
      .from(abuseEvents)
      .where(gte(abuseEvents.createdAt, week))
      .groupBy(abuseEvents.eventType),
  ]);

  // Side-effect: mark all unseen as seen. Fire-and-forget so the response
  // isn't held on the update; this is idempotent and safe under concurrent
  // admins. [PRESERVED verbatim.]
  db.update(abuseEvents)
    .set({ seenAt: new Date() })
    .where(isNull(abuseEvents.seenAt))
    .catch((err) => logger.warn("[admin/logs/security] mark-seen failed", err));

  return {
    abuseEvents: events,
    manualBans: bans,
    violationStats: {
      last24h: countLast24h[0]?.n ?? 0,
      last7d: countLast7d[0]?.n ?? 0,
      byType: Object.fromEntries(byType.map((r) => [r.type, r.n])),
    },
  };
}

// ── accounts ────────────────────────────────────────────────────────────────

export async function getAccountsLog(req: Request): Promise<unknown> {
  const range = parseRange(req);

  const queryString = `
    fields @timestamp, userId, companyId, method, path
    | filter tag = "visit"
    | filter ispresent(userId) and ispresent(method) and ispresent(path)
    | stats count(*) as hits, min(@timestamp) as firstTs, max(@timestamp) as lastTs by userId, companyId, method, path
    | sort hits desc
    | limit 1000
  `;

  // [B] no try/catch — errors propagate to the shell's generic INTERNAL 500.
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
    return { range, accounts: [] };
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

  return { range, accounts };
}

// ── engagement ──────────────────────────────────────────────────────────────

export async function getEngagementLog(req: Request): Promise<unknown> {
  const range = parseRange(req);
  const includeAll = new URL(req.url).searchParams.get("all") === "1";

  const queryString = `
    fields @timestamp, method, path, sessionId
    | filter tag = "visit"
    | filter ispresent(method) and ispresent(path)
    | stats count(*) as hits, count_distinct(sessionId) as uniqueUsers by method, path
    | sort hits desc
    | limit 200
  `;

  // [B] no try/catch — errors propagate to the shell's generic INTERNAL 500.
  const rows = await cachedQuery(
    `engagement:${range}`,
    60_000,
    () => runInsightsQuery(queryString, { range }, { limit: 200 }),
  );

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

  mapped.sort((a, b) => b.hits - a.hits);
  const top10 = mapped.slice(0, 10);

  let allMapped: Array<{ feature: string; hits: number; uniqueUsers: number }> = [];
  if (includeAll) {
    const byLabel = new Map<string, { hits: number; uniqueUsers: number }>();
    for (const m of mapped) {
      const existing = byLabel.get(m.feature);
      if (existing) {
        existing.hits += m.hits;
        existing.uniqueUsers = Math.max(existing.uniqueUsers, m.uniqueUsers);
      } else {
        byLabel.set(m.feature, { hits: m.hits, uniqueUsers: m.uniqueUsers });
      }
    }
    for (const label of ALL_FEATURE_LABELS) {
      if (!byLabel.has(label)) byLabel.set(label, { hits: 0, uniqueUsers: 0 });
    }
    allMapped = Array.from(byLabel.entries())
      .map(([feature, stats]) => ({ feature, hits: stats.hits, uniqueUsers: stats.uniqueUsers }))
      .sort((a, b) => b.hits - a.hits || a.feature.localeCompare(b.feature));
  }

  return {
    range,
    top10,
    allMapped,
    unmappedHits,
    totalMappedRoutes: mapped.length,
  };
}

// ── visitors ────────────────────────────────────────────────────────────────

export async function getVisitorsLog(req: Request): Promise<unknown> {
  const range = parseRange(req);

  const queryString = `
    fields @timestamp, ip, country, method, path, status, userAgent, authed, sessionId
    | filter tag = "visit"
    | filter ispresent(ip)
    | stats count(*) as requests,
            min(@timestamp) as firstSeenTs,
            max(@timestamp) as lastSeenTs,
            count_distinct(path) as uniquePaths,
            count_distinct(sessionId) as uniqueSessions,
            max(country) as country,
            max(userAgent) as userAgent,
            max(authed) as authed
      by ip
    | sort requests desc
    | limit 100
  `;

  // [B] no try/catch — errors propagate to the shell's generic INTERNAL 500.
  const [rows, manualBans, oldestMs] = await Promise.all([
    cachedQuery(
      `visitors:${range}`,
      60_000,
      () => runInsightsQuery(queryString, { range }, { limit: 100 }),
    ),
    db.select().from(manualIpBans),
    oldestLogTimestampMs(),
  ]);

  const bannedIps = new Set(manualBans.map((b) => b.ip));

  const visitors = rows.map((row) => {
    const firstSeen = row.firstSeenTs ? new Date(row.firstSeenTs).toISOString() : null;
    const lastSeen = row.lastSeenTs ? new Date(row.lastSeenTs).toISOString() : null;
    const durationMs =
      row.firstSeenTs && row.lastSeenTs
        ? new Date(row.lastSeenTs).getTime() - new Date(row.firstSeenTs).getTime()
        : 0;
    return {
      ip: row.ip,
      country: row.country || "??",
      requests: Number(row.requests || 0),
      firstSeen,
      lastSeen,
      durationMs,
      uniquePaths: Number(row.uniquePaths || 0),
      uniqueSessions: Number(row.uniqueSessions || 0),
      userAgent: row.userAgent || "",
      authed: row.authed === "1" || row.authed === "true",
      isManuallyBanned: bannedIps.has(row.ip),
    };
  });

  const retentionCapDays = 30;
  const warnThresholdDays = 3;
  let retentionWarning: { daysUntilRollover: number } | null = null;
  if (oldestMs) {
    const ageDays = (Date.now() - oldestMs) / (24 * 3600 * 1000);
    const daysUntilRollover = Math.floor(retentionCapDays - ageDays);
    if (daysUntilRollover <= warnThresholdDays && daysUntilRollover >= 0) {
      retentionWarning = { daysUntilRollover };
    }
  }

  return {
    range,
    visitors,
    retentionWarning,
  };
}
