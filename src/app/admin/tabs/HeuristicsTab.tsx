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

interface YoloSource {
  modelId: number;
  modelName: string;
  classes: string[];
}

interface PageNamingConfig {
  enabled: boolean;
  yoloSources: YoloSource[];
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
  const [pageNaming, setPageNaming] = useState<PageNamingConfig>({ enabled: false, yoloSources: [] });
  const [savingPageNaming, setSavingPageNaming] = useState(false);
  const [pageNamingMessage, setPageNamingMessage] = useState("");

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

        if (data.pageNaming) {
          setPageNaming(data.pageNaming);
        }
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

  async function savePageNaming() {
    setSavingPageNaming(true);
    setPageNamingMessage("");
    try {
      const res = await fetch("/api/admin/heuristics/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageNaming }),
      });
      if (res.ok) {
        setPageNamingMessage("Page naming config saved");
        setTimeout(() => setPageNamingMessage(""), 3000);
      } else {
        setPageNamingMessage("Save failed");
      }
    } catch {
      setPageNamingMessage("Save failed");
    }
    setSavingPageNaming(false);
  }

  function addYoloSource() {
    setPageNaming(prev => ({
      ...prev,
      yoloSources: [...prev.yoloSources, { modelId: 0, modelName: "", classes: [] }],
    }));
  }

  function removeYoloSource(idx: number) {
    setPageNaming(prev => ({
      ...prev,
      yoloSources: prev.yoloSources.filter((_, i) => i !== idx),
    }));
  }

  function updateYoloSource(idx: number, updates: Partial<YoloSource>) {
    setPageNaming(prev => ({
      ...prev,
      yoloSources: prev.yoloSources.map((s, i) => i === idx ? { ...s, ...updates } : s),
    }));
  }

  function toggleYoloSourceClass(idx: number, cls: string) {
    setPageNaming(prev => ({
      ...prev,
      yoloSources: prev.yoloSources.map((s, i) => {
        if (i !== idx) return s;
        const has = s.classes.includes(cls);
        return { ...s, classes: has ? s.classes.filter(c => c !== cls) : [...s.classes, cls] };
      }),
    }));
  }

  // Check if any configured source has a valid model with selected classes
  const pageNamingValid = pageNaming.yoloSources.length > 0 &&
    pageNaming.yoloSources.every(s => s.modelId > 0 && s.classes.length > 0);

  // Check which models have title_block-like classes for hint
  const modelsWithTitleBlock = yoloModels.filter(m =>
    (m.config?.classes || []).some(c => c.toLowerCase().includes("title"))
  );

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

      {/* Page Naming — YOLO Title Block Configuration */}
      <section className="border border-emerald-500/20 rounded-lg p-4 space-y-3 bg-emerald-500/5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-[var(--fg)]">Page Naming — YOLO Title Block</h3>
            <p className="text-[10px] text-[var(--muted)] mt-0.5">
              Use YOLO-detected title block regions to improve page name extraction accuracy.
            </p>
          </div>
          <button
            onClick={() => setPageNaming(prev => ({ ...prev, enabled: !prev.enabled }))}
            className={`w-10 h-5 rounded-full relative transition-colors ${
              pageNaming.enabled ? "bg-emerald-500" : "bg-[var(--border)]"
            }`}
          >
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              pageNaming.enabled ? "left-5" : "left-0.5"
            }`} />
          </button>
        </div>

        {pageNaming.enabled && (
          <div className="space-y-3">
            {/* YOLO sources */}
            {pageNaming.yoloSources.length === 0 && (
              <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-400/20 rounded px-3 py-2">
                No YOLO sources configured. Add a model + class below.
              </div>
            )}

            {pageNaming.yoloSources.map((source, idx) => {
              const selectedModel = yoloModels.find(m => m.id === source.modelId);
              const modelClasses = selectedModel?.config?.classes || [];
              return (
                <div key={idx} className="bg-[var(--surface)] border border-[var(--border)] rounded p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-[var(--muted)] font-medium">Source {idx + 1}</span>
                    <div className="flex-1" />
                    <button
                      onClick={() => removeYoloSource(idx)}
                      className="text-[10px] text-[var(--muted)] hover:text-red-400"
                    >
                      Remove
                    </button>
                  </div>

                  {/* Model picker */}
                  <div>
                    <label className="text-[10px] text-[var(--muted)] block mb-1">YOLO Model</label>
                    <select
                      value={source.modelId || ""}
                      onChange={(e) => {
                        const mid = e.target.value ? Number(e.target.value) : 0;
                        const model = yoloModels.find(m => m.id === mid);
                        updateYoloSource(idx, {
                          modelId: mid,
                          modelName: model?.name || "",
                          classes: [], // Reset classes when model changes
                        });
                      }}
                      className="w-full px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none"
                    >
                      <option value="">Select model...</option>
                      {yoloModels.map(m => (
                        <option key={m.id} value={m.id}>{m.name} ({(m.config?.classes || []).length} classes)</option>
                      ))}
                    </select>
                  </div>

                  {/* Class picker (chips) */}
                  {modelClasses.length > 0 && (
                    <div>
                      <label className="text-[10px] text-[var(--muted)] block mb-1">
                        Classes to use as title block (click to toggle)
                      </label>
                      <div className="flex flex-wrap gap-1">
                        {modelClasses.map(cls => {
                          const active = source.classes.includes(cls);
                          return (
                            <button
                              key={cls}
                              onClick={() => toggleYoloSourceClass(idx, cls)}
                              className={`px-1.5 py-0.5 text-[9px] rounded border transition-colors ${
                                active
                                  ? "border-emerald-400/50 text-emerald-300 bg-emerald-500/15"
                                  : "border-[var(--border)] text-[var(--muted)] hover:border-emerald-400/30"
                              }`}
                            >
                              {cls}
                            </button>
                          );
                        })}
                      </div>
                      {source.classes.length === 0 && source.modelId > 0 && (
                        <p className="text-[9px] text-amber-400 mt-1">Select at least one class</p>
                      )}
                    </div>
                  )}

                  {source.modelId > 0 && modelClasses.length === 0 && (
                    <p className="text-[9px] text-[var(--muted)]">
                      This model has no classes defined. Upload a classes.txt file for it.
                    </p>
                  )}
                </div>
              );
            })}

            {/* Add source button */}
            <button
              onClick={addYoloSource}
              className="w-full px-3 py-1.5 text-xs rounded border border-dashed border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-emerald-400/30"
            >
              + Add YOLO Source
            </button>

            {/* Validation warnings */}
            {pageNaming.enabled && pageNaming.yoloSources.length > 0 && !pageNamingValid && (
              <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-400/20 rounded px-3 py-2">
                Each source needs a model selected and at least one class toggled on.
              </div>
            )}

            {pageNaming.enabled && yoloModels.length === 0 && (
              <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-400/20 rounded px-3 py-2">
                No YOLO models found. Upload and run YOLO model(s) with a title_block class first.
              </div>
            )}

            {pageNaming.enabled && yoloModels.length > 0 && modelsWithTitleBlock.length === 0 && (
              <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-400/20 rounded px-3 py-2">
                None of your YOLO models have a class containing "title". You can still select any class, but typical title block classes are: title_block, title_area, etc.
              </div>
            )}

            {/* Save */}
            <div className="flex items-center gap-3">
              <button
                onClick={savePageNaming}
                disabled={savingPageNaming}
                className="px-4 py-1.5 text-sm rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {savingPageNaming ? "Saving..." : "Save Page Naming Config"}
              </button>
              {pageNamingMessage && (
                <span className={`text-xs ${pageNamingMessage.includes("fail") ? "text-red-400" : "text-green-400"}`}>
                  {pageNamingMessage}
                </span>
              )}
            </div>
          </div>
        )}
      </section>

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

                    {/* Class chips from selected model (or all models if none selected) */}
                    {(() => {
                      const selectedModel = yoloModels.find((m) => m.id === rule.modelId);
                      // When a model is selected, use its classes. Otherwise, collect from ALL models.
                      const modelClasses = selectedModel?.config?.classes || [];
                      const allModelClasses: { cls: string; modelName: string }[] = [];
                      if (modelClasses.length === 0 && yoloModels.length > 0) {
                        for (const m of yoloModels) {
                          for (const cls of m.config?.classes || []) {
                            if (!allModelClasses.some((c) => c.cls === cls)) {
                              allModelClasses.push({ cls, modelName: m.name });
                            }
                          }
                        }
                      }
                      const chipClasses = modelClasses.length > 0
                        ? modelClasses.map((cls: string) => ({ cls, modelName: selectedModel?.name || "" }))
                        : allModelClasses;
                      if (chipClasses.length === 0) return (
                        <div className="text-[10px] text-[var(--muted)]">No YOLO models available — upload a model first.</div>
                      );
                      const showModelLabel = modelClasses.length === 0; // show "Model: class" when using all models
                      return (
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="text-[10px] text-[var(--muted)] block mb-1">Required Classes (click to toggle)</label>
                            <div className="flex flex-wrap gap-1">
                              {chipClasses.map(({ cls, modelName }) => {
                                const active = rule.yoloRequired.includes(cls);
                                return (
                                  <button key={`${modelName}:${cls}`} onClick={() => {
                                    const next = active ? rule.yoloRequired.filter((c: string) => c !== cls) : [...rule.yoloRequired, cls];
                                    updateRule(rule.id, { yoloRequired: next });
                                  }} className={`px-1.5 py-0.5 text-[9px] rounded border ${active
                                    ? "border-purple-400/50 text-purple-300 bg-purple-500/15"
                                    : "border-[var(--border)] text-[var(--muted)] hover:border-purple-400/30"}`}>
                                    {showModelLabel ? `${modelName}: ${cls}` : cls}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                          <div>
                            <label className="text-[10px] text-[var(--muted)] block mb-1">Booster Classes (click to toggle)</label>
                            <div className="flex flex-wrap gap-1">
                              {chipClasses.map(({ cls, modelName }) => {
                                const active = rule.yoloBoosters.includes(cls);
                                return (
                                  <button key={`${modelName}:${cls}`} onClick={() => {
                                    const next = active ? rule.yoloBoosters.filter((c: string) => c !== cls) : [...rule.yoloBoosters, cls];
                                    updateRule(rule.id, { yoloBoosters: next });
                                  }} className={`px-1.5 py-0.5 text-[9px] rounded border ${active
                                    ? "border-amber-400/50 text-amber-300 bg-amber-500/15"
                                    : "border-[var(--border)] text-[var(--muted)] hover:border-amber-400/30"}`}>
                                    {showModelLabel ? `${modelName}: ${cls}` : cls}
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
