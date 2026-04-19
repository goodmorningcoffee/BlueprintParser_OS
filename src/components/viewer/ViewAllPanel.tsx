"use client";

import { useMemo, useState } from "react";
import {
  useViewerStore,
  usePanels,
  useSelection,
  useAnnotationGroups,
  usePageData,
} from "@/stores/viewerStore";
import type { AnnotationGroup, ClientAnnotation, TakeoffGroup, ClientTakeoffItem, TextAnnotation, CsiCode } from "@/types";
import TreeSection from "./TreeSection";
import MarkupDialog from "./MarkupDialog";

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
 *
 * Performance strategy: sections collapsed by default (no child rendering
 * until expanded); per-section row cap of 100 with "Show N more" grows cap
 * by 100 each click. No virtualization — collapse-by-default keeps DOM
 * small for typical scroll.
 */
export default function ViewAllPanel() {
  const { toggleViewAllPanel } = usePanels();

  // Direct selectors — no useTakeoffs hook exists; matches TakeoffPanel.tsx:28 pattern.
  const annotations = useViewerStore((s) => s.annotations);
  const takeoffItems = useViewerStore((s) => s.takeoffItems);
  const takeoffGroups = useViewerStore((s) => s.takeoffGroups);
  const setPage = useViewerStore((s) => s.setPage);
  const setFocusAnnotationId = useViewerStore((s) => s.setFocusAnnotationId);
  const setActiveTakeoffItemId = useViewerStore((s) => s.setActiveTakeoffItemId);

  const {
    annotationGroups,
    annotationGroupMemberships,
    groupMembers,
    upsertAnnotationGroup,
  } = useAnnotationGroups();
  const { csiCodes, textAnnotations, setCsiFilter } = usePageData();
  const { selectedAnnotationIds, setSelectedAnnotationIds } = useSelection();

  // Section expand state — collapsed by default.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (k: string) =>
    setExpanded((s) => ({ ...s, [k]: !s[k] }));

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

  // Shared row-action helpers.
  const handleNav = (pageNumber: number, focusId?: number) => {
    setPage(pageNumber);
    if (focusId !== undefined) setFocusAnnotationId(focusId);
  };

  const toggleAnnSelection = (annId: number) => {
    const next = new Set(selectedAnnotationIds);
    if (next.has(annId)) next.delete(annId);
    else next.add(annId);
    setSelectedAnnotationIds(next);
  };

  // ─── Derived per-section data ────────────────────────────

  // Groups — filter by search on name/csi.
  const groupsFiltered = useMemo(
    () => annotationGroups.filter((g) => match(g.name) || match(g.csiCode)),
    [annotationGroups, q],
  );

  // Annotations by source (filter by search once).
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

  // Detections hierarchy: YOLO by model→class, Shape Parse by shape, Symbol Search by source page.
  const detectionBuckets = useMemo(() => {
    const yoloModels: Record<string, Record<string, ClientAnnotation[]>> = {};
    const shapeByShape: Record<string, ClientAnnotation[]> = {};
    const symbolByPage: Record<number, ClientAnnotation[]> = {};
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
      } else if (a.source === "shape-parse") {
        const shape = (a.data?.shapeType as string) || a.name || "shape";
        if (!shapeByShape[shape]) shapeByShape[shape] = [];
        shapeByShape[shape].push(a);
      } else if (a.source === "symbol-search") {
        const src = (a.data?.templateSourcePage as number) || a.pageNumber;
        if (!symbolByPage[src]) symbolByPage[src] = [];
        symbolByPage[src].push(a);
      }
    }
    return { yoloModels, shapeByShape, symbolByPage, total };
  }, [filteredAnnotations]);

  // Markup by page.
  const markupByPage = useMemo(() => {
    const byPage: Record<number, ClientAnnotation[]> = {};
    let total = 0;
    for (const a of filteredAnnotations) {
      if (a.source !== "user") continue;
      if (!byPage[a.pageNumber]) byPage[a.pageNumber] = [];
      byPage[a.pageNumber].push(a);
      total++;
    }
    return { byPage, total };
  }, [filteredAnnotations]);

  // Takeoffs by kind nested under takeoffGroups.
  const takeoffsByKind = useMemo(() => {
    const byKind: Record<string, Record<string, ClientTakeoffItem[]>> = {
      count: {},
      area: {},
      linear: {},
    };
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
      total++;
    }
    return { byKind, groupById, total };
  }, [takeoffItems, takeoffGroups, q]);

  // Text annotations by page → type.
  const textByPage = useMemo(() => {
    const byPage: Record<number, Record<string, TextAnnotation[]>> = {};
    let total = 0;
    for (const [pnStr, list] of Object.entries(textAnnotations)) {
      const pn = Number(pnStr);
      if (!list) continue;
      for (const ta of list) {
        if (!match(ta.text) && !match(ta.type)) continue;
        if (!byPage[pn]) byPage[pn] = {};
        if (!byPage[pn][ta.type]) byPage[pn][ta.type] = [];
        byPage[pn][ta.type].push(ta);
        total++;
      }
    }
    return { byPage, total };
  }, [textAnnotations, q]);

  // CSI codes by division — aggregate detected codes across all pages.
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
    const total = Object.keys(agg).length;
    return { byDivision, total };
  }, [csiCodes, q]);

  // Shared row-cap renderer: slice + optional "Show more" button.
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

  // Small annotation row — used by Groups (members), Detections (instances), Markup.
  function AnnotationRow({ ann, indent = 0 }: { ann: ClientAnnotation; indent?: number }) {
    const csi = (ann.data?.csiCodes as string[] | undefined)?.[0];
    const color = (ann.data?.color as string | undefined) || null;
    const isSelected = selectedAnnotationIds.has(ann.id);
    return (
      <div
        className={`flex items-center gap-2 px-2 py-1 text-[11px] hover:bg-white/5 ${isSelected ? "bg-[var(--accent)]/10" : ""}`}
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
          className="flex-1 text-left truncate text-[var(--fg)]"
          title={ann.name}
        >
          {ann.name}
        </button>
        <span className="text-[10px] text-[var(--muted)] shrink-0">p.{ann.pageNumber}</span>
        {csi && (
          <span className="text-[9px] text-[var(--muted)] font-mono shrink-0">{csi}</span>
        )}
      </div>
    );
  }

  return (
    <div className="w-80 flex flex-col h-full overflow-hidden border border-[var(--border)] bg-[var(--surface)] shadow-lg">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
        <h3 className="text-sm font-medium text-[var(--fg)]">View All</h3>
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
            return (
              <div key={g.id}>
                <div className="flex items-center gap-2 px-3 py-1 hover:bg-white/5">
                  <button
                    onClick={() => toggle(key)}
                    className="text-[10px] text-[var(--muted)] w-3 shrink-0"
                  >
                    {isOpen ? "\u25BC" : "\u25B6"}
                  </button>
                  {g.color && (
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: g.color, opacity: g.isActive === false ? 0.4 : 1 }}
                    />
                  )}
                  <button
                    onClick={() => toggle(key)}
                    className={`text-xs flex-1 text-left truncate ${g.isActive === false ? "text-[var(--muted)]" : "text-[var(--fg)]"}`}
                    title={g.name}
                  >
                    {g.name}
                    {g.isActive === false && (
                      <span className="text-[9px] ml-2 text-[var(--muted)]">(inactive)</span>
                    )}
                  </button>
                  {g.csiCode && (
                    <span className="text-[10px] text-[var(--muted)] font-mono shrink-0">{g.csiCode}</span>
                  )}
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface)] text-[var(--muted)] shrink-0">
                    {memberCount}
                  </span>
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
        >
          {/* YOLO sub-section */}
          {Object.keys(detectionBuckets.yoloModels).length > 0 && (
            <SubHeader
              label="YOLO"
              count={Object.values(detectionBuckets.yoloModels).reduce(
                (n, classes) => n + Object.values(classes).reduce((m, anns) => m + anns.length, 0),
                0,
              )}
              isOpen={!!expanded["det-yolo"]}
              onToggle={() => toggle("det-yolo")}
            />
          )}
          {expanded["det-yolo"] &&
            Object.entries(detectionBuckets.yoloModels).map(([model, classes]) => {
              const mkey = `det-yolo-${model}`;
              const mOpen = !!expanded[mkey];
              const modelTotal = Object.values(classes).reduce((n, anns) => n + anns.length, 0);
              return (
                <div key={model}>
                  <SubHeader
                    label={model}
                    count={modelTotal}
                    isOpen={mOpen}
                    onToggle={() => toggle(mkey)}
                    indent={2}
                  />
                  {mOpen &&
                    Object.entries(classes).map(([cls, anns]) => {
                      const ckey = `${mkey}-${cls}`;
                      const cOpen = !!expanded[ckey];
                      return (
                        <div key={cls}>
                          <SubHeader
                            label={cls}
                            count={anns.length}
                            isOpen={cOpen}
                            onToggle={() => toggle(ckey)}
                            indent={3}
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
              count={Object.values(detectionBuckets.shapeByShape).reduce((n, a) => n + a.length, 0)}
              isOpen={!!expanded["det-shape"]}
              onToggle={() => toggle("det-shape")}
            />
          )}
          {expanded["det-shape"] &&
            Object.entries(detectionBuckets.shapeByShape).map(([shape, anns]) => {
              const skey = `det-shape-${shape}`;
              const sOpen = !!expanded[skey];
              return (
                <div key={shape}>
                  <SubHeader label={shape} count={anns.length} isOpen={sOpen} onToggle={() => toggle(skey)} indent={2} />
                  {sOpen && withCap(skey, anns, (a) => <AnnotationRow key={a.id} ann={a} indent={3} />)}
                </div>
              );
            })}

          {/* Symbol Search sub-section */}
          {Object.keys(detectionBuckets.symbolByPage).length > 0 && (
            <SubHeader
              label="Symbol Search"
              count={Object.values(detectionBuckets.symbolByPage).reduce((n, a) => n + a.length, 0)}
              isOpen={!!expanded["det-symbol"]}
              onToggle={() => toggle("det-symbol")}
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
                  <SubHeader label={`Page ${pn}`} count={anns.length} isOpen={pOpen} onToggle={() => toggle(pkey)} />
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
            const kindTotal = groupsList.reduce((n, [, items]) => n + items.length, 0);
            return (
              <div key={kind}>
                <SubHeader label={kind} count={kindTotal} isOpen={kOpen} onToggle={() => toggle(kKey)} />
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
                        />
                        {gOpen &&
                          withCap(gKey, items, (item) => (
                            <div
                              key={item.id}
                              className="flex items-center gap-2 text-[11px] py-1 hover:bg-white/5"
                              style={{ paddingLeft: 8 + 3 * 12 }}
                            >
                              <span
                                className="w-2 h-2 rounded-full shrink-0"
                                style={{ backgroundColor: item.color }}
                              />
                              <button
                                onClick={() => setActiveTakeoffItemId(item.id)}
                                className="flex-1 text-left truncate text-[var(--fg)]"
                                title={item.name}
                              >
                                {item.name}
                              </button>
                              <span className="text-[10px] text-[var(--muted)] shrink-0">{item.shape}</span>
                            </div>
                          ))}
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
        >
          {Object.keys(textByPage.byPage).length === 0 && (
            <div className="px-4 py-2 text-[11px] text-[var(--muted)]">No text annotations detected.</div>
          )}
          {Object.entries(textByPage.byPage)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([pn, types]) => {
              const pKey = `ta-${pn}`;
              const pOpen = !!expanded[pKey];
              const pageTotal = Object.values(types).reduce((n, items) => n + items.length, 0);
              return (
                <div key={pn}>
                  <SubHeader label={`Page ${pn}`} count={pageTotal} isOpen={pOpen} onToggle={() => toggle(pKey)} />
                  {pOpen &&
                    Object.entries(types).map(([type, items]) => {
                      const tKey = `${pKey}-${type}`;
                      const tOpen = !!expanded[tKey];
                      return (
                        <div key={type}>
                          <SubHeader
                            label={type}
                            count={items.length}
                            isOpen={tOpen}
                            onToggle={() => toggle(tKey)}
                            indent={2}
                          />
                          {tOpen &&
                            withCap(tKey, items, (ta, idx) => (
                              <div
                                key={`${type}-${idx}`}
                                className="flex items-center gap-2 text-[11px] py-1 hover:bg-white/5"
                                style={{ paddingLeft: 8 + 3 * 12 }}
                              >
                                <button
                                  onClick={() => handleNav(Number(pn))}
                                  className="flex-1 text-left truncate text-[var(--fg)]"
                                  title={ta.text}
                                >
                                  {ta.text}
                                </button>
                                <span className="text-[10px] text-[var(--muted)] shrink-0">
                                  {Math.round((ta.confidence || 0) * 100)}%
                                </span>
                              </div>
                            ))}
                        </div>
                      );
                    })}
                </div>
              );
            })}
        </TreeSection>

        {/* ─── CSI codes ──────────────────────────────────── */}
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
 * Small internal sub-section header — chevron + label + count.
 * Used for nested rows below TreeSection (so TreeSection stays the
 * top-level section frame and SubHeader handles the intermediate tiers).
 */
function SubHeader({
  label,
  count,
  isOpen,
  onToggle,
  indent = 1,
}: {
  label: string;
  count: number;
  isOpen: boolean;
  onToggle: () => void;
  indent?: number;
}) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center gap-2 py-1 pr-2 hover:bg-white/5 text-left"
      style={{ paddingLeft: 8 + indent * 12 }}
    >
      <span className="text-[10px] text-[var(--muted)] w-3 shrink-0">
        {isOpen ? "\u25BC" : "\u25B6"}
      </span>
      <span className="text-[11px] text-[var(--fg)] flex-1 truncate">{label}</span>
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface)] text-[var(--muted)] shrink-0">
        {count}
      </span>
    </button>
  );
}
