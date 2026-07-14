// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  recordAbuseEvent: vi.fn(),
  lookupCountry: vi.fn(async () => null),
  loggerInfo: vi.fn(),
}));

vi.mock("@/lib/admin-logs/record-abuse", () => ({
  recordAbuseEvent: h.recordAbuseEvent,
}));
vi.mock("@/lib/admin-logs/manual-ban-cache", () => ({
  isManuallyBanned: vi.fn(() => false),
}));
vi.mock("@/lib/geo", () => ({ lookupCountry: h.lookupCountry }));
vi.mock("@/lib/logger", () => ({
  logger: { info: h.loggerInfo },
}));
vi.mock("next-auth/jwt", () => ({ getToken: vi.fn(async () => null) }));

import { middleware } from "@/middleware";

describe("deprecated-route middleware admission", () => {
  beforeEach(() => {
    h.recordAbuseEvent.mockClear();
  });

  it("cannot bypass one tight bucket by spoofing changing left XFF hops", async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 128; index += 1) {
      const spoofedLeftHop = `198.51.100.${index + 1}`;
      const request = new NextRequest(
        "http://localhost/api/labeling/credentials",
        {
          headers: {
            "user-agent": "deprecated-route-regression-test",
            "x-forwarded-for": `${spoofedLeftHop}, 203.0.113.77`,
          },
        },
      );
      statuses.push((await middleware(request)).status);
    }

    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5)).toHaveLength(123);
    expect(statuses.slice(5).every((status) => status === 429)).toBe(true);
    expect(h.recordAbuseEvent).toHaveBeenCalledTimes(1);
    expect(h.recordAbuseEvent).toHaveBeenCalledWith({
      eventType: "DEPRECATED_ROUTE",
      ip: "203.0.113.77",
      path: "/api/labeling/credentials",
      userAgent: "deprecated-route-regression-test",
      details: { windowMs: 60_000 },
    });
  });
});
