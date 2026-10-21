"use client";

import { useEffect, useState, useCallback } from "react";
import { normalizeCsiCodes, CSI_INPUT_PLACEHOLDER } from "@/lib/csi-utils";
import {
  CSI_V2_LOWEST_EMITTED_CONFIDENCE,
  CSI_V2_MAX_CODES_MAX,
  CSI_V2_MAX_CODES_MIN,
  DEFAULT_CSI_V2_CONFIG,
  pickCsiV2Config,
  type CsiV2Config,
} from "@/lib/csi-v2-config";
import { apiErrorMessage } from "@/lib/client-persist"; // [refactor jul8 S058 PR-E1] envelope unwrap

// [csi-v2 S6] The v2 tagger has exactly two settings (PLAN §7). The pre-v2 tier weights and the
// three tagger sliders (keyword overlap, min word matches, max tags per annotation) are gone: the
// first had no v2 meaning and the second were never read by any code.
type CsiConfig = CsiV2Config;

const DEFAULTS: CsiConfig = { ...DEFAULT_CSI_V2_CONFIG };

interface CsiTabProps {
  reprocessing: boolean;
  reprocessLog: string[];
  onReprocess: () => void;
}

export default function CsiTab({ reprocessing, reprocessLog, onReprocess }: CsiTabProps) {
  const [config, setConfig] = useState<CsiConfig>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [stats, setStats] = useState<{ totalCodes: number; divisions: number; source?: string } | null>(null);
  const [uploading, setUploading] = useState(false);

  // YOLO Model CSI state
  const [yoloModels, setYoloModels] = useState<Array<{ id: number; name: string; config: any }>>([]);
  const [expandedYoloModel, setExpandedYoloModel] = useState<number | null>(null);
  const [yoloCsiEdits, setYoloCsiEdits] = useState<Record<string, string>>({});
  const [yoloKwEdits, setYoloKwEdits] = useState<Record<string, string>>({});
  const [savingYoloCsi, setSavingYoloCsi] = useState(false);
  const [reprocessingCsi, setReprocessingCsi] = useState(false);

  const loadYoloModels = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/models");
      if (res.ok) setYoloModels(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadConfig();
    loadYoloModels();
  }, [loadYoloModels]);

  async function loadConfig() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/csi/config");
      if (res.ok) {
        const data = await res.json();
        // pre-v2 rows: matchingConfidenceThreshold > 0.704 is read as tau, other legacy keys are ignored
        setConfig({ ...DEFAULTS, ...pickCsiV2Config(data.config) });
        setStats(data.stats);
      }
    } catch { /* use defaults */ }
    setLoading(false);
  }

  async function saveConfig() {
    setSaving(true);
    setMessage("");
    try {
      const res = await fetch("/api/admin/csi/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (res.ok) {
        setMessage("CSI configuration saved");
        setTimeout(() => setMessage(""), 3000);
      } else {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        setMessage(apiErrorMessage(err) || "Save failed");
      }
    } catch {
      setMessage("Save failed");
    }
    setSaving(false);
  }

  function resetDefaults() {
    setConfig(DEFAULTS);
  }

  function updateConfig<K extends keyof CsiConfig>(key: K, value: CsiConfig[K]) {
    setConfig(prev => ({ ...prev, [key]: value }));
  }

  if (loading) {
    return <div className="text-[var(--muted)] text-sm py-8 text-center">Loading CSI configuration...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold">CSI Code Configuration</h2>
        <p className="text-sm text-[var(--muted)] mt-1">
          Configure CSI MasterFormat code detection.
        </p>
      </div>

      {message && (
        <div className="px-4 py-2 rounded bg-[var(--accent)]/20 text-[var(--accent)] text-sm">{message}</div>
      )}

      {/* Database stats */}
      {stats && (
        <div className="flex gap-4 text-sm flex-wrap">
          <div className="px-3 py-2 rounded bg-[var(--surface)] border border-[var(--border)]">
            <span className="text-[var(--muted)]">CSI Database: </span>
            <span className="font-medium text-[var(--fg)]">{stats.totalCodes.toLocaleString()} codes</span>
          </div>
          <div className="px-3 py-2 rounded bg-[var(--surface)] border border-[var(--border)]">
            <span className="text-[var(--muted)]">Divisions: </span>
            <span className="font-medium text-[var(--fg)]">{stats.divisions}</span>
          </div>
          <div className="px-3 py-2 rounded bg-[var(--surface)] border border-[var(--border)]">
            <span className="text-[var(--muted)]">Source: </span>
            <span className="font-medium text-[var(--fg)]">{stats.source || "Built-in MasterFormat 2018"}</span>
          </div>
        </div>
      )}

      {/* Custom CSI Database Upload */}
      <section className="border border-[var(--border)] rounded-lg p-4 space-y-3">
        <h3 className="text-sm font-semibold text-[var(--fg)]">CSI Database</h3>
        <p className="text-xs text-[var(--muted)]">
          The built-in list is MasterFormat 2018 (titles, keyword index, and common drawing abbreviations).
          An uploaded custom list ADDS codes and phrases on top of it; a phrase the built-in list already
          uses keeps its built-in code, and one-word entries only hint a division.
        </p>
        <div className="flex gap-3 items-center flex-wrap">
          <label className="flex items-center gap-2 px-3 py-2 text-xs rounded border border-[var(--border)] text-[var(--fg)] hover:border-[var(--accent)]/50 cursor-pointer">
            <input
              type="file"
              accept=".csv,.tsv,.json"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setUploading(true);
                setMessage("");
                try {
                  const formData = new FormData();
                  formData.append("file", file);
                  const res = await fetch("/api/admin/csi/upload", { method: "POST", body: formData });
                  if (res.ok) {
                    const data = await res.json();
                    setMessage(`Uploaded ${data.codesLoaded} CSI codes from ${file.name}`);
                    loadConfig();
                  } else {
                    const err = await res.json().catch(() => ({ error: "Upload failed" }));
                    setMessage(apiErrorMessage(err) || "Upload failed");
                  }
                } catch { setMessage("Upload failed"); }
                setUploading(false);
                e.target.value = "";
              }}
            />
            {uploading ? "Uploading..." : "Upload Custom CSI List"}
          </label>
          <button
            onClick={async () => {
              setMessage("");
              const res = await fetch("/api/admin/csi/upload", { method: "DELETE" });
              if (res.ok) {
                setMessage("Reverted to built-in CSI database");
                loadConfig();
              }
            }}
            className="px-3 py-2 text-xs rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
          >
            Revert to Built-in
          </button>
          <span className="text-[10px] text-[var(--muted)]">Accepts CSV, TSV, or JSON (code + description columns)</span>
        </div>
      </section>

      {/* Detection (v2 tagger) */}
      <section className="border border-[var(--border)] rounded-lg p-4 space-y-4">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Detection</h3>
        <p className="text-xs text-[var(--muted)]">Controls which matched CSI codes are listed on a page.</p>
        <details className="text-[10px] text-[var(--muted)] bg-[var(--surface)] border border-[var(--border)] rounded p-2">
          <summary className="cursor-pointer text-[var(--accent)] font-medium">How detection works</summary>
          <div className="mt-2 space-y-1.5">
            <p><strong className="text-[var(--fg)]">Spans:</strong> each OCR line (or table cell) is matched against MasterFormat titles, keyword-index phrases and a curated list of drawing abbreviations (GWB, ACT, HM&hellip;). A phrase counts only when the code&apos;s distinctive words are present, at least 80% of the phrase&apos;s weight is found, and the words sit close together without crossing punctuation. Score: 1.00 for the exact words in order, 0.85 when they are out of order or spread out. The most specific matching code wins (&ldquo;hollow metal doors&rdquo; &rarr; 08 13 13, not 08 00 00).</p>
            <p><strong className="text-[var(--fg)]">Page confidence:</strong> a code&apos;s best span score &times; a repetition factor &mdash; 0.88 for one occurrence, +0.03 per extra occurrence, up to 1.00 at five.</p>
            <p><strong className="text-[var(--fg)]">Always filtered, whatever the settings:</strong> codes whose best span scores under 0.80, phrases marked &ldquo;by others&rdquo; / N.I.C., one-word matches that are not curated abbreviations, Division 00/01 codes on drawings, and site/process divisions (33&ndash;35, 40&ndash;48) unless matched at least twice by their own phrases or the sheet is a civil (C-) sheet.</p>
          </div>
        </details>

        <div className="grid gap-4">
          <SliderField
            label="Minimum confidence (tau)"
            description={`List a code only when its page confidence reaches this value. Every listed code already scores at least ${(CSI_V2_LOWEST_EMITTED_CONFIDENCE * 100).toFixed(1)}%, so lower values change nothing. The default ${(DEFAULT_CSI_V2_CONFIG.tau * 100).toFixed(0)}% keeps a single exact phrase (88%) and drops a single loose match (0.85 × 0.88 ≈ 74.8%) unless it repeats on the page.`}
            value={config.tau}
            onChange={(v) => updateConfig("tau", v)}
            min={0.7} max={1} step={0.01}
          />
          <NumberField
            label="Max codes per page"
            description={`Keep at most this many codes per page, highest confidence first (default ${DEFAULT_CSI_V2_CONFIG.maxCodesPerPage}). On the evaluation drawings a page lists 4 codes at the median and 15 at the 90th percentile, so the cap rarely applies.`}
            value={config.maxCodesPerPage}
            onChange={(v) => updateConfig("maxCodesPerPage", Math.min(CSI_V2_MAX_CODES_MAX, Math.max(CSI_V2_MAX_CODES_MIN, v)))}
            min={CSI_V2_MAX_CODES_MIN} max={CSI_V2_MAX_CODES_MAX}
          />
        </div>
      </section>

      {/* YOLO Model Class CSI Tags */}
      <section className="border border-[var(--border)] rounded-lg p-4 space-y-3">
        <h3 className="text-sm font-semibold text-[var(--fg)]">YOLO Model Class CSI Tags</h3>
        <p className="text-xs text-[var(--muted)]">
          Assign CSI codes and keywords to YOLO model classes. These tags are applied globally to all projects when YOLO results are loaded.
        </p>

        {yoloModels.length === 0 ? (
          <p className="text-xs text-[var(--muted)] py-4 text-center">No YOLO models uploaded</p>
        ) : (
          <div className="space-y-2">
            {yoloModels.map((m) => {
              const classes: string[] = m.config?.classes || [];
              const classCsiCodes: Record<string, string[]> = m.config?.classCsiCodes || {};
              const classKeywords: Record<string, string[]> = m.config?.classKeywords || {};
              const csiCount = Object.keys(classCsiCodes).length;
              const isExpanded = expandedYoloModel === m.id;
              return (
                <div key={m.id} className="bg-[var(--surface)] border border-[var(--border)] rounded">
                  <button
                    onClick={() => {
                      if (isExpanded) { setExpandedYoloModel(null); return; }
                      setExpandedYoloModel(m.id);
                      const csiStrings: Record<string, string> = {};
                      const kwStrings: Record<string, string> = {};
                      for (const [cls, codes] of Object.entries(classCsiCodes)) csiStrings[cls] = codes.join(", ");
                      for (const [cls, kws] of Object.entries(classKeywords)) kwStrings[cls] = kws.join(", ");
                      setYoloCsiEdits(csiStrings);
                      setYoloKwEdits(kwStrings);
                    }}
                    className="w-full flex items-center justify-between p-2.5 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-[var(--muted)] w-3">{isExpanded ? "▼" : "▶"}</span>
                      <span className="text-xs font-medium">{m.name}</span>
                      <span className="text-[10px] text-[var(--muted)]">{classes.length} classes</span>
                      {csiCount > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-400/20 text-blue-300">
                          {csiCount} CSI tagged
                        </span>
                      )}
                    </div>
                  </button>
                  {isExpanded && classes.length > 0 && (
                    <div className="px-3 pb-3 border-t border-[var(--border)] space-y-2 mt-0">
                      {classes.map((cls) => (
                        <div key={cls} className="flex items-start gap-2 py-1 border-b border-[var(--border)]/30 last:border-0">
                          <span className="text-[10px] font-mono w-32 truncate shrink-0 pt-1" title={cls}>{cls}</span>
                          <div className="flex-1 space-y-0.5">
                            <div className="flex items-center gap-1.5">
                              <label className="text-[10px] text-[var(--muted)] w-7 shrink-0">CSI</label>
                              <input
                                type="text"
                                value={yoloCsiEdits[cls] || ""}
                                onChange={(e) => setYoloCsiEdits((p) => ({ ...p, [cls]: e.target.value }))}
                                placeholder={CSI_INPUT_PLACEHOLDER}
                                className="flex-1 px-1.5 py-0.5 text-[10px] bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none focus:border-blue-400/50 font-mono"
                              />
                            </div>
                            <div className="flex items-center gap-1.5">
                              <label className="text-[10px] text-[var(--muted)] w-7 shrink-0">Keys</label>
                              <input
                                type="text"
                                value={yoloKwEdits[cls] || ""}
                                onChange={(e) => setYoloKwEdits((p) => ({ ...p, [cls]: e.target.value }))}
                                placeholder="e.g. door, opening"
                                className="flex-1 px-1.5 py-0.5 text-[10px] bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none focus:border-emerald-400/50"
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                      <div className="flex items-center gap-2 mt-2">
                        <button
                          onClick={async () => {
                            setSavingYoloCsi(true);
                            const classCsi: Record<string, string[]> = {};
                            const classKw: Record<string, string[]> = {};
                            for (const [cls, val] of Object.entries(yoloCsiEdits)) {
                              const codes = normalizeCsiCodes(val);
                              if (codes.length > 0) classCsi[cls] = codes;
                            }
                            for (const [cls, val] of Object.entries(yoloKwEdits)) {
                              const kws = val.split(",").map(s => s.trim()).filter(Boolean);
                              if (kws.length > 0) classKw[cls] = kws;
                            }
                            try {
                              const res = await fetch("/api/admin/models", {
                                method: "PUT",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ id: m.id, classCsiCodes: classCsi, classKeywords: classKw }),
                              });
                              if (res.ok) {
                                setMessage("YOLO class CSI tags saved");
                                setTimeout(() => setMessage(""), 3000);
                                loadYoloModels();
                              }
                            } catch { setMessage("Save failed"); }
                            setSavingYoloCsi(false);
                          }}
                          disabled={savingYoloCsi}
                          className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-40"
                        >
                          {savingYoloCsi ? "Saving..." : "Save CSI Tags"}
                        </button>
                        <button
                          onClick={async () => {
                            setReprocessingCsi(true);
                            setMessage("Reprocessing YOLO CSI tags...");
                            try {
                              const res = await fetch("/api/admin/models/reprocess-csi", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ modelId: m.id }),
                              });
                              if (res.ok) {
                                const data = await res.json();
                                setMessage(`Updated ${data.annotationsUpdated || 0} annotations across ${data.projectsProcessed || 0} projects`);
                              } else {
                                setMessage("Reprocess failed");
                              }
                            } catch { setMessage("Reprocess failed"); }
                            setTimeout(() => setMessage(""), 5000);
                            setReprocessingCsi(false);
                          }}
                          disabled={reprocessingCsi}
                          className="px-3 py-1 text-xs rounded border border-orange-400/40 text-orange-400 hover:bg-orange-400/10 disabled:opacity-50"
                        >
                          {reprocessingCsi ? "Reprocessing..." : "Reprocess YOLO Tags"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Actions */}
      <div className="flex gap-3 items-center">
        <button
          onClick={saveConfig}
          disabled={saving}
          className="px-4 py-2 text-sm rounded bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save Configuration"}
        </button>
        <button
          onClick={resetDefaults}
          className="px-4 py-2 text-sm rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
        >
          Reset to Defaults
        </button>
        <button
          onClick={onReprocess}
          disabled={reprocessing}
          className="px-4 py-2 text-sm rounded border border-orange-400/40 text-orange-400 hover:bg-orange-400/10 disabled:opacity-50"
        >
          {reprocessing ? "Reprocessing..." : "Reprocess CSI Detection"}
        </button>
      </div>

      {/* Reprocess log */}
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

// ═══════════════════════════════════════════════════════════════
// Shared form components
// ═══════════════════════════════════════════════════════════════

function SliderField({ label, description, value, onChange, min, max, step }: {
  label: string; description: string; value: number;
  onChange: (v: number) => void; min: number; max: number; step: number;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs font-medium text-[var(--fg)]">{label}</label>
        <span className="text-xs font-mono text-[var(--accent)]">{(value * 100).toFixed(0)}%</span>
      </div>
      <p className="text-[10px] text-[var(--muted)] mb-1.5">{description}</p>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1 accent-[var(--accent)]"
      />
    </div>
  );
}

function NumberField({ label, description, value, onChange, min, max }: {
  label: string; description: string; value: number;
  onChange: (v: number) => void; min: number; max: number;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs font-medium text-[var(--fg)]">{label}</label>
        <span className="text-xs font-mono text-[var(--accent)]">{value}</span>
      </div>
      <p className="text-[10px] text-[var(--muted)] mb-1.5">{description}</p>
      <input
        type="number" min={min} max={max} value={value}
        onChange={(e) => onChange(parseInt(e.target.value) || min)}
        className="w-16 px-2 py-1 text-xs bg-[var(--surface)] border border-[var(--border)] rounded text-[var(--fg)] outline-none focus:border-[var(--accent)]"
      />
    </div>
  );
}
