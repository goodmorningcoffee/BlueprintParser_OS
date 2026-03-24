"use client";

import { useState, useMemo } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import { TAKEOFF_SHAPES, TWENTY_COLORS, AREA_UNIT_MAP } from "@/types";
import type {
  TakeoffShape,
  AreaUnit,
  AreaUnitSq,
  ClientAnnotation,
  ClientTakeoffItem,
  AreaPolygonData,
  ScaleCalibrationData,
} from "@/types";
import { computeRealArea } from "@/lib/areaCalc";

// ─── Shape icons for count tab ──────────────────────────────
const SHAPE_ICONS: Record<TakeoffShape, (color: string) => React.ReactNode> = {
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
function ColorDot({ color }: { color: string }) {
  return (
    <span
      className="inline-block w-3 h-3 rounded-full shrink-0"
      style={{ backgroundColor: color }}
    />
  );
}

// ─── AREA_UNITS constant for dropdown ────────────────────────
const AREA_UNITS: AreaUnit[] = ["ft", "in", "m", "cm"];

// ═════════════════════════════════════════════════════════════
//  COUNT TAB
// ═════════════════════════════════════════════════════════════
function CountTab() {
  const annotations = useViewerStore((s) => s.annotations);
  const takeoffItems = useViewerStore((s) => s.takeoffItems);
  const addTakeoffItem = useViewerStore((s) => s.addTakeoffItem);
  const removeTakeoffItem = useViewerStore((s) => s.removeTakeoffItem);
  const updateTakeoffItem = useViewerStore((s) => s.updateTakeoffItem);
  const activeTakeoffItemId = useViewerStore((s) => s.activeTakeoffItemId);
  const setActiveTakeoffItemId = useViewerStore((s) => s.setActiveTakeoffItemId);
  const setAnnotations = useViewerStore((s) => s.setAnnotations);
  const publicId = useViewerStore((s) => s.publicId);
  const isDemo = useViewerStore((s) => s.isDemo);

  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formShape, setFormShape] = useState<TakeoffShape>("circle");
  const [formColor, setFormColor] = useState(TWENTY_COLORS[0]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Filter to count items only (exclude polygon)
  const countItems = useMemo(
    () => takeoffItems.filter((i) => i.shape !== "polygon"),
    [takeoffItems]
  );

  // Count markers per takeoff item
  const counts = useMemo(() => {
    const map: Record<number, { count: number; pages: Set<number> }> = {};
    for (const ann of annotations) {
      if (ann.source !== "takeoff" || !ann.data) continue;
      const itemId = (ann.data as any).takeoffItemId;
      if (!itemId) continue;
      if (!map[itemId]) map[itemId] = { count: 0, pages: new Set() };
      map[itemId].count++;
      map[itemId].pages.add(ann.pageNumber);
    }
    return map;
  }, [annotations]);

  const totalCount = countItems.reduce((sum, item) => sum + (counts[item.id]?.count || 0), 0);

  async function handleCreate() {
    if (!formName.trim()) return;

    if (isDemo) {
      const item = { id: -Date.now(), name: formName.trim(), shape: formShape, color: formColor, sortOrder: countItems.length };
      addTakeoffItem(item);
      setActiveTakeoffItemId(item.id);
      setFormName("");
      setShowForm(false);
      setFormError(null);
      return;
    }

    setCreating(true);
    setFormError(null);

    try {
      const res = await fetch("/api/takeoff-items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: publicId,
          name: formName.trim(),
          shape: formShape,
          color: formColor,
        }),
      });

      if (res.ok) {
        const item = await res.json();
        addTakeoffItem(item);
        setFormName("");
        setShowForm(false);
        setFormError(null);
        setActiveTakeoffItemId(item.id);
      } else {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setFormError(err.error || `Failed (${res.status})`);
      }
    } catch (err) {
      setFormError("Network error — is the server running?");
      console.error("Failed to create takeoff item:", err);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(item: ClientTakeoffItem) {
    if (isDemo) {
      removeTakeoffItem(item.id);
      setAnnotations(
        annotations.filter(
          (a) => !(a.source === "takeoff" && (a.data as any)?.takeoffItemId === item.id)
        )
      );
      if (activeTakeoffItemId === item.id) setActiveTakeoffItemId(null);
      return;
    }

    try {
      const res = await fetch(`/api/takeoff-items/${item.id}`, { method: "DELETE" });
      if (res.ok) {
        removeTakeoffItem(item.id);
        setAnnotations(
          annotations.filter(
            (a) => !(a.source === "takeoff" && (a.data as any)?.takeoffItemId === item.id)
          )
        );
        if (activeTakeoffItemId === item.id) setActiveTakeoffItemId(null);
      }
    } catch (err) {
      console.error("Failed to delete takeoff item:", err);
    }
  }

  async function handleRename(item: ClientTakeoffItem, newName: string) {
    if (!newName.trim() || newName === item.name) {
      setEditingId(null);
      return;
    }

    if (isDemo) {
      updateTakeoffItem(item.id, { name: newName.trim() });
      setAnnotations(
        annotations.map((a) =>
          a.source === "takeoff" && (a.data as any)?.takeoffItemId === item.id
            ? { ...a, name: newName.trim() }
            : a
        )
      );
      setEditingId(null);
      return;
    }

    try {
      const res = await fetch(`/api/takeoff-items/${item.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (res.ok) {
        updateTakeoffItem(item.id, { name: newName.trim() });
        setAnnotations(
          annotations.map((a) =>
            a.source === "takeoff" && (a.data as any)?.takeoffItemId === item.id
              ? { ...a, name: newName.trim() }
              : a
          )
        );
      }
    } catch (err) {
      console.error("Failed to rename:", err);
    }
    setEditingId(null);
  }

  return (
    <>
      {/* Item list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {countItems.map((item) => {
          const c = counts[item.id];
          const isActive = activeTakeoffItemId === item.id;

          return (
            <div
              key={item.id}
              onClick={() => setActiveTakeoffItemId(isActive ? null : item.id)}
              className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer group transition-colors ${
                isActive
                  ? "ring-1 ring-[var(--accent)]"
                  : "hover:bg-[var(--surface-hover)]"
              }`}
              style={isActive ? { backgroundColor: item.color + "20" } : undefined}
            >
              {SHAPE_ICONS[item.shape as TakeoffShape]?.(item.color)}

              {editingId === item.id ? (
                <input
                  autoFocus
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={() => handleRename(item, editName)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRename(item, editName);
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="flex-1 bg-transparent border-b border-[var(--accent)] text-xs outline-none px-0.5"
                />
              ) : (
                <span
                  className="flex-1 text-xs truncate"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setEditingId(item.id);
                    setEditName(item.name);
                  }}
                >
                  {item.name}
                </span>
              )}

              <span className="text-xs font-medium tabular-nums" style={{ color: item.color }}>
                {c?.count || 0}
              </span>

              {c && c.pages.size > 0 && (
                <span className="text-[10px] text-[var(--muted)]">
                  {c.pages.size}pg
                </span>
              )}

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(item);
                }}
                className="text-[10px] text-[var(--muted)] opacity-0 group-hover:opacity-100 hover:text-red-400"
                title="Delete item and all markers"
              >
                x
              </button>
            </div>
          );
        })}

        {countItems.length === 0 && !showForm && (
          <div className="text-xs text-[var(--muted)] text-center py-4">
            No count items yet.
            <br />
            Add one below to start counting.
          </div>
        )}
      </div>

      {/* Total */}
      {countItems.length > 0 && (
        <div className="px-3 py-1.5 text-[10px] text-[var(--muted)] border-t border-[var(--border)]">
          {totalCount} total across {countItems.length} items
        </div>
      )}

      {/* Add form / button */}
      <div className="p-2 border-t border-[var(--border)]">
        {showForm ? (
          <div className="space-y-2">
            <input
              autoFocus
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") setShowForm(false);
              }}
              placeholder="Item name..."
              className="w-full px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]"
            />

            {/* Shape picker */}
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-[var(--muted)] w-10">Shape</span>
              {TAKEOFF_SHAPES.map((s) => (
                <button
                  key={s}
                  onClick={() => setFormShape(s)}
                  className={`p-1 rounded ${
                    formShape === s ? "ring-1 ring-[var(--accent)] bg-[var(--surface)]" : ""
                  }`}
                  title={s}
                >
                  {SHAPE_ICONS[s](formShape === s ? formColor : "#666")}
                </button>
              ))}
            </div>

            {/* Color picker */}
            <div className="flex items-center gap-0.5 flex-wrap">
              <span className="text-[10px] text-[var(--muted)] w-10">Color</span>
              {TWENTY_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setFormColor(c)}
                  className={`w-4 h-4 rounded-sm ${
                    formColor === c ? "ring-1 ring-white ring-offset-1 ring-offset-[#1e1e22]" : ""
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>

            {/* Error feedback */}
            {formError && (
              <div className="text-[10px] text-red-400 px-1">{formError}</div>
            )}

            {/* Preview + actions */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                {SHAPE_ICONS[formShape](formColor)}
                <span className="text-xs">{formName || "Preview"}</span>
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => { setShowForm(false); setFormError(null); }}
                  className="text-xs px-2 py-0.5 text-[var(--muted)] hover:text-[var(--fg)]"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreate}
                  disabled={!formName.trim() || creating}
                  className="text-xs px-2 py-0.5 rounded bg-[var(--accent)] text-white disabled:opacity-40"
                >
                  {creating ? "..." : "Create"}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowForm(true)}
            className={`w-full text-xs py-1.5 rounded border ${
              countItems.length === 0
                ? "chat-pulse"
                : "border-dashed border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--accent)]"
            }`}
          >
            + Add Count Item
          </button>
        )}
      </div>
    </>
  );
}

// ═════════════════════════════════════════════════════════════
//  CALIBRATION INPUT (inline in ScaleStatus)
// ═════════════════════════════════════════════════════════════
function CalibrationInput() {
  const pageNumber = useViewerStore((s) => s.pageNumber);
  const calibrationPoints = useViewerStore((s) => s.calibrationPoints);
  const setScaleCalibration = useViewerStore((s) => s.setScaleCalibration);
  const resetCalibration = useViewerStore((s) => s.resetCalibration);
  const annotations = useViewerStore((s) => s.annotations);
  const setAnnotations = useViewerStore((s) => s.setAnnotations);
  const publicId = useViewerStore((s) => s.publicId);
  const isDemo = useViewerStore((s) => s.isDemo);

  const [distance, setDistance] = useState("");
  const [unit, setUnit] = useState<AreaUnit>("ft");
  const [saving, setSaving] = useState(false);

  async function handleOk() {
    const dist = parseFloat(distance);
    if (!dist || dist <= 0 || !calibrationPoints.p1 || !calibrationPoints.p2) return;

    setSaving(true);
    const cal: ScaleCalibrationData = {
      type: "scale-calibration",
      point1: calibrationPoints.p1,
      point2: calibrationPoints.p2,
      realDistance: dist,
      unit,
    };

    if (isDemo) {
      setScaleCalibration(pageNumber, cal);
      const tempAnn: ClientAnnotation = {
        id: -Date.now(),
        pageNumber,
        name: `Scale (pg ${pageNumber})`,
        bbox: [0, 0, 0, 0],
        note: null,
        source: "takeoff-scale",
        data: cal as unknown as Record<string, unknown>,
      };
      setAnnotations([
        ...annotations.filter(
          (a) => !(a.source === "takeoff-scale" && a.pageNumber === pageNumber)
        ),
        tempAnn,
      ]);
      resetCalibration();
      setSaving(false);
      return;
    }

    try {
      // Persist as annotation via POST /api/annotations
      // Remove any existing scale annotation for this page first
      const existingScaleAnns = annotations.filter(
        (a) => a.source === "takeoff-scale" && a.pageNumber === pageNumber
      );

      for (const ann of existingScaleAnns) {
        await fetch(`/api/annotations/${ann.id}`, { method: "DELETE" });
      }

      const res = await fetch("/api/annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: publicId,
          pageNumber,
          name: `Scale (pg ${pageNumber})`,
          bbox: [0, 0, 0, 0],
          note: null,
          source: "takeoff-scale",
          data: cal,
        }),
      });

      if (res.ok) {
        const saved = await res.json();
        // Update annotations in store: remove old scale anns for this page, add new
        setAnnotations([
          ...annotations.filter(
            (a) => !(a.source === "takeoff-scale" && a.pageNumber === pageNumber)
          ),
          saved,
        ]);
        setScaleCalibration(pageNumber, cal);
        resetCalibration();
      } else {
        console.error("Failed to save scale calibration:", res.status);
      }
    } catch (err) {
      console.error("Failed to save scale calibration:", err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-1.5 mt-1.5">
      <input
        autoFocus
        type="number"
        min="0"
        step="any"
        value={distance}
        onChange={(e) => setDistance(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleOk();
          if (e.key === "Escape") resetCalibration();
        }}
        placeholder="Distance..."
        className="w-20 px-1.5 py-0.5 text-xs bg-[var(--bg)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]"
      />
      <select
        value={unit}
        onChange={(e) => setUnit(e.target.value as AreaUnit)}
        className="px-1 py-0.5 text-xs bg-[var(--bg)] border border-[var(--border)] rounded focus:outline-none"
      >
        {AREA_UNITS.map((u) => (
          <option key={u} value={u}>{u}</option>
        ))}
      </select>
      <button
        onClick={handleOk}
        disabled={!distance || parseFloat(distance) <= 0 || saving}
        className="text-xs px-2 py-0.5 rounded bg-[var(--accent)] text-white disabled:opacity-40"
      >
        {saving ? "..." : "OK"}
      </button>
      <button
        onClick={resetCalibration}
        className="text-xs px-1.5 py-0.5 text-[var(--muted)] hover:text-[var(--fg)]"
      >
        Cancel
      </button>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
//  SCALE STATUS (top of area tab)
// ═════════════════════════════════════════════════════════════
function ScaleStatus() {
  const pageNumber = useViewerStore((s) => s.pageNumber);
  const scaleCalibrations = useViewerStore((s) => s.scaleCalibrations);
  const calibrationMode = useViewerStore((s) => s.calibrationMode);
  const setCalibrationMode = useViewerStore((s) => s.setCalibrationMode);
  const resetCalibration = useViewerStore((s) => s.resetCalibration);

  const hasScale = !!scaleCalibrations[pageNumber];

  // Calibration in progress
  if (calibrationMode !== "idle") {
    return (
      <div className="px-2 py-2 border-b border-[var(--border)]">
        <div className="text-xs text-amber-400">
          {calibrationMode === "point1" && "Click first point on a known dimension..."}
          {calibrationMode === "point2" && "Click second point..."}
          {calibrationMode === "input" && "Enter the real-world distance:"}
        </div>
        {calibrationMode === "input" && <CalibrationInput />}
        {calibrationMode !== "input" && (
          <button
            onClick={resetCalibration}
            className="text-[10px] text-[var(--muted)] hover:text-[var(--fg)] mt-1"
          >
            Cancel
          </button>
        )}
      </div>
    );
  }

  // Scale set
  if (hasScale) {
    return (
      <div className="px-2 py-2 border-b border-[var(--border)] flex items-center justify-between">
        <span className="text-xs text-green-400">
          Scale: set (pg {pageNumber}) &#10003;
        </span>
        <button
          onClick={() => { resetCalibration(); setCalibrationMode("point1"); }}
          className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--accent)]"
        >
          Recalibrate
        </button>
      </div>
    );
  }

  // No scale
  return (
    <div className="px-2 py-2 border-b border-[var(--border)]">
      <button
        onClick={() => setCalibrationMode("point1")}
        className="w-full text-xs py-1.5 rounded border border-dashed border-amber-500/60 text-amber-400 hover:border-amber-400 hover:text-amber-300 transition-colors"
      >
        Set Scale
      </button>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
//  AREA TAB
// ═════════════════════════════════════════════════════════════
function AreaTab() {
  const annotations = useViewerStore((s) => s.annotations);
  const takeoffItems = useViewerStore((s) => s.takeoffItems);
  const addTakeoffItem = useViewerStore((s) => s.addTakeoffItem);
  const removeTakeoffItem = useViewerStore((s) => s.removeTakeoffItem);
  const updateTakeoffItem = useViewerStore((s) => s.updateTakeoffItem);
  const activeTakeoffItemId = useViewerStore((s) => s.activeTakeoffItemId);
  const setActiveTakeoffItemId = useViewerStore((s) => s.setActiveTakeoffItemId);
  const setAnnotations = useViewerStore((s) => s.setAnnotations);
  const publicId = useViewerStore((s) => s.publicId);
  const pageDimensions = useViewerStore((s) => s.pageDimensions);
  const scaleCalibrations = useViewerStore((s) => s.scaleCalibrations);
  const isDemo = useViewerStore((s) => s.isDemo);

  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formColor, setFormColor] = useState(TWENTY_COLORS[0]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Filter to polygon / area items only
  const areaItems = useMemo(
    () => takeoffItems.filter((i) => i.shape === "polygon"),
    [takeoffItems]
  );

  // Compute per-item area summaries from annotations
  const areaSummaries = useMemo(() => {
    const map: Record<number, { totalArea: number; polyCount: number; pages: Set<number>; hasCalibration: boolean }> = {};

    for (const ann of annotations) {
      if (ann.source !== "takeoff" || !ann.data) continue;
      const data = ann.data as any;
      if (data.type !== "area-polygon") continue;
      const itemId = data.takeoffItemId as number;
      if (!itemId) continue;

      if (!map[itemId]) map[itemId] = { totalArea: 0, polyCount: 0, pages: new Set(), hasCalibration: true };
      map[itemId].polyCount++;
      map[itemId].pages.add(ann.pageNumber);

      const vertices = (data as AreaPolygonData).vertices;
      const dim = pageDimensions[ann.pageNumber];
      const cal = scaleCalibrations[ann.pageNumber];

      if (vertices && dim && cal) {
        const area = computeRealArea(vertices, dim.width, dim.height, cal);
        map[itemId].totalArea += area;
      } else {
        map[itemId].hasCalibration = false;
      }
    }

    return map;
  }, [annotations, pageDimensions, scaleCalibrations]);

  // Determine display unit from first available calibration
  const displayUnit: AreaUnitSq = useMemo(() => {
    const cals = Object.values(scaleCalibrations);
    if (cals.length > 0) return AREA_UNIT_MAP[cals[0].unit];
    return "SF";
  }, [scaleCalibrations]);

  const totalArea = areaItems.reduce((sum, item) => {
    const s = areaSummaries[item.id];
    return sum + (s?.totalArea || 0);
  }, 0);

  const anyMissingCalibration = areaItems.some((item) => {
    const s = areaSummaries[item.id];
    return s && !s.hasCalibration;
  });

  async function handleCreate() {
    if (!formName.trim()) return;

    if (isDemo) {
      const item = { id: -Date.now(), name: formName.trim(), shape: "polygon" as const, color: formColor, sortOrder: areaItems.length };
      addTakeoffItem(item);
      setActiveTakeoffItemId(item.id);
      setFormName("");
      setShowForm(false);
      setFormError(null);
      return;
    }

    setCreating(true);
    setFormError(null);

    try {
      const res = await fetch("/api/takeoff-items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: publicId,
          name: formName.trim(),
          shape: "polygon",
          color: formColor,
        }),
      });

      if (res.ok) {
        const item = await res.json();
        addTakeoffItem(item);
        setFormName("");
        setShowForm(false);
        setFormError(null);
        setActiveTakeoffItemId(item.id);
      } else {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setFormError(err.error || `Failed (${res.status})`);
      }
    } catch (err) {
      setFormError("Network error — is the server running?");
      console.error("Failed to create area item:", err);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(item: ClientTakeoffItem) {
    if (isDemo) {
      removeTakeoffItem(item.id);
      setAnnotations(
        annotations.filter(
          (a) => !(a.source === "takeoff" && (a.data as any)?.takeoffItemId === item.id)
        )
      );
      if (activeTakeoffItemId === item.id) setActiveTakeoffItemId(null);
      return;
    }

    try {
      const res = await fetch(`/api/takeoff-items/${item.id}`, { method: "DELETE" });
      if (res.ok) {
        removeTakeoffItem(item.id);
        setAnnotations(
          annotations.filter(
            (a) => !(a.source === "takeoff" && (a.data as any)?.takeoffItemId === item.id)
          )
        );
        if (activeTakeoffItemId === item.id) setActiveTakeoffItemId(null);
      }
    } catch (err) {
      console.error("Failed to delete area item:", err);
    }
  }

  async function handleRename(item: ClientTakeoffItem, newName: string) {
    if (!newName.trim() || newName === item.name) {
      setEditingId(null);
      return;
    }

    if (isDemo) {
      updateTakeoffItem(item.id, { name: newName.trim() });
      setAnnotations(
        annotations.map((a) =>
          a.source === "takeoff" && (a.data as any)?.takeoffItemId === item.id
            ? { ...a, name: newName.trim() }
            : a
        )
      );
      setEditingId(null);
      return;
    }

    try {
      const res = await fetch(`/api/takeoff-items/${item.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (res.ok) {
        updateTakeoffItem(item.id, { name: newName.trim() });
        setAnnotations(
          annotations.map((a) =>
            a.source === "takeoff" && (a.data as any)?.takeoffItemId === item.id
              ? { ...a, name: newName.trim() }
              : a
          )
        );
      }
    } catch (err) {
      console.error("Failed to rename:", err);
    }
    setEditingId(null);
  }

  function formatArea(val: number | undefined, hasCal: boolean): string {
    if (!hasCal || val === undefined) return `-- ${displayUnit}`;
    return `${val.toFixed(1)} ${displayUnit}`;
  }

  return (
    <>
      {/* Scale status */}
      <ScaleStatus />

      {/* Item list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {areaItems.map((item) => {
          const s = areaSummaries[item.id];
          const isActive = activeTakeoffItemId === item.id;

          return (
            <div
              key={item.id}
              onClick={() => setActiveTakeoffItemId(isActive ? null : item.id)}
              className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer group transition-colors ${
                isActive
                  ? "ring-1 ring-[var(--accent)]"
                  : "hover:bg-[var(--surface-hover)]"
              }`}
              style={isActive ? { backgroundColor: item.color + "20" } : undefined}
            >
              <ColorDot color={item.color} />

              {editingId === item.id ? (
                <input
                  autoFocus
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={() => handleRename(item, editName)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRename(item, editName);
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="flex-1 bg-transparent border-b border-[var(--accent)] text-xs outline-none px-0.5"
                />
              ) : (
                <span
                  className="flex-1 text-xs truncate"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setEditingId(item.id);
                    setEditName(item.name);
                  }}
                >
                  {item.name}
                </span>
              )}

              <span className="text-xs font-medium tabular-nums" style={{ color: item.color }}>
                {formatArea(s?.totalArea, s?.hasCalibration !== false)}
              </span>

              {s && s.polyCount > 0 && (
                <span className="text-[10px] text-[var(--muted)]">
                  {s.polyCount}p {s.pages.size}pg
                </span>
              )}

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(item);
                }}
                className="text-[10px] text-[var(--muted)] opacity-0 group-hover:opacity-100 hover:text-red-400"
                title="Delete item and all polygons"
              >
                x
              </button>
            </div>
          );
        })}

        {areaItems.length === 0 && !showForm && (
          <div className="text-xs text-[var(--muted)] text-center py-4">
            No area items yet.
            <br />
            Set scale, then add an item below.
          </div>
        )}
      </div>

      {/* Total */}
      {areaItems.length > 0 && (
        <div className="px-3 py-1.5 text-[10px] text-[var(--muted)] border-t border-[var(--border)]">
          {anyMissingCalibration
            ? `-- ${displayUnit} total (missing calibration on some pages)`
            : `${totalArea.toFixed(1)} ${displayUnit} total across ${areaItems.length} items`}
        </div>
      )}

      {/* Add form / button */}
      <div className="p-2 border-t border-[var(--border)]">
        {showForm ? (
          <div className="space-y-2">
            <input
              autoFocus
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") setShowForm(false);
              }}
              placeholder="Area item name..."
              className="w-full px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]"
            />

            {/* Color picker (no shape picker — always polygon) */}
            <div className="flex items-center gap-0.5 flex-wrap">
              <span className="text-[10px] text-[var(--muted)] w-10">Color</span>
              {TWENTY_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setFormColor(c)}
                  className={`w-4 h-4 rounded-sm ${
                    formColor === c ? "ring-1 ring-white ring-offset-1 ring-offset-[#1e1e22]" : ""
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>

            {/* Error feedback */}
            {formError && (
              <div className="text-[10px] text-red-400 px-1">{formError}</div>
            )}

            {/* Preview + actions */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <ColorDot color={formColor} />
                <span className="text-xs">{formName || "Preview"}</span>
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => { setShowForm(false); setFormError(null); }}
                  className="text-xs px-2 py-0.5 text-[var(--muted)] hover:text-[var(--fg)]"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreate}
                  disabled={!formName.trim() || creating}
                  className="text-xs px-2 py-0.5 rounded bg-[var(--accent)] text-white disabled:opacity-40"
                >
                  {creating ? "..." : "Create"}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowForm(true)}
            className={`w-full text-xs py-1.5 rounded border ${
              areaItems.length === 0
                ? "chat-pulse"
                : "border-dashed border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--accent)]"
            }`}
          >
            + Add Area Item
          </button>
        )}
      </div>
    </>
  );
}

// ═════════════════════════════════════════════════════════════
//  MAIN PANEL
// ═════════════════════════════════════════════════════════════
export default function TakeoffPanel() {
  const takeoffTab = useViewerStore((s) => s.takeoffTab);
  const setTakeoffTab = useViewerStore((s) => s.setTakeoffTab);
  const annotations = useViewerStore((s) => s.annotations);
  const takeoffItems = useViewerStore((s) => s.takeoffItems);
  const pageDimensions = useViewerStore((s) => s.pageDimensions);
  const scaleCalibrations = useViewerStore((s) => s.scaleCalibrations);

  // ─── CSV export (both count + area) ─────────────────────
  function exportCSV() {
    const rows: string[] = [];

    for (const item of takeoffItems) {
      const isArea = item.shape === "polygon";

      if (isArea) {
        // Area item: compute total from annotations
        let totalArea = 0;
        const pages = new Set<number>();
        let hasCal = true;

        for (const ann of annotations) {
          if (ann.source !== "takeoff" || !ann.data) continue;
          const data = ann.data as any;
          if (data.type !== "area-polygon" || data.takeoffItemId !== item.id) continue;
          pages.add(ann.pageNumber);

          const vertices = (data as AreaPolygonData).vertices;
          const dim = pageDimensions[ann.pageNumber];
          const cal = scaleCalibrations[ann.pageNumber];
          if (vertices && dim && cal) {
            totalArea += computeRealArea(vertices, dim.width, dim.height, cal);
          } else {
            hasCal = false;
          }
        }

        // Determine unit from first calibration
        const cals = Object.values(scaleCalibrations);
        const unitSq: AreaUnitSq = cals.length > 0 ? AREA_UNIT_MAP[cals[0].unit] : "SF";

        rows.push(
          `"${item.name.replace(/"/g, '""')}",area,polygon,${item.color},${hasCal ? totalArea.toFixed(1) : ""},${unitSq},"${Array.from(pages).sort((a, b) => a - b).join("; ")}"`
        );
      } else {
        // Count item: count markers
        let count = 0;
        const pages = new Set<number>();
        for (const ann of annotations) {
          if (ann.source !== "takeoff" || !ann.data) continue;
          const data = ann.data as any;
          if (data.takeoffItemId !== item.id) continue;
          if (data.type === "area-polygon") continue;
          count++;
          pages.add(ann.pageNumber);
        }

        rows.push(
          `"${item.name.replace(/"/g, '""')}",count,${item.shape},${item.color},${count},EA,"${Array.from(pages).sort((a, b) => a - b).join("; ")}"`
        );
      }
    }

    const csv = ["Item Name,Type,Shape,Color,Quantity,Unit,Pages", ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "takeoff.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div
      className="w-80 shrink-0 border-l border-[var(--border)] flex flex-col"
      style={{ backgroundColor: "#1e1e22" }}
    >
      {/* Header */}
      <div className="p-3 border-b border-[var(--border)] flex items-center justify-between">
        <span className="text-sm font-medium">Quantity Takeoff</span>
        <button
          onClick={exportCSV}
          className="text-xs px-2 py-0.5 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--accent)]"
          title="Export CSV"
        >
          CSV
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[var(--border)]">
        <button
          onClick={() => setTakeoffTab("count")}
          className={`flex-1 text-xs py-2 text-center transition-colors ${
            takeoffTab === "count"
              ? "text-[var(--fg)] border-b-2 border-[var(--accent)]"
              : "text-[var(--muted)] hover:text-[var(--fg)]"
          }`}
        >
          Count (EA)
        </button>
        <button
          onClick={() => setTakeoffTab("area")}
          className={`flex-1 text-xs py-2 text-center transition-colors ${
            takeoffTab === "area"
              ? "text-[var(--fg)] border-b-2 border-[var(--accent)]"
              : "text-[var(--muted)] hover:text-[var(--fg)]"
          }`}
        >
          Area (SF)
        </button>
      </div>

      {/* Tab content */}
      {takeoffTab === "count" ? <CountTab /> : <AreaTab />}
    </div>
  );
}
