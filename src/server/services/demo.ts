// [refactor jul6 S045] admin/demo SOLO — POST refresh-demo-projects OR toggle a project's
// isDemo flag, folded from the legacy route (git show 7976990:src/app/api/admin/demo/route.ts).
// Char: __tests__/admin-demo.route.test.ts (DEMO-*). requireAdmin (the shell provides
// auth:"admin"). Sanctioned diffs:
//   • A — flat auth errors → envelope; the "projectId and isDemo required" 400 literal stays
//     byte-verbatim as ApiError("VALIDATION", ...).
//   • E — legacy `await req.json()` (no try/catch) subsumed by the shell raw-parse (malformed
//     → 400 BAD_REQUEST "Invalid JSON body").
//   • NO B — no catch-500 literal; unexpected db errors → shell generic INTERNAL 500.
// PRESERVED byte-exact: BOTH writes carry the companyId tenancy guard (eq(projects.companyId,
// session.user.companyId) — NO root bypass); the isDemo=true refresh filter + .returning(id);
// the set-branch publicId+companyId WHERE; new Date() updatedAt bumps.

import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import type { AuthSession } from "@/lib/api-utils";
import { ApiError } from "@/server/api/envelope";

export async function manageDemo(rawBody: Record<string, unknown>, session: AuthSession): Promise<unknown> {
  const body = rawBody as { action?: unknown; projectId?: unknown; isDemo?: unknown };

  // Refresh all demo projects (bust caches, confirm sync)
  if (body.action === "refresh") {
    const result = await db
      .update(projects)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(projects.isDemo, true),
          eq(projects.companyId, session.user.companyId)
        )
      )
      .returning({ id: projects.id });

    return { success: true, refreshed: result.length };
  }

  const { projectId, isDemo } = body as { projectId?: string; isDemo?: unknown };

  if (!projectId || typeof isDemo !== "boolean") {
    throw new ApiError("VALIDATION", "projectId and isDemo required");
  }

  await db
    .update(projects)
    .set({ isDemo, updatedAt: new Date() })
    .where(
      and(
        eq(projects.publicId, projectId),
        eq(projects.companyId, session.user.companyId)
      )
    );

  return { success: true };
}
