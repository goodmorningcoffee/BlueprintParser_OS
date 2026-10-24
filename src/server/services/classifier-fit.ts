// [clf step 4 2026-10-24] Admin › classifier weight fitting (ROOT only, read-only).
// POST /api/admin/classifiers/fit {companyId?, dryRun: true} — fit the company's effective recipes
// (built-ins + `companies.pipeline_config.classifiers`) on its stored verdicts
// (`pages.page_intelligence.proposalVerdicts`, features snapshotted at label time) and return the
// report + a PROPOSED overlay patch. Writes nothing: applying goes through the builder's overlay save.
// Demo projects are never read. All numbers are in-sample (the verdicts are the training set); the
// held-out comparison lives in scripts/classifier-fit.ts (gitignore/projects/classifier_builder/PLAN.md).
import { z } from "zod";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { AuthSession } from "@/lib/api-utils";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { companies, pages, projects } from "@/lib/db/schema";
import { ApiError } from "@/server/api/envelope";
import { effectiveRecipes } from "@/lib/classifier-engine/recipes";
import { storedProposalVerdicts } from "@/lib/classifier-engine/summary";
import { fitRecipe, overlayFromFits, samplesFromVerdicts, type RecipeFitReport } from "@/lib/classifier-engine/fit";
import type { ProposalVerdict } from "@/lib/classifier-engine/types";

export const zClassifierFitBody = z.object({
  companyId: z.union([z.number().int().positive(), z.string().regex(/^[1-9][0-9]{0,9}$/)]).optional(),
  /** Always a dry run: this route never writes. */
  dryRun: z.literal(true),
  lambda: z.number().positive().max(1000).optional(),
});
type FitBody = z.infer<typeof zClassifierFitBody>;

/** Verdict rows read per request (pages with any verdict, non-demo projects of one company). */
const MAX_PAGES = 50_000;

export interface ClassifierFitResponse {
  dryRun: true;
  applied: false;
  companyId: number;
  verdicts: { total: number; pages: number; truncated: boolean; byRecipe: Record<string, { accept: number; reject: number; rename: number }> };
  fits: RecipeFitReport[];
  /** Proposed patches against the company's CURRENT effective recipes; merge into its overlay to apply. */
  overlay: ReturnType<typeof overlayFromFits>;
  notes: string[];
}

export async function fitCompanyClassifiers(session: AuthSession, body: FitBody): Promise<ClassifierFitResponse> {
  if (!session.user.isRootAdmin) throw new ApiError("FORBIDDEN", "Root only");
  const companyId = body.companyId === undefined ? session.user.companyId : Number(body.companyId);
  const [company] = await db.select({ id: companies.id, pipelineConfig: companies.pipelineConfig }).from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!company) throw new ApiError("NOT_FOUND", "Company not found");

  const rows = await db
    .select({ verdicts: sql<unknown>`${pages.pageIntelligence} -> 'proposalVerdicts'` })
    .from(pages)
    .innerJoin(projects, eq(pages.projectId, projects.id))
    .where(and(eq(projects.companyId, companyId), eq(projects.isDemo, false), isNotNull(sql`${pages.pageIntelligence} -> 'proposalVerdicts'`)))
    .orderBy(pages.id)
    .limit(MAX_PAGES + 1);
  const truncated = rows.length > MAX_PAGES;
  const verdicts: ProposalVerdict[] = rows.slice(0, MAX_PAGES).flatMap((r) => Object.values(storedProposalVerdicts({ proposalVerdicts: r.verdicts })));

  const byRecipe: ClassifierFitResponse["verdicts"]["byRecipe"] = {};
  for (const v of verdicts) {
    const b = (byRecipe[v.recipeId] ??= { accept: 0, reject: 0, rename: 0 });
    if (v.verdict in b) b[v.verdict]++;
  }
  const recipes = effectiveRecipes(company.pipelineConfig?.classifiers);
  const fits = recipes
    .filter((r) => byRecipe[r.id])
    .map((r) => fitRecipe(r, samplesFromVerdicts(verdicts, r), body.lambda === undefined ? {} : { lambda: body.lambda }));
  const overlay = overlayFromFits(fits, new Date().toISOString());

  audit("admin.classifiers.fit", {
    userId: session.user.dbId,
    companyId: session.user.companyId,
    details: { dryRun: true, scopeCompanyId: companyId, verdicts: verdicts.length, recipes: fits.map((f) => ({ id: f.report.recipeId, patched: !!f.patch })) },
  });
  return {
    dryRun: true, applied: false, companyId,
    verdicts: { total: verdicts.length, pages: Math.min(rows.length, MAX_PAGES), truncated, byRecipe },
    fits: fits.map((f) => f.report), overlay,
    notes: [
      "In-sample: the verdicts are both the training and the scoring set, so the fitted side is optimistic.",
      "Verdicts exist only for proposals that passed the detect head, so detect recall cannot be measured from them.",
      "Nothing was written. Apply the overlay through the classifier builder (it merges into the company overlay).",
    ],
  };
}
