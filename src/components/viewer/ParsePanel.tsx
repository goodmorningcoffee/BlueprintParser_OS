"use client";

import type { PDFDocumentProxy } from "pdfjs-dist";
import { usePanels } from "@/stores/viewerStore";
import DetectionPanel from "./DetectionPanel";
import SymbolSearchPanel from "./SymbolSearchPanel";

/**
 * ParsePanel — D3 orchestrator (new 2026-04-21).
 *
 * Houses the three parsing tools the user calls out under one roof:
 *   - Shape Parse          → DetectionPanel embedded, lockedTab="shape"
 *   - Template Parse       → SymbolSearchPanel embedded (renamed from Symbol Search)
 *   - YOLO-Tag-Map         → DetectionPanel embedded, lockedTab="tags"
 *
 * Follows the TableParsePanel orchestrator pattern: single header + tab bar +
 * content area switched on a store field (parsePanelTab). Each tab mounts the
 * existing panel in "embedded" mode — the child skips its own chrome so only
 * the orchestrator's header is visible. Underlying store state + hooks are
 * reused, no duplication.
 *
 * The YOLO toolbar button still opens DetectionPanel standalone (full tabs) —
 * ParsePanel is an additional entry point, not a replacement. Deprecation of
 * the duplicate tabs in DetectionPanel is deferred to a later pass.
 */
export default function ParsePanel({ pdfDoc }: { pdfDoc: PDFDocumentProxy | null }) {
  const { toggleParsePanel, parsePanelTab, setParsePanelTab } = usePanels();

  return (
    <div className="w-72 flex flex-col h-full border border-[var(--border)] bg-[var(--surface)] shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Parse</h3>
        <button
          onClick={toggleParsePanel}
          className="text-[var(--muted)] hover:text-[var(--fg)] text-lg leading-none"
        >
          &times;
        </button>
      </div>

      {/* Tab bar — matches TableParsePanel L400-417 rhythm */}
      <div className="flex border-b border-[var(--border)]">
        {(["shape", "template", "yolo-tag-map"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setParsePanelTab(tab)}
            className={`flex-1 px-1.5 py-1.5 text-[9px] font-medium ${
              parsePanelTab === tab
                ? "text-cyan-300 border-b-2 border-cyan-400"
                : "text-[var(--muted)] hover:text-[var(--fg)]"
            }`}
          >
            {tab === "shape"
              ? "Shape Parse"
              : tab === "template"
                ? "Template Parse"
                : "YOLO-Tag-Map"}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {parsePanelTab === "shape" && <DetectionPanel embedded lockedTab="shape" />}
        {parsePanelTab === "template" && <SymbolSearchPanel pdfDoc={pdfDoc} embedded />}
        {parsePanelTab === "yolo-tag-map" && <DetectionPanel embedded lockedTab="tags" />}
      </div>
    </div>
  );
}
