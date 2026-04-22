"use client";

import { useEffect, useState } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import NotesIndex from "./NotesIndex";
import NotesClassifier from "./NotesClassifier";
import NotesParser from "./NotesParser";

type NotesSubTab = "index" | "classifier" | "parser";

interface NotesPanelProps {
  /** When true, suppresses outer chrome (border/shadow/header) so the panel
   *  can be embedded inside SpecsNotesPanel's existing tab scaffold. */
  embedded?: boolean;
}

/**
 * NotesPanel — Stage 4 orchestrator for the Notes parsing suite.
 *
 * Renders three sub-tools:
 *   - Index: project-wide notes regions, click jumps to page + Parser
 *   - Classifier: per-page Accept/Edit/Reject cards
 *   - Parser: commit tool with Auto / Guided / Fast-manual / Manual sub-modes
 *
 * Mirrors KeynotePanel's embedded prop + flat-button tab row styling.
 */
export default function NotesPanel({ embedded = false }: NotesPanelProps) {
  const [tab, setTab] = useState<NotesSubTab>("index");
  const notesParseRegion = useViewerStore((s) => s.notesParseRegion);
  const projectId = useViewerStore((s) => s.projectId);

  // Auto-switch to Parser when a region is pre-selected (Classifier Edit or Index row click).
  useEffect(() => {
    if (notesParseRegion && tab !== "parser") {
      setTab("parser");
    }
  }, [notesParseRegion]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset to Index on project switch.
  useEffect(() => {
    setTab("index");
  }, [projectId]);

  const content = (
    <>
      <div className="flex border-b border-[var(--border)]">
        {(["index", "classifier", "parser"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 px-1.5 py-1.5 text-[9px] font-medium ${
              tab === t
                ? "text-blue-300 border-b-2 border-blue-400"
                : "text-[var(--muted)] hover:text-[var(--fg)]"
            }`}
          >
            {t === "index" ? "Index" : t === "classifier" ? "Classifier" : "Parser"}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-hidden flex flex-col">
        {tab === "index" && <NotesIndex onOpenParser={() => setTab("parser")} />}
        {tab === "classifier" && <NotesClassifier onEditInParser={() => setTab("parser")} />}
        {tab === "parser" && <NotesParser />}
      </div>
    </>
  );

  if (embedded) {
    return <div className="flex-1 flex flex-col overflow-hidden">{content}</div>;
  }

  return (
    <div className="w-80 flex flex-col h-full border border-[var(--border)] bg-[var(--surface)] shadow-lg">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Notes</h3>
      </div>
      {content}
    </div>
  );
}
