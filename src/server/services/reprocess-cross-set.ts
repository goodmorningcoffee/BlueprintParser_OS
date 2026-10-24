// [cross-set F3 2026-10-24] POST /api/admin/reprocess?scope=cross-set — the company-wide cross-set
// pass (services/cross-set-links.ts): ONE compute over every eligible project of the admin's company,
// then this project's slice persisted for each SELECTED project under its reprocess lease. No OCR,
// no detectors, no page writes. Selecting a subset limits what is written, never what is compared.
//
// Lives here, not in reprocess.ts (its per-project loop count is pinned at exactly 5 by
// reprocess-per-project-guard.test.ts); this loop carries the same per-project guard itself.

import { logger } from "@/lib/logger";
import type { CrossSetLinks, CrossSetSummary } from "@/lib/knowledge-graph";
import type { ProjectWriteCapability } from "@/server/api/project-write-capability";
import { computeCompanyCrossSet, persistProjectCrossSet, type CompanyCrossSet } from "./cross-set-links";
import type { ReprocessStream } from "./reprocess-stream";

export interface CrossSetScopeProject {
  id: number;
  name: string;
}

export interface CrossSetScopeCounts {
  /** Selected projects whose links file + summary were written. */
  updated: number;
  /** Selected projects not eligible (demo / no storage prefix) or whose write failed. */
  skipped: number;
  errors: number;
  total: number;
  /** Eligible projects of the company that took part in the compute. */
  companyProjects: number;
  pages: number;
  links: { twin: number; revision: number; copy: number };
  dropped: CrossSetLinks["dropped"];
}

export async function reprocessCrossSetScope(opts: {
  companyId: number;
  projects: readonly CrossSetScopeProject[];
  withLease: <T>(projectId: number, op: (writeCapability: ProjectWriteCapability) => Promise<T>) => Promise<T>;
  stream: Pick<ReprocessStream, "send" | "debug">;
  compute?: (companyId: number, onProject: (loaded: number, total: number, name: string) => void) => Promise<CompanyCrossSet>;
  persist?: (writeCapability: ProjectWriteCapability, project: { id: number; publicId: string; dataUrl: string }, result: CrossSetLinks) => Promise<CrossSetSummary>;
}): Promise<CrossSetScopeCounts> {
  const { send, debug } = opts.stream;
  const compute = opts.compute ?? ((companyId, onProject) => computeCompanyCrossSet(companyId, undefined, { onProject: (loaded, total, p) => onProject(loaded, total, p.name) }));
  const persist = opts.persist ?? ((wc, project, result) => persistProjectCrossSet(wc, project, result));
  const c: CrossSetScopeCounts = {
    updated: 0, skipped: 0, errors: 0, total: 0, companyProjects: 0, pages: 0,
    links: { twin: 0, revision: 0, copy: 0 }, dropped: { stockTexts: 0, oversizedBuckets: 0, truncatedBuckets: 0, comparisons: 0 },
  };

  // 1. One company-wide compute (reads only). A failure here fails the whole stage: nothing was written.
  send({ type: "project", name: "Cross-set links: reading the company's sets" });
  const { projects: eligible, result } = await compute(opts.companyId, (loaded, total, name) => {
    send({ type: "progress", loaded, total, project: name });
  });
  c.companyProjects = result.projects;
  c.pages = result.pages;
  c.links.twin = result.links.filter((l) => l.kind === "twin_of").length;
  c.links.revision = result.links.length - c.links.twin;
  c.links.copy = result.projectLinks.length;
  c.dropped = result.dropped;
  debug("company.cross-set", { companyProjects: c.companyProjects, pages: c.pages, links: c.links, dropped: c.dropped });
  const byId = new Map(eligible.map((p) => [p.id, p]));

  // 2. Persist each selected project's slice under its lease.
  for (const project of opts.projects) {
    try {
      await opts.withLease(project.id, async (writeCapability) => {
        c.total++;
        send({ type: "project", name: project.name });
        const row = byId.get(project.id);
        if (!row) {
          c.skipped++;
          send({ type: "warning", project: project.name, message: "Cross-set links not written (not eligible: demo or no storage prefix)" });
          return;
        }
        const summary = await persist(writeCapability, row, result);
        c.updated++;
        debug("project.cross-set", { project: project.name, linkedProjects: summary.linkedProjects.length });
        send({ type: "progress", updated: c.updated, total: c.total, project: project.name, linkedProjects: summary.linkedProjects.length });
      });
    } catch (err) {
      // Per-project guard — same contract as reprocess.ts's five scopes (S8 / TILE_015 C1).
      c.errors++;
      logger.error(`[reprocess-cross-set] Project ${project.name} failed:`, err);
      send({ type: "error", project: project.name, error: err instanceof Error ? err.message : "Failed" });
    }
  }
  return c;
}
