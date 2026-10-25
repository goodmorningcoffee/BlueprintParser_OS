// [refactor jul6 S041] ADMIN B6 — model-access root grant/revoke contracts (GET list, POST
// grant, DELETE revoke), folded from the legacy route (git show 858777f:src/app/api/admin/
// model-access/route.ts at the freeze). Char: __tests__/admin-models-access.route.test.ts (MA-*).
//
// requireRootAdmin (the shell provides auth:"root"). Sanctioned diffs:
//   • A — flat auth errors → envelope; the POST validation + ownership/existence 400/404
//     literals stay byte-verbatim here as ApiError(...).
//   • E — the legacy `req.json().catch(()=>({}))` graceful parse is subsumed by the shell
//     raw-parse (malformed → 400 BAD_REQUEST "Invalid JSON body", pre-auth).
//   • NO B — no catch-500 literals; unexpected db errors propagate to the shell generic 500.
// PRESERVED verbatim: parseTarget null-aware userId, the ownership gate (root may only
// grant/revoke models IT uploaded: model.companyId===session.companyId → else 404 "Model not
// found"), the cross-company-user check, and the null-aware UPSERT (select existing by
// modelId+companyId+userId[isNull|eq] → update enabled OR insert grantedBy).

import { db } from "@/lib/db";
import { models, modelAccess, companies, users } from "@/lib/db/schema";
import { and, eq, isNull, desc } from "drizzle-orm";
import type { AuthSession } from "@/lib/api-utils";
import { ApiError } from "@/server/api/envelope";
import { audit } from "@/lib/audit";

export async function getModelAccess(session: AuthSession): Promise<unknown> {
  // Models root uploaded (owned by root's company).
  const rootModels = await db
    .select({ id: models.id, name: models.name, type: models.type })
    .from(models)
    .where(eq(models.companyId, session.user.companyId))
    .orderBy(desc(models.createdAt));

  // Grants on root's own models only (join models, filter by owner company).
  const grants = await db
    .select({
      id: modelAccess.id,
      modelId: modelAccess.modelId,
      companyId: modelAccess.companyId,
      userId: modelAccess.userId,
      enabled: modelAccess.enabled,
      companyName: companies.name,
      username: users.username,
    })
    .from(modelAccess)
    .innerJoin(models, eq(modelAccess.modelId, models.id))
    .innerJoin(companies, eq(modelAccess.companyId, companies.id))
    .leftJoin(users, eq(modelAccess.userId, users.id))
    .where(eq(models.companyId, session.user.companyId));

  return { models: rootModels, grants };
}

function parseTarget(body: Record<string, unknown>) {
  const modelId = Number(body?.modelId);
  const companyId = Number(body?.companyId);
  const raw = body?.userId;
  const userId = raw === null || raw === undefined || raw === "" ? null : Number(raw);
  return { modelId, companyId, userId };
}

/** Grant a model to a company (userId null) or a specific user in it. */
export async function grantModelAccess(rawBody: Record<string, unknown>, session: AuthSession): Promise<unknown> {
  const { modelId, companyId, userId } = parseTarget(rawBody);
  if (!Number.isInteger(modelId) || !Number.isInteger(companyId)) {
    throw new ApiError("VALIDATION", "modelId and companyId are required");
  }
  if (userId !== null && !Number.isInteger(userId)) {
    throw new ApiError("VALIDATION", "userId must be an integer or null");
  }

  // Root may only grant models it uploaded (owned by root's company).
  const [model] = await db.select({ id: models.id, companyId: models.companyId }).from(models).where(eq(models.id, modelId)).limit(1);
  if (!model || model.companyId !== session.user.companyId) {
    throw new ApiError("NOT_FOUND", "Model not found");
  }
  const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!company) throw new ApiError("NOT_FOUND", "Company not found");
  if (userId !== null) {
    const [u] = await db.select({ id: users.id, companyId: users.companyId }).from(users).where(eq(users.id, userId)).limit(1);
    if (!u) throw new ApiError("NOT_FOUND", "User not found");
    if (u.companyId !== companyId) {
      throw new ApiError("VALIDATION", "That user is not in the selected company");
    }
  }

  // Upsert (null-aware on userId — the partial unique indexes enforce one row each).
  const [existing] = await db
    .select({ id: modelAccess.id })
    .from(modelAccess)
    .where(and(
      eq(modelAccess.modelId, modelId),
      eq(modelAccess.companyId, companyId),
      userId === null ? isNull(modelAccess.userId) : eq(modelAccess.userId, userId)
    ))
    .limit(1);

  if (existing) {
    await db.update(modelAccess).set({ enabled: true }).where(eq(modelAccess.id, existing.id));
  } else {
    await db.insert(modelAccess).values({ modelId, companyId, userId, enabled: true, grantedBy: session.user.dbId });
  }
  audit("model_access_granted", { userId: session.user.dbId, companyId: session.user.companyId, details: { modelId, targetCompanyId: companyId, targetUserId: userId, existed: !!existing } });

  return { success: true };
}

/** Revoke a grant (company-wide or user-specific). */
export async function revokeModelAccess(rawBody: Record<string, unknown>, session: AuthSession): Promise<unknown> {
  const { modelId, companyId, userId } = parseTarget(rawBody);
  if (!Number.isInteger(modelId) || !Number.isInteger(companyId)) {
    throw new ApiError("VALIDATION", "modelId and companyId are required");
  }

  // Only revoke grants on models root uploaded.
  const [model] = await db.select({ companyId: models.companyId }).from(models).where(eq(models.id, modelId)).limit(1);
  if (!model || model.companyId !== session.user.companyId) {
    throw new ApiError("NOT_FOUND", "Model not found");
  }

  const removed = await db.delete(modelAccess).where(and(
    eq(modelAccess.modelId, modelId),
    eq(modelAccess.companyId, companyId),
    userId === null ? isNull(modelAccess.userId) : eq(modelAccess.userId, userId)
  )).returning({ id: modelAccess.id });
  audit("model_access_revoked", { userId: session.user.dbId, companyId: session.user.companyId, details: { modelId, targetCompanyId: companyId, targetUserId: userId, removed: removed.length } });

  return { success: true };
}
