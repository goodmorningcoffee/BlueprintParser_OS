"use client";

import { usePanels } from "@/stores/viewerStore";
import CsiPanel from "./CsiPanel";
import TextPanel from "./TextPanel";
import PageIntelligencePanel from "./PageIntelligencePanel";

/**
 * ToolsPanel — D4 orchestrator (new 2026-04-21).
 *
 * Consolidates three small analysis tools that used to each own a toolbar
 * button. Each tab mounts the existing panel in "embedded" mode (outer
 * wrapper, border, and own header suppressed) so only this orchestrator's
 * header shows. State + hooks are all reused from the underlying panels —
 * no duplication.
 *
 * Follows the TableParsePanel orchestrator pattern: single header + tab bar
 * + content area switched on a store field (toolsPanelTab).
 */
export default function ToolsPanel() {
  const { toggleToolsPanel, toolsPanelTab, setToolsPanelTab } = usePanels();

  return (
    <div className="w-80 flex flex-col h-full border border-[var(--border)] bg-[var(--surface)] shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Tools</h3>
        <button
          onClick={toggleToolsPanel}
          className="text-[var(--muted)] hover:text-[var(--fg)] text-lg leading-none"
        >
          &times;
        </button>
      </div>

      {/* Tab bar — same rhythm as TableParsePanel L400-417 */}
      <div className="flex border-b border-[var(--border)]">
        {(["csi", "text", "intel"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setToolsPanelTab(tab)}
            className={`flex-1 px-1.5 py-1.5 text-[9px] font-medium ${
              toolsPanelTab === tab
                ? "text-green-300 border-b-2 border-green-400"
                : "text-[var(--muted)] hover:text-[var(--fg)]"
            }`}
          >
            {tab === "csi" ? "CSI" : tab === "text" ? "Text" : "Page Intel"}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {toolsPanelTab === "csi" && <CsiPanel embedded />}
        {toolsPanelTab === "text" && <TextPanel embedded />}
        {toolsPanelTab === "intel" && <PageIntelligencePanel embedded />}
      </div>
    </div>
  );
}
