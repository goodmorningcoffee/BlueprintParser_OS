"use client";

import { useState, useMemo, useCallback, useEffect, memo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  publishSettledActiveTakeoffItemId,
  reconcileSettledDeletedTakeoffItem,
  useToolStore,
} from "@/stores/toolStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { navigateViewerPage } from "@/stores/viewerCommands";
import { useUiStore } from "@/stores/uiStore";
import { useSessionStore } from "@/stores/sessionStore";
// [refactor jul10 P2.2④] takeoff items+groups: zustand → TanStack cache facade.
import { useTakeoffItems, useTakeoffGroups } from "@/queries/useTakeoff";
import { useAnnotations } from "@/queries/useAnnotations";
import { queryKeys } from "@/queries/queryKeys";
import { resolveBucketFillMode, vectorMayRun } from "@/lib/bucket-fill-mode";
import { TWENTY_COLORS, AREA_UNIT_MAP } from "@/types";
import type { AreaUnitSq, ClientTakeoffItem, AreaPolygonData, TakeoffGroup } from "@/types";
import { computeRealArea } from "@/lib/areaCalc";
import { ColorDot, TakeoffEditPanel } from "./TakeoffShared";
import CalibrationInput from "./CalibrationInput";
import TakeoffGroupSection from "./TakeoffGroupSection";
import { persistFetch, canPersist, apiErrorMessage } from "@/lib/client-persist";
import { selectActiveToolKey } from "@/lib/active-tool-state";
import {
  claimToolTailAuthority,
  consumeToolTailAuthority,
  invalidateToolTailAuthority,
  ownsToolTailAuthority,
} from "@/lib/parse-tool-authority";
import { useProjectLifecycleGuard } from "@/hooks/useProjectLifecycleGuard";

// ─── Scale status bar (top of area tab) ─────────────────────
function ScaleStatus() {
  const pageNumber = useViewerCoreStore((s) => s.pageNumber);
  const calibrationActive = useToolStore((s) => selectActiveToolKey(s) === "calibration");
  const scaleCalibrations = useToolStore((s) => s.scaleCalibrations);
  const calibrationMode = useToolStore((s) => s.calibrationMode);
  const setCalibrationMode = useToolStore((s) => s.setCalibrationMode);
  const resetCalibration = useToolStore((s) => s.resetCalibration);

  const hasScale = !!scaleCalibrations[pageNumber];

  if (calibrationActive) {
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
          onClick={() => setCalibrationMode("point1")}
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
export default memo(function AreaTab() {
  const queryClient = useQueryClient();
  // [refactor jul10 P2.2⑥] Keep value-replace semantics for the render-captured delete/rename
  // arrays below; functionalizing them here would silently change the frozen post-await behavior.
  const { annotations, setAnnotations } = useAnnotations();
  // [refactor jul10 P2.2④] takeoff items+groups read from the TanStack cache facade (dual
  // reader). Handler bodies UNCHANGED — orderings frozen per TAKEOFF_IMPL/SPEC.md §3; NOTE the
  // group-create failure channel here is the inline `groupError` state, NOT alert (frozen quirk,
  // TakeoffTabsFreeze TA-3).
  const { takeoffItems, updateTakeoffItem } = useTakeoffItems();
  const activeTakeoffItemId = useToolStore((s) => s.activeTakeoffItemId);
  const setActiveTakeoffItemId = useToolStore((s) => s.setActiveTakeoffItemId);
  const publicId = useSessionStore((s) => s.publicId);
  const pageDimensions = useViewerCoreStore((s) => s.pageDimensions);
  const scaleCalibrations = useToolStore((s) => s.scaleCalibrations);
  const isDemo = useSessionStore((s) => s.isDemo);
  const canAdoptProjectLifecycle = useProjectLifecycleGuard(publicId, isDemo);
  const { takeoffGroups, addTakeoffGroup, removeTakeoffGroup, updateTakeoffGroup } = useTakeoffGroups();

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
  const [groupError, setGroupError] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  // Bug 3: which area items have their instance list expanded
  const [expandedItems, setExpandedItems] = useState<Set<number>>(new Set());
  useEffect(() => setCreating(false), [canAdoptProjectLifecycle]);
  const toggleItemExpanded = (id: number) => setExpandedItems((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

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
        // Subtract hole areas so courtyards don't inflate the total.
        const outerArea = computeRealArea(vertices, dim.width, dim.height, cal);
        let holesArea = 0;
        for (const hole of (((data as any).holes ?? []) as { vertices: { x: number; y: number }[] }[])) {
          if (hole.vertices && hole.vertices.length >= 3) {
            holesArea += computeRealArea(hole.vertices, dim.width, dim.height, cal);
          }
        }
        map[itemId].totalArea += Math.max(0, outerArea - holesArea);
      } else {
        map[itemId].hasCalibration = false;
      }
    }
    return map;
  }, [annotations, pageDimensions, scaleCalibrations]);

  // Per-item instance list for the expand-on-click hierarchy (Bug 3).
  const areaInstances = useMemo(() => {
    const map: Record<number, Array<{ annId: number; pageNumber: number; area: number; hasCal: boolean }>> = {};
    for (const ann of annotations) {
      if (ann.source !== "takeoff" || !ann.data) continue;
      const data = ann.data as any;
      if (data.type !== "area-polygon") continue;
      const itemId = data.takeoffItemId as number;
      if (!itemId) continue;
      if (!map[itemId]) map[itemId] = [];
      const dim = pageDimensions[ann.pageNumber];
      const cal = scaleCalibrations[ann.pageNumber];
      let area = 0;
      let hasCal = false;
      if (cal && dim && data.vertices) {
        const outer = computeRealArea(data.vertices, dim.width, dim.height, cal);
        let holesArea = 0;
        for (const hole of ((data.holes ?? []) as { vertices: { x: number; y: number }[] }[])) {
          if (hole.vertices && hole.vertices.length >= 3) {
            holesArea += computeRealArea(hole.vertices, dim.width, dim.height, cal);
          }
        }
        area = Math.max(0, outer - holesArea);
        hasCal = true;
      }
      map[itemId].push({ annId: ann.id, pageNumber: ann.pageNumber, area, hasCal });
    }
    for (const key of Object.keys(map)) {
      map[Number(key)].sort((a, b) => a.pageNumber - b.pageNumber || b.area - a.area);
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
    if (!canAdoptProjectLifecycle()) return;
    if (!formName.trim()) return;
    const session = useSessionStore.getState();
    const capturedPublicId = session.publicId;
    const capturedItemsKey = queryKeys.takeoff.items(capturedPublicId);
    const token = claimToolTailAuthority({});
    if (session.isDemo) {
      const item = { id: -Date.now(), name: formName.trim(), shape: "polygon" as const, color: formColor, size: 10, sortOrder: areaItems.length };
      if (!canAdoptProjectLifecycle()) return;
      queryClient.setQueryData<ClientTakeoffItem[]>(capturedItemsKey, (old = []) => [
        ...old,
        item,
      ]);
      if (
        useSessionStore.getState().publicId === capturedPublicId &&
        ownsToolTailAuthority(token)
      ) {
        consumeToolTailAuthority(token, () => publishSettledActiveTakeoffItemId(item.id));
      }
      if (!canAdoptProjectLifecycle()) return;
      setFormName("");
      if (!canAdoptProjectLifecycle()) return;
      setShowForm(false);
      if (!canAdoptProjectLifecycle()) return;
      setFormError(null);
      return;
    }
    setCreating(true);
    if (!canAdoptProjectLifecycle()) return;
    setFormError(null);
    try {
      if (!canAdoptProjectLifecycle()) return;
      const res = await fetch("/api/takeoff-items", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: capturedPublicId, name: formName.trim(), shape: "polygon", color: formColor }),
      });
      if (!canAdoptProjectLifecycle()) return;
      if (res.ok) {
        const item = await res.json() as ClientTakeoffItem;
        if (!canAdoptProjectLifecycle()) return;
        queryClient.setQueryData<ClientTakeoffItem[]>(capturedItemsKey, (old = []) => [
          ...old,
          item,
        ]);
        if (!canAdoptProjectLifecycle()) return;
        setFormName("");
        if (!canAdoptProjectLifecycle()) return;
        setShowForm(false);
        if (!canAdoptProjectLifecycle()) return;
        setFormError(null);
        if (
          useSessionStore.getState().publicId === capturedPublicId &&
          ownsToolTailAuthority(token)
        ) {
          consumeToolTailAuthority(token, () => publishSettledActiveTakeoffItemId(item.id));
        }
      } else {
        // [refactor jun16 P1.2] read either error envelope (legacy string | {code,message}).
        const err = await res.json().catch(() => null);
        if (!canAdoptProjectLifecycle()) return;
        setFormError(apiErrorMessage(err) || `Failed (${res.status})`);
      }
    } catch (err) {
      if (!canAdoptProjectLifecycle()) return;
      setFormError("Network error");
      console.error("Failed to create area item:", err);
    } finally {
      if (canAdoptProjectLifecycle()) setCreating(false);
    }
  }

  async function handleDelete(item: ClientTakeoffItem) {
    if (!canAdoptProjectLifecycle()) return;
    const session = useSessionStore.getState();
    const capturedPublicId = session.publicId;
    const capturedItemsKey = queryKeys.takeoff.items(capturedPublicId);
    const capturedAnnotationsKey = queryKeys.annotations.all(capturedPublicId);
    const reconciledAnnotations = annotations.filter((a) => !(a.source === "takeoff" && String((a.data as any)?.takeoffItemId) === String(item.id)));
    invalidateToolTailAuthority();
    if (session.isDemo) {
      if (!canAdoptProjectLifecycle()) return;
      queryClient.setQueryData<ClientTakeoffItem[]>(capturedItemsKey, (old = []) =>
        old.filter((candidate) => candidate.id !== item.id),
      );
      if (!canAdoptProjectLifecycle()) return;
      queryClient.setQueryData(capturedAnnotationsKey, reconciledAnnotations);
      if (canAdoptProjectLifecycle() && useSessionStore.getState().publicId === capturedPublicId) {
        reconcileSettledDeletedTakeoffItem(item.id);
      }
      return;
    }
    try {
      await persistFetch(`/api/takeoff-items/${item.id}`, undefined, "DELETE");
      if (!canAdoptProjectLifecycle()) return;
      queryClient.setQueryData<ClientTakeoffItem[]>(capturedItemsKey, (old = []) =>
        old.filter((candidate) => candidate.id !== item.id),
      );
      if (!canAdoptProjectLifecycle()) return;
      queryClient.setQueryData(capturedAnnotationsKey, reconciledAnnotations);
      if (canAdoptProjectLifecycle() && useSessionStore.getState().publicId === capturedPublicId) {
        reconcileSettledDeletedTakeoffItem(item.id);
      }
    } catch (err) {
      if (!canAdoptProjectLifecycle()) return;
      console.error("Failed to delete area item:", err);
      window.alert(`Failed to delete item: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  }

  async function handleRename(item: ClientTakeoffItem, newName: string) {
    if (!canAdoptProjectLifecycle()) return;
    if (!newName.trim() || newName === item.name) { setEditingId(null); return; }
    if (isDemo) {
      updateTakeoffItem(item.id, { name: newName.trim() });
      if (!canAdoptProjectLifecycle()) return;
      setAnnotations(annotations.map((a) => a.source === "takeoff" && (a.data as any)?.takeoffItemId === item.id ? { ...a, name: newName.trim() } : a));
      if (!canAdoptProjectLifecycle()) return;
      setEditingId(null); return;
    }
    try {
      await persistFetch(`/api/takeoff-items/${item.id}`, { name: newName.trim() }, "PUT");
      if (!canAdoptProjectLifecycle()) return;
      updateTakeoffItem(item.id, { name: newName.trim() });
      if (!canAdoptProjectLifecycle()) return;
      setAnnotations(annotations.map((a) => a.source === "takeoff" && (a.data as any)?.takeoffItemId === item.id ? { ...a, name: newName.trim() } : a));
    } catch (err) {
      if (!canAdoptProjectLifecycle()) return;
      console.error("Failed to rename:", err);
      window.alert(`Failed to rename item: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
    if (canAdoptProjectLifecycle()) setEditingId(null);
  }

  async function handleCreateGroup() {
    if (!canAdoptProjectLifecycle()) return;
    const name = newGroupName.trim();
    if (!name) return;
    setGroupError(null);
    if (!canAdoptProjectLifecycle()) return;
    if (isDemo) {
      const g: TakeoffGroup = { id: -Date.now(), name, kind: "area", color: null, csiCode: null, sortOrder: areaGroups.length };
      addTakeoffGroup(g);
      if (!canAdoptProjectLifecycle()) return;
      setNewGroupName("");
      if (!canAdoptProjectLifecycle()) return;
      setShowGroupForm(false);
      return;
    }
    if (!canPersist(publicId, isDemo)) return;
    try {
      const g = await persistFetch("/api/takeoff-groups", { projectId: publicId, name, kind: "area" });
      if (!canAdoptProjectLifecycle()) return;
      addTakeoffGroup(g as TakeoffGroup);
      if (!canAdoptProjectLifecycle()) return;
      setNewGroupName("");
      if (!canAdoptProjectLifecycle()) return;
      setShowGroupForm(false);
    } catch (err) {
      if (!canAdoptProjectLifecycle()) return;
      setGroupError(err instanceof Error ? err.message : "Failed to create group");
      console.error("Failed to create group:", err);
    }
  }

  async function handleRenameGroup(id: number, name: string) {
    if (!canAdoptProjectLifecycle()) return;
    updateTakeoffGroup(id, { name });
    if (!canAdoptProjectLifecycle()) return;
    if (isDemo) return;
    try {
      await persistFetch(`/api/takeoff-groups/${id}`, { name }, "PUT");
    } catch (err) {
      if (!canAdoptProjectLifecycle()) return;
      console.error("Failed to rename group:", err);
      window.alert(`Failed to rename group: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  }

  async function handleDeleteGroup(id: number) {
    if (!canAdoptProjectLifecycle()) return;
    removeTakeoffGroup(id);
    if (!canAdoptProjectLifecycle()) return;
    if (isDemo) return;
    try {
      await persistFetch(`/api/takeoff-groups/${id}`, undefined, "DELETE");
    } catch (err) {
      if (!canAdoptProjectLifecycle()) return;
      console.error("Failed to delete group:", err);
      window.alert(`Failed to delete group: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  }

  const handleMoveItem = useCallback(async (itemId: number, targetGroupId: number | null) => {
    if (!canAdoptProjectLifecycle()) return;
    updateTakeoffItem(itemId, { groupId: targetGroupId });
    if (!canAdoptProjectLifecycle()) return;
    if (isDemo) return;
    try {
      await persistFetch(`/api/takeoff-items/${itemId}`, { groupId: targetGroupId }, "PUT");
    } catch (err) {
      if (!canAdoptProjectLifecycle()) return;
      console.error("Failed to move item:", err);
      window.alert(`Failed to move item: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  }, [canAdoptProjectLifecycle, isDemo, updateTakeoffItem]);

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
    const instances = areaInstances[item.id] ?? [];
    const isExpanded = expandedItems.has(item.id);
    return (
      <div>
        <div
          onClick={() => {
            if (!canAdoptProjectLifecycle()) return;
            setActiveTakeoffItemId(isActive ? null : item.id);
            if (!canAdoptProjectLifecycle()) return;
            const store = useUiStore.getState();
            if (isActive) { store.setTakeoffFilter(null); } else { store.setTakeoffFilter(item.id); }
          }}
          className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer group transition-colors ${isActive ? "ring-1 ring-[var(--accent)]" : "hover:bg-[var(--surface-hover)]"}`}
          style={isActive ? { backgroundColor: item.color + "20" } : undefined}
        >
          {/* Expand chevron: toggles per-instance list. Only visible when
              the item has polygons; click stops propagation so activation
              doesn't fire. */}
          <button
            onClick={(e) => { e.stopPropagation(); if (instances.length > 0) toggleItemExpanded(item.id); }}
            className="text-[var(--muted)] w-3 shrink-0 text-left"
            title={instances.length > 0 ? (isExpanded ? "Collapse instances" : "Expand instances") : undefined}
          >
            {instances.length > 0 ? (isExpanded ? "\u25BE" : "\u25B8") : ""}
          </button>
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
        {isExpanded && instances.length > 0 && (
          <div className="ml-5 border-l border-[var(--border)] pl-2">
            {instances.map((inst, idx) => (
              <div
                key={inst.annId}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!canAdoptProjectLifecycle()) return;
                  navigateViewerPage(inst.pageNumber);
                  if (!canAdoptProjectLifecycle()) return;
                  useUiStore.getState().setFocusAnnotationId(inst.annId);
                }}
                className="flex items-center gap-2 px-2 py-0.5 text-[11px] rounded cursor-pointer hover:bg-[var(--surface-hover)]"
                title={`Go to page ${inst.pageNumber}`}
              >
                <span className="text-[var(--muted)] w-6 shrink-0">#{idx + 1}</span>
                <span className="flex-1 text-[var(--muted)]">p{inst.pageNumber}</span>
                <span className="text-[var(--muted)] tabular-nums">
                  {inst.hasCal ? `${inst.area.toFixed(1)}` : "\u2014"}
                </span>
              </div>
            ))}
          </div>
        )}
        {editPanelId === item.id && (
          <TakeoffEditPanel item={item}
            onSave={async (updates) => {
              if (!canAdoptProjectLifecycle()) return;
              updateTakeoffItem(item.id, updates);
              if (!canAdoptProjectLifecycle()) return;
              if (!isDemo) {
                try {
                  await persistFetch(`/api/takeoff-items/${item.id}`, updates, "PUT");
                } catch (err) {
                  if (!canAdoptProjectLifecycle()) return;
                  window.alert(`Failed to save item: ${err instanceof Error ? err.message : "Unknown error"}`);
                }
              }
            }}
            onLiveUpdate={(updates) => updateTakeoffItem(item.id, updates)}
            onClose={() => setEditPanelId(null)} />
        )}
      </div>
    );
  };

  const bucketFillActive = useToolStore((s) => selectActiveToolKey(s) === "bucketFill");
  // [bucketfill P3] Read once per render: a dev/env override, not reactive state.
  const knobsAreRasterOnly = vectorMayRun(resolveBucketFillMode());
  const setBucketFillActive = useToolStore((s) => s.setBucketFillActive);
  const bucketFillBarrierMode = useToolStore((s) => s.bucketFillBarrierMode);
  const setBucketFillBarrierMode = useToolStore((s) => s.setBucketFillBarrierMode);
  const bucketFillBarriers = useToolStore((s) => s.bucketFillBarriers);
  const clearBucketFillBarriers = useToolStore((s) => s.clearBucketFillBarriers);
  const bucketFillTolerance = useToolStore((s) => s.bucketFillTolerance);
  const setBucketFillTolerance = useToolStore((s) => s.setBucketFillTolerance);
  const bucketFillDilatePx = useToolStore((s) => s.bucketFillDilatePx);
  const setBucketFillDilatePx = useToolStore((s) => s.setBucketFillDilatePx);
  const bucketFillResolution = useToolStore((s) => s.bucketFillResolution);
  const setBucketFillResolution = useToolStore((s) => s.setBucketFillResolution);
  const splitAreaActive = useToolStore((s) => selectActiveToolKey(s) === "split");
  const setSplitAreaActive = useToolStore((s) => s.setSplitAreaActive);

  return (
    <>
      <div className="p-2 border-b border-[var(--border)]">
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
      <ScaleStatus />
      {/* Bucket fill toolbar — always enabled, independent of item selection */}
      <div className="px-2 py-1.5 border-b border-[var(--border)] space-y-1">
        <div className="flex items-center gap-1.5">
          <button
            onPointerDown={() => invalidateToolTailAuthority()}
            onKeyDown={() => invalidateToolTailAuthority()}
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
                onPointerDown={() => invalidateToolTailAuthority()}
                onKeyDown={() => invalidateToolTailAuthority()}
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
                  onPointerDown={() => invalidateToolTailAuthority()}
                  onKeyDown={() => invalidateToolTailAuthority()}
                  onClick={() => {
                    invalidateToolTailAuthority();
                    clearBucketFillBarriers();
                  }}
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
          <div className="space-y-1.5">
            <div className="text-[10px] text-[var(--muted)] leading-tight">
              {bucketFillBarrierMode
                ? "Click two points to draw a barrier line across a doorway"
                : "Click inside a room to detect its boundary"}
            </div>
            {/* [bucketfill P3] Knob honesty — these three tune the RASTER flood only. Hidden
                while raster is the only engine (saying "raster only" then is noise). ⚠ The
                tooltip note is APPENDED, never prefixed: the perf spec selects these sliders by
                title prefix. Guarded by KnobTooltipSelectorContract.test.ts. */}
            {knobsAreRasterOnly && (
              <div className="text-[10px] italic text-[var(--muted)] leading-tight">
                Raster only — these do not affect pages measured from vector linework.
              </div>
            )}
            {/* Resolution slider — 4 snap values (1000/2000/3000/4000 px).
                Lower = instant but thin walls vanish on high-DPI plans.
                Higher = preserves 1-pixel walls, ~150-250ms pause at 4000
                on big room fills. Dominant knob for preventing overflow;
                tolerance/dilation are secondary. */}
            <div className="space-y-0.5">
              <div
                className="flex items-center gap-1.5"
                title="Max pixel dimension the worker floods on. 1000 = instant but walls under ~3px vanish on high-DPI plans. 2000/3000 = intermediate. 4000 = near-native PDF.js canvas resolution, preserves 1-pixel walls at ~150-250ms cost on big fills. Raster only — has no effect on pages measured from vector linework."
              >
                <span className="w-14 text-[10px] text-[var(--muted)] shrink-0">Resolution</span>
                <input
                  type="range"
                  min={1000}
                  max={4000}
                  step={1000}
                  value={bucketFillResolution}
                  onPointerDown={() => invalidateToolTailAuthority()}
                  onKeyDown={() => invalidateToolTailAuthority()}
                  onChange={(e) => {
                    invalidateToolTailAuthority();
                    setBucketFillResolution(
                      Number(e.target.value) as 1000 | 2000 | 3000 | 4000,
                    );
                  }}
                  className="flex-1 h-1 accent-pink-400"
                />
                <span className="w-9 text-[10px] text-right font-mono text-[var(--muted)]">
                  {bucketFillResolution >= 1000 ? `${bucketFillResolution / 1000}k` : bucketFillResolution}
                </span>
              </div>
              <div className="text-[9px] text-[var(--muted)]/80 leading-tight">
                {bucketFillResolution === 1000 && "Instant. May leak on high-DPI plans."}
                {bucketFillResolution === 2000 && "Balanced. Catches most thin-wall leaks."}
                {bucketFillResolution === 3000 && "Near-native resolution. Small pause."}
                {bucketFillResolution === 4000 && "Native resolution. Preserves 1-pixel walls."}
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-[9px] text-[var(--muted)]/80 px-0.5 leading-tight">
                Lower = tighter fill (more sensitive to thin lines).
                Higher = looser (fills through noisy pixels).
              </div>
              <div
                className="flex items-center gap-1.5"
                title="How aggressively the fill pushes past faint pixels. Negative = extreme strictness (nearly every pixel becomes a wall). 0 = tighter than default. 30 = pure Otsu (default). Higher = ignores small gaps and extends further. Raster only — has no effect on pages measured from vector linework."
              >
                <span className="w-14 text-[10px] text-[var(--muted)] shrink-0">Tolerance</span>
                <input type="range" min={-20} max={80} step={1}
                  value={bucketFillTolerance}
                  onPointerDown={() => invalidateToolTailAuthority()}
                  onKeyDown={() => invalidateToolTailAuthority()}
                  onChange={(e) => {
                    invalidateToolTailAuthority();
                    setBucketFillTolerance(Number(e.target.value));
                  }}
                  className="flex-1 h-1 accent-cyan-400" />
                <span className="w-7 text-[10px] text-right font-mono text-[var(--muted)]">{bucketFillTolerance}</span>
              </div>
              <div
                className="flex items-center gap-1.5"
                title="Gap-closing radius in pixels, applied to walls before flooding. 0 = no gap-closing, respects every single pixel. 1–10 = seal gaps of that many pixels (helps when line art has 1–2px breaks at door frames). Raster only — has no effect on pages measured from vector linework."
              >
                <span className="w-14 text-[10px] text-[var(--muted)] shrink-0">Dilation</span>
                <input type="range" min={0} max={10} step={1}
                  value={bucketFillDilatePx}
                  onPointerDown={() => invalidateToolTailAuthority()}
                  onKeyDown={() => invalidateToolTailAuthority()}
                  onChange={(e) => {
                    invalidateToolTailAuthority();
                    setBucketFillDilatePx(Number(e.target.value));
                  }}
                  className="flex-1 h-1 accent-cyan-400" />
                <span className="w-7 text-[10px] text-right font-mono text-[var(--muted)]">{bucketFillDilatePx}</span>
              </div>
            </div>
          </div>
        )}
      </div>
      {areaItems.length > 0 && (
        <div className="px-2 py-1.5 border-b border-[var(--border)] space-y-1">
          <div className="flex items-center gap-1.5">
            <button
              onPointerDown={() => invalidateToolTailAuthority()}
              onKeyDown={() => invalidateToolTailAuthority()}
              onClick={() => setSplitAreaActive(!splitAreaActive)}
              className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded border transition-colors ${
                splitAreaActive
                  ? "border-fuchsia-400/60 text-fuchsia-300 bg-fuchsia-400/10"
                  : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-fuchsia-400/40"
              }`}
              title="Split an existing area polygon by drawing a line across it"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12 L21 12" strokeDasharray="4 3" />
                <path d="M8 5 L8 19" />
                <path d="M16 5 L16 19" />
              </svg>
              Split Area
            </button>
          </div>
          <div className="text-[10px] text-[var(--muted)]/70 leading-tight">
            {splitAreaActive
              ? "Click two points to define a splitting line, then click the polygon to split."
              : "Split an existing area polygon by drawing a line across it."}
          </div>
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        {/* New Group button */}
        <div className="px-2 py-1.5 border-b border-[var(--border)]">
          {showGroupForm ? (
            <div>
              <div className="flex gap-1">
                <input
                  autoFocus
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleCreateGroup(); if (e.key === "Escape") { setShowGroupForm(false); setNewGroupName(""); setGroupError(null); } }}
                  placeholder="Group name (e.g. Division 09)"
                  className="flex-1 px-2 py-0.5 text-[11px] bg-[var(--bg)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]"
                />
                <button onClick={handleCreateGroup} disabled={!newGroupName.trim()}
                  className="text-[10px] px-2 py-0.5 rounded bg-emerald-600 text-white disabled:opacity-40">Add</button>
                <button onClick={() => { setShowGroupForm(false); setNewGroupName(""); setGroupError(null); }}
                  className="text-[10px] px-1 text-[var(--muted)] hover:text-[var(--fg)]">&times;</button>
              </div>
              {groupError && <div className="text-[10px] text-red-400 px-1 mt-0.5">{groupError}</div>}
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
    </>
  );
})
