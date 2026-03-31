import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/**
 * GET /api/admin/pipeline
 * Returns the pipeline configuration for the admin's company.
 */
export async function GET() {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const [company] = await db
    .select({ pipelineConfig: companies.pipelineConfig })
    .from(companies)
    .where(eq(companies.id, session.user.companyId))
    .limit(1);

  const config = (company?.pipelineConfig as Record<string, unknown>) || {};
  return NextResponse.json({ pipeline: config.pipeline || {} });
}

/**
 * PUT /api/admin/pipeline
 * Updates the pipeline configuration for the admin's company.
 * Merges into existing pipelineConfig (preserves heuristics, csi, etc).
 */
export async function PUT(req: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const body = await req.json();
  const { pipeline } = body;

  if (!pipeline || typeof pipeline !== "object") {
    return NextResponse.json({ error: "pipeline object required" }, { status: 400 });
  }

  const [company] = await db
    .select({ pipelineConfig: companies.pipelineConfig })
    .from(companies)
    .where(eq(companies.id, session.user.companyId))
    .limit(1);

  const existing = (company?.pipelineConfig as Record<string, unknown>) || {};
  const updated = { ...existing, pipeline };

  await db
    .update(companies)
    .set({ pipelineConfig: updated as any })
    .where(eq(companies.id, session.user.companyId));

  return NextResponse.json({ success: true });
}
