// [graph T8 2026-10-24] POST /api/admin/reprocess?scope=graph — rebuild ONLY the knowledge graph
// (services/project-graph.ts) for each project from stored rows: no OCR, no detectors, no page
// writes. The fast backfill for projects uploaded before the graph existed; the intelligence scope
// also rebuilds it, so after Intelligence this stage finds nothing new to do.
//
// Lives here, not in reprocess.ts (its per-project loop count is pinned at exactly 5 by
// reprocess-per-project-guard.test.ts); this loop carries the same per-project guard itself.

import { logger } from "@/lib/logger";
import type { ProjectWriteCapability } from "@/server/api/project-write-capability";
import { refreshProjectGraph, type GraphRefreshResult } from "./project-graph";
import type { ReprocessStream } from "./reprocess-stream";

export interface GraphScopeProject {
  id: number;
  name: string;
}

export interface GraphScopeCounts {
  /** Projects whose graph was rebuilt. */
  updated: number;
  /** Projects with no storage prefix or a failed build — the console's "skipped". */
  skipped: number;
  errors: number;
  total: number;
  nodes: number;
  edges: number;
  references: { total: number; resolved: number; unresolved: number; ambiguous: number };
}

export async function reprocessGraphScope(opts: {
  projects: readonly GraphScopeProject[];
  withLease: <T>(projectId: number, op: (writeCapability: ProjectWriteCapability) => Promise<T>) => Promise<T>;
  stream: Pick<ReprocessStream, "send" | "debug">;
  refresh?: (projectId: number, writeCapability: ProjectWriteCapability) => Promise<GraphRefreshResult>;
}): Promise<GraphScopeCounts> {
  const refresh = opts.refresh ?? ((projectId, wc) => refreshProjectGraph(projectId, wc));
  const { send, debug } = opts.stream;
  const c: GraphScopeCounts = { updated: 0, skipped: 0, errors: 0, total: 0, nodes: 0, edges: 0, references: { total: 0, resolved: 0, unresolved: 0, ambiguous: 0 } };

  for (const project of opts.projects) {
    try {
      await opts.withLease(project.id, async (writeCapability) => {
        c.total++;
        send({ type: "project", name: project.name });
        const result = await refresh(project.id, writeCapability);
        if (!result.ok || !result.summary) {
          c.skipped++;
          if (result.reason && result.reason !== "no-data-url") c.errors++;
          send({ type: "warning", project: project.name, message: `Graph not built (${result.reason ?? "failed"})` });
          return;
        }
        const s = result.summary;
        c.updated++;
        c.nodes += Object.values(s.nodes).reduce((a, b) => a + b, 0);
        c.edges += Object.values(s.edges).reduce((a, b) => a + b, 0);
        c.references.total += s.references.total;
        c.references.resolved += s.references.resolved;
        c.references.unresolved += s.references.unresolved;
        c.references.ambiguous += s.references.ambiguous;
        debug("project.graph", { project: project.name, nodes: s.nodes, edges: s.edges, references: s.references });
        send({ type: "progress", updated: c.updated, total: c.total, project: project.name, references: s.references });
      });
    } catch (err) {
      // Per-project guard — same contract as reprocess.ts's five scopes (S8 / TILE_015 C1).
      logger.error(`[reprocess-graph] Project ${project.name} failed:`, err);
      send({ type: "error", project: project.name, error: err instanceof Error ? err.message : "Failed" });
    }
  }
  return c;
}
