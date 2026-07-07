// [refactor jul7 S049] YOLO-admin SOLO pair — yolo-status (GET detection-count status) +
// yolo-purge (DELETE all YOLO annotations), folded from the legacy routes (git show
// 3ef0130:src/app/api/admin/{yolo-status,yolo-purge}/route.ts). DR005 GAP-1: these two were
// UNACCOUNTED in the plan/memories until the 2026-07-07 drift review. Char:
// __tests__/admin-yolo-admin.route.test.ts (YS-*/YP-*). Both requireAdmin (the shell provides
// auth:"admin"), both company-SCOPED raw SQL, no body. Sanctioned diff A only (flat auth →
// envelope); no body → no E; no catch-500 literal → no B. PRESERVED byte-exact: the two
// raw-SQL queries + the nested-object shaping + the {deleted:rowCount} response.

import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import type { AuthSession } from "@/lib/api-utils";

export async function getYoloStatus(session: AuthSession): Promise<unknown> {
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

  return status;
}

export async function purgeYolo(session: AuthSession): Promise<unknown> {
  const result = await db.execute(sql`
    DELETE FROM annotations
    WHERE source = 'yolo'
      AND project_id IN (
        SELECT id FROM projects WHERE company_id = ${session.user.companyId}
      )
  `);

  return { deleted: result.rowCount ?? 0 };
}
