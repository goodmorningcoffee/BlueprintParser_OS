import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects, pages, annotations } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import {
  findOccurrences,
  scanClassForTexts,
  buildScope,
  inferTagPattern,
  type ScoredMatch,
  type MatchContext,
  type DropReason,
  type PageMeta,
} from "@/lib/tag-mapping";
import type {
  ClientAnnotation,
  TextractPageData,
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

type StrictnessMode = "strict" | "balanced" | "lenient";
const VALID_STRICTNESS: StrictnessMode[] = ["strict", "balanced", "lenient"];

/**
 * POST /api/projects/[id]/map-tags-batch
 *
 * Batch tag mapping. Loads all annotations + textract data ONCE, dispatches
 * each tag through `findOccurrences` from @/lib/tag-mapping, which returns
 * scored matches (tier + dropReason). Post-filters by `strictnessMode`.
 *
 * Body: {
 *   tags: string[],
 *   yoloClass?: string,
 *   yoloModel?: string,
 *   itemType?: QtoItemType,
 *   tagShapeClass?: string,
 *   selectedPages?: number[],
 *   drawingNumberPrefixes?: string[],  // ["E-", "M-"] → restrict to pages
 *                                       //   whose drawingNumber starts with
 *                                       //   one of these (case-insensitive)
 *   action?: "map" | "scanClass",
 *   strictnessMode?: "strict" | "balanced" | "lenient",  // default "balanced"
 * }
 *
 * Returns: { results: Record<string, ScoredMatch[]>, dropCounts, strictnessMode }
 *
 * Strictness semantics:
 *   - "strict"   keep tier === "high"    (reproduces pre-refactor
 *                                         applyExclusionFilter behavior)
 *   - "balanced" keep tier !== "low"     (default for general Map Tags)
 *   - "lenient"  keep everything, including tier="low" matches with
 *                dropReason populated for audit/review
 *
 * Pattern inference (Phase 3): for non-Type-1 item types, the route runs
 * inferTagPattern() on the tag corpus. Strong patterns hard-zero plan-side
 * matches that don't fit the format (kills "01" matching phone numbers
 * when the schedule is D-101/D-102/D-103). Weak patterns attenuate instead
 * of dropping. Scope filter respects selectedPages ∩ drawingNumberPrefixes.
 * Pre-YOLO projects (no classifiedRegions) resolve to "unclassified" →
 * tier=medium → kept under "balanced" (graceful degrade preserved).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const body = await req.json();
  const {
    action, tags, yoloClass, yoloModel, itemType, tagShapeClass,
    selectedPages, strictnessMode, drawingNumberPrefixes,
  } = body as {
    action?: "map" | "scanClass";
    tags?: string[];
    yoloClass?: string;
    yoloModel?: string;
    itemType?: string;
    tagShapeClass?: string;
    selectedPages?: number[];
    strictnessMode?: StrictnessMode;
    drawingNumberPrefixes?: string[];
  };

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
  if (drawingNumberPrefixes !== undefined && drawingNumberPrefixes !== null) {
    if (!Array.isArray(drawingNumberPrefixes) || !drawingNumberPrefixes.every((p) => typeof p === "string")) {
      return NextResponse.json({ error: "drawingNumberPrefixes must be strings" }, { status: 400 });
    }
  }

  if (itemType !== undefined && !VALID_ITEM_TYPES.includes(itemType as QtoItemType)) {
    return NextResponse.json({ error: `invalid itemType: ${itemType}` }, { status: 400 });
  }
  if (itemType === "yolo-object-with-tag-shape" && (!tagShapeClass || typeof tagShapeClass !== "string")) {
    return NextResponse.json({
      error: "tagShapeClass required for itemType='yolo-object-with-tag-shape'",
    }, { status: 400 });
  }

  // strictnessMode: validate + default to "balanced"
  const effectiveStrictness: StrictnessMode =
    (strictnessMode && VALID_STRICTNESS.includes(strictnessMode))
      ? strictnessMode
      : "balanced";

  // Auth
  const session = await auth();
  let project;
  if (session?.user) {
    const companyId = (session.user as { companyId?: number }).companyId;
    [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.publicId, id), eq(projects.companyId, companyId!)))
      .limit(1);
  } else {
    [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.publicId, id), eq(projects.isDemo, true)))
      .limit(1);
  }

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Load annotations + textract + pageIntelligence
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

  const pageFilter = !isScan && selectedPages && selectedPages.length > 0
    ? new Set(selectedPages)
    : null;
  const pageRows = await db
    .select({
      pageNumber: pages.pageNumber,
      drawingNumber: pages.drawingNumber,
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
  const pageMeta: PageMeta[] = [];
  for (const row of pageRows) {
    if (row.textractData) {
      textractMap[row.pageNumber] = row.textractData as TextractPageData;
    }
    const pi = row.pageIntelligence as PageIntelligence | null;
    if (pi?.classifiedRegions) {
      classifiedRegionsByPage[row.pageNumber] = pi.classifiedRegions;
    }
    pageMeta.push({
      pageNumber: row.pageNumber,
      drawingNumber: row.drawingNumber,
    });
  }

  // scanClass mode (unchanged)
  if (isScan) {
    const scanResults = scanClassForTexts(yoloClass!, yoloModel, clientAnnotations, textractMap);
    return NextResponse.json({ texts: scanResults });
  }

  const effectiveItemType: QtoItemType =
    (itemType as QtoItemType | undefined)
      ?? (yoloClass ? "yolo-with-inner-text" : "text-only");

  // Sanitize the tag corpus before pattern inference: trim, drop empties,
  // dedupe. inferTagPattern handles these internally too but redundancy
  // is cheap and keeps the returned InferredPattern stable across duplicate
  // tag inputs.
  const cleanTags = tags
    ? [...new Set(tags.map((t) => t.trim()).filter(Boolean))]
    : [];

  // Skip pattern inference for Type 1 (yolo-only) — no tag-text corpus to
  // infer from; tag values are placeholders/labels not meant to constrain
  // plan-side text matches.
  const inferredPattern = (effectiveItemType === "yolo-only" || cleanTags.length === 0)
    ? null
    : inferTagPattern(cleanTags);

  // Build the MatchContext once — all tags share the same scope, regions,
  // annotations, textract, and inferred pattern.
  const baseContext: MatchContext = {
    scope: buildScope(
      {
        pages: selectedPages,
        drawingNumberPrefixes: drawingNumberPrefixes && drawingNumberPrefixes.length > 0
          ? drawingNumberPrefixes
          : undefined,
      },
      pageMeta,
    ),
    isPageScoped: Array.isArray(selectedPages) && selectedPages.length === 1,
    annotations: clientAnnotations,
    textractData: textractMap,
    classifiedRegionsByPage,
    pattern: inferredPattern,
  };

  const results: Record<string, ScoredMatch[]> = {};
  const dropCounts: Record<DropReason, number> = {
    outside_scope: 0,
    pattern_mismatch: 0,
    inside_title_block: 0,
    inside_table: 0,
    outside_drawings: 0,
  };

  const applyStrictness = (scored: ScoredMatch[]): ScoredMatch[] => {
    if (effectiveStrictness === "lenient") return scored;
    const threshold = effectiveStrictness === "strict" ? "high" : "medium";
    const kept: ScoredMatch[] = [];
    for (const m of scored) {
      const tier = m.confidenceTier ?? "high";
      if (threshold === "high") {
        if (tier === "high") kept.push(m);
        else if (m.dropReason) dropCounts[m.dropReason]++;
      } else {
        // threshold "medium" — keep high + medium, drop low
        if (tier !== "low") kept.push(m);
        else if (m.dropReason) dropCounts[m.dropReason]++;
      }
    }
    // Also post-filter by selectedPages (redundant with pageFilter below,
    // but cheap and explicit for the yolo-only path where findItemOccurrences
    // scanned all pages).
    if (pageFilter) {
      return kept.filter((inst) => pageFilter.has(inst.pageNumber));
    }
    return kept;
  };

  // Type 1 special case: yolo-only — one dispatch, result shared across all tags
  if (effectiveItemType === "yolo-only") {
    const key = tags && tags.length > 0 ? tags[0].trim() : (yoloClass || "__all__");
    const scored = findOccurrences(
      {
        itemType: "yolo-only",
        label: key,
        yoloClass: yoloClass || undefined,
        yoloModel: yoloModel || undefined,
      },
      baseContext,
    );
    const kept = applyStrictness(scored);
    for (const tag of tags ?? [key]) {
      const t = tag.trim();
      if (!t) continue;
      results[t] = kept;
    }
    return NextResponse.json({
      results,
      dropCounts,
      strictnessMode: effectiveStrictness,
    });
  }

  // Types 2, 3, 4, 5 — per-tag dispatch
  for (const tag of tags!) {
    const trimmed = tag.trim();
    if (!trimmed) continue;

    const scored = findOccurrences(
      {
        itemType: effectiveItemType,
        label: trimmed,
        yoloClass: yoloClass || undefined,
        yoloModel: yoloModel || undefined,
        tagShapeClass: tagShapeClass || undefined,
        text: trimmed,
      },
      baseContext,
    );

    results[trimmed] = applyStrictness(scored);
  }

  return NextResponse.json({
    results,
    dropCounts,
    strictnessMode: effectiveStrictness,
  });
}
