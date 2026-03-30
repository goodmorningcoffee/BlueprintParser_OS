"use client";

import { useState } from "react";
import { TAKEOFF_SHAPES, TWENTY_COLORS } from "@/types";
import type { TakeoffShape, ClientTakeoffItem } from "@/types";

// ─── Shape icons for count tab ──────────────────────────────
export const SHAPE_ICONS: Record<TakeoffShape, (color: string) => React.ReactNode> = {
  circle: (c) => (
    <svg width="14" height="14" viewBox="0 0 14 14">
      <circle cx="7" cy="7" r="6" fill={c} stroke={c} strokeWidth="1" opacity="0.85" />
    </svg>
  ),
  square: (c) => (
    <svg width="14" height="14" viewBox="0 0 14 14">
      <rect x="1" y="1" width="12" height="12" fill={c} stroke={c} strokeWidth="1" opacity="0.85" />
    </svg>
  ),
  diamond: (c) => (
    <svg width="14" height="14" viewBox="0 0 14 14">
      <polygon points="7,1 13,7 7,13 1,7" fill={c} stroke={c} strokeWidth="1" opacity="0.85" />
    </svg>
  ),
  triangle: (c) => (
    <svg width="14" height="14" viewBox="0 0 14 14">
      <polygon points="7,1 13,13 1,13" fill={c} stroke={c} strokeWidth="1" opacity="0.85" />
    </svg>
  ),
  cross: (c) => (
    <svg width="14" height="14" viewBox="0 0 14 14">
      <path d="M5,1 L9,1 L9,5 L13,5 L13,9 L9,9 L9,13 L5,13 L5,9 L1,9 L1,5 L5,5 Z" fill={c} stroke={c} strokeWidth="0.5" opacity="0.85" />
    </svg>
  ),
};

// ─── Colored dot for area items ──────────────────────────────
export function ColorDot({ color }: { color: string }) {
  return (
    <span
      className="inline-block w-3 h-3 rounded-full shrink-0"
      style={{ backgroundColor: color }}
    />
  );
}

// ─── Shared edit panel for takeoff items ────────────────────
export function TakeoffEditPanel({
  item,
  onSave,
  onClose,
  onLiveUpdate,
  showShape,
}: {
  item: ClientTakeoffItem;
  onSave: (updates: Partial<ClientTakeoffItem>) => Promise<void>;
  onClose: () => void;
  onLiveUpdate?: (updates: Partial<ClientTakeoffItem>) => void;
  showShape?: boolean;
}) {
  const [name, setName] = useState(item.name);
  const [color, setColor] = useState(item.color);
  const [shape, setShape] = useState<TakeoffShape>(item.shape as TakeoffShape);
  const [size, setSize] = useState(item.size || 10);
  const [notes, setNotes] = useState(item.notes || "");
  const [saving, setSaving] = useState(false);

  return (
    <div
      className="ml-2 mr-1 mb-2 p-2 rounded border border-[var(--border)] bg-[var(--bg)] space-y-2"
      onClick={(e) => e.stopPropagation()}
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full text-xs px-2 py-1 bg-[var(--surface)] border border-[var(--border)] rounded outline-none focus:border-[var(--accent)]"
        placeholder="Name"
      />
      {/* Color picker */}
      <div className="flex flex-wrap gap-1">
        {TWENTY_COLORS.map((c) => (
          <button
            key={c}
            onClick={() => setColor(c)}
            className={`w-4 h-4 rounded-full border-2 ${color === c ? "border-white" : "border-transparent"}`}
            style={{ backgroundColor: c }}
          />
        ))}
      </div>
      {/* Shape picker (count items only) */}
      {showShape && (
        <div className="flex gap-1">
          {TAKEOFF_SHAPES.map((s) => (
            <button
              key={s}
              onClick={() => setShape(s)}
              className={`px-2 py-0.5 text-[10px] rounded border ${
                shape === s ? "border-[var(--accent)] text-[var(--fg)]" : "border-[var(--border)] text-[var(--muted)]"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      )}
      {/* Size slider */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-[var(--muted)] w-6">Size</span>
        <input
          type="range"
          min="4"
          max="30"
          step="1"
          value={size}
          onChange={(e) => { const v = parseInt(e.target.value); setSize(v); onLiveUpdate?.({ size: v }); }}
          className="flex-1 h-1 accent-[var(--accent)]"
        />
        <span className="text-[10px] text-[var(--muted)] w-5 text-right">{size}</span>
      </div>
      {/* Notes */}
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes (searchable by LLM)..."
        className="w-full text-xs px-2 py-1 bg-[var(--surface)] border border-[var(--border)] rounded outline-none focus:border-[var(--accent)] resize-none"
        rows={2}
      />
      {/* Actions */}
      <div className="flex justify-end gap-1">
        <button
          onClick={onClose}
          className="px-2 py-0.5 text-[10px] text-[var(--muted)] hover:text-[var(--fg)]"
        >
          Cancel
        </button>
        <button
          disabled={saving || !name.trim()}
          onClick={async () => {
            setSaving(true);
            const updates: Partial<ClientTakeoffItem> = {};
            if (name !== item.name) updates.name = name;
            if (color !== item.color) updates.color = color;
            if (showShape && shape !== item.shape) updates.shape = shape;
            if (size !== (item.size || 10)) updates.size = size;
            if (notes !== (item.notes || "")) updates.notes = notes;
            if (Object.keys(updates).length > 0) await onSave(updates);
            setSaving(false);
            onClose();
          }}
          className="px-2 py-0.5 text-[10px] rounded border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)]/10 disabled:opacity-40"
        >
          {saving ? "..." : "Save"}
        </button>
      </div>
    </div>
  );
}
