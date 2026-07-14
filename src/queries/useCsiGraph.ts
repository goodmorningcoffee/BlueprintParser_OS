"use client";

// [refactor jul11 P2.3] Tiny bootstrap owner for the sole live remainder of the former
// projectIntelligenceData store blob. Do not broaden this to the full PI object: summaries and
// yoloTags already have canonical Query owners, and caching the blob would recreate hidden copies.

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/queries/queryKeys";
import { useSessionStore } from "@/stores/sessionStore";
import type { CsiNetworkGraph } from "@/lib/csi-graph";

type ProjectIntelligence = Record<string, unknown> | null | undefined;

/** Unconditional openProject seed; `null` is explicit because undefined is a v5 no-op. */
export function seedCsiGraphFromBootstrap(
  qc: QueryClient,
  publicId: string,
  projectIntelligence: ProjectIntelligence,
): void {
  // Preserve the formerly unvalidated JSONB read; P4 owns schema validation. The cast changes only
  // TypeScript ownership and the explicit null prevents React Query v5's undefined=no-op behavior.
  const graph = projectIntelligence?.csiGraph as CsiNetworkGraph | null | undefined;
  qc.setQueryData<CsiNetworkGraph | null>(queryKeys.csiGraph.all(publicId), graph ?? null);
}

/** Exact project cleanup; sibling Query domains have independent lifetime/persistence policy. */
export function clearCsiGraphProject(qc: QueryClient, publicId: string): void {
  if (!publicId) return;
  qc.removeQueries({ queryKey: queryKeys.csiGraph.all(publicId), exact: true });
}

/** CsiPanel's disabled bootstrap observer. No client GET exists for this embedded artifact. */
export function useCsiGraph(): CsiNetworkGraph | null {
  const publicId = useSessionStore((state) => state.publicId);
  const { data } = useQuery<CsiNetworkGraph | null>({
    queryKey: queryKeys.csiGraph.all(publicId),
    queryFn: () => {
      throw new Error("csiGraph is project-bootstrap seeded; queryFn must never run");
    },
    enabled: false,
    initialData: null,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data;
}
