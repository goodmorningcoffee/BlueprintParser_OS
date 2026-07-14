"use client";

import { useQuery, type QueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/queries/queryKeys";
import { useSessionStore } from "@/stores/sessionStore";
import type { PageWindowResponsePage } from "@/queries/pageWindowCore";
import type { ProjectSummaries } from "@/types";

export interface ProjectCatalogs {
  allTrades: string[];
  allCsiCodes: { code: string; description: string }[];
}

export const EMPTY_PROJECT_CATALOGS: ProjectCatalogs = Object.freeze({
  allTrades: Object.freeze([]) as unknown as string[],
  allCsiCodes: Object.freeze([]) as unknown as ProjectCatalogs["allCsiCodes"],
});

export function deriveProjectCatalogs(
  summaries: ProjectSummaries | null | undefined,
  pages: readonly PageWindowResponsePage[] | null | undefined,
  demo: boolean,
): ProjectCatalogs {
  if (summaries) {
    return {
      allTrades: summaries.allTrades,
      allCsiCodes: summaries.allCsiCodes,
    };
  }

  if (!pages) {
    return {
      allTrades: [],
      allCsiCodes: [],
    };
  }

  const trades = new Set<string>();
  const csiCodes = new Map<string, string>();
  for (const page of pages) {
    if (!page.csiCodes) continue;
    for (const csiCode of page.csiCodes) {
      // Preserve the loaders' existing asymmetry: authenticated fallback skipped falsey trades,
      // while the demo fallback inserted the value unconditionally.
      if (demo || csiCode.trade) trades.add(csiCode.trade);
      csiCodes.set(csiCode.code, csiCode.description);
    }
  }

  return {
    allTrades: Array.from(trades).sort(),
    allCsiCodes: Array.from(csiCodes.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, description]) => ({ code, description })),
  };
}

export function seedProjectCatalogsCache(
  queryClient: QueryClient,
  publicId: string,
  catalogs: ProjectCatalogs | null | undefined,
): void {
  queryClient.setQueryData(
    queryKeys.projectCatalogs.all(publicId),
    catalogs ?? { allTrades: [], allCsiCodes: [] },
  );
}

export function useProjectCatalogs(): ProjectCatalogs {
  const publicId = useSessionStore((state) => state.publicId);
  const { data } = useQuery({
    queryKey: queryKeys.projectCatalogs.all(publicId),
    queryFn: (): ProjectCatalogs => {
      throw new Error("project catalogs are bootstrap-seeded");
    },
    enabled: false,
    initialData: EMPTY_PROJECT_CATALOGS,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data ?? EMPTY_PROJECT_CATALOGS;
}
