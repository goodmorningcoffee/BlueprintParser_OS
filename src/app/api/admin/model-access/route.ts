import { NextResponse } from "next/server";
import { requireRootAdmin } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { models, modelAccess, companies, users } from "@/lib/db/schema";
import { and, eq, isNull, desc } from "drizzle-orm";

/**
 * Root-only YOLO model-access grants (managed from the admin Usage tab). Root
 * grants a model it uploaded to a whole company (userId null) or a specific user
 * (userId set). Granted models then appear in the grantee's AI Models list and
 * are runnable at /api/yolo/run (subject to the page caps).
 */
export async function GET() {
  const { session, error } = await requireRootAdmin();
  if (error) return error;

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

  return NextResponse.json({ models: rootModels, grants });
}

function parseTarget(body: Record<string, unknown>) {
  const modelId = Number(body?.modelId);
  const companyId = Number(body?.companyId);
  const raw = body?.userId;
  const userId = raw === null || raw === undefined || raw === "" ? null : Number(raw);
  return { modelId, companyId, userId };
}

/** Grant a model to a company (userId null) or a specific user in it. */
export async function POST(req: Request) {
  const { session, error } = await requireRootAdmin();
  if (error) return error;

  const { modelId, companyId, userId } = parseTarget(await req.json().catch(() => ({})));
  if (!Number.isInteger(modelId) || !Number.isInteger(companyId)) {
    return NextResponse.json({ error: "modelId and companyId are required" }, { status: 400 });
  }
  if (userId !== null && !Number.isInteger(userId)) {
    return NextResponse.json({ error: "userId must be an integer or null" }, { status: 400 });
  }

  // Root may only grant models it uploaded (owned by root's company).
  const [model] = await db.select({ id: models.id, companyId: models.companyId }).from(models).where(eq(models.id, modelId)).limit(1);
  if (!model || model.companyId !== session.user.companyId) {
    return NextResponse.json({ error: "Model not found" }, { status: 404 });
  }
  const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });
  if (userId !== null) {
    const [u] = await db.select({ id: users.id, companyId: users.companyId }).from(users).where(eq(users.id, userId)).limit(1);
    if (!u) return NextResponse.json({ error: "User not found" }, { status: 404 });
    if (u.companyId !== companyId) {
      return NextResponse.json({ error: "That user is not in the selected company" }, { status: 400 });
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

  return NextResponse.json({ success: true });
}

/** Revoke a grant (company-wide or user-specific). */
export async function DELETE(req: Request) {
  const { session, error } = await requireRootAdmin();
  if (error) return error;

  const { modelId, companyId, userId } = parseTarget(await req.json().catch(() => ({})));
  if (!Number.isInteger(modelId) || !Number.isInteger(companyId)) {
    return NextResponse.json({ error: "modelId and companyId are required" }, { status: 400 });
  }

  // Only revoke grants on models root uploaded.
  const [model] = await db.select({ companyId: models.companyId }).from(models).where(eq(models.id, modelId)).limit(1);
  if (!model || model.companyId !== session.user.companyId) {
    return NextResponse.json({ error: "Model not found" }, { status: 404 });
  }

  await db.delete(modelAccess).where(and(
    eq(modelAccess.modelId, modelId),
    eq(modelAccess.companyId, companyId),
    userId === null ? isNull(modelAccess.userId) : eq(modelAccess.userId, userId)
  ));

  return NextResponse.json({ success: true });
}
