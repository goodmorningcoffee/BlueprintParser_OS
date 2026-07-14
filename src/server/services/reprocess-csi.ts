// [refactor jul6 S041] ADMIN B6 — models/reprocess-csi contract (re-stamp CSI codes +
// keywords onto existing YOLO annotations), folded from the legacy route (git show
// 858777f:src/app/api/admin/models/reprocess-csi/route.ts at the freeze). Char:
// __tests__/admin-models-access.route.test.ts (RC-*).
//
// ⚠️ auth:"admin" — this is requireAdmin (company-admin), NOT requireRootAdmin. Do NOT
// elevate to auth:"root" (the DR002 §5 auth trap). Sanctioned diffs:
//   • A — flat auth errors → envelope; "modelId required" / "Model not found" byte-verbatim
//     as ApiError(...).
//   • E — legacy `await req.json()` (no catch — malformed threw → framework 500) subsumed by
//     the shell raw-parse (malformed → 400 BAD_REQUEST "Invalid JSON body").
//   • NO B — no catch-500 literal; unexpected errors propagate to the shell generic 500.
// ⚠️ SECURITY SCOPE (H6-class, load-bearing — DO NOT weaken): a company-admin may only
// re-stamp a model owned by their OWN company; root bypasses for platform-wide re-stamps.
// The `data = data || ...::jsonb` MERGE (NOT replace — preserves sibling annotation-data
// keys) remains. P2 resolves each concrete private target and locks its lifecycle before writing.

import { db } from "@/lib/db";
import { annotations, models, projects } from "@/lib/db/schema";
import { and, eq, sql } from "drizzle-orm";
import type { AuthSession } from "@/lib/api-utils";
import { ApiError } from "@/server/api/envelope";
import { assertProjectWritable } from "@/server/api/access";
import { withProjectWrite } from "@/server/api/project-write-capability";

export async function reprocessCsi(rawBody: Record<string, unknown>, session: AuthSession): Promise<unknown> {
  const { modelId } = rawBody as { modelId?: unknown };
  if (!modelId) {
    throw new ApiError("VALIDATION", "modelId required");
  }

  // Fetch model config
  const [model] = await db.select().from(models).where(eq(models.id, modelId as number)).limit(1);
  if (!model) {
    throw new ApiError("NOT_FOUND", "Model not found");
  }

  // SECURITY: model must belong to the admin's company. Without this scope
  // check, a company-admin with any `modelId` could update YOLO annotations
  // owned by a different company. Root admins bypass intentionally so
  // platform-wide re-stamps remain possible.
  if (!session.user.isRootAdmin && model.companyId !== session.user.companyId) {
    throw new ApiError("NOT_FOUND", "Model not found");
  }

  const classCsiCodes = model.config?.classCsiCodes || {};
  const classKeywords = model.config?.classKeywords || {};

  // Get all unique class names from this model's annotations
  const classNames = Object.keys({ ...classCsiCodes, ...classKeywords });
  if (classNames.length === 0) {
    return { success: true, annotationsUpdated: 0, projectsProcessed: 0 };
  }

  let totalUpdated = 0;
  const projectIds = new Set<number>();

  // Resolve every concrete mutation target first, then lock and revalidate its exact lifecycle
  // generation before writing. A model grant permits inference use; it never grants mutation rights
  // over a grantee's projects.
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
      eq(projects.companyId, model.companyId),
      eq(projects.isDemo, false),
      eq(annotations.source, "yolo"),
      sql`${annotations.data}->>'modelId' = ${String(modelId)}`,
    ));

  for (const project of targetProjects) {
    const writeCapability = assertProjectWritable(project);
    await withProjectWrite(writeCapability, project.id, async (tx) => {
      for (const className of classNames) {
        const csiCodes = classCsiCodes[className] || [];
        const keywords = classKeywords[className] || [];
        const result = await tx.execute(sql`
          UPDATE annotations
          SET data = data || ${JSON.stringify({ csiCodes, keywords })}::jsonb
          WHERE project_id = ${project.id}
            AND source = 'yolo'
            AND data->>'modelId' = ${String(modelId)}
            AND name = ${className}
          RETURNING project_id
        `);
        totalUpdated += result.rowCount || 0;
        if ((result.rowCount || 0) > 0) projectIds.add(project.id);
      }
    });
  }

  return {
    success: true,
    annotationsUpdated: totalUpdated,
    projectsProcessed: projectIds.size,
  };
}
