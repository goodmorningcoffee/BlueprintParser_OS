"use client";

import { useState } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import type { YoloTagInstance } from "@/types";

/** Convert keynote parsedRegion data to grid format for TableCompareModal */
function keynoteDataToGrid(data: any): { headers: string[]; rows: Record<string, string>[]; tagColumn: string; tableName?: string } {
  if (data.headers && data.rows) return { headers: data.headers, rows: data.rows, tagColumn: data.tagColumn || data.headers[0], tableName: data.tableName };
  const headers = ["Key", "Description"];
  const rows = (data.keynotes || []).map((k: any) => ({ Key: k.key || "", Description: k.description || "" }));
  return { headers, rows, tagColumn: "Key", tableName: data.tableName };
}

interface KeynoteItemProps {
  keynote: { pageNumber: number; keys: { key: string; description: string; csiCodes?: string[]; note?: string }[]; yoloClass?: string; tableName?: string };
  pageNames: Record<number, string>;
  isCurrentPage: boolean;
  onNavigate: () => void;
  activeHighlight: { pageNumber: number; key: string } | null;
  onHighlight: (key: string) => void;
  onDelete: () => void;
  region?: any;
  publicId?: string;
}

/** Collapsible keynote item in All Keynotes list */
export default function KeynoteItem({
  keynote,
  pageNames,
  isCurrentPage,
  onNavigate,
  activeHighlight,
  onHighlight,
  onDelete,
  region,
  publicId,
}: KeynoteItemProps) {
  const [expanded, setExpanded] = useState(false);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editNote, setEditNote] = useState("");
  const [editCsi, setEditCsi] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(keynote.tableName || "Keynotes");
  const [showMapTags, setShowMapTags] = useState(false);
  const [mapTagType, setMapTagType] = useState<"free-floating" | "yolo">("free-floating");
  const [mapYoloClass, setMapYoloClass] = useState<{ model: string; className: string } | null>(null);
  const [mapping, setMapping] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);

  const yoloTags = useViewerStore((s) => s.yoloTags);
  const activeTableTagViews = useViewerStore((s) => s.activeTableTagViews);
  const isTagViewActive = region?.id ? !!activeTableTagViews[region.id] : false;

  const saveName = () => {
    const trimmed = nameValue.trim();
    if (trimmed) {
      const store = useViewerStore.getState();
      const oldName = keynote.tableName;

      // 1. Update parsedKeynoteData (find by identity, not index — array may be sorted differently)
      const allKeynotes = store.parsedKeynoteData;
      if (allKeynotes) {
        const updated = allKeynotes.map((kn: any) => {
          if (kn.pageNumber === keynote.pageNumber && kn.tableName === oldName) {
            return { ...kn, tableName: trimmed };
          }
          return kn;
        });
        store.setParsedKeynoteData(updated as any);
      }

      // 2. Update matching parsedRegion in pageIntelligence
      const intel = store.pageIntelligence[keynote.pageNumber] || {};
      const regions = ((intel as any)?.parsedRegions || []).map((r: any) => {
        if (r.type !== "keynote") return r;
        if (r.data?.tableName === oldName || (!r.data?.tableName && r.category === "keynote-table")) {
          return { ...r, data: { ...r.data, tableName: trimmed }, category: trimmed };
        }
        return r;
      });
      const updatedIntel = { ...intel, parsedRegions: regions };
      store.setPageIntelligence(keynote.pageNumber, updatedIntel);

      // 3. Persist to DB (fire-and-forget)
      const { projectId, isDemo } = store;
      if (projectId && !isDemo) {
        fetch("/api/pages/intelligence", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, pageNumber: keynote.pageNumber, intelligence: updatedIntel }),
        }).catch(() => {});
      }
    }
    setEditingName(false);
  };

  const tagInstances = (key: string) => {
    const yt = yoloTags.find((t) => t.tagText === key && t.source === "keynote" && t.pageNumber === keynote.pageNumber);
    return yt?.instances?.length || 0;
  };

  const handleKeyClick = (key: string) => {
    const store = useViewerStore.getState();
    const existing = store.yoloTags.find((t) => t.tagText === key && t.source === "keynote" && t.pageNumber === keynote.pageNumber);
    if (existing) {
      if (store.activeYoloTagId === existing.id) {
        store.setActiveYoloTagId(null);
        store.setYoloTagFilter(null);
      } else {
        store.setActiveYoloTagId(existing.id);
        store.setYoloTagFilter(existing.id);
      }
    }
    onHighlight(key);
  };

  return (
    <div className={`rounded border ${isCurrentPage ? "border-amber-400/30 bg-amber-500/5" : "border-[var(--border)]"}`}>
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button onClick={() => setExpanded(!expanded)} className="text-[10px] text-[var(--muted)] shrink-0">
          {expanded ? "\u25BC" : "\u25B6"}
        </button>
        <div className="flex-1 min-w-0" onDoubleClick={onNavigate}>
          {editingName ? (
            <input autoFocus value={nameValue} onChange={(e) => setNameValue(e.target.value)}
              onBlur={saveName} onKeyDown={(e) => { if (e.key === "Enter") saveName(); if (e.key === "Escape") setEditingName(false); }}
              className="text-[11px] font-medium bg-transparent border-b border-amber-400 outline-none w-full text-[var(--fg)]" />
          ) : (
            <span onClick={() => setEditingName(true)}
              className="text-[11px] font-medium text-[var(--fg)] truncate block cursor-pointer hover:text-amber-300"
              title="Click to rename, double-click to navigate">
              {keynote.tableName || "Keynotes"}
            </span>
          )}
          <span className="text-[9px] text-[var(--muted)]">
            {pageNames[keynote.pageNumber] || `p.${keynote.pageNumber}`} &middot; {keynote.keys.length} keys
          </span>
        </div>
        {/* Eye icon — toggle mapped tag visibility */}
        {region && keynote.keys.some((k) => yoloTags.some((t) => t.tagText === k.key && t.source === "keynote")) && (
          <button
            onClick={() => {
              const store = useViewerStore.getState();
              if (isTagViewActive) {
                store.setTableTagView(region.id, null);
              } else {
                const tagTexts = keynote.keys.map((k) => k.key).filter(Boolean);
                store.setTableTagView(region.id, {
                  regionId: region.id,
                  pageNum: keynote.pageNumber,
                  bbox: region.bbox || [0, 0, 1, 1],
                  tagTexts,
                  source: "keynote",
                });
              }
            }}
            className={`text-[10px] shrink-0 ${isTagViewActive ? "text-cyan-300" : "text-[var(--muted)] hover:text-cyan-300"}`}
            title="Toggle mapped tag visibility"
          >
            {isTagViewActive ? "\u{1F441}" : "\u25CB"}
          </button>
        )}
        <button onClick={onDelete} className="text-[10px] text-[var(--muted)] hover:text-red-400 shrink-0" title="Delete keynote table">x</button>
      </div>

      {expanded && (
        <div className="px-2 pb-2 space-y-0.5 border-t border-[var(--border)] mt-0.5 pt-1">
          {/* Action buttons */}
          {!showMapTags && (
            <div className="flex gap-1 mb-1">
              {region && (
                <button
                  onClick={() => {
                    const store = useViewerStore.getState();
                    const grid = keynoteDataToGrid(region.data || {});
                    store.setTableParsedGrid({
                      headers: grid.headers,
                      rows: grid.rows,
                      tagColumn: grid.tagColumn,
                      tableName: keynote.tableName || "Keynotes",
                    });
                    store.setTableParseRegion(region.bbox || null);
                    store.setPage(keynote.pageNumber);
                    store.toggleTableCompareModal();
                  }}
                  className="flex-1 text-[9px] px-2 py-1 rounded border border-amber-500/30 text-amber-300 hover:bg-amber-500/10"
                >
                  View / Edit
                </button>
              )}
              {publicId && (
                <button
                  onClick={() => setShowMapTags(true)}
                  className="flex-1 text-[9px] px-2 py-1 rounded border border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10"
                >
                  {yoloTags.some((t) => t.source === "keynote" && keynote.keys.some((k) => k.key === t.tagText))
                    ? "Re-Map Tags" : "Map Tags"}
                </button>
              )}
            </div>
          )}

          {/* Inline Map Tags UI */}
          {showMapTags && publicId && (
            <div className="border border-cyan-500/30 rounded px-2 py-2 space-y-1.5 bg-cyan-500/5 mb-1">
              <div className="text-[10px] text-cyan-400 font-medium">Map Tags</div>
              <p className="text-[9px] text-[var(--muted)]">
                Tag column: <span className="font-mono text-[var(--fg)]">Key</span>
                {" "}({new Set(keynote.keys.map((k) => k.key.trim()).filter(Boolean)).size} unique tags)
              </p>
              <div>
                <label className="text-[9px] text-[var(--muted)] block">Tag Type</label>
                <div className="flex gap-1">
                  <button
                    onClick={() => { setMapTagType("free-floating"); setMapYoloClass(null); }}
                    className={`flex-1 text-[9px] px-2 py-1 rounded border ${mapTagType === "free-floating" ? "border-cyan-400 bg-cyan-500/10 text-cyan-300" : "border-[var(--border)] text-[var(--muted)]"}`}
                  >Free-floating</button>
                  <button
                    onClick={() => setMapTagType("yolo")}
                    className={`flex-1 text-[9px] px-2 py-1 rounded border ${mapTagType === "yolo" ? "border-cyan-400 bg-cyan-500/10 text-cyan-300" : "border-[var(--border)] text-[var(--muted)]"}`}
                  >YOLO Shape</button>
                </div>
              </div>
              {mapTagType === "yolo" && (
                <div>
                  <label className="text-[9px] text-[var(--muted)] block">YOLO Class</label>
                  {(() => {
                    const store = useViewerStore.getState();
                    const yoloAnns = store.annotations.filter((a) => a.source === "yolo");
                    const groups: Record<string, { model: string; className: string; count: number }> = {};
                    for (const a of yoloAnns) {
                      const model = (a as any).data?.modelName || "unknown";
                      const cls = a.name;
                      const key = `${model}:${cls}`;
                      if (!groups[key]) groups[key] = { model, className: cls, count: 0 };
                      groups[key].count++;
                    }
                    const sorted = Object.values(groups).sort((a, b) => b.count - a.count);
                    return sorted.length > 0 ? (
                      <div className="space-y-0.5">
                        {sorted.slice(0, 8).map((g, gi) => (
                          <button key={gi}
                            onClick={() => setMapYoloClass(mapYoloClass?.className === g.className && mapYoloClass?.model === g.model ? null : g)}
                            className={`w-full text-left text-[9px] px-1.5 py-0.5 rounded border ${
                              mapYoloClass?.className === g.className && mapYoloClass?.model === g.model
                                ? "border-cyan-400 bg-cyan-500/10 text-cyan-300"
                                : "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-hover)]"
                            }`}
                          >
                            {g.className} <span className="text-[var(--muted)]">({g.model}) &mdash; {g.count}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[9px] text-[var(--muted)] italic">No YOLO annotations loaded</div>
                    );
                  })()}
                </div>
              )}
              <div className="flex gap-1">
                <button
                  disabled={mapping}
                  onClick={async () => {
                    setMapping(true);
                    setMapError(null);
                    try {
                      const store = useViewerStore.getState();
                      const tags: string[] = [...new Set<string>(
                        keynote.keys.map((k) => k.key.trim()).filter(Boolean)
                      )].filter((tag) => !store.yoloTags.some((t) => t.tagText === tag && t.source === "keynote"));

                      if (tags.length === 0) { setShowMapTags(false); return; }

                      const res = await fetch(`/api/projects/${publicId}/map-tags-batch`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          tags,
                          yoloClass: mapTagType === "yolo" ? mapYoloClass?.className : undefined,
                          yoloModel: mapTagType === "yolo" ? mapYoloClass?.model : undefined,
                        }),
                      });
                      if (!res.ok) throw new Error(`Server error: ${res.status}`);
                      const { results }: { results: Record<string, YoloTagInstance[]> } = await res.json();

                      for (const tag of tags) {
                        const instances = results[tag] || [];
                        const k = keynote.keys.find((kk) => kk.key.trim() === tag);
                        store.addYoloTag({
                          id: `keynote-${keynote.pageNumber}-${tag}-${Date.now()}`,
                          name: tag,
                          tagText: tag,
                          yoloClass: mapTagType === "yolo" ? (mapYoloClass?.className || "") : "",
                          yoloModel: mapTagType === "yolo" ? (mapYoloClass?.model || "") : "",
                          source: "keynote",
                          scope: "project",
                          pageNumber: keynote.pageNumber,
                          description: (k?.description || "").slice(0, 200),
                          instances,
                        });
                      }
                      setShowMapTags(false);
                    } catch (err) {
                      console.error("[MAP_TAGS] Keynote batch mapping failed:", err);
                      setMapError(err instanceof Error ? err.message : "Mapping failed");
                    } finally {
                      setMapping(false);
                    }
                  }}
                  className="flex-1 text-[9px] px-2 py-1 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/30 font-medium"
                >
                  {mapping ? "Mapping..." : "Run Mapping"}
                </button>
                <button
                  onClick={() => setShowMapTags(false)}
                  className="text-[9px] px-2 py-1 rounded border border-[var(--border)] text-[var(--muted)]"
                >Cancel</button>
              </div>
              {mapError && (
                <div className="text-[9px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1 mt-1">
                  {mapError}
                </div>
              )}
            </div>
          )}

          {keynote.keys.map((k, i) => (
            <div key={i}>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => handleKeyClick(k.key)}
                  className={`flex-1 text-left text-[10px] px-1.5 py-0.5 rounded ${
                    activeHighlight?.pageNumber === keynote.pageNumber && activeHighlight?.key === k.key
                      ? "bg-amber-500/15 text-amber-300" : "hover:bg-[var(--surface-hover)] text-[var(--muted)]"
                  }`}
                >
                  <span className="font-mono font-medium text-[var(--fg)]">{k.key || "?"}</span>
                  <span className="text-[var(--muted)]"> &mdash; {k.description || "(no description)"}</span>
                  {k.csiCodes && k.csiCodes.length > 0 && (
                    <span className="text-orange-400/60 ml-1 text-[9px]">[{k.csiCodes.join(", ")}]</span>
                  )}
                  {tagInstances(k.key) > 0 && (
                    <span className="text-cyan-400/70 text-[9px] ml-1">({tagInstances(k.key)})</span>
                  )}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (editingIdx === i) { setEditingIdx(null); }
                    else { setEditingIdx(i); setEditNote(k.note || ""); setEditCsi(k.csiCodes?.join(", ") || ""); }
                  }}
                  className="text-[10px] text-[var(--muted)] hover:text-amber-300 shrink-0 px-0.5"
                  title="Edit metadata"
                >
                  {editingIdx === i ? "x" : "\u270F"}
                </button>
              </div>
              {editingIdx === i && (
                <div className="ml-2 mt-1 mb-1 space-y-1 p-1.5 rounded bg-[var(--surface)] border border-[var(--border)]">
                  <div>
                    <label className="text-[9px] text-[var(--muted)] block">CSI Codes</label>
                    <input type="text" value={editCsi} onChange={(e) => setEditCsi(e.target.value)} placeholder="e.g. 08 21 16, 09 91 00"
                      className="w-full text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] bg-transparent text-[var(--fg)] placeholder:text-[var(--muted)]/30 focus:outline-none focus:border-amber-400/50" />
                  </div>
                  <div>
                    <label className="text-[9px] text-[var(--muted)] block">Notes</label>
                    <textarea value={editNote} onChange={(e) => setEditNote(e.target.value)} placeholder="Add notes..." rows={2}
                      className="w-full text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] bg-transparent text-[var(--fg)] placeholder:text-[var(--muted)]/30 focus:outline-none focus:border-amber-400/50 resize-none" />
                  </div>
                  <button
                    onClick={() => {
                      const store = useViewerStore.getState();
                      const allKeynotes = store.parsedKeynoteData;
                      if (allKeynotes) {
                        const updated = allKeynotes.map((kn) => {
                          if (kn.pageNumber !== keynote.pageNumber || kn.tableName !== keynote.tableName) return kn;
                          return {
                            ...kn,
                            keys: kn.keys.map((key, ki) => {
                              if (ki !== i) return key;
                              return { ...key, csiCodes: editCsi.split(",").map(c => c.trim()).filter(Boolean), note: editNote };
                            }),
                          };
                        });
                        store.setParsedKeynoteData(updated as any);
                      }
                      setEditingIdx(null);
                    }}
                    className="text-[9px] px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30"
                  >
                    Save
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
