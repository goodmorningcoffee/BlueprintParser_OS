"use client";

import { useState, useEffect } from "react";

interface PipelineTabProps {
  reprocessing: boolean;
  reprocessLog: string[];
  onReprocess: (scope?: string, projectIds?: string[]) => void;
  projects: Array<{ id: string; name: string; status: string }>;
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
}

const UPLOAD_STEPS = [
  { id: "csi-detection", name: "CSI Code Detection", description: "Detect CSI MasterFormat codes from OCR text", configTab: "csi", alwaysOn: false },
  { id: "text-annotations", name: "Text Annotations", description: "Detect phone, email, equipment tags, abbreviations", configTab: "text-annotations", alwaysOn: false },
  { id: "page-intelligence", name: "Page Intelligence", description: "Classify pages, detect cross-references, note blocks", configTab: null, alwaysOn: false },
  { id: "text-regions", name: "Text Region Classification", description: "Identify table-like, notes, spec, key-value regions from OCR", configTab: null, alwaysOn: false },
  { id: "heuristic-engine", name: "Heuristic Engine (text-only)", description: "Rule-based inference: schedule detection, symbol legends, notes", configTab: "heuristics", alwaysOn: false },
  { id: "table-classification", name: "Table Classification", description: "Combine text regions + heuristics to classify schedules", configTab: null, alwaysOn: false },
  { id: "csi-spatial", name: "CSI Spatial Mapping", description: "Heatmap: which page zones contain which CSI codes", configTab: null, alwaysOn: false },
];

const POST_YOLO_STEPS = [
  { id: "heuristic-yolo", name: "Heuristic Engine (YOLO-augmented)", description: "Re-run rules with YOLO spatial signals", configTab: "heuristics", alwaysOn: false },
  { id: "table-reclassify", name: "Table Reclassification", description: "Re-classify with YOLO-enriched heuristics", configTab: null, alwaysOn: false },
  { id: "yolo-csi-merge", name: "YOLO CSI Code Merge", description: "Add CSI codes from YOLO model class config to pages", configTab: null, alwaysOn: false },
];

const ALWAYS_ON_STEPS = [
  "PDF Rasterization + OCR",
  "Drawing Number Extraction",
  "Project Analysis + Summaries",
];

const REPROCESS_SCOPES = [
  { id: "full", label: "Full (CSI + Text Annotations)", description: "Re-detect CSI codes and text annotations on all pages" },
  { id: "intelligence", label: "Intelligence (Heuristics + Tables)", description: "Re-run page analysis, heuristics, table classification, summaries" },
  { id: "page-names", label: "Page Names", description: "Re-extract drawing numbers (optionally using YOLO title blocks)" },
];

export default function PipelineTab({ reprocessing, reprocessLog, onReprocess, projects }: PipelineTabProps) {
  const [config, setConfig] = useState<PipelineConfig>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Reprocess controls
  const [reprocessScope, setReprocessScope] = useState("intelligence");
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const [selectAll, setSelectAll] = useState(true);

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

  const handleReprocess = () => {
    const ids = selectAll ? undefined : [...selectedProjects];
    onReprocess(reprocessScope, ids);
  };

  const completedProjects = projects.filter((p) => p.status === "completed");

  if (loading) {
    return <div className="text-sm text-[var(--muted)]">Loading pipeline config...</div>;
  }

  return (
    <div className="space-y-8 max-w-3xl">
      {/* Upload Processing */}
      <section>
        <h3 className="text-sm font-semibold mb-1">Upload Processing</h3>
        <p className="text-xs text-[var(--muted)] mb-3">Steps that run when a new blueprint is uploaded.</p>

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
          <select
            value={String(config.csiSpatialGrid?.rows ?? 3)}
            onChange={(e) => {
              const n = parseInt(e.target.value);
              const updated = { ...config, csiSpatialGrid: { rows: n, cols: n } };
              setConfig(updated);
              saveConfig(updated);
            }}
            className="w-20 text-center text-xs px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)]"
          >
            <option value="3">3x3</option>
            <option value="6">6x6</option>
            <option value="9">9x9</option>
            <option value="12">12x12</option>
          </select>
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
            const enabled = !disabledSteps.has(step.id);
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
                  onClick={() => toggleStep(step.id)}
                  className={`w-8 text-center text-[10px] font-medium rounded py-0.5 ${
                    enabled ? "bg-emerald-500/20 text-emerald-400" : "bg-[var(--border)] text-[var(--muted)]"
                  }`}
                >
                  {enabled ? "ON" : "OFF"}
                </button>
                <div className="flex-1">
                  <div className="text-xs font-medium text-[var(--fg)]">{step.name}</div>
                  <div className="text-[10px] text-[var(--muted)]">{step.description}</div>
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
            const enabled = !disabledSteps.has(step.id);
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
                  onClick={() => toggleStep(step.id)}
                  className={`w-8 text-center text-[10px] font-medium rounded py-0.5 ${
                    enabled ? "bg-emerald-500/20 text-emerald-400" : "bg-[var(--border)] text-[var(--muted)]"
                  }`}
                >
                  {enabled ? "ON" : "OFF"}
                </button>
                <div className="flex-1">
                  <div className="text-xs font-medium text-[var(--fg)]">{step.name}</div>
                  <div className="text-[10px] text-[var(--muted)]">{step.description}</div>
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

      {/* Reprocess */}
      <section>
        <h3 className="text-sm font-semibold mb-1">Reprocess</h3>
        <p className="text-xs text-[var(--muted)] mb-3">Re-run pipeline steps on existing projects.</p>

        <div className="space-y-3">
          {/* Scope selector */}
          <div>
            <label className="text-[10px] text-[var(--muted)] uppercase tracking-wide block mb-1">Scope</label>
            <div className="space-y-1">
              {REPROCESS_SCOPES.map((scope) => (
                <button
                  key={scope.id}
                  onClick={() => setReprocessScope(scope.id)}
                  className={`w-full text-left px-3 py-1.5 rounded border text-xs transition-colors ${
                    reprocessScope === scope.id
                      ? "border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--fg)]"
                      : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--muted)]/40"
                  }`}
                >
                  <div className="font-medium">{scope.label}</div>
                  <div className="text-[10px] text-[var(--muted)]">{scope.description}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Project selector */}
          <div>
            <label className="text-[10px] text-[var(--muted)] uppercase tracking-wide block mb-1">Projects</label>
            <div className="flex items-center gap-2 mb-2">
              <button
                onClick={() => setSelectAll(true)}
                className={`text-xs px-3 py-1 rounded border ${
                  selectAll ? "border-[var(--accent)]/40 bg-[var(--accent)]/10" : "border-[var(--border)] text-[var(--muted)]"
                }`}
              >
                All ({completedProjects.length})
              </button>
              <button
                onClick={() => setSelectAll(false)}
                className={`text-xs px-3 py-1 rounded border ${
                  !selectAll ? "border-[var(--accent)]/40 bg-[var(--accent)]/10" : "border-[var(--border)] text-[var(--muted)]"
                }`}
              >
                Select...
              </button>
            </div>
            {!selectAll && (
              <div className="max-h-32 overflow-y-auto space-y-0.5 border border-[var(--border)] rounded p-2">
                {completedProjects.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-[var(--surface-hover)] rounded px-1 py-0.5">
                    <input
                      type="checkbox"
                      checked={selectedProjects.has(p.id)}
                      onChange={() => {
                        setSelectedProjects((prev) => {
                          const next = new Set(prev);
                          if (next.has(p.id)) next.delete(p.id);
                          else next.add(p.id);
                          return next;
                        });
                      }}
                      className="rounded"
                    />
                    <span className="text-[var(--fg)]">{p.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Run button */}
          <button
            disabled={reprocessing || (!selectAll && selectedProjects.size === 0)}
            onClick={handleReprocess}
            className="w-full py-2 rounded bg-[var(--accent)] text-white text-xs font-medium disabled:opacity-40 hover:opacity-90"
          >
            {reprocessing ? "Reprocessing..." : `Run ${REPROCESS_SCOPES.find((s) => s.id === reprocessScope)?.label || "Reprocess"}`}
          </button>

          {/* Reprocess log */}
          {reprocessLog.length > 0 && (
            <div className="bg-[var(--bg)] border border-[var(--border)] rounded p-2 max-h-40 overflow-y-auto">
              {reprocessLog.map((line, i) => (
                <div key={i} className="text-[10px] text-[var(--muted)] font-mono">{line}</div>
              ))}
            </div>
          )}
        </div>
      </section>

      {saving && (
        <div className="text-[10px] text-[var(--accent)] text-center">Saving...</div>
      )}
    </div>
  );
}
