"use client";

/**
 * Admin › Data tools › Duplicate projects (ROOT only). Scan (changes nothing) groups likely
 * duplicate uploads per company, cheapest evidence first: same name → same name ignoring case /
 * spaces → same text content (page count + per-page text hash, from the database) → byte-identical
 * PDF (S3 ETag + size, checked for group members only). Each group keeps one project — by default
 * the one with the most user-made annotations / takeoffs (tie → oldest); pick another with the
 * radio. Tick the copies to delete (or "Select all" per evidence level), run the dry run, type
 * DELETE. Deletion is the normal project delete; a project it refuses (labeling session, running
 * job, …) is reported and left alone.
 */

import { useMemo, useState } from "react";
import { apiErrorMessage } from "@/lib/client-persist";
import { MATCH_LABEL, MATCH_LEVELS, matchLevel, type ProjectFingerprint, type ProjectMatchLevel } from "@/lib/project-dedup";

interface Member extends ProjectFingerprint {
  status: string;
  numPages: number | null;
  companyName: string;
  owner: string | null;
  userAnnotations: number;
  takeoffItems: number;
  blocked: string | null;
  fileSize: number | null;
  fileNote: string | null;
}
interface Group { id: string; defaultKeeper: string; members: Member[] }
interface ScanResult {
  scannedProjects: number;
  truncated: boolean;
  files: { checked: number; missing: number; hashed: number; errors: number } | null;
  companies: { companyId: number; companyName: string; groups: Group[] }[];
}
interface PlanItem { publicId: string; name: string; level: ProjectMatchLevel | null; action: "delete" | "blocked" | "refused"; reason: string | null }
interface DryRun { planDigest: string; summary: { delete: number; blocked: number; refused: number }; groups: { keeper: string; items: PlanItem[] }[] }
interface DeleteResult { publicId: string; name: string; result: string; reason: string | null }

const mb = (n: number | null) => (n === null ? "—" : `${(n / 1048576).toFixed(1)} MB`);
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; data: unknown }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ok: res.ok, data: await res.json().catch(() => null) };
}

export default function DataToolsProjectDuplicates({ isRootAdmin }: { isRootAdmin: boolean }) {
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [checkFiles, setCheckFiles] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [keepers, setKeepers] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [dryRun, setDryRun] = useState<DryRun | null>(null);
  const [confirm, setConfirm] = useState("");
  const [results, setResults] = useState<DeleteResult[] | null>(null);

  const groups = useMemo(() => scan?.companies.flatMap((c) => c.groups) ?? [], [scan]);
  const keeperOf = (g: Group) => g.members.find((m) => m.publicId === (keepers[g.id] ?? g.defaultKeeper)) ?? g.members[0];
  /** Every non-keeper member with its level against the keeper of its group. */
  const candidates = groups.flatMap((g) => {
    const keeper = keeperOf(g);
    return g.members.filter((m) => m !== keeper).map((m) => ({ g, m, level: matchLevel(m, keeper) }));
  });
  const chosen = candidates.filter((c) => selected[c.m.publicId]);

  if (!isRootAdmin) return null;

  function invalidate() { setDryRun(null); setConfirm(""); }

  async function runScan() {
    setBusy(true);
    setMessage("");
    setResults(null);
    invalidate();
    const { ok, data } = await postJson("/api/admin/project-duplicates/scan", { checkFiles });
    setBusy(false);
    if (!ok) return setMessage(apiErrorMessage(data) ?? "Scan failed");
    const result = data as ScanResult;
    setScan(result);
    setKeepers({});
    setSelected({});
    const n = result.companies.reduce((k, c) => k + c.groups.length, 0);
    setMessage(`${n} group(s) of likely duplicates in ${result.scannedProjects} project(s)${result.truncated ? " (project limit reached — narrow the scope)" : ""}.`);
  }

  function selectLevel(level: ProjectMatchLevel, on: boolean) {
    invalidate();
    setSelected((cur) => {
      const next = { ...cur };
      for (const c of candidates) if (c.level === level) next[c.m.publicId] = on;
      return next;
    });
  }

  const requestGroups = () =>
    groups
      .map((g) => ({ keeper: keeperOf(g).publicId, remove: g.members.filter((m) => m !== keeperOf(g) && selected[m.publicId]).map((m) => m.publicId) }))
      .filter((g) => g.remove.length > 0);

  async function runDry() {
    setBusy(true);
    setResults(null);
    const { ok, data } = await postJson("/api/admin/project-duplicates/delete", { groups: requestGroups(), dryRun: true });
    setBusy(false);
    if (!ok) return setMessage(apiErrorMessage(data) ?? "Dry run failed");
    setDryRun(data as DryRun);
    setMessage("");
  }

  async function runDelete() {
    if (!dryRun) return;
    setBusy(true);
    const { ok, data } = await postJson("/api/admin/project-duplicates/delete", {
      groups: requestGroups(), dryRun: false, planDigest: dryRun.planDigest, confirm,
    });
    setBusy(false);
    invalidate();
    if (!ok) return setMessage(apiErrorMessage(data) ?? "Delete failed");
    const list = (data as { results: DeleteResult[] }).results;
    setResults(list);
    const deleted = list.filter((r) => r.result === "deleted").length;
    setMessage(`Deleted ${deleted} of ${list.length} project(s). Scan again to refresh.`);
  }

  const levelCounts = MATCH_LEVELS.map((level) => ({ level, all: candidates.filter((c) => c.level === level), on: chosen.filter((c) => c.level === level).length }))
    .filter((x) => x.all.length > 0);

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Duplicate projects</h2>
        <p className="text-xs text-[var(--muted)]">
          Finds projects uploaded more than once. Scan changes nothing: names and stored page text are compared in the database;
          only projects already grouped get a file check on storage (size + checksum, no download). Deleting is permanent.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={checkFiles} onChange={(e) => setCheckFiles(e.target.checked)} /> check files (byte-identical)
        </label>
        <button disabled={busy} onClick={runScan} className="px-3 py-1 rounded bg-[var(--accent)] text-white disabled:opacity-50">
          {busy ? "Working…" : "Scan all companies"}
        </button>
      </div>
      {message && <div className="text-sm text-[var(--accent)]">{message}</div>}
      {scan?.files && (
        <div className="text-xs text-[var(--muted)]">
          Files checked {scan.files.checked} · missing {scan.files.missing} · hashed {scan.files.hashed}{scan.files.errors ? ` · errors ${scan.files.errors}` : ""}
        </div>
      )}
      {levelCounts.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs border border-[var(--border)] rounded p-2">
          <span className="font-medium">Select copies (keepers are never selected):</span>
          {levelCounts.map(({ level, all, on }) => (
            <span key={level} className="inline-flex items-center gap-1 border border-[var(--border)] rounded px-1">
              {MATCH_LABEL[level]} {on}/{all.length}
              <button className="underline" onClick={() => selectLevel(level, true)}>all</button>
              <button className="underline" onClick={() => selectLevel(level, false)}>none</button>
            </span>
          ))}
          <button className="underline" onClick={() => { invalidate(); setSelected({}); }}>clear</button>
        </div>
      )}
      {scan?.companies.map((c) => (
        <div key={c.companyId} className="space-y-2">
          <div className="text-sm font-medium">{c.companyName}</div>
          {c.groups.map((g) => {
            const keeper = keeperOf(g);
            return (
              <div key={g.id} className="border border-[var(--border)] rounded p-2 overflow-x-auto">
                <table className="text-xs w-full">
                  <thead className="text-[var(--muted)] text-left">
                    <tr><th>keep</th><th>delete</th><th>project</th><th>match vs keeper</th><th>status</th><th>pages</th><th>file</th><th>uploaded</th><th>owner</th><th>annotations / takeoffs</th><th>note</th></tr>
                  </thead>
                  <tbody>
                    {g.members.map((m) => {
                      const isKeeper = m === keeper;
                      const level = isKeeper ? null : matchLevel(m, keeper);
                      return (
                        <tr key={m.publicId} className={isKeeper ? "font-medium" : ""}>
                          <td><input type="radio" name={g.id} aria-label={`Keep ${m.name}`} checked={isKeeper}
                            onChange={() => { invalidate(); setKeepers({ ...keepers, [g.id]: m.publicId }); setSelected({ ...selected, [m.publicId]: false }); }} /></td>
                          <td><input type="checkbox" aria-label={`Delete ${m.name}`} disabled={isKeeper} checked={!isKeeper && !!selected[m.publicId]}
                            onChange={(e) => { invalidate(); setSelected({ ...selected, [m.publicId]: e.target.checked }); }} /></td>
                          <td>{m.name}</td>
                          <td>{isKeeper ? "keeper" : level ? MATCH_LABEL[level] : "linked via another copy"}</td>
                          <td>{m.status}</td>
                          <td>{m.pageCount || m.numPages || 0}</td>
                          <td>{mb(m.fileSize)}</td>
                          <td>{day(m.createdAt)}</td>
                          <td>{m.owner ?? "—"}</td>
                          <td>{m.userAnnotations} / {m.takeoffItems}</td>
                          <td>{[m.blocked && `blocked: ${m.blocked}`, m.fileNote].filter(Boolean).join("; ")}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      ))}
      {chosen.length > 0 && (
        <div className="space-y-2 text-xs border border-[var(--border)] rounded p-2">
          <div className="flex items-center gap-2">
            <span>{chosen.length} project(s) selected for deletion.</span>
            <button disabled={busy} onClick={runDry} className="px-2 py-1 rounded border border-[var(--border)] disabled:opacity-50">Dry run</button>
          </div>
          {dryRun && (
            <>
              <div>
                Dry run: {dryRun.summary.delete} to delete · {dryRun.summary.blocked} blocked · {dryRun.summary.refused} refused. Nothing has changed yet.
              </div>
              <ul className="list-disc pl-5">
                {dryRun.groups.flatMap((g) => g.items).map((i) => (
                  <li key={i.publicId}>
                    {i.name}: {i.action === "delete" ? "will be deleted" : `${i.action} — ${i.reason}`}{i.level ? ` (${MATCH_LABEL[i.level]})` : ""}
                  </li>
                ))}
              </ul>
              {dryRun.summary.delete > 0 && (
                <div className="flex items-center gap-2">
                  <span>Type DELETE to permanently delete {dryRun.summary.delete} project(s):</span>
                  <input value={confirm} onChange={(e) => setConfirm(e.target.value)} className="bg-[var(--bg)] border border-[var(--border)] rounded px-1 w-24" />
                  <button disabled={confirm !== "DELETE" || busy} onClick={runDelete} className="px-2 py-1 rounded bg-red-600 text-white disabled:opacity-40">Delete</button>
                </div>
              )}
            </>
          )}
        </div>
      )}
      {results && (
        <ul className="text-xs list-disc pl-5">
          {results.map((r) => <li key={r.publicId}>{r.name}: {r.result}{r.reason ? ` — ${r.reason}` : ""}</li>)}
        </ul>
      )}
    </section>
  );
}
