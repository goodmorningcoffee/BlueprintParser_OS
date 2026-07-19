"use client";

import { memo } from "react";

import { invalidateToolTailAuthority } from "@/lib/parse-tool-authority";
import { useToolStore, type ToolStoreData } from "@/stores/toolStore";

type SplitPreview = NonNullable<ToolStoreData["splitPreview"]>;

interface SplitPreviewActionsProps {
  preview: SplitPreview;
  width: number;
  height: number;
  cssScale: number;
}

/** Exact-owner actions for the ready/pending Split draft; owns no store subscription. */
export default memo(function SplitPreviewActions({
  preview,
  width,
  height,
  cssScale,
}: SplitPreviewActionsProps) {
  const midX = ((preview.lineA.x + preview.lineB.x) / 2) * width;
  const midY = ((preview.lineA.y + preview.lineB.y) / 2) * height;
  const commitPending = preview.commitPending === true;
  const renderedActivation = useToolStore.getState().activeTool;
  const ownsReadyPreview = () => {
    const live = useToolStore.getState();
    return (
      live.activeTool === renderedActivation &&
      live.activeTool?.kind === "split" &&
      live.splitPreview === preview &&
      live.splitPreview.commitPending !== true &&
      live.splitLineA === preview.lineA &&
      live.splitLineB === preview.lineB
    );
  };

  const claimReadyTail = () => {
    if (!commitPending && ownsReadyPreview()) invalidateToolTailAuthority();
  };

  return (
    <div
      style={{
        position: "absolute",
        left: `${midX - 58}px`,
        top: `${midY + 14}px`,
        display: "flex",
        gap: "6px",
        zIndex: 16,
        transform: cssScale !== 1 ? `scale(${cssScale})` : undefined,
        transformOrigin: "top left",
      }}
    >
      <button
        disabled={commitPending}
        aria-busy={commitPending}
        onPointerDown={claimReadyTail}
        onKeyDown={claimReadyTail}
        onClick={(event) => {
          event.stopPropagation();
          if (commitPending || !ownsReadyPreview()) return;
          invalidateToolTailAuthority();
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
        }}
        style={{
          padding: "4px 12px",
          borderRadius: "4px",
          border: "none",
          background: "#22c55e",
          color: "#fff",
          fontSize: "12px",
          fontWeight: 600,
          cursor: commitPending ? "wait" : "pointer",
          opacity: commitPending ? 0.75 : 1,
        }}
      >
        {commitPending ? "Splitting…" : "Split"}
      </button>
      <button
        disabled={commitPending}
        onPointerDown={claimReadyTail}
        onKeyDown={claimReadyTail}
        onClick={(event) => {
          event.stopPropagation();
          if (commitPending || !ownsReadyPreview()) return;
          invalidateToolTailAuthority();
          useToolStore.setState((state) =>
            state.activeTool === renderedActivation &&
            state.splitPreview === preview &&
            state.splitPreview.commitPending !== true &&
            state.splitLineA === preview.lineA &&
            state.splitLineB === preview.lineB
              ? { splitPreview: null }
              : state,
          );
        }}
        style={{
          padding: "4px 12px",
          borderRadius: "4px",
          border: "none",
          background: "#ef4444",
          color: "#fff",
          fontSize: "12px",
          fontWeight: 600,
          cursor: commitPending ? "not-allowed" : "pointer",
          opacity: commitPending ? 0.6 : 1,
        }}
      >
        Cancel
      </button>
    </div>
  );
});
