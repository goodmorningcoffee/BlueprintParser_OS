import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, pages, annotations } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { mapYoloToOcrText, scanClassForTexts } from "@/lib/yolo-tag-engine";
import type { ClientAnnotation, TextractPageData, YoloTagInstance } from "@/types";

/**
 * POST /api/projects/[id]/map-tags-batch
 *
 * Batch tag mapping: loads all annotations + textract data ONCE,
 * maps ALL tags in a single request. Much more efficient than N
 * individual /map-tags calls for a full schedule.
 *
 * Body: { tags: string[], yoloClass?, yoloModel?, selectedPages?: number[] }
 * Returns: { results: Record<string, YoloTagInstance[]> }
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const body = await req.json();
  const { action, tags, yoloClass, yoloModel, selectedPages } = body as {
    action?: "map" | "scanClass";
    tags?: string[];
    yoloClass?: string;
    yoloModel?: string;
    selectedPages?: number[];
  };

  // Validate based on action
  const isScan = action === "scanClass";
  if (!isScan) {
    if (!tags || !Array.isArray(tags) || tags.length === 0) {
      return NextResponse.json({ error: "tags array required" }, { status: 400 });
    }
    if (tags.length > 500) {
      return NextResponse.json({ error: "Max 500 tags per batch" }, { status: 400 });
    }
    if (!tags.every((t) => typeof t === "string")) {
      return NextResponse.json({ error: "tags must be strings" }, { status: 400 });
    }
  }
  if (isScan && (!yoloClass || typeof yoloClass !== "string")) {
    return NextResponse.json({ error: "yoloClass required for scanClass" }, { status: 400 });
  }
  if (selectedPages !== undefined && selectedPages !== null) {
    if (!Array.isArray(selectedPages) || !selectedPages.every((p) => Number.isInteger(p) && p >= 1)) {
      return NextResponse.json({ error: "selectedPages must be positive integers" }, { status: 400 });
    }
    if (selectedPages.length > 2000) {
      return NextResponse.json({ error: "Max 2000 pages per batch" }, { status: 400 });
    }
  }

  // Auth: check session for real projects, allow demo projects without auth
  const session = await auth();
  let project;
  if (session?.user) {
    const companyId = (session.user as any).companyId;
    [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.publicId, id), eq(projects.companyId, companyId)))
      .limit(1);
  } else {
    // Demo fallback: allow read-only access to demo projects
    [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.publicId, id), eq(projects.isDemo, true)))
      .limit(1);
  }

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Load all annotations ONCE
  const allAnnotations = await db
    .select({
      id: annotations.id,
      pageNumber: annotations.pageNumber,
      name: annotations.name,
      minX: annotations.minX,
      minY: annotations.minY,
      maxX: annotations.maxX,
      maxY: annotations.maxY,
      note: annotations.note,
      source: annotations.source,
      data: annotations.data,
    })
    .from(annotations)
    .where(eq(annotations.projectId, project.id));

  const clientAnnotations: ClientAnnotation[] = allAnnotations.map((a) => ({
    id: a.id,
    pageNumber: a.pageNumber,
    name: a.name,
    bbox: [a.minX, a.minY, a.maxX, a.maxY] as [number, number, number, number],
    note: a.note,
    source: a.source as ClientAnnotation["source"],
    data: a.data ?? null,
  }));

  // Load textract data (filtered to selectedPages when available to avoid loading ~80KB/page for unused pages)
  const pageFilter = !isScan && selectedPages && selectedPages.length > 0
    ? new Set(selectedPages)
    : null;
  const pageRows = await db
    .select({ pageNumber: pages.pageNumber, textractData: pages.textractData })
    .from(pages)
    .where(
      pageFilter
        ? and(eq(pages.projectId, project.id), inArray(pages.pageNumber, selectedPages!))
        : eq(pages.projectId, project.id)
    );

  const textractMap: Record<number, TextractPageData> = {};
  for (const row of pageRows) {
    if (row.textractData) {
      textractMap[row.pageNumber] = row.textractData as TextractPageData;
    }
  }

  // ─── scanClass mode: find all unique texts inside annotations of a class ───
  if (isScan) {
    const scanResults = scanClassForTexts(yoloClass!, yoloModel, clientAnnotations, textractMap);
    return NextResponse.json({ texts: scanResults });
  }

  // ─── map mode (default): map specific tag texts to instances ───
  const results: Record<string, YoloTagInstance[]> = {};

  for (const tag of tags!) {
    const trimmed = tag.trim();
    if (!trimmed) continue;

    let instances = mapYoloToOcrText({
      tagText: trimmed,
      yoloClass: yoloClass || undefined,
      yoloModel: yoloModel || undefined,
      scope: "project",
      annotations: clientAnnotations,
      textractData: textractMap,
    });

    if (pageFilter) {
      instances = instances.filter((inst) => pageFilter.has(inst.pageNumber));
    }

    results[trimmed] = instances;
  }

  return NextResponse.json({ results });
}
