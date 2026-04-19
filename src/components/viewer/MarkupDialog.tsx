"use client";

import { useRef, useEffect } from "react";
import { TWENTY_COLORS } from "@/types";

export type MarkupDialogMode = "annotation" | "group";

interface MarkupDialogProps {
  isEditing: boolean;
  mode?: MarkupDialogMode;
  name: string;
  note: string;
  csiCode?: string;
  color?: string | null;
  isActive?: boolean;
  annotationCount?: number;
  onNameChange: (name: string) => void;
  onNoteChange: (note: string) => void;
  onCsiChange?: (csi: string) => void;
  onColorChange?: (color: string) => void;
  onActiveChange?: (active: boolean) => void;
  onSave: () => void;
  onCancel: () => void;
}

/**
 * Modal dialog for creating or editing annotations / annotation groups.
 *
 * Used by:
 *   - `AnnotationOverlay` markup-create + pencil-edit (mode="annotation")
 *   - Group Actions "Group N selected" flow + group-row pencil-edit (mode="group")
 *
 * Group mode adds a color picker (TWENTY_COLORS swatch grid) and swaps
 * the header copy. CSI code field is present in both modes — the
 * existing auto-CSI detection on text flows through the same input.
 */
export default function MarkupDialog({
  isEditing,
  mode = "annotation",
  name,
  note,
  csiCode = "",
  color = null,
  isActive,
  annotationCount,
  onNameChange,
  onNoteChange,
  onCsiChange,
  onColorChange,
  onActiveChange,
  onSave,
  onCancel,
}: MarkupDialogProps) {
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => nameInputRef.current?.focus(), 50);
  }, []);

  // Live CSI suggestion chips were dropped in 2026-04-18 because
  // `detectCsiCodes` pulls `fs.readFileSync` — server-only. Server-side
  // auto-CSI still runs on save (annotations PUT/POST + annotation-groups
  // POST both call detectCsiCodes on the final text), so users don't
  // lose tagging, just the live in-dialog preview. If we want suggestions
  // back, add `GET /api/csi/detect?text=...` and fetch on debounce.

  const headerCopy = (() => {
    if (mode === "group") {
      if (isEditing) return "Edit group";
      return annotationCount
        ? `Group ${annotationCount} annotation${annotationCount === 1 ? "" : "s"}`
        : "New group";
    }
    return isEditing ? "Edit Markup" : "New Markup";
  })();

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        style={{ background: "var(--surface, #161616)", border: "1px solid var(--border, #3a3a3a)", borderRadius: 8, padding: 20, width: 380, color: "var(--fg, #ededed)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 600 }}>{headerCopy}</h3>

        <label style={{ display: "block", fontSize: 12, color: "var(--muted, #aaa)", marginBottom: 4 }}>Name</label>
        <input
          ref={nameInputRef}
          type="text"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onSave(); if (e.key === "Escape") onCancel(); }}
          placeholder={mode === "group" ? "e.g. Division 08 doors, Tree protection group..." : "e.g. RFI #12, Missing detail, Check dimension..."}
          style={{ width: "100%", padding: "6px 8px", background: "var(--bg, #0a0a0a)", border: "1px solid var(--border, #3a3a3a)", borderRadius: 4, color: "var(--fg, #ededed)", fontSize: 14, marginBottom: 12, boxSizing: "border-box" }}
        />

        {onCsiChange && (
          <>
            <label style={{ display: "block", fontSize: 12, color: "var(--muted, #aaa)", marginBottom: 4 }}>CSI Code</label>
            <input
              type="text"
              value={csiCode}
              onChange={(e) => onCsiChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
              placeholder="e.g. 08 11 13 — or leave blank for server auto-detect"
              style={{ width: "100%", padding: "6px 8px", background: "var(--bg, #0a0a0a)", border: "1px solid var(--border, #3a3a3a)", borderRadius: 4, color: "var(--fg, #ededed)", fontSize: 13, marginBottom: 12, boxSizing: "border-box", fontFamily: "ui-monospace, monospace" }}
            />
          </>
        )}

        <label style={{ display: "block", fontSize: 12, color: "var(--muted, #aaa)", marginBottom: 4 }}>Notes</label>
        <textarea
          value={note}
          onChange={(e) => onNoteChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
          placeholder={mode === "group" ? "Add details about this group..." : "Add details about this markup..."}
          rows={3}
          style={{ width: "100%", padding: "6px 8px", background: "var(--bg, #0a0a0a)", border: "1px solid var(--border, #3a3a3a)", borderRadius: 4, color: "var(--fg, #ededed)", fontSize: 13, resize: "vertical", marginBottom: 14, fontFamily: "inherit", boxSizing: "border-box" }}
        />

        {mode === "group" && onColorChange && (
          <>
            <label style={{ display: "block", fontSize: 12, color: "var(--muted, #aaa)", marginBottom: 6 }}>Color</label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(10, 1fr)", gap: 4, marginBottom: 14 }}>
              {TWENTY_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => onColorChange(c)}
                  style={{ width: 24, height: 24, background: c, border: color === c ? "2px solid #fff" : "1px solid var(--border, #3a3a3a)", borderRadius: 4, cursor: "pointer", padding: 0 }}
                  title={c}
                  aria-label={`Color ${c}`}
                />
              ))}
            </div>
          </>
        )}

        {mode === "group" && onActiveChange && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, fontSize: 12, color: "var(--muted, #aaa)", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={isActive !== false}
              onChange={(e) => onActiveChange(e.target.checked)}
              style={{ cursor: "pointer" }}
            />
            <span>
              Active <span style={{ color: "var(--muted, #777)" }}>— enables outline + sibling-select. Uncheck to keep members grouped silently.</span>
            </span>
          </label>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            onClick={onCancel}
            style={{ padding: "6px 14px", background: "transparent", border: "1px solid var(--border, #3a3a3a)", borderRadius: 4, color: "var(--muted, #aaa)", cursor: "pointer", fontSize: 13 }}
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={!name.trim()}
            style={{ padding: "6px 14px", background: name.trim() ? "var(--accent, #3b82f6)" : "#333", border: "none", borderRadius: 4, color: "#fff", cursor: name.trim() ? "pointer" : "default", fontSize: 13, fontWeight: 500 }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
