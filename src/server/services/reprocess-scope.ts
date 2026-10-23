// [2026-10-23] Read-only dry count for Admin › Pipeline › Reprocess "All" (GET /api/admin/reprocess/scope).
// POST /api/admin/reprocess with no projectIds runs on EVERY non-demo project of the caller's OWN
// company, whatever its status (services/reprocess.ts — that selection is freeze-pinned and is not
// changed here). The Pipeline tab lists COMPLETED projects, and for a root admin across ALL
// companies, so its count differed from the server's (owner saw 216 listed vs 128 processed). This
// mirrors the server's predicate exactly — company_id = session company AND is_demo = false, no
// status filter — so the tab can state the real scope and count before a run; the reprocess-scope
// route test pins it against the POST stream's own `start` count.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, projects } from "@/lib/db/schema";
import type { AuthSession } from "@/lib/api-utils";

export interface ReprocessScope {
  companyId: number;
  companyName: string | null;
  /** What a no-selection reprocess run processes. */
  projects: number;
  byStatus: Record<string, number>;
  description: string;
}

export async function getReprocessScope(session: AuthSession): Promise<ReprocessScope> {
  const companyId = session.user.companyId;
  const [rows, [company]] = await Promise.all([
    db
      .select({ status: projects.status, count: sql<number>`count(*)::int` })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), eq(projects.isDemo, false)))
      .groupBy(projects.status),
    db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1),
  ]);
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    byStatus[r.status ?? "unknown"] = Number(r.count);
    total += Number(r.count);
  }
  return {
    companyId,
    companyName: company?.name ?? null,
    projects: total,
    byStatus,
    description: "every non-demo project of your own company, any status",
  };
}
