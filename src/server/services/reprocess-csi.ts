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
// [refactor jul23 P4.1 U8] log-mode shape observation for the raw-SQL mutate-in-place sink.
import { observeAnnotationDataBatch } from "./annotation-data-observe";

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
      // [refactor jul23 P4.1 U8] Collect the TRUE persisted blobs across the per-class merges so
      // we can observe the shape that ACTUALLY lands (RD-U8 option a). The in-process pre-write
      // value is only the fragment {csiCodes,keywords}, which would mis-classify as empty-markup;
      // RETURNING the merged row yields the real yolo-detection blob. Per-project scope: the
      // observe fires once per project, after this project's class loop but still in-tx.
      const observedBlobs: unknown[] = [];
      for (const className of classNames) {
        const csiCodes = classCsiCodes[className] || [];
        const keywords = classKeywords[className] || [];
        // RETURNING widened project_id → data; the byte-exact `data || $1::jsonb` MERGE (SET) and
        // the WHERE predicate are untouched, so RC-5/L5 persisted-byte + count pins hold. rowCount
        // still counts one row per updated annotation (accounting byte-identical), and result.rows
        // now carries one merged blob per updated annotation.
        const result = await tx.execute(sql`
          UPDATE annotations
          SET data = data || ${JSON.stringify({ csiCodes, keywords })}::jsonb
          WHERE project_id = ${project.id}
            AND source = 'yolo'
            AND data->>'modelId' = ${String(modelId)}
            AND name = ${className}
          RETURNING data
        `);
        totalUpdated += result.rowCount || 0;
        if ((result.rowCount || 0) > 0) projectIds.add(project.id);
        for (const row of result.rows as { data: unknown }[]) observedBlobs.push(row.data);
      }
      // [refactor jul23 P4.1 U8] Post-write, in-tx, LOG-ONLY observation of the merged
      // yolo-detection blobs. gate:false is PERMANENT (like every pipeline sink): these are
      // re-read historic-corpus rows, not fresh client writes, so a coincidental legacy top-level
      // `v` must never 400 an admin re-stamp — and a throw here would tear the SEQUENTIAL
      // per-project loop (projects 1..N-1 already committed) into a partial re-stamp + 500. The
      // batch aggregates one warn per (sink,kind), so a systematic drift can't flood the log.
      observeAnnotationDataBatch(observedBlobs, "reprocessCsi", { gate: false });
    });
  }

  return {
    success: true,
    annotationsUpdated: totalUpdated,
    projectsProcessed: projectIds.size,
  };
}
