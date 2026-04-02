import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, pages, annotations, models, companies } from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { getEffectiveRules, runHeuristicEngine } from "@/lib/heuristic-engine";
import { classifyTables } from "@/lib/table-classifier";
import { computeProjectSummaries } from "@/lib/project-analysis";
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { S3_BUCKET } from "@/lib/s3";
import { logger } from "@/lib/logger";

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  ...(process.env.AWS_ACCESS_KEY_ID && {
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  }),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || (session.user.role !== "admin" && !(session.user as any).isRootAdmin)) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const { projectId, modelId, modelName } = await req.json();

  const [project] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.publicId, projectId),
        eq(projects.companyId, session.user.companyId)
      )
    )
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Get model for class names
  const [model] = await db
    .select()
    .from(models)
    .where(eq(models.id, modelId))
    .limit(1);

  // Extract class-level CSI codes and keywords from model config
  const modelConfig = (model?.config as Record<string, unknown>) || {};
  const classCsiCodes = (modelConfig.classCsiCodes as Record<string, string[]>) || {};
  const classKeywords = (modelConfig.classKeywords as Record<string, string[]>) || {};

  const outputPrefix = `${project.dataUrl}/yolo-output/${modelName}/`;

  // List all JSON result files
  const listed = await s3Client.send(
    new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: outputPrefix })
  );

  if (!listed.Contents || listed.Contents.length === 0) {
    return NextResponse.json({ error: "No results found" }, { status: 404 });
  }

  // Collect all detections first, then batch insert
  const allValues: Array<{
    name: string;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    pageNumber: number;
    threshold: number;
    data: Record<string, unknown>;
    source: string;
    projectId: number;
  }> = [];

  let filesProcessed = 0;

  for (const obj of listed.Contents) {
    if (!obj.Key?.endsWith(".json") || obj.Key.endsWith("_manifest.json")) continue;

    const getObj = await s3Client.send(
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key })
    );
    const body = await getObj.Body?.transformToString();
    if (!body) continue;

    try {
      const result = JSON.parse(body);
      const detections = result.detections || [];

      const filename = obj.Key.split("/").pop() || "";
      const pageMatch = filename.match(/page_(\d+)/);
      const pageNumber = pageMatch ? parseInt(pageMatch[1]) : 0;
      if (pageNumber === 0) continue;

      filesProcessed++;

      for (const det of detections) {
        const [x1, y1, x2, y2] = det.bbox_normalized || det.bbox || [0, 0, 0, 0];

        const className = det.class_name || `class_${det.class_id}`;
        allValues.push({
          name: className,
          minX: x1,
          minY: y1,
          maxX: x2,
          maxY: y2,
          pageNumber,
          threshold: det.confidence,
          data: {
            modelId: modelId,
            modelName: modelName,
            classId: det.class_id,
            confidence: det.confidence,
            csiCodes: classCsiCodes[className] || [],
            keywords: classKeywords[className] || [],
          },
          source: "yolo",
          projectId: project.id,
        });
      }
    } catch (err) {
      logger.error(`Failed to parse ${obj.Key}:`, err);
    }
  }

  if (allValues.length === 0) {
    return NextResponse.json({
      success: false,
      detectionsLoaded: 0,
      filesProcessed,
      error: "No detections found in result files",
    });
  }

  // Use raw pg Pool to bypass Drizzle entirely
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
  });

  let totalInserted = 0;
  let deletedPrevious = 0;
  let firstError: string | null = null;

  try {
    const client = await pool.connect();

    // Delete previous detections for this project+model to prevent duplicates
    try {
      const delResult = await client.query(
        `DELETE FROM annotations WHERE project_id = $1 AND source = 'yolo' AND data->>'modelId' = $2`,
        [project.id, String(modelId)]
      );
      deletedPrevious = delResult.rowCount || 0;
    } catch (delErr: any) {
      logger.warn("[YOLO-LOAD] Delete previous failed (non-fatal):", delErr?.message);
    }
    try {
      for (const v of allValues) {
        await client.query(
          `INSERT INTO annotations (name, min_x, max_x, min_y, max_y, page_number, threshold, data, source, project_id, creator_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
          [v.name, v.minX, v.maxX, v.minY, v.maxY, v.pageNumber, v.threshold, JSON.stringify(v.data), v.source, v.projectId, session.user.dbId]
        );
        totalInserted++;
      }
    } finally {
      client.release();
    }
  } catch (err: any) {
    firstError = `pg error: ${err?.message || err} (code: ${err?.code || "?"}, detail: ${err?.detail || "none"})`;
    logger.error("[YOLO-LOAD] Raw pg error:", err);
  } finally {
    await pool.end();
  }

  // ─── Post-YOLO: Run heuristic engine with YOLO data ───
  if (totalInserted > 0) {
    try {
      // Fetch YOLO annotations + page data for heuristic re-evaluation
      const yoloAnns = await db
        .select({ name: annotations.name, minX: annotations.minX, minY: annotations.minY, maxX: annotations.maxX, maxY: annotations.maxY, pageNumber: annotations.pageNumber, data: annotations.data })
        .from(annotations)
        .where(and(eq(annotations.projectId, project.id), eq(annotations.source, "yolo")));

      const projectPages = await db
        .select({ id: pages.id, pageNumber: pages.pageNumber, rawText: pages.rawText, pageIntelligence: pages.pageIntelligence, csiCodes: pages.csiCodes })
        .from(pages)
        .where(eq(pages.projectId, project.id));

      // Fetch company heuristic config
      let companyHeuristics: any[] | undefined;
      try {
        const [company] = await db
          .select({ pipelineConfig: companies.pipelineConfig })
          .from(companies)
          .where(eq(companies.id, project.companyId))
          .limit(1);
        companyHeuristics = (company?.pipelineConfig as any)?.heuristics;
      } catch { /* use defaults */ }

      const rules = getEffectiveRules(companyHeuristics);

      // Group YOLO detections by page
      const yoloByPage = new Map<number, Array<{ name: string; minX: number; minY: number; maxX: number; maxY: number; confidence: number }>>();
      for (const a of yoloAnns) {
        if (!yoloByPage.has(a.pageNumber)) yoloByPage.set(a.pageNumber, []);
        yoloByPage.get(a.pageNumber)!.push({
          name: a.name,
          minX: a.minX,
          minY: a.minY,
          maxX: a.maxX,
          maxY: a.maxY,
          confidence: (a.data as any)?.confidence || 0,
        });
      }

      // Run heuristics per page with YOLO data
      for (const page of projectPages) {
        const yoloDets = yoloByPage.get(page.pageNumber);
        if (!yoloDets?.length) continue;

        const existing = (page.pageIntelligence || {}) as any;
        const inferences = runHeuristicEngine(rules, {
          rawText: page.rawText || "",
          yoloDetections: yoloDets,
          textRegions: existing.textRegions,
          csiCodes: existing.csiCodes,
          pageNumber: page.pageNumber,
        });

        if (inferences.length > 0) {
          const updated = { ...existing, heuristicInferences: inferences };

          // Reclassify tables with YOLO-enriched heuristic data
          if (updated.textRegions?.length > 0) {
            const classified = classifyTables({
              textRegions: updated.textRegions,
              heuristicInferences: inferences,
              csiCodes: existing.csiCodes,
              pageNumber: page.pageNumber,
            });
            if (classified.length > 0) updated.classifiedTables = classified;
          }

          await db.update(pages).set({ pageIntelligence: updated }).where(eq(pages.id, page.id));
        }

        // Merge YOLO CSI codes from model class config into page-level csiCodes
        const allYoloCsi = new Set<string>();
        for (const codes of Object.values(classCsiCodes)) {
          for (const code of codes) allYoloCsi.add(code);
        }
        if (allYoloCsi.size > 0) {
          const existingPageCsi = (page.csiCodes || []) as any[];
          const existingSet = new Set(existingPageCsi.map((c: any) => c.code));
          const newCsi = [...existingPageCsi];
          for (const code of allYoloCsi) {
            if (!existingSet.has(code)) {
              newCsi.push({ code, description: "From YOLO class config", division: code.substring(0, 2), trade: "" });
            }
          }
          if (newCsi.length > existingPageCsi.length) {
            await db.update(pages).set({ csiCodes: newCsi }).where(eq(pages.id, page.id));
          }
        }
      }
      logger.info(`[YOLO-LOAD] Post-YOLO heuristic engine ran on ${projectPages.length} pages`);
    } catch (err) {
      logger.error("[YOLO-LOAD] Post-YOLO heuristic engine failed:", err);
    }
  }

  // Recompute project summaries (annotation counts changed after YOLO load)
  try {
    await computeProjectSummaries(project.id);
    logger.info(`[YOLO-LOAD] Project summaries recomputed`);
  } catch (err) {
    logger.error("[YOLO-LOAD] Summary recomputation failed:", err);
  }

  return NextResponse.json({
    success: totalInserted > 0,
    detectionsLoaded: totalInserted,
    deletedPrevious,
    filesProcessed,
    ...(firstError && { error: firstError }),
  });
}
