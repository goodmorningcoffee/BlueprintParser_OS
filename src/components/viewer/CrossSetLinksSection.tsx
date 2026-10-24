"use client";

// [cross-set F3 2026-10-24] "Same sheet in other sets" — the Page Intelligence panel's cross-set section
// (its own component: PageIntelligencePanel is near its ceiling). Each row is the same sheet in ANOTHER
// project of the company: a twin (identical text) or a revision (same sheet number, matching content).
// Clicking opens that project's viewer at that page — cross-project navigation is a plain link
// (/project/{publicId}?page=N, read by the viewer route), never the in-project page command.
// Nothing renders for a project with no pass yet; the server already dropped links the caller may not see.

import Link from "next/link";
import { usePageCrossSetLinks, type CrossSetViewerLink } from "@/queries/useCrossSetLinks";

export function crossSetViewerHref(publicId: string, page: number): string {
  return `/project/${encodeURIComponent(publicId)}?page=${page}`;
}

const KIND_LABEL: Record<CrossSetViewerLink["kind"], string> = { twin_of: "identical", revision_of: "revision" };

export default function CrossSetLinksSection({ pageNumber, expanded, onToggle }: { pageNumber: number; expanded: boolean; onToggle: () => void }) {
  const { built, links, projects } = usePageCrossSetLinks(pageNumber);
  if (!built) return null;
  return (
    <div className="border border-[var(--border)] rounded">
      <button type="button" onClick={onToggle} className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-[var(--surface-hover)]">
        <span className="text-[10px] text-[var(--muted)] w-3">{expanded ? "▼" : "▶"}</span>
        <span className="text-[11px] font-medium text-[var(--fg)]">Same sheet in other sets ({links.length})</span>
      </button>
      {expanded && (
        <div className="px-2 pb-2 space-y-0.5">
          {links.length === 0 && <p className="text-[10px] text-[var(--muted)] italic">No other set of your company carries this sheet.</p>}
          {links.map((l, i) => (
            <div key={i} className="text-[11px] flex items-center gap-1 flex-wrap">
              <Link
                href={crossSetViewerHref(l.project.publicId, l.page)}
                className="text-[var(--accent)] hover:underline"
                title={`${l.project.name} — page ${l.page}${l.sheet ? ` (${l.sheet})` : ""}`}
              >
                {l.project.name} <span className="text-[var(--muted)]">p.{l.page}{l.sheet ? ` ${l.sheet}` : ""}</span>
              </Link>
              <span className={`text-[9px] px-1 rounded ${l.kind === "twin_of" ? "bg-emerald-500/10 text-emerald-300" : "bg-sky-500/10 text-sky-300"}`}>
                {KIND_LABEL[l.kind]}{l.kind === "revision_of" ? ` ${Math.round(l.confidence * 100)}%` : ""}
              </span>
              <span className="text-[9px] text-[var(--muted)]">{l.direction === "older" ? "older set" : "newer set"}</span>
            </div>
          ))}
          {projects.length > 0 && (
            <div className="pt-1 text-[10px] text-[var(--muted)]">
              {projects.map((p) => (
                <div key={p.publicId}>
                  {p.role === "copy" ? "This set is a page-for-page copy of " : "Page-for-page copied by "}
                  <Link href={crossSetViewerHref(p.publicId, 1)} className="text-[var(--accent)] hover:underline">{p.name}</Link>
                  {` (${p.shared}/${p.pages} pages)`}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
