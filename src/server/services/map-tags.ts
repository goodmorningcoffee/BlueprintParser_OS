// [refactor jul3 P1.5] Map-Tags service — the map-tags-batch route's behavior.
//
// `projects/[id]/map-tags-batch` (POST) is now a thin `defineRoute` shell; ALL behavior lives
// here. The matching ENGINE stays in @/lib/tag-mapping (findOccurrences / scanClassForTexts /
// buildScope / inferTagPattern) — this service is the ROUTE contract: validation cascade, mode
// dispatch, context assembly, strictness post-filter. No P0.3 char file existed — the NEW
// projects-map-tags-batch.route.test.ts written WITH this migration IS the freeze.
//
// Shape: VALIDATE-BEFORE-AUTH (legacy ran req.json() + the whole field cascade BEFORE
// resolveProjectAccess) → the shell is auth:"none" + body:zLooseBody and THIS fn validates
// fields FIRST, resolves access AFTER (an invalid body 400s even signed-out on an unknown
// project — frozen). Access = resolveProjectOrThrow({publicId}, {allowDemo:true}) — the same
// legacy engine: demo projects are a PUBLIC read, unknown → 404 BEFORE auth, root bypass,
// cross-tenant 404.
//
// Sanctioned diffs ONLY (success bodies byte-identical):
//   A envelope flips {error:string} → {error:{code,message}}; ALL NINE cascade messages
//     byte-verbatim (incl. the INTERPOLATED `invalid itemType: ${itemType}`).
//   B leak-drop: legacy had NO try/catch → an unexpected throw was a raw leaky 500; now the
//     shell's generic INTERNAL 500.
//   C non-uuid id → clean 400 "Invalid project id" (was the pg uuid-cast 500 inside
//     resolveProjectAccess), gated AFTER the field cascade (validation-first pinned).
//   E malformed JSON → the shell's BAD_REQUEST 400 (legacy unguarded req.json() → raw 500).
//     An EMPTY body / JSON `null` / non-object valid JSON → zLooseBody VALIDATION 400 (legacy:
//     empty + null = raw 500s [json-parse / destructure-of-null throws]; number/string/array =
//     destructure-to-undefined "tags array required" 400 — STATUS preserved, message drifts;
//     the S013 cosmetic class).
//
// Frozen quirks (do NOT "fix"):
//   FQ-1 an INVALID strictnessMode does NOT 400 — silently defaults to "balanced" (echoed back).
//   FQ-2 scanClass returns the DIFFERENT {texts} shape (no results/dropCounts/strictnessMode).
//   FQ-3 dropCounts is the FIXED 5-key zero-initialized object; only strictness-DROPPED matches
//        WITH a dropReason increment it.
//   FQ-4 yolo-only = ONE dispatch shared across every tag key; the shared key falls back
//        tags[0].trim() → yoloClass → "__all__".
//   FQ-5 results keys are TRIMMED tags; empty-after-trim tags are SKIPPED (both branches).
//   FQ-6 effectiveItemType default: yoloClass ? "yolo-with-inner-text" : "text-only".
//   FQ-7 pattern inference SKIPPED for yolo-only / empty corpus; cleanTags = trim+dedupe first.
//   FQ-8 applyStrictness: tier defaults "high" when confidenceTier missing; the redundant
//        pageFilter post-filter is KEPT (explicit for the yolo-only all-pages path).

import { db } from "@/lib/db";
import { pages, annotations } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { ApiError } from "@/server/api/envelope";
import { resolveProjectOrThrow } from "@/server/api/access";
import { zPublicId } from "@/server/api/schemas";
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

type PublicDemoInput = {
  annotations: ClientAnnotation[];
  includePrivatePageIntelligence: boolean;
};

function filterPublicDemoInput(
  isPublicDemo: boolean,
  annotationsInput: ClientAnnotation[],
): PublicDemoInput {
  return isPublicDemo
    ? { annotations: [], includePrivatePageIntelligence: false }
    : { annotations: annotationsInput, includePrivatePageIntelligence: true };
}

export async function mapTagsBatch(body: Record<string, unknown>, idParam: string) {
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

  // The legacy validation cascade — SOURCE ORDER + byte-exact messages, BEFORE access.
  const isScan = action === "scanClass";
  if (!isScan) {
    if (!tags || !Array.isArray(tags) || tags.length === 0) {
      throw new ApiError("VALIDATION", "tags array required");
    }
    if (tags.length > 500) {
      throw new ApiError("VALIDATION", "Max 500 tags per batch");
    }
    if (!tags.every((t) => typeof t === "string")) {
      throw new ApiError("VALIDATION", "tags must be strings");
    }
  }
  if (isScan && (!yoloClass || typeof yoloClass !== "string")) {
    throw new ApiError("VALIDATION", "yoloClass required for scanClass");
  }
  if (selectedPages !== undefined && selectedPages !== null) {
    if (!Array.isArray(selectedPages) || !selectedPages.every((p) => Number.isInteger(p) && p >= 1)) {
      throw new ApiError("VALIDATION", "selectedPages must be positive integers");
    }
    if (selectedPages.length > 2000) {
      throw new ApiError("VALIDATION", "Max 2000 pages per batch");
    }
  }
  if (drawingNumberPrefixes !== undefined && drawingNumberPrefixes !== null) {
    if (!Array.isArray(drawingNumberPrefixes) || !drawingNumberPrefixes.every((p) => typeof p === "string")) {
      throw new ApiError("VALIDATION", "drawingNumberPrefixes must be strings");
    }
  }

  if (itemType !== undefined && !VALID_ITEM_TYPES.includes(itemType as QtoItemType)) {
    throw new ApiError("VALIDATION", `invalid itemType: ${itemType}`);
  }
  if (itemType === "yolo-object-with-tag-shape" && (!tagShapeClass || typeof tagShapeClass !== "string")) {
    throw new ApiError("VALIDATION", "tagShapeClass required for itemType='yolo-object-with-tag-shape'");
  }

  // FQ-1: strictnessMode validate + SILENT default to "balanced" (never a 400).
  const effectiveStrictness: StrictnessMode =
    (strictnessMode && VALID_STRICTNESS.includes(strictnessMode))
      ? strictnessMode
      : "balanced";

  // [diff C] non-uuid → clean 400 (legacy: pg uuid-cast 500), AFTER the field cascade.
  const parsed = zPublicId.safeParse(idParam);
  if (!parsed.success) {
    throw new ApiError("VALIDATION", "Invalid project id");
  }

  // Auth + project lookup — the legacy resolveProjectAccess engine verbatim: authenticates,
  // allows demo (read-only route), grants root admins any company's project.
  const { project, scope } = await resolveProjectOrThrow({ publicId: parsed.data }, { allowDemo: true });

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

  const mappedAnnotations: ClientAnnotation[] = allAnnotations.map((a) => ({
    id: a.id,
    pageNumber: a.pageNumber,
    name: a.name,
    bbox: [a.minX, a.minY, a.maxX, a.maxY] as [number, number, number, number],
    note: a.note,
    source: a.source as ClientAnnotation["source"],
    data: a.data ?? null,
  }));
  const publicDemoSafe = filterPublicDemoInput(project.isDemo && scope === "demo", mappedAnnotations);
  const clientAnnotations = publicDemoSafe.annotations;

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
    const pi = publicDemoSafe.includePrivatePageIntelligence
      ? row.pageIntelligence as PageIntelligence | null
      : null;
    if (pi?.classifiedRegions) {
      classifiedRegionsByPage[row.pageNumber] = pi.classifiedRegions;
    }
    pageMeta.push({
      pageNumber: row.pageNumber,
      drawingNumber: row.drawingNumber,
    });
  }

  // FQ-2: scanClass mode returns its own {texts} shape.
  if (isScan) {
    const scanResults = scanClassForTexts(yoloClass!, yoloModel, clientAnnotations, textractMap);
    return { texts: scanResults };
  }

  // FQ-6: itemType default.
  const effectiveItemType: QtoItemType =
    (itemType as QtoItemType | undefined)
      ?? (yoloClass ? "yolo-with-inner-text" : "text-only");

  // Sanitize the tag corpus before pattern inference: trim, drop empties, dedupe.
  // inferTagPattern handles these internally too but redundancy is cheap and keeps the
  // returned InferredPattern stable across duplicate tag inputs. (FQ-7)
  const cleanTags = tags
    ? [...new Set(tags.map((t) => t.trim()).filter(Boolean))]
    : [];

  // Skip pattern inference for Type 1 (yolo-only) — no tag-text corpus to infer from.
  const inferredPattern = (effectiveItemType === "yolo-only" || cleanTags.length === 0)
    ? null
    : inferTagPattern(cleanTags);

  // Build the MatchContext once — all tags share the same scope, regions, annotations,
  // textract, and inferred pattern.
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
  // FQ-3: the fixed 5-key zero-initialized dropCounts.
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
      const tier = m.confidenceTier ?? "high"; // FQ-8
      if (threshold === "high") {
        if (tier === "high") kept.push(m);
        else if (m.dropReason) dropCounts[m.dropReason]++;
      } else {
        // threshold "medium" — keep high + medium, drop low
        if (tier !== "low") kept.push(m);
        else if (m.dropReason) dropCounts[m.dropReason]++;
      }
    }
    // Also post-filter by selectedPages (redundant with pageFilter below, but cheap and
    // explicit for the yolo-only path where findItemOccurrences scanned all pages). (FQ-8)
    if (pageFilter) {
      return kept.filter((inst) => pageFilter.has(inst.pageNumber));
    }
    return kept;
  };

  // FQ-4: Type 1 special case — yolo-only: one dispatch, result shared across all tags.
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
      if (!t) continue; // FQ-5
      results[t] = kept;
    }
    return {
      results,
      dropCounts,
      strictnessMode: effectiveStrictness,
    };
  }

  // Types 2, 3, 4, 5 — per-tag dispatch
  for (const tag of tags!) {
    const trimmed = tag.trim();
    if (!trimmed) continue; // FQ-5

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

  return {
    results,
    dropCounts,
    strictnessMode: effectiveStrictness,
  };
}
