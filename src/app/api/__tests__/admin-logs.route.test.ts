// @vitest-environment node
// [refactor jul6 S038] CHARACTERIZATION for the ADMIN B3 batch — the 5 root-admin log-reads
// (logs/alert-count · logs/security · logs/accounts · logs/engagement · logs/visitors),
// written as THE FREEZE before the fold onto services/admin-logs.ts.
//
// Per DR003's shared-DETECTOR discipline these are PER-ROUTE cases. Common skeleton (all 5):
// requireRootAdmin → read (db and/or CloudWatch Insights) → shape → NextResponse.json.
// GET-only, NO request body → ZERO E-class body-parse diffs for the whole batch.
// Frozen quirk inventory:
//   • AUTH: requireRootAdmin → 401 flat {error:"Unauthorized"} (no session) / 403 flat
//     {error:"Root admin only"} (authed non-root). Root passes. defineRoute auth:"root"
//     byte-matches (requireSession("root")). None scope by companyId (root cross-company).
//   • alert-count: catch → 200 GRACEFUL {unseen:0,latestEventAt:null} ("fail quietly" so a
//     db hiccup doesn't light the badge) — a SUCCESS fallback, must be preserved in-service
//     (NOT dropped to a generic 500).
//   • security: fire-and-forget mark-seen UPDATE (sets seenAt on all unseen abuse events) as
//     a side-effect of the read; catch → 500 "Security query failed".
//   • accounts/engagement/visitors: ?range validation → 400 "range must be 1h|24h|7d|30d"
//     (byte-identical literal across all three) BEFORE the query; each catch → 500
//     "<X> query failed" (Accounts/Engagement/Visitor). These 4 fixed 500-literals (no
//     err.message leak) flip to generic INTERNAL 500 at fold (diff B; S032 precedent).
//   • The range-400 literal stays byte-verbatim in-service (diff A → VALIDATION 400).
// Assertions tagged [S038 fold: … applied] were flipped in the fold commit onto
// services/admin-logs.ts (sanctioned A/B only — ZERO E; GET-only batch).
import { describe, expect, inject, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

// CloudWatch Insights + cache + feature-map are mocked (external/expensive); the routes'
// SHAPING logic runs for real against canned rows.
const h = vi.hoisted(() => ({
  runInsightsQuery: vi.fn(),
  oldestLogTimestampMs: vi.fn(),
  labelFor: vi.fn(),
}));
vi.mock("@/lib/admin-logs/cw-logs", () => ({
  runInsightsQuery: h.runInsightsQuery,
  oldestLogTimestampMs: h.oldestLogTimestampMs,
}));
vi.mock("@/lib/admin-logs/query-cache", () => ({
  // pass-through: run the producer directly (deterministic in tests)
  cachedQuery: (_key: string, _ttl: number, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/admin-logs/feature-map", () => ({
  labelFor: h.labelFor,
  ALL_FEATURE_LABELS: ["Tool A", "Tool B", "Tool C"],
}));

import { GET as alertGET } from "@/app/api/admin/logs/alert-count/route";
import { GET as secGET } from "@/app/api/admin/logs/security/route";
import { GET as accGET } from "@/app/api/admin/logs/accounts/route";
import { GET as engGET } from "@/app/api/admin/logs/engagement/route";
import { GET as visGET } from "@/app/api/admin/logs/visitors/route";
import { db } from "@/lib/db";
import { abuseEvents, manualIpBans } from "@/lib/db/schema";
import { isNull } from "drizzle-orm";
import {
  asUser,
  createCompany,
  createUser,
  makeReq,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

async function makeRoot() {
  const company = await createCompany();
  const root = await createUser(company.id, { isRootAdmin: true });
  const member = await createUser(company.id); // role "member", not root
  return { company, root, member };
}

const getReq = (path: string) => makeReq(path, { method: "GET" });
const UNAUTH = { error: { code: "UNAUTHORIZED", message: "Unauthorized" } }; // [S038 fold: A applied]
const ROOT_ONLY = { error: { code: "FORBIDDEN", message: "Root admin only" } }; // [S038 fold: A applied]

// Seed helpers
async function seedAbuse(over: Partial<typeof abuseEvents.$inferInsert> = {}) {
  const [row] = await db.insert(abuseEvents).values({
    eventType: "RATE_LIMIT", ip: "1.2.3.4", ...over,
  }).returning();
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
  h.oldestLogTimestampMs.mockResolvedValue(null);
  h.labelFor.mockReturnValue(null);
});

// ── alert-count — pure db, graceful catch, NO range ───────────────────────────
describe.skipIf(!dbUp)("admin/logs/alert-count (ALERT)", () => {
  it("ALERT-1 auth: signed-out→401, member→403, root→200", async () => {
    const { root, member } = await makeRoot();
    let r = await readJson(await alertGET(getReq("/api/admin/logs/alert-count")));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S038 fold: A applied]
    asUser(member);
    r = await readJson(await alertGET(getReq("/api/admin/logs/alert-count")));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ROOT_ONLY); // [S038 fold: A applied]
    asUser(root);
    r = await readJson(await alertGET(getReq("/api/admin/logs/alert-count")));
    expect(r.status).toBe(200);
  });

  it("ALERT-2 read: counts UNSEEN events + newest-unseen timestamp; empty→{0,null}", async () => {
    const { root } = await makeRoot();
    asUser(root);
    // empty first
    let r = await readJson(await alertGET(getReq("/api/admin/logs/alert-count")));
    expect(r.body).toEqual({ unseen: 0, latestEventAt: null });
    // 2 unseen + 1 already-seen (excluded from the count)
    await seedAbuse({ ip: "9.9.9.1" });
    const newest = await seedAbuse({ ip: "9.9.9.2" });
    await seedAbuse({ ip: "9.9.9.3", seenAt: new Date() });
    r = await readJson(await alertGET(getReq("/api/admin/logs/alert-count")));
    expect(r.status).toBe(200);
    expect(r.body.unseen).toBe(2);
    expect(new Date(r.body.latestEventAt).getTime()).toBe(new Date(newest.createdAt as Date).getTime());
  });
});

// ── security — db read + mark-seen SIDE-EFFECT + 500-literal catch ─────────────
describe.skipIf(!dbUp)("admin/logs/security (SEC)", () => {
  it("SEC-1 auth: signed-out→401, member→403", async () => {
    const { member } = await makeRoot();
    let r = await readJson(await secGET(getReq("/api/admin/logs/security")));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S038 fold: A applied]
    asUser(member);
    r = await readJson(await secGET(getReq("/api/admin/logs/security")));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ROOT_ONLY); // [S038 fold: A applied]
  });

  it("SEC-2 read+shape: {abuseEvents, manualBans, violationStats{last24h,last7d,byType}}", async () => {
    const { root } = await makeRoot();
    asUser(root);
    await seedAbuse({ eventType: "RATE_LIMIT", ip: "5.5.5.1" });
    await seedAbuse({ eventType: "RATE_LIMIT", ip: "5.5.5.2" });
    await seedAbuse({ eventType: "LOCKOUT", ip: "5.5.5.3" });
    await db.insert(manualIpBans).values({ ip: "6.6.6.6", reason: "spam" });
    const r = await readJson(await secGET(getReq("/api/admin/logs/security")));
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.abuseEvents)).toBe(true);
    expect(r.body.abuseEvents.length).toBeGreaterThanOrEqual(3);
    expect(r.body.manualBans.some((b: { ip: string }) => b.ip === "6.6.6.6")).toBe(true);
    expect(r.body.violationStats.last7d).toBeGreaterThanOrEqual(3);
    expect(r.body.violationStats.byType.RATE_LIMIT).toBeGreaterThanOrEqual(2);
    expect(r.body.violationStats.byType.LOCKOUT).toBeGreaterThanOrEqual(1);
  });

  it("SEC-3 SIDE-EFFECT: reading marks all unseen abuse events as seen (fire-and-forget)", async () => {
    const { root } = await makeRoot();
    asUser(root);
    await seedAbuse({ ip: "7.7.7.1" });
    await seedAbuse({ ip: "7.7.7.2" });
    await readJson(await secGET(getReq("/api/admin/logs/security")));
    // fire-and-forget → poll until the async UPDATE lands (bounded)
    let remaining = 99;
    for (let i = 0; i < 50 && remaining > 0; i++) {
      const unseen = await db.select().from(abuseEvents).where(isNull(abuseEvents.seenAt));
      remaining = unseen.filter((e) => ["7.7.7.1", "7.7.7.2"].includes(e.ip)).length;
      if (remaining === 0) break;
      await new Promise((res) => setTimeout(res, 20));
    }
    expect(remaining).toBe(0);
  });
});

// ── accounts — CW Insights + db PII resolution + range + 500-literal ──────────
describe.skipIf(!dbUp)("admin/logs/accounts (ACC)", () => {
  it("ACC-1 auth: signed-out→401, member→403", async () => {
    const { member } = await makeRoot();
    let r = await readJson(await accGET(getReq("/api/admin/logs/accounts")));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S038 fold: A applied]
    asUser(member);
    r = await readJson(await accGET(getReq("/api/admin/logs/accounts")));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ROOT_ONLY); // [S038 fold: A applied]
  });

  it("ACC-2 range validation: bad range → 400 byte-literal (BEFORE any query)", async () => {
    const { root } = await makeRoot();
    asUser(root);
    const r = await readJson(await accGET(getReq("/api/admin/logs/accounts?range=99y")));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "VALIDATION", message: "range must be 1h|24h|7d|30d" } }); // [S038 fold: A applied]
    expect(h.runInsightsQuery).not.toHaveBeenCalled();
  });

  it("ACC-3 read+shape: resolves userId/companyId→names, aggregates tools; empty→{range,accounts:[]}", async () => {
    const { company, root } = await makeRoot();
    asUser(root);
    // empty rows
    h.runInsightsQuery.mockResolvedValue([]);
    let r = await readJson(await accGET(getReq("/api/admin/logs/accounts?range=7d")));
    expect(r.body).toEqual({ range: "7d", accounts: [] });
    // one user, two mapped tool actions
    const u = await createUser(company.id, { role: "member" });
    h.labelFor.mockImplementation((m: string, p: string) => (p === "/api/tool-a" ? "Tool A" : p === "/api/tool-b" ? "Tool B" : null));
    h.runInsightsQuery.mockResolvedValue([
      { userId: String(u.id), companyId: String(company.id), method: "GET", path: "/api/tool-a", hits: "5", firstTs: "2026-07-01T00:00:00.000Z", lastTs: "2026-07-02T00:00:00.000Z" },
      { userId: String(u.id), companyId: String(company.id), method: "GET", path: "/api/tool-b", hits: "3", firstTs: "2026-07-03T00:00:00.000Z", lastTs: "2026-07-04T00:00:00.000Z" },
      { userId: String(u.id), companyId: String(company.id), method: "GET", path: "/api/unmapped", hits: "99", firstTs: "2026-07-01T00:00:00.000Z", lastTs: "2026-07-05T00:00:00.000Z" },
    ]);
    r = await readJson(await accGET(getReq("/api/admin/logs/accounts?range=7d")));
    expect(r.status).toBe(200);
    expect(r.body.range).toBe("7d");
    expect(r.body.accounts).toHaveLength(1);
    const a = r.body.accounts[0];
    expect(a.userId).toBe(u.id);
    expect(a.email).toBe(u.email);
    expect(a.companyName).toBe(company.name);
    expect(a.totalActions).toBe(8); // 5 + 3 (unmapped excluded)
    expect(a.uniqueTools).toBe(2);
    expect(a.topTools).toEqual([{ tool: "Tool A", hits: 5 }, { tool: "Tool B", hits: 3 }]); // sorted desc
    expect(a.firstSeen).toBe("2026-07-01T00:00:00.000Z");
    expect(a.lastSeen).toBe("2026-07-04T00:00:00.000Z");
  });

  it("ACC-4 catch: Insights throw → 500 'Accounts query failed'", async () => {
    // [S038 fold: B — fixed-literal catch → generic INTERNAL 500 'Internal server error']
    const { root } = await makeRoot();
    asUser(root);
    h.runInsightsQuery.mockRejectedValue(new Error("cw down"));
    const r = await readJson(await accGET(getReq("/api/admin/logs/accounts?range=24h")));
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: { code: "INTERNAL", message: "Internal server error" } }); // [S038 fold: B applied — leak-free literal retired]
  });
});

// ── engagement — CW Insights + ?all zero-fill + range + 500-literal ───────────
describe.skipIf(!dbUp)("admin/logs/engagement (ENG)", () => {
  it("ENG-1 range validation: bad → 400 byte-literal", async () => {
    const { root } = await makeRoot();
    asUser(root);
    const r = await readJson(await engGET(getReq("/api/admin/logs/engagement?range=nope")));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "VALIDATION", message: "range must be 1h|24h|7d|30d" } }); // [S038 fold: A applied]
  });

  it("ENG-2 read+shape: top10 + unmappedHits + totalMappedRoutes; ?all=1 zero-fills labels", async () => {
    const { root } = await makeRoot();
    asUser(root);
    h.labelFor.mockImplementation((_m: string, p: string) => (p === "/api/tool-a" ? "Tool A" : p === "/api/tool-b" ? "Tool B" : null));
    h.runInsightsQuery.mockResolvedValue([
      { method: "GET", path: "/api/tool-a", hits: "10", uniqueUsers: "4" },
      { method: "GET", path: "/api/tool-b", hits: "6", uniqueUsers: "2" },
      { method: "GET", path: "/api/unmapped", hits: "7", uniqueUsers: "1" },
    ]);
    let r = await readJson(await engGET(getReq("/api/admin/logs/engagement?range=24h")));
    expect(r.status).toBe(200);
    expect(r.body.range).toBe("24h");
    expect(r.body.unmappedHits).toBe(7);
    expect(r.body.totalMappedRoutes).toBe(2);
    expect(r.body.top10.map((t: { feature: string }) => t.feature)).toEqual(["Tool A", "Tool B"]);
    expect(r.body.allMapped).toEqual([]); // no ?all → empty
    // ?all=1 zero-fills Tool C (in ALL_FEATURE_LABELS, never hit)
    r = await readJson(await engGET(getReq("/api/admin/logs/engagement?range=24h&all=1")));
    const feats = r.body.allMapped.map((m: { feature: string; hits: number }) => [m.feature, m.hits]);
    expect(feats).toEqual(expect.arrayContaining([["Tool A", 10], ["Tool B", 6], ["Tool C", 0]]));
  });

  it("ENG-3 catch: Insights throw → 500 'Engagement query failed'", async () => {
    // [S038 fold: B → generic INTERNAL 500]
    const { root } = await makeRoot();
    asUser(root);
    h.runInsightsQuery.mockRejectedValue(new Error("cw down"));
    const r = await readJson(await engGET(getReq("/api/admin/logs/engagement?range=24h")));
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: { code: "INTERNAL", message: "Internal server error" } }); // [S038 fold: B applied]
  });
});

// ── visitors — CW Insights + db bans + retentionWarning + range + 500-literal ─
describe.skipIf(!dbUp)("admin/logs/visitors (VIS)", () => {
  it("VIS-1 range validation: bad → 400 byte-literal", async () => {
    const { root } = await makeRoot();
    asUser(root);
    const r = await readJson(await visGET(getReq("/api/admin/logs/visitors?range=bad")));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "VALIDATION", message: "range must be 1h|24h|7d|30d" } }); // [S038 fold: A applied]
  });

  it("VIS-2 read+shape: per-IP summary, isManuallyBanned join, retentionWarning null when logs fresh", async () => {
    const { root } = await makeRoot();
    asUser(root);
    await db.insert(manualIpBans).values({ ip: "8.8.8.8", reason: "abuse" });
    h.oldestLogTimestampMs.mockResolvedValue(Date.now()); // fresh → no warning
    h.runInsightsQuery.mockResolvedValue([
      { ip: "8.8.8.8", country: "US", requests: "50", firstSeenTs: "2026-07-01T00:00:00.000Z", lastSeenTs: "2026-07-01T01:00:00.000Z", uniquePaths: "3", uniqueSessions: "2", userAgent: "curl", authed: "1" },
      { ip: "3.3.3.3", requests: "5", firstSeenTs: "", lastSeenTs: "", uniquePaths: "1", uniqueSessions: "1", userAgent: "", authed: "0" },
    ]);
    const r = await readJson(await visGET(getReq("/api/admin/logs/visitors?range=24h")));
    expect(r.status).toBe(200);
    expect(r.body.range).toBe("24h");
    expect(r.body.retentionWarning).toBeNull();
    const v0 = r.body.visitors.find((v: { ip: string }) => v.ip === "8.8.8.8");
    expect(v0).toMatchObject({ country: "US", requests: 50, uniquePaths: 3, authed: true, isManuallyBanned: true });
    const v1 = r.body.visitors.find((v: { ip: string }) => v.ip === "3.3.3.3");
    expect(v1).toMatchObject({ country: "??", requests: 5, authed: false, isManuallyBanned: false, firstSeen: null, durationMs: 0 });
  });

  it("VIS-3 retentionWarning fires when oldest log within 3 days of the 30-day cap", async () => {
    const { root } = await makeRoot();
    asUser(root);
    h.oldestLogTimestampMs.mockResolvedValue(Date.now() - 27.5 * 24 * 3600 * 1000); // 27.5d old → floor(30-27.5)=2 days left
    h.runInsightsQuery.mockResolvedValue([]);
    const r = await readJson(await visGET(getReq("/api/admin/logs/visitors?range=24h")));
    expect(r.body.retentionWarning).toEqual({ daysUntilRollover: 2 });
  });

  it("VIS-4 catch: Insights throw → 500 'Visitor query failed'", async () => {
    // [S038 fold: B → generic INTERNAL 500]
    const { root } = await makeRoot();
    asUser(root);
    h.runInsightsQuery.mockRejectedValue(new Error("cw down"));
    const r = await readJson(await visGET(getReq("/api/admin/logs/visitors?range=24h")));
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: { code: "INTERNAL", message: "Internal server error" } }); // [S038 fold: B applied]
  });
});
