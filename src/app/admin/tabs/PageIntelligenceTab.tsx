"use client";

import { useState } from "react";

interface PageIntelligenceTabProps {
  reprocessing: boolean;
  reprocessLog: string[];
  onReprocess: () => void;
}

export default function PageIntelligenceTab({ reprocessing, reprocessLog, onReprocess }: PageIntelligenceTabProps) {
  const [reprocessingIntel, setReprocessingIntel] = useState(false);
  const [intelLog, setIntelLog] = useState<string[]>([]);

  async function reprocessIntelligence() {
    setReprocessingIntel(true);
    setIntelLog(["Starting intelligence reprocessing..."]);
    try {
      const res = await fetch("/api/admin/reprocess?scope=intelligence", { method: "POST" });
      if (res.ok && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.type === "start") setIntelLog(prev => [...prev, `Processing ${msg.projects} project(s)...`]);
              else if (msg.type === "project") setIntelLog(prev => [...prev, `Project: ${msg.name} (${msg.pages} pages)`]);
              else if (msg.type === "progress") setIntelLog(prev => [...prev, `  ${msg.updated}/${msg.total} pages updated`]);
              else if (msg.type === "project-analysis") setIntelLog(prev => [...prev, `  Project analysis complete`]);
              else if (msg.type === "done") setIntelLog(prev => [...prev, `Done: ${msg.updated} pages updated across ${msg.projects || "all"} projects`]);
              else if (msg.type === "error") setIntelLog(prev => [...prev, `Error: ${msg.message}`]);
            } catch { /* skip non-JSON lines */ }
          }
        }
      } else {
        setIntelLog(prev => [...prev, "Reprocessing failed"]);
      }
    } catch {
      setIntelLog(prev => [...prev, "Reprocessing failed"]);
    }
    setReprocessingIntel(false);
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Page Intelligence</h2>
        <p className="text-sm text-[var(--muted)] mt-1">
          Page-level intelligence includes classification, cross-references, note blocks, text regions, heuristic inferences, classified tables, and CSI spatial mapping.
          Project-level intelligence includes drawing sequence analysis, reference graphs, CSI topology, and CSI network graphs.
        </p>
      </div>

      {/* Pipeline description */}
      <section className="border border-[var(--border)] rounded-lg p-4 space-y-3">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Intelligence Pipeline</h3>
        <p className="text-xs text-[var(--muted)]">
          The intelligence pipeline runs automatically during PDF processing and after YOLO loads. Use the buttons below to manually re-run on existing data.
        </p>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="p-2 rounded bg-[var(--surface)] border border-[var(--border)]">
            <div className="font-medium text-[var(--fg)] mb-1">Per-Page Analysis</div>
            <ul className="text-[var(--muted)] space-y-0.5 text-[10px]">
              <li>Page classification (discipline + drawing type)</li>
              <li>Cross-reference detection</li>
              <li>Note block detection</li>
              <li>Text region classification</li>
              <li>Heuristic engine inferences</li>
              <li>Table/schedule classification</li>
              <li>CSI spatial heatmap</li>
            </ul>
          </div>
          <div className="p-2 rounded bg-[var(--surface)] border border-[var(--border)]">
            <div className="font-medium text-[var(--fg)] mb-1">Per-Project Analysis</div>
            <ul className="text-[var(--muted)] space-y-0.5 text-[10px]">
              <li>Drawing sequence analysis</li>
              <li>Cross-reference graph</li>
              <li>CSI topology analysis</li>
              <li>CSI network graph + fingerprint</li>
              <li>Auto-generated project report</li>
            </ul>
          </div>
        </div>
      </section>

      {/* Actions */}
      <div className="flex gap-3 items-center flex-wrap">
        <button
          onClick={reprocessIntelligence}
          disabled={reprocessingIntel || reprocessing}
          className="px-4 py-2 text-sm rounded bg-cyan-600 text-white hover:bg-cyan-500 disabled:opacity-50"
        >
          {reprocessingIntel ? "Reprocessing Intelligence..." : "Reprocess Intelligence (All Projects)"}
        </button>
        <button
          onClick={onReprocess}
          disabled={reprocessing || reprocessingIntel}
          className="px-4 py-2 text-sm rounded border border-orange-400/40 text-orange-400 hover:bg-orange-400/10 disabled:opacity-50"
        >
          {reprocessing ? "Reprocessing..." : "Full Reprocess (OCR + CSI + Intelligence)"}
        </button>
        <p className="text-[10px] text-[var(--muted)] w-full">
          "Reprocess Intelligence" re-runs only the analysis layers on existing OCR/CSI data (fast).
          "Full Reprocess" re-runs everything including CSI detection and text annotations (slower).
        </p>
      </div>

      {/* Intelligence reprocess log */}
      {intelLog.length > 0 && (
        <div className="border border-[var(--border)] rounded p-3 max-h-40 overflow-y-auto bg-[var(--surface)]">
          {intelLog.map((line, i) => (
            <div key={i} className="text-xs text-[var(--muted)] font-mono">{line}</div>
          ))}
        </div>
      )}

      {/* Full reprocess log */}
      {reprocessLog.length > 0 && (
        <div className="border border-[var(--border)] rounded p-3 max-h-40 overflow-y-auto bg-[var(--surface)]">
          {reprocessLog.map((line, i) => (
            <div key={i} className="text-xs text-[var(--muted)] font-mono">{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}
