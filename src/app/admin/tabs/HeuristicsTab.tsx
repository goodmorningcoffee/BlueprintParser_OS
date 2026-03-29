"use client";

import { useEffect, useState, useCallback } from "react";
import { normalizeCsiCodes, CSI_INPUT_PLACEHOLDER } from "@/lib/csi-utils";

interface HeuristicRule {
  id: string;
  name: string;
  source: "built-in" | "custom";
  enabled: boolean;
  modelId?: number;
  modelName?: string;
  yoloRequired: string[];
  yoloBoosters: string[];
  textKeywords: string[];
  overlapRequired: boolean;
  textRegionType?: string;
  csiDivisionsRequired?: string[];
  outputLabel: string;
  outputCsiCode?: string;
  minConfidence: number;
}

interface YoloModel {
  id: number;
  name: string;
  config: { classes?: string[] };
}

interface HeuristicsTabProps {
  reprocessing: boolean;
  reprocessLog: string[];
  onReprocess: () => void;
}

export default function HeuristicsTab({ reprocessing, reprocessLog, onReprocess }: HeuristicsTabProps) {
  const [rules, setRules] = useState<HeuristicRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [expandedRule, setExpandedRule] = useState<string | null>(null);
  const [yoloModels, setYoloModels] = useState<YoloModel[]>([]);

  const loadModels = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/models");
      if (res.ok) setYoloModels(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadRules();
    loadModels();
  }, [loadModels]);

  async function loadRules() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/heuristics/config");
      if (res.ok) {
        const data = await res.json();
        const builtIn: HeuristicRule[] = data.builtInRules || [];
        const overrides: HeuristicRule[] = data.companyOverrides || [];

        // Merge: company overrides replace built-in rules by ID, custom rules are appended
        const ruleMap = new Map<string, HeuristicRule>();
        for (const r of builtIn) ruleMap.set(r.id, { ...r, enabled: true });
        for (const r of overrides) ruleMap.set(r.id, r);

        setRules([...ruleMap.values()]);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }

  async function saveRules() {
    setSaving(true);
    setMessage("");
    try {
      const res = await fetch("/api/admin/heuristics/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ heuristics: rules }),
      });
      if (res.ok) {
        setMessage("Heuristic rules saved");
        setTimeout(() => setMessage(""), 3000);
      } else {
        setMessage("Save failed");
      }
    } catch {
      setMessage("Save failed");
    }
    setSaving(false);
  }

  function updateRule(id: string, updates: Partial<HeuristicRule>) {
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...updates } : r)));
  }

  function addCustomRule() {
    const id = `custom-${Date.now()}`;
    setRules((prev) => [
      ...prev,
      {
        id,
        name: "New Custom Rule",
        source: "custom",
        enabled: true,
        yoloRequired: [],
        yoloBoosters: [],
        textKeywords: [],
        overlapRequired: false,
        outputLabel: "custom-label",
        minConfidence: 0.5,
      },
    ]);
    setExpandedRule(id);
  }

  function removeRule(id: string) {
    setRules((prev) => prev.filter((r) => r.id !== id));
    if (expandedRule === id) setExpandedRule(null);
  }

  if (loading) {
    return <div className="text-[var(--muted)] text-sm py-8 text-center">Loading heuristic rules...</div>;
  }

  const enabledCount = rules.filter((r) => r.enabled).length;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Heuristic Engine Rules</h2>
        <p className="text-sm text-[var(--muted)] mt-1">
          Configure rules that detect higher-level page constructs (schedules, note blocks, section cuts) from YOLO + OCR data.
          {" "}{enabledCount} of {rules.length} rules enabled.
        </p>
      </div>

      {message && (
        <div className="px-4 py-2 rounded bg-[var(--accent)]/20 text-[var(--accent)] text-sm">{message}</div>
      )}

      {/* Rule list */}
      <div className="space-y-2">
        {rules.map((rule) => {
          const isExpanded = expandedRule === rule.id;
          return (
            <div key={rule.id} className="bg-[var(--surface)] border border-[var(--border)] rounded">
              {/* Rule header */}
              <div className="flex items-center gap-3 p-3">
                {/* Enable/disable toggle */}
                <button
                  onClick={() => updateRule(rule.id, { enabled: !rule.enabled })}
                  className={`w-8 h-4 rounded-full relative transition-colors ${
                    rule.enabled ? "bg-green-500" : "bg-[var(--border)]"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                      rule.enabled ? "left-4" : "left-0.5"
                    }`}
                  />
                </button>

                {/* Rule info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-medium ${rule.enabled ? "text-[var(--fg)]" : "text-[var(--muted)]"}`}>
                      {rule.name}
                    </span>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded ${
                      rule.source === "built-in"
                        ? "bg-blue-500/10 text-blue-400 border border-blue-400/20"
                        : "bg-purple-500/10 text-purple-400 border border-purple-400/20"
                    }`}>
                      {rule.source}
                    </span>
                    {rule.outputCsiCode && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-400/20 font-mono">
                        CSI {rule.outputCsiCode}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {rule.modelName && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--surface)] text-[var(--muted)] border border-[var(--border)]">
                        {rule.modelName}
                      </span>
                    )}
                    {rule.yoloRequired.map((y) => (
                      <span key={y} className="text-[9px] px-1 py-0.5 rounded bg-purple-500/10 text-purple-300">
                        YOLO: {y}
                      </span>
                    ))}
                    {rule.textKeywords.slice(0, 3).map((k) => (
                      <span key={k} className="text-[9px] px-1 py-0.5 rounded bg-emerald-500/10 text-emerald-300">
                        {k}
                      </span>
                    ))}
                    {rule.textKeywords.length > 3 && (
                      <span className="text-[9px] text-[var(--muted)]">+{rule.textKeywords.length - 3} more</span>
                    )}
                    {(rule.csiDivisionsRequired || []).map((d) => (
                      <span key={d} className="text-[9px] px-1 py-0.5 rounded bg-blue-500/10 text-blue-300 font-mono">
                        Div {d}
                      </span>
                    ))}
                    <span className="text-[9px] text-[var(--muted)]">
                      min {Math.round(rule.minConfidence * 100)}%
                    </span>
                  </div>
                </div>

                {/* Expand / Delete */}
                <button
                  onClick={() => setExpandedRule(isExpanded ? null : rule.id)}
                  className="text-[10px] text-[var(--muted)] hover:text-[var(--fg)] px-2"
                >
                  {isExpanded ? "▲ Close" : "▼ Edit"}
                </button>
                {rule.source === "custom" && (
                  <button
                    onClick={() => removeRule(rule.id)}
                    className="text-[10px] text-[var(--muted)] hover:text-red-400"
                  >
                    Delete
                  </button>
                )}
              </div>

              {/* Expanded edit form */}
              {isExpanded && (
                <div className="px-3 pb-3 border-t border-[var(--border)] space-y-3 pt-3">
                  {/* Name (editable for custom) */}
                  {rule.source === "custom" && (
                    <div>
                      <label className="text-[10px] text-[var(--muted)] block mb-1">Rule Name</label>
                      <input
                        type="text"
                        value={rule.name}
                        onChange={(e) => updateRule(rule.id, { name: e.target.value })}
                        className="w-full px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none focus:border-[var(--accent)]"
                      />
                    </div>
                  )}

                  {/* Text Keywords */}
                  <div>
                    <label className="text-[10px] text-[var(--muted)] block mb-1">
                      Text Keywords (comma-separated, ALL must appear in page text)
                    </label>
                    <input
                      type="text"
                      value={rule.textKeywords.join(", ")}
                      onChange={(e) =>
                        updateRule(rule.id, { textKeywords: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })
                      }
                      placeholder="e.g. DOOR, SCHEDULE"
                      className="w-full px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none focus:border-emerald-400/50"
                    />
                  </div>

                  {/* YOLO Model + Classes */}
                  <div className="space-y-2">
                    <div>
                      <label className="text-[10px] text-[var(--muted)] block mb-1">YOLO Model</label>
                      <select
                        value={rule.modelId || ""}
                        onChange={(e) => {
                          const mid = e.target.value ? Number(e.target.value) : undefined;
                          const model = yoloModels.find((m) => m.id === mid);
                          updateRule(rule.id, { modelId: mid, modelName: model?.name });
                        }}
                        className="w-full px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none"
                      >
                        <option value="">Any / Manual</option>
                        {yoloModels.map((m) => (
                          <option key={m.id} value={m.id}>{m.name} ({(m.config?.classes || []).length} classes)</option>
                        ))}
                      </select>
                    </div>

                    {/* Class chips from selected model */}
                    {(() => {
                      const selectedModel = yoloModels.find((m) => m.id === rule.modelId);
                      const modelClasses = selectedModel?.config?.classes || [];
                      if (modelClasses.length === 0) return (
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="text-[10px] text-[var(--muted)] block mb-1">YOLO Required (comma-separated)</label>
                            <input type="text" value={rule.yoloRequired.join(", ")}
                              onChange={(e) => updateRule(rule.id, { yoloRequired: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                              placeholder="e.g. table" className="w-full px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none focus:border-purple-400/50" />
                          </div>
                          <div>
                            <label className="text-[10px] text-[var(--muted)] block mb-1">YOLO Boosters (comma-separated)</label>
                            <input type="text" value={rule.yoloBoosters.join(", ")}
                              onChange={(e) => updateRule(rule.id, { yoloBoosters: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                              placeholder="e.g. grid, horizontal_area" className="w-full px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none focus:border-purple-400/50" />
                          </div>
                        </div>
                      );
                      return (
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="text-[10px] text-[var(--muted)] block mb-1">Required Classes (click to toggle)</label>
                            <div className="flex flex-wrap gap-1">
                              {modelClasses.map((cls) => {
                                const active = rule.yoloRequired.includes(cls);
                                return (
                                  <button key={cls} onClick={() => {
                                    const next = active ? rule.yoloRequired.filter((c) => c !== cls) : [...rule.yoloRequired, cls];
                                    updateRule(rule.id, { yoloRequired: next });
                                  }} className={`px-1.5 py-0.5 text-[9px] rounded border ${active
                                    ? "border-purple-400/50 text-purple-300 bg-purple-500/15"
                                    : "border-[var(--border)] text-[var(--muted)] hover:border-purple-400/30"}`}>
                                    {cls}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                          <div>
                            <label className="text-[10px] text-[var(--muted)] block mb-1">Booster Classes (click to toggle)</label>
                            <div className="flex flex-wrap gap-1">
                              {modelClasses.map((cls) => {
                                const active = rule.yoloBoosters.includes(cls);
                                return (
                                  <button key={cls} onClick={() => {
                                    const next = active ? rule.yoloBoosters.filter((c) => c !== cls) : [...rule.yoloBoosters, cls];
                                    updateRule(rule.id, { yoloBoosters: next });
                                  }} className={`px-1.5 py-0.5 text-[9px] rounded border ${active
                                    ? "border-amber-400/50 text-amber-300 bg-amber-500/15"
                                    : "border-[var(--border)] text-[var(--muted)] hover:border-amber-400/30"}`}>
                                    {cls}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      );
                    })()}
                  </div>

                  {/* Output label + CSI code + min confidence */}
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="text-[10px] text-[var(--muted)] block mb-1">Output Label</label>
                      <input
                        type="text"
                        value={rule.outputLabel}
                        onChange={(e) => updateRule(rule.id, { outputLabel: e.target.value })}
                        placeholder="e.g. door-schedule"
                        className="w-full px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none focus:border-[var(--accent)]"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-[var(--muted)] block mb-1">CSI Code (optional)</label>
                      <input
                        type="text"
                        value={rule.outputCsiCode || ""}
                        onChange={(e) => updateRule(rule.id, { outputCsiCode: e.target.value || undefined })}
                        placeholder="e.g. 08 11 16"
                        className="w-full px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none focus:border-blue-400/50 font-mono"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-[var(--muted)] block mb-1">
                        Min Confidence: {Math.round(rule.minConfidence * 100)}%
                      </label>
                      <input
                        type="range"
                        min="10"
                        max="95"
                        value={rule.minConfidence * 100}
                        onChange={(e) => updateRule(rule.id, { minConfidence: Number(e.target.value) / 100 })}
                        className="w-full h-1 accent-[var(--accent)]"
                      />
                    </div>
                  </div>

                  {/* CSI Divisions Required */}
                  <div>
                    <label className="text-[10px] text-[var(--muted)] block mb-1">
                      CSI Divisions Required (comma-separated, e.g. "08, 09" — rule only fires if these divisions are on the page)
                    </label>
                    <input
                      type="text"
                      value={(rule.csiDivisionsRequired || []).join(", ")}
                      onChange={(e) =>
                        updateRule(rule.id, { csiDivisionsRequired: normalizeCsiCodes(e.target.value) })
                      }
                      placeholder="e.g. 08, 09"
                      className="w-48 px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none focus:border-blue-400/50 font-mono"
                    />
                  </div>

                  {/* Text region type + overlap required */}
                  <div className="flex items-center gap-4">
                    <div>
                      <label className="text-[10px] text-[var(--muted)] block mb-1">Text Region Type (optional)</label>
                      <select
                        value={rule.textRegionType || ""}
                        onChange={(e) => updateRule(rule.id, { textRegionType: e.target.value || undefined })}
                        className="px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none"
                      >
                        <option value="">Any</option>
                        <option value="table-like">table-like</option>
                        <option value="notes-block">notes-block</option>
                        <option value="spec-text">spec-text</option>
                        <option value="key-value">key-value</option>
                        <option value="paragraph">paragraph</option>
                      </select>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer mt-4">
                      <input
                        type="checkbox"
                        checked={rule.overlapRequired}
                        onChange={(e) => updateRule(rule.id, { overlapRequired: e.target.checked })}
                        className="accent-[var(--accent)]"
                      />
                      <span className="text-[10px] text-[var(--muted)]">Require YOLO + text spatial overlap</span>
                    </label>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add custom rule button */}
      <button
        onClick={addCustomRule}
        className="px-4 py-2 text-sm rounded border border-dashed border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--accent)]/30 w-full"
      >
        + Add Custom Rule
      </button>

      {/* Actions */}
      <div className="flex gap-3 items-center">
        <button
          onClick={saveRules}
          disabled={saving}
          className="px-4 py-2 text-sm rounded bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save Rules"}
        </button>
        <button
          onClick={onReprocess}
          disabled={reprocessing}
          className="px-4 py-2 text-sm rounded border border-orange-400/40 text-orange-400 hover:bg-orange-400/10 disabled:opacity-50"
        >
          {reprocessing ? "Reprocessing..." : "Reprocess All Projects"}
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
