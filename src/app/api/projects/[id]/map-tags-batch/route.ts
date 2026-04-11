import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, pages, annotations } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { findItemOccurrences, scanClassForTexts } from "@/lib/yolo-tag-engine";
import { applyExclusionFilter } from "@/lib/composite-classifier";
import type {
  ClientAnnotation,
  TextractPageData,
  YoloTagInstance,
  ClassifiedPageRegions,
  PageIntelligence,
  QtoItemType,
} from "@/types";

const VALID_ITEM_TYPES: QtoItemType[] = [
  "yolo-only",
  "text-only",
  "yolo-with-inner-text",
  "yolo-object-with-tag-shape",
  "yolo-object-with-nearby-text",
];

/**
 * POST /api/projects/[id]/map-tags-batch
 *
 * Batch tag mapping. Loads all annotations + textract data ONCE, dispatches
 * each tag through the SHIP 2 findItemOccurrences engine, and applies the
 * composite-classifier exclusion filter.
 *
 * Body: {
 *   tags: string[],                 // list of tag texts (ignored when itemType === "yolo-only")
 *   yoloClass?: string,             // primary class (Types 1, 3, 4, 5)
 *   yoloModel?: string,
 *   itemType?: QtoItemType,         // defaults to "yolo-with-inner-text" when yoloClass set,
 *                                   // otherwise "text-only". Keeps pre-SHIP-2 callers working.
 *   tagShapeClass?: string,         // required when itemType === "yolo-object-with-tag-shape"
 *   selectedPages?: number[],
 *   action?: "map" | "scanClass",
 * }
 * Returns: { results: Record<string, YoloTagInstance[]>, dropCounts }
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const body = await req.json();
  const {
    action, tags, yoloClass, yoloModel, itemType, tagShapeClass, selectedPages,
  } = body as {
    action?: "map" | "scanClass";
    tags?: string[];
    yoloClass?: string;
    yoloModel?: string;
    itemType?: string;
    tagShapeClass?: string;
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

  // Validate itemType + Type-4 prerequisites
  if (itemType !== undefined && !VALID_ITEM_TYPES.includes(itemType as QtoItemType)) {
    return NextResponse.json({ error: `invalid itemType: ${itemType}` }, { status: 400 });
  }
  if (itemType === "yolo-object-with-tag-shape" && (!tagShapeClass || typeof tagShapeClass !== "string")) {
    return NextResponse.json({
      error: "tagShapeClass required for itemType='yolo-object-with-tag-shape'",
    }, { status: 400 });
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

  // Load textract data + pageIntelligence (filtered to selectedPages when
  // available to avoid loading ~80KB/page for unused pages).
  //
  // pageIntelligence.classifiedRegions is used by the exclusion filter to
  // drop tag matches that sit inside tables/title_blocks or outside the
  // drawings region. Populated by the post-YOLO hook in /api/yolo/load.
  const pageFilter = !isScan && selectedPages && selectedPages.length > 0
    ? new Set(selectedPages)
    : null;
  const pageRows = await db
    .select({
      pageNumber: pages.pageNumber,
      textractData: pages.textractData,
      pageIntelligence: pages.pageIntelligence,
    })
    .from(pages)
    .where(
      pageFilter
        ? and(eq(pages.projectId, project.id), inArray(pages.pageNumber, selectedPages!))
        : eq(pages.projectId, project.id)
    );

  const textractMap: Record<number, TextractPageData> = {};
  const classifiedRegionsByPage: Record<number, ClassifiedPageRegions | undefined> = {};
  for (const row of pageRows) {
    if (row.textractData) {
      textractMap[row.pageNumber] = row.textractData as TextractPageData;
    }
    const pi = row.pageIntelligence as PageIntelligence | null;
    if (pi?.classifiedRegions) {
      classifiedRegionsByPage[row.pageNumber] = pi.classifiedRegions;
    }
  }

  // ─── scanClass mode: find all unique texts inside annotations of a class ───
  if (isScan) {
    const scanResults = scanClassForTexts(yoloClass!, yoloModel, clientAnnotations, textractMap);
    return NextResponse.json({ texts: scanResults });
  }

  // ─── map mode: dispatch each tag through the 5-type engine ───
  //
  // Effective item type: explicit from body, else inferred for backward compat —
  // pre-SHIP-2 callers that pass only `yoloClass` get Type 3 semantics; callers
  // that pass nothing get Type 2 (free-floating text).
  const effectiveItemType: QtoItemType =
    (itemType as QtoItemType | undefined)
      ?? (yoloClass ? "yolo-with-inner-text" : "text-only");

  const results: Record<string, YoloTagInstance[]> = {};
  // Aggregate drop counts for debugging — returned in the response body so
  // callers can see WHY results are smaller than raw matches.
  const dropCounts = { inside_table: 0, inside_title_block: 0, outside_drawings: 0 };

  // Type 1 special case: yolo-only doesn't use tags[] for filtering —
  // every shape of the class counts. Run the dispatcher once and key the
  // result by the FIRST tag in the array (or yoloClass if tags is empty).
  // This keeps the response shape identical so the client-side line-item
  // builder still works without changes.
  if (effectiveItemType === "yolo-only") {
    const key = tags && tags.length > 0 ? tags[0].trim() : (yoloClass || "__all__");
    let instances = findItemOccurrences(
      {
        itemType: "yolo-only",
        label: key,
        yoloClass: yoloClass || undefined,
        yoloModel: yoloModel || undefined,
      },
      "project",
      undefined,
      clientAnnotations,
      textractMap,
    );
    if (pageFilter) {
      instances = instances.filter((inst) => pageFilter.has(inst.pageNumber));
    }
    const filtered = applyExclusionFilter(instances, classifiedRegionsByPage);
    for (const d of filtered.dropped) dropCounts[d.reason]++;
    // Emit the same result under every tag key so the client's line-item
    // building loop sees consistent counts per row.
    for (const tag of tags ?? [key]) {
      const t = tag.trim();
      if (!t) continue;
      results[t] = filtered.kept;
    }
    return NextResponse.json({ results, dropCounts });
  }

  // Types 2, 3, 4, 5 — per-tag dispatch via findItemOccurrences
  for (const tag of tags!) {
    const trimmed = tag.trim();
    if (!trimmed) continue;

    let instances = findItemOccurrences(
      {
        itemType: effectiveItemType,
        label: trimmed,
        yoloClass: yoloClass || undefined,
        yoloModel: yoloModel || undefined,
        tagShapeClass: tagShapeClass || undefined,
        text: trimmed,
      },
      "project",
      undefined,
      clientAnnotations,
      textractMap,
    );

    if (pageFilter) {
      instances = instances.filter((inst) => pageFilter.has(inst.pageNumber));
    }

    // QTO SHIP 1: apply exclusion + inclusion rules using classifiedRegions.
    // Pages without classifiedRegions (yolo never loaded, or classifier found
    // nothing) pass through unchanged — Map Tags degrades gracefully.
    const filtered = applyExclusionFilter(instances, classifiedRegionsByPage);
    for (const d of filtered.dropped) dropCounts[d.reason]++;
    results[trimmed] = filtered.kept;
  }

  return NextResponse.json({ results, dropCounts });
}
