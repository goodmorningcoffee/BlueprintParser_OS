// @vitest-environment node
// [table pipeline WP-3.E, C1-M3] POST /api/projects/<id>/parse-engine/parse is a parser-lane route with
// its own exact-regex rate rule. Its route rule and its parser burst bucket are keyed by the rule NAME
// (`parse-engine-parse`), never by the first path segments or the project id, so rotating project ids
// buys nothing, and it neither spends nor shares another parser route's burst. Unique ip per case: the
// stores are module-level singletons.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  getToken: vi.fn(async (): Promise<{ dbId: number } | null> => null),
  recordAbuseEvent: vi.fn(),
}));

vi.mock("@/lib/admin-logs/record-abuse", () => ({ recordAbuseEvent: h.recordAbuseEvent }));
vi.mock("@/lib/admin-logs/manual-ban-cache", () => ({ isManuallyBanned: vi.fn(() => false) }));
vi.mock("@/lib/geo", () => ({ lookupCountry: vi.fn(async () => null) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn() } }));
vi.mock("next-auth/jwt", () => ({ getToken: h.getToken }));

import { middleware } from "@/middleware";
import {
  PARSE_ENGINE_PARSE_BURST_LIMIT,
  PARSE_ENGINE_PARSE_RULE_NAME,
  findRateRule,
  isParseEngineParsePath,
  parserBurstBucket,
} from "@/lib/middleware-rate-limit";

const BASE = new Date("2026-10-27T00:00:00.000Z").getTime();
const P1 = "/api/projects/11111111-1111-4111-8111-111111111111/parse-engine/parse";
const P2 = "/api/projects/22222222-2222-4222-8222-222222222222/parse-engine/parse";

function post(path: string, ip: string, signedIn = false): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "user-agent": "parse-engine-rate",
      "x-forwarded-for": ip,
      ...(signedIn ? { cookie: "authjs.session-token=opaque" } : {}),
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
  h.recordAbuseEvent.mockClear();
  h.getToken.mockResolvedValue(null);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("classification", () => {
  it("the exact regex matches only the parse route, for any project id", () => {
    expect(isParseEngineParsePath(P1)).toBe(true);
    expect(isParseEngineParsePath("/api/projects/not-a-uuid/parse-engine/parse")).toBe(true);
    for (const p of [
      "/api/projects/x/parse-engine/parse/extra",
      "/api/projects/x/parse-engine/flags",
      "/api/projects/x/y/parse-engine/parse",
      "/api/projects//parse-engine/parse",
      "/api/projects/x/parse-engine/parsex",
    ]) expect(isParseEngineParsePath(p)).toBe(false);
  });

  it("POST gets the named rule (user-keyed); other methods do not", () => {
    const rule = findRateRule(P1, "POST");
    expect(rule).toMatchObject({ pattern: PARSE_ENGINE_PARSE_RULE_NAME, method: "POST", keyType: "user" });
    expect(findRateRule(P2, "POST")).toBe(rule);
    expect(findRateRule(P1, "GET")).toBeUndefined();
  });

  it("the burst bucket is the rule name with its own limit, not the first path segments", () => {
    expect(parserBurstBucket(P1, 5)).toEqual({ route: PARSE_ENGINE_PARSE_RULE_NAME, limit: PARSE_ENGINE_PARSE_BURST_LIMIT });
    expect(parserBurstBucket(P2, 5)).toEqual(parserBurstBucket(P1, 5));
    expect(parserBurstBucket("/api/projects/x/pages", 5).route).toBe("/api/projects");
  });
});

describe("middleware admission", () => {
  it("the parse route is in the parser lane: its burst is shared across project ids and breaches past the limit", async () => {
    const ip = "203.0.113.70";
    for (let i = 0; i < PARSE_ENGINE_PARSE_BURST_LIMIT; i += 1) {
      expect((await middleware(post(i % 2 ? P1 : P2, ip))).status).toBe(200);
    }
    const over = await middleware(post(P1, ip));
    expect(over.status).toBe(429);
    expect(h.recordAbuseEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "RATE_LIMIT_BREACH", ip, path: P1 }));
  });

  it("the parse burst neither spends nor shares another parser route's bucket", async () => {
    const ip = "203.0.113.71";
    for (let i = 0; i < PARSE_ENGINE_PARSE_BURST_LIMIT; i += 1) {
      expect((await middleware(post(P1, ip))).status).toBe(200);
    }
    for (let i = 0; i < 5; i += 1) {
      expect((await middleware(post("/api/shape-parse", ip))).status).toBe(200);
    }
    expect(h.recordAbuseEvent).not.toHaveBeenCalled();
  });

  it("a non-parser project route is not in the parser lane", async () => {
    const ip = "203.0.113.72";
    for (let i = 0; i < PARSE_ENGINE_PARSE_BURST_LIMIT + 5; i += 1) {
      expect((await middleware(post("/api/projects/x/parse-engine/flags", ip))).status).toBe(200);
    }
    expect(h.recordAbuseEvent).not.toHaveBeenCalled();
  });

  it("the route rule is per verified user, 120 per minute, across project ids", async () => {
    h.getToken.mockResolvedValue({ dbId: 4242 });
    const rule = findRateRule(P1, "POST")!;
    let admitted = 0;
    // stay under the per-IP burst (20 / 10 s) and the IP backstop by spreading requests over addresses
    for (let i = 0; i < rule.limit + 1; i += 1) {
      const res = await middleware(post(i % 2 ? P1 : P2, `198.51.100.${(i % 200) + 1}`, true));
      if (res.status === 200) admitted += 1;
    }
    expect(admitted).toBe(rule.limit);
  });
});
