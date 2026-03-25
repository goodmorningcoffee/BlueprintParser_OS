"use client";

import { useState } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import Link from "next/link";

interface ViewerToolbarProps {
  projectName: string;
  backHref?: string;
  onRename?: (newName: string) => void;
}

export default function ViewerToolbar({ projectName, backHref = "/home", onRename }: ViewerToolbarProps) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(projectName);
  const {
    pageNumber,
    numPages,
    setPage,
    scale,
    zoomIn,
    zoomOut,
    zoomFit,
    mode,
    setMode,
    searchQuery,
    setSearch,
    searchResults,
    searchLoading,
    showTextPanel,
    toggleTextPanel,
    showChatPanel,
    toggleChatPanel,
    showTakeoffPanel,
    toggleTakeoffPanel,
    showDetections,
    toggleDetections,
    confidenceThreshold,
    setConfidenceThreshold,
    annotations,
    allTrades,
    activeTradeFilter,
    setTradeFilter,
    allCsiCodes,
    activeCsiFilter,
    setCsiFilter,
  } = useViewerStore();

  const publicId = useViewerStore((s) => s.publicId);
  const hasYoloAnnotations = annotations.some((a) => a.source === "yolo");

  async function saveRename() {
    const trimmed = editName.trim();
    if (!trimmed || trimmed === projectName) {
      setEditName(projectName);
      setEditing(false);
      return;
    }
    const res = await fetch(`/api/projects/${publicId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    if (res.ok) {
      onRename?.(trimmed);
    } else {
      setEditName(projectName);
    }
    setEditing(false);
  }

  return (
    <div className="h-12 border-b border-[var(--border)] bg-[var(--surface)] flex items-center px-3 gap-2 shrink-0">
      {/* Back to home */}
      <Link
        href={backHref}
        className="text-[var(--muted)] hover:text-[var(--fg)] mr-2 text-sm"
      >
        &larr;
      </Link>

      {/* Project name */}
      {editing ? (
        <input
          autoFocus
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={saveRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveRename();
            if (e.key === "Escape") { setEditName(projectName); setEditing(false); }
          }}
          className="text-sm font-medium bg-transparent border-b border-[var(--accent)] outline-none max-w-48 px-0"
        />
      ) : (
        <span
          className={`text-sm font-medium truncate max-w-48 ${onRename ? "cursor-pointer hover:text-[var(--accent)]" : ""}`}
          onClick={onRename ? () => { setEditing(true); setEditName(projectName); } : undefined}
          title={onRename ? "Click to rename" : undefined}
        >
          {projectName}
        </span>
      )}

      <div className="w-px h-6 bg-[var(--border)] mx-2" />

      {/* Page navigation */}
      <button
        onClick={() => setPage(pageNumber - 1)}
        disabled={pageNumber <= 1}
        className="px-2 py-1 text-sm text-[var(--muted)] hover:text-[var(--fg)] disabled:opacity-30"
      >
        &lt;
      </button>
      <span className="text-sm tabular-nums min-w-16 text-center">
        {pageNumber} / {numPages}
      </span>
      <button
        onClick={() => setPage(pageNumber + 1)}
        disabled={pageNumber >= numPages}
        className="px-2 py-1 text-sm text-[var(--muted)] hover:text-[var(--fg)] disabled:opacity-30"
      >
        &gt;
      </button>

      <div className="w-px h-6 bg-[var(--border)] mx-2" />

      {/* Zoom controls */}
      <button
        onClick={zoomOut}
        className="px-2 py-1 text-sm text-[var(--muted)] hover:text-[var(--fg)]"
        title="Zoom out"
      >
        -
      </button>
      <span className="text-xs tabular-nums min-w-12 text-center text-[var(--muted)]">
        {Math.round(scale * 100)}%
      </span>
      <button
        onClick={zoomIn}
        className="px-2 py-1 text-sm text-[var(--muted)] hover:text-[var(--fg)]"
        title="Zoom in"
      >
        +
      </button>
      <button
        onClick={zoomFit}
        className="px-2 py-1 text-xs text-[var(--muted)] hover:text-[var(--fg)] border border-[var(--border)] rounded"
        title="Fit to window"
      >
        Fit
      </button>

      <div className="w-px h-6 bg-[var(--border)] mx-2" />

      {/* Mode toggle */}
      <div className="flex border border-[var(--border)] rounded overflow-hidden">
        <button
          onClick={() => setMode("pointer")}
          className={`px-3 py-1 text-xs ${
            mode === "pointer"
              ? "bg-[var(--accent)] text-white"
              : "text-[var(--muted)] hover:text-[var(--fg)]"
          }`}
          title="Click on keynotes and markups"
        >
          Pointer
        </button>
        <button
          onClick={() => setMode("move")}
          className={`px-3 py-1 text-xs ${
            mode === "move"
              ? "bg-[var(--accent)] text-white"
              : "text-[var(--muted)] hover:text-[var(--fg)]"
          }`}
        >
          Pan
        </button>
        <button
          onClick={() => setMode("markup")}
          className={`px-3 py-1 text-xs ${
            mode === "markup"
              ? "bg-[var(--accent)] text-white"
              : "text-[var(--muted)] hover:text-[var(--fg)]"
          }`}
          title="Draw markups"
        >
          Add Markup
        </button>
        <button
          onClick={() => setMode("moveMarkup")}
          className={`px-3 py-1 text-xs ${
            mode === "moveMarkup"
              ? "bg-[var(--accent)] text-white"
              : "text-[var(--muted)] hover:text-[var(--fg)]"
          }`}
          title="Reposition markups"
        >
          Move Markup
        </button>
      </div>

      {/* Trade filter */}
      {allTrades.length > 0 && (
        <>
          <div className="w-px h-6 bg-[var(--border)] mx-2" />
          <select
            value={activeTradeFilter || ""}
            onChange={(e) => setTradeFilter(e.target.value || null)}
            className="px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] max-w-40"
          >
            <option value="">All Trades</option>
            {allTrades.map((trade) => (
              <option key={trade} value={trade}>
                {trade}
              </option>
            ))}
          </select>
        </>
      )}

      {/* CSI code filter */}
      {allCsiCodes.length > 0 && (
        <>
          <div className="w-px h-6 bg-[var(--border)] mx-2" />
          <select
            value={activeCsiFilter || ""}
            onChange={(e) => setCsiFilter(e.target.value || null)}
            className="px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] max-w-48"
          >
            <option value="">All CSI Codes</option>
            {allCsiCodes.map((csi) => (
              <option key={csi.code} value={csi.code}>
                {csi.code} — {csi.description}
              </option>
            ))}
          </select>
        </>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Search */}
      <div className="relative flex items-center">
        <input
          type="text"
          placeholder="Search text..."
          value={searchQuery}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-1 text-sm bg-[var(--bg)] border border-sky-400/20 rounded focus:outline-none focus:border-sky-400/50 w-48 pr-16"
        />
        <div className="absolute right-2 flex items-center gap-1">
          {searchLoading && (
            <span className="text-xs text-[var(--muted)] animate-pulse">
              ...
            </span>
          )}
          {!searchLoading && searchResults.length > 0 && (
            <span className="text-xs text-[var(--accent)]">
              {searchResults.length}pg
            </span>
          )}
          {searchQuery && (
            <button
              onClick={() => setSearch("")}
              className="text-xs text-[var(--muted)] hover:text-[var(--fg)] ml-0.5"
            >
              x
            </button>
          )}
        </div>
      </div>

      {/* YOLO detections toggle + confidence slider */}
      {hasYoloAnnotations && (
        <>
          <button
            onClick={toggleDetections}
            className={`px-2 py-1 text-xs rounded border ${
              showDetections
                ? "border-purple-400/60 text-purple-400 bg-purple-400/10"
                : "border-purple-400/20 text-purple-400/50 hover:text-purple-300 hover:border-purple-400/40"
            }`}
          >
            YOLO
          </button>
          {showDetections && (
            <div className="flex items-center gap-1">
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={confidenceThreshold}
                onChange={(e) => setConfidenceThreshold(parseFloat(e.target.value))}
                className="w-16 h-1 accent-[var(--accent)]"
                title={`Confidence: ${Math.round(confidenceThreshold * 100)}%`}
              />
              <span className="text-[10px] text-[var(--muted)] w-8">
                {Math.round(confidenceThreshold * 100)}%
              </span>
            </div>
          )}
        </>
      )}

      {/* Text panel toggle */}
      <button
        onClick={toggleTextPanel}
        className={`px-2 py-1 text-xs rounded border ${
          showTextPanel
            ? "border-sky-400/60 text-sky-400 bg-sky-400/10"
            : "border-sky-400/20 text-sky-400/50 hover:text-sky-300 hover:border-sky-400/40"
        }`}
        title="Toggle text panel"
      >
        Text
      </button>

      {/* Chat panel toggle */}
      <button
        onClick={toggleChatPanel}
        className={`px-2 py-1 text-xs rounded border ${
          showChatPanel
            ? "border-[var(--accent)] text-[var(--accent)]"
            : "chat-pulse"
        }`}
        title="Toggle chat panel"
      >
        Chat
      </button>

      {/* Takeoff panel toggle */}
      <button
        onClick={toggleTakeoffPanel}
        className={`px-2 py-1 text-xs rounded border ${
          showTakeoffPanel
            ? "border-emerald-400/60 text-emerald-400 bg-emerald-400/10"
            : "border-emerald-400/20 text-emerald-400/50 hover:text-emerald-300 hover:border-emerald-400/40"
        }`}
        title="Toggle QTO panel"
      >
        QTO
      </button>
    </div>
  );
}
