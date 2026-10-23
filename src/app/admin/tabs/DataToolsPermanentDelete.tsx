"use client";

/**
 * Admin › Data tools › Duplicates › Delete hidden pages permanently (ROOT only). Rendered inside
 * DataToolsDuplicates. Pick projects (or all), Preview (a dry run that changes nothing: pages
 * that would go, pages skipped and why, annotation/chat counts, S3 objects), then type DELETE.
 * Not reversible. Page numbers stay (gaps); original.pdf keeps the pages. Pages carrying your
 * work are never deleted. Any change to the choices discards the preview.
 */

import { useEffect, useMemo, useState } from "react";
import { apiErrorMessage } from "@/lib/client-persist";

export interface DeleteProjectOption { id: string; name: string }
interface PlannedPage { page: number; canonical: number; tier: string; annotations: number; chats: number; s3Keys: string[] }
interface ProjectPlan {
  publicId: string; name: string; skippedReason?: string; pages: PlannedPage[];
  skipped: { page: number; reason: string }[]; warnings: string[]; deleted?: number; error?: string;
}
interface DeleteResult {
  dryRun: boolean; confirmPhrase: string; note: string; projects: ProjectPlan[];
  totals: { pages: number; annotations: number; chats: number; s3Keys: number; skipped: number };
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(apiErrorMessage(json) || `HTTP ${res.status}`);
  return json as T;
}

function ProjectLine({ p, dryRun }: { p: ProjectPlan; dryRun: boolean }) {
  const [open, setOpen] = useState(false);
  if (p.error) return <div className="text-red-500">{p.name}: FAILED — {p.error}</div>;
  if (p.skippedReason) return <div className="text-[var(--muted)]">{p.name}: skipped ({p.skippedReason})</div>;
  if (p.pages.length === 0 && p.skipped.length === 0 && p.warnings.length === 0) return null;
  const ann = p.pages.reduce((n, x) => n + x.annotations, 0);
  const chats = p.pages.reduce((n, x) => n + x.chats, 0);
  const keys = p.pages.reduce((n, x) => n + x.s3Keys.length, 0);
  return (
    <div>
      <button className="text-left" onClick={() => setOpen(!open)}>
        {open ? "▼" : "▶"} {p.name}: {dryRun ? "would delete" : "deleted"} {p.pages.length} page(s) · {ann} annotation(s) · {chats} chat message(s) · {keys} S3 object(s)
        {p.skipped.length > 0 ? ` · ${p.skipped.length} skipped` : ""}
      </button>
      {open && (
        <div className="pl-4 space-y-0.5">
          {p.pages.map((x) => (
            <div key={x.page}>p.{x.page} (copy of p.{x.canonical}, {x.tier}) — {x.annotations} annotation(s), {x.chats} chat, {x.s3Keys.length} object(s)</div>
          ))}
          {p.skipped.map((s) => <div key={`s${s.page}`} className="text-amber-500">p.{s.page} skipped: {s.reason}</div>)}
        </div>
      )}
      {p.warnings.map((w, i) => <div key={i} className="text-amber-500 pl-4">Warning: {w}</div>)}
    </div>
  );
}

export default function DataToolsPermanentDelete({ query, projects }: { query: string; projects: DeleteProjectOption[] }) {
  const [allProjects, setAllProjects] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<DeleteResult | null>(null);
  const [done, setDone] = useState<DeleteResult | null>(null);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  // Any change to the choices invalidates the preview: what runs must be what was previewed.
  useEffect(() => { setPreview(null); setConfirm(""); }, [query, allProjects, picked]);

  const body = useMemo(() => (allProjects ? { all: true } : { projectPublicIds: [...picked] }), [allProjects, picked]);
  const ready = allProjects || picked.size > 0;

  async function run(dryRun: boolean) {
    setBusy(true);
    setMessage("");
    try {
      const result = await post<DeleteResult>(`/api/admin/duplicates/delete-hidden${query}`, { ...body, dryRun, ...(dryRun ? {} : { confirm }) });
      if (dryRun) { setPreview(result); setDone(null); } else { setDone(result); setPreview(null); setConfirm(""); }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPicked(next);
  };
  const shown = preview ?? done;

  return (
    <div className="border border-red-900/40 rounded p-3 space-y-3 text-xs">
      <div>
        <div className="text-sm font-semibold">Delete hidden pages permanently</div>
        <p className="text-[var(--muted)]">
          Root only. Removes HIDDEN duplicates for good: the page row, its annotations and page chat, and its page image,
          thumbnail and per-page YOLO files in storage. Cannot be undone (Restore no longer applies). Page numbers stay,
          so the project keeps gaps; original.pdf still contains the pages. Pages carrying your work are never deleted.
          Hide pages first (above), then preview here.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={allProjects} onChange={(e) => setAllProjects(e.target.checked)} /> All projects in scope ({projects.length})
        </label>
        <button disabled={busy || !ready} onClick={() => run(true)} className="px-3 py-1 rounded bg-[var(--accent)] text-white disabled:opacity-50">
          {busy && !preview ? "Previewing…" : "Preview (dry run)"}
        </button>
      </div>
      {!allProjects && (
        <div className="max-h-40 overflow-y-auto border border-[var(--border)] rounded p-2 grid gap-0.5">
          {projects.map((p) => (
            <label key={p.id} className="flex items-center gap-1">
              <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} /> {p.name}
            </label>
          ))}
          {projects.length === 0 && <span className="text-[var(--muted)]">No projects in scope.</span>}
        </div>
      )}
      {message && <div className="text-sm text-red-500">{message}</div>}
      {shown && (
        <div className="space-y-1">
          <div className="font-medium">
            {shown.dryRun ? "Would delete" : "Deleted"} {shown.totals.pages} page(s) · {shown.totals.annotations} annotation(s) · {shown.totals.chats} chat message(s)
            {" "}· {shown.totals.s3Keys} S3 object(s) across {shown.projects.length} project(s); {shown.totals.skipped} page(s) skipped{shown.dryRun ? "" : " — done"}.
          </div>
          <div className="text-[var(--muted)]">{shown.note}</div>
          <div className="max-h-64 overflow-y-auto space-y-0.5">
            {shown.projects.map((p) => <ProjectLine key={p.publicId} p={p} dryRun={shown.dryRun} />)}
          </div>
        </div>
      )}
      {preview && preview.totals.pages > 0 && (
        <div className="flex items-center gap-2">
          <span>Type {preview.confirmPhrase} to confirm:</span>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} className="bg-[var(--bg)] border border-[var(--border)] rounded px-1 w-24" />
          <button disabled={busy || confirm !== preview.confirmPhrase} onClick={() => run(false)} className="px-2 py-1 rounded bg-red-600 text-white disabled:opacity-40">
            {busy ? "Deleting…" : `Delete ${preview.totals.pages} page(s) permanently`}
          </button>
        </div>
      )}
    </div>
  );
}
