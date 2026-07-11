// [refactor jul11 P2.3] Additive ownership contract. Production loaders/CsiPanel move only in the
// session ownership-flip commit, so this facade is independently testable and revertible first.

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { queryKeys } from "@/queries/queryKeys";
import {
  clearCsiGraphProject,
  seedCsiGraphFromBootstrap,
  useCsiGraph,
} from "@/queries/useCsiGraph";
import { useSessionStore } from "@/stores/sessionStore";
import type { CsiNetworkGraph } from "@/lib/csi-graph";

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function graph(division: string): CsiNetworkGraph {
  return {
    nodes: [{ division, name: division, totalInstances: 1, pageCount: 1, pages: [1] }],
    edges: [],
    clusters: [],
    fingerprint: `fp-${division}`,
  };
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useSessionStore.getState().resetSession();
  useSessionStore.setState({ publicId: "project-A" });
});

afterEach(() => {
  cleanup();
  qc.clear();
  useSessionStore.getState().resetSession();
  vi.restoreAllMocks();
});

describe("P2.3 csiGraph bootstrap owner", () => {
  it("seeds only csiGraph and publishes updates to the disabled observer", async () => {
    const seededGraph = graph("08");
    seedCsiGraphFromBootstrap(qc, "project-A", {
      summaries: { mustNotDuplicate: true },
      yoloTags: [{ mustNotDuplicate: true }],
      csiGraph: seededGraph,
    });

    const { result } = renderHook(() => useCsiGraph(), { wrapper });
    expect(result.current).toEqual(seededGraph);

    const replacement = graph("09");
    seedCsiGraphFromBootstrap(qc, "project-A", { csiGraph: replacement });
    await waitFor(() => expect(result.current).toEqual(replacement));

    expect(qc.getQueryData(queryKeys.summaries.all("project-A"))).toBeUndefined();
    expect(qc.getQueryData(queryKeys.yoloTags.all("project-A"))).toBeUndefined();
  });

  it("unconditionally maps absent/null graph data to null and overwrites a same-key seed", () => {
    seedCsiGraphFromBootstrap(qc, "project-A", { csiGraph: graph("08") });
    seedCsiGraphFromBootstrap(qc, "project-A", {});
    expect(qc.getQueryData(queryKeys.csiGraph.all("project-A"))).toBeNull();

    seedCsiGraphFromBootstrap(qc, "project-A", null);
    expect(qc.getQueryData(queryKeys.csiGraph.all("project-A"))).toBeNull();
  });

  it("isolates projects and exact cleanup preserves every sibling domain", () => {
    seedCsiGraphFromBootstrap(qc, "project-A", { csiGraph: graph("A") });
    seedCsiGraphFromBootstrap(qc, "project-B", { csiGraph: graph("B") });
    qc.setQueryData(queryKeys.annotations.all("project-A"), [{ id: 1 }]);

    clearCsiGraphProject(qc, "project-A");
    expect(qc.getQueryData(queryKeys.csiGraph.all("project-A"))).toBeUndefined();
    expect(qc.getQueryData(queryKeys.csiGraph.all("project-B"))).toEqual(graph("B"));
    expect(qc.getQueryData(queryKeys.annotations.all("project-A"))).toEqual([{ id: 1 }]);
  });

  it("uses an infinite disabled bootstrap Query and never executes transport", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { result } = renderHook(() => useCsiGraph(), { wrapper });
    expect(result.current).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    const query = qc.getQueryCache().find({
      queryKey: queryKeys.csiGraph.all("project-A"),
      exact: true,
    });
    expect(query?.options).toMatchObject({ staleTime: Infinity, gcTime: Infinity });
  });
});
