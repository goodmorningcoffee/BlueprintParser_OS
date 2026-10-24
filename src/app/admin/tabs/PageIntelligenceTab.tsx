"use client";

// [2026-10-24 master Reprocess tab] This tab used to own three reprocess buttons with two private
// NDJSON readers that dropped the server's `error` lines (and rendered `msg.message` where the server
// sends `msg.error`). They are links into the Reprocess tab now; the classifier-debug option lives on
// its Intelligence stage. The pipeline description stays.

import OpenReprocessLink from "./OpenReprocessLink";
import type { ReprocessPreset } from "./reprocess-plan";

interface PageIntelligenceTabProps {
  onOpenReprocess: (preset: ReprocessPreset) => void;
}

export default function PageIntelligenceTab({ onOpenReprocess }: PageIntelligenceTabProps) {
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
          The intelligence pipeline runs automatically during PDF processing and after YOLO loads. Use the Reprocess tab to re-run it on existing data.
        </p>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="p-2 rounded bg-[var(--surface)] border border-[var(--border)]">
            <div className="font-medium text-[var(--fg)] mb-1">Per-Page Analysis</div>
            <ul className="text-[var(--muted)] space-y-0.5 text-[10px]">
              <li>Page classification (discipline + drawing type)</li>
              <li>Cross-reference detection</li>
              <li>Note block detection</li>
              <li>Text region classification (Stage 1 composite, 2026-04-24)</li>
              <li>Heuristic engine (YOLO-aware if annotations already exist)</li>
              <li>Table/schedule classification</li>
              <li>Composite region classifier (tables / title blocks / drawings — fires only when YOLO data is present)</li>
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

      {/* Re-runs: links into the Reprocess tab */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Re-run</h3>
        <div className="flex flex-col gap-1">
          <OpenReprocessLink preset="page-names" onOpen={onOpenReprocess} note="Page names — re-extract drawing numbers (label-anchored search + regex + YOLO title blocks):" />
          <OpenReprocessLink preset="rules-changed" onOpen={onOpenReprocess} note="Intelligence only — re-run the analysis layers on existing OCR/CSI data (fast; classifier debug is an option there):" />
          <OpenReprocessLink preset="detectors-changed" onOpen={onOpenReprocess} note="Full — CSI detection + text annotations on the existing OCR, then intelligence (slower):" />
        </div>
      </section>
    </div>
  );
}
