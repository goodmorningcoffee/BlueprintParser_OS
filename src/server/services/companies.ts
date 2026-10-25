// [refactor jul6 S043] admin/companies SOLO — 4-method root write route (GET list+counts,
// POST create, PUT update, DELETE with empty-check guards), folded from the legacy route
// (git show d2980e4:src/app/api/admin/companies/route.ts). Char:
// __tests__/admin-companies.route.test.ts (CO-*). requireRootAdmin (the shell provides
// auth:"root"). Sanctioned diffs:
//   • A — flat auth errors → envelope; the POST/PUT/DELETE validation + delete-guard 400
//     literals stay byte-verbatim here as ApiError("VALIDATION", ...).
//   • E — legacy `await req.json()` (no catch — malformed threw) subsumed by the shell
//     raw-parse (malformed → 400 BAD_REQUEST "Invalid JSON body").
//   • NO B — no catch-500 literal; unexpected db errors propagate to the shell generic 500.
// PRESERVED verbatim: the GET user/NON-DEMO-project count aggregates + payload shape; the
// crypto accessKey (randomBytes(16)) + dataKey slug (lower/[^a-z0-9]→"-"/collapse/slice30 +
// "-" + randomBytes(4)); the PUT conditional updates (name if trim, key regen if flag, always
// updatedAt); the DELETE users-then-projects empty-check guard order.

import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import crypto from "crypto";
import { ApiError } from "@/server/api/envelope";
import { audit } from "@/lib/audit";
import type { AuthSession } from "@/lib/api-utils";

export async function getCompanies(): Promise<unknown> {
  const allCompanies = await db.select().from(companies).orderBy(companies.name);

  // Get user counts and project counts per company
  const userCounts = await db.execute(sql`
    SELECT company_id, COUNT(*)::int AS cnt FROM users GROUP BY company_id
  `);
  const projectCounts = await db.execute(sql`
    SELECT company_id, COUNT(*)::int AS cnt FROM projects WHERE is_demo = false GROUP BY company_id
  `);

  const userMap: Record<number, number> = {};
  for (const row of userCounts.rows as any[]) userMap[row.company_id] = row.cnt;

  const projectMap: Record<number, number> = {};
  for (const row of projectCounts.rows as any[]) projectMap[row.company_id] = row.cnt;

  return {
    companies: allCompanies.map((c) => ({
      id: c.id,
      publicId: c.publicId,
      name: c.name,
      accessKey: c.accessKey,
      dataKey: c.dataKey,
      userCount: userMap[c.id] || 0,
      projectCount: projectMap[c.id] || 0,
      createdAt: c.createdAt,
    })),
  };
}

export async function createCompany(rawBody: Record<string, unknown>, session: AuthSession): Promise<unknown> {
  const { name } = rawBody as { name?: string };
  if (!name?.trim()) {
    throw new ApiError("VALIDATION", "Company name required");
  }

  // Generate unique access key and data key
  const accessKey = crypto.randomBytes(16).toString("hex");
  const dataKey = name.trim().toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").slice(0, 30) + "-" + crypto.randomBytes(4).toString("hex");

  const [created] = await db
    .insert(companies)
    .values({
      name: name.trim(),
      accessKey,
      dataKey,
      emailDomain: "",
      subscription: 0,
    })
    .returning();
  audit("company_created", { userId: session.user.dbId, companyId: session.user.companyId, details: { createdCompanyId: created.id, name: created.name } });

  return {
    id: created.id,
    publicId: created.publicId,
    name: created.name,
    accessKey: created.accessKey,
    dataKey: created.dataKey,
  };
}

export async function updateCompany(rawBody: Record<string, unknown>, session: AuthSession): Promise<unknown> {
  const { companyId, name, regenerateKey } = rawBody as { companyId?: number; name?: string; regenerateKey?: boolean };
  if (!companyId) throw new ApiError("VALIDATION", "companyId required");

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (name?.trim()) updates.name = name.trim();
  if (regenerateKey) updates.accessKey = crypto.randomBytes(16).toString("hex");

  const [before] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1);
  await db.update(companies).set(updates).where(eq(companies.id, companyId));
  // The access key itself is never written to the log — only that it was rotated.
  audit("company_updated", { userId: session.user.dbId, companyId: session.user.companyId, details: { targetCompanyId: companyId, before: { name: before?.name ?? null }, after: { name: updates.name ?? before?.name ?? null }, accessKeyRegenerated: !!regenerateKey } });

  const [updated] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  return { company: updated };
}

export async function deleteCompany(rawBody: Record<string, unknown>, session: AuthSession): Promise<unknown> {
  const { companyId } = rawBody as { companyId?: number };
  if (!companyId) throw new ApiError("VALIDATION", "companyId required");

  // Check for existing users
  const userCheck = await db.execute(sql`SELECT COUNT(*)::int AS cnt FROM users WHERE company_id = ${companyId}`);
  if ((userCheck.rows[0] as any)?.cnt > 0) {
    throw new ApiError("VALIDATION", "Cannot delete company with existing users. Remove all users first.");
  }

  // Check for existing projects
  const projCheck = await db.execute(sql`SELECT COUNT(*)::int AS cnt FROM projects WHERE company_id = ${companyId}`);
  if ((projCheck.rows[0] as any)?.cnt > 0) {
    throw new ApiError("VALIDATION", "Cannot delete company with existing projects. Delete all projects first.");
  }

  await db.delete(companies).where(eq(companies.id, companyId));
  audit("company_deleted", { userId: session.user.dbId, companyId: session.user.companyId, details: { targetCompanyId: companyId } });
  return { success: true };
}
