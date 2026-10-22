// @vitest-environment node
// Owner ruling 2026-10-21: the quota checks in src/lib/quotas.ts exempt a root admin (no read, no
// count, no consume) and apply per-user / per-company overrides. Without overrides a non-root
// caller must see exactly the shipped limits and messages. The DB is mocked so the SQL each check
// issues (and does NOT issue) can be asserted.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const h = vi.hoisted(() => ({
  execute: vi.fn(),
  consumeDailyCounter: vi.fn(),
  overrides: undefined as unknown,
  overridesThrows: false,
  count: 0,
  queries: [] as { text: string; params: unknown[] }[],
}));

vi.mock("@/lib/db", () => ({ db: { execute: h.execute } }));
vi.mock("@/lib/compute-usage", () => ({ consumeDailyCounter: h.consumeDailyCounter }));

import { checkChatQuota, checkDemoChatQuota, checkUploadQuota, checkYoloQuota } from "@/lib/quotas";

const dialect = new PgDialect();

beforeEach(() => {
  h.overrides = undefined;
  h.overridesThrows = false;
  h.count = 0;
  h.queries = [];
  h.consumeDailyCounter.mockReset();
  h.execute.mockReset();
  h.execute.mockImplementation(async (query: SQL) => {
    const { sql: text, params } = dialect.sqlToQuery(query);
    h.queries.push({ text, params });
    if (text.includes("app_settings")) {
      if (h.overridesThrows) throw new Error("db down");
      return { rows: h.overrides === undefined ? [] : [{ value: h.overrides }] };
    }
    return { rows: [{ cnt: h.count }] };
  });
});

const countQueries = () => h.queries.filter((q) => !q.text.includes("app_settings"));

describe("root admin is exempt from every quota (no read, no count)", () => {
  it("uploads, YOLO, chat: allowed with zero DB queries", async () => {
    h.overrides = { users: { "5": { uploadsPerDay: 0, yoloJobsPerDay: 0, chatMessagesPerDay: 0 } } };
    h.count = 1_000_000;
    expect(await checkUploadQuota(1, "member", true, 5)).toEqual({ allowed: true });
    expect(await checkYoloQuota(1, true, 5)).toEqual({ allowed: true });
    expect(await checkChatQuota(1, true, 5)).toEqual({ allowed: true });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("demo chat: root neither checks nor consumes the shared pool", async () => {
    expect(await checkDemoChatQuota(true)).toEqual({ allowed: true });
    expect(h.consumeDailyCounter).not.toHaveBeenCalled();
    h.consumeDailyCounter.mockResolvedValue(501);
    expect(await checkDemoChatQuota()).toEqual({
      allowed: false,
      message: "Demo chat limit reached for today. Sign up for full access!",
      current: 501,
      limit: 500,
    });
    expect(h.consumeDailyCounter).toHaveBeenCalledExactlyOnceWith("demo_chat");
  });
});

describe("non-root with no overrides: byte-identical to the shipped limits", () => {
  it.each([
    ["member upload", () => checkUploadQuota(1, "member", false, 5), 3, "Daily upload limit reached (3/day)"],
    ["admin upload", () => checkUploadQuota(1, "admin", false, 5), 10, "Daily upload limit reached (10/day)"],
    ["legacy 2-arg upload", () => checkUploadQuota(1, "member"), 3, "Daily upload limit reached (3/day)"],
    ["YOLO", () => checkYoloQuota(1, false, 5), 10, "Daily YOLO job limit reached (10/day)"],
    ["chat", () => checkChatQuota(1, false, 5), 200, "Daily chat limit reached (200/day for your organization)"],
  ] as const)("%s: limit-1 allowed, limit refused with the same message", async (_name, check, limit, message) => {
    h.count = limit - 1;
    expect(await check()).toEqual({ allowed: true, current: limit - 1, limit });
    h.count = limit;
    expect(await check()).toEqual({ allowed: false, message, current: limit, limit });
    // counted by company, exactly as shipped
    for (const q of countQueries()) expect(q.text).toMatch(/company_id = \$1/);
  });

  it("a malformed overrides document falls back to the defaults", async () => {
    h.overrides = "garbage";
    h.count = 3;
    expect(await checkUploadQuota(1, "member", false, 5)).toMatchObject({ allowed: false, limit: 3 });
  });

  it("a failed overrides read falls back to the defaults and does not throw", async () => {
    h.overridesThrows = true;
    h.count = 9;
    expect(await checkYoloQuota(1, false, 5)).toEqual({ allowed: true, current: 9, limit: 10 });
  });
});

describe("overrides", () => {
  it("user override null = unlimited: allowed without counting", async () => {
    h.overrides = { users: { "5": { uploadsPerDay: null } } };
    h.count = 999;
    expect(await checkUploadQuota(1, "member", false, 5)).toEqual({ allowed: true });
    expect(countQueries()).toHaveLength(0);
  });

  it("user upload override counts that user's OWN projects (projects.author_id)", async () => {
    h.overrides = { users: { "5": { uploadsPerDay: 50 } } };
    h.count = 49;
    expect(await checkUploadQuota(1, "member", false, 5)).toEqual({ allowed: true, current: 49, limit: 50 });
    const [q] = countQueries();
    expect(q.text).toMatch(/author_id = \$1/);
    expect(q.params).toEqual([5]);
    h.count = 50;
    expect(await checkUploadQuota(1, "member", false, 5)).toMatchObject({
      allowed: false,
      message: "Daily upload limit reached (50/day)",
    });
  });

  it("company override applies to every user without a user override, counted by company", async () => {
    h.overrides = { companies: { "1": { uploadsPerDay: 20 } }, users: { "6": { uploadsPerDay: 2 } } };
    h.count = 19;
    expect(await checkUploadQuota(1, "admin", false, 5)).toEqual({ allowed: true, current: 19, limit: 20 });
    expect(countQueries()[0].text).toMatch(/company_id = \$1/);
    h.queries = [];
    h.count = 2;
    expect(await checkUploadQuota(1, "admin", false, 6)).toMatchObject({ allowed: false, limit: 2 });
    expect(countQueries()[0].text).toMatch(/author_id = \$1/);
  });

  it("zero is a real limit: refuses the first action", async () => {
    h.overrides = { companies: { "1": { yoloJobsPerDay: 0 } } };
    h.count = 0;
    expect(await checkYoloQuota(1, false, 5)).toEqual({
      allowed: false,
      message: "Daily YOLO job limit reached (0/day)",
      current: 0,
      limit: 0,
    });
  });

  it("YOLO user override changes the limit only; the count stays the company's jobs", async () => {
    h.overrides = { users: { "5": { yoloJobsPerDay: 25 } } };
    h.count = 24;
    expect(await checkYoloQuota(1, false, 5)).toEqual({ allowed: true, current: 24, limit: 25 });
    expect(countQueries()[0].text).toMatch(/p\.company_id = \$1/);
  });

  it("[2026-10-22 DOUBLE_BACK quota burn] a YOLO job SageMaker never accepted does not count toward the day", async () => {
    h.count = 3;
    await checkYoloQuota(1, false, 5);
    expect(countQueries()[0].text).toMatch(/pj\.error IS NULL OR pj\.error NOT LIKE 'SageMaker job never accepted%'/u);
  });

  it("chat user override counts that user's own messages (chat_messages.user_id)", async () => {
    h.overrides = { users: { "5": { chatMessagesPerDay: 1000 } } };
    h.count = 1000;
    expect(await checkChatQuota(1, false, 5)).toMatchObject({
      allowed: false,
      message: "Daily chat limit reached (1000/day for your organization)",
    });
    expect(countQueries()[0].text).toMatch(/cm\.user_id = \$1/);
  });
});
