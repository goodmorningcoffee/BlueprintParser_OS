"use client";

import { useState, useMemo } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import { TAKEOFF_SHAPES, TWENTY_COLORS } from "@/types";
import type { TakeoffShape, ClientTakeoffItem } from "@/types";
import { SHAPE_ICONS, TakeoffEditPanel } from "./TakeoffShared";

export default function CountTab() {
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
  const [editPanelId, setEditPanelId] = useState<number | null>(null);

  const countItems = useMemo(
    () => takeoffItems.filter((i) => i.shape !== "polygon"),
    [takeoffItems]
  );

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
      const item = { id: -Date.now(), name: formName.trim(), shape: formShape, color: formColor, size: 10, sortOrder: countItems.length };
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
        body: JSON.stringify({ projectId: publicId, name: formName.trim(), shape: formShape, color: formColor }),
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
    } catch (err) {
      console.error("Failed to delete takeoff item:", err);
    }
  }

  async function handleRename(item: ClientTakeoffItem, newName: string) {
    if (!newName.trim() || newName === item.name) { setEditingId(null); return; }
    if (isDemo) {
      updateTakeoffItem(item.id, { name: newName.trim() });
      setAnnotations(annotations.map((a) => a.source === "takeoff" && (a.data as any)?.takeoffItemId === item.id ? { ...a, name: newName.trim() } : a));
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
        setAnnotations(annotations.map((a) => a.source === "takeoff" && (a.data as any)?.takeoffItemId === item.id ? { ...a, name: newName.trim() } : a));
      }
    } catch (err) {
      console.error("Failed to rename:", err);
    }
    setEditingId(null);
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {countItems.map((item) => {
          const c = counts[item.id];
          const isActive = activeTakeoffItemId === item.id;
          return (
            <div key={item.id}>
              <div
                onClick={() => {
                  setActiveTakeoffItemId(isActive ? null : item.id);
                  const store = useViewerStore.getState();
                  if (isActive) { store.setTakeoffFilter(null); }
                  else { store.setTakeoffFilter(item.id); }
                }}
                className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer group transition-colors ${
                  isActive ? "ring-1 ring-[var(--accent)]" : "hover:bg-[var(--surface-hover)]"
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
                    onKeyDown={(e) => { if (e.key === "Enter") handleRename(item, editName); if (e.key === "Escape") setEditingId(null); }}
                    onClick={(e) => e.stopPropagation()}
                    className="flex-1 bg-transparent border-b border-[var(--accent)] text-xs outline-none px-0.5"
                  />
                ) : (
                  <span className="flex-1 text-xs truncate" onDoubleClick={(e) => { e.stopPropagation(); setEditingId(item.id); setEditName(item.name); }}>
                    {item.name}
                  </span>
                )}
                <span className="text-xs font-medium tabular-nums" style={{ color: item.color }}>{c?.count || 0}</span>
                {c && c.pages.size > 0 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const store = useViewerStore.getState();
                      if (store.activeTakeoffFilter === item.id) { store.setTakeoffFilter(null); store.setSearch(""); }
                      else { store.setTakeoffFilter(item.id); store.setSearch(item.name); }
                    }}
                    className={`text-[10px] px-1 rounded hover:text-emerald-400 ${
                      useViewerStore.getState().activeTakeoffFilter === item.id ? "text-emerald-400 bg-emerald-500/20" : "text-[var(--muted)]"
                    }`}
                    title="Filter pages by this item"
                  >
                    {c.pages.size}pg
                  </button>
                )}
                <button onClick={(e) => { e.stopPropagation(); setEditPanelId(editPanelId === item.id ? null : item.id); }}
                  className="text-[10px] text-[var(--fg)]/40 opacity-50 group-hover:opacity-100 hover:text-[var(--accent)]" title="Edit item">&#9998;</button>
                <button onClick={(e) => { e.stopPropagation(); handleDelete(item); }}
                  className="text-[10px] text-red-400/40 opacity-50 group-hover:opacity-100 hover:text-red-400" title="Delete item and all markers">x</button>
              </div>
              {editPanelId === item.id && (
                <TakeoffEditPanel
                  item={item}
                  onSave={async (updates) => {
                    updateTakeoffItem(item.id, updates);
                    if (!isDemo) {
                      await fetch(`/api/takeoff-items/${item.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updates) });
                    }
                  }}
                  onLiveUpdate={(updates) => updateTakeoffItem(item.id, updates)}
                  onClose={() => setEditPanelId(null)}
                  showShape
                />
              )}
            </div>
          );
        })}
        {countItems.length === 0 && !showForm && (
          <div className="text-xs text-[var(--muted)] text-center py-4">No count items yet.<br />Add one below to start counting.</div>
        )}
      </div>
      {countItems.length > 0 && (
        <div className="px-3 py-1.5 text-[10px] text-[var(--muted)] border-t border-[var(--border)]">{totalCount} total across {countItems.length} items</div>
      )}
      <div className="p-2 border-t border-[var(--border)]">
        {showForm ? (
          <div className="space-y-2">
            <input autoFocus value={formName} onChange={(e) => setFormName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") setShowForm(false); }}
              placeholder="Item name..." className="w-full px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]" />
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-[var(--muted)] w-10">Shape</span>
              {TAKEOFF_SHAPES.map((s) => (
                <button key={s} onClick={() => setFormShape(s)}
                  className={`p-1 rounded ${formShape === s ? "ring-1 ring-[var(--accent)] bg-[var(--surface)]" : ""}`} title={s}>
                  {SHAPE_ICONS[s](formShape === s ? formColor : "#666")}
                </button>
              ))}
            </div>
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
              <div className="flex items-center gap-1.5">{SHAPE_ICONS[formShape](formColor)}<span className="text-xs">{formName || "Preview"}</span></div>
              <div className="flex gap-1">
                <button onClick={() => { setShowForm(false); setFormError(null); }} className="text-xs px-2 py-0.5 text-[var(--muted)] hover:text-[var(--fg)]">Cancel</button>
                <button onClick={handleCreate} disabled={!formName.trim() || creating}
                  className="text-xs px-2 py-0.5 rounded bg-emerald-600 text-white disabled:opacity-40 hover:bg-emerald-500">{creating ? "..." : "Create"}</button>
              </div>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowForm(true)}
            className={`w-full text-xs py-1.5 rounded border ${
              countItems.length === 0 ? "border-emerald-400/30 text-emerald-400/70 bg-emerald-400/5 hover:bg-emerald-400/10" : "border-dashed border-emerald-400/20 text-emerald-400/50 hover:text-emerald-300 hover:border-emerald-400/40"
            }`}>+ Add Count Item</button>
        )}
      </div>
    </>
  );
}
