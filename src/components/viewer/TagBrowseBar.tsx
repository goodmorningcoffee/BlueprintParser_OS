"use client";

import { useState } from "react";
import { useViewerStore } from "@/stores/viewerStore";

/**
 * Floating tag instance navigator — shows when browsing tag instances.
 * Like "Find All" in a code editor: prev/next through instances across pages.
 * Includes inline edit to correct OCR text for the tag.
 */
export default function TagBrowseBar() {
  const tagBrowseId = useViewerStore((s) => s.tagBrowseId);
  const tagBrowseIndex = useViewerStore((s) => s.tagBrowseIndex);
  const yoloTags = useViewerStore((s) => s.yoloTags);
  const pageNames = useViewerStore((s) => s.pageNames);

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");

  if (!tagBrowseId) return null;

  const tag = yoloTags.find((t) => t.id === tagBrowseId);
  if (!tag || tag.instances.length === 0) return null;

  const total = tag.instances.length;
  const current = tagBrowseIndex + 1;
  const inst = tag.instances[tagBrowseIndex];
  const pageName = pageNames[inst?.pageNumber] || `pg ${inst?.pageNumber}`;

  const navigate = (delta: number) => {
    useViewerStore.getState().tagBrowseNavigate(tagBrowseId, tagBrowseIndex + delta);
  };

  const close = () => {
    useViewerStore.getState().setLlmHighlight(null);
    useViewerStore.setState({ tagBrowseId: null, tagBrowseIndex: 0 });
    setEditing(false);
  };

  const startEdit = () => {
    setEditValue(tag.tagText);
    setEditing(true);
  };

  const saveEdit = () => {
    const trimmed = editValue.trim();
    if (!trimmed || trimmed === tag.tagText) { setEditing(false); return; }

    const store = useViewerStore.getState();

    // Update the YoloTag text + name
    store.updateYoloTag(tag.id, { tagText: trimmed, name: trimmed });

    // Update all annotation names that reference this tag
    const updatedAnnotations = store.annotations.map((a) => {
      if (a.source !== "takeoff" && a.data?.takeoffItemId) return a;
      // Match by tag's instances — any annotation matching this tag's instances
      const isInstance = tag.instances.some(
        (inst) => inst.annotationId === a.id || (inst.annotationId === -1 && inst.pageNumber === a.pageNumber && inst.bbox[0] === a.bbox[0] && inst.bbox[1] === a.bbox[1])
      );
      if (isInstance) return { ...a, name: trimmed };
      return a;
    });
    store.setAnnotations(updatedAnnotations);

    // Refresh the highlight label
    store.tagBrowseNavigate(tag.id, tagBrowseIndex);

    setEditing(false);
  };

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2 rounded-lg border border-cyan-500/40 bg-[#1a1a2e]/95 backdrop-blur-sm shadow-xl">
      {/* Tag name — click pencil to edit */}
      {editing ? (
        <input
          autoFocus
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditing(false); }}
          onBlur={saveEdit}
          className="text-xs font-mono font-medium bg-transparent border-b border-cyan-400 outline-none text-cyan-300 w-20"
        />
      ) : (
        <span className="text-xs font-mono font-medium text-cyan-300 flex items-center gap-1">
          {tag.tagText}
          <button
            onClick={startEdit}
            className="text-[9px] text-cyan-400/40 hover:text-cyan-300"
            title="Edit tag text"
          >
            &#9998;
          </button>
        </span>
      )}

      {/* Tier badge for the current instance — color-coded by confidence tier.
          Pre-Phase-2 data lacks `confidenceTier` → defaults to "high" (no badge). */}
      {(() => {
        const tier = inst?.confidenceTier;
        if (!tier || tier === "high") return null;
        const label = tier === "medium" ? "Med" : "Low";
        const className =
          tier === "medium"
            ? "text-[8px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-medium"
            : "text-[8px] px-1.5 py-0.5 rounded border border-red-400/60 text-red-300 font-medium";
        const signals = inst?.signals;
        const score = inst?.score;
        const reason = inst?.dropReason;
        const title = [
          `tier=${tier}`,
          score !== undefined ? `score=${score.toFixed(2)}` : null,
          signals ? `region=${signals.regionType}` : null,
          signals?.patternMatch !== undefined ? `pattern=${signals.patternMatch ? "✓" : "✗"}` : null,
          signals?.windowMatch !== undefined ? `window=${signals.windowMatch ? "✓" : "✗"}` : null,
          signals?.fuzzy ? "fuzzy-OCR" : null,
          reason ? `reason=${reason}` : null,
        ].filter(Boolean).join(" · ");
        return <span className={className} title={title}>{label}</span>;
      })()}

      {/* Navigation */}
      <button
        onClick={() => navigate(-1)}
        className="text-sm px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-cyan-400"
        title="Previous instance (←)"
      >
        &#9664;
      </button>
      <span className="text-xs tabular-nums text-[var(--fg)] min-w-[4rem] text-center">
        {current} / {total}
      </span>
      <button
        onClick={() => navigate(1)}
        className="text-sm px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-cyan-400"
        title="Next instance (→)"
      >
        &#9654;
      </button>

      {/* Page info + close */}
      <span className="text-[10px] text-[var(--muted)]">{pageName}</span>
      <button
        onClick={close}
        className="text-sm text-[var(--muted)] hover:text-red-400 ml-1"
        title="Close (Esc)"
      >
        &times;
      </button>
    </div>
  );
}
