"use client";

// [classifier-builder 2026-10-24] Canvas-side half of the proposals list.
//   ProposalFocusLayer  soft outline for the hovered row, bright green box for the FOCUSED proposal,
//                       zoom/pan to fit it, Esc to end it, and focus cleared when the page/project changes.
//   ProposalDimGroup    dims the annotation canvas to the same .25 alpha the existing dim path uses
//                       (render/existingAnnotations.ts) while a proposal on this page is focused. That path's
//                       condition cannot be extended in place: AnnotationOverlay.tsx and
//                       render/existingAnnotations.ts are whole-file SHA-256 frozen, so the alpha is applied
//                       to the overlay as a group instead of per annotation.
//   ProposalOutlinesLayer (sibling file) is mounted inside this layer's root, beneath the hover / focus boxes,
//                       so PDFPage.tsx (pinned by several topology freezes) needs no new import.

import { useEffect, useRef, type ReactNode } from "react";
import { useProposalFocusStore, type ProposalFocusTarget } from "@/stores/proposalFocusStore";
import { useSessionStore } from "@/stores/sessionStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { isEditableKeyboardTarget } from "@/lib/keyboard-target";
import { centerDelta, findScrollContainer, fitScaleForBox } from "./proposals/proposalViewport";
import ProposalOutlinesLayer from "./ProposalOutlinesLayer";
import WorkspaceCanvasLayer from "./workspace/canvas/WorkspaceCanvasLayer";

export const FOCUS_COLOR = "#00E676";
export const DIM_ALPHA = 0.25;

function onPage(target: ProposalFocusTarget | null, publicId: string, pageNumber: number): target is ProposalFocusTarget {
  return target !== null && target.publicId === publicId && target.pageNumber === pageNumber;
}

function boxStyle(bbox: ProposalFocusTarget["bbox"]): React.CSSProperties {
  const [minX, minY, maxX, maxY] = bbox;
  return {
    position: "absolute",
    left: `${minX * 100}%`,
    top: `${minY * 100}%`,
    width: `${(maxX - minX) * 100}%`,
    height: `${(maxY - minY) * 100}%`,
    boxSizing: "border-box",
    pointerEvents: "none",
  };
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export function ProposalDimGroup({ pageNumber, children }: { pageNumber: number; children: ReactNode }) {
  const publicId = useSessionStore((s) => s.publicId);
  const dim = useProposalFocusStore((s) => onPage(s.focus, publicId, pageNumber));
  return (
    <div
      data-proposal-dim={dim ? "on" : "off"}
      style={{ position: "absolute", top: 0, left: 0, width: 0, height: 0, overflow: "visible", opacity: dim ? DIM_ALPHA : undefined }}
    >
      {children}
    </div>
  );
}

export default function ProposalFocusLayer({ pageNumber }: { pageNumber: number }) {
  const publicId = useSessionStore((s) => s.publicId);
  const hover = useProposalFocusStore((s) => s.hover);
  const focus = useProposalFocusStore((s) => s.focus);
  const fitRequest = useProposalFocusStore((s) => s.fitRequest);
  const clearFocus = useProposalFocusStore((s) => s.clearFocus);
  const rootRef = useRef<HTMLDivElement>(null);
  const fittedRef = useRef(0);

  // Navigating away (another page or project) ends focus.
  useEffect(() => {
    if (focus && !onPage(focus, publicId, pageNumber)) clearFocus();
  }, [focus, publicId, pageNumber, clearFocus]);

  // Esc ends focus (never while typing).
  useEffect(() => {
    if (!focus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isEditableKeyboardTarget(e.target)) clearFocus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus, clearFocus]);

  // Each focus request fits the viewport to the box once: let a page change lay out, zoom, then centre the box
  // after the new size lays out.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !onPage(focus, publicId, pageNumber) || fittedRef.current === fitRequest) return;
    fittedRef.current = fitRequest;
    const container = findScrollContainer(root);
    if (!container) return;
    let cancelled = false;
    void (async () => {
      await nextFrame();
      await nextFrame();
      if (cancelled) return;
      const core = useViewerCoreStore.getState();
      const view = { width: container.clientWidth, height: container.clientHeight };
      const nextScale = fitScaleForBox(root.getBoundingClientRect(), focus.bbox, view, core.scale);
      if (Math.abs(nextScale - core.scale) > 1e-3) core.setScale(nextScale);
      await nextFrame();
      await nextFrame();
      if (cancelled) return;
      const { dx, dy } = centerDelta(root.getBoundingClientRect(), container.getBoundingClientRect(), focus.bbox);
      container.scrollLeft += dx;
      container.scrollTop += dy;
    })();
    return () => {
      cancelled = true;
    };
  }, [focus, fitRequest, publicId, pageNumber]);

  const focused = onPage(focus, publicId, pageNumber) ? focus : null;
  const hovered = onPage(hover, publicId, pageNumber) && hover.proposalId !== focused?.proposalId ? hover : null;
  return (
    <div
      ref={rootRef}
      data-proposal-layer=""
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
    >
      <ProposalOutlinesLayer pageNumber={pageNumber} focusedId={focused?.proposalId ?? null} />
      <WorkspaceCanvasLayer pageNumber={pageNumber} />
      {hovered && (
        <div
          data-proposal-hover={hovered.proposalId}
          style={{
            ...boxStyle(hovered.bbox),
            border: `2px solid ${FOCUS_COLOR}80`,
            background: `${FOCUS_COLOR}12`,
            borderRadius: 2,
          }}
        />
      )}
      {focused && (
        <div
          data-proposal-focus={focused.proposalId}
          style={{
            ...boxStyle(focused.bbox),
            border: `4px solid ${FOCUS_COLOR}`,
            borderRadius: 3,
            boxShadow: `0 0 0 1px rgba(0,0,0,0.35), 0 0 14px 4px ${FOCUS_COLOR}73`,
          }}
        />
      )}
    </div>
  );
}
