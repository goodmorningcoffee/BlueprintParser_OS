"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import { refreshPageCsiSpatialMap } from "@/lib/csi-spatial-refresh";
import type { PageIntelligence, TextRegion } from "@/types";

interface NotesClassifierProps {
  /** Called after the user clicks Edit so NotesPanel can switch to the Parser
   *  tab pre-seeded with the region. */
  onEditInParser: () => void;
}

type RowAction = "idle" | "promoting" | "rejecting";

/**
 * NotesClassifier — Stage 4 per-page triage.
 *
 * Reads pageIntelligence[currentPage].textRegions filtered to
 *   { notes-numbered, notes-key-value }
 * minus pageIntelligence.rejectedTextRegionIds minus regions that a
 * ParsedRegion has already been promoted from (tracked via
 * ParsedRegion.sourceTextRegionId).
 *
 * Three actions per card:
 *   - Accept → POST /api/regions/promote (one-click promote path)
 *   - Edit   → seed notesParseRegion + notesType, switch to Parser tab
 *   - Reject → append id to rejectedTextRegionIds, PATCH intelligence
 */
export default function NotesClassifier({ onEditInParser }: NotesClassifierProps) {
  const projectId = useViewerStore((s) => s.projectId);
  const pageNumber = useViewerStore((s) => s.pageNumber);
  // Scoped subscription: rerender only when this page's intel changes,
  // not when any page's intel changes.
  const intel = useViewerStore((s) => s.pageIntelligence[pageNumber]) as PageIntelligence | undefined;
  const setPageIntelligence = useViewerStore((s) => s.setPageIntelligence);
  const setNotesParseRegion = useViewerStore((s) => s.setNotesParseRegion);
  const setNotesType = useViewerStore((s) => s.setNotesType);
  const [rowStates, setRowStates] = useState<Record<string, RowAction>>({});
  const [errorByRow, setErrorByRow] = useState<Record<string, string>>({});

  // One-shot prune of stale rejectedTextRegionIds — IDs whose textRegion no
  // longer exists after a Layer 1 reprocess. Keyed on (projectId, pageNumber)
  // so we prune at most once per page visit. Fires only when there's actually
  // stale data to avoid unnecessary PATCH traffic.
  const prunedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!projectId || !intel?.textRegions || !intel.rejectedTextRegionIds?.length) return;
    const key = `${projectId}:${pageNumber}`;
    if (prunedKeyRef.current === key) return;
    const activeIds = new Set(intel.textRegions.map((tr) => tr.id));
    const pruned = intel.rejectedTextRegionIds.filter((id) => activeIds.has(id));
    if (pruned.length === intel.rejectedTextRegionIds.length) return; // nothing stale
    prunedKeyRef.current = key;
    const updated: PageIntelligence = { ...intel, rejectedTextRegionIds: pruned };
    setPageIntelligence(pageNumber, updated);
    fetch("/api/pages/intelligence", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, pageNumber, intelligence: updated }),
    }).catch(() => {
      // Non-fatal — next page visit will retry if stale IDs still present.
      prunedKeyRef.current = null;
    });
  }, [projectId, pageNumber, intel, setPageIntelligence]);

  const visibleRegions = useMemo(() => {
    if (!intel?.textRegions) return [];
    const rejected = new Set(intel.rejectedTextRegionIds ?? []);
    const promotedSources = new Set(
      (intel.parsedRegions ?? [])
        .map((p) => p.sourceTextRegionId)
        .filter((id): id is string => typeof id === "string"),
    );
    return intel.textRegions.filter((tr) => {
      if (tr.type !== "notes-numbered" && tr.type !== "notes-key-value") return false;
      if (rejected.has(tr.id)) return false;
      if (promotedSources.has(tr.id)) return false;
      return true;
    });
  }, [intel]);

  const setRowState = (id: string, s: RowAction) =>
    setRowStates((prev) => ({ ...prev, [id]: s }));
  const setRowError = (id: string, msg: string | null) =>
    setErrorByRow((prev) => {
      const next = { ...prev };
      if (msg === null) delete next[id];
      else next[id] = msg;
      return next;
    });

  const handleAccept = async (tr: TextRegion) => {
    if (!projectId) return;
    setRowState(tr.id, "promoting");
    setRowError(tr.id, null);
    try {
      const res = await fetch("/api/regions/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          pageNumber,
          type: "notes",
          sourceTextRegionId: tr.id,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Promote failed" }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const payload = (await res.json()) as { updatedIntelligence: PageIntelligence };
      setPageIntelligence(pageNumber, payload.updatedIntelligence);
      refreshPageCsiSpatialMap(pageNumber);
    } catch (err) {
      setRowError(tr.id, err instanceof Error ? err.message : "Promote failed");
    } finally {
      setRowState(tr.id, "idle");
    }
  };

  const handleEdit = (tr: TextRegion) => {
    // textRegion.bbox is LTWH; viewer stores parse regions as MinMax.
    const [l, t, w, h] = tr.bbox;
    setNotesParseRegion([l, t, l + w, t + h]);
    setNotesType(inferNoteType(tr.classifiedLabels?.tier2));
    onEditInParser();
  };

  const handleReject = async (tr: TextRegion) => {
    if (!projectId || !intel) return;
    setRowState(tr.id, "rejecting");
    setRowError(tr.id, null);

    const existingRejected = intel.rejectedTextRegionIds ?? [];
    if (existingRejected.includes(tr.id)) {
      setRowState(tr.id, "idle");
      return;
    }
    const nextRejected = [...existingRejected, tr.id];
    const updatedIntel: PageIntelligence = { ...intel, rejectedTextRegionIds: nextRejected };

    // Optimistic local update
    setPageIntelligence(pageNumber, updatedIntel);

    try {
      const res = await fetch("/api/pages/intelligence", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, pageNumber, intelligence: updatedIntel }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Reject failed" }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      // Roll back the optimistic update
      setPageIntelligence(pageNumber, intel);
      setRowError(tr.id, err instanceof Error ? err.message : "Reject failed");
    } finally {
      setRowState(tr.id, "idle");
    }
  };

  if (!intel) {
    return (
      <div className="flex-1 flex items-center justify-center px-6 py-8 text-[10px] text-[var(--muted)] text-center">
        Loading page intelligence…
      </div>
    );
  }

  if (visibleRegions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-6 py-8 text-center">
        <div>
          <div className="text-[11px] text-[var(--muted)] mb-1">
            No note regions detected on this page
          </div>
          <div className="text-[10px] text-[var(--muted)]/70">
            Draw one in the Parser tab, or run admin reprocess (intelligence scope)
            if you expect classifier coverage here.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-2 py-2 space-y-2">
      {visibleRegions.map((tr) => {
        const state = rowStates[tr.id] ?? "idle";
        const err = errorByRow[tr.id];
        const preview = (tr.containedText ?? "").slice(0, 180);
        return (
          <div
            key={tr.id}
            className="rounded border border-[var(--border)] bg-[var(--surface-2)]/50 p-2"
          >
            <div className="flex items-center justify-between gap-2 mb-1">
              <div className="flex items-center gap-1 flex-wrap min-w-0">
                <span className="text-[10px] font-semibold text-blue-300 truncate">
                  {tr.headerText || (tr.type === "notes-numbered" ? "Notes" : "Legend")}
                </span>
                <span className="text-[8.5px] px-1 py-[1px] rounded bg-[var(--border)]/30 text-[var(--muted)]">
                  {tr.type === "notes-numbered" ? "numbered" : "K:V"}
                </span>
              </div>
              <span className="text-[9px] text-[var(--muted)] shrink-0">
                {Math.round(tr.confidence * 100)}%
              </span>
            </div>

            {(tr.classifiedLabels?.tier1 || tr.classifiedLabels?.tier2 || tr.classifiedLabels?.trade) && (
              <div className="flex flex-wrap gap-1 mb-1">
                {tr.classifiedLabels?.tier1 && (
                  <Chip color="emerald">{tr.classifiedLabels.tier1}</Chip>
                )}
                {tr.classifiedLabels?.tier2 && (
                  <Chip color="sky">{tr.classifiedLabels.tier2}</Chip>
                )}
                {tr.classifiedLabels?.trade && (
                  <Chip color="violet">{tr.classifiedLabels.trade}</Chip>
                )}
              </div>
            )}

            {preview && (
              <div className="text-[9.5px] text-[var(--muted)] leading-snug mb-1.5 line-clamp-3">
                {preview}
                {tr.containedText && tr.containedText.length > 180 ? "…" : ""}
              </div>
            )}

            {err && (
              <div className="text-[9px] text-red-400 mb-1">{err}</div>
            )}

            <div className="flex gap-1">
              <button
                onClick={() => handleAccept(tr)}
                disabled={state !== "idle"}
                title="Accept the classifier-proposed grid as a committed ParsedRegion"
                className="flex-1 text-[10px] px-2 py-1 rounded border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {state === "promoting" ? "Accepting…" : "Accept"}
              </button>
              <button
                onClick={() => handleEdit(tr)}
                disabled={state !== "idle"}
                className="flex-1 text-[10px] px-2 py-1 rounded border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 disabled:opacity-40"
              >
                Edit
              </button>
              <button
                onClick={() => handleReject(tr)}
                disabled={state !== "idle"}
                className="flex-1 text-[10px] px-2 py-1 rounded border border-red-500/40 text-red-300 hover:bg-red-500/10 disabled:opacity-40"
              >
                {state === "rejecting" ? "…" : "Reject"}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Chip({
  color,
  children,
}: {
  color: "emerald" | "sky" | "violet";
  children: React.ReactNode;
}) {
  const classes = {
    emerald: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    sky: "bg-sky-500/15 text-sky-300 border-sky-500/30",
    violet: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  }[color];
  return (
    <span
      className={`inline-block px-1.5 py-[1px] rounded border text-[8.5px] leading-tight ${classes}`}
    >
      {children}
    </span>
  );
}

function inferNoteType(
  tier2?: string,
): "general" | "rcp" | "demo" | "key" | "spec-note" | "other" | null {
  if (!tier2) return null;
  const upper = tier2.toUpperCase();
  if (upper.includes("GENERAL")) return "general";
  if (upper.includes("RCP") || upper.includes("CEILING")) return "rcp";
  if (upper.includes("DEMO")) return "demo";
  if (upper.includes("KEY")) return "key";
  if (upper.includes("PART 1") || upper.includes("PART 2") || upper.includes("SECTION")) return "spec-note";
  return "other";
}
