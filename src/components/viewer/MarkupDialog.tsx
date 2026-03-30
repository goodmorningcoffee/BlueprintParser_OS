"use client";

import { useRef, useEffect } from "react";

interface MarkupDialogProps {
  isEditing: boolean;
  name: string;
  note: string;
  onNameChange: (name: string) => void;
  onNoteChange: (note: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

/**
 * Modal dialog for creating or editing markup annotations.
 * Extracted from AnnotationOverlay for single responsibility.
 */
export default function MarkupDialog({
  isEditing,
  name,
  note,
  onNameChange,
  onNoteChange,
  onSave,
  onCancel,
}: MarkupDialogProps) {
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => nameInputRef.current?.focus(), 50);
  }, []);

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        style={{ background: "var(--surface, #161616)", border: "1px solid var(--border, #3a3a3a)", borderRadius: 8, padding: 20, width: 360, color: "var(--fg, #ededed)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 600 }}>{isEditing ? "Edit Markup" : "New Markup"}</h3>
        <label style={{ display: "block", fontSize: 12, color: "var(--muted, #aaa)", marginBottom: 4 }}>Name</label>
        <input
          ref={nameInputRef}
          type="text"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onSave(); if (e.key === "Escape") onCancel(); }}
          placeholder="e.g. RFI #12, Missing detail, Check dimension..."
          style={{ width: "100%", padding: "6px 8px", background: "var(--bg, #0a0a0a)", border: "1px solid var(--border, #3a3a3a)", borderRadius: 4, color: "var(--fg, #ededed)", fontSize: 14, marginBottom: 12, boxSizing: "border-box" }}
        />
        <label style={{ display: "block", fontSize: 12, color: "var(--muted, #aaa)", marginBottom: 4 }}>Notes</label>
        <textarea
          value={note}
          onChange={(e) => onNoteChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
          placeholder="Add details about this markup..."
          rows={3}
          style={{ width: "100%", padding: "6px 8px", background: "var(--bg, #0a0a0a)", border: "1px solid var(--border, #3a3a3a)", borderRadius: 4, color: "var(--fg, #ededed)", fontSize: 13, resize: "vertical", marginBottom: 14, fontFamily: "inherit", boxSizing: "border-box" }}
        />
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
