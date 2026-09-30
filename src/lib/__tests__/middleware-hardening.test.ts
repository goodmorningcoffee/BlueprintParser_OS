// @vitest-environment node
// [hardening sep30] Three properties of the middleware that the public launch depends on:
//   1. /api/health is never rate-limited (a 429 there makes ECS replace a healthy task);
//   2. limiter decisions use the percent-DECODED path, the form Next's router matches;
//   3. caller-controlled fields in the visit log are bounded.
// Unique ip per case: the limiter stores are module-level singletons.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  loggerInfo: vi.fn(),
  recordAbuseEvent: vi.fn(),
}));

vi.mock("@/lib/admin-logs/record-abuse", () => ({ recordAbuseEvent: h.recordAbuseEvent }));
vi.mock("@/lib/admin-logs/manual-ban-cache", () => ({ isManuallyBanned: vi.fn(() => false) }));
vi.mock("@/lib/geo", () => ({ lookupCountry: vi.fn(async () => null) }));
vi.mock("@/lib/logger", () => ({ logger: { info: h.loggerInfo } }));
vi.mock("next-auth/jwt", () => ({ getToken: vi.fn(async () => null) }));

import { middleware } from "@/middleware";

const req = (url: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(`http://localhost${url}`, { method: init.method ?? "GET", headers: init.headers });

const flushVisitLog = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T00:00:00.000Z"));
  h.loggerInfo.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("middleware — health check", () => {
  it("is admitted far past the per-IP backstop, with no forwarded address at all", async () => {
    for (let i = 0; i < 500; i += 1) {
      expect((await middleware(req("/api/health"))).status).toBe(200);
    }
  });

  it("writes no visit log line", async () => {
    await middleware(req("/api/health"));
    await flushVisitLog();
    expect(h.loggerInfo).not.toHaveBeenCalled();
  });
});

describe("middleware — percent-encoded paths", () => {
  const ip = "203.0.113.201";
  const hit = (path: string) =>
    middleware(req(path, { method: "POST", headers: { "x-forwarded-for": ip } }));

  it("an encoded parser path shares the plain path's tight bucket", async () => {
    // ABUSIVE_LIMIT is 5 per 10 s per route prefix: three encoded + two plain, then the 6th.
    for (const path of [
      "/api/%74able-parse",
      "/%61pi/table-parse",
      "/api/table%2Dparse",
      "/api/table-parse",
      "/api/table-parse",
    ]) {
      expect((await hit(path)).status).toBe(200);
    }
    expect((await hit("/%61pi/%74able-parse")).status).toBe(429);
  });

  it("an undecodable path is refused outright", async () => {
    expect((await hit("/api/%E0%A4%A")).status).toBe(400);
  });
});

describe("middleware — visit log bounds", () => {
  it("truncates user-agent and path, and ignores a session cookie that is not a UUID", async () => {
    const response = await middleware(
      req(`/${"p".repeat(5_000)}`, {
        headers: {
          "user-agent": "u".repeat(5_000),
          "x-forwarded-for": "203.0.113.202",
          cookie: `bp_visit_session=${"c".repeat(5_000)}`,
        },
      }),
    );
    await flushVisitLog();
    const [, fields] = h.loggerInfo.mock.calls[0] as [string, Record<string, string>];
    expect(fields.userAgent).toHaveLength(256);
    expect(fields.path).toHaveLength(256);
    expect(fields.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    // A fresh id was minted, so the cookie is re-issued.
    expect(response.cookies.get("bp_visit_session")?.value).toBe(fields.sessionId);
  });

  it("keeps a well-formed session cookie", async () => {
    const id = "11111111-2222-4333-8444-555555555555";
    await middleware(
      req("/", { headers: { "x-forwarded-for": "203.0.113.203", cookie: `bp_visit_session=${id}` } }),
    );
    await flushVisitLog();
    const [, fields] = h.loggerInfo.mock.calls[0] as [string, Record<string, string>];
    expect(fields.sessionId).toBe(id);
  });
});
