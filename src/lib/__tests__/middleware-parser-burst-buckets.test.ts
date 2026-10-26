// @vitest-environment node
// [TP-1 WP-1.D, K21] Guided's slider re-proposes on a 300 ms debounce. `/api/table-parse/propose`
// used to share the `/api/table-parse` 5/10 s burst bucket, so tuning a proposal spent the table
// parse budget and the second breach banned the IP from every parser route for an hour. It now has
// its own bucket (`parserBurstBucket`). The escalation contract itself is pinned, unchanged, by
// middleware-auto-ban.test.ts. Unique ip per case: the stores are module-level singletons.
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
import { PARSER_OWN_BURST_BUCKETS, parserBurstBucket } from "@/lib/middleware-rate-limit";

const BASE = new Date("2026-10-26T00:00:00.000Z").getTime();
const PROPOSE = "/api/table-parse/propose";

function post(path: string, ip: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "user-agent": "parser-burst-buckets", "x-forwarded-for": ip },
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

describe("parserBurstBucket", () => {
  it("gives /propose its own route key and limit; every other parser path keys on its prefix", () => {
    expect(parserBurstBucket(PROPOSE, 5)).toEqual({ route: PROPOSE, limit: PARSER_OWN_BURST_BUCKETS[PROPOSE] });
    expect(parserBurstBucket("/api/table-parse", 5)).toEqual({ route: "/api/table-parse", limit: 5 });
    expect(parserBurstBucket("/api/table-parse/other", 5)).toEqual({ route: "/api/table-parse", limit: 5 });
    expect(parserBurstBucket("/api/table-parse/proposeX", 5)).toEqual({ route: "/api/table-parse", limit: 5 });
    expect(parserBurstBucket("/api/symbol-search/x", 5)).toEqual({ route: "/api/symbol-search", limit: 5 });
  });
});

describe("middleware: /propose does not spend the /table-parse burst (K21)", () => {
  it("10 propose calls in 10 s are admitted and /table-parse still admits its full 5", async () => {
    const ip = "203.0.113.40";
    for (let i = 0; i < 10; i += 1) {
      expect((await middleware(post(PROPOSE, ip))).status).toBe(200);
      vi.advanceTimersByTime(900);
    }
    for (let i = 0; i < 5; i += 1) {
      expect((await middleware(post("/api/table-parse", ip))).status).toBe(200);
    }
    expect(h.recordAbuseEvent).not.toHaveBeenCalled();
  });

  it("/propose is still bounded: one past its own limit breaches and escalates as before", async () => {
    const ip = "203.0.113.41";
    const limit = PARSER_OWN_BURST_BUCKETS[PROPOSE];
    for (let i = 0; i < limit; i += 1) {
      expect((await middleware(post(PROPOSE, ip))).status).toBe(200);
    }
    const over = await middleware(post(PROPOSE, ip));
    expect(over.status).toBe(429);
    expect(h.recordAbuseEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "RATE_LIMIT_BREACH", ip, path: PROPOSE }),
    );
  });

  it("/table-parse keeps its 5/10 s bucket: the 6th breaches", async () => {
    const ip = "203.0.113.42";
    for (let i = 0; i < 5; i += 1) {
      expect((await middleware(post("/api/table-parse", ip))).status).toBe(200);
    }
    expect((await middleware(post("/api/table-parse", ip))).status).toBe(429);
  });
});
