"use client";

import { useEffect, useState } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import SpecIndex from "./SpecIndex";
import SpecClassifier from "./SpecClassifier";
import SpecParser from "./SpecParser";

type SpecSubTab = "index" | "classifier" | "parser";

interface SpecPanelProps {
  embedded?: boolean;
}

/**
 * SpecPanel — Stage 5 orchestrator for the Spec parsing suite.
 * Mirrors NotesPanel structure with a violet accent and spec-dense-columns
 * region filter. Three sub-tools: Index / Classifier / Parser.
 */
export default function SpecPanel({ embedded = false }: SpecPanelProps) {
  const [tab, setTab] = useState<SpecSubTab>("index");
  const specParseRegion = useViewerStore((s) => s.specParseRegion);
  const projectId = useViewerStore((s) => s.projectId);

  useEffect(() => {
    if (specParseRegion && tab !== "parser") setTab("parser");
  }, [specParseRegion]); // eslint-disable-line react-hooks/exhaustive-deps

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
                ? "text-violet-300 border-b-2 border-violet-400"
                : "text-[var(--muted)] hover:text-[var(--fg)]"
            }`}
          >
            {t === "index" ? "Index" : t === "classifier" ? "Classifier" : "Parser"}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-hidden flex flex-col">
        {tab === "index" && <SpecIndex onOpenParser={() => setTab("parser")} />}
        {tab === "classifier" && <SpecClassifier onEditInParser={() => setTab("parser")} />}
        {tab === "parser" && <SpecParser />}
      </div>
    </>
  );

  if (embedded) {
    return <div className="flex-1 flex flex-col overflow-hidden">{content}</div>;
  }

  return (
    <div className="w-80 flex flex-col h-full border border-[var(--border)] bg-[var(--surface)] shadow-lg">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Spec</h3>
      </div>
      {content}
    </div>
  );
}
