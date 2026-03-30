import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * GET /api/admin/csi/config
 * Returns CSI configuration + database stats for the company.
 */
export async function GET() {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const [company] = await db
    .select({ pipelineConfig: companies.pipelineConfig })
    .from(companies)
    .where(eq(companies.id, session.user.companyId))
    .limit(1);

  const csiConfig = (company?.pipelineConfig as any)?.csi || {};

  // Get CSI database stats
  let totalCodes = 0;
  const divisionSet = new Set<string>();
  try {
    const paths = [
      join(process.cwd(), "src/data/csi-masterformat.tsv"),
      join(process.cwd(), "csi-masterformat.tsv"),
    ];
    for (const p of paths) {
      try {
        const content = readFileSync(p, "utf-8");
        const lines = content.split("\n").filter(l => l.trim());
        totalCodes = Math.max(0, lines.length - 1); // subtract header
        for (const line of lines.slice(1)) {
          const code = line.split("\t")[0] || "";
          if (code.length >= 2) divisionSet.add(code.substring(0, 2));
        }
        break;
      } catch { continue; }
    }
  } catch { /* ignore */ }

  const customDb = (csiConfig as any)?.customDatabaseName;
  const source = customDb
    ? `Custom: ${customDb} (${(csiConfig as any)?.customDatabaseCodes || "?"} codes)`
    : "Built-in MasterFormat 2018+2016";

  return NextResponse.json({
    config: csiConfig,
    stats: { totalCodes, divisions: divisionSet.size, source },
  });
}

/**
 * PUT /api/admin/csi/config
 * Save CSI configuration for the company.
 */
export async function PUT(req: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const body = await req.json();

  const [company] = await db
    .select({ pipelineConfig: companies.pipelineConfig })
    .from(companies)
    .where(eq(companies.id, session.user.companyId))
    .limit(1);

  const existing = (company?.pipelineConfig || {}) as Record<string, unknown>;
  const updated = { ...existing, csi: body };

  await db
    .update(companies)
    .set({ pipelineConfig: updated })
    .where(eq(companies.id, session.user.companyId));

  return NextResponse.json({ success: true });
}
