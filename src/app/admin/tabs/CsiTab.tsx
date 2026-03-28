"use client";

import { useEffect, useState } from "react";

interface CsiConfig {
  matchingConfidenceThreshold: number;  // min confidence to report a CSI match (0-1)
  taggerKeywordOverlap: number;         // min % word overlap for CSI tagging annotations (0-1)
  taggerMinWordMatches: number;         // min absolute word matches for CSI tagging
  maxCsiTagsPerAnnotation: number;      // max CSI tags shown per annotation in LLM context
  tier2MinWords: number;                // min significant words in description for Tier 2 matching
  tier3MinWords: number;                // min significant words for Tier 3 anchor matching
  tier2Weight: number;                  // max confidence for Tier 2 bag-of-words (0-1)
  tier3Weight: number;                  // max confidence for Tier 3 anchors (0-1)
  contextBudgetOverrides: Record<string, number>; // model → context budget chars
}

const DEFAULTS: CsiConfig = {
  matchingConfidenceThreshold: 0.4,
  taggerKeywordOverlap: 0.6,
  taggerMinWordMatches: 3,
  maxCsiTagsPerAnnotation: 2,
  tier2MinWords: 3,
  tier3MinWords: 5,
  tier2Weight: 0.75,
  tier3Weight: 0.50,
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

  useEffect(() => {
    loadConfig();
  }, []);

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
      </section>

      {/* CSI Tagging */}
      <section className="border border-[var(--border)] rounded-lg p-4 space-y-4">
        <h3 className="text-sm font-semibold text-[var(--fg)]">Annotation Tagging</h3>
        <p className="text-xs text-[var(--muted)]">Controls how detected CSI codes are tagged onto text annotations for the LLM.</p>

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
