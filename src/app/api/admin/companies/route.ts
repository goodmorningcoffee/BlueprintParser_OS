import { NextResponse } from "next/server";
import { requireRootAdmin } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { companies, users, projects } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import crypto from "crypto";

/**
 * GET /api/admin/companies — List all companies with user/project counts (root admin only)
 */
export async function GET() {
  const { session, error } = await requireRootAdmin();
  if (error) return error;

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

  return NextResponse.json({
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
  });
}

/**
 * POST /api/admin/companies — Create a new company (root admin only)
 */
export async function POST(req: Request) {
  const { session, error } = await requireRootAdmin();
  if (error) return error;

  const { name } = await req.json();
  if (!name?.trim()) {
    return NextResponse.json({ error: "Company name required" }, { status: 400 });
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

  return NextResponse.json({
    id: created.id,
    publicId: created.publicId,
    name: created.name,
    accessKey: created.accessKey,
    dataKey: created.dataKey,
  });
}

/**
 * PUT /api/admin/companies — Update company name or regenerate access key (root admin only)
 */
export async function PUT(req: Request) {
  const { session, error } = await requireRootAdmin();
  if (error) return error;

  const { companyId, name, regenerateKey } = await req.json();
  if (!companyId) return NextResponse.json({ error: "companyId required" }, { status: 400 });

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (name?.trim()) updates.name = name.trim();
  if (regenerateKey) updates.accessKey = crypto.randomBytes(16).toString("hex");

  await db.update(companies).set(updates).where(eq(companies.id, companyId));

  const [updated] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  return NextResponse.json({ company: updated });
}

/**
 * DELETE /api/admin/companies — Delete a company (root admin only, must be empty)
 */
export async function DELETE(req: Request) {
  const { session, error } = await requireRootAdmin();
  if (error) return error;

  const { companyId } = await req.json();
  if (!companyId) return NextResponse.json({ error: "companyId required" }, { status: 400 });

  // Check for existing users
  const userCheck = await db.execute(sql`SELECT COUNT(*)::int AS cnt FROM users WHERE company_id = ${companyId}`);
  if ((userCheck.rows[0] as any)?.cnt > 0) {
    return NextResponse.json({ error: "Cannot delete company with existing users. Remove all users first." }, { status: 400 });
  }

  // Check for existing projects
  const projCheck = await db.execute(sql`SELECT COUNT(*)::int AS cnt FROM projects WHERE company_id = ${companyId}`);
  if ((projCheck.rows[0] as any)?.cnt > 0) {
    return NextResponse.json({ error: "Cannot delete company with existing projects. Delete all projects first." }, { status: 400 });
  }

  await db.delete(companies).where(eq(companies.id, companyId));
  return NextResponse.json({ success: true });
}
