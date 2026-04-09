"use client";

import { useState, useEffect, useCallback } from "react";

interface Company { id: number; name: string; userCount?: number; projectCount?: number; }
interface User { id: string; dbId?: number; username: string; email: string; role: string; companyId: number; companyName?: string; canRunModels: boolean; isRootAdmin: boolean; }
interface Model { id: number; name: string; companyId?: number; companyName?: string; }
interface LlmConfig { id: number; userId: number | null; provider: string; model: string; isDemo: boolean; }
interface ModelAccessRow { companyId: number; companyName: string; enabled: boolean; }

const LLM_OPTIONS = [
  { provider: "groq", model: "llama-3.3-70b-versatile", label: "Groq / Llama 3.3" },
  { provider: "anthropic", model: "claude-haiku-4-5-20251001", label: "Claude Haiku" },
  { provider: "anthropic", model: "claude-sonnet-4-6", label: "Claude Sonnet" },
  { provider: "openai", model: "gpt-4o-mini", label: "GPT-4o Mini" },
  { provider: "openai", model: "gpt-4o", label: "GPT-4o" },
];

export default function AiRbacTab() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [llmConfigs, setLlmConfigs] = useState<LlmConfig[]>([]);
  const [modelAccess, setModelAccess] = useState<Record<number, ModelAccessRow[]>>({});
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [compRes, userRes, modelRes] = await Promise.all([
      fetch("/api/admin/companies"),
      fetch("/api/admin/users"),
      fetch("/api/admin/models"),
    ]);
    if (compRes.ok) {
      const data = await compRes.json();
      setCompanies(data.companies || data);
    }
    if (userRes.ok) setUsers(await userRes.json());
    if (modelRes.ok) setModels(await modelRes.json());
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Load LLM configs for a company when expanded
  async function loadCompanyLlmConfigs(companyId: number) {
    const res = await fetch(`/api/admin/llm-config?includeUsers=true&companyId=${companyId}`);
    if (res.ok) {
      const data = await res.json();
      setLlmConfigs((prev) => [...prev.filter((c) => !users.some((u) => u.companyId === companyId && u.dbId === c.userId)), ...(data.configs || [])]);
    }
  }

  // Load model access for all models (once)
  async function loadAllModelAccess() {
    const toFetch = models.filter((m) => !modelAccess[m.id]);
    const results = await Promise.all(
      toFetch.map(async (m) => {
        const res = await fetch(`/api/admin/models?action=access&modelId=${m.id}`);
        return { id: m.id, rows: res.ok ? await res.json() : [] };
      })
    );
    setModelAccess((prev) => {
      const next = { ...prev };
      for (const r of results) next[r.id] = r.rows;
      return next;
    });
  }

  function toggleExpand(companyId: number) {
    const next = !expanded[companyId];
    setExpanded((prev) => ({ ...prev, [companyId]: next }));
    if (next) loadCompanyLlmConfigs(companyId);
  }

  async function updateUser(userId: string, updates: Record<string, unknown>) {
    const res = await fetch("/api/admin/users", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: userId, ...updates }),
    });
    if (res.ok) {
      setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, ...updates } as User : u));
    }
  }

  async function setUserLlm(dbUserId: number, companyId: number, provider: string, model: string) {
    await fetch("/api/admin/llm-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, model, userId: dbUserId, targetCompanyId: companyId, isDemo: false }),
    });
    // Refresh configs
    loadCompanyLlmConfigs(companyId);
  }

  async function clearUserLlm(configId: number, companyId: number) {
    await fetch("/api/admin/llm-config", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: configId }),
    });
    setLlmConfigs((prev) => prev.filter((c) => c.id !== configId));
  }

  async function toggleModelCompanyAccess(modelId: number, companyId: number, enabled: boolean) {
    const res = await fetch("/api/admin/models", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId, companyId, enabled }),
    });
    if (res.ok) {
      setModelAccess((prev) => {
        const rows = prev[modelId] || [];
        const idx = rows.findIndex((r) => r.companyId === companyId);
        if (idx >= 0) {
          const updated = [...rows];
          updated[idx] = { ...updated[idx], enabled };
          return { ...prev, [modelId]: updated };
        }
        const company = companies.find((c) => c.id === companyId);
        return { ...prev, [modelId]: [...rows, { companyId, companyName: company?.name || "", enabled }] };
      });
    }
  }

  if (loading) return <div className="text-[var(--muted)] text-sm py-8 text-center">Loading...</div>;

  return (
    <div className="space-y-8">
      {/* ─── Section 1: Companies + Users ─── */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Companies &amp; User Access</h2>
        <div className="space-y-2">
          {companies.map((company) => {
            const companyUsers = users.filter((u) => u.companyId === company.id);
            const isExpanded = expanded[company.id];

            return (
              <div key={company.id} className="border border-[var(--border)] rounded bg-[var(--surface)]">
                {/* Company header row */}
                <button
                  onClick={() => toggleExpand(company.id)}
                  className="w-full flex items-center justify-between p-3 text-left hover:bg-[var(--surface-hover)] transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-[10px] text-[var(--muted)]">{isExpanded ? "▼" : "▶"}</span>
                    <span className="font-medium">{company.name}</span>
                    <span className="text-xs text-[var(--muted)]">{companyUsers.length} users</span>
                  </div>
                  <div className="flex items-center gap-3 text-[10px]">
                    <span className="text-[var(--muted)]">
                      Models: {models.filter((m) => m.companyId === company.id).length} owned
                      {models.some(m => m.companyId !== company.id &&
                        (modelAccess[m.id] || []).some(a => a.companyId === company.id && a.enabled)) &&
                        ` + shared`
                      }
                    </span>
                  </div>
                </button>

                {/* Expanded: user table */}
                {isExpanded && (
                  <div className="border-t border-[var(--border)] p-3">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-[var(--muted)] text-[10px] uppercase tracking-wide">
                          <th className="text-left py-1 font-medium">User</th>
                          <th className="text-left py-1 font-medium">Role</th>
                          <th className="text-center py-1 font-medium">YOLO</th>
                          <th className="text-left py-1 font-medium">LLM Override</th>
                          <th className="text-right py-1 font-medium">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {companyUsers.map((user) => {
                          const userLlm = llmConfigs.find((c) => c.userId === user.dbId && !c.isDemo);
                          return (
                            <tr key={user.id} className="border-t border-[var(--border)]/30">
                              <td className="py-2">
                                <div className="font-medium">{user.username}</div>
                                <div className="text-[10px] text-[var(--muted)]">{user.email}</div>
                              </td>
                              <td className="py-2">
                                <select
                                  value={user.role}
                                  onChange={(e) => updateUser(user.id, { role: e.target.value })}
                                  className="bg-[var(--bg)] border border-[var(--border)] rounded px-1.5 py-0.5 text-[11px]"
                                >
                                  <option value="member">Member</option>
                                  <option value="admin">Admin</option>
                                </select>
                              </td>
                              <td className="py-2 text-center">
                                <button
                                  onClick={() => updateUser(user.id, { canRunModels: !user.canRunModels })}
                                  className={`text-[10px] px-2 py-0.5 rounded border ${
                                    user.canRunModels
                                      ? "border-green-400/30 text-green-300 bg-green-500/10"
                                      : "border-[var(--border)] text-[var(--muted)]"
                                  }`}
                                >
                                  {user.canRunModels ? "Yes" : "No"}
                                </button>
                              </td>
                              <td className="py-2">
                                {userLlm ? (
                                  <div className="flex items-center gap-1">
                                    <span className="text-[var(--accent)] text-[10px]">
                                      {LLM_OPTIONS.find((o) => o.provider === userLlm.provider && o.model === userLlm.model)?.label || `${userLlm.provider}/${userLlm.model}`}
                                    </span>
                                    <button
                                      onClick={() => clearUserLlm(userLlm.id, company.id)}
                                      className="text-[10px] text-[var(--muted)] hover:text-red-400"
                                    >
                                      ×
                                    </button>
                                  </div>
                                ) : (
                                  <span className="text-[10px] text-[var(--muted)]">Company default</span>
                                )}
                              </td>
                              <td className="py-2 text-right">
                                <select
                                  value=""
                                  onChange={(e) => {
                                    if (!e.target.value || !user.dbId) return;
                                    const opt = LLM_OPTIONS.find((o) => o.label === e.target.value);
                                    if (opt) setUserLlm(user.dbId, company.id, opt.provider, opt.model);
                                  }}
                                  className="bg-[var(--bg)] border border-[var(--border)] rounded px-1 py-0.5 text-[10px] text-[var(--muted)]"
                                >
                                  <option value="">Set LLM...</option>
                                  {LLM_OPTIONS.map((o) => (
                                    <option key={o.label} value={o.label}>{o.label}</option>
                                  ))}
                                </select>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* ─── Section 2: Model Access Matrix ─── */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Model Access Matrix</h2>
        <button
          onClick={loadAllModelAccess}
          className="text-xs px-3 py-1.5 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--accent)]/40 mb-3"
        >
          Load Access Data
        </button>
        {Object.keys(modelAccess).length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs border border-[var(--border)]">
              <thead>
                <tr className="bg-[var(--surface)]">
                  <th className="text-left p-2 border-b border-[var(--border)] font-medium">Model</th>
                  <th className="text-left p-2 border-b border-[var(--border)] font-medium text-[10px] text-[var(--muted)]">Owner</th>
                  {companies.map((c) => (
                    <th key={c.id} className="text-center p-2 border-b border-[var(--border)] font-medium text-[10px]">
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {models.map((m) => {
                  const access = modelAccess[m.id] || [];
                  return (
                    <tr key={m.id} className="border-b border-[var(--border)]/30">
                      <td className="p-2 font-medium">{m.name}</td>
                      <td className="p-2 text-[10px] text-[var(--muted)]">{m.companyName || "—"}</td>
                      {companies.map((c) => {
                        const isOwner = m.companyId === c.id;
                        const row = access.find((a) => a.companyId === c.id);
                        const hasAccess = isOwner || row?.enabled;
                        return (
                          <td key={c.id} className="p-2 text-center">
                            {isOwner ? (
                              <span className="text-green-400 text-[10px]">owner</span>
                            ) : (
                              <button
                                onClick={() => toggleModelCompanyAccess(m.id, c.id, !hasAccess)}
                                className={`text-[10px] px-2 py-0.5 rounded border ${
                                  hasAccess
                                    ? "border-green-400/30 text-green-300 bg-green-500/10"
                                    : "border-[var(--border)] text-[var(--muted)] hover:border-cyan-400/30"
                                }`}
                              >
                                {hasAccess ? "✓" : "—"}
                              </button>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
