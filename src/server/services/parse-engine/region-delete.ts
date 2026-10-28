/**
 * DELETE /api/projects/[id]/parse-engine/region — remove one saved region from the workspace (table pipeline
 * PLAN §3.2; WP-3.G; K50).
 *
 * Under `withProjectWrite` (project row first) and the page row FOR UPDATE (rule 11), in one transaction:
 *   - every `parsedRegions` row with that id goes (old data can hold duplicates); sibling order is kept;
 *   - its label `parseLabels[regionId]` goes (an orphan would pin the page as human work, WP-2.F LOW-2);
 *   - page CSI shrinks: the region's codes that no remaining region carries and the page does not own
 *     (trigger-bearing text codes, YOLO class codes) are dropped (K50, `page-csi.ts`). The classic
 *     `DELETE /api/regions` still leaves page CSI untouched (frozen);
 *   - its tag projection goes: `replace-for-region` with no tags removes every `yoloTags` row linked to it.
 * Then `computeProjectSummaries` (which re-derives `PJ.structureIndex`). Proposal and text-region verdicts are
 * left as they are: they are the user's labels on the detection, not on the saved region.
 * Works for classic regions too (they simply have no linked tags). Demo projects are refused.
 */

import { and, eq, sql } from "drizzle-orm";
import { pages } from "@/lib/db/schema";
import type { AuthSession, ProjectAccessRow } from "@/lib/api-utils";
import { computeProjectSummaries } from "@/lib/project-analysis";
import { logger } from "@/lib/logger";
import type { RegionDeleteResponse } from "@/lib/parse-engine/types-commit";
import type { CsiCode, PageIntelligence, ParsedRegion } from "@/types";
import { ApiError } from "@/server/api/envelope";
import {
  assertProjectWritable,
  type ProjectWriteCapability,
  withProjectWrite,
} from "@/server/api/project-write-capability";
import { serializePageWindowIntelligence } from "@/server/services/page-window-serialization";
import { applyTagOps, type TagOpsResult } from "@/server/services/tag-ops";
import { pageCsiAfterRegionChange } from "./page-csi";

const MAX_ID = 300;

export function parseRegionDeleteInput(body: Record<string, unknown>): { pageNumber: number; regionId: string } {
  const { pageNumber, regionId } = body;
  if (typeof pageNumber !== "number" || !Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new ApiError("VALIDATION", "pageNumber must be a positive integer");
  }
  if (typeof regionId !== "string" || regionId.length === 0 || regionId.length > MAX_ID) {
    throw new ApiError("VALIDATION", "regionId is required");
  }
  return { pageNumber, regionId };
}

export interface RegionDeleteDeps {
  summaries(projectId: number, capability: ProjectWriteCapability): Promise<unknown>;
}

export const defaultRegionDeleteDeps: RegionDeleteDeps = {
  summaries: (projectId, capability) => computeProjectSummaries(projectId, capability),
};

export async function deleteWorkspaceRegion(
  accessProject: ProjectAccessRow,
  session: AuthSession | null,
  body: Record<string, unknown>,
  deps: RegionDeleteDeps = defaultRegionDeleteDeps,
): Promise<RegionDeleteResponse> {
  const capability = assertProjectWritable(accessProject);
  if (!session) throw new ApiError("UNAUTHORIZED", "Unauthorized");
  const { pageNumber, regionId } = parseRegionDeleteInput(body);

  const result = await withProjectWrite(capability, accessProject.id, async (tx) => {
    const [page] = await tx
      .select({ id: pages.id, pageIntelligence: pages.pageIntelligence, csiCodes: pages.csiCodes })
      .from(pages)
      .where(and(eq(pages.projectId, accessProject.id), eq(pages.pageNumber, pageNumber)))
      .for("update")
      .limit(1);
    if (!page) throw new ApiError("NOT_FOUND", "Page not found");
    const pi = (page.pageIntelligence ?? {}) as PageIntelligence;
    const regions = Array.isArray(pi.parsedRegions) ? pi.parsedRegions : [];
    const removed = regions.filter((r) => r?.id === regionId);
    const empty: TagOpsResult = { tags: [], removed: [], replacedRegionIds: [], skipped: [] };
    if (!removed.length) {
      return { deleted: false, pageIntelligence: pi, csiCodeCount: ((page.csiCodes ?? []) as CsiCode[]).length, tags: empty };
    }
    const kept: ParsedRegion[] = regions.filter((r) => r?.id !== regionId);
    const csiCodes = pageCsiAfterRegionChange(
      (page.csiCodes ?? []) as CsiCode[],
      removed.flatMap((r) => r.csiTags ?? []),
      kept.map((r) => r?.csiTags),
    );
    const base = sql`coalesce(${pages.pageIntelligence}, '{}'::jsonb)`;
    const [written] = await tx
      .update(pages)
      .set({
        pageIntelligence: sql`(${base} || ${JSON.stringify({ parsedRegions: kept })}::jsonb) #- array['parseLabels', ${regionId}::text]`,
        csiCodes,
      })
      .where(eq(pages.id, page.id))
      .returning({ pageIntelligence: pages.pageIntelligence });
    const tags = await applyTagOps(tx, capability, [{ op: "replace-for-region", regionId, tags: [] }]);
    return { deleted: true, pageIntelligence: (written?.pageIntelligence ?? {}) as PageIntelligence, csiCodeCount: csiCodes.length, tags };
  });

  let summaries: unknown = null;
  if (result.deleted) {
    try {
      summaries = await deps.summaries(accessProject.id, capability);
    } catch (err) {
      logger.warn("[parse-engine/region] Summary recompute failed (non-fatal)", { error: err });
    }
  }
  return {
    ok: true,
    deleted: result.deleted,
    updatedIntelligence: serializePageWindowIntelligence(result.pageIntelligence),
    csiCodeCount: result.csiCodeCount,
    tags: { rows: result.tags.tags, removed: result.tags.removed, replacedRegionIds: result.tags.replacedRegionIds },
    summaries,
  };
}
