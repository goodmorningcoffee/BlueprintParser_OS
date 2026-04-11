"use client";

/**
 * TableParseTab — Phase I.2.d
 *
 * Admin debug surface for the table-parse pipeline. Three cards:
 *
 * 1. Container Health: dropdown of canned diagnostic commands. Replaces ECS
 *    exec for routine container checks ("is TATR model present?", "does the
 *    Python ML stack import?").
 *
 * 2. Recent Parses: last 50 table-parse requests from the in-memory ring
 *    buffer (src/lib/parse-history.ts). Each entry expands to show the full
 *    request, all per-method results with subprocess stderr + intermediate
 *    state, infraStages timing, mergerNotes filtering decisions.
 *
 * 3. Persistent Debug Toggle: backed by appSettings.tableParse.debugMode.
 *    When ON, every parse returns full methodResults regardless of the
 *    client's debugMode flag — replaces the localStorage workaround.
 */

import { useState, useEffect, useCallback } from "react";

// ─── Types ──────────────────────────────────────────────────

interface CheckDef {
  id: string;
  description: string;
}

interface CheckResult {
  check: string;
  description: string;
  command: string;
  durationMs: number;
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface MethodDebug {
  durationMs?: number;
  stderr?: string;
  exitCode?: number;
  pythonMode?: string;
  intermediate?: Record<string, unknown>;
}

interface MethodResult {
  method: string;
  headers: string[];
  rows: Record<string, string>[];
  confidence: number;
  tagColumn?: string;
  colBoundaries?: number[];
  rowBoundaries?: number[];
  error?: string;
  debug?: MethodDebug;
}

interface InfraStage {
  stage: string;
  durationMs: number;
  sizeBytes?: number;
  dimensions?: { width: number; height: number };
  error?: string;
}

interface MergerNotes {
  baseMethod: string;
  filteredMethods: Array<{ method: string; reason: string; detail?: string }>;
  agreementRate: number;
  methodBonus: number;
  totalCells: number;
}

interface ParseHistoryEntry {
  id: string;
  timestamp: string;
  request: {
    projectId: number;
    pageNumber: number;
    regionBbox: [number, number, number, number];
    debugMode: boolean;
    options: Record<string, unknown>;
  };
  response: {
    status: number;
    durationMs: number;
    headers: string[];
    rowCount: number;
    confidence: number;
    tagColumn?: string;
    methods: Array<{ name: string; confidence: number; gridShape: [number, number]; error?: string }>;
    methodResults: MethodResult[];
    infraStages: InfraStage[];
    infraErrors: Array<{ stage: string; error: string }>;
    mergerNotes?: MergerNotes;
  };
}

// ─── Main component ─────────────────────────────────────────

export default function TableParseTab() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1">Table Parsing Debug</h2>
        <p className="text-sm text-[var(--muted)]">
          Live diagnostics for the auto-parse pipeline. Use these tools to verify the parser
          stack is healthy and to inspect what each method returned for recent parses.
        </p>
      </div>

      <ContainerHealthCard />
      <RecentParsesCard />
      <DebugToggleCard />
    </div>
  );
}

// ─── Card 1: Container Health ───────────────────────────────

function ContainerHealthCard() {
  const [checks, setChecks] = useState<CheckDef[]>([]);
  const [selectedCheck, setSelectedCheck] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the list of available checks on mount
  useEffect(() => {
    fetch("/api/admin/parser-health")
      .then((r) => r.json())
      .then((data) => {
        setChecks(data.checks || []);
        if (data.checks?.length > 0) setSelectedCheck(data.checks[0].id);
      })
      .catch(() => setError("Failed to load check list"));
  }, []);

  async function runCheck() {
    if (!selectedCheck) return;
    setRunning(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch("/api/admin/parser-health", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ check: selectedCheck }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as CheckResult;
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Check failed");
    } finally {
      setRunning(false);
    }
  }

  const selectedCheckDef = checks.find((c) => c.id === selectedCheck);

  return (
    <div className="border border-[var(--border)] rounded-lg p-5 bg-[var(--surface)]">
      <h3 className="font-semibold mb-1">Container Health</h3>
      <p className="text-xs text-[var(--muted)] mb-4">
        Run a whitelisted diagnostic command inside the running container. Replaces ECS exec
        for routine checks. Whitelist lives in <code className="text-[var(--accent)]">src/app/api/admin/parser-health/route.ts</code>.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={selectedCheck}
          onChange={(e) => setSelectedCheck(e.target.value)}
          disabled={running || checks.length === 0}
          className="flex-1 min-w-[280px] px-3 py-2 text-sm bg-[var(--bg)] border border-[var(--border)] rounded outline-none focus:border-[var(--accent)]"
        >
          {checks.length === 0 && <option>Loading...</option>}
          {checks.map((c) => (
            <option key={c.id} value={c.id}>
              {c.id} — {c.description.slice(0, 80)}
            </option>
          ))}
        </select>
        <button
          onClick={runCheck}
          disabled={running || !selectedCheck}
          className="px-4 py-2 text-sm font-medium rounded bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40"
        >
          {running ? "Running..." : "Run Check"}
        </button>
      </div>

      {selectedCheckDef && (
        <p className="text-[11px] text-[var(--muted)] mt-2 italic">{selectedCheckDef.description}</p>
      )}

      {error && (
        <div className="mt-3 px-3 py-2 text-sm text-red-300 border border-red-500/30 rounded bg-red-500/10">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-4 space-y-2">
          <div className="flex items-center gap-3 text-xs">
            <span className={`px-2 py-1 rounded font-mono ${result.exitCode === 0 ? "bg-green-500/20 text-green-300" : "bg-red-500/20 text-red-300"}`}>
              exit {result.exitCode}
            </span>
            <span className="text-[var(--muted)]">{result.durationMs}ms</span>
            <span className="text-[var(--muted)] font-mono truncate flex-1">$ {result.command}</span>
          </div>
          {result.stdout && (
            <div>
              <div className="text-[10px] text-[var(--muted)] uppercase tracking-wide mb-1">stdout</div>
              <pre className="text-[11px] font-mono bg-[var(--bg)] border border-[var(--border)] rounded p-3 overflow-x-auto whitespace-pre-wrap break-words max-h-96 overflow-y-auto">
                {result.stdout}
              </pre>
            </div>
          )}
          {result.stderr && (
            <div>
              <div className="text-[10px] text-[var(--muted)] uppercase tracking-wide mb-1">stderr</div>
              <pre className="text-[11px] font-mono bg-amber-500/5 border border-amber-500/20 rounded p-3 overflow-x-auto whitespace-pre-wrap break-words max-h-96 overflow-y-auto text-amber-200">
                {result.stderr}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Card 2: Recent Parses ──────────────────────────────────

function RecentParsesCard() {
  const [entries, setEntries] = useState<ParseHistoryEntry[]>([]);
  const [maxEntries, setMaxEntries] = useState(50);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/recent-parses");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setEntries(data.entries || []);
      setMaxEntries(data.maxEntries || 50);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  async function clearAll() {
    if (!confirm("Clear all recent parse history?")) return;
    try {
      await fetch("/api/admin/recent-parses", { method: "DELETE" });
      setEntries([]);
      setExpandedId(null);
    } catch {
      setError("Failed to clear");
    }
  }

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="border border-[var(--border)] rounded-lg p-5 bg-[var(--surface)]">
      <div className="flex items-center justify-between mb-1">
        <h3 className="font-semibold">Recent Parses</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--muted)]">{entries.length} / {maxEntries}</span>
          <button
            onClick={refresh}
            disabled={loading}
            className="px-3 py-1 text-xs rounded border border-[var(--border)] hover:bg-[var(--surface-hover)] disabled:opacity-40"
          >
            {loading ? "Loading..." : "Refresh"}
          </button>
          <button
            onClick={clearAll}
            disabled={entries.length === 0}
            className="px-3 py-1 text-xs rounded border border-red-500/30 text-red-300 hover:bg-red-500/10 disabled:opacity-40"
          >
            Clear
          </button>
        </div>
      </div>
      <p className="text-xs text-[var(--muted)] mb-4">
        Last {maxEntries} table-parse requests served by THIS task. In-memory ring buffer — lost on container restart.
        Multi-replica ECS: each task has its own buffer.
      </p>

      {error && (
        <div className="mb-3 px-3 py-2 text-sm text-red-300 border border-red-500/30 rounded bg-red-500/10">
          {error}
        </div>
      )}

      {entries.length === 0 && !loading && (
        <div className="text-sm text-[var(--muted)] italic py-4 text-center">
          No parses recorded yet. Run an auto-parse from the viewer to populate this list.
        </div>
      )}

      <div className="space-y-1">
        {entries.map((entry) => (
          <ParseHistoryRow
            key={entry.id}
            entry={entry}
            expanded={expandedId === entry.id}
            onToggle={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ParseHistoryRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: ParseHistoryEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const isEmpty = entry.response.headers.length === 0 || entry.response.rowCount === 0;
  const hasInfraErrors = entry.response.infraErrors.length > 0;

  return (
    <div className="border border-[var(--border)] rounded">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-[var(--surface-hover)] text-left"
      >
        <span className={`inline-block transition-transform text-[10px] ${expanded ? "rotate-90" : ""}`}>▶</span>
        <span className="text-[var(--muted)] font-mono">{time}</span>
        <span className="font-mono">proj={entry.request.projectId}</span>
        <span className="font-mono">p{entry.request.pageNumber}</span>
        <span className={`font-mono px-1.5 py-0.5 rounded text-[10px] ${
          hasInfraErrors ? "bg-red-500/20 text-red-300" :
          isEmpty ? "bg-amber-500/20 text-amber-300" :
          "bg-green-500/20 text-green-300"
        }`}>
          {entry.response.confidence.toFixed(2)} · {entry.response.rowCount}r×{entry.response.headers.length}c
        </span>
        <span className="text-[var(--muted)] ml-auto">{entry.response.durationMs}ms</span>
      </button>

      {expanded && <ParseHistoryDetail entry={entry} />}
    </div>
  );
}

function ParseHistoryDetail({ entry }: { entry: ParseHistoryEntry }) {
  const [remerge, setRemerge] = useState<{
    baseMethod?: string;
    headers: string[];
    rowCount: number;
    confidence: number;
    filteredMethods: Array<{ method: string; reason: string; detail?: string }>;
    agreementRate: number;
  } | null>(null);
  const [remergeLoading, setRemergeLoading] = useState(false);
  const [remergeError, setRemergeError] = useState<string | null>(null);

  const runRemerge = useCallback(async () => {
    if (!entry.response.methodResults?.length) return;
    setRemergeLoading(true);
    setRemergeError(null);
    setRemerge(null);
    try {
      const resp = await fetch("/api/admin/remerge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ results: entry.response.methodResults }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      const merged = await resp.json();
      setRemerge({
        baseMethod: merged.mergerNotes?.baseMethod,
        headers: merged.headers || [],
        rowCount: (merged.rows || []).length,
        confidence: merged.confidence || 0,
        filteredMethods: merged.mergerNotes?.filteredMethods || [],
        agreementRate: merged.mergerNotes?.agreementRate || 0,
      });
    } catch (e) {
      setRemergeError(e instanceof Error ? e.message : "Re-merge failed");
    } finally {
      setRemergeLoading(false);
    }
  }, [entry.response.methodResults]);

  return (
    <div className="border-t border-[var(--border)] p-4 space-y-4 text-xs bg-[var(--bg)]">
      {/* Request */}
      <div>
        <div className="text-[10px] uppercase tracking-wide text-[var(--muted)] mb-1">Request</div>
        <div className="font-mono space-y-0.5">
          <div>projectId: <span className="text-[var(--accent)]">{entry.request.projectId}</span></div>
          <div>pageNumber: <span className="text-[var(--accent)]">{entry.request.pageNumber}</span></div>
          <div>regionBbox: [{entry.request.regionBbox.map((n) => n.toFixed(3)).join(", ")}]</div>
          <div>debugMode (request): {String(entry.request.debugMode)}</div>
        </div>
      </div>

      {/* Infra errors */}
      {entry.response.infraErrors.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-red-300 mb-1">
            Pipeline Errors ({entry.response.infraErrors.length})
          </div>
          <div className="space-y-1">
            {entry.response.infraErrors.map((e, i) => (
              <div key={i} className="font-mono px-2 py-1 bg-red-500/10 border border-red-500/30 rounded">
                <span className="text-red-300">{e.stage}:</span> {e.error}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Infra stages */}
      {entry.response.infraStages.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-[var(--muted)] mb-1">Infrastructure Stages</div>
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="text-left text-[var(--muted)]">
                <th className="py-0.5 pr-3">stage</th>
                <th className="py-0.5 pr-3">duration</th>
                <th className="py-0.5 pr-3">size</th>
                <th className="py-0.5 pr-3">dimensions</th>
                <th className="py-0.5">error</th>
              </tr>
            </thead>
            <tbody>
              {entry.response.infraStages.map((s, i) => (
                <tr key={i} className={s.error ? "text-red-300" : ""}>
                  <td className="py-0.5 pr-3">{s.stage}</td>
                  <td className="py-0.5 pr-3">{s.durationMs}ms</td>
                  <td className="py-0.5 pr-3">{s.sizeBytes != null ? `${(s.sizeBytes / 1024).toFixed(1)} KB` : "—"}</td>
                  <td className="py-0.5 pr-3">{s.dimensions ? `${s.dimensions.width}×${s.dimensions.height}` : "—"}</td>
                  <td className="py-0.5 truncate">{s.error || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Per-method results */}
      <div>
        <div className="text-[10px] uppercase tracking-wide text-[var(--muted)] mb-1">
          Methods ({entry.response.methodResults.length})
        </div>
        <div className="space-y-2">
          {entry.response.methodResults.map((mr, i) => (
            <MethodResultDetail key={`${mr.method}-${i}`} result={mr} />
          ))}
        </div>
      </div>

      {/* Merger notes */}
      {entry.response.mergerNotes && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-[var(--muted)] mb-1">Merger Notes</div>
          <div className="font-mono space-y-0.5">
            <div>baseMethod: <span className="text-[var(--accent)]">{entry.response.mergerNotes.baseMethod}</span></div>
            <div>agreementRate: {(entry.response.mergerNotes.agreementRate * 100).toFixed(1)}%</div>
            <div>methodBonus: +{(entry.response.mergerNotes.methodBonus * 100).toFixed(1)}%</div>
            <div>totalCells: {entry.response.mergerNotes.totalCells}</div>
          </div>
          {entry.response.mergerNotes.filteredMethods.length > 0 && (
            <div className="mt-2">
              <div className="text-[10px] text-[var(--muted)] mb-1">filteredMethods:</div>
              <ul className="space-y-0.5 ml-3">
                {entry.response.mergerNotes.filteredMethods.map((f, i) => (
                  <li key={i} className="font-mono">
                    <span className="text-amber-300">{f.method}</span> — {f.reason}
                    {f.detail && <span className="text-[var(--muted)]"> ({f.detail})</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Final merged grid */}
      {entry.response.headers.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-[var(--muted)] mb-1">
            Merged Grid ({entry.response.rowCount}r × {entry.response.headers.length}c, conf {(entry.response.confidence * 100).toFixed(0)}%)
          </div>
          <div className="font-mono text-[10px] truncate">
            headers: [{entry.response.headers.map((h) => `"${h}"`).join(", ")}]
          </div>
        </div>
      )}

      {/* Re-merge with current heuristics */}
      <div className="pt-2 border-t border-[var(--border)]/50">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">
            Re-merge (current heuristics)
          </div>
          <button
            onClick={runRemerge}
            disabled={remergeLoading || !entry.response.methodResults?.length}
            className="text-[10px] px-2 py-1 rounded border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-40"
            title="Re-run mergeGrids() on stored methodResults without re-parsing — lets you iterate on merger code against historical data"
          >
            {remergeLoading ? "Running…" : "Re-merge now"}
          </button>
        </div>
        {remergeError && (
          <div className="text-[11px] text-red-300 px-2 py-1 bg-red-500/10 border border-red-500/30 rounded">
            {remergeError}
          </div>
        )}
        {remerge && (
          <div className="font-mono space-y-0.5 px-2 py-1.5 bg-cyan-500/5 border border-cyan-500/20 rounded text-[11px]">
            <div>
              baseMethod: <span className="text-cyan-300">{remerge.baseMethod || "—"}</span>
              {entry.response.mergerNotes?.baseMethod && entry.response.mergerNotes.baseMethod !== remerge.baseMethod && (
                <span className="text-amber-300 ml-2">(was: {entry.response.mergerNotes.baseMethod})</span>
              )}
            </div>
            <div>
              shape: {remerge.rowCount}r × {remerge.headers.length}c (conf {(remerge.confidence * 100).toFixed(0)}%)
              {entry.response.rowCount !== remerge.rowCount || entry.response.headers.length !== remerge.headers.length ? (
                <span className="text-amber-300 ml-2">
                  (was: {entry.response.rowCount}r × {entry.response.headers.length}c)
                </span>
              ) : null}
            </div>
            <div>agreementRate: {(remerge.agreementRate * 100).toFixed(1)}%</div>
            {remerge.filteredMethods.length > 0 && (
              <div className="mt-1">
                <div className="text-[var(--muted)]">filteredMethods:</div>
                <ul className="space-y-0.5 ml-3">
                  {remerge.filteredMethods.map((f, i) => (
                    <li key={i}>
                      <span className="text-amber-300">{f.method}</span> — {f.reason}
                      {f.detail && <span className="text-[var(--muted)]"> ({f.detail})</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="text-[10px] text-[var(--muted)] mt-1">
              headers: [{remerge.headers.map((h) => `"${h}"`).join(", ")}]
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MethodResultDetail({ result }: { result: MethodResult }) {
  const [open, setOpen] = useState(false);
  const hasData = result.headers.length > 0 && result.rows.length > 0;
  const dur = result.debug?.durationMs;
  const isSubprocess = result.debug?.exitCode !== undefined;

  return (
    <div className="border border-[var(--border)]/40 rounded">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-[11px] hover:bg-[var(--surface-hover)] text-left"
      >
        <span className={`inline-block transition-transform text-[9px] ${open ? "rotate-90" : ""}`}>▶</span>
        <span className="font-mono font-semibold">{result.method}</span>
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
          result.confidence > 0.5 ? "bg-green-500/20 text-green-300" :
          result.confidence > 0 ? "bg-yellow-500/20 text-yellow-300" :
          result.error ? "bg-red-500/20 text-red-300" :
          "bg-[var(--border)] text-[var(--muted)]"
        }`}>
          {(result.confidence * 100).toFixed(0)}%
        </span>
        <span className="text-[var(--muted)] font-mono text-[10px]">
          {hasData ? `${result.rows.length}r×${result.headers.length}c` : result.error ? "error" : "no data"}
        </span>
        {dur != null && <span className="text-[var(--muted)] font-mono text-[10px]">{dur}ms</span>}
        {result.debug?.pythonMode && (
          <span className="text-[var(--muted)] font-mono text-[10px] italic">{result.debug.pythonMode}</span>
        )}
      </button>

      {open && (
        <div className="border-t border-[var(--border)]/40 p-2 space-y-2 bg-[var(--bg)]">
          {result.error && (
            <div className="text-[11px] text-red-300 px-2 py-1 bg-red-500/10 border border-red-500/30 rounded">
              <span className="font-semibold">error:</span> {result.error}
            </div>
          )}

          {result.debug?.intermediate && Object.keys(result.debug.intermediate).length > 0 && (
            <div>
              <div className="text-[9px] uppercase tracking-wide text-[var(--muted)] mb-1">Intermediate state</div>
              <div className="font-mono text-[10px] space-y-0.5 ml-2">
                {Object.entries(result.debug.intermediate).map(([k, v]) => (
                  <div key={k}>
                    <span className="text-[var(--muted)]">{k}:</span>{" "}
                    <span>{typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {isSubprocess && (
            <div className="font-mono text-[10px]">
              <span className="text-[var(--muted)]">subprocess:</span>{" "}
              exit {result.debug?.exitCode}
              {result.debug?.pythonMode && <> · mode: {result.debug.pythonMode}</>}
            </div>
          )}

          {result.debug?.stderr && (
            <details>
              <summary className="text-[9px] uppercase tracking-wide text-[var(--muted)] cursor-pointer hover:text-[var(--fg)]">
                Subprocess stderr ({result.debug.stderr.length} chars)
              </summary>
              <pre className="mt-1 text-[10px] font-mono bg-amber-500/5 border border-amber-500/20 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words max-h-64 overflow-y-auto text-amber-200">
                {result.debug.stderr}
              </pre>
            </details>
          )}

          {hasData && (
            <details>
              <summary className="text-[9px] uppercase tracking-wide text-[var(--muted)] cursor-pointer hover:text-[var(--fg)]">
                Grid preview (first 10 rows)
              </summary>
              <div className="mt-1 overflow-x-auto max-h-64 overflow-y-auto border border-[var(--border)]/30 rounded">
                <table className="text-[10px] font-mono border-collapse w-full">
                  <thead className="sticky top-0 bg-[var(--surface)]">
                    <tr>
                      {result.headers.map((h, i) => (
                        <th key={i} className="border border-[var(--border)]/30 px-1 py-0.5 text-left whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.slice(0, 10).map((row, ri) => (
                      <tr key={ri}>
                        {result.headers.map((h, ci) => (
                          <td key={ci} className="border border-[var(--border)]/20 px-1 py-0.5 align-top">
                            <div className="max-w-[140px] truncate" title={(row[h] || "").replace(/\n/g, " · ")}>
                              {((row[h] || "").substring(0, 60)).replace(/\n/g, " ")}
                            </div>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {result.rows.length > 10 && (
                <div className="text-[9px] text-[var(--muted)] mt-1">
                  Showing first 10 of {result.rows.length} rows
                </div>
              )}
            </details>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Card 3: Persistent Debug Toggle ───────────────────────

function DebugToggleCard() {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/app-settings")
      .then((r) => r.json())
      .then((data) => {
        const setting = (data["tableParse.debugMode"] as { enabled?: boolean } | undefined);
        setEnabled(!!setting?.enabled);
      })
      .catch(() => setError("Failed to load setting"))
      .finally(() => setLoading(false));
  }, []);

  async function toggle() {
    setSaving(true);
    setError(null);
    const newValue = !enabled;
    try {
      const res = await fetch("/api/admin/app-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "tableParse.debugMode", value: { enabled: newValue } }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      setEnabled(newValue);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border border-[var(--border)] rounded-lg p-5 bg-[var(--surface)]">
      <h3 className="font-semibold mb-1">Persistent Debug Mode</h3>
      <p className="text-xs text-[var(--muted)] mb-4">
        When ON, every <code className="text-[var(--accent)]">/api/table-parse</code> request returns the full per-method
        debug data regardless of what the client sent. Affects all users globally — turn OFF in production.
        Stored in <code className="text-[var(--accent)]">appSettings.tableParse.debugMode</code>.
      </p>

      {loading ? (
        <div className="text-sm text-[var(--muted)]">Loading...</div>
      ) : (
        <div className="flex items-center gap-3">
          <button
            onClick={toggle}
            disabled={saving}
            className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors disabled:opacity-50 ${
              enabled ? "bg-[var(--accent)]" : "bg-[var(--border)]"
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                enabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
          <span className="text-sm">{enabled ? "ON" : "OFF"}</span>
          {saving && <span className="text-xs text-[var(--muted)]">Saving...</span>}
        </div>
      )}

      {error && (
        <div className="mt-3 px-3 py-2 text-sm text-red-300 border border-red-500/30 rounded bg-red-500/10">
          {error}
        </div>
      )}

      <div className="mt-4 text-[11px] text-[var(--muted)] space-y-1">
        <div>
          <strong>Per-browser fallback:</strong> developers can flip debug mode on for just their browser by running{" "}
          <code className="text-[var(--accent)]">localStorage.setItem("bp2_debug_table_parse", "1")</code> in DevTools.
          Either path (this toggle OR localStorage) enables full per-method results.
        </div>
        <div>
          <strong>Note:</strong> the in-memory ring buffer always captures full results regardless of this toggle —
          you can debug recent parses retrospectively even without enabling this.
        </div>
      </div>
    </div>
  );
}
