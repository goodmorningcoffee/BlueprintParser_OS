"use client";

import { useMemo, useState } from "react";
import {
  useViewerStore,
  usePanels,
  useSelection,
  useAnnotationGroups,
  usePageData,
  useDetection,
  useTextAnnotationDisplay,
} from "@/stores/viewerStore";
import type { AnnotationGroup, ClientAnnotation, TakeoffGroup, ClientTakeoffItem, TextAnnotation, ParsedRegion, ScheduleData, KeynoteData, LegendData, NotesData } from "@/types";
import TreeSection from "./TreeSection";
import MarkupDialog from "./MarkupDialog";
import VisibilityEye, { type VisibilityState } from "./VisibilityEye";

const DETECTION_SOURCES = new Set(["yolo", "shape-parse", "symbol-search"]);
const ROW_CAP_STEP = 100;

/**
 * Unified tree panel — "view everything this project has parsed."
 *
 * Six sections collapse by default. Row interactions:
 *   - Annotation row click → setPage(n) + setFocusAnnotationId(id)
 *   - Annotation checkbox → toggle in selectedAnnotationIds (GroupActionsBar lights up at ≥2)
 *   - Group row click → expand to members; pencil → MarkupDialog in edit mode
 *   - Takeoff item click → setActiveTakeoffItemId
 *   - CSI code click → setCsiFilter
 *   - Eyeball at every level → hide/show via existing canonical store actions
 *
 * Macro-visibility: every level (master, section, sub-section, row) carries
 * a VisibilityEye. Parent eyes show an aggregate state (all-visible /
 * all-hidden / partial) computed from their descendant rows and clicking
 * them fires bulk operations against the same canonical state used by the
 * canvas (hiddenAnnotationIds, hiddenClasses, activeModels, hiddenTakeoffItemIds,
 * hiddenTextAnnotations, activeTextAnnotationTypes, annotationGroups.isActive).
 * No parallel visibility state introduced — the panel is a remote control
 * over existing canvas plumbing.
 */

function aggregate<T>(items: readonly T[], isHidden: (item: T) => boolean): VisibilityState {
  if (items.length === 0) return "all-visible";
  let h = 0;
  for (const i of items) if (isHidden(i)) h++;
  if (h === 0) return "all-visible";
  if (h === items.length) return "all-hidden";
  return "partial";
}

// ─── Bulk visibility helpers (escape hatch via setState) ──
// These avoid N round-trips through individual toggle actions when the user
// clicks a parent eye. All operate on the same store state the canvas reads.

function setAnnotationsHiddenBulk(ids: number[], hide: boolean) {
  useViewerStore.setState((s) => {
    const next = new Set(s.hiddenAnnotationIds);
    if (hide) for (const id of ids) next.add(id);
    else for (const id of ids) next.delete(id);
    return { hiddenAnnotationIds: next };
  });
}

function setTakeoffItemsHiddenBulk(ids: number[], hide: boolean) {
  useViewerStore.setState((s) => {
    const next = new Set(s.hiddenTakeoffItemIds);
    if (hide) for (const id of ids) next.add(id);
    else for (const id of ids) next.delete(id);
    return { hiddenTakeoffItemIds: next };
  });
}

function setTextAnnotationsHiddenBulk(keys: string[], hide: boolean) {
  useViewerStore.setState((s) => {
    const next = new Set(s.hiddenTextAnnotations);
    if (hide) for (const k of keys) next.add(k);
    else for (const k of keys) next.delete(k);
    return { hiddenTextAnnotations: next };
  });
}

// hiddenClasses uses inverted semantic: key === false means hidden; default visible.
function setClassesHiddenBulk(keys: string[], hide: boolean) {
  useViewerStore.setState((s) => {
    const next = { ...s.hiddenClasses };
    for (const k of keys) {
      if (hide) next[k] = false;
      else delete next[k];
    }
    return { hiddenClasses: next };
  });
}

// activeModels same inverted semantic.
function setModelsHiddenBulk(names: string[], hide: boolean) {
  useViewerStore.setState((s) => {
    const next = { ...s.activeModels };
    for (const m of names) next[m] = !hide;
    return { activeModels: next };
  });
}

function setTextAnnotationTypesHiddenBulk(types: string[], hide: boolean) {
  useViewerStore.setState((s) => {
    const next = { ...s.activeTextAnnotationTypes };
    for (const t of types) next[t] = !hide;
    return { activeTextAnnotationTypes: next };
  });
}

export default function ViewAllPanel() {
  const { toggleViewAllPanel } = usePanels();

  // Direct selectors — matches TakeoffPanel.tsx:28 convention for takeoff state
  // + picks up the visibility fields that aren't in a slice hook.
  const annotations = useViewerStore((s) => s.annotations);
  const takeoffItems = useViewerStore((s) => s.takeoffItems);
  const takeoffGroups = useViewerStore((s) => s.takeoffGroups);
  const hiddenTakeoffItemIds = useViewerStore((s) => s.hiddenTakeoffItemIds);
  const toggleTakeoffItemVisibility = useViewerStore((s) => s.toggleTakeoffItemVisibility);
  const setPage = useViewerStore((s) => s.setPage);
  const setFocusAnnotationId = useViewerStore((s) => s.setFocusAnnotationId);
  const setActiveTakeoffItemId = useViewerStore((s) => s.setActiveTakeoffItemId);
  // Drawing numbers per page — join into every row so users see "p.12 · A-201"
  // instead of just "p.12". Hydrated at project load, so no loading state needed.
  const pageDrawingNumbers = useViewerStore((s) => s.pageDrawingNumbers);
  const sheetLabel = (pn: number): string => {
    const dn = pageDrawingNumbers[pn];
    return dn ? `p.${pn} · ${dn}` : `p.${pn}`;
  };
  // Pages touched per takeoff item — derived from takeoff-source annotations
  // that carry `takeoffItemId` in their data. Used to show "A-201, A-203"
  // next to each takeoff row (multi-page items show up to 3 sheets + "+N").
  const pagesByTakeoffItemId = useMemo(() => {
    const map: Record<number, number[]> = {};
    for (const a of annotations) {
      if (a.source !== "takeoff") continue;
      const tid = (a.data as { takeoffItemId?: number } | undefined)?.takeoffItemId;
      if (typeof tid !== "number") continue;
      if (!map[tid]) map[tid] = [];
      if (!map[tid].includes(a.pageNumber)) map[tid].push(a.pageNumber);
    }
    for (const pages of Object.values(map)) pages.sort((a, b) => a - b);
    return map;
  }, [annotations]);
  const takeoffSheetSummary = (itemId: number): string | null => {
    const pages = pagesByTakeoffItemId[itemId] ?? [];
    if (pages.length === 0) return null;
    if (pages.length === 1) return sheetLabel(pages[0]);
    const labels = pages.slice(0, 3).map((p) => pageDrawingNumbers[p] || `p.${p}`);
    return pages.length > 3 ? `${labels.join(", ")} +${pages.length - 3}` : labels.join(", ");
  };
  // Master-visibility fields that gate the whole overlay class on the canvas.
  // ViewAllPanel eyeballs for YOLO / Text sub-sections bind to these so toggling
  // either surface (panel button or View All eye) keeps the other in sync.
  const showDetections = useViewerStore((s) => s.showDetections);
  const toggleDetections = useViewerStore((s) => s.toggleDetections);

  const {
    hiddenAnnotationIds, toggleAnnotationVisibility,
    hiddenClasses, toggleClassVisibility,
    activeModels, setModelActive,
  } = useDetection();

  const {
    showTextAnnotations, toggleTextAnnotations,
    hiddenTextAnnotations, toggleTextAnnotationVisibility,
    activeTextAnnotationTypes, setTextAnnotationType,
  } = useTextAnnotationDisplay();

  const {
    annotationGroups,
    annotationGroupMemberships,
    groupMembers,
    upsertAnnotationGroup,
  } = useAnnotationGroups();
  const { csiCodes, textAnnotations, setCsiFilter, pageIntelligence } = usePageData();
  const { selectedAnnotationIds, setSelectedAnnotationIds } = useSelection();

  // Section expand state — collapsed by default.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (k: string) =>
    setExpanded((s) => ({ ...s, [k]: !s[k] }));

  // Master-eye memento: when user master-hides, snapshot exact visibility state
  // so the subsequent master-show restores that state (not a full reveal of
  // everything). Ephemeral — resets when the panel unmounts, which falls back
  // to the original "full reveal" behavior on next show.
  const [masterSnapshot, setMasterSnapshot] = useState<{
    showDetections: boolean;
    showTextAnnotations: boolean;
    hiddenAnnotationIds: number[];
    hiddenTakeoffItemIds: number[];
    hiddenTextAnnotations: string[];
    hiddenClasses: Record<string, boolean>;
    activeModels: Record<string, boolean>;
    activeTextAnnotationTypes: Record<string, boolean>;
    inactiveGroupIds: number[];
  } | null>(null);

  // Per-section visible row cap (starts at ROW_CAP_STEP, grows on "Show more").
  const [caps, setCaps] = useState<Record<string, number>>({});
  const capFor = (k: string) => caps[k] ?? ROW_CAP_STEP;
  const showMore = (k: string) =>
    setCaps((s) => ({ ...s, [k]: (s[k] ?? ROW_CAP_STEP) + ROW_CAP_STEP }));

  // Top-level search.
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const match = (s: string | null | undefined) =>
    !q || (s ?? "").toLowerCase().includes(q);

  // Edit-group dialog state — mirrors Phase A4 in GroupActionsBar.
  const [editingGroup, setEditingGroup] = useState<AnnotationGroup | null>(null);
  const [editName, setEditName] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editCsi, setEditCsi] = useState("");
  const [editColor, setEditColor] = useState<string | null>(null);
  const [editActive, setEditActive] = useState(true);
  const [editBusy, setEditBusy] = useState(false);

  function openEdit(group: AnnotationGroup) {
    setEditingGroup(group);
    setEditName(group.name);
    setEditNote(group.notes ?? "");
    setEditCsi(group.csiCode ?? "");
    setEditColor(group.color);
    setEditActive(group.isActive !== false);
  }

  async function handleEditSave() {
    if (!editingGroup || !editName.trim()) return;
    setEditBusy(true);
    try {
      const res = await fetch(`/api/annotation-groups/${editingGroup.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editName.trim(),
          notes: editNote.trim() || null,
          csiCode: editCsi.trim() || null,
          color: editColor,
          isActive: editActive,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      if (data.group) upsertAnnotationGroup(data.group as AnnotationGroup);
      setEditingGroup(null);
    } catch (err) {
      console.error("[ViewAllPanel] Edit group failed:", err);
    } finally {
      setEditBusy(false);
    }
  }

  // Toggle a single group's `isActive`. Optimistic update + rollback on error.
  async function toggleGroupActive(g: AnnotationGroup) {
    const nextActive = g.isActive === false;
    upsertAnnotationGroup({ ...g, isActive: nextActive });
    try {
      const res = await fetch(`/api/annotation-groups/${g.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: nextActive }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      if (data.group) upsertAnnotationGroup(data.group as AnnotationGroup);
    } catch (err) {
      console.error("[ViewAllPanel] Toggle group active failed:", err);
      upsertAnnotationGroup(g); // rollback
    }
  }

  // Bulk toggle `isActive` across many groups. Optimistic + parallel PUTs.
  async function setGroupsActiveBulk(gs: AnnotationGroup[], nextActive: boolean) {
    for (const g of gs) upsertAnnotationGroup({ ...g, isActive: nextActive });
    const results = await Promise.allSettled(
      gs.map((g) =>
        fetch(`/api/annotation-groups/${g.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive: nextActive }),
        }),
      ),
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok)) {
        upsertAnnotationGroup(gs[i]); // rollback
      }
    }
  }

  // Shared row-action helpers.
  // Reuses the existing `llmHighlight` scroll-to-bbox effect in PDFViewer so
  // deep-nested row clicks reliably scroll the annotation into view — same
  // mechanism used by tag-browse and LLM tool-use highlights.
  const handleNav = (pageNumber: number, focusId?: number) => {
    setPage(pageNumber);
    if (focusId === undefined) return;
    setFocusAnnotationId(focusId);
    const ann = useViewerStore.getState().annotations.find((a) => a.id === focusId);
    if (ann) {
      useViewerStore.getState().setLlmHighlight({
        pageNumber: ann.pageNumber,
        bbox: ann.bbox,
        label: ann.name,
      });
    }
  };

  const toggleAnnSelection = (annId: number) => {
    const next = new Set(selectedAnnotationIds);
    if (next.has(annId)) next.delete(annId);
    else next.add(annId);
    setSelectedAnnotationIds(next);
  };

  // ─── Derived per-section data ────────────────────────────

  const groupsFiltered = useMemo(
    () => annotationGroups.filter((g) => match(g.name) || match(g.csiCode)),
    [annotationGroups, q],
  );

  const filteredAnnotations = useMemo(
    () =>
      annotations.filter(
        (a) =>
          match(a.name) ||
          match(a.note) ||
          ((a.data?.csiCodes as string[] | undefined) || []).some(match),
      ),
    [annotations, q],
  );

  // Detections hierarchy + per-bucket id lists for aggregate eyes.
  const detectionBuckets = useMemo(() => {
    const yoloModels: Record<string, Record<string, ClientAnnotation[]>> = {};
    const shapeByShape: Record<string, ClientAnnotation[]> = {};
    const symbolByPage: Record<number, ClientAnnotation[]> = {};
    const allYolo: ClientAnnotation[] = [];
    const allShape: ClientAnnotation[] = [];
    const allSymbol: ClientAnnotation[] = [];
    let total = 0;
    for (const a of filteredAnnotations) {
      if (!DETECTION_SOURCES.has(a.source)) continue;
      total++;
      if (a.source === "yolo") {
        const model = (a.data?.modelName as string) || "Unknown Model";
        const cls = a.name;
        if (!yoloModels[model]) yoloModels[model] = {};
        if (!yoloModels[model][cls]) yoloModels[model][cls] = [];
        yoloModels[model][cls].push(a);
        allYolo.push(a);
      } else if (a.source === "shape-parse") {
        const shape = (a.data?.shapeType as string) || a.name || "shape";
        if (!shapeByShape[shape]) shapeByShape[shape] = [];
        shapeByShape[shape].push(a);
        allShape.push(a);
      } else if (a.source === "symbol-search") {
        const src = (a.data?.templateSourcePage as number) || a.pageNumber;
        if (!symbolByPage[src]) symbolByPage[src] = [];
        symbolByPage[src].push(a);
        allSymbol.push(a);
      }
    }
    return { yoloModels, shapeByShape, symbolByPage, allYolo, allShape, allSymbol, total };
  }, [filteredAnnotations]);

  // Markup by page + flat list for section aggregate.
  const markupByPage = useMemo(() => {
    const byPage: Record<number, ClientAnnotation[]> = {};
    const all: ClientAnnotation[] = [];
    let total = 0;
    for (const a of filteredAnnotations) {
      if (a.source !== "user") continue;
      if (!byPage[a.pageNumber]) byPage[a.pageNumber] = [];
      byPage[a.pageNumber].push(a);
      all.push(a);
      total++;
    }
    return { byPage, all, total };
  }, [filteredAnnotations]);

  // Takeoffs grouped by kind nested under TakeoffGroup.
  const takeoffsByKind = useMemo(() => {
    const byKind: Record<string, Record<string, ClientTakeoffItem[]>> = {
      count: {},
      area: {},
      linear: {},
    };
    const allItems: ClientTakeoffItem[] = [];
    let total = 0;
    const groupById: Record<number, TakeoffGroup> = {};
    for (const g of takeoffGroups) groupById[g.id] = g;
    for (const item of takeoffItems) {
      if (!match(item.name)) continue;
      const kind: "count" | "area" | "linear" =
        item.shape === "polygon" ? "area" : item.shape === "linear" ? "linear" : "count";
      const groupName = item.groupId && groupById[item.groupId] ? groupById[item.groupId].name : "Ungrouped";
      if (!byKind[kind][groupName]) byKind[kind][groupName] = [];
      byKind[kind][groupName].push(item);
      allItems.push(item);
      total++;
    }
    return { byKind, groupById, allItems, total };
  }, [takeoffItems, takeoffGroups, q]);

  // Text annotations per page → type, carrying original index for
  // toggleTextAnnotationVisibility(pageNum, index) calls.
  const textByPage = useMemo(() => {
    type TaWithIdx = { ta: TextAnnotation; idx: number };
    const byPage: Record<number, Record<string, TaWithIdx[]>> = {};
    const allKeys: string[] = [];
    const typesInUse = new Set<string>();
    let total = 0;
    for (const [pnStr, list] of Object.entries(textAnnotations)) {
      const pn = Number(pnStr);
      if (!list) continue;
      list.forEach((ta, idx) => {
        if (!match(ta.text) && !match(ta.type)) return;
        if (!byPage[pn]) byPage[pn] = {};
        if (!byPage[pn][ta.type]) byPage[pn][ta.type] = [];
        byPage[pn][ta.type].push({ ta, idx });
        allKeys.push(`${pn}:${idx}`);
        typesInUse.add(ta.type);
        total++;
      });
    }
    return { byPage, allKeys, typesInUse: Array.from(typesInUse), total };
  }, [textAnnotations, q]);

  // CSI codes by division — aggregate detected codes across pages.
  // Parsed tables per page — schedules, keynote tables, legends, general notes.
  // These are user-saved from the Table Parse tool and live in
  // pageIntelligence[pn].parsedRegions. View All surfaces them so users can
  // browse every parsed table in the project from one place.
  const tablesByPage = useMemo(() => {
    const byPage: Record<number, ParsedRegion[]> = {};
    let total = 0;
    for (const [pnStr, pi] of Object.entries(pageIntelligence)) {
      const pn = Number(pnStr);
      const parsed = pi?.parsedRegions ?? [];
      if (parsed.length === 0) continue;
      const filtered = parsed.filter((r) => match(r.category) || match(r.type));
      if (filtered.length === 0) continue;
      byPage[pn] = filtered;
      total += filtered.length;
    }
    return { byPage, total };
  }, [pageIntelligence, q]);

  const csiByDivision = useMemo(() => {
    type CsiAgg = {
      code: string;
      description: string;
      division: string;
      count: number;
      pages: Set<number>;
    };
    const agg: Record<string, CsiAgg> = {};
    for (const [pnStr, list] of Object.entries(csiCodes)) {
      const pn = Number(pnStr);
      if (!list) continue;
      for (const c of list) {
        if (!match(c.code) && !match(c.description)) continue;
        const existing = agg[c.code];
        if (existing) {
          existing.count += 1;
          existing.pages.add(pn);
        } else {
          agg[c.code] = {
            code: c.code,
            description: c.description,
            division: c.division || "Uncategorized",
            count: 1,
            pages: new Set<number>([pn]),
          };
        }
      }
    }
    const byDivision: Record<string, CsiAgg[]> = {};
    for (const a of Object.values(agg)) {
      if (!byDivision[a.division]) byDivision[a.division] = [];
      byDivision[a.division].push(a);
    }
    for (const d of Object.keys(byDivision)) {
      byDivision[d].sort((a, b) => a.code.localeCompare(b.code));
    }
    return { byDivision, total: Object.keys(agg).length };
  }, [csiCodes, q]);

  // ─── Aggregate visibility states ─────────────────────────

  const isAnnHidden = (a: ClientAnnotation) => hiddenAnnotationIds.has(a.id);
  const isTakeoffHidden = (i: ClientTakeoffItem) => hiddenTakeoffItemIds.has(i.id);
  const isGroupHidden = (g: AnnotationGroup) => g.isActive === false;
  // Text "effective-hidden" = master off OR type filtered off OR individual hidden.
  const isTextHidden = (args: { ta: TextAnnotation; idx: number; pn: number }) =>
    !showTextAnnotations ||
    hiddenTextAnnotations.has(`${args.pn}:${args.idx}`) ||
    activeTextAnnotationTypes[args.ta.type] === false;
  // YOLO "effective-hidden" = master off OR model/class flag off OR individual hidden.
  const isYoloHidden = (a: ClientAnnotation) => {
    if (!showDetections) return true;
    if (hiddenAnnotationIds.has(a.id)) return true;
    const model = (a.data?.modelName as string | undefined) || "";
    if (model && activeModels[model] === false) return true;
    if (model && hiddenClasses[`${model}:${a.name}`] === false) return true;
    return false;
  };

  function rollupStates(...states: VisibilityState[]): VisibilityState {
    if (states.length === 0) return "all-visible";
    if (states.every((s) => s === "all-hidden")) return "all-hidden";
    if (states.every((s) => s === "all-visible")) return "all-visible";
    return "partial";
  }

  // Reveal helpers — when transitioning a master from hidden → visible we
  // clear per-item/per-class/per-model hides so the reveal is complete.
  function clearYoloHides() {
    const yoloIds = detectionBuckets.allYolo.map((a) => a.id);
    setAnnotationsHiddenBulk(yoloIds, false);
    const modelsInUse = Object.keys(detectionBuckets.yoloModels);
    setModelsHiddenBulk(modelsInUse, false);
    const classKeys: string[] = [];
    for (const [model, classes] of Object.entries(detectionBuckets.yoloModels)) {
      for (const cls of Object.keys(classes)) classKeys.push(`${model}:${cls}`);
    }
    setClassesHiddenBulk(classKeys, false);
  }
  function clearTextHides() {
    setTextAnnotationsHiddenBulk(textByPage.allKeys, false);
    setTextAnnotationTypesHiddenBulk(textByPage.typesInUse, false);
  }

  // Per-section aggregate states.
  // YOLO uses isYoloHidden (folds showDetections master + model/class flags);
  // Text uses isTextHidden (folds showTextAnnotations master + type filter).
  // Shape Parse + Symbol Search have no master — just per-item hides.
  const sectionStates = useMemo(() => {
    const groups = aggregate(groupsFiltered, isGroupHidden);
    const yolo = aggregate(detectionBuckets.allYolo, isYoloHidden);
    const shape = aggregate(detectionBuckets.allShape, isAnnHidden);
    const symbol = aggregate(detectionBuckets.allSymbol, isAnnHidden);
    const detections = rollupStates(yolo, shape, symbol);
    const markup = aggregate(markupByPage.all, isAnnHidden);
    const takeoffs = aggregate(takeoffsByKind.allItems, isTakeoffHidden);
    const text = aggregate(
      (() => {
        const out: { ta: TextAnnotation; idx: number; pn: number }[] = [];
        for (const [pnStr, types] of Object.entries(textByPage.byPage)) {
          const pn = Number(pnStr);
          for (const list of Object.values(types)) {
            for (const { ta, idx } of list) out.push({ ta, idx, pn });
          }
        }
        return out;
      })(),
      isTextHidden,
    );
    return { groups, detections, yolo, shape, symbol, markup, takeoffs, text };
  }, [
    groupsFiltered,
    detectionBuckets,
    markupByPage.all,
    takeoffsByKind.allItems,
    textByPage.byPage,
    showDetections,
    showTextAnnotations,
    activeModels,
    hiddenClasses,
    hiddenAnnotationIds,
    hiddenTakeoffItemIds,
    hiddenTextAnnotations,
    activeTextAnnotationTypes,
  ]);

  // Master "everything" aggregate: partial if any section mixed; hidden only if all sections hidden.
  const masterState: VisibilityState = useMemo(() => {
    const vs = Object.values(sectionStates);
    if (vs.every((s) => s === "all-hidden")) return "all-hidden";
    if (vs.every((s) => s === "all-visible")) return "all-visible";
    return "partial";
  }, [sectionStates]);

  // Master toggle: hide-all snapshots current state; show-all restores from
  // snapshot so flipping off+on returns the panel to exactly the state it was
  // in before. No snapshot = first-ever reveal or a post-reload reveal → fall
  // back to full reveal of everything.
  function toggleMaster() {
    if (masterState === "all-hidden") {
      // Show — restore from snapshot if we have one
      if (masterSnapshot) {
        useViewerStore.setState({
          showDetections: masterSnapshot.showDetections,
          showTextAnnotations: masterSnapshot.showTextAnnotations,
          hiddenAnnotationIds: new Set(masterSnapshot.hiddenAnnotationIds),
          hiddenTakeoffItemIds: new Set(masterSnapshot.hiddenTakeoffItemIds),
          hiddenTextAnnotations: new Set(masterSnapshot.hiddenTextAnnotations),
          hiddenClasses: { ...masterSnapshot.hiddenClasses },
          activeModels: { ...masterSnapshot.activeModels },
          activeTextAnnotationTypes: { ...masterSnapshot.activeTextAnnotationTypes },
        });
        // Restore group active state to match snapshot
        const inactive = new Set(masterSnapshot.inactiveGroupIds);
        const toDeactivate = groupsFiltered.filter((g) => inactive.has(g.id));
        const toActivate = groupsFiltered.filter((g) => !inactive.has(g.id));
        if (toDeactivate.length > 0) setGroupsActiveBulk(toDeactivate, false);
        if (toActivate.length > 0) setGroupsActiveBulk(toActivate, true);
        setMasterSnapshot(null);
      } else {
        // No snapshot — full reveal (first time, or after panel remount)
        if (!showDetections) toggleDetections();
        if (!showTextAnnotations) toggleTextAnnotations();
        clearYoloHides();
        clearTextHides();
        setAnnotationsHiddenBulk(detectionBuckets.allShape.map((a) => a.id), false);
        setAnnotationsHiddenBulk(detectionBuckets.allSymbol.map((a) => a.id), false);
        setAnnotationsHiddenBulk(markupByPage.all.map((a) => a.id), false);
        setTakeoffItemsHiddenBulk(takeoffsByKind.allItems.map((i) => i.id), false);
        setGroupsActiveBulk(groupsFiltered, true);
      }
    } else {
      // Hide — snapshot current state FIRST, then hide everything
      const cur = useViewerStore.getState();
      setMasterSnapshot({
        showDetections: cur.showDetections,
        showTextAnnotations: cur.showTextAnnotations,
        hiddenAnnotationIds: Array.from(cur.hiddenAnnotationIds),
        hiddenTakeoffItemIds: Array.from(cur.hiddenTakeoffItemIds),
        hiddenTextAnnotations: Array.from(cur.hiddenTextAnnotations),
        hiddenClasses: { ...cur.hiddenClasses },
        activeModels: { ...cur.activeModels },
        activeTextAnnotationTypes: { ...cur.activeTextAnnotationTypes },
        inactiveGroupIds: groupsFiltered.filter((g) => g.isActive === false).map((g) => g.id),
      });
      if (showDetections) toggleDetections();
      if (showTextAnnotations) toggleTextAnnotations();
      setAnnotationsHiddenBulk(detectionBuckets.allShape.map((a) => a.id), true);
      setAnnotationsHiddenBulk(detectionBuckets.allSymbol.map((a) => a.id), true);
      setAnnotationsHiddenBulk(markupByPage.all.map((a) => a.id), true);
      setTakeoffItemsHiddenBulk(takeoffsByKind.allItems.map((i) => i.id), true);
      setGroupsActiveBulk(groupsFiltered, false);
    }
  }

  // Shared row-cap slicer with "Show more".
  function withCap<T>(key: string, list: T[], renderRow: (item: T, idx: number) => React.ReactNode) {
    const cap = capFor(key);
    const visible = list.slice(0, cap);
    return (
      <>
        {visible.map(renderRow)}
        {list.length > cap && (
          <button
            onClick={() => showMore(key)}
            className="w-full text-[11px] text-[var(--muted)] hover:text-[var(--fg)] py-1 pl-8 text-left"
          >
            Show {Math.min(ROW_CAP_STEP, list.length - cap)} more ({list.length - cap} hidden)
          </button>
        )}
      </>
    );
  }

  // Annotation row — covers Groups-members + Detections-instances + Markup rows.
  function AnnotationRow({ ann, indent = 0 }: { ann: ClientAnnotation; indent?: number }) {
    const csi = (ann.data?.csiCodes as string[] | undefined)?.[0];
    const color = (ann.data?.color as string | undefined) || null;
    const isSelected = selectedAnnotationIds.has(ann.id);
    const isHidden = hiddenAnnotationIds.has(ann.id);
    return (
      <div
        className={`group flex items-center gap-2 px-2 py-1 text-[11px] hover:bg-white/5 ${isSelected ? "bg-[var(--accent)]/10" : ""}`}
        style={{ paddingLeft: 8 + indent * 12 }}
      >
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => toggleAnnSelection(ann.id)}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 cursor-pointer"
        />
        {color && <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />}
        <button
          onClick={() => handleNav(ann.pageNumber, ann.id)}
          className={`flex-1 text-left truncate ${isHidden ? "text-[var(--muted)] line-through opacity-60" : "text-[var(--fg)]"}`}
          title={ann.name}
        >
          {ann.name}
        </button>
        <span className="text-[10px] text-[var(--muted)] shrink-0 font-mono">{sheetLabel(ann.pageNumber)}</span>
        {csi && (
          <span className="text-[9px] text-[var(--muted)] font-mono shrink-0">{csi}</span>
        )}
        <VisibilityEye
          state={isHidden ? "all-hidden" : "all-visible"}
          onClick={() => toggleAnnotationVisibility(ann.id)}
          variant="row"
          size="sm"
          showOnHover
        />
      </div>
    );
  }

  return (
    <div className="w-80 flex flex-col h-full overflow-hidden border border-[var(--border)] bg-[var(--surface)] shadow-lg">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)]">
        <h3 className="text-sm font-medium text-[var(--fg)] flex-1">View All</h3>
        <VisibilityEye
          state={masterState}
          onClick={toggleMaster}
          variant="category"
          title={
            masterState === "all-hidden"
              ? "Show everything"
              : masterState === "partial"
              ? "Some hidden — click to hide everything"
              : "Hide everything"
          }
        />
        <button
          onClick={toggleViewAllPanel}
          className="text-[var(--muted)] hover:text-[var(--fg)] text-lg leading-none"
          title="Close panel"
        >
          &times;
        </button>
      </div>

      <div className="px-3 py-2 border-b border-[var(--border)]">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, CSI, note…"
          className="w-full px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)]"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* ─── Groups ─────────────────────────────────────── */}
        <TreeSection
          title="Groups"
          count={groupsFiltered.length}
          isExpanded={!!expanded.groups}
          onToggleExpand={() => toggle("groups")}
          badge={
            groupsFiltered.length > 0 ? (
              <VisibilityEye
                state={sectionStates.groups}
                onClick={() =>
                  setGroupsActiveBulk(groupsFiltered, sectionStates.groups === "all-hidden")
                }
                variant="category"
              />
            ) : undefined
          }
        >
          {groupsFiltered.length === 0 && (
            <div className="px-4 py-2 text-[11px] text-[var(--muted)]">No groups yet.</div>
          )}
          {withCap("groups", groupsFiltered, (g) => {
            const key = `group-${g.id}`;
            const memberIds = groupMembers[g.id];
            const members: ClientAnnotation[] = memberIds
              ? annotations.filter((a) => memberIds.has(a.id))
              : [];
            const memberCount = members.length;
            const isOpen = !!expanded[key];
            const inactive = g.isActive === false;
            return (
              <div key={g.id}>
                <div className="group flex items-center gap-2 px-3 py-1 hover:bg-white/5">
                  <button
                    onClick={() => toggle(key)}
                    className="text-[10px] text-[var(--muted)] w-3 shrink-0"
                  >
                    {isOpen ? "\u25BC" : "\u25B6"}
                  </button>
                  {g.color && (
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: g.color, opacity: inactive ? 0.4 : 1 }}
                    />
                  )}
                  <button
                    onClick={() => toggle(key)}
                    className={`text-xs flex-1 text-left truncate ${inactive ? "text-[var(--muted)]" : "text-[var(--fg)]"}`}
                    title={g.name}
                  >
                    {g.name}
                    {inactive && (
                      <span className="text-[9px] ml-2 text-[var(--muted)]">(inactive)</span>
                    )}
                  </button>
                  {g.csiCode && (
                    <span className="text-[10px] text-[var(--muted)] font-mono shrink-0">{g.csiCode}</span>
                  )}
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface)] text-[var(--muted)] shrink-0">
                    {memberCount}
                  </span>
                  <VisibilityEye
                    state={inactive ? "all-hidden" : "all-visible"}
                    onClick={() => toggleGroupActive(g)}
                    variant="category"
                    size="sm"
                  />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      openEdit(g);
                    }}
                    title="Edit group"
                    className="text-[var(--muted)] hover:text-[var(--fg)] shrink-0"
                  >
                    &#x270E;
                  </button>
                </div>
                {isOpen && (
                  <div>
                    {memberCount === 0 && (
                      <div className="px-6 py-1 text-[10px] text-[var(--muted)]">No members.</div>
                    )}
                    {withCap(`${key}-members`, members, (ann) => (
                      <AnnotationRow key={ann.id} ann={ann} indent={2} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </TreeSection>

        {/* ─── Detections ─────────────────────────────────── */}
        <TreeSection
          title="Detections"
          count={detectionBuckets.total}
          isExpanded={!!expanded.detections}
          onToggleExpand={() => toggle("detections")}
          badge={
            detectionBuckets.total > 0 ? (
              <VisibilityEye
                state={sectionStates.detections}
                onClick={() => {
                  if (sectionStates.detections === "all-hidden") {
                    // Reveal everything detection-related
                    if (!showDetections) toggleDetections();
                    clearYoloHides();
                    setAnnotationsHiddenBulk(detectionBuckets.allShape.map((a) => a.id), false);
                    setAnnotationsHiddenBulk(detectionBuckets.allSymbol.map((a) => a.id), false);
                  } else {
                    // Hide everything detection-related
                    if (showDetections) toggleDetections();
                    setAnnotationsHiddenBulk(detectionBuckets.allShape.map((a) => a.id), true);
                    setAnnotationsHiddenBulk(detectionBuckets.allSymbol.map((a) => a.id), true);
                  }
                }}
                variant="category"
              />
            ) : undefined
          }
        >
          {/* YOLO sub-section — master-gated by showDetections */}
          {Object.keys(detectionBuckets.yoloModels).length > 0 && (
            <SubHeader
              label="YOLO"
              count={detectionBuckets.allYolo.length}
              isOpen={!!expanded["det-yolo"]}
              onToggle={() => toggle("det-yolo")}
              visibility={sectionStates.yolo}
              onToggleVisibility={() => {
                if (sectionStates.yolo === "all-hidden") {
                  if (!showDetections) toggleDetections();
                  clearYoloHides();
                } else {
                  if (showDetections) toggleDetections();
                }
              }}
            />
          )}
          {expanded["det-yolo"] &&
            Object.entries(detectionBuckets.yoloModels).map(([model, classes]) => {
              const mkey = `det-yolo-${model}`;
              const mOpen = !!expanded[mkey];
              const modelAnns = Object.values(classes).flat();
              // Effective visibility folds master + model flag + class flags + individual.
              const modelVis: VisibilityState = aggregate(modelAnns, isYoloHidden);
              return (
                <div key={model}>
                  <SubHeader
                    label={model}
                    count={modelAnns.length}
                    isOpen={mOpen}
                    onToggle={() => toggle(mkey)}
                    indent={2}
                    visibility={modelVis}
                    onToggleVisibility={() => {
                      if (modelVis === "all-hidden") {
                        if (!showDetections) toggleDetections();
                        setModelActive(model, true);
                        setClassesHiddenBulk(Object.keys(classes).map((cls) => `${model}:${cls}`), false);
                        setAnnotationsHiddenBulk(modelAnns.map((a) => a.id), false);
                      } else {
                        setModelActive(model, false);
                      }
                    }}
                  />
                  {mOpen &&
                    Object.entries(classes).map(([cls, anns]) => {
                      const ckey = `${mkey}-${cls}`;
                      const cOpen = !!expanded[ckey];
                      const classVis: VisibilityState = aggregate(anns, isYoloHidden);
                      return (
                        <div key={cls}>
                          <SubHeader
                            label={cls}
                            count={anns.length}
                            isOpen={cOpen}
                            onToggle={() => toggle(ckey)}
                            indent={3}
                            visibility={classVis}
                            onToggleVisibility={() => {
                              if (classVis === "all-hidden") {
                                if (!showDetections) toggleDetections();
                                setModelActive(model, true);
                                setClassesHiddenBulk([`${model}:${cls}`], false);
                                setAnnotationsHiddenBulk(anns.map((a) => a.id), false);
                              } else {
                                toggleClassVisibility(model, cls);
                              }
                            }}
                          />
                          {cOpen && withCap(ckey, anns, (a) => <AnnotationRow key={a.id} ann={a} indent={4} />)}
                        </div>
                      );
                    })}
                </div>
              );
            })}

          {/* Shape Parse sub-section */}
          {Object.keys(detectionBuckets.shapeByShape).length > 0 && (
            <SubHeader
              label="Shape Parse"
              count={detectionBuckets.allShape.length}
              isOpen={!!expanded["det-shape"]}
              onToggle={() => toggle("det-shape")}
              visibility={aggregate(detectionBuckets.allShape, isAnnHidden)}
              onToggleVisibility={() => {
                const next =
                  aggregate(detectionBuckets.allShape, isAnnHidden) !== "all-hidden";
                setAnnotationsHiddenBulk(detectionBuckets.allShape.map((a) => a.id), next);
              }}
            />
          )}
          {expanded["det-shape"] &&
            Object.entries(detectionBuckets.shapeByShape).map(([shape, anns]) => {
              const skey = `det-shape-${shape}`;
              const sOpen = !!expanded[skey];
              return (
                <div key={shape}>
                  <SubHeader
                    label={shape}
                    count={anns.length}
                    isOpen={sOpen}
                    onToggle={() => toggle(skey)}
                    indent={2}
                    visibility={aggregate(anns, isAnnHidden)}
                    onToggleVisibility={() => {
                      const next = aggregate(anns, isAnnHidden) !== "all-hidden";
                      setAnnotationsHiddenBulk(anns.map((a) => a.id), next);
                    }}
                  />
                  {sOpen && withCap(skey, anns, (a) => <AnnotationRow key={a.id} ann={a} indent={3} />)}
                </div>
              );
            })}

          {/* Symbol Search sub-section */}
          {Object.keys(detectionBuckets.symbolByPage).length > 0 && (
            <SubHeader
              label="Symbol Search"
              count={detectionBuckets.allSymbol.length}
              isOpen={!!expanded["det-symbol"]}
              onToggle={() => toggle("det-symbol")}
              visibility={aggregate(detectionBuckets.allSymbol, isAnnHidden)}
              onToggleVisibility={() => {
                const next =
                  aggregate(detectionBuckets.allSymbol, isAnnHidden) !== "all-hidden";
                setAnnotationsHiddenBulk(detectionBuckets.allSymbol.map((a) => a.id), next);
              }}
            />
          )}
          {expanded["det-symbol"] &&
            Object.entries(detectionBuckets.symbolByPage).map(([pn, anns]) => {
              const pkey = `det-symbol-${pn}`;
              const pOpen = !!expanded[pkey];
              return (
                <div key={pn}>
                  <SubHeader
                    label={`template from p.${pn}`}
                    count={anns.length}
                    isOpen={pOpen}
                    onToggle={() => toggle(pkey)}
                    indent={2}
                    visibility={aggregate(anns, isAnnHidden)}
                    onToggleVisibility={() => {
                      const next = aggregate(anns, isAnnHidden) !== "all-hidden";
                      setAnnotationsHiddenBulk(anns.map((a) => a.id), next);
                    }}
                  />
                  {pOpen && withCap(pkey, anns, (a) => <AnnotationRow key={a.id} ann={a} indent={3} />)}
                </div>
              );
            })}
        </TreeSection>

        {/* ─── Markup ─────────────────────────────────────── */}
        <TreeSection
          title="Markup"
          count={markupByPage.total}
          isExpanded={!!expanded.markup}
          onToggleExpand={() => toggle("markup")}
          badge={
            markupByPage.total > 0 ? (
              <VisibilityEye
                state={sectionStates.markup}
                onClick={() => {
                  const next = sectionStates.markup !== "all-hidden";
                  setAnnotationsHiddenBulk(markupByPage.all.map((a) => a.id), next);
                }}
                variant="category"
              />
            ) : undefined
          }
        >
          {Object.keys(markupByPage.byPage).length === 0 && (
            <div className="px-4 py-2 text-[11px] text-[var(--muted)]">No markup annotations.</div>
          )}
          {Object.entries(markupByPage.byPage)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([pn, anns]) => {
              const pkey = `mk-${pn}`;
              const pOpen = !!expanded[pkey];
              return (
                <div key={pn}>
                  <SubHeader
                    label={`Page ${pn}`}
                    count={anns.length}
                    isOpen={pOpen}
                    onToggle={() => toggle(pkey)}
                    visibility={aggregate(anns, isAnnHidden)}
                    onToggleVisibility={() => {
                      const next = aggregate(anns, isAnnHidden) !== "all-hidden";
                      setAnnotationsHiddenBulk(anns.map((a) => a.id), next);
                    }}
                  />
                  {pOpen && withCap(pkey, anns, (a) => <AnnotationRow key={a.id} ann={a} indent={2} />)}
                </div>
              );
            })}
        </TreeSection>

        {/* ─── Takeoffs ───────────────────────────────────── */}
        <TreeSection
          title="Takeoffs"
          count={takeoffsByKind.total}
          isExpanded={!!expanded.takeoffs}
          onToggleExpand={() => toggle("takeoffs")}
          badge={
            takeoffsByKind.total > 0 ? (
              <VisibilityEye
                state={sectionStates.takeoffs}
                onClick={() => {
                  const next = sectionStates.takeoffs !== "all-hidden";
                  setTakeoffItemsHiddenBulk(takeoffsByKind.allItems.map((i) => i.id), next);
                }}
                variant="category"
              />
            ) : undefined
          }
        >
          {takeoffItems.length === 0 && (
            <div className="px-4 py-2 text-[11px] text-[var(--muted)]">No takeoff items.</div>
          )}
          {(["count", "area", "linear"] as const).map((kind) => {
            const groups = takeoffsByKind.byKind[kind] ?? {};
            const groupsList = Object.entries(groups);
            if (groupsList.length === 0) return null;
            const kKey = `to-${kind}`;
            const kOpen = !!expanded[kKey];
            const kindItems = groupsList.flatMap(([, items]) => items);
            return (
              <div key={kind}>
                <SubHeader
                  label={kind}
                  count={kindItems.length}
                  isOpen={kOpen}
                  onToggle={() => toggle(kKey)}
                  visibility={aggregate(kindItems, isTakeoffHidden)}
                  onToggleVisibility={() => {
                    const next = aggregate(kindItems, isTakeoffHidden) !== "all-hidden";
                    setTakeoffItemsHiddenBulk(kindItems.map((i) => i.id), next);
                  }}
                />
                {kOpen &&
                  groupsList.map(([groupName, items]) => {
                    const gKey = `to-${kind}-${groupName}`;
                    const gOpen = !!expanded[gKey];
                    return (
                      <div key={groupName}>
                        <SubHeader
                          label={groupName}
                          count={items.length}
                          isOpen={gOpen}
                          onToggle={() => toggle(gKey)}
                          indent={2}
                          visibility={aggregate(items, isTakeoffHidden)}
                          onToggleVisibility={() => {
                            const next = aggregate(items, isTakeoffHidden) !== "all-hidden";
                            setTakeoffItemsHiddenBulk(items.map((i) => i.id), next);
                          }}
                        />
                        {gOpen &&
                          withCap(gKey, items, (item) => {
                            const itemHidden = hiddenTakeoffItemIds.has(item.id);
                            return (
                              <div
                                key={item.id}
                                className="group flex items-center gap-2 text-[11px] py-1 hover:bg-white/5"
                                style={{ paddingLeft: 8 + 3 * 12 }}
                              >
                                <span
                                  className="w-2 h-2 rounded-full shrink-0"
                                  style={{ backgroundColor: item.color }}
                                />
                                <button
                                  onClick={() => {
                                    setActiveTakeoffItemId(item.id);
                                    // Also navigate to the item's first polygon so the
                                    // canvas jumps to where this takeoff lives.
                                    const itemAnns = annotations.filter(
                                      (a) =>
                                        a.source === "takeoff" &&
                                        (a.data as { takeoffItemId?: number } | undefined)?.takeoffItemId === item.id,
                                    );
                                    if (itemAnns.length > 0) {
                                      const first = itemAnns.reduce((a, b) =>
                                        a.pageNumber <= b.pageNumber ? a : b,
                                      );
                                      handleNav(first.pageNumber, first.id);
                                    }
                                  }}
                                  className={`flex-1 text-left truncate ${itemHidden ? "text-[var(--muted)] line-through opacity-60" : "text-[var(--fg)]"}`}
                                  title={item.name}
                                >
                                  {item.name}
                                </button>
                                {takeoffSheetSummary(item.id) && (
                                  <span className="text-[10px] text-[var(--muted)] shrink-0 font-mono">{takeoffSheetSummary(item.id)}</span>
                                )}
                                <span className="text-[10px] text-[var(--muted)] shrink-0">{item.shape}</span>
                                <VisibilityEye
                                  state={itemHidden ? "all-hidden" : "all-visible"}
                                  onClick={() => toggleTakeoffItemVisibility(item.id)}
                                  variant="row"
                                  size="sm"
                                  showOnHover
                                />
                              </div>
                            );
                          })}
                      </div>
                    );
                  })}
              </div>
            );
          })}
        </TreeSection>

        {/* ─── Text annotations ───────────────────────────── */}
        <TreeSection
          title="Text annotations"
          count={textByPage.total}
          isExpanded={!!expanded.text}
          onToggleExpand={() => toggle("text")}
          badge={
            textByPage.total > 0 ? (
              <VisibilityEye
                state={sectionStates.text}
                onClick={() => {
                  if (sectionStates.text === "all-hidden") {
                    // Enable master + clear all text-hides for a clean reveal
                    if (!showTextAnnotations) toggleTextAnnotations();
                    clearTextHides();
                  } else {
                    // Disable master; per-item hides persist for next reveal
                    if (showTextAnnotations) toggleTextAnnotations();
                  }
                }}
                variant="category"
              />
            ) : undefined
          }
        >
          {Object.keys(textByPage.byPage).length === 0 && (
            <div className="px-4 py-2 text-[11px] text-[var(--muted)]">No text annotations detected.</div>
          )}
          {Object.entries(textByPage.byPage)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([pn, types]) => {
              const pnNum = Number(pn);
              const pKey = `ta-${pn}`;
              const pOpen = !!expanded[pKey];
              const pageItems: { ta: TextAnnotation; idx: number; pn: number }[] = [];
              for (const list of Object.values(types)) {
                for (const t of list) pageItems.push({ ta: t.ta, idx: t.idx, pn: pnNum });
              }
              const pageVis = aggregate(pageItems, isTextHidden);
              const pageKeys = pageItems.map(({ pn, idx }) => `${pn}:${idx}`);
              return (
                <div key={pn}>
                  <SubHeader
                    label={`Page ${pn}`}
                    count={pageItems.length}
                    isOpen={pOpen}
                    onToggle={() => toggle(pKey)}
                    visibility={pageVis}
                    onToggleVisibility={() => {
                      const next = pageVis !== "all-hidden";
                      setTextAnnotationsHiddenBulk(pageKeys, next);
                    }}
                  />
                  {pOpen &&
                    Object.entries(types).map(([type, items]) => {
                      const tKey = `${pKey}-${type}`;
                      const tOpen = !!expanded[tKey];
                      const typeHidden = activeTextAnnotationTypes[type] === false;
                      const typeItems: { ta: TextAnnotation; idx: number; pn: number }[] = items.map(
                        ({ ta, idx }) => ({ ta, idx, pn: pnNum }),
                      );
                      const typeVis: VisibilityState = typeHidden
                        ? "all-hidden"
                        : aggregate(typeItems, isTextHidden);
                      return (
                        <div key={type}>
                          <SubHeader
                            label={type}
                            count={items.length}
                            isOpen={tOpen}
                            onToggle={() => toggle(tKey)}
                            indent={2}
                            visibility={typeVis}
                            onToggleVisibility={() =>
                              setTextAnnotationType(type, typeHidden)
                            }
                          />
                          {tOpen &&
                            withCap(tKey, items, ({ ta, idx }) => {
                              const key = `${pn}:${idx}`;
                              const isHidden = hiddenTextAnnotations.has(key) || typeHidden;
                              return (
                                <div
                                  key={key}
                                  className="group flex items-center gap-2 text-[11px] py-1 hover:bg-white/5"
                                  style={{ paddingLeft: 8 + 3 * 12 }}
                                >
                                  <button
                                    onClick={() => handleNav(pnNum)}
                                    className={`flex-1 text-left truncate ${isHidden ? "text-[var(--muted)] line-through opacity-60" : "text-[var(--fg)]"}`}
                                    title={ta.text}
                                  >
                                    {ta.text}
                                  </button>
                                  <span className="text-[10px] text-[var(--muted)] shrink-0">
                                    {Math.round((ta.confidence || 0) * 100)}%
                                  </span>
                                  <VisibilityEye
                                    state={isHidden ? "all-hidden" : "all-visible"}
                                    onClick={() => toggleTextAnnotationVisibility(pnNum, idx)}
                                    variant="row"
                                    size="sm"
                                    showOnHover
                                  />
                                </div>
                              );
                            })}
                        </div>
                      );
                    })}
                </div>
              );
            })}
        </TreeSection>

        {/* ─── Tables (parsed) ─────────────────────────────── */}
        {/* User-saved schedules / keynote tables / legends / general notes,
            aggregated from pageIntelligence[pn].parsedRegions. Row click sets
            page + llmHighlight → PDFViewer scrolls the region into view. No
            per-region visibility toggle in v1 (parsed regions don't have a
            canvas-hide flag today). */}
        <TreeSection
          title="Tables"
          count={tablesByPage.total}
          isExpanded={!!expanded.tables}
          onToggleExpand={() => toggle("tables")}
        >
          {tablesByPage.total === 0 && (
            <div className="px-4 py-2 text-[11px] text-[var(--muted)]">No parsed tables yet.</div>
          )}
          {Object.entries(tablesByPage.byPage)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([pn, regions]) => {
              const pnNum = Number(pn);
              const pKey = `tables-${pn}`;
              const pOpen = !!expanded[pKey];
              return (
                <div key={pn}>
                  <SubHeader
                    label={sheetLabel(pnNum)}
                    count={regions.length}
                    isOpen={pOpen}
                    onToggle={() => toggle(pKey)}
                  />
                  {pOpen &&
                    withCap(pKey, regions, (r) => {
                      const info = (() => {
                        if (r.type === "schedule") {
                          const sd = r.data as ScheduleData;
                          return `${sd.rowCount} rows × ${sd.columnCount} cols`;
                        }
                        if (r.type === "keynote") {
                          const kd = r.data as KeynoteData;
                          return `${kd.keynotes.length} keynotes`;
                        }
                        if (r.type === "legend") {
                          const ld = r.data as LegendData;
                          return `${ld.symbols.length} symbols`;
                        }
                        if (r.type === "notes") {
                          const nd = r.data as NotesData;
                          return `${nd.notes.length} notes`;
                        }
                        return null;
                      })();
                      return (
                        <div
                          key={r.id}
                          className="flex items-center gap-2 text-[11px] py-1 hover:bg-white/5"
                          style={{ paddingLeft: 8 + 2 * 12 }}
                        >
                          <button
                            onClick={() => {
                              setPage(pnNum);
                              const [l, t, w, h] = r.bbox;
                              useViewerStore.getState().setLlmHighlight({
                                pageNumber: pnNum,
                                bbox: [l, t, l + w, t + h],
                                label: r.category,
                              });
                            }}
                            className="flex items-center gap-2 flex-1 text-left truncate"
                            title={`${r.type} · ${r.category}`}
                          >
                            <span className="font-mono text-[var(--fg)]">{r.category}</span>
                            {info && <span className="text-[var(--muted)] truncate">{info}</span>}
                          </button>
                          <span className="text-[10px] text-[var(--muted)] shrink-0">{r.type}</span>
                        </div>
                      );
                    })}
                </div>
              );
            })}
        </TreeSection>

        {/* ─── CSI codes ──────────────────────────────────── */}
        {/* CSI codes have no per-code canvas visibility state (activeCsiFilter
            is single-select filter, not a visibility toggle). Row click =
            filter-to-code, matching CsiPanel behavior. No eyeballs here in v1. */}
        <TreeSection
          title="CSI codes"
          count={csiByDivision.total}
          isExpanded={!!expanded.csi}
          onToggleExpand={() => toggle("csi")}
        >
          {Object.keys(csiByDivision.byDivision).length === 0 && (
            <div className="px-4 py-2 text-[11px] text-[var(--muted)]">No CSI codes detected.</div>
          )}
          {Object.entries(csiByDivision.byDivision)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([division, codes]) => {
              const dKey = `csi-${division}`;
              const dOpen = !!expanded[dKey];
              return (
                <div key={division}>
                  <SubHeader label={division} count={codes.length} isOpen={dOpen} onToggle={() => toggle(dKey)} />
                  {dOpen &&
                    withCap(dKey, codes, (c) => (
                      <div
                        key={c.code}
                        className="flex items-center gap-2 text-[11px] py-1 hover:bg-white/5"
                        style={{ paddingLeft: 8 + 2 * 12 }}
                      >
                        <button
                          onClick={() => setCsiFilter(c.code)}
                          className="flex items-center gap-2 flex-1 text-left truncate"
                          title={`${c.code} — ${c.description}`}
                        >
                          <span className="font-mono text-[var(--fg)]">{c.code}</span>
                          <span className="text-[var(--muted)] truncate">{c.description}</span>
                        </button>
                        <span className="text-[10px] text-[var(--muted)] shrink-0">
                          {c.pages.size}p·{c.count}
                        </span>
                      </div>
                    ))}
                </div>
              );
            })}
        </TreeSection>
      </div>

      {/* Edit group dialog — reuses MarkupDialog in edit mode. */}
      {editingGroup && (
        <MarkupDialog
          isEditing
          mode="group"
          name={editName}
          note={editNote}
          csiCode={editCsi}
          color={editColor}
          isActive={editActive}
          onNameChange={setEditName}
          onNoteChange={setEditNote}
          onCsiChange={setEditCsi}
          onColorChange={setEditColor}
          onActiveChange={setEditActive}
          onSave={handleEditSave}
          onCancel={() => setEditingGroup(null)}
        />
      )}
      {editBusy && (
        <div className="absolute inset-0 bg-black/30 flex items-center justify-center text-[var(--fg)] text-xs">
          Saving...
        </div>
      )}
    </div>
  );
}

/**
 * Small internal sub-section header — chevron + label + count + optional eye.
 * Used for nested rows below TreeSection.
 */
function SubHeader({
  label,
  count,
  isOpen,
  onToggle,
  indent = 1,
  visibility,
  onToggleVisibility,
}: {
  label: string;
  count: number;
  isOpen: boolean;
  onToggle: () => void;
  indent?: number;
  visibility?: VisibilityState;
  onToggleVisibility?: () => void;
}) {
  return (
    <div
      className="w-full flex items-center gap-2 py-1 pr-2 hover:bg-white/5"
      style={{ paddingLeft: 8 + indent * 12 }}
    >
      <button onClick={onToggle} className="flex-1 flex items-center gap-2 text-left">
        <span className="text-[10px] text-[var(--muted)] w-3 shrink-0">
          {isOpen ? "\u25BC" : "\u25B6"}
        </span>
        <span className="text-[11px] text-[var(--fg)] flex-1 truncate">{label}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface)] text-[var(--muted)] shrink-0">
          {count}
        </span>
      </button>
      {visibility && onToggleVisibility && (
        <VisibilityEye
          state={visibility}
          onClick={onToggleVisibility}
          variant="category"
          size="sm"
        />
      )}
    </div>
  );
}
