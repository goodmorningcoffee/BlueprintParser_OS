"use client";

import { useCallback, useLayoutEffect, useRef } from "react";
import type { QueryClient } from "@tanstack/react-query";

import { canPersist, persistFetch } from "@/lib/client-persist";
import {
  publishAnnotationDrag,
  readAnnotations,
  rollbackAnnotationDrag,
  type AnnotationDragPayload,
} from "@/queries/useAnnotations";
import { useSessionStore } from "@/stores/sessionStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import type { ClientAnnotation } from "@/types";

export type AnnotationDragOperation =
  | Readonly<{ kind: "vertex"; vertexIndex: number }>
  | Readonly<{
      kind: "bbox";
      resizeCorner: string | null;
      dragOffset: Readonly<{ x: number; y: number }>;
    }>;

export type AnnotationDragSession = {
  generation: number;
  publicId: string;
  pageNumber: number;
  annotationId: number;
  isDemo: boolean;
  canAdopt: () => boolean;
  reportError: (message: string) => void;
  pageEpoch: number;
  origin: ClientAnnotation;
  operation: AnnotationDragOperation;
  lastPublishedRow: ClientAnnotation | null;
};

type PendingAnnotationDrag = {
  generation: number;
  update: AnnotationDragPayload;
};

type VertexHandle = { annId: number; idx: number };

type Options = {
  queryClient: QueryClient;
  publicId: string;
  pageNumber: number;
  canAdoptProjectLifecycle: () => boolean;
  publishTransientError: (message: string) => void;
  setDragging: (dragging: boolean) => void;
  setResizeCorner: (corner: string | null) => void;
  setDraggingVertex: (handle: VertexHandle | null) => void;
  setSelectedId: (id: number | null) => void;
};

function isLive(session: AnnotationDragSession, requireSourcePage = true): boolean {
  const liveSession = useSessionStore.getState();
  return session.canAdopt() &&
    liveSession.publicId === session.publicId &&
    liveSession.isDemo === session.isDemo &&
    (!requireSourcePage || useViewerCoreStore.getState().pageNumber === session.pageNumber);
}

/**
 * Per-overlay exact annotation-drag journal.
 *
 * Refs own the origin, latest exact wire body, operation physics, generation, and dedicated frame
 * slot. React state remains a rendering concern only; it cannot lend stale drag semantics to a
 * same-id lifecycle successor.
 */
export function useAnnotationDragMachine(options: Options) {
  const {
    queryClient,
    publicId,
    pageNumber,
    canAdoptProjectLifecycle,
    publishTransientError,
    setDragging,
    setResizeCorner,
    setDraggingVertex,
    setSelectedId,
  } = options;
  const dragRafRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const pageEpochRef = useRef(0);
  const activeRef = useRef<AnnotationDragSession | null>(null);
  const pendingRef = useRef<PendingAnnotationDrag | null>(null);
  // Retained as explicit lifecycle tripwires from the pre-machine implementation.
  const dragBboxRef = useRef<ClientAnnotation["bbox"] | null>(null);
  const draggingVertexRef = useRef<VertexHandle | null>(null);

  const detach = useCallback((expected: AnnotationDragSession) => {
    if (activeRef.current !== expected) return null;
    const pending = pendingRef.current;

    // Invalidate every callback predicate before cancellation. A dequeued callback—or a hostile
    // synchronous cancelAnimationFrame shim—therefore observes no ownership.
    generationRef.current += 1;
    activeRef.current = null;
    pendingRef.current = null;
    dragBboxRef.current = null;
    draggingVertexRef.current = null;
    setDragging(false);
    setResizeCorner(null);
    setDraggingVertex(null);
    const frame = dragRafRef.current;
    dragRafRef.current = null;
    if (frame !== null) cancelAnimationFrame(frame);
    return {
      session: expected,
      update: pending?.generation === expected.generation ? pending.update : null,
    };
  }, [setDragging, setDraggingVertex, setResizeCorner]);

  const abandonForPageBoundary = useCallback((session: AnnotationDragSession): boolean => {
    if (
      pageEpochRef.current === session.pageEpoch &&
      useViewerCoreStore.getState().pageNumber === session.pageNumber
    ) return false;
    if (isLive(session, false)) {
      rollbackAnnotationDrag(
        queryClient,
        session.publicId,
        session.pageNumber,
        session.annotationId,
        session.lastPublishedRow,
        session.origin,
        session.operation.kind,
      );
    }
    return true;
  }, [queryClient]);

  const begin = useCallback((
    annotation: ClientAnnotation,
    operation: AnnotationDragOperation,
  ): boolean => {
    const renderedAuthority = canAdoptProjectLifecycle;
    const sessionAtStart = useSessionStore.getState();
    const pageEpochAtStart = pageEpochRef.current;
    if (
      !mountedRef.current ||
      !renderedAuthority() ||
      sessionAtStart.publicId !== publicId ||
      useViewerCoreStore.getState().pageNumber !== pageNumber
    ) return false;
    // A stale render must never make its pre-cache geometry the rollback origin.
    const liveOrigin = readAnnotations(queryClient, publicId).find(
      (row) => row.id === annotation.id && row.pageNumber === pageNumber,
    );
    if (liveOrigin !== annotation) return false;

    const previous = activeRef.current;
    const expectedEmptyGeneration = generationRef.current + 1;
    let retired: ReturnType<typeof detach> = null;
    if (previous) {
      retired = detach(previous);
    } else {
      generationRef.current = expectedEmptyGeneration;
      pendingRef.current = null;
      dragBboxRef.current = null;
      draggingVertexRef.current = null;
      setDragging(false);
      setResizeCorner(null);
      setDraggingVertex(null);
      const previousFrame = dragRafRef.current;
      dragRafRef.current = null;
      if (previousFrame !== null) cancelAnimationFrame(previousFrame);
    }
    if (retired) abandonForPageBoundary(retired.session);

    // Cancellation is an external boundary in tests and browser integrations; revalidate after it.
    if (
      !mountedRef.current ||
      activeRef.current !== null ||
      generationRef.current !== expectedEmptyGeneration ||
      pageEpochRef.current !== pageEpochAtStart ||
      !renderedAuthority() ||
      useSessionStore.getState().publicId !== publicId ||
      useSessionStore.getState().isDemo !== sessionAtStart.isDemo ||
      useViewerCoreStore.getState().pageNumber !== pageNumber ||
      readAnnotations(queryClient, publicId).find(
        (row) => row.id === annotation.id && row.pageNumber === pageNumber,
      ) !== annotation
    ) return false;

    const generation = ++generationRef.current;
    const update: AnnotationDragPayload = operation.kind === "vertex"
      ? { kind: "vertex", payload: { bbox: annotation.bbox, data: annotation.data } }
      : { kind: "bbox", payload: { bbox: annotation.bbox } };
    const session: AnnotationDragSession = {
      generation,
      publicId,
      pageNumber,
      annotationId: annotation.id,
      isDemo: sessionAtStart.isDemo,
      canAdopt: renderedAuthority,
      reportError: publishTransientError,
      pageEpoch: pageEpochRef.current,
      origin: annotation,
      operation,
      lastPublishedRow: null,
    };
    activeRef.current = session;
    pendingRef.current = { generation, update };
    dragBboxRef.current = annotation.bbox;
    draggingVertexRef.current = operation.kind === "vertex"
      ? { annId: annotation.id, idx: operation.vertexIndex }
      : null;
    return true;
  }, [abandonForPageBoundary, canAdoptProjectLifecycle, detach, pageNumber, publicId,
    publishTransientError, queryClient, setDragging, setDraggingVertex, setResizeCorner]);

  const schedule = useCallback((
    session: AnnotationDragSession,
    update: AnnotationDragPayload,
  ): void => {
    if (activeRef.current !== session || update.kind !== session.operation.kind) return;
    pendingRef.current = { generation: session.generation, update };
    dragBboxRef.current = update.payload.bbox;

    const previousFrame = dragRafRef.current;
    dragRafRef.current = null;
    if (previousFrame !== null) cancelAnimationFrame(previousFrame);

    let frame = 0;
    frame = requestAnimationFrame(() => {
      if (
        dragRafRef.current !== frame ||
        activeRef.current !== session ||
        generationRef.current !== session.generation
      ) return;
      dragRafRef.current = null;
      if (!isLive(session)) return;
      const latest = pendingRef.current;
      if (!latest || latest.generation !== session.generation) return;

      const published = publishAnnotationDrag(
        queryClient,
        session.publicId,
        session.pageNumber,
        session.annotationId,
        latest.update,
      );
      if (!published) return;
      if (pageEpochRef.current !== session.pageEpoch) {
        const liveSession = useSessionStore.getState();
        if (
          session.canAdopt() &&
          liveSession.publicId === session.publicId &&
          liveSession.isDemo === session.isDemo
        ) {
          rollbackAnnotationDrag(
            queryClient,
            session.publicId,
            session.pageNumber,
            session.annotationId,
            published,
            session.origin,
            session.operation.kind,
          );
        }
        return;
      }
      const current = readAnnotations(queryClient, session.publicId).find(
        (row) => row.id === session.annotationId && row.pageNumber === session.pageNumber,
      );
      if (
        activeRef.current === session &&
        generationRef.current === session.generation &&
        isLive(session) &&
        current === published
      ) {
        session.lastPublishedRow = published;
      }
    });
    if (activeRef.current === session && generationRef.current === session.generation) {
      dragRafRef.current = frame;
    } else {
      cancelAnimationFrame(frame);
    }
  }, [queryClient]);

  const finish = useCallback((expected: AnnotationDragSession, persist: boolean): boolean => {
    const terminal = detach(expected);
    if (!terminal) return false;
    const { session, update } = terminal;
    if (abandonForPageBoundary(session)) return true;
    if (!update || !isLive(session)) return true;

    const published = publishAnnotationDrag(
      queryClient,
      session.publicId,
      session.pageNumber,
      session.annotationId,
      update,
    );
    if (!published) return true;

    if (pageEpochRef.current !== session.pageEpoch) {
      const liveSession = useSessionStore.getState();
      if (
        session.canAdopt() &&
        liveSession.publicId === session.publicId &&
        liveSession.isDemo === session.isDemo
      ) {
        rollbackAnnotationDrag(
          queryClient,
          session.publicId,
          session.pageNumber,
          session.annotationId,
          published,
          session.origin,
          session.operation.kind,
        );
      }
      return true;
    }
    if (!persist) return true;

    // setQueryData dispatch is synchronously reentrant. Persist only the still-current exact row.
    const current = readAnnotations(queryClient, session.publicId).find(
      (row) => row.id === session.annotationId && row.pageNumber === session.pageNumber,
    );
    if (
      !isLive(session) ||
      current !== published ||
      !canPersist(session.publicId, session.isDemo) ||
      session.annotationId <= 0
    ) return true;

    (async () => {
      try {
        await persistFetch(`/api/annotations/${session.annotationId}`, update.payload, "PUT");
      } catch (error) {
        session.reportError(
          session.operation.kind === "vertex"
            ? (error instanceof Error
                ? `Failed to save edit: ${error.message}`
                : "Failed to save edit")
            : (error instanceof Error
                ? `Failed to save move: ${error.message}`
                : "Failed to save move"),
        );
      }
    })();
    return true;
  }, [abandonForPageBoundary, detach, queryClient]);

  // Synchronous subscription closes the batched source→destination→source page ABA hole.
  useLayoutEffect(() => useViewerCoreStore.subscribe((next, previous) => {
    if (!mountedRef.current || next.pageNumber === previous.pageNumber) return;
    pageEpochRef.current += 1;
    setSelectedId(null);
    const active = activeRef.current;
    const terminal = active ? detach(active) : null;
    if (terminal) abandonForPageBoundary(terminal.session);
  }), [abandonForPageBoundary, detach, setSelectedId]);

  const lifecycleRef = useRef(canAdoptProjectLifecycle);
  // Clear A during the replacement commit, before successor B's passive focus transfer can run.
  useLayoutEffect(() => {
    const previous = lifecycleRef.current;
    lifecycleRef.current = canAdoptProjectLifecycle;
    if (previous === canAdoptProjectLifecycle) return;
    const active = activeRef.current;
    if (active?.canAdopt === canAdoptProjectLifecycle) return;
    setSelectedId(null);
    if (!active) return;
    detach(active);
  }, [canAdoptProjectLifecycle, detach, setSelectedId]);

  // Ref-only layout cleanup: no post-removal frame window, obsolete rollback, or React state write.
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      activeRef.current = null;
      pendingRef.current = null;
      dragBboxRef.current = null;
      draggingVertexRef.current = null;
      const frame = dragRafRef.current;
      dragRafRef.current = null;
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);

  const readActive = useCallback(() => {
    const active = activeRef.current;
    return active && isLive(active) ? active : null;
  }, []);
  return { begin, finish, readActive, schedule } as const;
}
