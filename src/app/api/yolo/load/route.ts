import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, annotations, models } from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { S3_BUCKET } from "@/lib/s3";

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
  if (!session?.user || session.user.role !== "admin") {
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

        allValues.push({
          name: det.class_name || `class_${det.class_id}`,
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
          },
          source: "yolo",
          projectId: project.id,
        });
      }
    } catch (err) {
      console.error(`Failed to parse ${obj.Key}:`, err);
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
  let firstError: string | null = null;

  try {
    const client = await pool.connect();
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
    console.error("[YOLO-LOAD] Raw pg error:", err);
  } finally {
    await pool.end();
  }

  return NextResponse.json({
    success: totalInserted > 0,
    detectionsLoaded: totalInserted,
    filesProcessed,
    ...(firstError && { error: firstError }),
  });
}
