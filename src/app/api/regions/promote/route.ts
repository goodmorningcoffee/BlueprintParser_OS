import { NextResponse } from "next/server";
import { resolveProjectAccess, apiError } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { parseNotesFromRegion } from "@/lib/text-region-classifier";
import { detectCsiFromGrid } from "@/lib/csi-detect";
import { mergeCsiCodes } from "@/lib/csi-utils";
import { computeProjectSummaries } from "@/lib/project-analysis";
import type {
  TextractPageData,
  PageIntelligence,
  ParsedRegion,
  ParsedRegionType,
  CsiCode,
  TextRegion,
  NotesData,
} from "@/types";
import { logger } from "@/lib/logger";

/**
 * POST /api/regions/promote
 *
 * Stage 4 generic commit route. Promotes a classifier-detected textRegion
 * (Classifier Accept path) or a user-parsed grid (Parser Save path) into
 * a committed `ParsedRegion{type}` inside `pageIntelligence.parsedRegions`.
 *
 * Atomically updates `pages.pageIntelligence` AND `pages.csiCodes` inside
 * a single DB transaction with SELECT FOR UPDATE, so rapid double-clicks
 * cannot produce duplicate region writes.
 *
 * Generic by design: Stage 5 Spec + future Keynote/Schedule flows can reuse
 * the same endpoint. The `type` field discriminates server-side binder
 * dispatch; today only `"notes"` is wired for the Classifier Accept fallback
 * binder — other types must supply `overrides.data`.
 *
 * Request:
 *   {
 *     projectId: number;
 *     pageNumber: number;
 *     type: "notes" | "spec" | "schedule" | "keynote" | "legend";
 *     sourceTextRegionId?: string;  // Classifier Accept path
 *     overrides?: {
 *       bbox?: [x0, y0, x1, y1];     // MinMax; required when no sourceTextRegionId
 *       data?: Record<string, unknown>;   // e.g. NotesData; required when no sourceTextRegionId
 *       category?: string;
 *       csiTags?: CsiCode[];
 *     };
 *   }
 *
 * Response:
 *   { ok: true; parsedRegion: ParsedRegion; updatedIntelligence: PageIntelligence; summaries: ProjectSummaries | null }
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      projectId,
      pageNumber,
      type,
      sourceTextRegionId,
      overrides,
    } = body as {
      projectId: number;
      pageNumber: number;
      type: ParsedRegionType;
      sourceTextRegionId?: string;
      overrides?: {
        bbox?: [number, number, number, number];
        data?: Record<string, unknown>;
        category?: string;
        csiTags?: CsiCode[];
      };
    };

    if (!projectId || !pageNumber || !type) {
      return apiError("Missing projectId, pageNumber, or type", 400);
    }
    if (!sourceTextRegionId && !(overrides?.data && overrides?.bbox)) {
      return apiError(
        "Must provide either sourceTextRegionId OR overrides.{data,bbox}",
        400,
      );
    }

    const access = await resolveProjectAccess({ dbId: projectId });
    if (access.error) return access.error;
    const { project } = access;

    if (project.isDemo) {
      return apiError("Demo projects are read-only", 403);
    }

    const result = await db.transaction(async (tx) => {
      const [pageRow] = await tx
        .select({
          id: pages.id,
          pageIntelligence: pages.pageIntelligence,
          csiCodes: pages.csiCodes,
          textractData: pages.textractData,
        })
        .from(pages)
        .where(and(eq(pages.projectId, project.id), eq(pages.pageNumber, pageNumber)))
        .for("update")
        .limit(1);

      if (!pageRow) {
        throw new Error("Page not found");
      }

      const currentIntel = (pageRow.pageIntelligence ?? {}) as PageIntelligence;
      const existingCsi = (pageRow.csiCodes ?? []) as CsiCode[];

      let regionBbox: [number, number, number, number];
      let regionData: Record<string, unknown>;
      let regionCsiTags: CsiCode[] = overrides?.csiTags ?? [];

      if (sourceTextRegionId) {
        const textRegion = currentIntel.textRegions?.find(
          (tr: TextRegion) => tr.id === sourceTextRegionId,
        );
        if (!textRegion) {
          throw new Error(
            `textRegion ${sourceTextRegionId} not found — reload the page and try again`,
          );
        }

        let grid:
          | { headers: string[]; rows: Record<string, string>[]; rowBoundaries?: number[]; colBoundaries?: number[] }
          | undefined;

        if (textRegion.grid && textRegion.grid.headers.length > 0 && textRegion.grid.rows.length > 0) {
          grid = {
            headers: textRegion.grid.headers,
            rows: textRegion.grid.rows,
            rowBoundaries: textRegion.grid.rowBoundaries,
            colBoundaries: textRegion.grid.colBoundaries,
          };
        } else if (type === "notes" && pageRow.textractData) {
          const td = pageRow.textractData as TextractPageData;
          grid = parseNotesFromRegion(td, textRegion.bbox);
        }

        if (!grid) {
          throw new Error(
            "Could not bind grid from textRegion — try the Parser Manual mode instead",
          );
        }

        if (regionCsiTags.length === 0) {
          try {
            regionCsiTags = detectCsiFromGrid(grid.headers, grid.rows);
          } catch (err) {
            logger.warn("[regions/promote] CSI detect failed (non-fatal):", err);
          }
        }

        // textRegion.bbox is LTWH; ParsedRegion.bbox stored as MinMax (matches keynote/table convention)
        const [tL, tT, tW, tH] = textRegion.bbox;
        regionBbox = [tL, tT, tL + tW, tT + tH];

        regionData = {
          headers: grid.headers,
          rows: grid.rows,
          tagColumn: grid.headers[0],
          tableName: textRegion.headerText ?? defaultTableName(type, pageNumber),
          rowCount: grid.rows.length,
          columnCount: grid.headers.length,
          colBoundaries: grid.colBoundaries,
          rowBoundaries: grid.rowBoundaries,
          ...(type === "notes"
            ? { noteType: inferNoteTypeFromTier2(textRegion.classifiedLabels?.tier2) }
            : {}),
        };
      } else {
        // Parser Save path — client supplies bbox + data directly
        regionBbox = overrides!.bbox!;
        regionData = overrides!.data!;
      }

      const parsedRegion: ParsedRegion = {
        id: `parsed-${Date.now()}`,
        type,
        category: overrides?.category ?? inferCategory(type, regionData),
        bbox: regionBbox,
        confidence: 0.85,
        source: "user",
        csiTags: regionCsiTags,
        data: regionData as NotesData,
      };
      if (sourceTextRegionId) {
        parsedRegion.sourceTextRegionId = sourceTextRegionId;
      }

      const existingRegions = currentIntel.parsedRegions ?? [];
      const updatedIntelligence: PageIntelligence = {
        ...currentIntel,
        parsedRegions: [...existingRegions, parsedRegion],
      };
      const newCsi = mergeCsiCodes(existingCsi, regionCsiTags);

      await tx
        .update(pages)
        .set({
          pageIntelligence: updatedIntelligence,
          csiCodes: newCsi,
        })
        .where(eq(pages.id, pageRow.id));

      return { parsedRegion, updatedIntelligence };
    });

    let summaries = null;
    try {
      summaries = await computeProjectSummaries(projectId);
    } catch (err) {
      logger.warn("[regions/promote] Summary recompute failed (non-fatal):", err);
    }

    return NextResponse.json({
      ok: true,
      parsedRegion: result.parsedRegion,
      updatedIntelligence: result.updatedIntelligence,
      summaries,
    });
  } catch (err) {
    logger.error("[regions/promote] Failed:", err);
    return apiError(err instanceof Error ? err.message : "Promote failed", 500);
  }
}

function inferCategory(type: ParsedRegionType, data: Record<string, unknown>): string {
  const tableName = data.tableName as string | undefined;
  if (tableName) return tableName.toLowerCase().replace(/\s+/g, "-");
  return `${type}-region`;
}

function defaultTableName(type: ParsedRegionType, pageNumber: number): string {
  const label = type === "notes" ? "Notes" : type === "spec" ? "Spec" : type;
  return `${label} p.${pageNumber}`;
}

function inferNoteTypeFromTier2(tier2?: string): NotesData["noteType"] {
  if (!tier2) return "other";
  const upper = tier2.toUpperCase();
  if (upper.includes("GENERAL")) return "general";
  if (upper.includes("RCP") || upper.includes("CEILING")) return "rcp";
  if (upper.includes("DEMO")) return "demo";
  if (upper.includes("KEY")) return "key";
  if (upper.includes("PART 1") || upper.includes("PART 2") || upper.includes("SECTION")) return "spec-note";
  return "other";
}
