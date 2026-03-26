import { useEffect, useRef } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import type { SearchWordMatch } from "@/types";

interface SearchResponse {
  query: string;
  results: Array<{
    pageNumber: number;
    pageName: string;
    snippet: string;
    rank: number;
    matchCount: number;
    wordMatches: SearchWordMatch[];
  }>;
}

/**
 * Debounced search hook.
 * Reads searchQuery and publicId from the store, calls the search API,
 * and updates searchResults + searchMatches in the store.
 */
export function useSearch() {
  const searchQuery = useViewerStore((s) => s.searchQuery);
  const publicId = useViewerStore((s) => s.publicId);
  const isDemo = useViewerStore((s) => s.isDemo);
  const setSearchResults = useViewerStore((s) => s.setSearchResults);
  const setSearchMatches = useViewerStore((s) => s.setSearchMatches);
  const setSearchLoading = useViewerStore((s) => s.setSearchLoading);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Clear previous timer
    if (timerRef.current) clearTimeout(timerRef.current);

    // Clear results if query is too short
    if (!searchQuery || searchQuery.trim().length < 2 || !publicId) {
      setSearchResults([]);
      setSearchMatches({});
      setSearchLoading(false);
      return;
    }

    setSearchLoading(true);

    // Debounce 300ms
    timerRef.current = setTimeout(async () => {
      // Abort any in-flight request
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const params = new URLSearchParams({
          projectId: publicId,
          q: searchQuery.trim(),
        });

        const endpoint = isDemo ? "/api/demo/search" : "/api/search";
        const res = await fetch(`${endpoint}?${params}`, {
          signal: controller.signal,
        });

        if (!res.ok) {
          setSearchResults([]);
          setSearchMatches({});
          return;
        }

        const data: SearchResponse = await res.json();

        // Update store
        const pageNumbers = data.results.map((r) => r.pageNumber);
        const matchesByPage: Record<number, SearchWordMatch[]> = {};
        for (const result of data.results) {
          matchesByPage[result.pageNumber] = result.wordMatches;
        }

        setSearchResults(pageNumbers);
        setSearchMatches(matchesByPage);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.error("Search error:", err);
          setSearchResults([]);
          setSearchMatches({});
        }
      } finally {
        setSearchLoading(false);
      }
    }, 300);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [searchQuery, publicId, isDemo, setSearchResults, setSearchMatches, setSearchLoading]);
}
