// @vitest-environment node
// [hardening sep30] The demo chat cap used to count chat_messages rows that are never written.
// It now counts requests in runtime_counters, and must actually refuse.
import { beforeEach, describe, expect, inject, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { runtimeCounters } from "@/lib/db/schema";
import { DEMO_CHAT_DAILY_LIMIT, checkDemoChatQuota } from "@/lib/quotas";

const dbUp = inject("dbUp") as boolean;
const today = () => new Date().toISOString().slice(0, 10);
const demoChatRow = and(eq(runtimeCounters.scope, "demo_chat"), eq(runtimeCounters.key, today()));

beforeEach(async () => {
  if (dbUp) await db.delete(runtimeCounters).where(eq(runtimeCounters.scope, "demo_chat"));
});

describe.skipIf(!dbUp)("checkDemoChatQuota", () => {
  it("every call consumes one unit", async () => {
    expect(await checkDemoChatQuota()).toMatchObject({ allowed: true, current: 1 });
    expect(await checkDemoChatQuota()).toMatchObject({ allowed: true, current: 2 });
  });

  it("allows the limit-th request and refuses the next", async () => {
    await checkDemoChatQuota();
    await db.update(runtimeCounters).set({ count: DEMO_CHAT_DAILY_LIMIT - 1 }).where(demoChatRow);
    expect(await checkDemoChatQuota()).toMatchObject({ allowed: true, current: DEMO_CHAT_DAILY_LIMIT });
    const refused = await checkDemoChatQuota();
    expect(refused.allowed).toBe(false);
    expect(refused.message).toBe("Demo chat limit reached for today. Sign up for full access!");
  });

  it("an expired window starts again from one", async () => {
    await checkDemoChatQuota();
    await db
      .update(runtimeCounters)
      .set({ count: 9_999, resetAt: new Date(Date.now() - 1_000) })
      .where(demoChatRow);
    expect(await checkDemoChatQuota()).toMatchObject({ allowed: true, current: 1 });
  });
});
