"use client";

import { useCallback, useEffect, useState } from "react";
import { apiErrorMessage } from "@/lib/client-persist"; // [refactor jul8 S058 PR-E1] envelope unwrap

interface CompanyUsage {
  id: number;
  name: string;
  sagemakerLimit: number;
  sagemakerUsed: number;
  textractLimit: number;
  textractUsed: number;
  resetInterval: string;
  windowStart: string | null;
}

interface UserUsage {
  id: number;
  username: string;
  email: string;
  companyId: number;
  sagemakerLimit: number | null;
  sagemakerUsed: number;
  windowStart: string | null;
}

interface ModelItem {
  id: number;
  name: string;
  type: string;
}

interface Grant {
  id: number;
  modelId: number;
  companyId: number;
  userId: number | null;
  enabled: boolean;
  companyName: string;
  username: string | null;
}

function UsageBar({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const color = pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 rounded bg-[var(--border)] overflow-hidden min-w-[70px]">
        <div className={`h-2 ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-[var(--muted)] tabular-nums whitespace-nowrap">
        {used.toLocaleString()} / {limit.toLocaleString()}
      </span>
    </div>
  );
}

export default function UsageTab() {
  const [companies, setCompanies] = useState<CompanyUsage[]>([]);
  const [users, setUsers] = useState<UserUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [companyEdits, setCompanyEdits] = useState<Record<number, string>>({});
  const [userEdits, setUserEdits] = useState<Record<number, string>>({});
  // YOLO model-access grants
  const [models, setModels] = useState<ModelItem[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [grantCompany, setGrantCompany] = useState("");
  const [grantUser, setGrantUser] = useState("");

  const loadData = useCallback(async () => {
    try {
      const [usageRes, maRes] = await Promise.all([
        fetch("/api/admin/usage"),
        fetch("/api/admin/model-access"),
      ]);
      if (usageRes.ok) {
        const data = await usageRes.json();
        setCompanies(data.companies);
        setUsers(data.users);
      } else {
        const err = await usageRes.json().catch(() => ({}));
        setMessage(apiErrorMessage(err) || "Failed to load usage");
      }
      if (maRes.ok) {
        const ma = await maRes.json();
        setModels(ma.models);
        setGrants(ma.grants);
      }
    } catch {
      setMessage("Failed to load usage");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const flash = (msg: string) => {
    setMessage(msg);
    setTimeout(() => setMessage(""), 3000);
  };

  const mutate = useCallback(
    async (payload: Record<string, unknown>, ok: string) => {
      setBusy(true);
      try {
        const res = await fetch("/api/admin/usage", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          flash(ok);
          await loadData();
        } else {
          const err = await res.json().catch(() => ({}));
          flash(apiErrorMessage(err) || "Failed");
        }
      } catch {
        flash("Failed");
      }
      setBusy(false);
    },
    [loadData]
  );

  // Effective selection defaults to the first model (computed, no state-in-effect).
  const effectiveModelId = selectedModelId || (models[0] ? String(models[0].id) : "");

  const grantModel = async () => {
    if (!effectiveModelId || !grantCompany) {
      flash("Pick a model and a company");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/admin/model-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelId: Number(effectiveModelId),
          companyId: Number(grantCompany),
          userId: grantUser ? Number(grantUser) : null,
        }),
      });
      if (res.ok) {
        flash("Access granted");
        await loadData();
      } else {
        const err = await res.json().catch(() => ({}));
        flash(apiErrorMessage(err) || "Failed");
      }
    } catch {
      flash("Failed");
    }
    setBusy(false);
  };

  const revokeGrant = async (g: Grant) => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/model-access", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId: g.modelId, companyId: g.companyId, userId: g.userId }),
      });
      if (res.ok) {
        flash("Access revoked");
        await loadData();
      } else {
        const err = await res.json().catch(() => ({}));
        flash(apiErrorMessage(err) || "Failed");
      }
    } catch {
      flash("Failed");
    }
    setBusy(false);
  };

  if (loading) {
    return <div className="text-sm text-[var(--muted)]">Loading usage…</div>;
  }

  return (
    <div className="space-y-8">
      {message && <div className="text-xs text-[var(--accent)]">{message}</div>}

      {/* ── Per-company ─────────────────────────────────────── */}
      <section>
        <h3 className="text-sm font-semibold mb-1">Company SageMaker usage</h3>
        <p className="text-xs text-[var(--muted)] mb-3">
          One YOLO run charges a project&apos;s full page count. SageMaker (GPU) is the
          real cost gate; Textract is cheap and tracked for visibility. &ldquo;Reset
          counter&rdquo; advances the window so usage returns to 0.
        </p>
        <div className="border border-[var(--border)] rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-[var(--muted)]">
                <th className="px-3 py-2">Company</th>
                <th className="px-3 py-2 w-[26%]">SageMaker (pages)</th>
                <th className="px-3 py-2 w-[22%]">Textract (pages)</th>
                <th className="px-3 py-2">Set SM limit</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-3 py-2 font-medium">{c.name}</td>
                  <td className="px-3 py-2">
                    <UsageBar used={c.sagemakerUsed} limit={c.sagemakerLimit} />
                  </td>
                  <td className="px-3 py-2">
                    <UsageBar used={c.textractUsed} limit={c.textractLimit} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min={0}
                        value={companyEdits[c.id] ?? String(c.sagemakerLimit)}
                        onChange={(e) =>
                          setCompanyEdits((p) => ({ ...p, [c.id]: e.target.value }))
                        }
                        className="w-20 px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded"
                      />
                      <button
                        disabled={busy}
                        onClick={() =>
                          mutate(
                            {
                              target: "company",
                              id: c.id,
                              action: "setSagemakerLimit",
                              value: Number(companyEdits[c.id] ?? c.sagemakerLimit),
                            },
                            "Limit updated"
                          )
                        }
                        className="px-2 py-1 text-xs rounded bg-[var(--accent)] text-white disabled:opacity-40"
                      >
                        Save
                      </button>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      disabled={busy}
                      onClick={() =>
                        mutate({ target: "company", id: c.id, action: "reset" }, "Counter reset")
                      }
                      className="px-2 py-1 text-xs rounded border border-[var(--border)] hover:bg-[var(--bg)] disabled:opacity-40"
                    >
                      Reset counter
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Per-user sub-caps ───────────────────────────────── */}
      <section>
        <h3 className="text-sm font-semibold mb-1">Per-user SageMaker sub-caps</h3>
        <p className="text-xs text-[var(--muted)] mb-3">
          Optional. Blank = no personal cap (governed only by the company pool). A run
          is blocked on whichever cap — company or user — is hit first.
        </p>
        <div className="border border-[var(--border)] rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-[var(--muted)]">
                <th className="px-3 py-2">User</th>
                <th className="px-3 py-2 w-[30%]">SageMaker (pages)</th>
                <th className="px-3 py-2">Sub-cap (blank = none)</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-3 py-2">
                    <div className="font-medium">{u.username}</div>
                    <div className="text-xs text-[var(--muted)]">{u.email}</div>
                  </td>
                  <td className="px-3 py-2">
                    {u.sagemakerLimit !== null ? (
                      <UsageBar used={u.sagemakerUsed} limit={u.sagemakerLimit} />
                    ) : (
                      <span className="text-xs text-[var(--muted)]">
                        {u.sagemakerUsed.toLocaleString()} pages (company pool)
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      min={0}
                      placeholder="none"
                      value={
                        userEdits[u.id] ??
                        (u.sagemakerLimit === null ? "" : String(u.sagemakerLimit))
                      }
                      onChange={(e) =>
                        setUserEdits((p) => ({ ...p, [u.id]: e.target.value }))
                      }
                      className="w-24 px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded"
                    />
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button
                      disabled={busy}
                      onClick={() => {
                        const raw = userEdits[u.id];
                        const value =
                          raw === undefined
                            ? u.sagemakerLimit
                            : raw.trim() === ""
                            ? null
                            : Number(raw);
                        mutate(
                          { target: "user", id: u.id, action: "setSagemakerLimit", value },
                          "Sub-cap updated"
                        );
                      }}
                      className="px-2 py-1 text-xs rounded bg-[var(--accent)] text-white disabled:opacity-40 mr-1"
                    >
                      Save
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        mutate({ target: "user", id: u.id, action: "reset" }, "Counter reset")
                      }
                      className="px-2 py-1 text-xs rounded border border-[var(--border)] hover:bg-[var(--bg)] disabled:opacity-40"
                    >
                      Reset
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── YOLO model access ─────────────────────────────────── */}
      <section>
        <h3 className="text-sm font-semibold mb-1">YOLO model access</h3>
        <p className="text-xs text-[var(--muted)] mb-3">
          Grant a model you uploaded to a whole company or a specific user. Granted models
          appear in that admin&apos;s AI Models tab and can be run — subject to the page limits above.
        </p>
        {models.length === 0 ? (
          <p className="text-xs text-[var(--muted)]">No models uploaded yet.</p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-1">
              <select
                value={effectiveModelId}
                onChange={(e) => setSelectedModelId(e.target.value)}
                className="px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded"
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
              <span className="text-xs text-[var(--muted)]">&rarr;</span>
              <select
                value={grantCompany}
                onChange={(e) => {
                  setGrantCompany(e.target.value);
                  setGrantUser("");
                }}
                className="px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded"
              >
                <option value="">Select company…</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <select
                value={grantUser}
                onChange={(e) => setGrantUser(e.target.value)}
                disabled={!grantCompany}
                className="px-2 py-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded disabled:opacity-40"
              >
                <option value="">Whole company</option>
                {users
                  .filter((u) => String(u.companyId) === grantCompany)
                  .map((u) => (
                    <option key={u.id} value={u.id}>{u.username}</option>
                  ))}
              </select>
              <button
                disabled={busy || !effectiveModelId || !grantCompany}
                onClick={grantModel}
                className="px-2 py-1 text-xs rounded bg-[var(--accent)] text-white disabled:opacity-40"
              >
                Grant
              </button>
            </div>

            <div className="border border-[var(--border)] rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-left text-[var(--muted)]">
                    <th className="px-3 py-2">Company</th>
                    <th className="px-3 py-2">Scope</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {grants.filter((g) => String(g.modelId) === effectiveModelId).length === 0 ? (
                    <tr>
                      <td className="px-3 py-2 text-xs text-[var(--muted)]" colSpan={3}>
                        Not shared with anyone yet.
                      </td>
                    </tr>
                  ) : (
                    grants
                      .filter((g) => String(g.modelId) === effectiveModelId)
                      .map((g) => (
                        <tr key={g.id} className="border-b border-[var(--border)] last:border-0">
                          <td className="px-3 py-2">{g.companyName}</td>
                          <td className="px-3 py-2 text-[var(--muted)]">
                            {g.username ? `User: ${g.username}` : "Whole company"}
                            {!g.enabled && <span className="ml-1 text-amber-400">(disabled)</span>}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <button
                              disabled={busy}
                              onClick={() => revokeGrant(g)}
                              className="px-2 py-1 text-xs rounded border border-[var(--border)] hover:bg-[var(--bg)] disabled:opacity-40"
                            >
                              Revoke
                            </button>
                          </td>
                        </tr>
                      ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
