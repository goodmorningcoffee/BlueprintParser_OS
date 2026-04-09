import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

/**
 * DELETE /api/admin/yolo-purge
 * Purges ALL YOLO annotations across all projects for the current company.
 */
export async function DELETE() {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const result = await db.execute(sql`
    DELETE FROM annotations
    WHERE source = 'yolo'
      AND project_id IN (
        SELECT id FROM projects WHERE company_id = ${session.user.companyId}
      )
  `);

  return NextResponse.json({ deleted: result.rowCount ?? 0 });
}
