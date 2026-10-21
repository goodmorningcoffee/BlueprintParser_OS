// @vitest-environment node
// Owner ruling 2026-10-21: per-user / per-company quota overrides, root exempt. Pure resolver
// (src/lib/quota-overrides.ts): precedence root > user > company > default, null = unlimited,
// 0 = a real limit, missing keys fall through, malformed documents never throw.
import { describe, expect, it } from "vitest";
import {
  QUOTA_DEFAULTS,
  QUOTA_OVERRIDE_MAX,
  emptyQuotaOverrides,
  parseQuotaOverrides,
  resolveQuotaLimit,
} from "@/lib/quota-overrides";

const doc = parseQuotaOverrides({
  users: { "7": { uploadsPerDay: 50, chatMessagesPerDay: null }, "8": { yoloJobsPerDay: 0 } },
  companies: { "3": { uploadsPerDay: 20, yoloJobsPerDay: null } },
});

describe("resolveQuotaLimit precedence", () => {
  it("root beats everything (even a user override of 0)", () => {
    const zeroDoc = parseQuotaOverrides({ users: { "7": { uploadsPerDay: 0 } } });
    expect(resolveQuotaLimit("uploadsPerDay", 3, { companyId: 3, userId: 7, isRootAdmin: true }, zeroDoc)).toEqual({ source: "root" });
  });

  it("user beats company beats default", () => {
    expect(resolveQuotaLimit("uploadsPerDay", 3, { companyId: 3, userId: 7 }, doc)).toEqual({ source: "user", limit: 50 });
    expect(resolveQuotaLimit("uploadsPerDay", 3, { companyId: 3, userId: 99 }, doc)).toEqual({ source: "company", limit: 20 });
    expect(resolveQuotaLimit("uploadsPerDay", 3, { companyId: 4, userId: 99 }, doc)).toEqual({ source: "default", limit: 3 });
  });

  it("a field missing at the user level falls through to the company, then the default", () => {
    // user 7 has no yoloJobsPerDay → company 3's null (unlimited)
    expect(resolveQuotaLimit("yoloJobsPerDay", 10, { companyId: 3, userId: 7 }, doc)).toEqual({ source: "company", limit: null });
    // user 7 in a company without overrides, field not set → default
    expect(resolveQuotaLimit("yoloJobsPerDay", 10, { companyId: 4, userId: 7 }, doc)).toEqual({ source: "default", limit: 10 });
  });

  it("null = unlimited and 0 = refuse-all are distinct and both honoured", () => {
    expect(resolveQuotaLimit("chatMessagesPerDay", 200, { companyId: 4, userId: 7 }, doc)).toEqual({ source: "user", limit: null });
    expect(resolveQuotaLimit("yoloJobsPerDay", 10, { companyId: 3, userId: 8 }, doc)).toEqual({ source: "user", limit: 0 });
  });

  it("no userId (or an invalid one) never matches a user entry", () => {
    expect(resolveQuotaLimit("uploadsPerDay", 3, { companyId: 3 }, doc)).toEqual({ source: "company", limit: 20 });
    expect(resolveQuotaLimit("uploadsPerDay", 3, { companyId: 3, userId: null }, doc)).toEqual({ source: "company", limit: 20 });
    expect(resolveQuotaLimit("uploadsPerDay", 3, { companyId: 3, userId: -7 }, doc)).toEqual({ source: "company", limit: 20 });
  });

  it("an empty document yields the code defaults (byte-identical behaviour)", () => {
    expect(resolveQuotaLimit("uploadsPerDay", QUOTA_DEFAULTS.uploadsPerDay.member, { companyId: 1, userId: 1 }, emptyQuotaOverrides()))
      .toEqual({ source: "default", limit: 3 });
    expect(QUOTA_DEFAULTS).toEqual({ uploadsPerDay: { member: 3, admin: 10 }, yoloJobsPerDay: 10, chatMessagesPerDay: 200 });
  });
});

describe("parseQuotaOverrides is lenient and never throws", () => {
  it.each([
    undefined,
    null,
    42,
    "quota",
    [],
    [{ users: {} }],
    { users: "x", companies: 5 },
    { users: [], companies: null },
  ])("malformed document %j → empty overrides", (raw) => {
    expect(parseQuotaOverrides(raw)).toEqual(emptyQuotaOverrides());
  });

  it("drops invalid values field by field and keeps the valid ones", () => {
    const parsed = parseQuotaOverrides({
      users: {
        "1": { uploadsPerDay: -1, yoloJobsPerDay: 5, chatMessagesPerDay: "9" },
        "2": { uploadsPerDay: 1.5 },
        "3": { uploadsPerDay: QUOTA_OVERRIDE_MAX + 1 },
        "4": { uploadsPerDay: QUOTA_OVERRIDE_MAX },
        "5": { somethingElse: 3 },
        "6": "not-an-object",
        "007": { uploadsPerDay: 1 },
        abc: { uploadsPerDay: 1 },
        "0": { uploadsPerDay: 1 },
      },
      companies: { "9": { uploadsPerDay: Number.NaN, yoloJobsPerDay: Infinity } },
    });
    expect(parsed).toEqual({
      users: { "1": { yoloJobsPerDay: 5 }, "4": { uploadsPerDay: QUOTA_OVERRIDE_MAX } },
      companies: {},
    });
  });

  it("an object whose getters throw still returns empty instead of throwing", () => {
    const hostile = {};
    Object.defineProperty(hostile, "users", { get() { throw new Error("boom"); }, enumerable: true });
    expect(() => parseQuotaOverrides(hostile)).not.toThrow();
    expect(parseQuotaOverrides(hostile)).toEqual(emptyQuotaOverrides());
  });

  it("prototype keys are not treated as entries", () => {
    const parsed = parseQuotaOverrides(JSON.parse('{"users":{"__proto__":{"uploadsPerDay":1}},"companies":{}}'));
    expect(parsed.users).toEqual({});
    expect(resolveQuotaLimit("uploadsPerDay", 3, { companyId: 1, userId: 1 }, parsed)).toEqual({ source: "default", limit: 3 });
  });
});
