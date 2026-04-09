"use client";

import { useState, useMemo, useCallback } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import { TWENTY_COLORS } from "@/types";
import type { ClientTakeoffItem, TakeoffGroup } from "@/types";
import { ColorDot, TakeoffEditPanel } from "./TakeoffShared";
import CalibrationInput from "./CalibrationInput";
import TakeoffGroupSection from "./TakeoffGroupSection";

// ─── Scale status bar (reuse pattern from AreaTab) ──────────
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
        Set Scale (required for linear measurement)
      </button>
    </div>
  );
}

// ─── Linear tab main component ─────────────────────────────
export default function LinearTab() {
  const annotations = useViewerStore((s) => s.annotations);
  const takeoffItems = useViewerStore((s) => s.takeoffItems);
  const addTakeoffItem = useViewerStore((s) => s.addTakeoffItem);
  const removeTakeoffItem = useViewerStore((s) => s.removeTakeoffItem);
  const updateTakeoffItem = useViewerStore((s) => s.updateTakeoffItem);
  const activeTakeoffItemId = useViewerStore((s) => s.activeTakeoffItemId);
  const setActiveTakeoffItemId = useViewerStore((s) => s.setActiveTakeoffItemId);
  const setAnnotations = useViewerStore((s) => s.setAnnotations);
  const publicId = useViewerStore((s) => s.publicId);
  const scaleCalibrations = useViewerStore((s) => s.scaleCalibrations);
  const isDemo = useViewerStore((s) => s.isDemo);
  const takeoffGroups = useViewerStore((s) => s.takeoffGroups);
  const addTakeoffGroup = useViewerStore((s) => s.addTakeoffGroup);
  const removeTakeoffGroup = useViewerStore((s) => s.removeTakeoffGroup);
  const updateTakeoffGroup = useViewerStore((s) => s.updateTakeoffGroup);
  const hiddenTakeoffItemIds = useViewerStore((s) => s.hiddenTakeoffItemIds);
  const toggleTakeoffItemVisibility = useViewerStore((s) => s.toggleTakeoffItemVisibility);

  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formColor, setFormColor] = useState(TWENTY_COLORS[2]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editPanelId, setEditPanelId] = useState<number | null>(null);
  const [showGroupForm, setShowGroupForm] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const linearItems = useMemo(() => takeoffItems.filter((i) => i.shape === "linear"), [takeoffItems]);
  const linearGroups = useMemo(() => takeoffGroups.filter((g) => g.kind === "linear"), [takeoffGroups]);

  const linearSummaries = useMemo(() => {
    const map: Record<number, { totalLength: number; lineCount: number; pages: Set<number>; hasCalibration: boolean }> = {};
    for (const ann of annotations) {
      if (ann.source !== "takeoff" || !ann.data) continue;
      const data = ann.data as any;
      if (data.type !== "linear-polyline") continue;
      const itemId = data.takeoffItemId as number;
      if (!itemId) continue;
      if (!map[itemId]) map[itemId] = { totalLength: 0, lineCount: 0, pages: new Set(), hasCalibration: true };
      map[itemId].lineCount++;
      map[itemId].pages.add(ann.pageNumber);
      if (typeof data.totalLength === "number") {
        map[itemId].totalLength += data.totalLength;
      } else {
        map[itemId].hasCalibration = false;
      }
    }
    return map;
  }, [annotations]);

  const displayUnit = useMemo(() => {
    const cals = Object.values(scaleCalibrations);
    if (cals.length > 0) return cals[0].unit;
    return "ft";
  }, [scaleCalibrations]);

  const totalLength = linearItems.reduce((sum, item) => sum + (linearSummaries[item.id]?.totalLength || 0), 0);

  async function handleCreate() {
    if (!formName.trim()) return;
    if (isDemo) {
      const item = { id: -Date.now(), name: formName.trim(), shape: "linear" as const, color: formColor, size: 10, sortOrder: linearItems.length };
      addTakeoffItem(item as ClientTakeoffItem);
      setActiveTakeoffItemId(item.id);
      setFormName(""); setShowForm(false); setFormError(null);
      return;
    }
    setCreating(true); setFormError(null);
    try {
      const res = await fetch("/api/takeoff-items", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: publicId, name: formName.trim(), shape: "linear", color: formColor }),
      });
      if (res.ok) {
        const item = await res.json();
        addTakeoffItem(item); setFormName(""); setShowForm(false); setFormError(null); setActiveTakeoffItemId(item.id);
      } else {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setFormError(err.error || `Failed (${res.status})`);
      }
    } catch (err) { setFormError("Network error"); console.error("Failed to create linear item:", err); }
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
    } catch (err) { console.error("Failed to delete linear item:", err); }
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
      const g: TakeoffGroup = { id: -Date.now(), name, kind: "linear", color: null, csiCode: null, sortOrder: linearGroups.length };
      addTakeoffGroup(g);
      setNewGroupName(""); setShowGroupForm(false);
      return;
    }
    try {
      const res = await fetch("/api/takeoff-groups", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: publicId, name, kind: "linear" }),
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
  for (const g of linearGroups) byGroup[g.id] = [];
  const ungrouped: ClientTakeoffItem[] = [];
  for (const item of linearItems) {
    if (item.groupId != null && byGroup[item.groupId]) byGroup[item.groupId].push(item);
    else ungrouped.push(item);
  }

  function formatLength(val: number | undefined, hasCal: boolean): string {
    if (!hasCal || val === undefined) return `-- ${displayUnit}`;
    return `${val.toFixed(1)} ${displayUnit}`;
  }

  const renderLinearItem = (item: ClientTakeoffItem, moveDropdown: React.ReactNode) => {
    const s = linearSummaries[item.id];
    const isActive = activeTakeoffItemId === item.id;
    const isHidden = hiddenTakeoffItemIds.has(item.id);
    return (
      <div>
        <div
          onClick={() => {
            setActiveTakeoffItemId(isActive ? null : item.id);
            const store = useViewerStore.getState();
            if (isActive) { store.setTakeoffFilter(null); } else { store.setTakeoffFilter(item.id); }
          }}
          className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer group transition-colors ${isActive ? "ring-1 ring-[var(--accent)]" : "hover:bg-[var(--surface-hover)]"} ${isHidden ? "opacity-40" : ""}`}
          style={isActive ? { backgroundColor: item.color + "20" } : undefined}
        >
          <ColorDot color={item.color} />
          <button
            onClick={(e) => { e.stopPropagation(); toggleTakeoffItemVisibility(item.id); }}
            className="text-[10px] leading-none text-[var(--muted)] hover:text-[var(--fg)]"
            title={isHidden ? "Show on canvas" : "Hide from canvas"}
          >{isHidden ? "\u25CB" : "\u25CF"}</button>
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
          <span className="text-xs font-medium tabular-nums" style={{ color: item.color }}>{formatLength(s?.totalLength, s?.hasCalibration !== false)}</span>
          {s && s.lineCount > 0 && <span className="text-[10px] text-[var(--muted)]">{s.lineCount}L {s.pages.size}pg</span>}
          {moveDropdown}
          <button onClick={(e) => { e.stopPropagation(); setEditPanelId(editPanelId === item.id ? null : item.id); }}
            className="text-[10px] text-[var(--fg)]/40 opacity-50 group-hover:opacity-100 hover:text-[var(--accent)]" title="Edit item">&#9998;</button>
          <button onClick={(e) => { e.stopPropagation(); handleDelete(item); }}
            className="text-[10px] text-red-400/40 opacity-50 group-hover:opacity-100 hover:text-red-400" title="Delete item and all lines">x</button>
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

  return (
    <>
      <ScaleStatus />
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
                placeholder="Group name (e.g. Division 03)"
                className="flex-1 px-2 py-0.5 text-[11px] bg-[var(--bg)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]"
              />
              <button onClick={handleCreateGroup} disabled={!newGroupName.trim()}
                className="text-[10px] px-2 py-0.5 rounded bg-blue-600 text-white disabled:opacity-40">Add</button>
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
        {linearGroups.map((g) => (
          <TakeoffGroupSection
            key={g.id}
            group={g}
            kind="linear"
            items={byGroup[g.id] || []}
            collapsed={collapsedGroups[String(g.id)] ?? false}
            onToggleCollapsed={() => toggleCollapsed(String(g.id))}
            onRename={(name) => handleRenameGroup(g.id, name)}
            onDelete={() => handleDeleteGroup(g.id)}
            onMoveItem={handleMoveItem}
            renderItem={renderLinearItem}
            availableGroups={linearGroups}
          />
        ))}
        <TakeoffGroupSection
          group={null}
          kind="linear"
          items={ungrouped}
          collapsed={collapsedGroups.ungrouped ?? false}
          onToggleCollapsed={() => toggleCollapsed("ungrouped")}
          onMoveItem={handleMoveItem}
          renderItem={renderLinearItem}
          availableGroups={linearGroups}
        />

        {linearItems.length === 0 && !showForm && (
          <div className="text-xs text-[var(--muted)] text-center py-4">No linear items yet.<br />Set scale, then add an item below.</div>
        )}
      </div>
      {linearItems.length > 0 && (
        <div className="px-3 py-1.5 text-[10px] text-[var(--muted)] border-t border-[var(--border)]">
          {`${totalLength.toFixed(1)} ${displayUnit} total across ${linearItems.length} items`}
        </div>
      )}
      <div className="p-2 border-t border-[var(--border)]">
        {showForm ? (
          <div className="space-y-2">
            <input autoFocus value={formName} onChange={(e) => setFormName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") setShowForm(false); }}
              placeholder="Linear item name (e.g., Wall Framing)..." className="w-full px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]" />
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
                  className="text-xs px-2 py-0.5 rounded bg-blue-600 text-white disabled:opacity-40 hover:bg-blue-500">{creating ? "..." : "Create"}</button>
              </div>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowForm(true)}
            className={`w-full text-xs py-1.5 rounded border ${linearItems.length === 0 ? "border-blue-400/30 text-blue-400/70 bg-blue-400/5 hover:bg-blue-400/10" : "border-dashed border-blue-400/20 text-blue-400/50 hover:text-blue-300 hover:border-blue-400/40"}`}>
            + Add Linear Item
          </button>
        )}
      </div>
    </>
  );
}
