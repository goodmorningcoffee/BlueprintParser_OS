import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

/**
 * GET /api/demo/csi
 * Aggregate CSI codes across all demo projects. Single query via JSON unnesting.
 * [csi-v2 S6] One row per code (csiDedupeKey-style key) — same rule as services/csi.ts csiAggregate.
 */
export async function GET() {
  const results = await db.execute(sql`
    SELECT
      MIN(code->>'code' COLLATE "C") AS code,
      mode() WITHIN GROUP (ORDER BY code->>'description') AS description,
      mode() WITHIN GROUP (ORDER BY code->>'trade') AS trade,
      mode() WITHIN GROUP (ORDER BY code->>'division') AS division,
      COUNT(DISTINCT p.id)::int AS project_count,
      COUNT(*)::int AS page_count,
      ARRAY_AGG(DISTINCT p.public_id) AS project_ids,
      ARRAY_AGG(p.public_id) AS project_ids_all
    FROM projects p
    JOIN pages pg ON pg.project_id = p.id,
    jsonb_array_elements(pg.csi_codes) AS code
    WHERE p.is_demo = true
      AND p.status = 'completed'
      AND pg.csi_codes IS NOT NULL
    GROUP BY COALESCE(NULLIF(upper(regexp_replace(code->>'code', '[[:space:].-]', '', 'g')), ''), code->>'code')
    ORDER BY page_count DESC
    LIMIT 200
  `);

  return NextResponse.json(
    results.rows.map((row: any) => {
      // Count sheets per project from non-deduplicated array
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
