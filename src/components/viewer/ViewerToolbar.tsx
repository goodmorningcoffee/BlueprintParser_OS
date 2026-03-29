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
    showCsiPanel,
    toggleCsiPanel,
    showPageIntelPanel,
    togglePageIntelPanel,
    showDetectionPanel,
    toggleDetectionPanel,
    showKeynotes,
    toggleKeynotes,
    showTableParsePanel,
    toggleTableParsePanel,
    showKeynoteParsePanel,
    toggleKeynoteParsePanel,
    symbolSearchActive,
    setSymbolSearchActive,
    symbolSearchResults,
    symbolSearchLoading,
    clearSymbolSearch,
  } = useViewerStore();

  const publicId = useViewerStore((s) => s.publicId);
  const hasYoloAnnotations = annotations.some((a) => a.source === "yolo");
  const [yoloDropdownOpen, setYoloDropdownOpen] = useState(false);
  const [csiDropdownOpen, setCsiDropdownOpen] = useState(false);
  const [csiSearchQuery, setCsiSearchQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const showLabelingWizard = useViewerStore((s) => s.showLabelingWizard);
  const setShowLabelingWizard = useViewerStore((s) => s.setShowLabelingWizard);
  const menuRef = useRef<HTMLDivElement>(null);
  const isDemo = useViewerStore((s) => s.isDemo);
  const yoloDropdownRef = useRef<HTMLDivElement>(null);
  const csiDropdownRef = useRef<HTMLDivElement>(null);

  // Derive unique model names from YOLO annotations
  const yoloModelNames = [...new Set(
    annotations
      .filter((a) => a.source === "yolo" && (a as any).data?.modelName)
      .map((a) => (a as any).data.modelName as string)
  )];

  // Close dropdowns on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (yoloDropdownRef.current && !yoloDropdownRef.current.contains(e.target as Node)) {
        setYoloDropdownOpen(false);
      }
      if (csiDropdownRef.current && !csiDropdownRef.current.contains(e.target as Node)) {
        setCsiDropdownOpen(false);
        setCsiSearchQuery("");
      }
    }
    if (yoloDropdownOpen || csiDropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [yoloDropdownOpen, csiDropdownOpen]);

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

      {/* Symbol Search */}
      <HelpTooltip id="symbol-search">
        <button
          onClick={() => {
            if (symbolSearchActive) {
              setSymbolSearchActive(false);
            } else if (symbolSearchResults) {
              clearSymbolSearch();
            } else {
              setSymbolSearchActive(true);
              setMode("pointer");
            }
          }}
          className={`px-2 py-1 text-xs rounded border flex items-center gap-1 ${
            symbolSearchActive
              ? "border-cyan-400/60 text-cyan-400 bg-cyan-400/10 animate-pulse"
              : symbolSearchResults
                ? "border-cyan-400/60 text-cyan-400 bg-cyan-400/10"
                : symbolSearchLoading
                  ? "border-cyan-400/40 text-cyan-400/60 animate-pulse"
                  : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--fg)]/30"
          }`}
          title={symbolSearchActive ? "Cancel symbol search" : symbolSearchResults ? "Clear search results" : "Symbol Search — draw a BB around a symbol to find all instances"}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="6.5" cy="6.5" r="4.5" />
            <line x1="10" y1="10" x2="14" y2="14" />
            <rect x="3.5" y="3.5" width="6" height="6" rx="0.5" strokeDasharray="2 1" strokeWidth="1" />
          </svg>
          {symbolSearchLoading ? "Searching..." : symbolSearchResults ? `${symbolSearchResults.totalMatches} found` : "Symbol Search"}
        </button>
      </HelpTooltip>

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

      {/* CSI code filter — custom dropdown with search + standard/masterformat toggle */}
      {allCsiCodes.length > 0 && (
        <HelpTooltip id="csi-filter">
          <div className="relative" ref={csiDropdownRef}>
            <button
              onClick={() => setCsiDropdownOpen(o => !o)}
              className={`px-2 py-1 text-xs rounded border ${
                activeCsiFilter
                  ? "border-orange-400/60 text-orange-400 bg-orange-400/10"
                  : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
              }`}
            >
              {activeCsiFilter ? `CSI: ${activeCsiFilter}` : `CSI Codes (${allCsiCodes.length})`}
              {activeCsiFilter && (
                <span
                  onClick={(e) => { e.stopPropagation(); setCsiFilter(null); setSearch(""); }}
                  className="ml-1 hover:text-[var(--fg)]"
                >×</span>
              )}
            </button>
            {csiDropdownOpen && (
              <div className="absolute top-full right-0 mt-1 bg-[var(--surface)] border border-[var(--border)] rounded shadow-lg z-50 w-72">
                {/* Search */}
                <div className="p-2 border-b border-[var(--border)]">
                  <input
                    type="text"
                    value={csiSearchQuery}
                    onChange={(e) => setCsiSearchQuery(e.target.value)}
                    placeholder="Search codes... (e.g. 08, door, plumbing)"
                    className="w-full px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none focus:border-[var(--accent)]"
                    autoFocus
                  />
                </div>
                {/* Code list */}
                <div className="max-h-64 overflow-y-auto">
                  <button
                    onClick={() => { setCsiFilter(null); setSearch(""); setCsiDropdownOpen(false); }}
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-hover)] ${!activeCsiFilter ? "text-[var(--accent)]" : "text-[var(--fg)]"}`}
                  >
                    All CSI Codes
                  </button>
                  {allCsiCodes
                    .filter(csi => {
                      if (!csiSearchQuery) return true;
                      const q = csiSearchQuery.toLowerCase();
                      return csi.code.toLowerCase().includes(q) || csi.description.toLowerCase().includes(q);
                    })
                    .slice(0, 50) // limit for performance
                    .map((csi) => (
                      <button
                        key={csi.code}
                        onClick={() => { setCsiFilter(csi.code); setSearch(csi.description); setCsiDropdownOpen(false); setCsiSearchQuery(""); }}
                        className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-hover)] ${
                          activeCsiFilter === csi.code ? "text-[var(--accent)] bg-[var(--accent)]/5" : "text-[var(--fg)]"
                        }`}
                      >
                        <span className="text-[var(--muted)] font-mono">{csi.code}</span>
                        <span className="ml-1.5">{csi.description}</span>
                      </button>
                    ))}
                  {allCsiCodes.length > 50 && !csiSearchQuery && (
                    <div className="px-3 py-2 text-[10px] text-[var(--muted)]">
                      Type to search {allCsiCodes.length} codes...
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
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

      {/* YOLO detections panel + per-model dropdown */}
      {hasYoloAnnotations && (
        <HelpTooltip id="yolo-toggle">
        <div className="relative" ref={yoloDropdownRef}>
          <button
            onClick={() => { toggleDetectionPanel(); if (!showDetections) toggleDetections(); }}
            className={`px-2 py-1 text-xs rounded-l border ${
              showDetectionPanel
                ? "border-green-400/30 text-green-400/50 bg-green-400/5"
                : "border-red-400/20 text-red-400/35 hover:text-red-300/45 hover:border-red-400/30"
            }`}
          >
            YOLO
          </button>
          {showDetections && yoloModelNames.length > 0 && (
            <button
              onClick={() => setYoloDropdownOpen((o) => !o)}
              className={`px-1.5 py-1 text-xs border border-l-0 rounded-r ${
                yoloDropdownOpen
                  ? "border-green-400/30 text-green-400/50 bg-green-400/5"
                  : "border-red-400/20 text-red-400/35 hover:text-red-300/45 hover:border-red-400/30"
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

      {/* ─── Panel toggle buttons: YOLO TEXT CSI CHAT Intel QTO ─── */}
      {/* Gradient: translucent/dark (left) → opaque/bright (right) */}
      {/* Green when active, red when inactive */}

      {/* TEXT — step 2 */}
      <HelpTooltip id="text-button">
        <button
          onClick={toggleTextPanel}
          className={`px-2 py-1 text-xs rounded border ${
            showTextPanel
              ? "border-green-400/40 text-green-400/60 bg-green-400/8"
              : "border-red-400/25 text-red-400/40 hover:text-red-300/50 hover:border-red-400/35"
          }`}
        >
          Text
        </button>
      </HelpTooltip>

      {/* CSI — step 3 */}
      <HelpTooltip id="csi-button">
        <button
          onClick={toggleCsiPanel}
          className={`px-2 py-1 text-xs rounded border ${
            showCsiPanel
              ? "border-green-400/50 text-green-400/70 bg-green-400/10"
              : "border-red-400/30 text-red-400/45 hover:text-red-300/55 hover:border-red-400/40"
          }`}
        >
          CSI
        </button>
      </HelpTooltip>

      {/* LLM CHAT — step 4 */}
      <HelpTooltip id="chat-button">
        <button
          onClick={toggleChatPanel}
          className={`px-2 py-1 text-xs rounded border ${
            showChatPanel
              ? "border-green-400/55 text-green-400/80 bg-green-400/12"
              : "border-red-400/35 text-red-400/50 hover:text-red-300/60 hover:border-red-400/45"
          }`}
        >
          LLM Chat
        </button>
      </HelpTooltip>

      {/* Intel — step 5 */}
      <button
        onClick={togglePageIntelPanel}
        className={`px-2 py-1 text-xs rounded border ${
          showPageIntelPanel
            ? "border-green-400/65 text-green-300/85 bg-green-400/15"
            : "border-red-400/40 text-red-400/55 hover:text-red-300/65 hover:border-red-400/50"
        }`}
        title="Page Intelligence"
      >
        Intel
      </button>

      {/* QTO */}
      <HelpTooltip id="qto-button">
        <button
          onClick={toggleTakeoffPanel}
          className={`px-2 py-1 text-xs rounded border ${
            showTakeoffPanel
              ? "border-green-400/75 text-green-300/95 bg-green-400/18"
              : "border-red-400/45 text-red-400/60 hover:text-red-300/70 hover:border-red-400/55"
          }`}
        >
          QTO
        </button>
      </HelpTooltip>

      {/* Schedules/Tables — far right */}
      <button
        onClick={toggleTableParsePanel}
        className={`px-2 py-1 text-xs rounded border ${
          showTableParsePanel
            ? "border-pink-400/75 text-pink-300/95 bg-pink-400/18"
            : "border-red-400/45 text-red-400/60 hover:text-red-300/70 hover:border-red-400/55"
        }`}
        title="Schedules & Table Parser"
      >
        Schedules/Tables
      </button>

      {/* Keynotes — far right */}
      <button
        onClick={toggleKeynoteParsePanel}
        className={`px-2 py-1 text-xs rounded border ${
          showKeynoteParsePanel
            ? "border-amber-400/75 text-amber-300/95 bg-amber-400/18"
            : "border-red-400/45 text-red-400/60 hover:text-red-300/70 hover:border-red-400/55"
        }`}
        title="Keynote Parser"
      >
        Keynotes
      </button>
    </div>
  );
}
