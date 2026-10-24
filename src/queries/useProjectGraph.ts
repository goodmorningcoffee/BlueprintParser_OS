"use client";

// [graph T8 2026-10-24] The viewer's read of the knowledge graph: GET /api/projects/[id]/graph
// (the reference index — per-page refers-to / referenced-by + the unresolved queue) once per open
// project, cached under queryKeys.projectGraph. Best-effort: any failure reads as "not built".
// Not seeded from the project bootstrap (the graph lives in S3, not in the bootstrap payload).

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/queries/queryKeys";
import { useSessionStore } from "@/stores/sessionStore";
import type { GraphIndex, GraphLink, GraphSummary, UnresolvedReference } from "@/lib/knowledge-graph/summary";

export interface ProjectGraphResponse {
  built: boolean;
  summary?: GraphSummary | null;
  index?: GraphIndex;
}

const EMPTY_LINKS: GraphLink[] = [];
const EMPTY_UNRESOLVED: UnresolvedReference[] = [];

export async function fetchProjectGraphIndex(publicId: string, signal?: AbortSignal): Promise<ProjectGraphResponse> {
  const res = await fetch(`/api/projects/${encodeURIComponent(publicId)}/graph`, { signal });
  if (!res.ok) return { built: false };
  return (await res.json()) as ProjectGraphResponse;
}

export function useProjectGraph(): { data: ProjectGraphResponse | undefined; isLoading: boolean } {
  const publicId = useSessionStore((s) => s.publicId);
  const { data, isLoading } = useQuery<ProjectGraphResponse>({
    queryKey: queryKeys.projectGraph.index(publicId),
    queryFn: ({ signal }) => fetchProjectGraphIndex(publicId, signal),
    enabled: Boolean(publicId),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return { data, isLoading };
}

/** One page's lists plus the project-wide unresolved queue, all stable empties when absent. */
export function usePageGraphLinks(pageNumber: number): {
  built: boolean;
  refersTo: GraphLink[];
  referencedBy: GraphLink[];
  unresolved: UnresolvedReference[];
  summary: GraphSummary | null;
} {
  const { data } = useProjectGraph();
  const entry = data?.index?.pages?.[pageNumber];
  return {
    built: Boolean(data?.built),
    refersTo: entry?.refersTo ?? EMPTY_LINKS,
    referencedBy: entry?.referencedBy ?? EMPTY_LINKS,
    unresolved: data?.index?.unresolved ?? EMPTY_UNRESOLVED,
    summary: data?.summary ?? null,
  };
}
