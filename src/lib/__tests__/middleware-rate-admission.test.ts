// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  getToken: vi.fn(async (): Promise<{ dbId: number } | null> => null),
  lookupCountry: vi.fn(async () => null),
  loggerInfo: vi.fn(),
}));

vi.mock("@/lib/admin-logs/record-abuse", () => ({
  recordAbuseEvent: vi.fn(),
}));
vi.mock("@/lib/admin-logs/manual-ban-cache", () => ({
  isManuallyBanned: vi.fn(() => false),
}));
vi.mock("@/lib/geo", () => ({ lookupCountry: h.lookupCountry }));
vi.mock("@/lib/logger", () => ({
  logger: { info: h.loggerInfo },
}));
vi.mock("next-auth/jwt", () => ({ getToken: h.getToken }));

import { middleware, middlewareRateLimitStoreSizeForTest } from "@/middleware";

function apiRequest(path: string, ip: string, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      ...(cookie ? { cookie: `authjs.session-token=${cookie}` } : {}),
      "user-agent": "middleware-rate-admission-test",
      "x-forwarded-for": ip,
    },
  });
}

async function responseStatuses(
  count: number,
  requestForIndex: (index: number) => NextRequest,
): Promise<number[]> {
  const statuses: number[] = [];
  for (let index = 0; index < count; index += 1) {
    statuses.push((await middleware(requestForIndex(index))).status);
  }
  return statuses;
}

describe("middleware rate admission identity and IP backstops", () => {
  beforeEach(() => {
    h.getToken.mockReset();
    h.getToken.mockResolvedValue(null);
    h.lookupCountry.mockClear();
    h.loggerInfo.mockClear();
  });

  it("cannot bypass or inflate a user bucket by rotating unverified cookie bytes", async () => {
    const before = middlewareRateLimitStoreSizeForTest();
    const statuses = await responseStatuses(11, (index) =>
      apiRequest(
        "/api/projects",
        "203.0.113.201",
        `attacker-selected-${index}`,
      ),
    );

    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
    // One shared general-IP backstop plus one route/IP fallback. Cookie
    // rotation must not allocate one map entry per attacker-selected value.
    expect(middlewareRateLimitStoreSizeForTest() - before).toBe(2);
    expect(h.getToken).toHaveBeenCalledTimes(11);
  });

  it("uses one verified stable user id across cookie rotation and client IPs", async () => {
    h.getToken.mockResolvedValue({ dbId: 42 });
    const before = middlewareRateLimitStoreSizeForTest();
    const statuses = await responseStatuses(11, (index) =>
      apiRequest(
        "/api/projects",
        index % 2 === 0 ? "203.0.113.202" : "203.0.113.203",
        `valid-rotated-token-${index}`,
      ),
    );

    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
    // Two IP backstops plus one verified-user route bucket.
    expect(middlewareRateLimitStoreSizeForTest() - before).toBe(3);
  });

  it("applies the shared 120/minute IP backstop alongside a permissive user rule", async () => {
    const before = middlewareRateLimitStoreSizeForTest();
    const statuses = await responseStatuses(121, (index) =>
      apiRequest("/api/yolo/run", "203.0.113.204", `unverified-${index}`),
    );

    expect(statuses.slice(0, 120).every((status) => status === 200)).toBe(true);
    expect(statuses[120]).toBe(429);
    expect(middlewareRateLimitStoreSizeForTest() - before).toBe(2);
  });

  it("keeps high-fanout viewer traffic on an independent bounded 600/minute IP backstop", async () => {
    const before = middlewareRateLimitStoreSizeForTest();
    const projectId = "550e8400-e29b-41d4-a716-446655440000";
    const statuses = await responseStatuses(
      601,
      () =>
        new NextRequest(
          `http://localhost/api/project-assets/${projectId}/original.pdf`,
          {
            headers: {
              "user-agent": "middleware-rate-admission-test",
              "x-forwarded-for": "203.0.113.205",
            },
          },
        ),
    );

    expect(statuses.slice(0, 600).every((status) => status === 200)).toBe(true);
    expect(statuses[600]).toBe(429);
    // Route and backstop buckets are deliberately independent namespaces.
    expect(middlewareRateLimitStoreSizeForTest() - before).toBe(2);
  }, 10_000);
});
