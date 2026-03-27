"use client";

import { useState, useRef, useEffect } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import Link from "next/link";
import LabelingWizard from "./LabelingWizard";
import HelpTooltip from "./HelpTooltip";

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
    activeModels,
    setModelActive,
    confidenceThresholds,
    setModelConfidence,
    annotations,
    allTrades,
    activeTradeFilter,
    setTradeFilter,
    allCsiCodes,
    activeCsiFilter,
    setCsiFilter,
    showKeynotes,
    toggleKeynotes,
  } = useViewerStore();

  const publicId = useViewerStore((s) => s.publicId);
  const hasYoloAnnotations = annotations.some((a) => a.source === "yolo");
  const [yoloDropdownOpen, setYoloDropdownOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const showLabelingWizard = useViewerStore((s) => s.showLabelingWizard);
  const setShowLabelingWizard = useViewerStore((s) => s.setShowLabelingWizard);
  const menuRef = useRef<HTMLDivElement>(null);
  const isDemo = useViewerStore((s) => s.isDemo);
  const yoloDropdownRef = useRef<HTMLDivElement>(null);

  // Derive unique model names from YOLO annotations
  const yoloModelNames = [...new Set(
    annotations
      .filter((a) => a.source === "yolo" && (a as any).data?.modelName)
      .map((a) => (a as any).data.modelName as string)
  )];

  // Close dropdown on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (yoloDropdownRef.current && !yoloDropdownRef.current.contains(e.target as Node)) {
        setYoloDropdownOpen(false);
      }
    }
    if (yoloDropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [yoloDropdownOpen]);

  // Close menu dropdown on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [menuOpen]);

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
    <div className="h-12 border-b border-[var(--border)] bg-[#222226] flex items-center px-3 gap-2 shrink-0">
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

      {/* Zoom controls */}
      <HelpTooltip id="zoom-out">
        <button
          onClick={zoomOut}
          className="px-2 py-1 text-sm text-[var(--muted)] hover:text-[var(--fg)]"
        >
          -
        </button>
      </HelpTooltip>
      <span className="text-xs tabular-nums min-w-12 text-center text-[var(--muted)]">
        {Math.round(scale * 100)}%
      </span>
      <HelpTooltip id="zoom-in">
        <button
          onClick={zoomIn}
          className="px-2 py-1 text-sm text-[var(--muted)] hover:text-[var(--fg)]"
        >
          +
        </button>
      </HelpTooltip>
      <HelpTooltip id="zoom-fit">
        <button
          onClick={zoomFit}
          className="px-2 py-1 text-xs text-[var(--muted)] hover:text-[var(--fg)] border border-[var(--border)] rounded"
        >
          Fit
        </button>
      </HelpTooltip>

      <div className="w-px h-6 bg-[var(--border)] mx-2" />

      {/* Labeling wizard modal */}
      {showLabelingWizard && (
        <LabelingWizard
          onClose={() => setShowLabelingWizard(false)}
          projectName={projectName}
          isDemo={isDemo}
        />
      )}

      {/* Mode toggle */}
      <div className="flex border border-[var(--border)] rounded">
        <HelpTooltip id="pointer-mode">
          <button
            onClick={() => setMode("pointer")}
            className={`px-3 py-1 text-xs rounded-l ${
              mode === "pointer"
                ? "bg-[var(--accent)] text-white"
                : "text-[var(--muted)] hover:text-[var(--fg)]"
            }`}
          >
            Pointer/Select
          </button>
        </HelpTooltip>
        <HelpTooltip id="pan-mode">
          <button
            onClick={() => setMode("move")}
            className={`px-3 py-1 text-xs ${
              mode === "move"
                ? "bg-[var(--accent)] text-white"
                : "text-[var(--muted)] hover:text-[var(--fg)]"
            }`}
          >
            Pan/Zoom
          </button>
        </HelpTooltip>
        <HelpTooltip id="markup-mode">
          <button
            onClick={() => setMode("markup")}
            className={`px-3 py-1 text-xs rounded-r ${
              mode === "markup"
                ? "bg-[var(--accent)] text-white"
                : "text-[var(--muted)] hover:text-[var(--fg)]"
            }`}
          >
            Add Markup
          </button>
        </HelpTooltip>
      </div>

      {/* Spacer — pushes center section */}
      <div className="flex-1" />

      {/* Menu dropdown */}
      <HelpTooltip id="menu-button">
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setMenuOpen((o) => !o)}
          className={`px-2 py-1 text-xs rounded border ${
            menuOpen
              ? "border-[var(--fg)]/50 text-[var(--fg)] bg-[var(--fg)]/5"
              : "border-[var(--fg)]/30 text-[var(--fg)]/70 hover:text-[var(--fg)] hover:border-[var(--fg)]/50"
          }`}
        >
          Menu
        </button>
        {menuOpen && (
          <div className="absolute top-full left-0 mt-1 bg-[var(--surface)] border border-[var(--border)] rounded shadow-lg z-50 min-w-[160px]">
            {!isDemo && (
              <button
                onClick={() => { setMenuOpen(false); setShowLabelingWizard(true); }}
                className="w-full text-left px-3 py-2 text-xs hover:bg-[var(--surface-hover)] text-[var(--fg)]"
              >
                Data Labeling
              </button>
            )}
            <button
              disabled
              className="w-full text-left px-3 py-2 text-xs text-[var(--muted)]/50 cursor-not-allowed"
            >
              Export PDF (coming soon)
            </button>
            <button
              disabled
              className="w-full text-left px-3 py-2 text-xs text-[var(--muted)]/50 cursor-not-allowed"
            >
              Settings (coming soon)
            </button>
            <div className="border-t border-[var(--border)]" />
            <button
              onClick={() => { setMenuOpen(false); useViewerStore.getState().toggleTips(); }}
              className="w-full text-left px-3 py-2 text-xs hover:bg-[var(--surface-hover)] text-[var(--fg)]"
            >
              Help
            </button>
          </div>
        )}
      </div>
      </HelpTooltip>

      {/* Search */}
      <HelpTooltip id="search-bar">
      <div className="relative flex items-center">
        <input
          type="text"
          placeholder="Search text..."
          value={searchQuery}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-1 text-sm bg-sky-950/30 border border-sky-400/30 rounded focus:outline-none focus:border-sky-400/60 w-56 pr-16"
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
      </HelpTooltip>

      {/* Trade filter */}
      {allTrades.length > 0 && (
        <HelpTooltip id="trade-filter">
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
        </HelpTooltip>
      )}

      {/* CSI code filter */}
      {allCsiCodes.length > 0 && (
        <HelpTooltip id="csi-filter">
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
        </HelpTooltip>
      )}

      {/* Spacer — pushes right buttons to edge */}
      <div className="flex-1" />

      {/* Keynote visibility toggle */}
      <HelpTooltip id="keynote-toggle">
        <button
          onClick={toggleKeynotes}
          className={`px-2 py-1 text-xs rounded border ${
            showKeynotes
              ? "border-amber-400/60 text-amber-400 bg-amber-400/10"
              : "border-amber-400/20 text-amber-400/50 hover:text-amber-300 hover:border-amber-400/40"
          }`}
        >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="inline-block">
          <ellipse cx="8" cy="8" rx="7" ry="4.5" />
          <circle cx="8" cy="8" r="2" fill="currentColor" />
          {!showKeynotes && <line x1="2" y1="14" x2="14" y2="2" strokeWidth="2" />}
        </svg>
      </button>
      </HelpTooltip>

      {/* YOLO detections toggle + per-model dropdown */}
      {hasYoloAnnotations && (
        <HelpTooltip id="yolo-toggle">
        <div className="relative" ref={yoloDropdownRef}>
          <button
            onClick={toggleDetections}
            className={`px-2 py-1 text-xs rounded-l border ${
              showDetections
                ? "border-purple-400/60 text-purple-400 bg-purple-400/10"
                : "border-purple-400/20 text-purple-400/50 hover:text-purple-300 hover:border-purple-400/40"
            }`}
          >
            YOLO
          </button>
          {showDetections && yoloModelNames.length > 0 && (
            <button
              onClick={() => setYoloDropdownOpen((o) => !o)}
              className={`px-1.5 py-1 text-xs border border-l-0 rounded-r ${
                yoloDropdownOpen
                  ? "border-purple-400/60 text-purple-400 bg-purple-400/10"
                  : "border-purple-400/40 text-purple-400/70 hover:text-purple-300 hover:border-purple-400/60"
              }`}
            >
              ▾
            </button>
          )}
          {yoloDropdownOpen && showDetections && (
            <div className="absolute top-full right-0 mt-1 bg-[var(--surface)] border border-[var(--border)] rounded shadow-lg z-50 min-w-[200px]">
              {yoloModelNames.map((modelName) => {
                const isActive = activeModels[modelName] ?? true;
                const threshold = confidenceThresholds[modelName] ?? 0.25;
                return (
                  <div key={modelName} className="px-3 py-2 border-b border-[var(--border)] last:border-b-0">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isActive}
                        onChange={(e) => setModelActive(modelName, e.target.checked)}
                        className="accent-purple-400"
                      />
                      <span className={`text-xs font-medium ${isActive ? "text-purple-300" : "text-[var(--muted)]"}`}>
                        {modelName}
                      </span>
                    </label>
                    {isActive && (
                      <div className="flex items-center gap-1 mt-1 ml-5">
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.05"
                          value={threshold}
                          onChange={(e) => setModelConfidence(modelName, parseFloat(e.target.value))}
                          className="w-20 h-1 accent-purple-400"
                          title={`${modelName} confidence: ${Math.round(threshold * 100)}%`}
                        />
                        <span className="text-[10px] text-[var(--muted)] w-8">
                          {Math.round(threshold * 100)}%
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        </HelpTooltip>
      )}

      {/* Text panel toggle */}
      <HelpTooltip id="text-button">
        <button
          onClick={toggleTextPanel}
          className={`px-2 py-1 text-xs rounded border ${
            showTextPanel
              ? "border-sky-400/60 text-sky-400 bg-sky-400/10"
              : "border-sky-400/20 text-sky-400/50 hover:text-sky-300 hover:border-sky-400/40"
          }`}
        >
          Text
        </button>
      </HelpTooltip>

      {/* Chat panel toggle */}
      <HelpTooltip id="chat-button">
        <button
          onClick={toggleChatPanel}
          className={`px-2 py-1 text-xs rounded border ${
            showChatPanel
              ? "border-blue-400/60 text-blue-400 bg-blue-400/10"
              : "border-blue-400/20 text-blue-400/50 hover:text-blue-300 hover:border-blue-400/40"
          }`}
        >
          LLM Chat
        </button>
      </HelpTooltip>

      {/* Takeoff panel toggle */}
      <HelpTooltip id="qto-button">
        <button
          onClick={toggleTakeoffPanel}
          className={`px-2 py-1 text-xs rounded border ${
            showTakeoffPanel
              ? "border-emerald-400/60 text-emerald-400 bg-emerald-400/10"
              : "border-emerald-400/20 text-emerald-400/50 hover:text-emerald-300 hover:border-emerald-400/40"
          }`}
        >
          QTO
        </button>
      </HelpTooltip>
    </div>
  );
}
