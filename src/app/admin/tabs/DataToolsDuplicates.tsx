"use client";

/**
 * Admin › Data tools › Duplicates. Scan (changes nothing) → review blocks and pairs with
 * thumbnails side by side → hide. Hiding is reversible (Restore) and page numbers never
 * change. Only Exact goes in bulk; a repeat set or likely revision set is removed one block
 * at a time, keeping the latest copy by default (their texts differ). A project showing any
 * revision evidence (bulkHold) takes no bulk at all: every block, exact ones too, one at a time.
 */

import { useCallback, useEffect, useState } from "react";
import { apiErrorMessage } from "@/lib/client-persist";
import { defaultKeep } from "@/lib/page-dedup/detect";
import type { DuplicateBlock, DuplicateCounts, DuplicateKeep, DuplicatePair } from "@/lib/page-dedup/types";

interface ProjectOption { id: string; name: string; status: string; isDemo: boolean; companyId?: number; companyName?: string }
type ReportPair = DuplicatePair & { diff?: { op: "-" | "+"; text: string }[] };
interface ProjectReport {
  project: { publicId: string; name: string; companyId: number; numPages: number | null };
  reportDigest: string;
  counts: DuplicateCounts;
  blocks: DuplicateBlock[];
  bulkHold: string | null;
  pairs: ReportPair[];
  hidden: { page: number; canonical: number; tier: string }[];
  thumbnailBase: string;
}
interface CrossPair { a: string; b: string; shared: number; bPages: number; aPages: number; copy: boolean }
interface ScanState {
  reports: ProjectReport[];
  skipped: { name: string; reason: string }[];
  cross: CrossPair[];
  dupRows: { total: number; projects: { publicId: string; name: string; rows: number }[] } | null;
  done: boolean;
}

const EMPTY: ScanState = { reports: [], skipped: [], cross: [], dupRows: null, done: false };
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pad4 = (n: number) => String(n).padStart(4, "0");

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; data: unknown }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, data };
}

function Thumb({ base, page, label }: { base: string; page: number; label: string }) {
  return (
    <figure className="w-40 shrink-0">
      <div className="aspect-[4/3] bg-[var(--bg)] rounded overflow-hidden border border-[var(--border)] flex items-center justify-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`${base}/page_${pad4(page)}.png`} alt={`Page ${page}`} className="w-full h-full object-contain" loading="lazy" />
      </div>
      <figcaption className="text-[10px] text-[var(--muted)] mt-0.5">{label} p.{page}</figcaption>
    </figure>
  );
}

function PairRow({ pair, base }: { pair: ReportPair; base: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-[var(--border)] py-2">
      <button className="text-xs text-left w-full" onClick={() => setOpen(!open)}>
        p.{pair.page} ↔ p.{pair.canonical} · {pair.tier} · content {pct(pair.content)} · full {pct(pair.full)}
        {pair.sameNumber ? " · same sheet number" : ""}{pair.identical ? " · identical text" : ""}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <div className="flex gap-3">
            <Thumb base={base} page={pair.canonical} label="keep" />
            <Thumb base={base} page={pair.page} label="duplicate" />
          </div>
          {pair.diff && pair.diff.length > 0 && (
            <pre className="text-[10px] bg-[var(--bg)] p-2 rounded max-h-48 overflow-auto whitespace-pre-wrap">
              {pair.diff.map((d, i) => (
                <div key={i} className={d.op === "-" ? "text-red-400" : "text-green-400"}>{d.op} {d.text}</div>
              ))}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function ProjectPanel({ report, query, onChanged }: { report: ProjectReport; query: string; onChanged: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [keep, setKeep] = useState<Record<string, DuplicateKeep>>({});
  const [busy, setBusy] = useState(false);
  const { counts, project } = report;
  const exactCount = report.pairs.filter((p) => p.tier === "exact").length;

  async function act(body: Record<string, unknown>, url = "/api/admin/duplicates/apply") {
    setBusy(true);
    const { ok, data } = await postJson(`${url}${query}`, { projectPublicId: project.publicId, ...body });
    setBusy(false);
    if (!ok) return onChanged(`${project.name}: ${apiErrorMessage(data) ?? "failed"}`);
    const r = data as { hidden?: unknown[]; skipped?: { reason: string }[]; restored?: number[] };
    if (r.restored) return onChanged(`${project.name}: restored ${r.restored.length} page(s)`);
    const reasons = [...new Set((r.skipped ?? []).map((s) => s.reason))].join(", ");
    onChanged(`${project.name}: hid ${r.hidden?.length ?? 0} page(s)${r.skipped?.length ? `; skipped ${r.skipped.length} (${reasons})` : ""}`);
  }

  return (
    <div className="border border-[var(--border)] rounded p-3">
      <div className="flex items-center gap-3 text-sm">
        <button className="font-medium text-left flex-1" onClick={() => setOpen(!open)}>{open ? "▼" : "▶"} {project.name}</button>
        <span className="text-xs text-[var(--muted)]">
          {counts.pages} pages · exact {counts.exact} · repeat {counts.run} · near {counts.near} · possible {counts.possible} · hidden {report.hidden.length}
        </span>
        {exactCount > 0 && report.bulkHold && (
          <span className="text-xs text-[var(--muted)]">No bulk: project {report.bulkHold}</span>
        )}
        {exactCount > 0 && !report.bulkHold && (
          <button disabled={busy} className="text-xs px-2 py-1 rounded bg-[var(--accent)] text-white disabled:opacity-50"
            onClick={() => act({ reportDigest: report.reportDigest, tiers: ["exact"] })}>Remove {exactCount} exact</button>
        )}
        {report.hidden.length > 0 && (
          <button disabled={busy} className="text-xs px-2 py-1 rounded border border-[var(--border)] disabled:opacity-50"
            onClick={() => act({}, "/api/admin/duplicates/restore")}>Restore {report.hidden.length}</button>
        )}
      </div>
      {open && (
        <div className="mt-3 space-y-3">
          {report.blocks.map((b) => {
            const choice = keep[b.id] ?? defaultKeep(b.tier);
            return (
              <div key={b.id} className="bg-[var(--surface)] rounded p-2">
                <div className="flex items-center gap-2 text-xs">
                  <span className="flex-1">
                    Pages {b.start + b.offset}–{b.start + b.offset + b.length - 1} repeat pages {b.start}–{b.start + b.length - 1}
                    {" "}· {b.tier} · {b.label} · min full {pct(b.minFull)}
                  </span>
                  {(b.tier !== "exact" || report.bulkHold) && (
                    <>
                      <select value={choice} onChange={(e) => setKeep({ ...keep, [b.id]: e.target.value as DuplicateKeep })}
                        className="text-xs bg-[var(--bg)] border border-[var(--border)] rounded px-1">
                        <option value="latest">keep latest copy</option>
                        <option value="earliest">keep first copy</option>
                      </select>
                      <button disabled={busy} className="text-xs px-2 py-1 rounded border border-[var(--border)] disabled:opacity-50"
                        onClick={() => act({ reportDigest: report.reportDigest, blocks: [b.id], keep: choice })}>Remove block</button>
                    </>
                  )}
                </div>
                {report.pairs.filter((p) => p.blockId === b.id).map((p) => <PairRow key={p.page} pair={p} base={report.thumbnailBase} />)}
              </div>
            );
          })}
          {report.pairs.some((p) => p.blockId === null) && (
            <div className="bg-[var(--surface)] rounded p-2">
              <div className="text-xs">Pairs outside blocks (exact is removable in bulk; near and possible are review only)</div>
              {report.pairs.filter((p) => p.blockId === null).map((p) => <PairRow key={p.page} pair={p} base={report.thumbnailBase} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function DataToolsDuplicates({ isRootAdmin }: { isRootAdmin: boolean }) {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [target, setTarget] = useState("all");
  const [companyId, setCompanyId] = useState("");
  const [scan, setScan] = useState<ScanState>(EMPTY);
  const [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState("");

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: ProjectOption[]) => setProjects(Array.isArray(rows) ? rows : []))
      .catch(() => setProjects([]));
  }, []);

  const query = isRootAdmin && companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
  const companies = isRootAdmin
    ? [...new Map(projects.filter((p) => p.companyId).map((p) => [p.companyId, p.companyName ?? String(p.companyId)])).entries()]
    : [];
  const visibleProjects = projects.filter((p) => !p.isDemo && (!companyId || String(p.companyId) === companyId));

  const runScan = useCallback(async () => {
    setScanning(true);
    setMessage("");
    setScan(EMPTY);
    const body = target === "all" ? { all: true } : { projectPublicIds: [target] };
    try {
      const res = await fetch(`/api/admin/duplicates/scan${query}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        setMessage(apiErrorMessage(await res.json().catch(() => null)) ?? "Scan failed");
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const next: ScanState = { reports: [], skipped: [], cross: [], dupRows: null, done: false };
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = done ? "" : (lines.pop() ?? "");
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as { t: string } & Record<string, unknown>;
          if (msg.t === "project") next.reports.push(msg as unknown as ProjectReport);
          else if (msg.t === "skipped" || msg.t === "error") {
            const p = msg.project as { name?: string } | undefined;
            next.skipped.push({ name: p?.name ?? "scan", reason: String(msg.reason ?? msg.message ?? "") });
          } else if (msg.t === "crossProject") next.cross.push(...(msg.pairs as CrossPair[]));
          else if (msg.t === "duplicatePageRows") next.dupRows = msg as unknown as NonNullable<ScanState["dupRows"]>;
          else if (msg.t === "done") next.done = true;
        }
        setScan({ ...next, reports: [...next.reports] });
        if (done) break;
      }
    } catch {
      setMessage("Scan failed");
    } finally {
      setScanning(false);
    }
  }, [query, target]);

  const withExact = scan.reports.filter((r) => !r.bulkHold && r.pairs.some((p) => p.tier === "exact"));
  async function removeAllExact() {
    const digests = Object.fromEntries(withExact.map((r) => [r.project.publicId, r.reportDigest]));
    const { ok, data } = await postJson(`/api/admin/duplicates/apply${query}`, { all: true, tiers: ["exact"], digests });
    setConfirm("");
    if (!ok) return setMessage(apiErrorMessage(data) ?? "Remove failed");
    const results = (data as { results: { hidden?: unknown[]; skipped?: unknown }[] }).results;
    const hid = results.reduce((n, r) => n + (Array.isArray(r.hidden) ? r.hidden.length : 0), 0);
    const skippedProjects = results.filter((r) => typeof r.skipped === "string").length;
    setMessage(`Hid ${hid} exact duplicate page(s) in ${results.length - skippedProjects} project(s)${skippedProjects ? `; ${skippedProjects} project(s) skipped (changed since scan or busy) — scan again` : ""}`);
  }
  const nameOf = (publicId: string) => scan.reports.find((r) => r.project.publicId === publicId)?.project.name ?? publicId;

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Duplicate pages</h2>
        <p className="text-xs text-[var(--muted)]">
          Scan changes nothing. Remove hides a page from the page list, search, chat and AI tools; page numbers stay and Restore undoes it.
          Hiding saves no storage, YOLO or page charges.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {isRootAdmin && (
          <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1">
            <option value="">All companies</option>
            {companies.map(([id, name]) => <option key={id} value={String(id)}>{name}</option>)}
          </select>
        )}
        <select value={target} onChange={(e) => setTarget(e.target.value)} className="bg-[var(--bg)] border border-[var(--border)] rounded px-2 py-1">
          <option value="all">All projects</option>
          {visibleProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button disabled={scanning} onClick={runScan} className="px-3 py-1 rounded bg-[var(--accent)] text-white disabled:opacity-50">
          {scanning ? "Scanning…" : "Scan"}
        </button>
      </div>
      {message && <div className="text-sm text-[var(--accent)]">{message}</div>}
      {withExact.length > 1 && scan.done && (
        <div className="flex items-center gap-2 text-xs">
          <span>Remove all exact duplicates in {withExact.length} projects — type REMOVE:</span>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} className="bg-[var(--bg)] border border-[var(--border)] rounded px-1 w-24" />
          <button disabled={confirm !== "REMOVE"} onClick={removeAllExact} className="px-2 py-1 rounded bg-red-600 text-white disabled:opacity-40">Remove all exact</button>
        </div>
      )}
      <div className="space-y-2">
        {scan.reports.map((r) => (
          <ProjectPanel key={r.project.publicId} report={r} query={query} onChanged={setMessage} />
        ))}
      </div>
      {scan.cross.length > 0 && (
        <div className="text-xs space-y-1">
          <div className="font-medium">Cross-project copies (report only)</div>
          {scan.cross.map((c) => (
            <div key={`${c.a}:${c.b}`}>
              {nameOf(c.b)} shares {c.shared} of its {c.bPages} pages with {nameOf(c.a)}{c.copy ? " — page-for-page copy" : ""}
            </div>
          ))}
        </div>
      )}
      {scan.dupRows && (
        <div className="text-xs">
          {scan.dupRows.total} duplicate page rows {target === "all" ? "company-wide" : "in this project"} (same page number stored twice; read-only)
          {target === "all" && scan.dupRows.projects.length > 0 && `: ${scan.dupRows.projects.map((p) => `${p.name} ${p.rows}`).join("; ")}`}
        </div>
      )}
      {scan.skipped.length > 0 && (
        <div className="text-xs text-[var(--muted)]">
          Not scanned: {scan.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}
        </div>
      )}
      {scan.done && scan.reports.length === 0 && <div className="text-xs text-[var(--muted)]">No completed projects in scope.</div>}
    </section>
  );
}
