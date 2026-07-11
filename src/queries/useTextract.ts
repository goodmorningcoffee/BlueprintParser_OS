"use client";

import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getCachedTextractForPages,
  subscribeTextractProject,
  textractPageQueryOptions,
} from "@/queries/textractCache";
import { useSessionStore } from "@/stores/sessionStore";
import type { TextractPageData } from "@/types";

// [refactor jul11 P2.2⑧ C2] Disabled observers are deliberate: the future null controller owns the
// exact trailing-200-ms GET cadence. These hooks subscribe to cache data only and can never initiate
// transport, retry, focus/reconnect work, or expose fetch lifecycle renders.

function selectPresentTextract(
  data: TextractPageData | null,
): TextractPageData | undefined {
  return data ?? undefined;
}

/** Narrow live observer for one publicId/page payload. */
export function useTextractForPage(pageNumber: number): TextractPageData | undefined {
  const publicId = useSessionStore((state) => state.publicId);
  const { data } = useQuery({
    ...textractPageQueryOptions(publicId, pageNumber),
    enabled: false,
    select: selectPresentTextract,
    notifyOnChangeProps: ["data"],
  });
  return data;
}

const EMPTY_TEXTRACT_MAP = Object.freeze({}) as Readonly<Record<number, TextractPageData>>;

function normalizeRequestedPages(requested: readonly number[]): string {
  return [...new Set(requested.filter((pageNumber) => Number.isFinite(pageNumber)))]
    .sort((a, b) => a - b)
    .join(",");
}

function sameTextractMap(
  left: Readonly<Record<number, TextractPageData>>,
  right: Readonly<Record<number, TextractPageData>>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (left[Number(key)] !== right[Number(key)]) return false;
  }
  return true;
}

interface PassiveSnapshot {
  publicId: string;
  requestedSignature: string;
  value: Readonly<Record<number, TextractPageData>>;
}

/**
 * PageSidebar-only bounded multi-page exception. It observes one primitive coordinator stream, scans
 * at most the retained prefix, creates zero page Query observers, and performs zero fetches. A cached
 * snapshot preserves identity when another retained page or a status-only event is irrelevant.
 */
export function useCachedTextractForPages(
  requestedPageNumbers: readonly number[],
): Readonly<Record<number, TextractPageData>> {
  const publicId = useSessionStore((state) => state.publicId);
  const qc = useQueryClient();
  const requestedSignature = normalizeRequestedPages(requestedPageNumbers);
  const requestedPages = useMemo(
    () =>
      new Set<number>(
        requestedSignature === ""
          ? []
          : requestedSignature.split(",").map((pageNumber) => Number(pageNumber)),
      ),
    [requestedSignature],
  );
  const snapshotRef = useRef<PassiveSnapshot>({
    publicId: "",
    requestedSignature: "",
    value: EMPTY_TEXTRACT_MAP,
  });

  const subscribe = useCallback(
    (listener: () => void) => subscribeTextractProject(qc, publicId, listener),
    [qc, publicId],
  );

  const getSnapshot = useCallback(() => {
    const next = getCachedTextractForPages(qc, publicId, requestedPages);
    const previous = snapshotRef.current;
    if (
      previous.publicId === publicId &&
      previous.requestedSignature === requestedSignature &&
      sameTextractMap(previous.value, next)
    ) {
      return previous.value;
    }

    const value = Object.keys(next).length === 0 ? EMPTY_TEXTRACT_MAP : next;
    snapshotRef.current = { publicId, requestedSignature, value };
    return value;
  }, [publicId, qc, requestedPages, requestedSignature]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
