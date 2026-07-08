"use client";

import { useCallback, useEffect, useMemo, useState, Fragment } from "react";
import type { LogsRange } from "./LogsTab";
import { apiErrorMessage } from "@/lib/client-persist"; // [refactor jul8 S058 PR-E1] envelope unwrap

interface ToolHit {
  tool: string;
  hits: number;
}

interface AccountRow {
  userId: number;
  email: string | null;
  name: string | null;
  role: string | null;
  companyId: number | null;
  companyName: string | null;
  totalActions: number;
  uniqueTools: number;
  topTools: ToolHit[];
  firstSeen: string;
  lastSeen: string;
}

interface AccountsResponse {
  range: LogsRange;
  accounts: AccountRow[];
}

type SortKey = "user" | "company" | "totalActions" | "uniqueTools" | "lastSeen";
type SortDir = "asc" | "desc";

function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 24 * 3600_000) return `${Math.round(ms / 3600_000)}h ago`;
  return `${Math.round(ms / (24 * 3600_000))}d ago`;
}

function label(a: AccountRow): string {
  return a.email || a.name || `user #${a.userId}`;
}

export default function LogsAccounts({ range }: { range: LogsRange }) {
  const [data, setData] = useState<AccountsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("totalActions");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "user" || key === "company" ? "asc" : "desc");
    }
  };

  const toggleExpand = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const sorted = useMemo(() => {
    if (!data) return [];
    const rows = [...data.accounts];
    const dir = sortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      let av: string | number;
      let bv: string | number;
      switch (sortKey) {
        case "user": av = label(a).toLowerCase(); bv = label(b).toLowerCase(); break;
        case "company": av = (a.companyName || "").toLowerCase(); bv = (b.companyName || "").toLowerCase(); break;
        case "totalActions": av = a.totalActions; bv = b.totalActions; break;
        case "uniqueTools": av = a.uniqueTools; bv = b.uniqueTools; break;
        case "lastSeen": av = new Date(a.lastSeen).getTime(); bv = new Date(b.lastSeen).getTime(); break;
      }
      if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * dir;
      return ((av as number) - (bv as number)) * dir;
    });
    return rows;
  }, [data, sortKey, sortDir]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/logs/accounts?range=${range}`);
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(apiErrorMessage(e) || `HTTP ${res.status}`);
      }
      setData((await res.json()) as AccountsResponse);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load accounts");
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const downloadCsv = () => {
    if (!data) return;
    const header = "user,email,company,role,totalActions,uniqueTools,topTools,firstSeen,lastSeen\n";
    const rows = data.accounts.map((a) =>
      [
        label(a),
        a.email || "",
        a.companyName || "",
        a.role || "",
        a.totalActions,
        a.uniqueTools,
        JSON.stringify(a.topTools.map((t) => `${t.tool}:${t.hits}`).join("; ")),
        a.firstSeen,
        a.lastSeen,
      ].join(","),
    );
    const blob = new Blob([header + rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `bp-accounts-${range}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const arrow = (col: SortKey) => (sortKey === col ? (sortDir === "asc" ? " ▲" : " ▼") : "");

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-[var(--fg)]">Accounts ({data?.accounts.length ?? 0})</h3>
          <p className="text-xs text-[var(--muted)]">
            Tool usage by signed-in users. Click a row for the full per-tool breakdown. Anonymous traffic lives in the
            Visitors tab.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastRefresh && (
            <span className="text-[10px] text-[var(--muted)]">
              Refreshed {Math.round((Date.now() - lastRefresh.getTime()) / 1000)}s ago
            </span>
          )}
          <button
            onClick={downloadCsv}
            disabled={!data}
            className="text-xs px-3 py-1 rounded border border-[var(--border)] hover:border-[var(--accent)] disabled:opacity-50"
          >
            Download CSV
          </button>
          <button
            onClick={fetchData}
            disabled={loading}
            className="text-xs px-3 py-1 rounded border border-[var(--border)] hover:border-[var(--accent)] disabled:opacity-50"
          >
            {loading ? "Loading…" : "🔄 Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded bg-red-500/10 border border-red-500/30 text-xs text-red-400">{error}</div>
      )}

      {!error && data && (
        <div className="rounded border border-[var(--border)] overflow-auto max-h-[70vh]">
          <table className="w-full text-xs">
            <thead className="bg-[var(--surface-2)]/50 text-[var(--muted)] sticky top-0">
              <tr>
                <th className="px-2 py-2 text-left">
                  <button onClick={() => toggleSort("user")} className="hover:text-[var(--fg)]">User{arrow("user")}</button>
                </th>
                <th className="px-2 py-2 text-left">
                  <button onClick={() => toggleSort("company")} className="hover:text-[var(--fg)]">Company{arrow("company")}</button>
                </th>
                <th className="px-2 py-2 text-left">Role</th>
                <th className="px-2 py-2 text-right">
                  <button onClick={() => toggleSort("totalActions")} className="hover:text-[var(--fg)]">Actions{arrow("totalActions")}</button>
                </th>
                <th className="px-2 py-2 text-right">
                  <button onClick={() => toggleSort("uniqueTools")} className="hover:text-[var(--fg)]">Tools{arrow("uniqueTools")}</button>
                </th>
                <th className="px-2 py-2 text-left">Top tools</th>
                <th className="px-2 py-2 text-left">
                  <button onClick={() => toggleSort("lastSeen")} className="hover:text-[var(--fg)]">Last seen{arrow("lastSeen")}</button>
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-2 py-8 text-center text-[var(--muted)] italic">
                    No signed-in tool usage in this window yet.
                  </td>
                </tr>
              )}
              {sorted.map((a) => (
                <Fragment key={a.userId}>
                  <tr
                    className="border-t border-[var(--border)] hover:bg-[var(--surface-2)]/30 cursor-pointer"
                    onClick={() => toggleExpand(a.userId)}
                  >
                    <td className="px-2 py-1.5">
                      <span className="text-[var(--muted)] mr-1">{expanded.has(a.userId) ? "▾" : "▸"}</span>
                      {label(a)}
                    </td>
                    <td className="px-2 py-1.5">{a.companyName || "—"}</td>
                    <td className="px-2 py-1.5">{a.role || "—"}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{a.totalActions}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{a.uniqueTools}</td>
                    <td className="px-2 py-1.5 text-[var(--muted)] truncate max-w-xs">
                      {a.topTools.slice(0, 3).map((t) => `${t.tool} ×${t.hits}`).join(", ")}
                      {a.topTools.length > 3 ? "…" : ""}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap text-[var(--muted)]" title={a.lastSeen}>
                      {fmtRelative(a.lastSeen)}
                    </td>
                  </tr>
                  {expanded.has(a.userId) && (
                    <tr className="bg-[var(--surface-2)]/20">
                      <td colSpan={7} className="px-6 py-2">
                        {a.topTools.length === 0 ? (
                          <span className="text-[11px] text-[var(--muted)] italic">No mapped tool actions.</span>
                        ) : (
                          <div className="flex flex-wrap gap-x-5 gap-y-1">
                            {a.topTools.map((t) => (
                              <span key={t.tool} className="text-[11px]">
                                <span className="text-[var(--fg)]">{t.tool}</span>
                                <span className="text-[var(--muted)]"> ×{t.hits}</span>
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
