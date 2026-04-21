"use client";

import { useViewerStore, usePanels } from "@/stores/viewerStore";
import KeynotePanel from "./KeynotePanel";

/**
 * SpecsNotesPanel — D2 orchestrator (new 2026-04-21).
 *
 * Wraps the existing KeynotePanel under the "Keynotes" sub-tab and scaffolds
 * three additional tabs (Specs / General Notes / Notes Mapping) for upcoming
 * work on the project → page → grid-region → note-box → specific-note-paragraph
 * mapping hierarchy per product_vision_graph_builder.md.
 *
 * Pattern mirrors TableParsePanel: thin orchestrator, single header + tab bar
 * + content area that switches on a store field (specsNotesTab). Child
 * content renders in "embedded" mode so the child's own chrome (border,
 * close button, outer header) is suppressed.
 */
export default function SpecsNotesPanel() {
  const { toggleSpecsNotesPanel, specsNotesTab, setSpecsNotesTab } = usePanels();
  const showParsedRegions = useViewerStore((s) => s.showParsedRegions);
  const toggleParsedRegions = useViewerStore((s) => s.toggleParsedRegions);

  return (
    <div className="w-80 flex flex-col h-full border border-[var(--border)] bg-[var(--surface)] shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Specs / Notes</h3>
        <div className="flex items-center gap-1">
          {specsNotesTab === "keynotes" && (
            <button
              onClick={toggleParsedRegions}
              className={`text-sm px-1 ${showParsedRegions ? "text-amber-300" : "text-[var(--muted)]/30"}`}
              title="Toggle keynote region outlines on canvas"
            >
              {showParsedRegions ? "\u25CF" : "\u25CB"}
            </button>
          )}
          <button
            onClick={toggleSpecsNotesPanel}
            className="text-[var(--muted)] hover:text-[var(--fg)] text-lg leading-none"
          >
            &times;
          </button>
        </div>
      </div>

      {/* Tab bar — same rhythm as TableParsePanel L400-417 */}
      <div className="flex border-b border-[var(--border)]">
        {(["spec-parse", "notes-parse", "keynotes"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setSpecsNotesTab(tab)}
            className={`flex-1 px-1.5 py-1.5 text-[9px] font-medium ${
              specsNotesTab === tab
                ? "text-amber-300 border-b-2 border-amber-400"
                : "text-[var(--muted)] hover:text-[var(--fg)]"
            }`}
          >
            {tab === "spec-parse"
              ? "Spec Parse"
              : tab === "notes-parse"
                ? "Notes Parse"
                : "Keynotes"}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {specsNotesTab === "spec-parse" && <StubTab label="Spec Parse" />}
        {specsNotesTab === "notes-parse" && <StubTab label="Notes Parse" />}
        {specsNotesTab === "keynotes" && <KeynotePanel embedded />}
      </div>
    </div>
  );
}

function StubTab({ label }: { label: string }) {
  return (
    <div className="flex-1 flex items-center justify-center px-6 py-8 text-center">
      <div>
        <div className="text-[11px] text-[var(--muted)] mb-1">{label}</div>
        <div className="text-[10px] text-[var(--muted)]/70">
          Coming soon — part of the Specs/Notes mapping hierarchy:
          <br />project → page → grid region → notes box → tagged paragraph.
        </div>
      </div>
    </div>
  );
}
