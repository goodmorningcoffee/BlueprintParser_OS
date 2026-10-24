// [classifier engine 2a 2026-10-24] The two server-side helpers around src/lib/classifier-engine:
//   • computeClassifierProposals — the engine over one page, NEVER throws (a failure is logged and
//     yields undefined, so an upload / YOLO load / reprocess is never failed by a recipe);
//   • writeProjectProposals — `projects.projectIntelligence.proposals` (ProjectProposalSummary) from
//     the pages' stored `classifierProposals` + `proposalVerdicts`, other keys untouched
//     (mergeProjectIntelligence). Same shape as tag-families-write.ts: pages may be passed in
//     (yolo/load's in-memory next intelligence) or read back (only the two keys, never whole rows).
// The company overlay (`companies.pipeline_config.classifiers`) is resolved by the caller and
// handed in as `overlay`; the CSI box tagger is built once per process (KB memoised by loadCsiKb).

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { pages, projects } from "@/lib/db/schema";
import { mergeProjectIntelligence } from "@/lib/intelligence-merge";
import { logger } from "@/lib/logger";
import {
  buildProjectProposalSummary, effectiveRecipes, runClassifierEngine,
  type BoxTagger, type ClassifierPageInput, type ClassifierRecipe, type PageClassifierProposals, type ProjectProposalSummary, type ProposalPage,
} from "@/lib/classifier-engine";
import { createCsiBoxTagger } from "@/lib/classifier-engine/csi-box-tagger";
import { type ProjectWriteCapability, withProjectWrite } from "@/server/api/project-write-capability";

let tagger: BoxTagger | null | undefined;
/** The process-wide CSI box tagger (null when the KB is unavailable → engine falls back to page triggers). */
export function classifierBoxTagger(): BoxTagger | null {
  if (tagger === undefined) tagger = createCsiBoxTagger();
  return tagger;
}

/** Recipes for a company: built-ins + its overlay (memoised per overlay object by the callers' loop). */
export function classifierRecipesFor(overlay: unknown): ClassifierRecipe[] {
  return effectiveRecipes(overlay);
}

/** Run the engine over one page; undefined (and one error log) when it throws. `recipes` default to the built-ins. */
export function computeClassifierProposals(input: Omit<ClassifierPageInput, "tagger">, recipes: readonly ClassifierRecipe[] = classifierRecipesFor(undefined)): PageClassifierProposals | undefined {
  try {
    const run = runClassifierEngine({ ...input, tagger: classifierBoxTagger() }, recipes);
    for (const e of run.errors) logger.error(`[classifier-engine] recipe ${e.recipeId} failed on page ${input.pageNumber}: ${e.message}`);
    return run.result;
  } catch (err) {
    logger.error(`[classifier-engine] failed on page ${input.pageNumber}:`, err);
    return undefined;
  }
}

/** All the project's pages, each carrying only `classifierProposals` + `proposalVerdicts`. */
export async function loadProjectProposalPages(projectId: number): Promise<ProposalPage[]> {
  const rows = await db
    .select({
      pageNumber: pages.pageNumber,
      proposals: sql<unknown>`${pages.pageIntelligence}->'classifierProposals'`,
      verdicts: sql<unknown>`${pages.pageIntelligence}->'proposalVerdicts'`,
    })
    .from(pages)
    .where(eq(pages.projectId, projectId))
    .orderBy(pages.pageNumber);
  return rows.map((r) => ({ pageNumber: r.pageNumber, pageIntelligence: { classifierProposals: r.proposals ?? undefined, proposalVerdicts: r.verdicts ?? undefined } }));
}

/** Recompute and persist `projectIntelligence.proposals`; `proposalPages` absent → read from the DB. */
export async function writeProjectProposals(
  writeCapability: ProjectWriteCapability,
  projectId: number,
  proposalPages?: readonly ProposalPage[],
): Promise<ProjectProposalSummary> {
  const proposals = buildProjectProposalSummary(proposalPages ?? (await loadProjectProposalPages(projectId)));
  await withProjectWrite(writeCapability, projectId, async (tx) => {
    const [current] = await tx.select({ pi: projects.projectIntelligence }).from(projects).where(eq(projects.id, projectId));
    await tx.update(projects)
      .set({ projectIntelligence: mergeProjectIntelligence(current?.pi, { proposals }) })
      .where(eq(projects.id, projectId));
  });
  return proposals;
}
