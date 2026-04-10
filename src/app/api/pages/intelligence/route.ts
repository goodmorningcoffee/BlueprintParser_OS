import { NextResponse } from "next/server";
import { resolveProjectAccess, apiError } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { pages, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import type { CsiCode } from "@/types";
import { computeProjectSummaries } from "@/lib/project-analysis";
import { logger } from "@/lib/logger";

/**
 * PATCH /api/pages/intelligence
 *
 * Persists pageIntelligence updates to DB and merges CSI codes
 * from parsed regions into the page-level csiCodes list.
 */
export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const { projectId, pageNumber, intelligence } = body as {
      projectId: number;
      pageNumber: number;
      intelligence: Record<string, unknown>;
    };

    if (!projectId || !pageNumber || !intelligence) {
      return apiError("Missing projectId, pageNumber, or intelligence", 400);
    }

    const access = await resolveProjectAccess({ dbId: projectId });
    if (access.error) return access.error;
    const { project: proj } = access;

    if (proj.isDemo) {
      return apiError("Demo projects are read-only", 403);
    }

    // Read current page data
    const [pageRow] = await db
      .select({
        id: pages.id,
        pageIntelligence: pages.pageIntelligence,
        csiCodes: pages.csiCodes,
      })
      .from(pages)
      .where(and(eq(pages.projectId, projectId), eq(pages.pageNumber, pageNumber)))
      .limit(1);

    if (!pageRow) {
      return apiError("Page not found", 404);
    }

    // Deep-merge intelligence (new fields override, existing fields preserved)
    const existing = (pageRow.pageIntelligence || {}) as Record<string, unknown>;
    const merged = { ...existing, ...intelligence };

    // CSI merge: collect CSI codes from parsedRegions and merge into page-level csiCodes
    const existingCsi = (pageRow.csiCodes || []) as CsiCode[];
    const existingCodes = new Set(existingCsi.map((c) => c.code));
    const newCsi = [...existingCsi];

    const parsedRegions = (merged.parsedRegions || []) as Array<{ csiTags?: Array<{ code: string; description: string }> }>;
    for (const region of parsedRegions) {
      if (region.csiTags) {
        for (const tag of region.csiTags) {
          if (!existingCodes.has(tag.code)) {
            existingCodes.add(tag.code);
            newCsi.push({
              code: tag.code,
              description: tag.description,
              division: tag.code.substring(0, 2),
              trade: "",
            } as CsiCode);
          }
        }
      }
    }

    // Write both fields
    await db
      .update(pages)
      .set({
        pageIntelligence: merged,
        csiCodes: newCsi,
      })
      .where(eq(pages.id, pageRow.id));

    // Recompute summaries if parsedRegions changed (new table/keynote parsed)
    let summaries = null;
    if (intelligence.parsedRegions) {
      try {
        summaries = await computeProjectSummaries(projectId);
      } catch (e) {
        logger.error("[pages/intelligence] Summary recompute failed:", e);
      }
    }

    return NextResponse.json({ ok: true, csiCodeCount: newCsi.length, summaries });
  } catch (err) {
    logger.error("[pages/intelligence] Failed:", err);
    return apiError(err instanceof Error ? err.message : "Intelligence update failed", 500);
  }
}
