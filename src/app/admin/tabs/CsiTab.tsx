"use client";

import { useEffect, useState, useCallback } from "react";
import { normalizeCsiCodes, CSI_INPUT_PLACEHOLDER } from "@/lib/csi-utils";
import { DEFAULT_CSI_DETECT_CONFIG, type CsiDetectConfig } from "@/lib/csi-detect-defs";

// CsiConfig is a superset of CsiDetectConfig — the extra fields belong to
// adjacent systems (CSI tagger, LLM context budgets), not the detection engine.
interface CsiConfig extends CsiDetectConfig {
  taggerKeywordOverlap: number;         // min % word overlap for CSI tagging annotations (0-1)
  taggerMinWordMatches: number;         // min absolute word matches for CSI tagging
  maxCsiTagsPerAnnotation: number;      // max CSI tags shown per annotation in LLM context
  contextBudgetOverrides: Record<string, number>; // model → context budget chars
}

const DEFAULTS: CsiConfig = {
  // Canonical detection defaults — imported from csi-detect-defs.ts so the
  // admin UI and the detection engine can never drift.
  ...DEFAULT_CSI_DETECT_CONFIG,
  // Admin-only fields for adjacent systems (not used by detectCsiCodes)
  taggerKeywordOverlap: 0.6,
  taggerMinWordMatches: 3,
  maxCsiTagsPerAnnotation: 2,
  contextBudgetOverrides: {},
};

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
        setConfig({ ...DEFAULTS, ...data.config });
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
        setMessage(err.error || "Save failed");
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

  function updateTier1Weight(index: number, value: number) {
    setConfig(prev => {
      const src = prev.tier1WeightByWordCount || DEFAULT_CSI_DETECT_CONFIG.tier1WeightByWordCount;
      const next = [...src];
      while (next.length <= index) next.push(next[next.length - 1] ?? 0);
      next[index] = value;
      return { ...prev, tier1WeightByWordCount: next };
    });
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
          Configure CSI MasterFormat code detection, matching tiers, and tagging thresholds.
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
          Using built-in MasterFormat 2018 + 2016 merged database. Upload a custom CSI list to override, or use the default.
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
                    setMessage(err.error || "Upload failed");
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

      {/* Matching Thresholds */}
      <section className="border border-[var(--border)] rounded-lg p-4 space-y-4">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Detection Matching</h3>
        <p className="text-xs text-[var(--muted)]">Controls how CSI codes are detected in OCR text. Three matching tiers run from strict to loose.</p>
        <details className="text-[10px] text-[var(--muted)] bg-[var(--surface)] border border-[var(--border)] rounded p-2">
          <summary className="cursor-pointer text-[var(--accent)] font-medium">How the three tiers work</summary>
          <div className="mt-2 space-y-1.5">
            <p><strong className="text-[var(--fg)]">Tier 1 — Exact Phrase (95%):</strong> Finds the full CSI description as consecutive words in the OCR text. Example: "hollow metal door" matches CSI 08 11 16. Always 95% confidence. Cannot be tuned.</p>
            <p><strong className="text-[var(--fg)]">Tier 2 — Scattered Words (up to Tier 2 Weight):</strong> Finds CSI words scattered in text, not consecutive. "door" + "metal" + "hollow" in any order. Higher weight = accept more scattered matches. Only activates when the CSI description has enough significant words (Tier 2 Min Words).</p>
            <p><strong className="text-[var(--fg)]">Tier 3 — Anchor Keywords (up to Tier 3 Weight):</strong> For long CSI descriptions, matches only the rarest/most distinctive words. Lower confidence. Only activates for descriptions with many words (Tier 3 Min Words).</p>
            <p><strong className="text-[var(--fg)]">Confidence Threshold:</strong> Matches below this score are discarded. Lower = more matches but noisier. Higher = fewer but more precise.</p>
          </div>
        </details>

        <div className="grid gap-4">
          <SliderField
            label="Minimum Confidence Threshold"
            description="Only report CSI matches above this confidence level"
            value={config.matchingConfidenceThreshold}
            onChange={(v) => updateConfig("matchingConfidenceThreshold", v)}
            min={0.1} max={0.9} step={0.05}
          />
          <SliderField
            label="Tier 2 Weight (Bag-of-Words)"
            description="Maximum confidence for non-consecutive word matching"
            value={config.tier2Weight}
            onChange={(v) => updateConfig("tier2Weight", v)}
            min={0.3} max={0.95} step={0.05}
          />
          <SliderField
            label="Tier 3 Weight (Keyword Anchors)"
            description="Maximum confidence for anchor-word matching on long descriptions"
            value={config.tier3Weight}
            onChange={(v) => updateConfig("tier3Weight", v)}
            min={0.2} max={0.7} step={0.05}
          />
          <NumberField
            label="Tier 2 Minimum Words"
            description="CSI descriptions need this many significant words to use Tier 2 matching"
            value={config.tier2MinWords}
            onChange={(v) => updateConfig("tier2MinWords", v)}
            min={2} max={8}
          />
          <NumberField
            label="Tier 3 Minimum Words"
            description="CSI descriptions need this many significant words to use Tier 3 anchor matching"
            value={config.tier3MinWords}
            onChange={(v) => updateConfig("tier3MinWords", v)}
            min={3} max={12}
          />
        </div>

        {/* Tier 1 word-count weights — down-weights short-description matches */}
        <div className="mt-2 pt-3 border-t border-[var(--border)]">
          <h4 className="text-xs font-semibold text-[var(--fg)] mb-1">Tier 1 Word-Count Weights</h4>
          <p className="text-[10px] text-[var(--muted)] mb-3 leading-snug">
            Multiplies Tier 1 (95%) confidence by a weight based on how many significant words
            the CSI description has. Default 1% for 1-word descriptions means codes like
            &ldquo;doors&rdquo; or &ldquo;concrete&rdquo; score 0.0095 and fall below the
            confidence threshold, killing false positives. 3+ word descriptions keep most
            of their confidence. Set a weight to 0 to disable that bucket entirely.
          </p>
          <div className="grid gap-3">
            <SliderField
              label="1-word description weight"
              description="E.g. single-word codes like 'doors', 'concrete', 'metals'"
              value={config.tier1WeightByWordCount?.[1] ?? DEFAULT_CSI_DETECT_CONFIG.tier1WeightByWordCount[1]}
              onChange={(v) => updateTier1Weight(1, v)}
              min={0} max={1} step={0.01}
            />
            <SliderField
              label="2-word description weight"
              description="E.g. 'structural steel', 'wood doors', 'roof insulation'"
              value={config.tier1WeightByWordCount?.[2] ?? DEFAULT_CSI_DETECT_CONFIG.tier1WeightByWordCount[2]}
              onChange={(v) => updateTier1Weight(2, v)}
              min={0} max={1} step={0.01}
            />
            <SliderField
              label="3-word description weight"
              description="E.g. 'cast in place concrete', 'hollow metal doors'"
              value={config.tier1WeightByWordCount?.[3] ?? DEFAULT_CSI_DETECT_CONFIG.tier1WeightByWordCount[3]}
              onChange={(v) => updateTier1Weight(3, v)}
              min={0} max={1} step={0.01}
            />
            <SliderField
              label="4-word description weight"
              description="E.g. 'fluid applied waterproofing membrane'"
              value={config.tier1WeightByWordCount?.[4] ?? DEFAULT_CSI_DETECT_CONFIG.tier1WeightByWordCount[4]}
              onChange={(v) => updateTier1Weight(4, v)}
              min={0} max={1} step={0.01}
            />
            <SliderField
              label="5+ word description weight"
              description="Longer, highly specific phrases — used for 5 or more significant words"
              value={config.tier1WeightByWordCount?.[5] ?? DEFAULT_CSI_DETECT_CONFIG.tier1WeightByWordCount[5]}
              onChange={(v) => updateTier1Weight(5, v)}
              min={0} max={1} step={0.01}
            />
          </div>
        </div>
      </section>

      {/* CSI Tagging */}
      <section className="border border-[var(--border)] rounded-lg p-4 space-y-4">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Annotation Tagging</h3>
        <p className="text-xs text-[var(--muted)]">Controls how detected CSI codes are tagged onto text annotations for the LLM.</p>
        <details className="text-[10px] text-[var(--muted)] bg-[var(--surface)] border border-[var(--border)] rounded p-2">
          <summary className="cursor-pointer text-[var(--accent)] font-medium">How annotation tagging works</summary>
          <div className="mt-2 space-y-1.5">
            <p><strong className="text-[var(--fg)]">Keyword Overlap:</strong> What % of the CSI description's significant words must appear in the annotation text. At 60%, "hollow metal door frame" (4 significant words) needs 3 matching words in the annotation.</p>
            <p><strong className="text-[var(--fg)]">Min Word Matches:</strong> Absolute minimum — even if the % threshold is met, this many words must match. Prevents false positives on short descriptions.</p>
            <p><strong className="text-[var(--fg)]">Max Tags per Annotation:</strong> Caps how many CSI codes are attached to one annotation. Keeps LLM context focused. At 2, each annotation gets at most 2 CSI codes even if more match.</p>
          </div>
        </details>

        <div className="grid gap-4">
          <SliderField
            label="Keyword Overlap Threshold"
            description="Minimum word overlap between annotation text and CSI description to tag"
            value={config.taggerKeywordOverlap}
            onChange={(v) => updateConfig("taggerKeywordOverlap", v)}
            min={0.3} max={0.9} step={0.05}
          />
          <NumberField
            label="Minimum Word Matches"
            description="At least this many words must match to apply a CSI tag"
            value={config.taggerMinWordMatches}
            onChange={(v) => updateConfig("taggerMinWordMatches", v)}
            min={1} max={6}
          />
          <NumberField
            label="Max CSI Tags per Annotation"
            description="Limit CSI tags shown per annotation in LLM context"
            value={config.maxCsiTagsPerAnnotation}
            onChange={(v) => updateConfig("maxCsiTagsPerAnnotation", v)}
            min={1} max={10}
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
