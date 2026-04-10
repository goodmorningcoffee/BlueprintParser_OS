import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/**
 * GET /api/admin/demo/config
 * Returns the demo feature configuration for the admin's company.
 */
export async function GET() {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const [company] = await db
    .select({ pipelineConfig: companies.pipelineConfig })
    .from(companies)
    .where(eq(companies.id, session.user.companyId))
    .limit(1);

  const config = company?.pipelineConfig || {};
  return NextResponse.json({ demo: config.demo || {} });
}

/**
 * PUT /api/admin/demo/config
 * Updates the demo feature configuration. Merges into existing pipelineConfig.
 */
export async function PUT(req: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const body = await req.json();
  const { demo } = body;

  if (!demo || typeof demo !== "object") {
    return NextResponse.json({ error: "demo object required" }, { status: 400 });
  }

  const [company] = await db
    .select({ pipelineConfig: companies.pipelineConfig })
    .from(companies)
    .where(eq(companies.id, session.user.companyId))
    .limit(1);

  const existing = company?.pipelineConfig || {};
  const updated = { ...existing, demo };

  await db
    .update(companies)
    .set({ pipelineConfig: updated })
    .where(eq(companies.id, session.user.companyId));

  return NextResponse.json({ success: true });
}
