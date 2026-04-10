"use client";

import { useState, useRef, useCallback, useEffect } from "react";

export interface EditableGridProps {
  headers: string[];
  rows: Array<Record<string, string>>;
  /** Column whose cells should render in green mono (e.g., the QTO tag column). */
  tagColumn?: string;
  /** Columns that cannot be edited (rendered dimmed, no click-to-edit). */
  readOnlyColumns?: Set<string>;
  onCellChange: (rowIndex: number, column: string, value: string) => void;
  onHeaderRename?: (colIndex: number, newName: string) => void;
  /** Fires whenever the active cell changes; used by TableCompareModal to drive image highlight. */
  onActiveCellChange?: (cell: { row: number; col: number } | null) => void;
  /** Highlight a specific row (e.g., from external navigation). */
  activeRowIndex?: number;
  /** Row click handler — useful when each row corresponds to a navigable entity (e.g., QTO tag → page). */
  onRowClick?: (rowIndex: number) => void;
  /** Fires on double-click of a cell (not editing). Used to trigger tag instance browsing. */
  onCellDoubleClick?: (rowIndex: number, colIndex: number, header: string, value: string) => void;
}

/**
 * Shared editable grid with keyboard navigation (Tab, Shift+Tab, Enter, Escape).
 * Extracted from TableCompareModal so it can be reused for takeoff CSV editing
 * without pulling in the image-compare / overlay features.
 */
type GridColorMode = "none" | "striped" | "checkerboard";

export default function EditableGrid({
  headers,
  rows,
  tagColumn,
  readOnlyColumns,
  onCellChange,
  onHeaderRename,
  onActiveCellChange,
  activeRowIndex,
  onRowClick,
  onCellDoubleClick,
}: EditableGridProps) {
  const [activeCell, setActiveCell] = useState<{ row: number; col: number } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editingHeader, setEditingHeader] = useState<number | null>(null);
  const [headerEditValue, setHeaderEditValue] = useState("");
  const [colorMode, setColorMode] = useState<GridColorMode>(
    () => (typeof window !== "undefined"
      ? (localStorage.getItem("bp-grid-color-mode") as GridColorMode) || "striped"
      : "striped")
  );
  const [wrapText, setWrapText] = useState(
    () => (typeof window !== "undefined" ? localStorage.getItem("bp-grid-wrap-mode") !== "false" : true)
  );
  const editInputRef = useRef<HTMLInputElement>(null);

  // Persist color mode preference
  useEffect(() => {
    localStorage.setItem("bp-grid-color-mode", colorMode);
  }, [colorMode]);

  // Persist wrap preference
  useEffect(() => {
    localStorage.setItem("bp-grid-wrap-mode", String(wrapText));
  }, [wrapText]);

  // Notify parent when active cell changes (for external highlighting)
  useEffect(() => {
    onActiveCellChange?.(activeCell);
  }, [activeCell, onActiveCellChange]);

  const isReadOnly = useCallback(
    (col: number) => readOnlyColumns?.has(headers[col]) ?? false,
    [headers, readOnlyColumns]
  );

  const startEdit = useCallback(
    (row: number, col: number) => {
      if (isReadOnly(col)) return;
      const header = headers[col];
      setActiveCell({ row, col });
      setEditValue(rows[row]?.[header] ?? "");
      setTimeout(() => editInputRef.current?.focus(), 30);
    },
    [headers, rows, isReadOnly]
  );

  const commitEdit = useCallback(() => {
    if (!activeCell) return;
    const header = headers[activeCell.col];
    const oldValue = rows[activeCell.row]?.[header] ?? "";
    if (editValue !== oldValue) {
      onCellChange(activeCell.row, header, editValue);
    }
  }, [activeCell, editValue, headers, rows, onCellChange]);

  const moveCell = useCallback(
    (dRow: number, dCol: number) => {
      if (!activeCell || headers.length === 0 || rows.length === 0) return;
      commitEdit();
      let { row, col } = activeCell;
      col += dCol;
      if (col >= headers.length) {
        col = 0;
        row++;
      }
      if (col < 0) {
        col = headers.length - 1;
        row--;
      }
      row += dRow;
      if (row >= rows.length) row = 0;
      if (row < 0) row = rows.length - 1;
      // Skip read-only columns in the target direction
      const dir = dCol >= 0 && dRow >= 0 ? 1 : -1;
      let safety = headers.length + 1;
      while (isReadOnly(col) && safety-- > 0) {
        col += dir;
        if (col >= headers.length) { col = 0; row = (row + 1) % rows.length; }
        if (col < 0) { col = headers.length - 1; row = (row - 1 + rows.length) % rows.length; }
      }
      startEdit(row, col);
    },
    [activeCell, headers, rows, commitEdit, startEdit, isReadOnly]
  );

  const handleCellKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Tab") {
        e.preventDefault();
        moveCell(0, e.shiftKey ? -1 : 1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        commitEdit();
        moveCell(1, 0);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setActiveCell(null);
      }
    },
    [moveCell, commitEdit]
  );

  const commitHeaderEdit = useCallback(() => {
    if (editingHeader === null || !onHeaderRename) return;
    const newName = headerEditValue.trim() || `Column ${editingHeader + 1}`;
    if (newName !== headers[editingHeader]) {
      onHeaderRename(editingHeader, newName);
    }
    setEditingHeader(null);
  }, [editingHeader, headerEditValue, headers, onHeaderRename]);

  const getRowBg = useCallback(
    (ri: number): string => {
      if (activeCell?.row === ri || activeRowIndex === ri) return "bg-pink-500/5";
      if (colorMode === "striped") {
        return ri % 2 === 0 ? "bg-amber-500/8" : "bg-violet-500/8";
      }
      return "";
    },
    [activeCell, activeRowIndex, colorMode]
  );

  const getCellBg = useCallback(
    (ri: number, ci: number): string => {
      if (colorMode !== "checkerboard") return "";
      return (ri + ci) % 2 === 0 ? "bg-amber-500/8" : "bg-violet-500/8";
    },
    [colorMode]
  );

  return (
    <div className="overflow-x-auto">
      <div className="flex items-center gap-2 pb-1.5 mb-1 border-b border-[var(--border)]">
        <span className="text-[10px] text-[var(--muted)] uppercase tracking-wide">Shading</span>
        <div className="flex items-center border border-[var(--border)] rounded">
          {(["none", "striped", "checkerboard"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setColorMode(mode)}
              className={`px-2 py-0.5 text-[10px] ${
                colorMode === mode
                  ? "bg-[var(--accent)] text-white"
                  : "text-[var(--muted)] hover:text-[var(--fg)]"
              } ${mode === "none" ? "rounded-l" : mode === "checkerboard" ? "rounded-r" : ""}`}
            >
              {mode === "none" ? "Off" : mode === "striped" ? "Rows" : "Grid"}
            </button>
          ))}
        </div>
        <button
          onClick={() => setWrapText(!wrapText)}
          className={`px-2 py-0.5 text-[10px] rounded border ${
            wrapText
              ? "bg-[var(--accent)] text-white border-[var(--accent)]"
              : "text-[var(--muted)] hover:text-[var(--fg)] border-[var(--border)]"
          }`}
        >
          Wrap
        </button>
      </div>
      <table className="text-[11px] border-collapse w-full">
        <thead>
          <tr>
            <th className="border border-[var(--border)] px-2 py-1.5 bg-[var(--surface)] text-[var(--muted)] w-8 text-center">#</th>
            {headers.map((h, hi) => (
              <th
                key={hi}
                className={`border border-[var(--border)] px-2 py-1.5 text-left font-semibold bg-[var(--surface)] ${
                  onHeaderRename ? "cursor-pointer hover:bg-[var(--surface-hover)]" : ""
                } ${h === tagColumn ? "text-green-400" : "text-[var(--fg)]"}`}
                onDoubleClick={() => {
                  if (!onHeaderRename) return;
                  setEditingHeader(hi);
                  setHeaderEditValue(h);
                }}
              >
                {editingHeader === hi ? (
                  <input
                    type="text"
                    value={headerEditValue}
                    onChange={(e) => setHeaderEditValue(e.target.value)}
                    onBlur={commitHeaderEdit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitHeaderEdit();
                      if (e.key === "Escape") setEditingHeader(null);
                    }}
                    className="w-full bg-transparent border-b border-[var(--accent)] outline-none text-[11px]"
                    autoFocus
                  />
                ) : (
                  h
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr
              key={ri}
              className={`${getRowBg(ri)} ${
                activeCell?.row === ri || activeRowIndex === ri
                  ? ""
                  : onRowClick
                  ? "hover:bg-[var(--surface-hover)] cursor-pointer"
                  : "hover:bg-[var(--surface-hover)]"
              }`}
              onClick={(e) => {
                if (onRowClick && (e.target as HTMLElement).tagName === "TD") onRowClick(ri);
              }}
            >
              <td className="border border-[var(--border)] px-2 py-1 text-[var(--muted)] text-center">{ri + 1}</td>
              {headers.map((h, ci) => {
                const isActive = activeCell?.row === ri && activeCell?.col === ci;
                const ro = isReadOnly(ci);
                return (
                  <td
                    key={ci}
                    className={`border border-[var(--border)] px-2 py-1 ${
                      isActive
                        ? "bg-pink-500/10 outline outline-1 outline-pink-400"
                        : h === tagColumn
                        ? `text-green-300 font-mono ${getCellBg(ri, ci)}`
                        : ro
                        ? "text-[var(--muted)]/60 bg-[var(--surface)]/40"
                        : `text-[var(--muted)] cursor-pointer ${getCellBg(ri, ci)}`
                    }`}
                    onClick={(e) => {
                      if (ro) return;
                      e.stopPropagation();
                      startEdit(ri, ci);
                    }}
                    onDoubleClick={(e) => {
                      if (onCellDoubleClick) {
                        e.stopPropagation();
                        setActiveCell(null);
                        onCellDoubleClick(ri, ci, headers[ci], rows[ri]?.[headers[ci]] || "");
                      }
                    }}
                  >
                    {isActive ? (
                      <input
                        ref={editInputRef}
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={() => {
                          commitEdit();
                          setActiveCell(null);
                        }}
                        onKeyDown={handleCellKeyDown}
                        className="w-full bg-transparent outline-none text-[11px] text-[var(--fg)]"
                      />
                    ) : (
                      <span className={wrapText ? "whitespace-normal break-words block max-w-[300px]" : "truncate block max-w-[200px]"} title={row[h] || ""}>
                        {row[h] || ""}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
