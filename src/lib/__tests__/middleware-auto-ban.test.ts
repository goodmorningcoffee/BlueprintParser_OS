// @vitest-environment node
// [refactor jul23 P5.4-A] FREEZE — locks the tiered auto-ban / cooldown escalation
// on Lambda-fanout ("abusive") routes BEFORE P5.4 moves that state to Postgres
// (auto-bans converge onto manual_ip_bans; cooldown into runtime_counters). This
// escalation had ZERO tests. The byte-identical 429/403 bodies + Retry-After +
// the RATE_LIMIT_BREACH→IP_BANNED_AUTO abuse-event sequence are the acceptance
// oracle for the Stage-D swap. Contract (middleware.ts):
//   ABUSIVE_LIMIT=5 / 10s  → 6th hit in-window breaches
//   breach → 30s cooldown (429 "Too many parser requests. Cooldown active.",
//            retryAfter 30) + RATE_LIMIT_BREACH{violations}
//   2nd breach within 5min → 1h ban (403 "Access temporarily blocked due to
//            repeated abuse.", Retry-After 3600) + IP_BANNED_AUTO
// Uses vi.useFakeTimers + a UNIQUE ip per case (the cooldown/ban/rate stores are
// module-level singletons, so isolation comes from never reusing an ip).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  getToken: vi.fn(async (): Promise<{ dbId: number } | null> => null),
  lookupCountry: vi.fn(async () => null),
  loggerInfo: vi.fn(),
  recordAbuseEvent: vi.fn(),
}));

vi.mock("@/lib/admin-logs/record-abuse", () => ({
  recordAbuseEvent: h.recordAbuseEvent,
}));
vi.mock("@/lib/admin-logs/manual-ban-cache", () => ({
  isManuallyBanned: vi.fn(() => false),
}));
vi.mock("@/lib/geo", () => ({ lookupCountry: h.lookupCountry }));
vi.mock("@/lib/logger", () => ({ logger: { info: h.loggerInfo } }));
vi.mock("next-auth/jwt", () => ({ getToken: h.getToken }));

import { middleware } from "@/middleware";

const BASE = new Date("2026-07-23T00:00:00.000Z").getTime();

function abusiveReq(ip: string): NextRequest {
  return new NextRequest("http://localhost/api/table-parse", {
    method: "POST",
    headers: { "user-agent": "auto-ban-freeze", "x-forwarded-for": ip },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
  h.recordAbuseEvent.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("middleware auto-ban / cooldown escalation (freeze)", () => {
  it("admits 5 abusive hits, then 429-cooldowns the 6th within the 10s window", async () => {
    const ip = "203.0.113.10";
    for (let i = 0; i < 5; i += 1) {
      expect((await middleware(abusiveReq(ip))).status).toBe(200);
    }
    const sixth = await middleware(abusiveReq(ip));
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("Retry-After")).toBe("30");
    expect(await sixth.json()).toEqual({
      error: "Too many parser requests. Cooldown active.",
      retryAfter: 30,
    });
    expect(h.recordAbuseEvent).toHaveBeenCalledTimes(1);
    expect(h.recordAbuseEvent).toHaveBeenCalledWith({
      eventType: "RATE_LIMIT_BREACH",
      ip,
      path: "/api/table-parse",
      userAgent: "auto-ban-freeze",
      details: { violations: 1, route: "/api/table-parse" },
    });
  });

  it("keeps 429-ing during the active cooldown without a new breach event", async () => {
    const ip = "203.0.113.11";
    for (let i = 0; i < 5; i += 1) await middleware(abusiveReq(ip));
    const breach = await middleware(abusiveReq(ip));
    expect(breach.status).toBe(429);
    h.recordAbuseEvent.mockClear();

    // Still inside the 30s cooldown → early cooldown 429, no new breach event.
    const during = await middleware(abusiveReq(ip));
    expect(during.status).toBe(429);
    expect(await during.json()).toEqual({
      error: "Too many parser requests. Cooldown active.",
      retryAfter: 30,
    });
    expect(h.recordAbuseEvent).not.toHaveBeenCalled();
  });

  it("bans (403) on the 2nd breach within the 5m violation window", async () => {
    const ip = "203.0.113.12";
    // First breach → cooldown (violations 1).
    for (let i = 0; i < 5; i += 1) await middleware(abusiveReq(ip));
    expect((await middleware(abusiveReq(ip))).status).toBe(429);

    // Cooldown (30s) + the 10s burst window both expire; still < 5m memory.
    vi.advanceTimersByTime(31_000);
    for (let i = 0; i < 5; i += 1) {
      expect((await middleware(abusiveReq(ip))).status).toBe(200);
    }
    h.recordAbuseEvent.mockClear();

    const banned = await middleware(abusiveReq(ip));
    expect(banned.status).toBe(403);
    expect(banned.headers.get("Retry-After")).toBe("3600");
    const body = await banned.json();
    expect(body.error).toBe("Access temporarily blocked due to repeated abuse.");
    expect(typeof body.bannedUntil).toBe("string");

    // RATE_LIMIT_BREACH (violations 2) fires BEFORE the IP_BANNED_AUTO event.
    const types = h.recordAbuseEvent.mock.calls.map((c) => c[0].eventType);
    expect(types).toEqual(["RATE_LIMIT_BREACH", "IP_BANNED_AUTO"]);
    expect(h.recordAbuseEvent.mock.calls[0][0].details.violations).toBe(2);
    expect(h.recordAbuseEvent.mock.calls[1][0]).toMatchObject({
      eventType: "IP_BANNED_AUTO",
      ip,
      details: { violations: 2 },
    });
    expect(typeof h.recordAbuseEvent.mock.calls[1][0].details.bannedUntil).toBe(
      "string",
    );
  });

  it("keeps returning 403 for subsequent requests while the ban is active", async () => {
    const ip = "203.0.113.13";
    for (let i = 0; i < 5; i += 1) await middleware(abusiveReq(ip));
    await middleware(abusiveReq(ip)); // breach 1
    vi.advanceTimersByTime(31_000);
    for (let i = 0; i < 5; i += 1) await middleware(abusiveReq(ip));
    expect((await middleware(abusiveReq(ip))).status).toBe(403); // ban

    // A follow-up request 1 minute later is still banned (1h window).
    vi.advanceTimersByTime(60_000);
    const stillBanned = await middleware(abusiveReq(ip));
    expect(stillBanned.status).toBe(403);
    expect(await stillBanned.json()).toMatchObject({
      error: "Access temporarily blocked due to repeated abuse.",
    });
  });
});
