import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { BUILT_IN_RULES } from "@/lib/heuristic-engine";

/**
 * GET — Return built-in heuristic rules + company-level overrides
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const [company] = await db
    .select({ pipelineConfig: companies.pipelineConfig })
    .from(companies)
    .where(eq(companies.id, session.user.companyId))
    .limit(1);

  const companyHeuristics = (company?.pipelineConfig as any)?.heuristics || [];

  return NextResponse.json({
    builtInRules: BUILT_IN_RULES.map((r) => ({
      ...r,
      source: "built-in" as const,
    })),
    companyOverrides: companyHeuristics,
  });
}

/**
 * PUT — Save heuristic rule overrides to company pipelineConfig
 */
export async function PUT(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const { heuristics } = await req.json();
  if (!Array.isArray(heuristics)) {
    return NextResponse.json({ error: "heuristics array required" }, { status: 400 });
  }

  const [company] = await db
    .select({ pipelineConfig: companies.pipelineConfig })
    .from(companies)
    .where(eq(companies.id, session.user.companyId))
    .limit(1);

  const existing = (company?.pipelineConfig as Record<string, unknown>) || {};
  const updated = { ...existing, heuristics };

  await db
    .update(companies)
    .set({ pipelineConfig: updated, updatedAt: new Date() })
    .where(eq(companies.id, session.user.companyId));

  return NextResponse.json({ success: true });
}
