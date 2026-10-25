// [refactor jul7 S049] YOLO-admin SOLO pair — yolo-status (GET detection-count status) +
// yolo-purge (DELETE all YOLO annotations), folded from the legacy routes (git show
// 3ef0130:src/app/api/admin/{yolo-status,yolo-purge}/route.ts). DR005 GAP-1: these two were
// UNACCOUNTED in the plan/memories until the 2026-07-07 drift review. Char:
// __tests__/admin-yolo-admin.route.test.ts (YS-*/YP-*). Both requireAdmin (the shell provides
// auth:"admin"), both company-scoped, no body. Sanctioned diff A only (flat auth → envelope);
// no body → no E; no catch-500 literal → no B. Status shaping and purge response stay
// frozen; P2 routes purge through stable multi-project lifecycle locks.

import { db } from "@/lib/db";
import { annotations, projects } from "@/lib/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AuthSession } from "@/lib/api-utils";
import { audit } from "@/lib/audit";
import { assertProjectWritable } from "@/server/api/access";
import { withProjectWrites } from "@/server/api/project-write-capability";

// [2026-10-23] Root only (route auth:"root"). A root admin's project list (GET /api/projects) spans
// every company, so the status does too — company-scoped, the AI-models rows of other companies'
// projects read as "no results" and bulk "only without results" re-ran them. A non-root session
// (in-service callers) keeps the own-company scope.
export async function getYoloStatus(session: AuthSession): Promise<unknown> {
  const companyScope = session.user.isRootAdmin ? sql`TRUE` : sql`p.company_id = ${session.user.companyId}`;
  const results = await db.execute(sql`
    SELECT
      p.public_id AS project_id,
      (a.data->>'modelId')::int AS model_id,
      COUNT(a.id)::int AS detection_count
    FROM annotations a
    JOIN projects p ON a.project_id = p.id
    WHERE a.source = 'yolo'
      AND ${companyScope}
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
  const targetProjects = await db
    .selectDistinct({
      id: projects.id,
      publicId: projects.publicId,
      companyId: projects.companyId,
      isDemo: projects.isDemo,
      lifecycleEpoch: projects.lifecycleEpoch,
    })
    .from(projects)
    .innerJoin(annotations, eq(annotations.projectId, projects.id))
    .where(and(
      eq(projects.companyId, session.user.companyId),
      eq(projects.isDemo, false),
      eq(annotations.source, "yolo"),
    ));

  if (targetProjects.length === 0) return { deleted: 0 };
  const ids = targetProjects.map((project) => project.id);
  const deleted = await withProjectWrites(
    targetProjects.map(assertProjectWritable),
    async (tx) => tx
      .delete(annotations)
      .where(and(
        eq(annotations.source, "yolo"),
        inArray(annotations.projectId, ids),
      ))
      .returning({ id: annotations.id }),
  );

  audit("yolo_purged", { userId: session.user.dbId, companyId: session.user.companyId, details: { projects: ids.length, deleted: deleted.length } });
  return { deleted: deleted.length };
}
