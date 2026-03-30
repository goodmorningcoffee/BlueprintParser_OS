"use client";

import { useState } from "react";
import { exportMultiTableCsv, exportTableCsv } from "@/lib/table-parse-utils";

interface ExportableTable {
  name: string;
  headers: string[];
  rows: Record<string, string>[];
  pageNumber: number;
}

interface ExportCsvModalProps {
  tables: ExportableTable[];
  onClose: () => void;
  filenamePrefix?: string;
}

/** Modal for selecting which tables/keynotes to export as CSV. */
export default function ExportCsvModal({ tables, onClose, filenamePrefix = "tables" }: ExportCsvModalProps) {
  const [selected, setSelected] = useState<Set<number>>(new Set(tables.map((_, i) => i)));

  const toggleSelection = (idx: number) => {
    const next = new Set(selected);
    if (next.has(idx)) next.delete(idx); else next.add(idx);
    setSelected(next);
  };

  const toggleAll = () => {
    if (selected.size === tables.length) setSelected(new Set());
    else setSelected(new Set(tables.map((_, i) => i)));
  };

  const handleExport = () => {
    const toExport = tables.filter((_, i) => selected.has(i));
    if (toExport.length === 0) return;

    if (toExport.length === 1) {
      exportTableCsv(toExport[0], toExport[0].pageNumber);
    } else {
      exportMultiTableCsv(toExport, `${filenamePrefix}_export.csv`);
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-[var(--bg)] border border-[var(--border)] rounded-lg shadow-xl w-80 max-h-[400px] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
          <h3 className="text-sm font-medium text-[var(--fg)]">Export CSV</h3>
          <button onClick={onClose} className="text-[var(--muted)] hover:text-[var(--fg)] text-lg leading-none">&times;</button>
        </div>

        {/* Table list */}
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
          <button
            onClick={toggleAll}
            className="text-[10px] text-[var(--muted)] hover:text-[var(--fg)] mb-1"
          >
            {selected.size === tables.length ? "Deselect All" : "Select All"}
          </button>

          {tables.map((t, i) => (
            <label
              key={i}
              className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer ${
                selected.has(i) ? "bg-[var(--surface)]" : "hover:bg-[var(--surface-hover)]"
              }`}
            >
              <input
                type="checkbox"
                checked={selected.has(i)}
                onChange={() => toggleSelection(i)}
                className="accent-[var(--accent)]"
              />
              <div className="flex-1 min-w-0">
                <div className="text-[11px] text-[var(--fg)] truncate">{t.name}</div>
                <div className="text-[9px] text-[var(--muted)]">
                  p.{t.pageNumber} &middot; {t.rows.length} rows, {t.headers.length} cols
                </div>
              </div>
            </label>
          ))}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-[var(--border)] flex items-center justify-between">
          <span className="text-[10px] text-[var(--muted)]">{selected.size} selected</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="text-xs px-3 py-1 text-[var(--muted)] hover:text-[var(--fg)]">
              Cancel
            </button>
            <button
              onClick={handleExport}
              disabled={selected.size === 0}
              className="text-xs px-3 py-1 rounded bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40"
            >
              Export {selected.size > 1 ? `${selected.size} Tables` : "CSV"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
