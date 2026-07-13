"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { canPersist, persistFetch } from "@/lib/client-persist";
import { invalidateToolTailAuthority } from "@/lib/parse-tool-authority";
import { queryKeys } from "@/queries/queryKeys";
import { useSessionStore } from "@/stores/sessionStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { useToolStore } from "@/stores/toolStore";
import type { ClientAnnotation, ClientTakeoffItem } from "@/types";

// [refactor jul11 P2.2⑥] ANNOTATIONS cache facade. It landed production-dead in C2, then C3
// moved the flat, chunk-windowed annotations collection out of viewerStore and wired consumers.
// Keeping extraction and wiring in separate commits gave the sacred viewer path a clean revert
// boundary and made C2's zero-behavior claim mechanically grep-able.
// P2_DESIGN/ANNOTATIONS_IMPL/SPEC.md is the authoritative contract.
//
// EXTEND HERE:
//   • subscribed component read/write       -> useAnnotations()
//   • handler/library live synchronous read -> readAnnotations(qc, publicId)
//   • live functional whole-array transform -> writeAnns(qc, publicId, updater)
//   • optimistic single-create              -> persistCreate(draft, options)
//
// Do not reach back into the deleted viewerStore.annotations field. `setAnnotations` is deliberately a
// VALUE replacement, while CRUD/writeAnns are functional: several existing post-await handlers
// replace render-captured arrays and therefore have a frozen lost-update hazard (ANNOTATIONS-W1).
// Making every write functional during the backing-store move would be a visible behavior change.
//
// The three cross-backend operations below (bucket fill and takeoff undo/redo) write BOTH this
// cache and zustand UI/tool state. TanStack notifyManager cannot make those backends atomic; their
// sanctioned <=1-frame tear is documented in SPEC §4. Cache is written first, then zustand, with
// no await inserted between. Existing persistence paths keep optimistic rows on failure by design.

export type AnnotationUpdater = (rows: ClientAnnotation[]) => ClientAnnotation[];
/**
 * The POST shape deliberately keeps server-defaulted fields optional.
 *
 * `persistCreate` normalizes those omissions only for the optimistic client row. This lets callers
 * converge on one create seam without quietly changing their existing wire payloads (for example,
 * markup historically omits `source`, while takeoff creates omit `note`).
 */
export type NewAnnotationDraft = Pick<ClientAnnotation, "pageNumber" | "name" | "bbox"> &
  Partial<Pick<ClientAnnotation, "note" | "source" | "data">>;

export interface PersistCreateOptions {
  /** Context for the default console reporter. Existing UI sites pass their own banner callback. */
  errorLabel?: string;
  onError?: (error: Error) => void;
  /** Future-only opt-in. Existing annotation writers keep optimistic rows on failure. */
  rollbackOnError?: boolean;
}

/** Public facade surface. Keeping this explicit makes new feature call sites discoverable. */
export interface UseAnnotationsResult {
  annotations: ClientAnnotation[];
  addAnnotation: (annotation: ClientAnnotation) => void;
  removeAnnotation: (id: number) => void;
  updateAnnotation: (id: number, updates: Partial<ClientAnnotation>) => void;
  /** Captured whole-array replacement; intentionally not an AnnotationUpdater overload. */
  setAnnotations: (annotations: ClientAnnotation[]) => void;
  commitBucketFill: (item: ClientTakeoffItem) => void;
  persistCreate: (
    draft: NewAnnotationDraft,
    options?: PersistCreateOptions,
  ) => Promise<number>;
}

// Module-scope and frozen: an absent entry must not hand the canvas a fresh `[]` on each render.
// Cast to the legacy mutable surface because every legitimate change replaces rather than mutates.
const EMPTY_ANNOTATIONS = Object.freeze([]) as unknown as ClientAnnotation[];

/**
 * Synchronous handler-time bridge, equivalent to the old `getState().annotations` read.
 * Cache writes are immediately visible here even though React observer notification is deferred.
 */
export function readAnnotations(qc: QueryClient, publicId: string): ClientAnnotation[] {
  return qc.getQueryData<ClientAnnotation[]>(queryKeys.annotations.all(publicId)) ?? EMPTY_ANNOTATIONS;
}

/**
 * The sanctioned live functional whole-array writer for non-React handlers and hoisted actions.
 * An absent cache entry behaves like the old store's always-present empty array.
 */
export function writeAnns(
  qc: QueryClient,
  publicId: string,
  updater: AnnotationUpdater,
): void {
  qc.setQueryData<ClientAnnotation[]>(
    queryKeys.annotations.all(publicId),
    (old = EMPTY_ANNOTATIONS) => updater(old),
  );
}

/**
 * [refactor jul11 P2.2⑥] Shared dashboard/demo bootstrap adapter.
 *
 * Both loaders must seed unconditionally—including an omitted/null collection becoming `[]`—so
 * reopening the same project after a failed/partial bootstrap cannot reveal a stale cached window.
 * `publicId` is explicit and server-canonical (`data.id` at both callers), never read from mutable
 * route/store state. The live navigation loader has a separate same-block RACE-2 write because it
 * must pair this domain with its pages-window zustand publication.
 */
export function seedAnnotationsFromBootstrap(
  qc: QueryClient,
  publicId: string,
  chunk: { annotations?: ClientAnnotation[] | null } | null | undefined,
): void {
  qc.setQueryData<ClientAnnotation[]>(
    queryKeys.annotations.all(publicId),
    chunk?.annotations ?? [],
  );
}

function reportPersistCreateError(error: Error, label?: string): void {
  // [refactor jul11 P2.2⑥] There is no generic global annotation banner. C4 adopters pass their
  // existing per-tool UI callback; the default stays visible to developers/future callers rather
  // than swallowing a failed save. No timer is created here (important for unmount/test lifetime).
  console.error(`[ANNOTATIONS] ${label ?? "Annotation drawn locally but NOT saved"}:`, error);
}

/** Hoisted store action: remove the last active-item annotation on the current page. */
export function takeoffUndo(qc: QueryClient): void {
  invalidateToolTailAuthority();
  // Identity and tool/page state had one Zustand owner before P2.3. Capture all three new owners in
  // one synchronous block so the cache key and tool/page predicate still describe one key event.
  const sessionSnapshot = useSessionStore.getState();
  const coreSnapshot = useViewerCoreStore.getState();
  const toolSnapshot = useToolStore.getState();
  if (toolSnapshot.activeTool?.kind !== "takeoffPlacement") return;
  const activeId = toolSnapshot.activeTakeoffItemId;
  if (!activeId) return;

  let removed: ClientAnnotation | undefined;
  writeAnns(qc, sessionSnapshot.publicId, (rows) => {
    const reverseIndex = [...rows].reverse().findIndex(
      (annotation) =>
        annotation.source === "takeoff" &&
        annotation.data?.takeoffItemId === activeId &&
        annotation.pageNumber === coreSnapshot.pageNumber,
    );
    if (reverseIndex === -1) return rows;

    const realIndex = rows.length - 1 - reverseIndex;
    removed = rows[realIndex];
    return rows.filter((_, index) => index !== realIndex);
  });

  // LOAD-BEARING guard: the old action cleared redo only inside its found-row branch. A null
  // active item or no matching annotation is a no-op on BOTH cache and stacks.
  if (!removed) return;
  const removedRow = removed;
  useToolStore.setState((state) => ({
    takeoffUndoStack: [...state.takeoffUndoStack, removedRow],
    takeoffRedoStack: [],
  }));
}

/** Hoisted store action: restore the current undo-stack top at the annotation-array tail. */
export function takeoffRedo(qc: QueryClient): void {
  invalidateToolTailAuthority();
  const sessionSnapshot = useSessionStore.getState();
  const toolSnapshot = useToolStore.getState();
  if (toolSnapshot.activeTool?.kind !== "takeoffPlacement") return;
  if (toolSnapshot.takeoffUndoStack.length === 0) return;

  // Deliberately no active-item guard: the old direct action could redo with activeId=null.
  const restored = toolSnapshot.takeoffUndoStack[toolSnapshot.takeoffUndoStack.length - 1];
  writeAnns(qc, sessionSnapshot.publicId, (rows) => [...rows, restored]);
  useToolStore.setState((state) => ({
    takeoffUndoStack: state.takeoffUndoStack.slice(0, -1),
    takeoffRedoStack: [...state.takeoffRedoStack, restored],
  }));
}

function useBucketFillCommit(qc: QueryClient): (item: ClientTakeoffItem) => void {
  return useCallback(
    (item: ClientTakeoffItem) => {
      // Invocation-time snapshots preserve the singleton store action's freshness. Capture all
      // owners adjacently, then use those values for cache key and request if navigation races.
      const sessionSnapshot = useSessionStore.getState();
      const coreSnapshot = useViewerCoreStore.getState();
      const toolSnapshot = useToolStore.getState();
      const pending = toolSnapshot.bucketFillPendingPolygon;
      if (!pending) return;

      // `holes` is intentionally conditional. The legacy interface's old "dropped" comment was
      // stale; executable behavior persists non-empty courtyard holes and C3 fixes it.
      const polygonData = {
        type: "area-polygon" as const,
        takeoffItemId: item.id,
        color: item.color,
        vertices: pending.vertices,
        ...(pending.holes && pending.holes.length > 0 ? { holes: pending.holes } : {}),
        areaSqUnits: pending.areaSqUnits,
        unit: pending.unit,
      };
      const tempId = -Date.now();
      const optimistic: ClientAnnotation = {
        id: tempId,
        pageNumber: coreSnapshot.pageNumber,
        name: item.name,
        bbox: pending.bbox,
        note: null,
        source: "takeoff",
        data: polygonData,
      };

      // [refactor jul11 P2.2⑥] Cache FIRST, then consume pending zustand state. Do not await or
      // reverse these lines: the post-migration dialog unmounts from the pending clear while cache
      // notification is deferred, and this ordering minimizes the sanctioned D8 visual tear.
      writeAnns(qc, sessionSnapshot.publicId, (rows) => [...rows, optimistic]);
      useToolStore.setState({ bucketFillPendingPolygon: null });

      // Preserve the original two-tier G6 gate byte-for-behavior: demo is local-only and silent;
      // non-demo with unresolved publicId keeps the local row but exposes a persistent error.
      if (sessionSnapshot.isDemo) return;
      if (!canPersist(sessionSnapshot.publicId, sessionSnapshot.isDemo)) {
        useToolStore.setState({
          bucketFillError:
            "Project not ready yet — bucket fill was NOT saved. Redraw once the viewer finishes loading.",
        });
        return;
      }

      void persistFetch("/api/annotations", {
        projectId: sessionSnapshot.publicId,
        pageNumber: coreSnapshot.pageNumber,
        name: item.name,
        bbox: pending.bbox,
        source: "takeoff",
        data: polygonData,
      })
        .then((saved) => {
          // The server may enrich the row (for example CSI data), but current writers reconcile
          // ID ONLY. Adopting the whole response here would be an unsanctioned behavior change.
          const savedId = (saved as { id?: number } | null)?.id;
          if (savedId) {
            writeAnns(qc, sessionSnapshot.publicId, (rows) =>
              rows.map((annotation) =>
                annotation.id === tempId ? { ...annotation, id: savedId } : annotation,
              ),
            );
          }
        })
        .catch((error: Error) => {
          // NO rollback by design: the user still sees locally drawn geometry and a clear warning.
          useToolStore.setState({
            bucketFillError: `Bucket fill drawn locally but NOT saved: ${error.message}`,
          });
        });
    },
    [qc],
  );
}

function usePersistCreate(
  qc: QueryClient,
  publicId: string,
  isDemo: boolean,
  addAnnotation: (annotation: ClientAnnotation) => void,
  updateAnnotation: (id: number, updates: Partial<ClientAnnotation>) => void,
  setAnnotations: (annotations: ClientAnnotation[]) => void,
): (draft: NewAnnotationDraft, options?: PersistCreateOptions) => Promise<number> {
  return useCallback(
    async (draft: NewAnnotationDraft, options?: PersistCreateOptions): Promise<number> => {
      // Snapshot BEFORE the optimistic add. The original SPEC pseudocode placed this below add,
      // making rollback inert by restoring a snapshot that already contained the temp row.
      const rollbackSnapshot = options?.rollbackOnError
        ? readAnnotations(qc, publicId)
        : null;
      const tempId = -Date.now();
      // [refactor jul11 P2.2⑥ C4] Normalize only the local row. The request below still spreads
      // the caller's exact draft, so optional fields that were historically omitted stay omitted.
      addAnnotation({
        id: tempId,
        pageNumber: draft.pageNumber,
        name: draft.name,
        bbox: draft.bbox,
        note: draft.note ?? null,
        source: draft.source ?? "user",
        data: draft.data ?? null,
      });

      // Optimistic local creation is always available, including demo/pre-bootstrap sessions.
      if (!canPersist(publicId, isDemo)) return tempId;

      try {
        const saved = (await persistFetch("/api/annotations", {
          projectId: publicId,
          ...draft,
        })) as { id?: number } | null;
        const savedId = saved?.id;
        if (savedId) {
          updateAnnotation(tempId, { id: savedId });
          return savedId;
        }
        // Match every existing reconcile site: null/missing/falsy IDs leave AND return the temp ID.
        return tempId;
      } catch (caught) {
        const error = caught instanceof Error ? caught : new Error(String(caught));
        // Explicit future capability only. Snapshot replacement can itself discard concurrent
        // rows, which is why no existing writer opts in during the behavior-faithful migration.
        if (rollbackSnapshot !== null) setAnnotations(rollbackSnapshot);
        (options?.onError ?? ((err: Error) => reportPersistCreateError(err, options?.errorLabel)))(
          error,
        );
        return tempId;
      }
    },
    [qc, publicId, isDemo, addAnnotation, updateAnnotation, setAnnotations],
  );
}

export function useAnnotations(): UseAnnotationsResult {
  const publicId = useSessionStore((state) => state.publicId);
  const isDemo = useSessionStore((state) => state.isDemo);
  const qc = useQueryClient();
  const key = queryKeys.annotations.all(publicId);

  // Destructure DATA ONLY. TanStack v5 tracked properties make this the render-notification
  // contract: status/fetch metadata here would add canvas renders that the old selector never had.
  const { data } = useQuery({
    queryKey: key,
    queryFn: (): ClientAnnotation[] => {
      throw new Error("annotations are chunk-seeded (no GET); queryFn must never run");
    },
    enabled: false,
    initialData: EMPTY_ANNOTATIONS,
    staleTime: Infinity,
    // ANNOTATIONS-W2: one windowed key has no recovery GET. Finite GC could erase demo/temp rows;
    // cross-project eviction belongs to the later project-switch orchestrator, not this migration.
    gcTime: Infinity,
    // structuralSharing remains the v5 default ON. Byte-identical chunk reseeds then preserve the
    // top-level reference and add zero AnnotationOverlay renders (the sacred §7 invariant).
  });

  const addAnnotation = useCallback(
    (annotation: ClientAnnotation): void => {
      qc.setQueryData<ClientAnnotation[]>(
        queryKeys.annotations.all(publicId),
        (old = EMPTY_ANNOTATIONS) => [...old, annotation],
      );
    },
    [qc, publicId],
  );
  const removeAnnotation = useCallback(
    (id: number): void => {
      qc.setQueryData<ClientAnnotation[]>(queryKeys.annotations.all(publicId), (old = EMPTY_ANNOTATIONS) =>
        old.filter((annotation) => annotation.id !== id),
      );
    },
    [qc, publicId],
  );
  const updateAnnotation = useCallback(
    (id: number, updates: Partial<ClientAnnotation>): void => {
      qc.setQueryData<ClientAnnotation[]>(
        queryKeys.annotations.all(publicId),
        (old = EMPTY_ANNOTATIONS) =>
          old.map((annotation) =>
            annotation.id === id ? { ...annotation, ...updates } : annotation,
          ),
      );
    },
    [qc, publicId],
  );
  const setAnnotations = useCallback(
    (annotations: ClientAnnotation[]) => {
      // VALUE replacement is load-bearing; see ANNOTATIONS-W1 in the file header and SPEC §3.3.
      qc.setQueryData<ClientAnnotation[]>(queryKeys.annotations.all(publicId), annotations);
    },
    [qc, publicId],
  );

  const commitBucketFill = useBucketFillCommit(qc);
  const persistCreate = usePersistCreate(
    qc,
    publicId,
    isDemo,
    addAnnotation,
    updateAnnotation,
    setAnnotations,
  );

  return {
    annotations: data ?? EMPTY_ANNOTATIONS,
    addAnnotation,
    removeAnnotation,
    updateAnnotation,
    setAnnotations,
    commitBucketFill,
    persistCreate,
  };
}
