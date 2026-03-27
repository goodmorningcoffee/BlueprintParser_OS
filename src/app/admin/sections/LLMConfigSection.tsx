"use client";

import { useEffect, useState, useCallback } from "react";
import { LLM_PRESETS, PROVIDER_ORDER } from "@/lib/llm/presets";

interface LlmConfigView {
  id: number;
  provider: string;
  model: string;
  maskedKey: string | null;
  hasKey: boolean;
  baseUrl: string | null;
  isDemo: boolean;
  isDefault: boolean;
  config: { temperature?: number; maxTokens?: number } | null;
}

interface EnvDefaults {
  groq: boolean;
  anthropic: boolean;
  openai: boolean;
}

type Scope = "users" | "demo";

export default function LLMConfigSection() {
  const [configs, setConfigs] = useState<LlmConfigView[]>([]);
  const [envDefaults, setEnvDefaults] = useState<EnvDefaults>({ groq: false, anthropic: false, openai: false });
  const [editingScope, setEditingScope] = useState<Scope | null>(null);
  const [form, setForm] = useState({ provider: "groq", model: "", apiKey: "", baseUrl: "" });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const loadConfigs = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/llm-config");
      if (res.ok) {
        const data = await res.json();
        setConfigs(data.configs);
        setEnvDefaults(data.envDefaults);
      }
    } catch { /* table may not exist */ }
  }, []);

  useEffect(() => { loadConfigs(); }, [loadConfigs]);

  const getConfig = (scope: Scope) => configs.find((c) => c.isDemo === (scope === "demo"));

  const getEnvDefault = (): string | null => {
    if (envDefaults.groq) return "Groq (llama-3.3-70b)";
    if (envDefaults.anthropic) return "Anthropic (Claude)";
    if (envDefaults.openai) return "OpenAI (GPT)";
    return null;
  };

  const startEdit = (scope: Scope) => {
    const existing = getConfig(scope);
    setForm({
      provider: existing?.provider || "groq",
      model: existing?.model || LLM_PRESETS.groq.defaultModel,
      apiKey: "",
      baseUrl: existing?.baseUrl || "",
    });
    setEditingScope(scope);
    setTestResult(null);
    setError("");
  };

  const cancelEdit = () => {
    setEditingScope(null);
    setTestResult(null);
    setError("");
  };

  const handleProviderChange = (provider: string) => {
    const preset = LLM_PRESETS[provider];
    setForm((f) => ({
      ...f,
      provider,
      model: preset?.defaultModel || "",
      baseUrl: provider === "custom" ? f.baseUrl : "",
    }));
    setTestResult(null);
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/admin/llm-config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: form.provider,
          model: form.model,
          apiKey: form.apiKey || undefined,
          baseUrl: form.provider === "custom" ? form.baseUrl : undefined,
        }),
      });
      const data = await res.json();
      setTestResult({
        success: data.success,
        message: data.success ? `Connected! ${data.responseTime}ms` : data.error,
      });
    } catch {
      setTestResult({ success: false, message: "Network error" });
    } finally {
      setTesting(false);
    }
  };

  const saveConfig = async () => {
    if (!editingScope) return;
    setSaving(true);
    setError("");
    try {
      const existing = getConfig(editingScope);
      const res = await fetch("/api/admin/llm-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: form.provider,
          model: form.model,
          apiKey: form.apiKey || (existing?.hasKey ? "unchanged" : undefined),
          baseUrl: form.provider === "custom" ? form.baseUrl : undefined,
          isDemo: editingScope === "demo",
        }),
      });
      if (res.ok) {
        setEditingScope(null);
        loadConfigs();
      } else {
        const data = await res.json();
        setError(data.error || "Save failed");
      }
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  };

  const deleteConfig = async (id: number) => {
    if (!confirm("Remove this LLM configuration? Chat will fall back to environment defaults.")) return;
    const res = await fetch("/api/admin/llm-config", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (res.ok) loadConfigs();
  };

  const preset = LLM_PRESETS[form.provider];
  const envDefault = getEnvDefault();

  return (
    <section>
      <h2 className="text-lg font-semibold mb-3">LLM Configuration</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {(["users", "demo"] as const).map((scope) => {
          const config = getConfig(scope);
          const isEditing = editingScope === scope;
          const label = scope === "users" ? "Authenticated Users" : "Demo (Public)";

          if (isEditing) {
            return (
              <div key={scope} className="p-4 bg-[var(--surface)] border border-[var(--accent)]/30 rounded space-y-3">
                <h3 className="text-sm font-medium text-[var(--accent)]">{label} — Configure</h3>

                {/* Provider */}
                <div>
                  <label className="text-xs text-[var(--muted)] block mb-1">Provider</label>
                  <select
                    value={form.provider}
                    onChange={(e) => handleProviderChange(e.target.value)}
                    className="w-full px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded"
                  >
                    {PROVIDER_ORDER.map((p) => (
                      <option key={p} value={p}>{LLM_PRESETS[p].label}</option>
                    ))}
                  </select>
                </div>

                {/* Model */}
                <div>
                  <label className="text-xs text-[var(--muted)] block mb-1">Model</label>
                  {preset && preset.models.length > 0 ? (
                    <select
                      value={form.model}
                      onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                      className="w-full px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded"
                    >
                      {preset.models.map((m) => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={form.model}
                      onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                      placeholder="e.g. llama3.1, mistral, etc."
                      className="w-full px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded"
                    />
                  )}
                </div>

                {/* API Key */}
                {preset?.needsKey !== false && (
                  <div>
                    <label className="text-xs text-[var(--muted)] block mb-1">
                      API Key {config?.hasKey && <span className="text-green-400">(current key saved)</span>}
                    </label>
                    <input
                      type="password"
                      value={form.apiKey}
                      onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                      placeholder={config?.hasKey ? "Leave blank to keep current key" : preset?.keyPrefix ? `Starts with ${preset.keyPrefix}...` : "API key"}
                      className="w-full px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded"
                    />
                  </div>
                )}

                {/* Base URL (custom only) */}
                {form.provider === "custom" && (
                  <div>
                    <label className="text-xs text-[var(--muted)] block mb-1">Base URL</label>
                    <input
                      value={form.baseUrl}
                      onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                      placeholder="http://localhost:11434/v1"
                      className="w-full px-3 py-1.5 text-sm bg-[var(--bg)] border border-[var(--border)] rounded"
                    />
                  </div>
                )}

                {/* Test result */}
                {testResult && (
                  <div className={`text-xs px-2 py-1 rounded ${testResult.success ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>
                    {testResult.success ? "\u2713 " : "\u2717 "}{testResult.message}
                  </div>
                )}
                {error && <div className="text-xs text-red-400">{error}</div>}

                {/* Actions */}
                <div className="flex gap-2 pt-1">
                  <button onClick={cancelEdit}
                    className="px-3 py-1.5 text-xs border border-[var(--border)] rounded text-[var(--muted)] hover:text-[var(--fg)]">
                    Cancel
                  </button>
                  <button onClick={testConnection} disabled={testing}
                    className="px-3 py-1.5 text-xs border border-[var(--border)] rounded text-[var(--accent)] hover:border-[var(--accent)] disabled:opacity-40">
                    {testing ? "Testing..." : "Test Connection"}
                  </button>
                  <button onClick={saveConfig} disabled={saving || !form.model}
                    className="px-3 py-1.5 text-xs bg-[var(--accent)] text-white rounded hover:bg-[var(--accent)]/80 disabled:opacity-40">
                    {saving ? "Saving..." : "Save"}
                  </button>
                </div>
              </div>
            );
          }

          if (config) {
            return (
              <div key={scope} className="p-4 bg-[var(--surface)] border border-[var(--border)] rounded space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">
                    {label} <span className="text-green-400 ml-1">\u2713</span>
                  </h3>
                  <button onClick={() => startEdit(scope)}
                    className="text-xs text-[var(--accent)] hover:underline">
                    Edit
                  </button>
                </div>
                <div className="text-xs space-y-1 text-[var(--muted)]">
                  <div>Provider: <span className="text-[var(--fg)]">{LLM_PRESETS[config.provider]?.label || config.provider}</span></div>
                  <div>Model: <span className="text-[var(--fg)]">{config.model}</span></div>
                  {config.maskedKey && <div>API Key: <span className="text-[var(--fg)] font-mono">{config.maskedKey}</span></div>}
                  {config.baseUrl && <div>URL: <span className="text-[var(--fg)]">{config.baseUrl}</span></div>}
                </div>
                <div className="flex gap-2 pt-1">
                  <button onClick={testConnection} disabled={testing}
                    className="text-xs text-[var(--muted)] hover:text-[var(--accent)]">
                    {testing ? "Testing..." : "Test Connection"}
                  </button>
                  <button onClick={() => deleteConfig(config.id)}
                    className="text-xs text-[var(--muted)] hover:text-red-400">
                    Remove
                  </button>
                </div>
              </div>
            );
          }

          return (
            <div key={scope} className="p-4 bg-[var(--surface)] border border-[var(--border)] rounded space-y-2">
              <h3 className="text-sm font-medium">{label}</h3>
              <p className="text-xs text-[var(--muted)]">
                {envDefault
                  ? `Using environment default: ${envDefault}`
                  : "No LLM configured \u2014 chat unavailable"}
              </p>
              <button onClick={() => startEdit(scope)}
                className="px-3 py-1.5 text-xs border border-[var(--border)] rounded text-[var(--accent)] hover:border-[var(--accent)]">
                Configure
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
