"use client";

import { useCallback, useEffect, useState } from "react";

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

  const loadData = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/usage");
      if (res.ok) {
        const data = await res.json();
        setCompanies(data.companies);
        setUsers(data.users);
      } else {
        const err = await res.json().catch(() => ({}));
        setMessage(err.error || "Failed to load usage");
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
          flash(err.error || "Failed");
        }
      } catch {
        flash("Failed");
      }
      setBusy(false);
    },
    [loadData]
  );

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
    </div>
  );
}
