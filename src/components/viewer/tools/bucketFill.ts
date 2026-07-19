// [refactor jul19 P3.2] BucketFill mousedown controller. This is a mechanical lift of the
// accepted-parent AnnotationOverlay branch: barrier drawing, captured collision inputs, exact
// global/lane ownership, worker-first transport, server fallback, and terminal publications remain
// byte-for-semantics. Preview preparation, assignment, keyboard, rendering, and cleanup remain on
// their shared ACCEPT-PARTIAL surfaces.
import { clientBucketFill, findPageCanvas } from "@/lib/bucket-fill-client";
import { apiErrorMessage } from "@/lib/client-persist";
import {
  claimLatestToolOperation,
  claimToolTailAuthority,
  consumeToolTailAuthority,
  invalidateLatestToolOperation,
  invalidateToolTailAuthority,
  ownsLatestToolOperation,
  ownsToolTailAuthority,
  registerToolTailCancellation,
  releaseToolTailCancellation,
} from "@/lib/parse-tool-authority";
import { readTextractForPage } from "@/queries/textractCache";
import { readAnnotations } from "@/queries/useAnnotations";
import { useToolStore } from "@/stores/toolStore";

import type { ToolController } from "./types";

export const bucketFillController: ToolController = Object.freeze({
  kind: "bucketFill",
  wantsEvents: (state) => state.activeTool?.kind === "bucketFill",
  matches: (press) => press.toolAtDown.activeTool?.kind === "bucketFill",
  onMouseDown(event, context) {
    const { toolAtDown: bfState, position } = context.press;
    event.stopPropagation();
    const normX = position.x / context.page.width;
    const normY = position.y / context.page.height;

    if (bfState.bucketFillBarrierMode) {
      invalidateToolTailAuthority();
      invalidateLatestToolOperation("bucketFill");
      const pending = bfState.barrierPendingPoint;
      if (pending) {
        const bucketFill = context.bucketFill;
        if (!bucketFill) {
          throw new Error(
            "bucketFill controller requires the bucketFill capability",
          );
        }
        bucketFill.addBarrier({
          x1: pending.x,
          y1: pending.y,
          x2: normX,
          y2: normY,
        });
        if (!context.canAdoptProjectLifecycle()) return true;
        bfState.setBarrierPendingPoint(null);
      } else {
        bfState.setBarrierPendingPoint({ x: normX, y: normY });
      }
      return true;
    }

    if (bfState.bucketFillLoading) return true;
    if (bfState.bucketFillPreview || bfState.bucketFillPendingPolygon) {
      return true;
    }

    const bucketFill = context.bucketFill;
    if (!bucketFill) {
      throw new Error(
        "bucketFill controller requires the bucketFill capability",
      );
    }

    const bucketToken = {};
    const bucketActivation = bfState.activeTool;
    const bucketProjectDbId = bucketFill.projectDbId;
    const bucketPublicId = context.page.publicId;
    const bucketPageNumber = context.page.number;
    const queryClient = bucketFill.queryClient;
    claimToolTailAuthority(bucketToken);
    claimLatestToolOperation("bucketFill", bucketToken);
    // A competing global intent defeats this result tail. Its exact queued cancellation may
    // still clear A's spinner while preserving a newer Bucket B (which rotates the lane).
    registerToolTailCancellation(bucketToken, () => {
      if (
        !ownsLatestToolOperation("bucketFill", bucketToken) ||
        context.stores.session.getState().projectId !== bucketProjectDbId ||
        context.stores.session.getState().publicId !== bucketPublicId ||
        context.stores.viewerCore.getState().pageNumber !== bucketPageNumber
      )
        return;
      useToolStore.setState((state) =>
        state.activeTool === bucketActivation &&
        (state.bucketFillLoading || state.bucketFillError !== null)
          ? { bucketFillLoading: false, bucketFillError: null }
          : state,
      );
    });
    useToolStore.setState({
      bucketFillLoading: true,
      bucketFillPreview: null,
      bucketFillError: null,
    });

    const ownsBucketFill = () => {
      const current = context.stores.tool.getState();
      return (
        context.canAdoptProjectLifecycle() &&
        ownsToolTailAuthority(bucketToken) &&
        ownsLatestToolOperation("bucketFill", bucketToken) &&
        current.activeTool === bucketActivation &&
        context.stores.session.getState().projectId === bucketProjectDbId &&
        context.stores.session.getState().publicId === bucketPublicId &&
        context.stores.viewerCore.getState().pageNumber === bucketPageNumber
      );
    };
    if (!ownsBucketFill()) return true;

    const consumeBucketFill = (publish: () => void): boolean => {
      if (!ownsBucketFill()) return false;
      releaseToolTailCancellation(bucketToken);
      return consumeToolTailAuthority(bucketToken, publish);
    };

    // Bucket-fill collision input is invocation-time state. Reading the cache bridge preserves
    // getState freshness without subscribing this controller or the sacred canvas surface.
    const existingPolygons = readAnnotations(queryClient, bucketPublicId)
      .filter(
        (annotation: any) =>
          annotation.pageNumber === bucketPageNumber &&
          annotation.source === "takeoff" &&
          annotation.data?.type === "area-polygon" &&
          annotation.data?.vertices?.length >= 3,
      )
      .map((annotation: any) => ({ vertices: annotation.data.vertices }));

    // OCR text bboxes remain staged for Tier 2 enclosed-text area accounting. The worker currently
    // ignores them; this invocation-time cache read must not become a Textract observer.
    const textractWords =
      readTextractForPage(queryClient, bucketPublicId, bucketPageNumber)
        ?.words ?? [];
    const textBboxes = textractWords.map(
      (word: { bbox: [number, number, number, number] }) => ({
        x: word.bbox[0],
        y: word.bbox[1],
        w: word.bbox[2],
        h: word.bbox[3],
      }),
    );

    const handleFillSuccess = (data: {
      vertices: { x: number; y: number }[];
      holes?: { vertices: { x: number; y: number }[] }[];
      method: string;
    }) => {
      consumeBucketFill(() =>
        useToolStore.setState({
          bucketFillLoading: false,
          bucketFillPreview: {
            vertices: data.vertices,
            holes: data.holes && data.holes.length > 0 ? data.holes : undefined,
            method: data.method,
          },
        }),
      );
    };

    const handleFillError = (message: string) => {
      if (!ownsBucketFill()) return;
      useToolStore.setState({
        bucketFillLoading: false,
        bucketFillError: message,
      });
      setTimeout(() => {
        consumeBucketFill(() =>
          context.stores.tool.getState().setBucketFillError(null),
        );
      }, 4000);
    };

    const serverFallback = () => {
      if (!ownsBucketFill()) return;
      void fetch("/api/bucket-fill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: bucketProjectDbId,
          pageNumber: bucketPageNumber,
          seedPoint: { x: normX, y: normY },
          tolerance: bfState.bucketFillTolerance,
          dilate: bfState.bucketFillDilatePx,
          barriers: bfState.bucketFillBarriers,
          polygonBarriers: existingPolygons,
          textBboxes,
        }),
      })
        .then(async (response) => {
          if (!ownsBucketFill()) return null;
          // Non-OK serves {error:{code,message}}; the in-band error-at-200 protocol is unchanged.
          if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(
              apiErrorMessage(error) || `HTTP ${response.status}`,
            );
          }
          const data = await response.json();
          return ownsBucketFill() ? data : null;
        })
        .then((data) => {
          if (!ownsBucketFill()) return;
          if (data?.type === "result" && data.vertices?.length >= 3) {
            handleFillSuccess({
              vertices: data.vertices,
              holes: data.holes,
              method: data.method || "server-raster",
            });
          } else if (data?.type === "error") {
            handleFillError(data.error || "Bucket fill failed");
          } else {
            consumeBucketFill(() => {
              useToolStore.setState({ bucketFillLoading: false });
            });
          }
        })
        .catch((error) => {
          handleFillError(error?.message || "Bucket fill failed");
        });
    };

    // Try client-side WebWorker first, then fall back to the server only while still owned.
    const pageCanvas = findPageCanvas();
    if (pageCanvas) {
      const maxDimension = bfState.bucketFillResolution;
      clientBucketFill(
        pageCanvas,
        { x: normX, y: normY },
        {
          tolerance: bfState.bucketFillTolerance,
          dilation: bfState.bucketFillDilatePx,
          barriers: bfState.bucketFillBarriers,
          polygonBarriers: existingPolygons,
          textBboxes,
          maxDimension,
        },
      )
        .then(handleFillSuccess)
        .catch(() => {
          if (ownsBucketFill()) serverFallback();
        });
    } else {
      serverFallback();
    }
    return true;
  },
} satisfies ToolController);
