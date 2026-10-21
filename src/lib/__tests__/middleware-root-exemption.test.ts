// @vitest-environment node
// Owner ruling 2026-10-21 ("i want root admin exempt from everything basicly"): a VERIFIED root
// admin skips the app's policy rate limits in middleware. Pinned here:
//   • root is recognised only from the verified token (getToken result), never from cookie bytes;
//   • root skips route rules + the IP backstop, but NOT the pre-auth rules (sign-in etc.);
//   • on the parser routes root gets a priority lane: never banned / cooled down, a per-user
//     ceiling with a plain 429 and no abuse escalation;
//   • non-root callers keep today's exact responses.
//   • fix round 1: the token's root claim is RE-CONFIRMED against users.isRootAdmin (cached
//     ROOT_CLAIM_RECHECK_MS), so a demoted/deleted root holding an unrefreshed cookie loses the
//     exemption within the window, and a failed read fails closed to today's limits.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  getToken: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
  lookupCountry: vi.fn(async () => null),
  loggerInfo: vi.fn(),
  recordAbuseEvent: vi.fn(),
  // The users row as the DB has it now. Default: the DB agrees with the token's claim.
  refreshJwtUserAuthority: vi.fn(
    async (token: { dbId?: number }): Promise<Record<string, unknown> | null> => ({
      ...token,
      isRootAdmin: true,
    }),
  ),
}));

vi.mock("@/lib/admin-logs/record-abuse", () => ({ recordAbuseEvent: h.recordAbuseEvent }));
vi.mock("@/lib/admin-logs/manual-ban-cache", () => ({ isManuallyBanned: vi.fn(() => false) }));
vi.mock("@/lib/geo", () => ({ lookupCountry: h.lookupCountry }));
vi.mock("@/lib/logger", () => ({ logger: { info: h.loggerInfo } }));
vi.mock("next-auth/jwt", () => ({ getToken: h.getToken }));
vi.mock("@/server/services/auth-jwt-authority", () => ({
  refreshJwtUserAuthority: h.refreshJwtUserAuthority,
}));

import { middleware, middlewareRateLimitStoreSizeForTest } from "@/middleware";
import {
  ROOT_CLAIM_RECHECK_MS,
  ROOT_PARSER_LANE_LIMIT,
  confirmedRootUserId,
  isRootExemptRule,
  findRateRule,
  verifiedRootUserId,
} from "@/lib/middleware-rate-limit";

const ROOT = { dbId: 9001, isRootAdmin: true };

function req(path: string, ip: string, method = "POST", cookie = "tok"): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie: `authjs.session-token=${cookie}` } : {}),
      "user-agent": "middleware-root-exemption-test",
      "x-forwarded-for": ip,
    },
  });
}

async function statuses(n: number, make: (i: number) => NextRequest): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) out.push((await middleware(make(i))).status);
  return out;
}

beforeEach(() => {
  h.getToken.mockReset();
  h.getToken.mockResolvedValue(null);
  h.recordAbuseEvent.mockClear();
  h.refreshJwtUserAuthority.mockReset();
  h.refreshJwtUserAuthority.mockImplementation(async (token) => ({ ...token, isRootAdmin: true }));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("verifiedRootUserId (claim parsing)", () => {
  it("accepts only isRootAdmin === true with a positive safe-integer dbId", () => {
    expect(verifiedRootUserId({ isRootAdmin: true, dbId: 7 })).toBe(7);
    expect(verifiedRootUserId({ isRootAdmin: "true", dbId: 7 })).toBeNull();
    expect(verifiedRootUserId({ isRootAdmin: 1, dbId: 7 })).toBeNull();
    expect(verifiedRootUserId({ isRootAdmin: false, dbId: 7 })).toBeNull();
    expect(verifiedRootUserId({ isRootAdmin: true, dbId: "7" })).toBeNull();
    expect(verifiedRootUserId({ isRootAdmin: true, dbId: 0 })).toBeNull();
    expect(verifiedRootUserId({ isRootAdmin: true, dbId: 1.5 })).toBeNull();
    expect(verifiedRootUserId({ isRootAdmin: true })).toBeNull();
    expect(verifiedRootUserId(null)).toBeNull();
    expect(verifiedRootUserId("root")).toBeNull();
  });

  it("keeps the four pre-auth rules binding for root; every other rule is exempt", () => {
    for (const path of [
      "/api/register",
      "/api/auth/forgot-password",
      "/api/auth/reset-password",
      "/api/auth/callback/credentials",
    ]) {
      expect(isRootExemptRule(findRateRule(path, "POST"))).toBe(false);
    }
    expect(isRootExemptRule(findRateRule("/api/projects", "POST"))).toBe(true);
    expect(isRootExemptRule(findRateRule("/api/ai/chat", "POST"))).toBe(true);
    expect(isRootExemptRule(undefined)).toBe(true);
  });
});

describe("middleware: root admin exemption", () => {
  it("root skips the 10/hour POST /api/projects rule without allocating buckets", async () => {
    h.getToken.mockResolvedValue(ROOT);
    const before = middlewareRateLimitStoreSizeForTest();
    const s = await statuses(15, () => req("/api/projects", "203.0.113.230"));
    expect(s).toEqual(Array(15).fill(200));
    expect(middlewareRateLimitStoreSizeForTest() - before).toBe(0);
  });

  it("root skips the 120/minute IP backstop", async () => {
    h.getToken.mockResolvedValue(ROOT);
    const s = await statuses(130, () => req("/api/annotations-anything", "203.0.113.231", "GET"));
    expect(s.every((status) => status === 200)).toBe(true);
  });

  it("a non-root holder of the same token shape is still limited (11th /api/projects → 429)", async () => {
    h.getToken.mockResolvedValue({ dbId: 9002, isRootAdmin: false });
    const s = await statuses(11, () => req("/api/projects", "203.0.113.232"));
    expect(s.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(s[10]).toBe(429);
  });

  it("an unverified cookie (getToken → null) gets no exemption", async () => {
    h.getToken.mockResolvedValue(null);
    const s = await statuses(11, (i) => req("/api/projects", "203.0.113.233", "POST", `forged-root-${i}`));
    expect(s[10]).toBe(429);
  });

  it("pre-auth rules still bind a root cookie holder (11th credentials callback → 429)", async () => {
    h.getToken.mockResolvedValue(ROOT);
    const s = await statuses(11, () => req("/api/auth/callback/credentials", "203.0.113.234"));
    expect(s.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(s[10]).toBe(429);
  });

  it("parser lane: root is never cooled down or banned; a plain 429 past the per-user ceiling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T00:00:00.000Z"));
    h.getToken.mockResolvedValue({ dbId: 9003, isRootAdmin: true });
    const ip = "203.0.113.235";
    const s = await statuses(ROOT_PARSER_LANE_LIMIT, () => req("/api/table-parse", ip));
    expect(s).toEqual(Array(ROOT_PARSER_LANE_LIMIT).fill(200)); // far past the anonymous 5/10 s
    const over = await middleware(req("/api/table-parse", ip));
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "Too many parser requests.", retryAfter: 10 });
    expect(over.headers.get("Retry-After")).toBe("10");
    expect(h.recordAbuseEvent).not.toHaveBeenCalled(); // no breach, no ban escalation

    // A separate prefix is its own lane.
    expect((await middleware(req("/api/bucket-fill", ip))).status).toBe(200);

    // After the window the lane re-admits; no cooldown or ban was ever stored.
    vi.setSystemTime(new Date("2026-10-21T00:00:11.000Z"));
    expect((await middleware(req("/api/table-parse", ip))).status).toBe(200);
  });

  it("parser lane: an anonymous caller on root's IP is cooled down, root on that IP is not", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T01:00:00.000Z"));
    const ip = "203.0.113.236";
    h.getToken.mockResolvedValue(null);
    const anon = await statuses(6, () => req("/api/shape-parse", ip, "POST", ""));
    expect(anon.slice(0, 5)).toEqual(Array(5).fill(200));
    expect(anon[5]).toBe(429); // anonymous: today's cooldown
    h.getToken.mockResolvedValue({ dbId: 9004, isRootAdmin: true });
    expect((await middleware(req("/api/shape-parse", ip))).status).toBe(200); // root: own lane
  });
});

describe("confirmedRootUserId (database re-confirmation of the root claim)", () => {
  it("never consults the database for a non-root or unverified token", async () => {
    const lookup = vi.fn(async () => true);
    expect(await confirmedRootUserId(null, lookup, 1_000)).toBeNull();
    expect(await confirmedRootUserId({ dbId: 7101, isRootAdmin: false }, lookup, 1_000)).toBeNull();
    expect(await confirmedRootUserId({ dbId: "7101", isRootAdmin: true }, lookup, 1_000)).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("caches a confirmation for the window, then re-reads and sees a demotion", async () => {
    let isRoot = true;
    const lookup = vi.fn(async () => isRoot);
    const token = { dbId: 7102, isRootAdmin: true };
    const t0 = 5_000_000;
    expect(await confirmedRootUserId(token, lookup, t0)).toBe(7102);
    isRoot = false; // demoted in the DB; the cookie still claims root
    expect(await confirmedRootUserId(token, lookup, t0 + ROOT_CLAIM_RECHECK_MS - 1)).toBe(7102);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(await confirmedRootUserId(token, lookup, t0 + ROOT_CLAIM_RECHECK_MS)).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenLastCalledWith(7102);
  });

  it("shares one read between concurrent requests", async () => {
    const lookup = vi.fn(async () => true);
    const token = { dbId: 7103, isRootAdmin: true };
    const out = await Promise.all([1, 2, 3, 4].map(() => confirmedRootUserId(token, lookup, 9_000)));
    expect(out).toEqual([7103, 7103, 7103, 7103]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the read rejects or throws, and does not re-read inside the window", async () => {
    const rejects = vi.fn(async (): Promise<boolean> => {
      throw new Error("db down");
    });
    expect(await confirmedRootUserId({ dbId: 7104, isRootAdmin: true }, rejects, 1_000)).toBeNull();
    expect(await confirmedRootUserId({ dbId: 7104, isRootAdmin: true }, rejects, 2_000)).toBeNull();
    expect(rejects).toHaveBeenCalledTimes(1);
    const throwsSync = vi.fn((): Promise<boolean> => {
      throw new Error("sync throw");
    });
    expect(await confirmedRootUserId({ dbId: 7105, isRootAdmin: true }, throwsSync, 1_000)).toBeNull();
  });

  it("a clock that moved backwards forces a re-read", async () => {
    const lookup = vi.fn(async () => true);
    const token = { dbId: 7106, isRootAdmin: true };
    await confirmedRootUserId(token, lookup, 50_000);
    await confirmedRootUserId(token, lookup, 40_000);
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});

describe("middleware: a stale root claim (demoted or deleted in the DB) is not exempt", () => {
  it("demoted root with an unrefreshed cookie: route rule binds again (11th /api/projects → 429)", async () => {
    h.getToken.mockResolvedValue({ dbId: 9010, isRootAdmin: true });
    h.refreshJwtUserAuthority.mockImplementation(async (token) => ({ ...token, isRootAdmin: false }));
    const s = await statuses(11, () => req("/api/projects", "203.0.113.240"));
    expect(s.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(s[10]).toBe(429);
    // One read for the whole burst: the answer is cached for the window.
    expect(h.refreshJwtUserAuthority).toHaveBeenCalledTimes(1);
    expect(h.refreshJwtUserAuthority).toHaveBeenCalledWith({ dbId: 9010 });
  });

  it("deleted user with an unrefreshed root cookie: the IP backstop binds again", async () => {
    h.getToken.mockResolvedValue({ dbId: 9011, isRootAdmin: true });
    h.refreshJwtUserAuthority.mockResolvedValue(null);
    const s = await statuses(121, () => req("/api/annotations-anything", "203.0.113.241", "GET"));
    expect(s.slice(0, 120).every((status) => status === 200)).toBe(true);
    expect(s[120]).toBe(429);
  });

  it("database failure: the root claim fails closed to today's parser cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T02:00:00.000Z"));
    h.getToken.mockResolvedValue({ dbId: 9012, isRootAdmin: true });
    h.refreshJwtUserAuthority.mockRejectedValue(new Error("db down"));
    const s = await statuses(6, () => req("/api/symbol-search", "203.0.113.242"));
    expect(s.slice(0, 5)).toEqual(Array(5).fill(200));
    expect(s[5]).toBe(429);
  });

  it("non-root and anonymous callers never cause a database read", async () => {
    h.getToken.mockResolvedValue({ dbId: 9013, isRootAdmin: false });
    await statuses(3, () => req("/api/projects", "203.0.113.243"));
    h.getToken.mockResolvedValue(null);
    await statuses(3, () => req("/api/projects", "203.0.113.244", "POST", ""));
    expect(h.refreshJwtUserAuthority).not.toHaveBeenCalled();
  });
});
