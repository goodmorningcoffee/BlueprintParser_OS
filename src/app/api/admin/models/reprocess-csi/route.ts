import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { models, annotations } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";

/**
 * POST — Re-stamp CSI codes and keywords on existing YOLO annotations
 * for a given model, across all projects that have detections from that model.
 */
export async function POST(req: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const { modelId } = await req.json();
  if (!modelId) {
    return NextResponse.json({ error: "modelId required" }, { status: 400 });
  }

  // Fetch model config
  const [model] = await db.select().from(models).where(eq(models.id, modelId)).limit(1);
  if (!model) {
    return NextResponse.json({ error: "Model not found" }, { status: 404 });
  }

  // SECURITY: model must belong to the admin's company. Without this scope
  // check, a company-admin with any `modelId` could update YOLO annotations
  // owned by a different company. Root admins bypass intentionally so
  // platform-wide re-stamps remain possible.
  if (!session.user.isRootAdmin && model.companyId !== session.user.companyId) {
    return NextResponse.json({ error: "Model not found" }, { status: 404 });
  }

  const classCsiCodes = model.config?.classCsiCodes || {};
  const classKeywords = model.config?.classKeywords || {};

  // Get all unique class names from this model's annotations
  const classNames = Object.keys({ ...classCsiCodes, ...classKeywords });
  if (classNames.length === 0) {
    return NextResponse.json({ success: true, annotationsUpdated: 0, projectsProcessed: 0 });
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

  return NextResponse.json({
    success: true,
    annotationsUpdated: totalUpdated,
    projectsProcessed: projectIds.size,
  });
}
