// @vitest-environment node
// [hardening sep30] abuse_events.path is varchar(255) and the value is caller-controlled. An
// over-long path made the insert fail, so a real auto-ban was applied with no row saying why.
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ values: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/db", () => ({ db: { insert: () => ({ values: h.values }) } }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

import { recordAbuseEvent } from "@/lib/admin-logs/record-abuse";

describe("recordAbuseEvent — column bounds", () => {
  it("clips path and user-agent to the column width and keeps the row", () => {
    recordAbuseEvent({
      eventType: "RATE_LIMIT_BREACH",
      ip: "203.0.113.9",
      path: `/api/${"p".repeat(10_000)}`,
      userAgent: "u".repeat(10_000),
    });
    const [row] = h.values.mock.calls[0] as unknown as [{ path: string; userAgent: string }];
    expect(row.path).toHaveLength(255);
    expect(row.userAgent).toHaveLength(255);
  });

  it("leaves short values and absent values alone", () => {
    recordAbuseEvent({ eventType: "RATE_LIMIT_BREACH", ip: "203.0.113.9", path: "/api/x" });
    const [row] = h.values.mock.calls.at(-1) as unknown as [{ path: string; userAgent: null }];
    expect(row.path).toBe("/api/x");
    expect(row.userAgent).toBeNull();
  });
});
