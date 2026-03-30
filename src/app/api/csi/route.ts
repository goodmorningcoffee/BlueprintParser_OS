import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

/**
 * GET /api/csi
 * Aggregate CSI codes across all company projects (authenticated).
 */
export async function GET() {
  const { session, error } = await requireAuth();
  if (error) return error;

  const results = await db.execute(sql`
    SELECT
      code->>'code' AS code,
      code->>'description' AS description,
      code->>'trade' AS trade,
      code->>'division' AS division,
      COUNT(DISTINCT p.id)::int AS project_count,
      COUNT(*)::int AS page_count,
      ARRAY_AGG(DISTINCT p.public_id) AS project_ids,
      ARRAY_AGG(p.public_id) AS project_ids_all
    FROM projects p
    JOIN pages pg ON pg.project_id = p.id,
    jsonb_array_elements(pg.csi_codes) AS code
    WHERE p.company_id = ${session.user.companyId}
      AND p.status = 'completed'
      AND pg.csi_codes IS NOT NULL
    GROUP BY code->>'code', code->>'description', code->>'trade', code->>'division'
    ORDER BY page_count DESC
    LIMIT 200
  `);

  return NextResponse.json(
    results.rows.map((row: any) => {
      const sheetCounts: Record<string, number> = {};
      for (const pid of (row.project_ids_all || [])) {
        sheetCounts[pid] = (sheetCounts[pid] || 0) + 1;
      }
      return {
        code: row.code,
        description: row.description,
        trade: row.trade,
        division: row.division,
        projectCount: row.project_count,
        pageCount: row.page_count,
        projectIds: row.project_ids || [],
        projectSheetCounts: sheetCounts,
      };
    })
  );
}
