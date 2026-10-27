"use client";

import { useState, useEffect } from "react";
import CsiSpatialGridPicker from "./CsiSpatialGridPicker";
import UploadComputePicker from "./UploadComputePicker";
import TilesToggle from "./TilesToggle";
import ParseEngineCard from "./pipeline/ParseEngineCard";
import OpenReprocessLink from "./OpenReprocessLink";
import type { ReprocessPreset } from "./reprocess-plan";

interface PipelineTabProps {
  /** [2026-10-24] The Reprocess section (scope picker + 5 scopes + log) moved to the Reprocess tab; this tab keeps config. */
  onOpenReprocess: (preset: ReprocessPreset) => void;
  isRootAdmin?: boolean;
}

interface PipelineConfig {
  disabledSteps?: string[];
  pageConcurrency?: number;
  csiSpatialGrid?: { rows: number; cols: number };
  tableProposals?: {
    enabled: boolean;
    yoloSources: { modelId: number; modelName: string; classes: string[] }[];
  };
  qtoPreCompute?: {
    enabled: boolean;
    templates: any[];
  };
  /** Stage 2c: auto-table-detector opt-in + tuning. */
  autoDetect?: {
    tables?: boolean;
    minProbability?: number;
    categoryFilter?: string[];
  };
  /** Stage 2b: ensemble reducer advanced tuning (enable/disable via disabledSteps["ensemble"]). */
  ensemble?: {
    config?: {
      minDistinctVotes?: number;
      iouThreshold?: number;
      containThreshold?: number;
      probabilityThreshold?: number;
      sourceWeights?: Record<string, number>;
    };
  };
}

const UPLOAD_STEPS = [
  { id: "csi-detection", name: "CSI Code Detection", description: "Detect CSI MasterFormat codes from OCR text", configTab: "csi", alwaysOn: false },
  { id: "text-annotations", name: "Text Annotations", description: "Detect phone, email, equipment tags, abbreviations", configTab: "text-annotations", alwaysOn: false },
  { id: "page-intelligence", name: "Page Intelligence", description: "Classify pages, detect cross-references, note blocks", configTab: null, alwaysOn: false },
  { id: "text-regions", name: "Text Region Classification", description: "Identify schedule tables, notes, spec columns, K:V legends from OCR", configTab: null, alwaysOn: false },
  { id: "heuristic-engine", name: "Heuristic Engine (text-only)", description: "Rule-based inference: schedule detection, symbol legends, notes", configTab: "heuristics", alwaysOn: false },
  { id: "table-classification", name: "Table Classification", description: "Combine text regions + heuristics to classify schedules", configTab: null, alwaysOn: false },
  { id: "csi-spatial", name: "CSI Spatial Mapping", description: "Heatmap: which page zones contain which CSI codes", configTab: null, alwaysOn: false },
  { id: "shape-parse", name: "Shape Parse (Keynotes)", description: "Detect circles, diamonds, hexagons with text — OpenCV + Tesseract, no ML model needed", configTab: null, alwaysOn: false },
];

const POST_YOLO_STEPS = [
  { id: "heuristic-yolo", name: "Heuristic Engine (YOLO-augmented)", description: "Re-run rules with YOLO spatial signals", configTab: "heuristics", alwaysOn: false },
  { id: "table-reclassify", name: "Table Reclassification", description: "Re-classify with YOLO-enriched heuristics", configTab: null, alwaysOn: false },
  { id: "yolo-csi-merge", name: "YOLO CSI Code Merge", description: "Add CSI codes from YOLO model class config to pages", configTab: null, alwaysOn: false },
  { id: "yolo-heatmap", name: "YOLO Density Heatmap (Stage 2a)", description: "Aggregate text_box + vertical_area + horizontal_area density into confident-region bboxes", configTab: null, alwaysOn: false },
  { id: "ensemble", name: "Ensemble Reducer (Stage 2b)", description: "Cross-signal table detection — suppresses keyword-only false positives by requiring ≥2 distinct vote sources", configTab: null, alwaysOn: false },
  { id: "auto-table-detect", name: "Auto-Table Detect (Stage 2c)", description: "Emit AutoTableProposal[] from ensembleRegions for downstream auto-parse. Opt-in — disabled by default.", configTab: null, alwaysOn: false },
];

// [fix 2026-10-21] Only these disabledSteps ids have a reader (processing.ts shape-parse;
// reprocess.ts + yolo.ts heatmap/ensemble). The other step toggles used to save a setting
// nothing reads, so switching them OFF changed nothing. They render as not-a-toggle now.
const WIRED_STEP_IDS = new Set(["shape-parse", "yolo-heatmap", "ensemble"]);

const ALWAYS_ON_STEPS = [
  "PDF Rasterization + OCR",
  "Drawing Number Extraction",
  "Project Analysis + Summaries",
];

export default function PipelineTab({ onOpenReprocess, isRootAdmin = false }: PipelineTabProps) {
  const [config, setConfig] = useState<PipelineConfig>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Load pipeline config
  useEffect(() => {
    fetch("/api/admin/pipeline")
      .then((r) => r.ok ? r.json() : { pipeline: {} })
      .then((data) => {
        setConfig(data.pipeline || {});
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const disabledSteps = new Set(config.disabledSteps || []);

  const toggleStep = (stepId: string) => {
    const next = new Set(disabledSteps);
    if (next.has(stepId)) next.delete(stepId);
    else next.add(stepId);
    const updated = { ...config, disabledSteps: [...next] };
    setConfig(updated);
    saveConfig(updated);
  };

  const saveConfig = async (cfg: PipelineConfig) => {
    setSaving(true);
    try {
      await fetch("/api/admin/pipeline", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pipeline: cfg }),
      });
    } catch (err) {
      console.error("[pipeline] Save failed:", err);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-sm text-[var(--muted)]">Loading pipeline config...</div>;
  }

  return (
    <div className="space-y-8 max-w-3xl">
      {/* Upload Processing */}
      <section>
        <h3 className="text-sm font-semibold mb-1">Upload Processing</h3>
        <p className="text-xs text-[var(--muted)] mb-3">Steps that run when a new blueprint is uploaded.</p>

        {isRootAdmin && <UploadComputePicker />}
        {isRootAdmin && <TilesToggle />}
        {isRootAdmin && <ParseEngineCard />}

        {/* Page concurrency */}
        <div className="flex items-center gap-3 px-3 py-2 mb-3 rounded border border-[var(--border)] bg-[var(--surface)]">
          <div className="flex-1">
            <div className="text-xs font-medium text-[var(--fg)]">Page Concurrency</div>
            <div className="text-[10px] text-[var(--muted)]">Parallel pages during OCR processing. Textract limit: 10 TPS.</div>
          </div>
          <input
            type="number"
            min={1}
            max={20}
            value={config.pageConcurrency ?? 8}
            onChange={(e) => {
              const val = Math.max(1, Math.min(20, parseInt(e.target.value) || 8));
              const updated = { ...config, pageConcurrency: val };
              setConfig(updated);
              saveConfig(updated);
            }}
            className="w-16 text-center text-xs px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)]"
          />
        </div>

        {/* CSI Spatial Grid Resolution */}
        <div className="flex items-center gap-3 px-3 py-2 mb-3 rounded border border-[var(--border)] bg-[var(--surface)]">
          <div className="flex-1">
            <div className="text-xs font-medium text-[var(--fg)]">CSI Spatial Grid</div>
            <div className="text-[10px] text-[var(--muted)]">Resolution for CSI spatial heatmap. Higher = more precise LLM context. Requires reprocess.</div>
          </div>
          <CsiSpatialGridPicker
            key={`${config.csiSpatialGrid?.rows}x${config.csiSpatialGrid?.cols}`}
            value={config.csiSpatialGrid}
            onChange={(grid) => {
              const updated = { ...config, csiSpatialGrid: grid };
              setConfig(updated);
              saveConfig(updated);
            }}
          />
        </div>

        {/* Always-on steps */}
        <div className="space-y-1 mb-2">
          {ALWAYS_ON_STEPS.map((name) => (
            <div key={name} className="flex items-center gap-3 px-3 py-1.5 rounded text-xs text-[var(--muted)]">
              <span className="w-8 text-center text-[10px] text-emerald-400">ON</span>
              <span className="flex-1">{name}</span>
              <span className="text-[10px] text-[var(--muted)]/50">always</span>
            </div>
          ))}
        </div>

        {/* Toggleable steps */}
        <div className="space-y-1">
          {UPLOAD_STEPS.map((step) => {
            const wired = WIRED_STEP_IDS.has(step.id);
            const enabled = !wired || !disabledSteps.has(step.id);
            return (
              <div
                key={step.id}
                className={`flex items-center gap-3 px-3 py-2 rounded border transition-colors ${
                  enabled
                    ? "border-emerald-500/20 bg-emerald-500/5"
                    : "border-[var(--border)] opacity-50"
                }`}
              >
                <button
                  onClick={() => wired && toggleStep(step.id)}
                  disabled={!wired}
                  title={wired ? undefined : "This toggle is not wired: no pipeline code reads it"}
                  className={`w-8 text-center text-[10px] font-medium rounded py-0.5 ${
                    enabled ? "bg-emerald-500/20 text-emerald-400" : "bg-[var(--border)] text-[var(--muted)]"
                  } ${wired ? "" : "cursor-not-allowed opacity-60"}`}
                >
                  {wired ? (enabled ? "ON" : "OFF") : "—"}
                </button>
                <div className="flex-1">
                  <div className="text-xs font-medium text-[var(--fg)]">{step.name}</div>
                  <div className="text-[10px] text-[var(--muted)]">
                    {step.description}
                    {!wired && " · not switchable: no pipeline code reads this toggle"}
                  </div>
                </div>
                {step.configTab && (
                  <span className="text-[9px] text-[var(--accent)] cursor-default">
                    {step.configTab} tab
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Post-YOLO Processing */}
      <section>
        <h3 className="text-sm font-semibold mb-1">Post-YOLO Processing</h3>
        <p className="text-xs text-[var(--muted)] mb-3">Steps that run after YOLO model results are loaded. YOLO runs are user-triggered.</p>

        <div className="space-y-1">
          {POST_YOLO_STEPS.map((step) => {
            const wired = WIRED_STEP_IDS.has(step.id);
            const enabled = !wired || !disabledSteps.has(step.id);
            return (
              <div
                key={step.id}
                className={`flex items-center gap-3 px-3 py-2 rounded border transition-colors ${
                  enabled
                    ? "border-emerald-500/20 bg-emerald-500/5"
                    : "border-[var(--border)] opacity-50"
                }`}
              >
                <button
                  onClick={() => wired && toggleStep(step.id)}
                  disabled={!wired}
                  title={wired ? undefined : "This toggle is not wired: no pipeline code reads it"}
                  className={`w-8 text-center text-[10px] font-medium rounded py-0.5 ${
                    enabled ? "bg-emerald-500/20 text-emerald-400" : "bg-[var(--border)] text-[var(--muted)]"
                  } ${wired ? "" : "cursor-not-allowed opacity-60"}`}
                >
                  {wired ? (enabled ? "ON" : "OFF") : "—"}
                </button>
                <div className="flex-1">
                  <div className="text-xs font-medium text-[var(--fg)]">{step.name}</div>
                  <div className="text-[10px] text-[var(--muted)]">
                    {step.description}
                    {!wired && " · not switchable: no pipeline code reads this toggle"}
                  </div>
                </div>
                {step.configTab && (
                  <span className="text-[9px] text-[var(--accent)] cursor-default">
                    {step.configTab} tab
                  </span>
                )}
              </div>
            );
          })}

          {/* Table Region Proposals */}
          <div className={`flex items-center gap-3 px-3 py-2 rounded border transition-colors ${
            config.tableProposals?.enabled
              ? "border-cyan-500/20 bg-cyan-500/5"
              : "border-[var(--border)] opacity-60"
          }`}>
            <button
              onClick={() => {
                const updated = {
                  ...config,
                  tableProposals: {
                    ...(config.tableProposals || { yoloSources: [] }),
                    enabled: !config.tableProposals?.enabled,
                  },
                };
                setConfig(updated);
                saveConfig(updated);
              }}
              className={`w-8 text-center text-[10px] font-medium rounded py-0.5 ${
                config.tableProposals?.enabled ? "bg-cyan-500/20 text-cyan-400" : "bg-[var(--border)] text-[var(--muted)]"
              }`}
            >
              {config.tableProposals?.enabled ? "ON" : "OFF"}
            </button>
            <div className="flex-1">
              <div className="text-xs font-medium text-[var(--fg)]">Table Region Proposals</div>
              <div className="text-[10px] text-[var(--muted)]">
                Use YOLO to auto-detect table/schedule bounding boxes. Saves proposed regions for parse assistance.
              </div>
              {config.tableProposals?.yoloSources?.length ? (
                <div className="text-[9px] text-cyan-400 mt-0.5">
                  {config.tableProposals.yoloSources.map((s) => `${s.modelName}: ${s.classes.join(", ")}`).join(" | ")}
                </div>
              ) : (
                <div className="text-[9px] text-[var(--muted)]/50 mt-0.5">No YOLO model configured</div>
              )}
            </div>
          </div>

          {/* Stage 2c: Auto-Table Detect — opt-in */}
          <div className={`flex items-center gap-3 px-3 py-2 rounded border transition-colors ${
            config.autoDetect?.tables
              ? "border-emerald-500/20 bg-emerald-500/5"
              : "border-[var(--border)] opacity-60"
          }`}>
            <button
              onClick={() => {
                const updated = {
                  ...config,
                  autoDetect: {
                    ...(config.autoDetect || {}),
                    tables: !config.autoDetect?.tables,
                  },
                };
                setConfig(updated);
                saveConfig(updated);
              }}
              className={`w-8 text-center text-[10px] font-medium rounded py-0.5 ${
                config.autoDetect?.tables ? "bg-emerald-500/20 text-emerald-400" : "bg-[var(--border)] text-[var(--muted)]"
              }`}
            >
              {config.autoDetect?.tables ? "ON" : "OFF"}
            </button>
            <div className="flex-1">
              <div className="text-xs font-medium text-[var(--fg)]">Auto-Table Detect (Stage 2c)</div>
              <div className="text-[10px] text-[var(--muted)]">
                Emit <code>AutoTableProposal[]</code> from ensembleRegions for downstream auto-parse. Requires ensemble reducer enabled. Opt-in.
              </div>
              {config.autoDetect?.tables && (
                <div className="mt-1 flex items-center gap-2">
                  <label className="text-[9px] text-[var(--muted)]">Min probability</label>
                  <input
                    type="number"
                    step="0.05"
                    min="0"
                    max="1"
                    value={config.autoDetect?.minProbability ?? 0.65}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      const updated = {
                        ...config,
                        autoDetect: { ...(config.autoDetect || {}), minProbability: isFinite(v) ? v : 0.65 },
                      };
                      setConfig(updated);
                      saveConfig(updated);
                    }}
                    className="w-16 text-[10px] bg-[var(--bg)] border border-[var(--border)] rounded px-1 py-0.5 text-[var(--fg)]"
                  />
                </div>
              )}
            </div>
          </div>

          {/* QTO Pre-Compute */}
          <div className={`flex items-center gap-3 px-3 py-2 rounded border transition-colors ${
            config.qtoPreCompute?.enabled
              ? "border-amber-500/20 bg-amber-500/5"
              : "border-[var(--border)] opacity-60"
          }`}>
            <button
              onClick={() => {
                const updated = {
                  ...config,
                  qtoPreCompute: {
                    ...(config.qtoPreCompute || { templates: [] }),
                    enabled: !config.qtoPreCompute?.enabled,
                  },
                };
                setConfig(updated);
                saveConfig(updated);
              }}
              className={`w-8 text-center text-[10px] font-medium rounded py-0.5 ${
                config.qtoPreCompute?.enabled ? "bg-amber-500/20 text-amber-400" : "bg-[var(--border)] text-[var(--muted)]"
              }`}
            >
              {config.qtoPreCompute?.enabled ? "ON" : "OFF"}
            </button>
            <div className="flex-1">
              <div className="text-xs font-medium text-[var(--fg)]">QTO Pre-Compute</div>
              <div className="text-[10px] text-[var(--muted)]">
                Auto-run saved QTO workflows after YOLO load. Requires parsed schedules.
              </div>
              <div className="text-[9px] text-[var(--muted)]/50 mt-0.5">
                {config.qtoPreCompute?.templates?.length || 0} template(s) configured
              </div>
            </div>
          </div>

          {/* Summary recompute - always on */}
          <div className="flex items-center gap-3 px-3 py-1.5 rounded text-xs text-[var(--muted)]">
            <span className="w-8 text-center text-[10px] text-emerald-400">ON</span>
            <span className="flex-1">Summary Recompute</span>
            <span className="text-[10px] text-[var(--muted)]/50">always</span>
          </div>
        </div>
      </section>

      {/* Reprocess — moved to its own tab */}
      <section>
        <h3 className="text-sm font-semibold mb-1">Reprocess</h3>
        <p className="text-xs text-[var(--muted)] mb-2">
          Re-running pipeline steps on existing projects (full, intelligence, page names, thumbnails, shape parse) lives in the
          Reprocess tab: one scope picker, a stage checklist that adds the stages your change makes stale, a preview and one log.
          Changing the CSI grid above still needs an intelligence re-run there.
        </p>
        <div className="flex flex-col gap-1">
          <OpenReprocessLink preset="full-refresh" onOpen={onOpenReprocess} />
          <OpenReprocessLink preset="rules-changed" onOpen={onOpenReprocess} note="After changing the CSI grid:" />
        </div>
      </section>

      {saving && (
        <div className="text-[10px] text-[var(--accent)] text-center">Saving...</div>
      )}
    </div>
  );
}
