"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import EditableGrid from "./EditableGrid";

export interface TakeoffCsvModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  headers: string[];
  rows: Array<Record<string, string>>;
  readOnlyColumns: Set<string>;
  onCellChange: (rowIndex: number, column: string, value: string) => void;
  /** Optional: called when user clicks the Export CSV button in the header. */
  onExport?: () => void;
  /** Optional row click handler — e.g., jump to instance page in the viewer. */
  onRowClick?: (rowIndex: number) => void;
}

/**
 * Resizable modal showing takeoff data as an editable spreadsheet.
 * Reuses EditableGrid for the core cell-edit UX. Unlike TableCompareModal,
 * this modal has no image comparison panel — just the grid + export.
 */
export default function TakeoffCsvModal({
  open,
  onClose,
  title,
  headers,
  rows,
  readOnlyColumns,
  onCellChange,
  onExport,
  onRowClick,
}: TakeoffCsvModalProps) {
  const [size, setSize] = useState({ w: 0, h: 0 });

  // Initialize size on open
  useEffect(() => {
    if (open) setSize({ w: Math.min(window.innerWidth - 64, 1200), h: Math.min(window.innerHeight - 64, 800) });
  }, [open]);

  // Escape closes modal when no inner input has focus
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === "Escape" && tag !== "INPUT") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  // Use ref to avoid stale closure in drag handler — size state changes during
  // drag shouldn't recreate the handler or capture outdated startW/startH
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = sizeRef.current.w;
    const startH = sizeRef.current.h;
    function onMove(ev: MouseEvent) {
      setSize({
        w: Math.max(400, Math.min(window.innerWidth - 32, startW + ev.clientX - startX)),
        h: Math.max(250, Math.min(window.innerHeight - 32, startH + ev.clientY - startY)),
      });
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/75 z-50 flex items-center justify-center" onClick={onClose}>
      <div
        className="relative flex flex-col bg-[var(--bg)] border border-[var(--border)] rounded-xl overflow-hidden shadow-2xl"
        style={{ width: size.w || "auto", height: size.h || "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] bg-[var(--surface)]">
          <h2 className="text-sm font-semibold text-[var(--fg)]">{title}</h2>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[var(--muted)]">
              {headers.length} cols, {rows.length} rows
            </span>
            {onExport && (
              <button
                onClick={onExport}
                className="text-[10px] px-2 py-1 rounded border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10"
              >
                Export CSV
              </button>
            )}
            <button
              onClick={onClose}
              className="text-[var(--muted)] hover:text-[var(--fg)] text-lg leading-none px-1"
              title="Close (Esc)"
            >
              &times;
            </button>
          </div>
        </div>

        {/* Grid */}
        <div className="flex-1 overflow-auto p-3">
          {rows.length === 0 ? (
            <div className="text-center text-sm text-[var(--muted)] py-12">No rows to display.</div>
          ) : (
            <EditableGrid
              headers={headers}
              rows={rows}
              readOnlyColumns={readOnlyColumns}
              onCellChange={onCellChange}
              onRowClick={onRowClick}
            />
          )}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-1.5 border-t border-[var(--border)] bg-[var(--surface)]">
          <div className="text-[10px] text-[var(--muted)]">
            Click cell to edit. Tab/Shift+Tab to move horizontally, Enter to commit + move down, Escape to cancel. Dimmed columns are read-only.
          </div>
        </div>

        {/* Resize handle — bottom-right corner */}
        <div
          onMouseDown={onResizeStart}
          className="absolute bottom-0 right-0 w-5 h-5 cursor-nwse-resize opacity-50 hover:opacity-100"
          title="Drag to resize"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" className="text-[var(--muted)]">
            <path d="M14 20L20 14M10 20L20 10M6 20L20 6" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
        </div>
      </div>
    </div>
  );
}
