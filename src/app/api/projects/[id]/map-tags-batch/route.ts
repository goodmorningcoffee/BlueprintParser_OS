import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, pages, annotations } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { mapYoloToOcrText } from "@/lib/yolo-tag-engine";
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
  const { tags, yoloClass, yoloModel, selectedPages } = body as {
    tags: string[];
    yoloClass?: string;
    yoloModel?: string;
    selectedPages?: number[];
  };

  if (!tags || !Array.isArray(tags) || tags.length === 0) {
    return NextResponse.json({ error: "tags array required" }, { status: 400 });
  }

  if (tags.length > 500) {
    return NextResponse.json({ error: "Max 500 tags per batch" }, { status: 400 });
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
    source: a.source,
    data: a.data as Record<string, unknown> | null,
  }));

  // Load all textract data ONCE
  const pageRows = await db
    .select({ pageNumber: pages.pageNumber, textractData: pages.textractData })
    .from(pages)
    .where(eq(pages.projectId, project.id));

  const textractMap: Record<number, TextractPageData> = {};
  for (const row of pageRows) {
    if (row.textractData) {
      textractMap[row.pageNumber] = row.textractData as TextractPageData;
    }
  }

  // Page filter set (if provided)
  const pageFilter = selectedPages && selectedPages.length > 0
    ? new Set(selectedPages)
    : null;

  // Map all tags
  const results: Record<string, YoloTagInstance[]> = {};

  for (const tag of tags) {
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

    // Filter to selected pages
    if (pageFilter) {
      instances = instances.filter((inst) => pageFilter.has(inst.pageNumber));
    }

    results[trimmed] = instances;
  }

  return NextResponse.json({ results });
}
