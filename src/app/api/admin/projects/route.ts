import { NextResponse } from "next/server";
import { requireRootAdmin } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { projects, companies, users } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";

/**
 * Root-only god-view (R2): list every project across ALL companies, joined to
 * its company + author. Normal company queries always filter by companyId, so
 * this cross-company listing is deliberately gated to requireRootAdmin.
 */
export async function GET() {
  const { error } = await requireRootAdmin();
  if (error) return error;

  const rows = await db
    .select({
      id: projects.publicId,
      name: projects.name,
      status: projects.status,
      numPages: projects.numPages,
      createdAt: projects.createdAt,
      companyId: projects.companyId,
      companyName: companies.name,
      author: users.username,
    })
    .from(projects)
    .innerJoin(companies, eq(companies.id, projects.companyId))
    .leftJoin(users, eq(users.id, projects.authorId))
    .orderBy(desc(projects.createdAt))
    .limit(1000);

  return NextResponse.json({ projects: rows });
}
