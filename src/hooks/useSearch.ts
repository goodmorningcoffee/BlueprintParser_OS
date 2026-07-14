import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  captureProjectLifecycle,
  isCurrentProjectLifecycle,
} from "@/lib/project-lifecycle";
import { useSessionStore } from "@/stores/sessionStore";
import { useUiStore, useSearchUiActions } from "@/stores/uiStore";
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
 * Reads search UI state and session identity from their owners, calls the search API,
 * and updates searchResults + searchMatches in the presentation store.
 */
export function useSearch() {
  const searchQuery = useUiStore((s) => s.searchQuery);
  const publicId = useSessionStore((s) => s.publicId);
  const isDemo = useSessionStore((s) => s.isDemo);
  const { setSearchResults, setSearchMatches, setSearchLoading } = useSearchUiActions();
  const queryClient = useQueryClient();

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    // Clear results if query is too short
    if (!searchQuery || searchQuery.trim().length < 2 || !publicId) {
      // These three fields are one UI transition. A subscriber may synchronously install a new
      // lifecycle, so separate writes would let this obsolete effect continue into its successor.
      useUiStore.setState({
        searchResults: [],
        searchMatches: {},
        searchLoading: false,
      });
      return;
    }

    const scheduledQuery = searchQuery.trim();
    const lifecycle = captureProjectLifecycle(queryClient);
    if (
      !lifecycle ||
      lifecycle.publicId !== publicId ||
      lifecycle.demo !== isDemo
    ) {
      return;
    }

    const isScheduledGenerationCurrent = () => {
      const session = useSessionStore.getState();
      return session.publicId === publicId &&
        session.isDemo === isDemo &&
        useUiStore.getState().searchQuery.trim() === scheduledQuery &&
        isCurrentProjectLifecycle(queryClient, lifecycle);
    };

    setSearchLoading(true);
    // Zustand subscribers run synchronously. Loading publication itself can install a successor,
    // so revalidate before registering any delayed work for the generation that just lost authority.
    if (!isScheduledGenerationCurrent()) return;

    // Debounce 300ms
    const timer = setTimeout(async () => {
      // Capture lifecycle authority when scheduling, not after the debounce. A callback already
      // dequeued by the browser can outlive effect cleanup and must not borrow a successor's token.
      if (timerRef.current !== timer || !isScheduledGenerationCurrent()) return;
      timerRef.current = null;

      // Abort any in-flight request
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const isCurrent = () => {
        return abortRef.current === controller &&
          !controller.signal.aborted &&
          isScheduledGenerationCurrent();
      };

      try {
        const params = new URLSearchParams({
          projectId: publicId,
          q: scheduledQuery,
        });

        const endpoint = isDemo ? "/api/demo/search" : "/api/search";
        const res = await fetch(`${endpoint}?${params}`, {
          signal: controller.signal,
        });
        if (!isCurrent()) return;

        if (!res.ok) {
          setSearchResults([]);
          if (!isCurrent()) return;
          setSearchMatches({});
          return;
        }

        const data: SearchResponse = await res.json();
        if (!isCurrent()) return;

        // Update store
        const pageNumbers = data.results.map((r) => r.pageNumber);
        const matchesByPage: Record<number, SearchWordMatch[]> = {};
        for (const result of data.results) {
          matchesByPage[result.pageNumber] = result.wordMatches;
        }

        setSearchResults(pageNumbers);
        // Zustand subscribers run synchronously. The first publication may install a successor
        // lifecycle, so it cannot authorize the paired matches publication into that successor.
        if (!isCurrent()) return;
        setSearchMatches(matchesByPage);
      } catch (err) {
        if (!isCurrent()) return;
        if ((err as Error).name !== "AbortError") {
          console.error("Search error:", err);
          setSearchResults([]);
          if (!isCurrent()) return;
          setSearchMatches({});
        }
      } finally {
        if (isCurrent()) {
          abortRef.current = null;
          setSearchLoading(false);
        }
      }
    }, 300);
    timerRef.current = timer;

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      const controller = abortRef.current;
      if (controller) {
        controller.abort();
        if (abortRef.current === controller) abortRef.current = null;
      }
    };
  }, [
    searchQuery,
    publicId,
    isDemo,
    queryClient,
    setSearchResults,
    setSearchMatches,
    setSearchLoading,
  ]);
}
