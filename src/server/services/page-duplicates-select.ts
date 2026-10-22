// Admin › Data tools › Duplicates — apply an explicit SELECTION (owner 2026-10-22: "select all
// for the partially-confident duplicate pages"). The admin ticks blocks and lone pairs of any
// tier (exact / run / near / possible), per project or across the whole scan, and this hides
// exactly those units.
//
// Why this is not a hole in the bulk rules (page-duplicates-apply.ts): every unit is named by
// the admin after review, the digest contract still holds per project (the plan is rebuilt from
// a fresh report under the project lock, and a changed report refuses), and every per-page
// guard (human work, already hidden, last visible copy, busy project) is the same code path.
// Hiding stays reversible via /restore. A unit id that is not in the fresh report → 400.

import type { AuthSession } from "@/lib/api-utils";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { blockHides, type DuplicateKeep, type DuplicateReport } from "@/lib/page-dedup";
import { pairHide } from "@/lib/page-dedup/selection";
import { ApiError } from "@/server/api/envelope";
import { applyPlannedHides, type PlannedHide, type ProjectApplyResult } from "./page-duplicates-apply";
import { loadScopeProjects, resolveCompanyScope } from "./page-duplicates";

export const MAX_SELECTION_PROJECTS = 500;

export interface ProjectSelection {
  projectPublicId: string;
  reportDigest: string;
  blocks?: { id: string; keep: DuplicateKeep }[];
  pairs?: { page: number; keep: DuplicateKeep }[];
}

/** Pages a selection hides, from a fresh report. Unknown block / lone pair → 400. */
export function planSelection(report: DuplicateReport, selection: Pick<ProjectSelection, "blocks" | "pairs">): PlannedHide[] {
  const byPage = new Map(report.pairs.map((p) => [p.page, p]));
  const plan = new Map<number, PlannedHide>();
  for (const { id, keep } of selection.blocks ?? []) {
    const block = report.blocks.find((b) => b.id === id);
    if (!block) throw new ApiError("VALIDATION", `Unknown block ${id}`);
    for (const hide of blockHides(block, keep)) {
      const pair = byPage.get(keep === "latest" ? hide.canonical : hide.page);
      if (!pair || plan.has(hide.page)) continue;
      // Same resolution as planHides: keeping the first copy points at the pair's own canonical.
      const canonical = keep === "earliest" ? pair.canonical : hide.canonical;
      plan.set(hide.page, { page: hide.page, canonical, tier: block.tier, content: pair.content, full: pair.full });
    }
  }
  for (const { page, keep } of selection.pairs ?? []) {
    const pair = byPage.get(page);
    if (!pair || pair.blockId !== null) throw new ApiError("VALIDATION", `Page ${page} is not a lone duplicate pair`);
    const hide = pairHide(pair, keep);
    if (plan.has(hide.page)) continue;
    plan.set(hide.page, { ...hide, tier: pair.tier, content: pair.content, full: pair.full });
  }
  return [...plan.values()].sort((a, b) => a.page - b.page);
}

type SelectionResult = ProjectApplyResult | { projectPublicId: string; skipped: string };

/** POST /api/admin/duplicates/apply-selection — {selections:[…]} (one entry per project). */
export async function applyDuplicateSelection(
  body: { selections: ProjectSelection[] },
  session: AuthSession,
  query: { companyId?: string },
): Promise<{ results: SelectionResult[] }> {
  const companyId = resolveCompanyScope(session, query.companyId);
  const selections = body.selections.filter((s) => (s.blocks?.length ?? 0) + (s.pairs?.length ?? 0) > 0);
  if (!selections.length) throw new ApiError("VALIDATION", "Nothing selected");
  if (selections.length > MAX_SELECTION_PROJECTS) throw new ApiError("VALIDATION", `At most ${MAX_SELECTION_PROJECTS} projects per request`);
  if (new Set(selections.map((s) => s.projectPublicId)).size !== selections.length) {
    throw new ApiError("VALIDATION", "One selection per project");
  }
  // Every id must resolve inside the caller's scope, or the whole request 404s (fail closed).
  const inScope = await loadScopeProjects(companyId, selections.map((s) => s.projectPublicId));
  const byPublicId = new Map(inScope.map((p) => [p.publicId, p]));

  const results: SelectionResult[] = [];
  for (const selection of selections) {
    const project = byPublicId.get(selection.projectPublicId)!;
    try {
      const result = await applyPlannedHides(project, selection.reportDigest, (report) => planSelection(report, selection), session);
      audit("admin.duplicates.apply", {
        userId: session.user.dbId,
        companyId: project.companyId,
        details: {
          projectPublicId: result.projectPublicId,
          hidden: result.hidden.map((h) => [h.page, h.canonical, h.tier]),
          skipped: result.skipped.length,
          selection: { blocks: selection.blocks ?? [], pairs: selection.pairs ?? [] },
        },
      });
      results.push(result);
    } catch (err) {
      if (!(err instanceof ApiError)) {
        logger.error("[duplicates] apply-selection failed", { projectPublicId: project.publicId, err: String(err) });
        results.push({ projectPublicId: project.publicId, skipped: "failed" });
        continue;
      }
      // One project per request → its error IS the response (same as /apply single-project).
      if (selections.length === 1) throw err;
      results.push({
        projectPublicId: project.publicId,
        skipped: err.status === 409 && err.message.startsWith("Duplicates changed") ? "changed since scan" : err.message,
      });
    }
  }
  return { results };
}
