"use client";

import { useState } from "react";
import { DEFAULT_GRID } from "@/lib/csi-spatial";
import { CSI_GRID_MAX, CSI_GRID_MIN, CSI_GRID_PRESETS, isValidCsiGridDim } from "@/lib/csi-spatial-grid-limits";

type Grid = { rows: number; cols: number };

/** Preset square grids (3x3 … 27x27) or a custom rows × cols, each 1–27. Key it on the saved grid so inputs reset on change. */
export default function CsiSpatialGridPicker({ value, onChange }: { value?: Grid; onChange: (grid: Grid) => void }) {
  const grid = value ?? DEFAULT_GRID;
  const isPreset = grid.rows === grid.cols && (CSI_GRID_PRESETS as readonly number[]).includes(grid.rows);
  const [custom, setCustom] = useState(!isPreset);
  const [rows, setRows] = useState(String(grid.rows));
  const [cols, setCols] = useState(String(grid.cols));

  const r = Number(rows);
  const c = Number(cols);
  const valid = isValidCsiGridDim(r) && isValidCsiGridDim(c);
  const dirty = r !== grid.rows || c !== grid.cols;
  const inputCls = "w-12 text-center text-xs px-1 py-1 rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)]";

  return (
    <div className="flex items-center gap-2">
      <select
        aria-label="CSI spatial grid size"
        value={custom ? "custom" : String(grid.rows)}
        onChange={(e) => {
          if (e.target.value === "custom") return setCustom(true);
          setCustom(false);
          const n = parseInt(e.target.value, 10);
          onChange({ rows: n, cols: n });
        }}
        className="w-24 text-center text-xs px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)]"
      >
        {CSI_GRID_PRESETS.map((n) => (
          <option key={n} value={n}>{n}x{n}</option>
        ))}
        <option value="custom">Custom…</option>
      </select>
      {custom && (
        <>
          <input aria-label="Grid rows" type="number" min={CSI_GRID_MIN} max={CSI_GRID_MAX} step={1} value={rows} onChange={(e) => setRows(e.target.value)} className={inputCls} />
          <span className="text-xs text-[var(--muted)]">×</span>
          <input aria-label="Grid columns" type="number" min={CSI_GRID_MIN} max={CSI_GRID_MAX} step={1} value={cols} onChange={(e) => setCols(e.target.value)} className={inputCls} />
          <button
            type="button"
            disabled={!valid || !dirty}
            onClick={() => onChange({ rows: r, cols: c })}
            className="text-xs px-2 py-1 rounded border border-[var(--border)] disabled:opacity-40"
          >
            Apply
          </button>
          {!valid && <span className="text-[10px] text-red-400">{CSI_GRID_MIN}–{CSI_GRID_MAX}</span>}
        </>
      )}
    </div>
  );
}
