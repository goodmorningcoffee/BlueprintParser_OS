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
// The raw pg Pool + the `data = data || $1::jsonb` jsonb MERGE (NOT replace — preserves
// sibling annotation-data keys) + the two SQL templates are ported byte-for-byte.

import { db } from "@/lib/db";
import { models } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { AuthSession } from "@/lib/api-utils";
import { ApiError } from "@/server/api/envelope";

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

  // Use raw SQL for batch updates — more efficient than Drizzle for jsonb_set
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
  });

  let totalUpdated = 0;
  const projectIds = new Set<number>();

  try {
    const client = await pool.connect();
    try {
      // For each class that has CSI codes or keywords, update all matching annotations
      for (const className of classNames) {
        const csiCodes = classCsiCodes[className] || [];
        const keywords = classKeywords[className] || [];

        const result = await client.query(
          `UPDATE annotations
           SET data = data || $1::jsonb
           WHERE source = 'yolo'
             AND data->>'modelId' = $2
             AND name = $3`,
          [
            JSON.stringify({ csiCodes, keywords }),
            String(modelId),
            className,
          ]
        );
        totalUpdated += result.rowCount || 0;
      }

      // Count distinct projects affected
      const projResult = await client.query(
        `SELECT DISTINCT project_id FROM annotations
         WHERE source = 'yolo' AND data->>'modelId' = $1`,
        [String(modelId)]
      );
      for (const row of projResult.rows) {
        projectIds.add(row.project_id);
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }

  return {
    success: true,
    annotationsUpdated: totalUpdated,
    projectsProcessed: projectIds.size,
  };
}
