"use client";

import { useEffect, useMemo, useState } from "react";

interface CompanyOption {
  publicId: string;
  name: string;
}

/** Build the download URL for GET /api/admin/data-export from the panel's choices. */
export function dataExportHref(opts: {
  companyId: string;
  projects: string;
  status: "completed" | "any";
  wordBoxes: boolean;
  intelligence: boolean;
  skipDuplicates: boolean;
  includeDemo: boolean;
  presign: boolean;
}): string {
  const qs = new URLSearchParams();
  if (opts.companyId) qs.set("companyId", opts.companyId);
  const ids = opts.projects
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length) qs.set("projects", ids.join(","));
  if (opts.status !== "completed") qs.set("status", opts.status);
  const omit = [opts.wordBoxes ? "" : "textract", opts.intelligence ? "" : "intelligence"].filter(Boolean);
  if (omit.length) qs.set("omit", omit.join(","));
  if (!opts.skipDuplicates) qs.set("skipDuplicates", "0");
  if (opts.includeDemo) qs.set("includeDemo", "1");
  if (opts.presign) qs.set("presign", "1");
  const s = qs.toString();
  return `/api/admin/data-export${s ? `?${s}` : ""}`;
}

/**
 * Data tools › Export. A plain <a download> link: the browser streams the .ndjson.gz to disk with
 * the session cookie, so nothing is buffered in the page.
 */
export default function DataToolsExport({ isRootAdmin }: { isRootAdmin: boolean }) {
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [companyId, setCompanyId] = useState("");
  const [projects, setProjects] = useState("");
  const [status, setStatus] = useState<"completed" | "any">("completed");
  const [wordBoxes, setWordBoxes] = useState(true);
  const [intelligence, setIntelligence] = useState(true);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [includeDemo, setIncludeDemo] = useState(false);
  const [presign, setPresign] = useState(false);

  useEffect(() => {
    if (!isRootAdmin) return;
    let cancelled = false;
    fetch("/api/admin/companies")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { companies?: CompanyOption[] } | null) => {
        if (!cancelled && data?.companies) {
          setCompanies(data.companies.map((c) => ({ publicId: c.publicId, name: c.name })));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isRootAdmin]);

  const href = useMemo(
    () =>
      dataExportHref({
        companyId,
        projects,
        status,
        wordBoxes,
        intelligence,
        skipDuplicates,
        includeDemo,
        presign: isRootAdmin && presign,
      }),
    [companyId, projects, status, wordBoxes, intelligence, skipDuplicates, includeDemo, presign, isRootAdmin],
  );

  const box = (label: string, checked: boolean, set: (v: boolean) => void, hint?: string) => (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => set(e.target.checked)} />
      <span>
        {label}
        {hint ? <span className="block text-xs text-[var(--muted)]">{hint}</span> : null}
      </span>
    </label>
  );

  return (
    <section className="space-y-4 border border-[var(--border)] rounded p-4">
      <div>
        <h3 className="text-base font-semibold">Export</h3>
        <p className="text-xs text-[var(--muted)]">
          One <code>.ndjson.gz</code> file (format <code>bp-dataset/1</code>): projects, pages with OCR text, CSI codes
          and page intelligence, every annotation labelled machine / human / assisted / unknown, takeoffs, QTO
          workflows, annotation groups, and links to each page image and the original PDF. One export per admin type runs at a time.
          Chat, user emails and project addresses are never included.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {isRootAdmin ? (
          <label className="text-sm space-y-1">
            <span className="block">Company</span>
            <select
              className="w-full bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1"
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
            >
              <option value="">All companies</option>
              {companies.map((c) => (
                <option key={c.publicId} value={c.publicId}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="text-sm">Company: your own company</p>
        )}
        <label className="text-sm space-y-1">
          <span className="block">Projects (optional ids, comma separated; empty = all)</span>
          <input
            className="w-full bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 font-mono text-xs"
            value={projects}
            onChange={(e) => setProjects(e.target.value)}
            placeholder="all projects"
          />
        </label>
        <label className="text-sm space-y-1">
          <span className="block">Project status</span>
          <select
            className="w-full bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1"
            value={status}
            onChange={(e) => setStatus(e.target.value === "any" ? "any" : "completed")}
          >
            <option value="completed">Completed only</option>
            <option value="any">Any status</option>
          </select>
        </label>
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        {box("OCR word boxes", wordBoxes, setWordBoxes, "The largest field; untick for a much smaller file.")}
        {box("Page and project intelligence", intelligence, setIntelligence)}
        {box("Skip hidden duplicate pages", skipDuplicates, setSkipDuplicates, "Also skips their annotations.")}
        {box("Include demo projects", includeDemo, setIncludeDemo)}
        {isRootAdmin
          ? box("Presigned download links (1 hour)", presign, setPresign, "For command-line use; root only.")
          : null}
      </div>

      <a
        href={href}
        download
        className="inline-block px-4 py-2 text-sm rounded bg-[var(--accent)] text-white hover:opacity-90"
      >
        Download
      </a>
    </section>
  );
}
