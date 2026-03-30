"use client";

import { useState } from "react";
import { useViewerStore } from "@/stores/viewerStore";

interface KeynoteItemProps {
  keynote: { pageNumber: number; keys: { key: string; description: string; csiCodes?: string[]; note?: string }[]; yoloClass?: string; tableName?: string };
  keynoteIndex: number;
  pageNames: Record<number, string>;
  isCurrentPage: boolean;
  onNavigate: () => void;
  activeHighlight: { pageNumber: number; key: string } | null;
  onHighlight: (key: string) => void;
  onDelete: () => void;
}

/** Collapsible keynote item in All Keynotes list */
export default function KeynoteItem({
  keynote,
  keynoteIndex,
  pageNames,
  isCurrentPage,
  onNavigate,
  activeHighlight,
  onHighlight,
  onDelete,
}: KeynoteItemProps) {
  const [expanded, setExpanded] = useState(false);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editNote, setEditNote] = useState("");
  const [editCsi, setEditCsi] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(keynote.tableName || "Keynotes");

  const yoloTags = useViewerStore((s) => s.yoloTags);

  const saveName = () => {
    const trimmed = nameValue.trim();
    if (trimmed) {
      const store = useViewerStore.getState();
      const allKeynotes = store.parsedKeynoteData;
      if (allKeynotes) {
        const updated = [...allKeynotes];
        updated[keynoteIndex] = { ...updated[keynoteIndex], tableName: trimmed };
        store.setParsedKeynoteData(updated as any);
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
        <button onClick={onDelete} className="text-[10px] text-[var(--muted)] hover:text-red-400 shrink-0" title="Delete keynote table">x</button>
      </div>

      {expanded && (
        <div className="px-2 pb-2 space-y-0.5">
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
