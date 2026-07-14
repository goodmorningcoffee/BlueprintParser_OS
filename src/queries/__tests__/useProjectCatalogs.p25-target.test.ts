// @vitest-environment jsdom

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { queryKeys } from "@/queries/queryKeys";
import {
  EMPTY_PROJECT_CATALOGS,
  deriveProjectCatalogs,
  seedProjectCatalogsCache,
  type ProjectCatalogs,
  useProjectCatalogs,
} from "@/queries/useProjectCatalogs";
import type { PageWindowResponsePage } from "@/queries/pageWindowCore";
import { useSessionStore } from "@/stores/sessionStore";
import type { ProjectSummaries } from "@/types";

const SRC_ROOT = join(process.cwd(), "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function projectPath(path: string): string {
  return `src/${relative(SRC_ROOT, path).replaceAll("\\", "/")}`;
}

function isTestSource(path: string): boolean {
  const relativePath = projectPath(path);
  return relativePath.includes("/__tests__/") || /\.(?:test|spec)\.[^.]+$/.test(relativePath);
}

function summaries(catalogs: ProjectCatalogs): ProjectSummaries {
  return {
    schedules: [],
    parsedTables: [],
    keynoteTablePages: [],
    csiPageIndex: {},
    tradePageIndex: {},
    keynotePageIndex: {},
    textAnnotationPageIndex: {},
    pageClassifications: {},
    annotationSummary: { modelNames: [], categoryCounts: {}, pageAnnotationCounts: {} },
    takeoffTotals: {},
    ...catalogs,
  };
}

function page(csiCodes: PageWindowResponsePage["csiCodes"]): PageWindowResponsePage {
  return {
    pageNumber: 1,
    name: "A1",
    drawingNumber: null,
    csiCodes,
  };
}

function freshClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapper(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

afterEach(() => {
  cleanup();
  useSessionStore.getState().resetSession();
});

describe("P2.5 target project catalog ownership", () => {
  it("uses summaries as the authoritative source when present", () => {
    const result = deriveProjectCatalogs(
      summaries({
        allTrades: ["Plumbing", "Electrical"],
        allCsiCodes: [{ code: "22 00 00", description: "Plumbing" }],
      }),
      [page([{ code: "09 00 00", description: "Finishes", trade: "Finishes", division: "09" }])],
      false,
    );

    expect(result).toEqual({
      allTrades: ["Plumbing", "Electrical"],
      allCsiCodes: [{ code: "22 00 00", description: "Plumbing" }],
    });
  });

  it("preserves auth fallback filtering, sorting, dedupe, and last-description-wins", () => {
    const result = deriveProjectCatalogs(
      null,
      [
        page([
          { code: "22 00 00", description: "Old", trade: "Plumbing", division: "22" },
          { code: "09 00 00", description: "Finishes", trade: "Finishes", division: "09" },
          { code: "22 00 00", description: "New", trade: "Plumbing", division: "22" },
          { code: "00 00 00", description: "No trade", trade: "", division: "00" },
        ]),
      ],
      false,
    );

    expect(result).toEqual({
      allTrades: ["Finishes", "Plumbing"],
      allCsiCodes: [
        { code: "00 00 00", description: "No trade" },
        { code: "09 00 00", description: "Finishes" },
        { code: "22 00 00", description: "New" },
      ],
    });
  });

  it("preserves the demo fallback's existing falsey-trade asymmetry", () => {
    expect(
      deriveProjectCatalogs(
        null,
        [page([{ code: "00 00 00", description: "No trade", trade: "", division: "00" }])],
        true,
      ).allTrades,
    ).toEqual([""]);
  });

  it("keeps catalogs empty when summaries and a parsed chunk are unavailable", () => {
    expect(deriveProjectCatalogs(null, null, false)).toEqual({
      allTrades: [],
      allCsiCodes: [],
    });
  });

  it("unconditionally overwrites a stale same-key cache entry", () => {
    const queryClient = new QueryClient();
    const key = queryKeys.projectCatalogs.all("same-id");
    queryClient.setQueryData(key, {
      allTrades: ["Private"],
      allCsiCodes: [{ code: "99", description: "Private" }],
    });

    seedProjectCatalogsCache(queryClient, "same-id", null);

    expect(queryClient.getQueryData(key)).toEqual({
      allTrades: [],
      allCsiCodes: [],
    });
  });

  it("binds the disabled hook to the session publicId with one stable empty seed", () => {
    const queryClient = freshClient();
    useSessionStore.setState({ publicId: "catalog-A" });

    const { result, rerender } = renderHook(() => useProjectCatalogs(), {
      wrapper: wrapper(queryClient),
    });

    expect(result.current).toBe(EMPTY_PROJECT_CATALOGS);
    expect(result.current.allTrades).toBe(EMPTY_PROJECT_CATALOGS.allTrades);
    expect(result.current.allCsiCodes).toBe(EMPTY_PROJECT_CATALOGS.allCsiCodes);
    rerender();
    expect(result.current).toBe(EMPTY_PROJECT_CATALOGS);

    const queries = queryClient.getQueryCache().findAll();
    expect(queries.map((query) => query.queryKey)).toEqual([
      queryKeys.projectCatalogs.all("catalog-A"),
    ]);

    const query = queries[0];
    expect(query.state).toMatchObject({
      status: "success",
      fetchStatus: "idle",
      error: null,
    });
    expect(query.options).toMatchObject({ staleTime: Infinity, gcTime: Infinity });
    expect(typeof query.options.queryFn).toBe("function");
    expect(() => (query.options.queryFn as () => ProjectCatalogs)()).toThrow(
      "project catalogs are bootstrap-seeded",
    );

    queryClient.clear();
  });

  it("observes exact-key cache updates and isolates them across project switches", async () => {
    const queryClient = freshClient();
    const catalogsA: ProjectCatalogs = {
      allTrades: ["Electrical"],
      allCsiCodes: [{ code: "26 00 00", description: "Electrical" }],
    };
    const catalogsB: ProjectCatalogs = {
      allTrades: ["Plumbing"],
      allCsiCodes: [{ code: "22 00 00", description: "Plumbing" }],
    };
    useSessionStore.setState({ publicId: "catalog-A" });

    const { result } = renderHook(() => useProjectCatalogs(), {
      wrapper: wrapper(queryClient),
    });

    act(() => seedProjectCatalogsCache(queryClient, "catalog-A", catalogsA));
    await waitFor(() => expect(result.current).toEqual(catalogsA));

    act(() => seedProjectCatalogsCache(queryClient, "catalog-B", catalogsB));
    expect(result.current).toEqual(catalogsA);

    act(() => useSessionStore.setState({ publicId: "catalog-B" }));
    await waitFor(() => expect(result.current).toEqual(catalogsB));
    expect(queryClient.getQueryData(queryKeys.projectCatalogs.all("catalog-A"))).toEqual(
      catalogsA,
    );
    expect(queryClient.getQueryData(queryKeys.projectCatalogs.all("catalog-B"))).toEqual(
      catalogsB,
    );

    act(() =>
      seedProjectCatalogsCache(queryClient, "catalog-A", {
        allTrades: ["Stale A"],
        allCsiCodes: [],
      }),
    );
    expect(result.current).toEqual(catalogsB);

    queryClient.clear();
  });

  it("keeps the accepted viewerStore compatibility shell below 100 lines and fail-closed", () => {
    const files = sourceFiles(SRC_ROOT);
    const productionLike = files.filter((path) =>
      !isTestSource(path) && projectPath(path) !== "src/stores/viewerStore.ts");
    const viewerStoreImport = /from\s+["']@\/stores\/viewerStore["']/;
    const importers = productionLike
      .filter((path) => viewerStoreImport.test(readFileSync(path, "utf8")))
      .map(projectPath)
      .sort();

    expect(importers).toEqual([
      "src/stores/viewerCommands.ts",
      "src/test/viewer-store-state.ts",
    ]);
    expect(
      importers.filter((path) => path.startsWith("src/components/")),
    ).toEqual([]);

    const pageDataConsumers = productionLike
      .filter((path) => /\busePageData\s*\(/.test(readFileSync(path, "utf8")))
      .map(projectPath);
    expect(pageDataConsumers).toEqual([]);

    const shell = readFileSync(join(SRC_ROOT, "stores/viewerStore.ts"), "utf8");
    expect(shell.trimEnd().split("\n").length).toBeLessThan(100);
    for (const component of ["ViewerToolbar.tsx", "CsiPanel.tsx"]) {
      const source = readFileSync(join(SRC_ROOT, "components/viewer", component), "utf8");
      expect(source).toContain('from "@/queries/useProjectCatalogs"');
      expect(source).not.toContain("viewerStore");
    }
  });
});
