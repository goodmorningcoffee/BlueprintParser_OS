/**
 * [2026-10-25 root hardening] GET/PUT /api/admin/llm-owner-key — ROOT ONLY (verified 2FA): which
 * companies may run chat on the owner's environment LLM keys (lib/llm/owner-key-grant.ts). Every
 * change is audited with the list it replaced.
 */

import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import { audit } from "@/lib/audit";
import type { AuthSession } from "@/lib/api-utils";
import { LLM_OWNER_KEY_GRANTS_KEY, parseOwnerKeyGrants, type LlmOwnerKeyGrants } from "@/lib/llm/owner-key-grant";
import { requireVerifiedRoot } from "@/server/api/root-authority";

export const zLlmOwnerKeyPut = z
  .object({ companyId: z.number().int().positive().max(2147483647), granted: z.boolean() })
  .strict();
export type LlmOwnerKeyPutBody = z.infer<typeof zLlmOwnerKeyPut>;

export async function getLlmOwnerKeyGrants(session: AuthSession): Promise<LlmOwnerKeyGrants> {
  requireVerifiedRoot(session);
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, LLM_OWNER_KEY_GRANTS_KEY)).limit(1);
  return parseOwnerKeyGrants(row?.value);
}

export async function putLlmOwnerKeyGrant(session: AuthSession, body: LlmOwnerKeyPutBody): Promise<{ companies: number[] }> {
  requireVerifiedRoot(session);
  const after = await db.transaction(async (tx) => {
    const [row] = await tx.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, LLM_OWNER_KEY_GRANTS_KEY)).limit(1).for("update");
    const before = parseOwnerKeyGrants(row?.value);
    const companies = body.granted
      ? Array.from(new Set([...before.companies, body.companyId])).sort((a, b) => a - b)
      : before.companies.filter((id) => id !== body.companyId);
    const value = { companies } as unknown as Record<string, unknown>;
    if (row) {
      await tx.update(appSettings).set({ value, updatedBy: session.user.dbId, updatedAt: new Date() }).where(eq(appSettings.key, LLM_OWNER_KEY_GRANTS_KEY));
    } else {
      await tx.insert(appSettings).values({ key: LLM_OWNER_KEY_GRANTS_KEY, value, updatedBy: session.user.dbId });
    }
    audit("llm_owner_key_grant_changed", {
      userId: session.user.dbId,
      companyId: session.user.companyId,
      details: { targetCompanyId: body.companyId, granted: body.granted, before: before.companies, after: companies },
    });
    return { companies };
  });
  return after;
}
