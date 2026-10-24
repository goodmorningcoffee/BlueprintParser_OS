/**
 * classifier-engine/summary.ts — `projectIntelligence.proposals`: the compact, capped list the
 * Tables panel reads (types.ts `ProjectProposalSummary`), built from the pages' stored
 * `classifierProposals` with each item's verdict joined from `proposalVerdicts`. Pure.
 */

import { storedClassifierProposals } from "./engine";
import {
  CLASSIFIER_ENGINE_VERSION, PROJECT_PROPOSALS_CAP,
  type PageProposalVerdicts, type ProjectProposalSummary, type ProposalSummaryItem, type ProposalVerdict,
} from "./types";

export type ProposalPage = { pageNumber: number; pageIntelligence: unknown };

export function storedProposalVerdicts(pageIntelligence: unknown): PageProposalVerdicts {
  if (!pageIntelligence || typeof pageIntelligence !== "object") return {};
  const v = (pageIntelligence as Record<string, unknown>).proposalVerdicts;
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: PageProposalVerdicts = {};
  for (const [id, verdict] of Object.entries(v as Record<string, unknown>)) {
    if (verdict && typeof verdict === "object" && typeof (verdict as ProposalVerdict).verdict === "string") out[id] = verdict as ProposalVerdict;
  }
  return out;
}

export function buildProjectProposalSummary(pages: readonly ProposalPage[], generatedAt: string = new Date().toISOString()): ProjectProposalSummary {
  const items: ProposalSummaryItem[] = [];
  let engineVersion = CLASSIFIER_ENGINE_VERSION;
  for (const page of [...pages].sort((a, b) => a.pageNumber - b.pageNumber)) {
    const stored = storedClassifierProposals(page.pageIntelligence);
    if (!stored) continue;
    engineVersion = stored.engineVersion;
    const verdicts = storedProposalVerdicts(page.pageIntelligence);
    for (const p of stored.proposals) {
      const verdict = verdicts[p.id]?.verdict;
      items.push({
        id: p.id, recipeId: p.recipeId, pageNumber: p.pageNumber, bbox: p.bbox, target: p.target,
        classId: p.classId, className: p.className, group: p.group, displayName: p.displayName, p: p.p, nameP: p.nameP,
        ...(verdict ? { verdict } : {}),
      });
    }
  }
  return { engineVersion, generatedAt, total: items.length, truncated: items.length > PROJECT_PROPOSALS_CAP, items: items.slice(0, PROJECT_PROPOSALS_CAP) };
}
