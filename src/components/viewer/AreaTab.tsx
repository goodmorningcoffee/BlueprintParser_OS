"use client";

import { useState, useMemo, useCallback } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import { TWENTY_COLORS, AREA_UNIT_MAP } from "@/types";
import type { AreaUnitSq, ClientTakeoffItem, AreaPolygonData, TakeoffGroup } from "@/types";
import { computeRealArea } from "@/lib/areaCalc";
import { ColorDot, TakeoffEditPanel } from "./TakeoffShared";
import CalibrationInput from "./CalibrationInput";
import TakeoffGroupSection from "./TakeoffGroupSection";

// ─── Scale status bar (top of area tab) ─────────────────────
function ScaleStatus() {
  const pageNumber = useViewerStore((s) => s.pageNumber);
  const scaleCalibrations = useViewerStore((s) => s.scaleCalibrations);
  const calibrationMode = useViewerStore((s) => s.calibrationMode);
  const setCalibrationMode = useViewerStore((s) => s.setCalibrationMode);
  const resetCalibration = useViewerStore((s) => s.resetCalibration);

  const hasScale = !!scaleCalibrations[pageNumber];

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
          <button onClick={resetCalibration} className="text-[10px] text-[var(--muted)] hover:text-[var(--fg)] mt-1">Cancel</button>
        )}
      </div>
    );
  }

  if (hasScale) {
    return (
      <div className="px-2 py-2 border-b border-[var(--border)] flex items-center justify-between">
        <span className="text-xs text-green-400">Scale: set (pg {pageNumber}) &#10003;</span>
        <button
          onClick={() => { resetCalibration(); setCalibrationMode("point1"); }}
          className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--accent)]"
        >
          Recalibrate
        </button>
      </div>
    );
  }

  return (
    <div className="px-2 py-2 border-b border-[var(--border)]">
      <button
        onClick={() => setCalibrationMode("point1")}
        className="w-full text-xs py-1.5 rounded border border-dashed border-amber-500/40 text-amber-400/80 bg-amber-400/5 hover:border-amber-400/60 hover:text-amber-300 hover:bg-amber-400/10 transition-colors"
      >
        Set Scale
      </button>
    </div>
  );
}

// ─── Area tab main component ────────────────────────────────
export default function AreaTab() {
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
  const takeoffGroups = useViewerStore((s) => s.takeoffGroups);
  const addTakeoffGroup = useViewerStore((s) => s.addTakeoffGroup);
  const removeTakeoffGroup = useViewerStore((s) => s.removeTakeoffGroup);
  const updateTakeoffGroup = useViewerStore((s) => s.updateTakeoffGroup);

  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formColor, setFormColor] = useState(TWENTY_COLORS[0]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editPanelId, setEditPanelId] = useState<number | null>(null);
  const [showGroupForm, setShowGroupForm] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const areaItems = useMemo(() => takeoffItems.filter((i) => i.shape === "polygon"), [takeoffItems]);
  const areaGroups = useMemo(() => takeoffGroups.filter((g) => g.kind === "area"), [takeoffGroups]);

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
        map[itemId].totalArea += computeRealArea(vertices, dim.width, dim.height, cal);
      } else {
        map[itemId].hasCalibration = false;
      }
    }
    return map;
  }, [annotations, pageDimensions, scaleCalibrations]);

  const displayUnit: AreaUnitSq = useMemo(() => {
    const cals = Object.values(scaleCalibrations);
    if (cals.length > 0) return AREA_UNIT_MAP[cals[0].unit];
    return "SF";
  }, [scaleCalibrations]);

  const totalArea = areaItems.reduce((sum, item) => sum + (areaSummaries[item.id]?.totalArea || 0), 0);
  const anyMissingCalibration = areaItems.some((item) => { const s = areaSummaries[item.id]; return s && !s.hasCalibration; });

  async function handleCreate() {
    if (!formName.trim()) return;
    if (isDemo) {
      const item = { id: -Date.now(), name: formName.trim(), shape: "polygon" as const, color: formColor, size: 10, sortOrder: areaItems.length };
      addTakeoffItem(item);
      setActiveTakeoffItemId(item.id);
      setFormName(""); setShowForm(false); setFormError(null);
      return;
    }
    setCreating(true); setFormError(null);
    try {
      const res = await fetch("/api/takeoff-items", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: publicId, name: formName.trim(), shape: "polygon", color: formColor }),
      });
      if (res.ok) {
        const item = await res.json();
        addTakeoffItem(item); setFormName(""); setShowForm(false); setFormError(null); setActiveTakeoffItemId(item.id);
      } else {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setFormError(err.error || `Failed (${res.status})`);
      }
    } catch (err) { setFormError("Network error"); console.error("Failed to create area item:", err); }
    finally { setCreating(false); }
  }

  async function handleDelete(item: ClientTakeoffItem) {
    if (isDemo) {
      removeTakeoffItem(item.id);
      setAnnotations(annotations.filter((a) => !(a.source === "takeoff" && String((a.data as any)?.takeoffItemId) === String(item.id))));
      if (activeTakeoffItemId === item.id) setActiveTakeoffItemId(null);
      return;
    }
    try {
      const res = await fetch(`/api/takeoff-items/${item.id}`, { method: "DELETE" });
      if (res.ok) {
        removeTakeoffItem(item.id);
        setAnnotations(annotations.filter((a) => !(a.source === "takeoff" && String((a.data as any)?.takeoffItemId) === String(item.id))));
        if (activeTakeoffItemId === item.id) setActiveTakeoffItemId(null);
      }
    } catch (err) { console.error("Failed to delete area item:", err); }
  }

  async function handleRename(item: ClientTakeoffItem, newName: string) {
    if (!newName.trim() || newName === item.name) { setEditingId(null); return; }
    if (isDemo) {
      updateTakeoffItem(item.id, { name: newName.trim() });
      setAnnotations(annotations.map((a) => a.source === "takeoff" && (a.data as any)?.takeoffItemId === item.id ? { ...a, name: newName.trim() } : a));
      setEditingId(null); return;
    }
    try {
      const res = await fetch(`/api/takeoff-items/${item.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: newName.trim() }) });
      if (res.ok) {
        updateTakeoffItem(item.id, { name: newName.trim() });
        setAnnotations(annotations.map((a) => a.source === "takeoff" && (a.data as any)?.takeoffItemId === item.id ? { ...a, name: newName.trim() } : a));
      }
    } catch (err) { console.error("Failed to rename:", err); }
    setEditingId(null);
  }

  async function handleCreateGroup() {
    const name = newGroupName.trim();
    if (!name) return;
    if (isDemo) {
      const g: TakeoffGroup = { id: -Date.now(), name, kind: "area", color: null, csiCode: null, sortOrder: areaGroups.length };
      addTakeoffGroup(g);
      setNewGroupName(""); setShowGroupForm(false);
      return;
    }
    try {
      const res = await fetch("/api/takeoff-groups", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: publicId, name, kind: "area" }),
      });
      if (res.ok) {
        const g = await res.json();
        addTakeoffGroup(g);
        setNewGroupName(""); setShowGroupForm(false);
      }
    } catch (err) { console.error("Failed to create group:", err); }
  }

  async function handleRenameGroup(id: number, name: string) {
    updateTakeoffGroup(id, { name });
    if (isDemo) return;
    try {
      await fetch(`/api/takeoff-groups/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
    } catch (err) { console.error("Failed to rename group:", err); }
  }

  async function handleDeleteGroup(id: number) {
    removeTakeoffGroup(id);
    if (isDemo) return;
    try {
      await fetch(`/api/takeoff-groups/${id}`, { method: "DELETE" });
    } catch (err) { console.error("Failed to delete group:", err); }
  }

  const handleMoveItem = useCallback(async (itemId: number, targetGroupId: number | null) => {
    updateTakeoffItem(itemId, { groupId: targetGroupId });
    if (isDemo) return;
    try {
      await fetch(`/api/takeoff-items/${itemId}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId: targetGroupId }),
      });
    } catch (err) { console.error("Failed to move item:", err); }
  }, [isDemo, updateTakeoffItem]);

  const toggleCollapsed = (key: string) => setCollapsedGroups((s) => ({ ...s, [key]: !s[key] }));

  const byGroup: Record<number, ClientTakeoffItem[]> = {};
  for (const g of areaGroups) byGroup[g.id] = [];
  const ungrouped: ClientTakeoffItem[] = [];
  for (const item of areaItems) {
    if (item.groupId != null && byGroup[item.groupId]) byGroup[item.groupId].push(item);
    else ungrouped.push(item);
  }

  function formatArea(val: number | undefined, hasCal: boolean): string {
    if (!hasCal || val === undefined) return `-- ${displayUnit}`;
    return `${val.toFixed(1)} ${displayUnit}`;
  }

  const renderAreaItem = (item: ClientTakeoffItem, moveDropdown: React.ReactNode) => {
    const s = areaSummaries[item.id];
    const isActive = activeTakeoffItemId === item.id;
    return (
      <div>
        <div
          onClick={() => {
            setActiveTakeoffItemId(isActive ? null : item.id);
            const store = useViewerStore.getState();
            if (isActive) { store.setTakeoffFilter(null); } else { store.setTakeoffFilter(item.id); }
          }}
          className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer group transition-colors ${isActive ? "ring-1 ring-[var(--accent)]" : "hover:bg-[var(--surface-hover)]"}`}
          style={isActive ? { backgroundColor: item.color + "20" } : undefined}
        >
          <ColorDot color={item.color} />
          {editingId === item.id ? (
            <input autoFocus value={editName} onChange={(e) => setEditName(e.target.value)}
              onBlur={() => handleRename(item, editName)}
              onKeyDown={(e) => { if (e.key === "Enter") handleRename(item, editName); if (e.key === "Escape") setEditingId(null); }}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 bg-transparent border-b border-[var(--accent)] text-xs outline-none px-0.5" />
          ) : (
            <span className="flex-1 text-xs truncate" onDoubleClick={(e) => { e.stopPropagation(); setEditingId(item.id); setEditName(item.name); }}>
              {item.name}
            </span>
          )}
          <span className="text-xs font-medium tabular-nums" style={{ color: item.color }}>{formatArea(s?.totalArea, s?.hasCalibration !== false)}</span>
          {s && s.polyCount > 0 && <span className="text-[10px] text-[var(--muted)]">{s.polyCount}p {s.pages.size}pg</span>}
          {moveDropdown}
          <button onClick={(e) => { e.stopPropagation(); setEditPanelId(editPanelId === item.id ? null : item.id); }}
            className="text-[10px] text-[var(--fg)]/40 opacity-50 group-hover:opacity-100 hover:text-[var(--accent)]" title="Edit item">&#9998;</button>
          <button onClick={(e) => { e.stopPropagation(); handleDelete(item); }}
            className="text-[10px] text-red-400/40 opacity-50 group-hover:opacity-100 hover:text-red-400" title="Delete item and all polygons">x</button>
        </div>
        {editPanelId === item.id && (
          <TakeoffEditPanel item={item}
            onSave={async (updates) => { updateTakeoffItem(item.id, updates); if (!isDemo) { await fetch(`/api/takeoff-items/${item.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updates) }); } }}
            onLiveUpdate={(updates) => updateTakeoffItem(item.id, updates)}
            onClose={() => setEditPanelId(null)} />
        )}
      </div>
    );
  };

  const bucketFillActive = useViewerStore((s) => s.bucketFillActive);
  const setBucketFillActive = useViewerStore((s) => s.setBucketFillActive);
  const bucketFillBarrierMode = useViewerStore((s) => s.bucketFillBarrierMode);
  const setBucketFillBarrierMode = useViewerStore((s) => s.setBucketFillBarrierMode);
  const bucketFillBarriers = useViewerStore((s) => s.bucketFillBarriers);
  const clearBucketFillBarriers = useViewerStore((s) => s.clearBucketFillBarriers);

  return (
    <>
      <ScaleStatus />
      {/* Bucket fill toolbar — only when an area polygon item is active */}
      {activeTakeoffItemId !== null && areaItems.some((i) => i.id === activeTakeoffItemId) && (
        <div className="px-2 py-1.5 border-b border-[var(--border)] space-y-1">
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setBucketFillActive(!bucketFillActive)}
              className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded border transition-colors ${
                bucketFillActive
                  ? "border-cyan-400/60 text-cyan-300 bg-cyan-400/10"
                  : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--accent)]"
              }`}
              title="Bucket Fill — click inside a room to auto-detect its boundary"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 2v5h5" /><path d="M21 6v6.5c0 .8-.7 1.5-1.5 1.5h-2l-3.5 4-3.5-4h-2C7.7 14 7 13.3 7 12.5V6c0-.8.7-1.5 1.5-1.5H19l2 1.5Z" />
                <path d="m2 2 20 20" />
              </svg>
              Bucket Fill
            </button>
            {bucketFillActive && (
              <>
                <button
                  onClick={() => setBucketFillBarrierMode(!bucketFillBarrierMode)}
                  className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded border transition-colors ${
                    bucketFillBarrierMode
                      ? "border-red-400/60 text-red-300 bg-red-400/10"
                      : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-red-400/40"
                  }`}
                  title="Draw barrier lines across doorways to seal rooms (B)"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="4" y1="4" x2="20" y2="20" />
                  </svg>
                  Barrier{bucketFillBarriers.length > 0 ? ` (${bucketFillBarriers.length})` : ""}
                </button>
                {bucketFillBarriers.length > 0 && (
                  <button
                    onClick={clearBucketFillBarriers}
                    className="text-[10px] text-red-400/60 hover:text-red-400"
                    title="Clear all barrier lines"
                  >
                    Clear
                  </button>
                )}
              </>
            )}
          </div>
          {bucketFillActive && (
            <div className="text-[10px] text-[var(--muted)] leading-tight">
              {bucketFillBarrierMode
                ? "Click two points to draw a barrier line across a doorway"
                : "Click inside a room to detect its boundary"}
            </div>
          )}
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        {/* New Group button */}
        <div className="px-2 py-1.5 border-b border-[var(--border)]">
          {showGroupForm ? (
            <div className="flex gap-1">
              <input
                autoFocus
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleCreateGroup(); if (e.key === "Escape") { setShowGroupForm(false); setNewGroupName(""); } }}
                placeholder="Group name (e.g. Division 09)"
                className="flex-1 px-2 py-0.5 text-[11px] bg-[var(--bg)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]"
              />
              <button onClick={handleCreateGroup} disabled={!newGroupName.trim()}
                className="text-[10px] px-2 py-0.5 rounded bg-emerald-600 text-white disabled:opacity-40">Add</button>
              <button onClick={() => { setShowGroupForm(false); setNewGroupName(""); }}
                className="text-[10px] px-1 text-[var(--muted)] hover:text-[var(--fg)]">&times;</button>
            </div>
          ) : (
            <button onClick={() => setShowGroupForm(true)}
              className="w-full text-left text-[10px] text-[var(--muted)] hover:text-[var(--fg)] py-0.5">
              + New Group
            </button>
          )}
        </div>

        {/* Groups + items */}
        {areaGroups.map((g) => (
          <TakeoffGroupSection
            key={g.id}
            group={g}
            kind="area"
            items={byGroup[g.id] || []}
            collapsed={collapsedGroups[String(g.id)] ?? false}
            onToggleCollapsed={() => toggleCollapsed(String(g.id))}
            onRename={(name) => handleRenameGroup(g.id, name)}
            onDelete={() => handleDeleteGroup(g.id)}
            onMoveItem={handleMoveItem}
            renderItem={renderAreaItem}
            availableGroups={areaGroups}
          />
        ))}
        <TakeoffGroupSection
          group={null}
          kind="area"
          items={ungrouped}
          collapsed={collapsedGroups.ungrouped ?? false}
          onToggleCollapsed={() => toggleCollapsed("ungrouped")}
          onMoveItem={handleMoveItem}
          renderItem={renderAreaItem}
          availableGroups={areaGroups}
        />

        {areaItems.length === 0 && !showForm && (
          <div className="text-xs text-[var(--muted)] text-center py-4">No area items yet.<br />Set scale, then add an item below.</div>
        )}
      </div>
      {areaItems.length > 0 && (
        <div className="px-3 py-1.5 text-[10px] text-[var(--muted)] border-t border-[var(--border)]">
          {anyMissingCalibration ? `-- ${displayUnit} total (missing calibration on some pages)` : `${totalArea.toFixed(1)} ${displayUnit} total across ${areaItems.length} items`}
        </div>
      )}
      <div className="p-2 border-t border-[var(--border)]">
        {showForm ? (
          <div className="space-y-2">
            <input autoFocus value={formName} onChange={(e) => setFormName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") setShowForm(false); }}
              placeholder="Area item name..." className="w-full px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]" />
            <div className="flex items-center gap-0.5 flex-wrap">
              <span className="text-[10px] text-[var(--muted)] w-10">Color</span>
              {TWENTY_COLORS.map((c) => (
                <button key={c} onClick={() => setFormColor(c)}
                  className={`w-4 h-4 rounded-sm ${formColor === c ? "ring-1 ring-white ring-offset-1 ring-offset-[#1e1e22]" : ""}`}
                  style={{ backgroundColor: c }} />
              ))}
            </div>
            {formError && <div className="text-[10px] text-red-400 px-1">{formError}</div>}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5"><ColorDot color={formColor} /><span className="text-xs">{formName || "Preview"}</span></div>
              <div className="flex gap-1">
                <button onClick={() => { setShowForm(false); setFormError(null); }} className="text-xs px-2 py-0.5 text-[var(--muted)] hover:text-[var(--fg)]">Cancel</button>
                <button onClick={handleCreate} disabled={!formName.trim() || creating}
                  className="text-xs px-2 py-0.5 rounded bg-emerald-600 text-white disabled:opacity-40 hover:bg-emerald-500">{creating ? "..." : "Create"}</button>
              </div>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowForm(true)}
            className={`w-full text-xs py-1.5 rounded border ${areaItems.length === 0 ? "border-emerald-400/30 text-emerald-400/70 bg-emerald-400/5 hover:bg-emerald-400/10" : "border-dashed border-emerald-400/20 text-emerald-400/50 hover:text-emerald-300 hover:border-emerald-400/40"}`}>
            + Add Area Item
          </button>
        )}
      </div>
    </>
  );
}
