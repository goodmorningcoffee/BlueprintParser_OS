"use client";

import { useState, useEffect } from "react";
import { SECTION_REGISTRY, SECTION_PRESETS, DEFAULT_SYSTEM_PROMPT } from "@/lib/context-builder";

interface LlmContextTabProps {
  projects: Array<{ id: string; name: string; numPages: number | null; status: string }>;
}

interface LlmConfig {
  systemPrompt?: string;
  customContextWindow?: number;
  budgetOverrides?: Record<string, number>;
  toolUse?: boolean;
  domainKnowledge?: string;
  sectionConfig?: {
    disabledSections?: string[];
    priorityOverrides?: Record<string, number>;
    percentAllocations?: Record<string, number>;
    preset?: string;
  };
}

interface PreviewSection {
  id: string;
  header: string;
  priority: number;
  chars: number;
  allocated: number;
  included: boolean;
  truncated: boolean;
}

const DEFAULT_BUDGETS: Record<string, { label: string; budget: number; window: string }> = {
  "anthropic:opus": { label: "Anthropic / Opus", budget: 200000, window: "1M tokens" },
  "anthropic:sonnet": { label: "Anthropic / Sonnet", budget: 80000, window: "200K tokens" },
  "anthropic:haiku": { label: "Anthropic / Haiku", budget: 40000, window: "200K tokens" },
  "openai:gpt-4o": { label: "OpenAI / GPT-4o", budget: 60000, window: "128K tokens" },
  "openai:o1": { label: "OpenAI / o1/o3", budget: 80000, window: "200K tokens" },
  "groq:llama": { label: "Groq / Llama", budget: 24000, window: "8-128K tokens" },
  "custom:default": { label: "Custom / Ollama", budget: 30000, window: "varies" },
};

export default function LlmContextTab({ projects }: LlmContextTabProps) {
  const [config, setConfig] = useState<LlmConfig>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activePanel, setActivePanel] = useState<"budget" | "prompt" | "sections" | "preview" | "domain">("sections");
  const [sortBy, setSortBy] = useState<"default" | "priority-asc" | "priority-desc" | "pct-asc" | "pct-desc">("default");
  const [defaultDomainKnowledge, setDefaultDomainKnowledge] = useState("");

  // Preview state
  const [previewProject, setPreviewProject] = useState("");
  const [previewPage, setPreviewPage] = useState(1);
  const [previewScope, setPreviewScope] = useState<"page" | "project">("page");
  const [previewResult, setPreviewResult] = useState<{ sections: PreviewSection[]; totalChars: number; budget: number } | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    fetch("/api/admin/llm/config")
      .then((r) => r.ok ? r.json() : { llm: {}, defaultDomainKnowledge: "" })
      .then((data) => {
        setConfig(data.llm || {});
        setDefaultDomainKnowledge(data.defaultDomainKnowledge || "");
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const save = async (updated: LlmConfig) => {
    const prev = config;
    setConfig(updated); // optimistic
    setSaving(true);
    try {
      const res = await fetch("/api/admin/llm/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llm: updated }),
      });
      if (!res.ok) setConfig(prev); // revert on failure
    } catch {
      setConfig(prev); // revert on error
    } finally {
      setSaving(false);
    }
  };

  const sectionConfig = config.sectionConfig || {};
  const disabledSet = new Set(sectionConfig.disabledSections || []);
  const priorities = sectionConfig.priorityOverrides || {};
  const allocations = sectionConfig.percentAllocations || {};
  const preset = sectionConfig.preset || "structured";

  const toggleSection = (id: string) => {
    const disabled = [...disabledSet];
    if (disabledSet.has(id)) {
      save({ ...config, sectionConfig: { ...sectionConfig, disabledSections: disabled.filter((d) => d !== id) } });
    } else {
      save({ ...config, sectionConfig: { ...sectionConfig, disabledSections: [...disabled, id] } });
    }
  };

  const setPriority = (id: string, value: number) => {
    save({ ...config, sectionConfig: { ...sectionConfig, priorityOverrides: { ...priorities, [id]: value } } });
  };

  const setAllocation = (id: string, value: number) => {
    const clamped = Math.max(0, Math.min(100, value));
    save({ ...config, sectionConfig: { ...sectionConfig, percentAllocations: { ...allocations, [id]: clamped }, preset: "custom" } });
  };

  const setPreset = (p: string) => {
    const presetAllocations = SECTION_PRESETS[p] || {};
    save({ ...config, sectionConfig: { ...sectionConfig, preset: p, percentAllocations: presetAllocations } });
  };

  const runPreview = async () => {
    if (!previewProject) return;
    setPreviewing(true);
    try {
      const res = await fetch("/api/admin/llm/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: previewProject, pageNumber: previewPage, scope: previewScope }),
      });
      if (res.ok) {
        setPreviewResult(await res.json());
      }
    } catch (err) {
      console.error("[llm-preview] Failed:", err);
    } finally {
      setPreviewing(false);
    }
  };

  const completedProjects = projects.filter((p) => p.status === "completed");

  if (loading) return <div className="text-sm text-[var(--muted)]">Loading LLM config...</div>;

  return (
    <div className="max-w-4xl">
      {/* Panel tabs */}
      <div className="flex gap-1 mb-4 border-b border-[var(--border)]">
        {[
          { id: "sections" as const, label: "Context Sections" },
          { id: "prompt" as const, label: "System Prompt" },
          { id: "domain" as const, label: "Domain Knowledge" },
          { id: "budget" as const, label: "Budget" },
          { id: "preview" as const, label: "Preview" },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActivePanel(tab.id)}
            className={`px-4 py-2 text-xs font-medium transition-colors ${
              activePanel === tab.id
                ? "text-[var(--accent)] border-b-2 border-[var(--accent)]"
                : "text-[var(--muted)] hover:text-[var(--fg)]"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ─── Panel 1: Context Sections ─── */}
      {activePanel === "sections" && (
        <div className="space-y-4">
          {/* Tool Use Toggle */}
          <div className="flex items-center justify-between px-3 py-2.5 rounded border border-[var(--border)] bg-[var(--bg)]">
            <div>
              <div className="text-xs font-semibold text-[var(--fg)]">Tool Use (Agentic Mode)</div>
              <div className="text-[9px] text-[var(--muted)]">
                LLM calls tools to fetch data on-demand instead of receiving pre-built context. Requires Claude or GPT-4o. Uses more tokens per message but gives dramatically better answers.
              </div>
            </div>
            <button
              onClick={() => save({ ...config, toolUse: !config.toolUse })}
              className={`px-3 py-1 rounded text-[10px] font-medium border shrink-0 ml-3 ${
                config.toolUse
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                  : "border-[var(--border)] text-[var(--muted)]"
              }`}
            >
              {config.toolUse ? "ON" : "OFF"}
            </button>
          </div>

          {config.toolUse && (
            <div className="text-[10px] text-amber-400 px-3 py-2 rounded bg-amber-500/5 border border-amber-500/20">
              When Tool Use is ON, the context sections below are bypassed. The LLM uses 27 tools to query project data on-demand. Turn OFF to use the traditional context-dump approach.
            </div>
          )}

          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold">Context Sections</h3>
              <p className="text-xs text-[var(--muted)]">Control what data the LLM receives. <strong>Priority</strong> (lower = included first). <strong>Budget %</strong> = share of context data sent to the model. Unused % overflows to sections that need more space.</p>
            </div>
            <div className="flex gap-1">
              {["balanced", "structured", "verbose", "custom"].map((p) => (
                <button
                  key={p}
                  onClick={() => setPreset(p)}
                  className={`px-2 py-1 rounded text-[10px] border ${
                    preset === p
                      ? "border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]"
                      : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* Column headers — clickable to sort */}
          <div className="flex items-center gap-3 px-3 py-1">
            <div className="w-8 shrink-0" />
            <div className="flex-1 min-w-0" />
            <button
              onClick={() => setSortBy(sortBy === "priority-asc" ? "priority-desc" : "priority-asc")}
              className="w-12 text-[9px] text-[var(--muted)] text-center hover:text-[var(--fg)] cursor-pointer"
            >
              Priority {sortBy === "priority-asc" ? "▲" : sortBy === "priority-desc" ? "▼" : ""}
            </button>
            <button
              onClick={() => setSortBy(sortBy === "pct-desc" ? "pct-asc" : "pct-desc")}
              className="w-16 text-[9px] text-[var(--muted)] text-center shrink-0 hover:text-[var(--fg)] cursor-pointer"
            >
              Budget % {sortBy === "pct-desc" ? "▼" : sortBy === "pct-asc" ? "▲" : ""}
            </button>
          </div>

          <div className="space-y-1">
            {(() => {
              const enabledCount = Object.keys(SECTION_REGISTRY).filter((id) => !disabledSet.has(id)).length;
              const defaultPct = Math.round(100 / Math.max(enabledCount, 1));
              const rows = Object.entries(SECTION_REGISTRY).map(([id, reg]) => {
                const enabled = !disabledSet.has(id);
                const priority = priorities[id] ?? reg.defaultPriority;
                const presetPct = SECTION_PRESETS[preset]?.[id];
                // For presets with no explicit allocation (like "balanced"), show equal split
                const pct = allocations[id] ?? (presetPct !== undefined ? presetPct : defaultPct);
                return { id, reg, enabled, priority, pct };
              });
              const totalPct = rows.filter((r) => r.enabled).reduce((sum, r) => sum + r.pct, 0);

              // Apply sort
              const sorted = [...rows];
              if (sortBy === "priority-asc") sorted.sort((a, b) => a.priority - b.priority);
              else if (sortBy === "priority-desc") sorted.sort((a, b) => b.priority - a.priority);
              else if (sortBy === "pct-desc") sorted.sort((a, b) => b.pct - a.pct);
              else if (sortBy === "pct-asc") sorted.sort((a, b) => a.pct - b.pct);

              return (
                <>
                  {sorted.map(({ id, reg, enabled, priority, pct }) => (
                    <div
                      key={id}
                      className={`flex items-center gap-3 px-3 py-2 rounded border transition-colors ${
                        enabled ? "border-emerald-500/20 bg-emerald-500/5" : "border-[var(--border)] opacity-40"
                      }`}
                    >
                      <button
                        onClick={() => toggleSection(id)}
                        className={`w-8 text-center text-[10px] font-medium rounded py-0.5 shrink-0 ${
                          enabled ? "bg-emerald-500/20 text-emerald-400" : "bg-[var(--border)] text-[var(--muted)]"
                        }`}
                      >
                        {enabled ? "ON" : "OFF"}
                      </button>

                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-[var(--fg)] truncate">{reg.label}</div>
                        <div className="text-[9px] text-[var(--muted)] truncate">{reg.description}</div>
                      </div>

                      {enabled && (
                        <>
                          <input
                            type="number"
                            value={priority}
                            onChange={(e) => setPriority(id, parseFloat(e.target.value) || 0)}
                            className="w-12 text-[10px] text-center bg-[var(--bg)] border border-[var(--border)] rounded px-1 py-0.5 text-[var(--fg)]"
                            title="Priority: lower number = included first when budget is tight"
                            step="0.5"
                          />
                          <div className="flex items-center gap-1 w-16 shrink-0">
                            <input
                              type="number"
                              value={pct}
                              onChange={(e) => setAllocation(id, parseInt(e.target.value) || 0)}
                              className="w-10 text-[10px] text-center bg-[var(--bg)] border border-[var(--border)] rounded px-1 py-0.5 text-[var(--fg)]"
                              title="% of context budget allocated to this section"
                              min={0}
                              max={100}
                            />
                            <span className="text-[9px] text-[var(--muted)]">%</span>
                          </div>
                        </>
                      )}
                    </div>
                  ))}

                  {/* Total allocation summary */}
                  <div className={`flex items-center justify-end gap-2 px-3 py-1.5 rounded text-[10px] font-medium ${
                    totalPct > 100 ? "text-red-400 bg-red-500/10 border border-red-500/20" :
                    totalPct < 80 ? "text-amber-400" : "text-[var(--muted)]"
                  }`}>
                    {totalPct > 100 && <span>Over-allocated — excess sections will be truncated or dropped.</span>}
                    {totalPct < 80 && <span>Under-allocated — unused budget becomes overflow for large sections.</span>}
                    <span className="ml-auto">Total: {totalPct}%</span>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* ─── Panel 2: System Prompt ─── */}
      {activePanel === "prompt" && (
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold">System Prompt</h3>
            <p className="text-xs text-[var(--muted)]">
              The instruction the LLM sees before any blueprint data. Anti-hallucination guardrails are always appended.
            </p>
          </div>

          <textarea
            value={config.systemPrompt || DEFAULT_SYSTEM_PROMPT}
            onChange={(e) => save({ ...config, systemPrompt: e.target.value })}
            rows={8}
            className="w-full text-xs bg-[var(--bg)] border border-[var(--border)] rounded p-3 text-[var(--fg)] font-mono outline-none focus:border-[var(--accent)]/50 resize-y"
          />

          <div className="text-[10px] text-[var(--muted)] space-y-1">
            <div>Template variables: <code className="text-[var(--accent)]">{"{{project_name}}"}</code> <code className="text-[var(--accent)]">{"{{page_count}}"}</code> <code className="text-[var(--accent)]">{"{{company_name}}"}</code></div>
            <div>The following is always appended: "DATA PROVIDED:" summary + "cite actual page numbers" instruction.</div>
          </div>

          <button
            onClick={() => save({ ...config, systemPrompt: undefined })}
            className="text-xs px-3 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
          >
            Reset to Default
          </button>
        </div>
      )}

      {/* ─── Panel: Domain Knowledge ─── */}
      {activePanel === "domain" && (
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold">Domain Knowledge</h3>
            <p className="text-xs text-[var(--muted)]">
              Construction domain reference injected into the LLM system prompt when Tool Use is ON.
              Teaches the AI about drawing conventions, YOLO classes, CSI divisions, heuristic patterns, and how to interpret blueprint data.
              Edit to add your company&apos;s specific conventions.
            </p>
          </div>

          <textarea
            value={config.domainKnowledge || defaultDomainKnowledge}
            onChange={(e) => save({ ...config, domainKnowledge: e.target.value })}
            rows={24}
            className="w-full text-xs bg-[var(--bg)] border border-[var(--border)] rounded p-3 text-[var(--fg)] font-mono outline-none focus:border-[var(--accent)]/50 resize-y leading-relaxed"
          />

          <div className="flex items-center gap-2">
            {config.domainKnowledge && (
              <button
                onClick={() => save({ ...config, domainKnowledge: undefined })}
                className="text-xs px-3 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
              >
                Reset to Built-in Default
              </button>
            )}
            <span className="text-[10px] text-[var(--muted)]">
              {config.domainKnowledge
                ? `Custom (${config.domainKnowledge.length} chars) — editing will save to your company config`
                : `Showing built-in default (${defaultDomainKnowledge.length} chars) — edit to customize`}
            </span>
          </div>
        </div>
      )}

      {/* ─── Panel 3: Budget ─── */}
      {activePanel === "budget" && (
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold">Context Budgets</h3>
            <p className="text-xs text-[var(--muted)]">
              How many characters of context to send per model. ~4 chars = ~1 token. Budget is split across enabled sections by % allocation.
            </p>
          </div>

          <div className="space-y-1">
            {Object.entries(DEFAULT_BUDGETS).map(([key, def]) => {
              const override = config.budgetOverrides?.[key];
              const current = override ?? def.budget;
              return (
                <div key={key} className="flex items-center gap-3 px-3 py-2 rounded border border-[var(--border)]">
                  <span className="text-xs text-[var(--fg)] flex-1">{def.label}</span>
                  <span className="text-[10px] text-[var(--muted)] w-24 text-right">{def.window}</span>
                  <input
                    type="number"
                    value={current}
                    onChange={(e) => {
                      const val = parseInt(e.target.value) || def.budget;
                      save({ ...config, budgetOverrides: { ...(config.budgetOverrides || {}), [key]: val } });
                    }}
                    className="w-20 text-xs text-right bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1 text-[var(--fg)]"
                    step={1000}
                  />
                  <span className="text-[9px] text-[var(--muted)] w-14 text-right">~{Math.round(current / 4).toLocaleString()} tok</span>
                </div>
              );
            })}
          </div>

          <div className="px-3 py-2 rounded border border-[var(--border)]">
            <div className="text-xs text-[var(--fg)] mb-1">Custom / Ollama Context Window</div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={config.customContextWindow || 32000}
                onChange={(e) => save({ ...config, customContextWindow: parseInt(e.target.value) || 32000 })}
                className="w-24 text-xs bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1 text-[var(--fg)]"
                step={1000}
              />
              <span className="text-[10px] text-[var(--muted)]">tokens (set manually for custom LLM providers)</span>
            </div>
          </div>

          <button
            onClick={() => save({ ...config, budgetOverrides: undefined, customContextWindow: undefined })}
            className="text-xs px-3 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
          >
            Reset to Defaults
          </button>
        </div>
      )}

      {/* ─── Panel 4: Preview ─── */}
      {activePanel === "preview" && (
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold">Context Preview</h3>
            <p className="text-xs text-[var(--muted)]">See exactly what the LLM receives for any project + page.</p>
          </div>

          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <label className="text-[10px] text-[var(--muted)] block mb-1">Project</label>
              <select
                value={previewProject}
                onChange={(e) => setPreviewProject(e.target.value)}
                className="w-full text-xs bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--fg)]"
              >
                <option value="">Select...</option>
                {completedProjects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div className="w-20">
              <label className="text-[10px] text-[var(--muted)] block mb-1">Page</label>
              <input
                type="number"
                value={previewPage}
                onChange={(e) => setPreviewPage(parseInt(e.target.value) || 1)}
                className="w-full text-xs bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--fg)]"
                min={1}
              />
            </div>
            <div className="w-24">
              <label className="text-[10px] text-[var(--muted)] block mb-1">Scope</label>
              <select
                value={previewScope}
                onChange={(e) => setPreviewScope(e.target.value as "page" | "project")}
                className="w-full text-xs bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--fg)]"
              >
                <option value="page">Page</option>
                <option value="project">Project</option>
              </select>
            </div>
            <button
              onClick={runPreview}
              disabled={!previewProject || previewing}
              className="px-4 py-1.5 rounded bg-[var(--accent)] text-white text-xs font-medium disabled:opacity-40"
            >
              {previewing ? "..." : "Preview"}
            </button>
          </div>

          {previewResult && (
            <div className="border border-[var(--border)] rounded bg-[var(--bg)] p-3 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[var(--fg)] font-medium">
                  {previewResult.totalChars.toLocaleString()} / {previewResult.budget.toLocaleString()} chars
                  ({Math.round(previewResult.totalChars / previewResult.budget * 100)}%)
                </span>
                <span className="text-[var(--muted)]">
                  {previewResult.sections.filter((s) => s.included).length} sections included
                </span>
              </div>

              {/* Budget bar */}
              <div className="h-2 rounded bg-[var(--border)] overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded"
                  style={{ width: `${Math.min(100, previewResult.totalChars / previewResult.budget * 100)}%` }}
                />
              </div>

              {/* Section list */}
              <div className="space-y-0.5 max-h-64 overflow-y-auto">
                {previewResult.sections
                  .sort((a, b) => a.priority - b.priority)
                  .map((s) => (
                    <div
                      key={s.id}
                      className={`flex items-center gap-2 px-2 py-1 rounded text-[10px] ${
                        s.included
                          ? s.truncated ? "text-amber-400" : "text-[var(--fg)]"
                          : "text-[var(--muted)]/40 line-through"
                      }`}
                    >
                      <span className="w-6 text-right text-[var(--muted)]">{s.priority}</span>
                      <span className="flex-1 truncate">{s.header}</span>
                      <span className="w-16 text-right font-mono">
                        {s.included ? `${s.chars.toLocaleString()} ch` : "—"}
                      </span>
                      {s.truncated && <span className="text-amber-400 text-[8px]">TRUNC</span>}
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}

      {saving && <div className="text-[10px] text-[var(--accent)] text-center mt-2">Saving...</div>}
    </div>
  );
}
