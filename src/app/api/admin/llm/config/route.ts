import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/**
 * GET /api/admin/llm/config
 * Returns the LLM context configuration for the admin's company.
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

  // Include default domain knowledge so admin editor can show it
  let defaultDomainKnowledge = "";
  try {
    const { readFile } = await import("fs/promises");
    const { join } = await import("path");
    defaultDomainKnowledge = await readFile(join(process.cwd(), "src/data/domain-knowledge.md"), "utf-8");
  } catch { /* file not found in production — try dist path */ }

  return NextResponse.json({ llm: config.llm || {}, defaultDomainKnowledge });
}

/**
 * PUT /api/admin/llm/config
 * Updates the LLM context configuration.
 * Merges into existing pipelineConfig (preserves heuristics, pipeline, csi, etc).
 */
export async function PUT(req: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const body = await req.json();
  const { llm } = body;

  if (!llm || typeof llm !== "object") {
    return NextResponse.json({ error: "llm config object required" }, { status: 400 });
  }

  const [company] = await db
    .select({ pipelineConfig: companies.pipelineConfig })
    .from(companies)
    .where(eq(companies.id, session.user.companyId))
    .limit(1);

  const existing = company?.pipelineConfig || {};
  const updated = { ...existing, llm };

  await db
    .update(companies)
    .set({ pipelineConfig: updated })
    .where(eq(companies.id, session.user.companyId));

  return NextResponse.json({ success: true });
}
