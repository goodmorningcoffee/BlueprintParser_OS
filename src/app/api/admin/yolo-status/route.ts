import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

/**
 * GET /api/admin/yolo-status
 * Returns which projects have YOLO annotations loaded, with detection counts.
 */
export async function GET() {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const results = await db.execute(sql`
    SELECT
      p.public_id AS project_id,
      (a.data->>'modelId')::int AS model_id,
      COUNT(a.id)::int AS detection_count
    FROM annotations a
    JOIN projects p ON a.project_id = p.id
    WHERE a.source = 'yolo'
      AND p.company_id = ${session.user.companyId}
    GROUP BY p.public_id, (a.data->>'modelId')::int
  `);

  const status: Record<string, Record<string, number>> = {};
  for (const row of results.rows as any[]) {
    if (!status[row.project_id]) status[row.project_id] = {};
    status[row.project_id][String(row.model_id)] = row.detection_count;
  }

  return NextResponse.json(status);
}
