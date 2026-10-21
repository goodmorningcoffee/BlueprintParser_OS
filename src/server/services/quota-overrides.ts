// [2026-10-21] Root-only quota overrides (owner ruling: "i want ability to modify the limit for a
// user"). The document lives in the existing app_settings table under QUOTA_OVERRIDES_KEY — no
// schema change. Precedence and the request-path reader live in src/lib/quota-overrides.ts.
//
//   GET  → { overrides: {users, companies}, defaults }        (route auth:"root")
//   PUT  → { target: "user"|"company", id, limits }            (route auth:"root")
//          `limits` REPLACES that subject's entry: a field set to an integer 0..1,000,000 is that
//          limit, null is unlimited, an omitted field returns to the default; {} clears the
//          subject. Unknown keys are rejected (zod .strict()); the subject must exist.
//          The write and its audit_log row commit in ONE transaction, under a row lock, so two
//          concurrent saves cannot lose each other's change and no change is ever unaudited.

import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { appSettings, auditLog, companies, users } from "@/lib/db/schema";
import type { AuthSession } from "@/lib/api-utils";
import { ApiError } from "@/server/api/envelope";
import {
  QUOTA_DEFAULTS,
  QUOTA_OVERRIDES_KEY,
  QUOTA_OVERRIDE_MAX,
  parseQuotaOverrides,
  type QuotaOverrideEntry,
  type QuotaOverrides,
} from "@/lib/quota-overrides";

const zLimit = z.union([z.number().int().min(0).max(QUOTA_OVERRIDE_MAX), z.null()]);

export const zQuotaOverridePut = z
  .object({
    target: z.enum(["user", "company"]),
    id: z.number().int().positive().max(2147483647),
    limits: z
      .object({
        uploadsPerDay: zLimit.optional(),
        yoloJobsPerDay: zLimit.optional(),
        chatMessagesPerDay: zLimit.optional(),
      })
      .strict(),
  })
  .strict();
export type QuotaOverridePutBody = z.infer<typeof zQuotaOverridePut>;

export const QUOTA_OVERRIDE_AUDIT_ACTION = "quota_override_changed";

export async function getQuotaOverrides(): Promise<{
  overrides: QuotaOverrides;
  defaults: typeof QUOTA_DEFAULTS;
}> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, QUOTA_OVERRIDES_KEY))
    .limit(1);
  return { overrides: parseQuotaOverrides(row?.value), defaults: QUOTA_DEFAULTS };
}

function cleanEntry(limits: QuotaOverridePutBody["limits"]): QuotaOverrideEntry {
  const entry: QuotaOverrideEntry = {};
  if (limits.uploadsPerDay !== undefined) entry.uploadsPerDay = limits.uploadsPerDay;
  if (limits.yoloJobsPerDay !== undefined) entry.yoloJobsPerDay = limits.yoloJobsPerDay;
  if (limits.chatMessagesPerDay !== undefined) entry.chatMessagesPerDay = limits.chatMessagesPerDay;
  return entry;
}

export async function putQuotaOverride(
  body: QuotaOverridePutBody,
  session: AuthSession,
): Promise<{ success: true; overrides: QuotaOverrides }> {
  // The route is auth:"root"; this is the in-service belt so no other caller can reach a write.
  if (!session.user.isRootAdmin) throw new ApiError("FORBIDDEN", "Root admin required");

  const { target, id } = body;
  const exists =
    target === "user"
      ? (await db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1)).length > 0
      : (await db.select({ id: companies.id }).from(companies).where(eq(companies.id, id)).limit(1)).length > 0;
  if (!exists) throw new ApiError("VALIDATION", `Unknown ${target} id ${id}`);

  const entry = cleanEntry(body.limits);
  const section = target === "user" ? "users" : "companies";

  const next = await db.transaction(async (tx) => {
    await tx
      .insert(appSettings)
      .values({ key: QUOTA_OVERRIDES_KEY, value: { users: {}, companies: {} }, updatedBy: session.user.dbId })
      .onConflictDoNothing();
    const [row] = await tx
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, QUOTA_OVERRIDES_KEY))
      .for("update");
    // Lenient read: a hand-edited malformed document is normalized on the next save.
    const current = parseQuotaOverrides(row?.value);
    const before = current[section][String(id)] ?? null;
    if (Object.keys(entry).length > 0) current[section][String(id)] = entry;
    else delete current[section][String(id)];

    await tx
      .update(appSettings)
      .set({ value: current as unknown as Record<string, unknown>, updatedBy: session.user.dbId, updatedAt: new Date() })
      .where(eq(appSettings.key, QUOTA_OVERRIDES_KEY));
    await tx.insert(auditLog).values({
      action: QUOTA_OVERRIDE_AUDIT_ACTION,
      userId: session.user.dbId,
      companyId: session.user.companyId,
      details: { target, id, before, after: Object.keys(entry).length > 0 ? entry : null },
    });
    return current;
  });

  return { success: true, overrides: next };
}
