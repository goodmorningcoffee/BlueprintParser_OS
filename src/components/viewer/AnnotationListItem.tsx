"use client";

import { useState } from "react";
import type { ClientAnnotation } from "@/types";
import { useViewerStore } from "@/stores/viewerStore";
import { normalizeCsiCodes, CSI_INPUT_PLACEHOLDER } from "@/lib/csi-utils";

interface AnnotationListItemProps {
  annotation: ClientAnnotation;
  isActive: boolean;
  onToggleFilter: (name: string) => void;
  onSearchKeyword: (keyword: string) => void;
  color?: string;
  showPageNumber?: boolean;
}

export default function AnnotationListItem({
  annotation, isActive, onToggleFilter, onSearchKeyword,
  color = "#a855f7", showPageNumber = true,
}: AnnotationListItemProps) {
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState(annotation.note || "");
  const [saving, setSaving] = useState(false);
  const updateAnnotation = useViewerStore((s) => s.updateAnnotation);

  const confidence = annotation.data?.confidence as number | undefined;
  const csiCodes = (annotation.data?.csiCodes as string[]) || [];
  const keywords = (annotation.data?.keywords as string[]) || [];
  const [csiInput, setCsiInput] = useState(csiCodes.join(", "));

  function handleRowClick() {
    onToggleFilter(annotation.name);
    if (!isActive) onSearchKeyword(annotation.name);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const normalizedCsi = normalizeCsiCodes(csiInput);
      const updatedData = { ...annotation.data, note, csiCodes: normalizedCsi.length > 0 ? normalizedCsi : undefined };
      const res = await fetch(`/api/annotations/${annotation.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note, data: updatedData }),
      });
      const result = await res.json();
      // Merge auto-detected CSI codes from note text
      if (result.autoCsiCodes?.length > 0) {
        const merged = [...new Set([...normalizedCsi, ...result.autoCsiCodes])];
        updatedData.csiCodes = merged;
        setCsiInput(merged.join(", "));
      }
      updateAnnotation(annotation.id, { note: note || null, data: updatedData });
    } catch {
      // Silently fail -- user can retry
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`rounded transition-colors ${
      isActive ? "bg-[var(--accent)]/10 border-l-2 border-[var(--accent)]" : "hover:bg-[var(--surface-hover)]"
    }`}>
      {/* Collapsed row */}
      <div className="flex items-center gap-2 px-2 py-1.5 cursor-pointer" onClick={handleRowClick}>
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          className="text-[10px] text-[var(--muted)] hover:text-[var(--fg)] shrink-0 w-3 text-center"
        >
          {expanded ? "\u25BC" : "\u25B6"}
        </button>
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
        <span className={`text-xs truncate flex-1 ${
          isActive ? "text-[var(--accent)] font-medium" : "text-[var(--fg)]"
        }`} title={annotation.name}>
          {annotation.name}
        </span>
        {confidence !== undefined && (
          <span className="text-[10px] text-[var(--muted)] shrink-0">{Math.round(confidence * 100)}%</span>
        )}
        {showPageNumber && (
          <span className="text-[10px] px-1 py-0.5 rounded bg-[var(--surface)] text-[var(--muted)] shrink-0">
            p{annotation.pageNumber}
          </span>
        )}
      </div>

      {/* Expanded edit form */}
      {expanded && (
        <div className="px-3 pb-2 pt-1 ml-5 space-y-2" onClick={(e) => e.stopPropagation()}>
          <textarea
            value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="Add notes..." rows={2}
            className="w-full text-xs px-2 py-1 bg-[var(--surface)] border border-[var(--border)] rounded outline-none focus:border-[var(--accent)] resize-none text-[var(--fg)]"
          />
          <div className="flex items-center gap-1.5">
            <label className="text-[9px] text-[var(--muted)] shrink-0">CSI</label>
            <input
              type="text"
              value={csiInput}
              onChange={(e) => setCsiInput(e.target.value)}
              placeholder={CSI_INPUT_PLACEHOLDER}
              className="flex-1 px-1.5 py-0.5 text-[10px] bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none focus:border-blue-400/50 font-mono"
            />
          </div>
          {keywords.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {keywords.map((kw) => (
                <span key={kw} className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">{kw}</span>
              ))}
            </div>
          )}
          <button
            onClick={handleSave} disabled={saving}
            className="text-[11px] px-2 py-1 rounded bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/30 hover:bg-[var(--accent)]/30 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      )}
    </div>
  );
}
