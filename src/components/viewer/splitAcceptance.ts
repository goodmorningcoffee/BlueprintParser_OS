"use client";

import type { QueryClient } from "@tanstack/react-query";

import {
  type CommitAnnotationSplitResult,
  type CommitAnnotationSplitTarget,
} from "@/queries/annotationSplit";
import { readAnnotations } from "@/queries/useAnnotations";
import { readTakeoffItems } from "@/queries/useTakeoff";
import { canPersist } from "@/lib/client-persist";
import {
  isNormalizedPoint,
  parseSplittableAreaData,
  SPLIT_ANNOTATION_ERROR_DURATION_MS,
  SPLIT_HOLED_TARGET_MESSAGE,
  SPLIT_PERSISTED_NOT_ADOPTED_MESSAGE,
  SPLIT_STALE_PREVIEW_MESSAGE,
  SPLIT_UNSAVED_SOURCE_MESSAGE,
  SPLIT_UNSUPPORTED_AREA_DATA_MESSAGE,
  type SplitAnnotationRequest,
} from "@/lib/annotation-split-contract";
import type { ProjectLifecycleSnapshot } from "@/lib/project-lifecycle";
import { computeRealArea } from "@/lib/areaCalc";
import { useSessionStore } from "@/stores/sessionStore";
import { useToolStore, type ToolStoreData } from "@/stores/toolStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { AREA_UNIT_MAP } from "@/types";
import type {
  AreaUnitSq,
  ClientAnnotation,
  ScaleCalibrationData,
} from "@/types";

type SplitPreview = NonNullable<ToolStoreData["splitPreview"]>;

export interface SplitAcceptanceOptions {
  queryClient: QueryClient;
  publicId: string;
  isDemo: boolean;
  pageNumber: number;
  lifecycle: ProjectLifecycleSnapshot | null;
  calibration: ScaleCalibrationData | undefined;
  width: number;
  height: number;
  canAdoptProjectLifecycle: () => boolean;
  publishError: (message: string, delay?: number) => void;
  addAnnotation: (annotation: ClientAnnotation) => void;
  updateAnnotation: (id: number, updates: Partial<ClientAnnotation>) => void;
}

export interface AdmittedAnnotationSplit {
  target: CommitAnnotationSplitTarget;
  request: SplitAnnotationRequest;
  settle: (result: CommitAnnotationSplitResult) => void;
  reject: (error: unknown) => void;
}

function pointSequencesMatch(
  left: readonly { x: number; y: number }[],
  right: readonly { x: number; y: number }[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (point, index) =>
        point.x === right[index].x && point.y === right[index].y,
    )
  );
}

function isUsableHalf(vertices: readonly { x: number; y: number }[]): boolean {
  return vertices.length >= 3 && vertices.every(isNormalizedPoint);
}

/**
 * Admit the exact live Split draft and return the sole durable command terminal. Demo/local work
 * settles synchronously and returns null. This leaf owns no observer, hook, or transport URL.
 */
export function admitAnnotationSplit(
  options: SplitAcceptanceOptions,
): AdmittedAnnotationSplit | null {
  const {
    queryClient,
    publicId,
    isDemo,
    pageNumber,
    lifecycle,
    calibration,
    width,
    height,
    canAdoptProjectLifecycle,
    publishError,
    addAnnotation,
    updateAnnotation,
  } = options;
  if (!canAdoptProjectLifecycle()) return null;

  const admittedTool = useToolStore.getState();
  const activation = admittedTool.activeTool;
  const readyPreview = admittedTool.splitPreview;
  const admittedLineA = admittedTool.splitLineA;
  const admittedLineB = admittedTool.splitLineB;
  if (
    activation?.kind !== "split" ||
    !readyPreview ||
    readyPreview.commitPending === true
  ) {
    return null;
  }

  const ownsRenderedProjectPage = () => {
    const session = useSessionStore.getState();
    return (
      canAdoptProjectLifecycle() &&
      session.publicId === publicId &&
      session.isDemo === isDemo &&
      useViewerCoreStore.getState().pageNumber === pageNumber
    );
  };
  const cacheHasExactSource = (source: ClientAnnotation) =>
    readAnnotations(queryClient, publicId).some(
      (row) =>
        row === source && row.id === source.id && row.pageNumber === pageNumber,
    );
  const clearExactReadyUi = (): boolean => {
    let cleared = false;
    useToolStore.setState((state) => {
      if (
        state.activeTool !== activation ||
        state.splitPreview !== readyPreview ||
        state.splitLineA !== admittedLineA ||
        state.splitLineB !== admittedLineB ||
        !ownsRenderedProjectPage()
      )
        return state;
      cleared = true;
      return { splitPreview: null, splitLineA: null, splitLineB: null };
    });
    return cleared;
  };

  const currentAnnotations = readAnnotations(queryClient, publicId);
  const currentItems = readTakeoffItems(queryClient, publicId);
  const target = currentAnnotations.find(
    (annotation) =>
      annotation.id === readyPreview.targetAnnotationId &&
      annotation.pageNumber === pageNumber,
  );
  if (!target || target.source !== "takeoff") {
    clearExactReadyUi();
    return null;
  }

  const parsedTarget = parseSplittableAreaData(target.data);
  if (!parsedTarget.ok) {
    if (parsedTarget.reason === "nonempty-holes") {
      publishError(
        SPLIT_HOLED_TARGET_MESSAGE,
        SPLIT_ANNOTATION_ERROR_DURATION_MS,
      );
    } else if (
      parsedTarget.reason === "unsupported-key" ||
      parsedTarget.reason === "invalid-extensions" ||
      parsedTarget.reason === "invalid-holes"
    ) {
      publishError(
        SPLIT_UNSUPPORTED_AREA_DATA_MESSAGE,
        SPLIT_ANNOTATION_ERROR_DURATION_MS,
      );
    } else {
      clearExactReadyUi();
    }
    return null;
  }

  const targetData = parsedTarget.data;
  const parentItem = currentItems.find(
    (item) => item.id === targetData.takeoffItemId,
  );
  if (!parentItem || parentItem.shape !== "polygon") {
    clearExactReadyUi();
    return null;
  }
  if (!pointSequencesMatch(targetData.vertices, readyPreview.original)) {
    publishError(
      SPLIT_STALE_PREVIEW_MESSAGE,
      SPLIT_ANNOTATION_ERROR_DURATION_MS,
    );
    return null;
  }
  if (
    admittedLineA !== readyPreview.lineA ||
    admittedLineB !== readyPreview.lineB ||
    !isNormalizedPoint(admittedLineA) ||
    !isNormalizedPoint(admittedLineB) ||
    (admittedLineA.x === admittedLineB.x &&
      admittedLineA.y === admittedLineB.y) ||
    !isUsableHalf(readyPreview.left) ||
    !isUsableHalf(readyPreview.right)
  ) {
    clearExactReadyUi();
    return null;
  }

  const computeData = (vertices: { x: number; y: number }[]) => {
    const xs = vertices.map(({ x }) => x);
    const ys = vertices.map(({ y }) => y);
    const bbox: [number, number, number, number] = [
      Math.min(...xs),
      Math.min(...ys),
      Math.max(...xs),
      Math.max(...ys),
    ];
    let areaSqUnits = 0;
    let unit: AreaUnitSq = "SF";
    if (calibration) {
      areaSqUnits = computeRealArea(vertices, width, height, calibration);
      unit = AREA_UNIT_MAP[calibration.unit] || "SF";
    }
    return {
      bbox,
      data: {
        type: "area-polygon" as const,
        takeoffItemId: parentItem.id,
        color: parentItem.color,
        vertices: [...vertices],
        areaSqUnits,
        unit,
        ...(targetData.csiCodes === undefined
          ? {}
          : { csiCodes: [...targetData.csiCodes] }),
        ...(targetData.keywords === undefined
          ? {}
          : { keywords: [...targetData.keywords] }),
      },
    };
  };
  const leftResult = computeData(readyPreview.left);
  const rightResult = computeData(readyPreview.right);

  if (!canPersist(publicId, isDemo)) {
    const tempAnnId = -Date.now() - 1;
    addAnnotation({
      id: tempAnnId,
      pageNumber,
      name: parentItem.name,
      bbox: rightResult.bbox,
      note: null,
      source: "takeoff",
      data: rightResult.data,
    });
    if (!ownsRenderedProjectPage()) return null;
    updateAnnotation(target.id, {
      bbox: leftResult.bbox,
      data: leftResult.data,
    });
    if (ownsRenderedProjectPage()) clearExactReadyUi();
    return null;
  }

  if (target.id <= 0) {
    publishError(
      SPLIT_UNSAVED_SOURCE_MESSAGE,
      SPLIT_ANNOTATION_ERROR_DURATION_MS,
    );
    return null;
  }

  let pendingPreview: SplitPreview | null = null;
  useToolStore.setState((state) => {
    if (
      state.activeTool !== activation ||
      state.splitPreview !== readyPreview ||
      state.splitLineA !== admittedLineA ||
      state.splitLineB !== admittedLineB ||
      !ownsRenderedProjectPage() ||
      !cacheHasExactSource(target)
    )
      return state;
    pendingPreview = { ...readyPreview, commitPending: true };
    return { splitPreview: pendingPreview };
  });
  if (!pendingPreview) return null;

  const ownsPendingUi = () => {
    const state = useToolStore.getState();
    return (
      ownsRenderedProjectPage() &&
      state.activeTool === activation &&
      state.splitPreview === pendingPreview &&
      state.splitLineA === admittedLineA &&
      state.splitLineB === admittedLineB
    );
  };
  const clearPendingWithMessage = (message: string): void => {
    let cleared = false;
    useToolStore.setState((state) => {
      if (
        state.activeTool !== activation ||
        state.splitPreview !== pendingPreview ||
        state.splitLineA !== admittedLineA ||
        state.splitLineB !== admittedLineB ||
        !ownsRenderedProjectPage()
      )
        return state;
      cleared = true;
      return { splitPreview: null, splitLineA: null, splitLineB: null };
    });
    const settled = useToolStore.getState();
    if (
      cleared &&
      ownsRenderedProjectPage() &&
      settled.activeTool === activation &&
      settled.splitPreview === null &&
      settled.splitLineA === null &&
      settled.splitLineB === null
    )
      publishError(message, SPLIT_ANNOTATION_ERROR_DURATION_MS);
  };
  const restoreReadyAfterRejection = (message: string): void => {
    if (!cacheHasExactSource(target)) {
      clearPendingWithMessage(SPLIT_STALE_PREVIEW_MESSAGE);
      return;
    }
    let restored = false;
    useToolStore.setState((state) => {
      if (
        state.activeTool !== activation ||
        state.splitPreview !== pendingPreview ||
        state.splitLineA !== admittedLineA ||
        state.splitLineB !== admittedLineB ||
        !ownsRenderedProjectPage() ||
        !cacheHasExactSource(target)
      )
        return state;
      restored = true;
      return { splitPreview: readyPreview };
    });
    const settled = useToolStore.getState();
    if (
      restored &&
      ownsRenderedProjectPage() &&
      cacheHasExactSource(target) &&
      settled.activeTool === activation &&
      settled.splitPreview === readyPreview &&
      settled.splitLineA === admittedLineA &&
      settled.splitLineB === admittedLineB
    )
      publishError(message, SPLIT_ANNOTATION_ERROR_DURATION_MS);
  };

  if (!ownsPendingUi() || !cacheHasExactSource(target)) {
    if (ownsPendingUi()) clearPendingWithMessage(SPLIT_STALE_PREVIEW_MESSAGE);
    return null;
  }

  const request: SplitAnnotationRequest = {
    sourceAnnotationId: target.id,
    expectedSource: {
      pageNumber: target.pageNumber,
      bbox: target.bbox,
      data: target.data as Record<string, unknown>,
    },
    lineA: admittedLineA,
    lineB: admittedLineB,
    measurements: {
      leftAreaSqUnits: leftResult.data.areaSqUnits,
      rightAreaSqUnits: rightResult.data.areaSqUnits,
      unit: leftResult.data.unit,
    },
  };

  return {
    target: { publicId, isDemo, pageNumber, lifecycle, source: target },
    request,
    settle(result) {
      if (result.status === "adopted") {
        const rows = readAnnotations(queryClient, publicId);
        const ownsCanonicalRows =
          rows.some((row) => row === result.left) &&
          rows.some((row) => row === result.right);
        if (!ownsCanonicalRows) {
          clearPendingWithMessage(SPLIT_PERSISTED_NOT_ADOPTED_MESSAGE);
          return;
        }
        useToolStore.setState((state) => {
          if (
            state.activeTool !== activation ||
            state.splitPreview !== pendingPreview ||
            state.splitLineA !== admittedLineA ||
            state.splitLineB !== admittedLineB ||
            !ownsRenderedProjectPage()
          )
            return state;
          return { splitPreview: null, splitLineA: null, splitLineB: null };
        });
        return;
      }
      if (result.status === "persisted-not-adopted") {
        if (result.reason !== "lifecycle-retired") {
          clearPendingWithMessage(SPLIT_PERSISTED_NOT_ADOPTED_MESSAGE);
        }
        return;
      }
      if (result.reason === "lifecycle-retired") return;
      if (result.reason === "source-not-current") {
        clearPendingWithMessage(SPLIT_STALE_PREVIEW_MESSAGE);
      } else if (result.reason === "nonpositive-source") {
        restoreReadyAfterRejection(SPLIT_UNSAVED_SOURCE_MESSAGE);
      } else {
        restoreReadyAfterRejection("Failed to save split");
      }
    },
    reject(error) {
      restoreReadyAfterRejection(
        error instanceof Error
          ? `Failed to save split: ${error.message}`
          : "Failed to save split",
      );
    },
  };
}
