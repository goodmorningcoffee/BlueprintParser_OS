"use client";

// [TP-2 WP-2.F] Verdict bar under a saved parsed region: ✓ (the parse is correct) and ✗ (it is wrong), nothing
// else. Clicking the active verdict again removes it. The server snapshots the region at verdict time; an edit
// saved later turns the label into "corrected" (inferred on read), which shows here as a muted note. Hidden in
// demo projects and for a region without a saved id. Labels are gold for the table pipeline (PLAN §6.5).

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useProject } from "@/stores/sessionStore";
import {
  invalidateParseLabels,
  submitParseLabel,
  undoParseLabel,
  useParseLabels,
} from "@/queries/useParseLabels";

const FOCUS_RING = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#00E676]";

function buttonClass(on: boolean, tone: "ok" | "bad"): string {
  const active = tone === "ok" ? "border-[#00E676]/60 text-[#00E676] bg-[#00E676]/10" : "border-red-400/60 text-red-300 bg-red-500/10";
  return `px-1.5 py-0.5 rounded border text-[10px] leading-none disabled:opacity-50 ${FOCUS_RING} ${
    on ? active : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
  }`;
}

export default function ParseVerdictBar({
  pageNumber,
  region,
}: {
  pageNumber: number;
  region: { id?: unknown; data?: unknown } | null | undefined;
}) {
  const { publicId, isDemo } = useProject();
  const qc = useQueryClient();
  const labels = useParseLabels(pageNumber);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const regionId = typeof region?.id === "string" ? region.id : null;

  // An edit-save replaces the region's data; re-read the page's labels so a ✓/✗ can read back as corrected.
  const data = region?.data;
  const seen = useRef(data);
  useEffect(() => {
    if (seen.current === data) return;
    seen.current = data;
    invalidateParseLabels(qc, publicId, pageNumber);
  }, [data, qc, publicId, pageNumber]);

  if (isDemo || !publicId || !regionId) return null;
  const current = labels?.[regionId];

  const choose = async (verdict: "correct" | "wrong") => {
    setBusy(true);
    setError(null);
    try {
      if (current?.verdict === verdict) await undoParseLabel(qc, publicId, { pageNumber, regionId });
      else await submitParseLabel(qc, publicId, { pageNumber, regionId, verdict });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-1 px-2 pb-1" role="group" aria-label="Parse verdict" data-parse-verdict={regionId}>
      <span className="text-[9px] text-[var(--muted)]">Parse:</span>
      <button
        type="button"
        disabled={busy}
        aria-pressed={current?.verdict === "correct"}
        aria-label="Parse is correct"
        title="The parse is correct"
        onClick={() => void choose("correct")}
        className={buttonClass(current?.verdict === "correct", "ok")}
      >
        {"✓"}
      </button>
      <button
        type="button"
        disabled={busy}
        aria-pressed={current?.verdict === "wrong"}
        aria-label="Parse is wrong"
        title="The parse is wrong"
        onClick={() => void choose("wrong")}
        className={buttonClass(current?.verdict === "wrong", "bad")}
      >
        {"✗"}
      </button>
      {current?.verdict === "corrected" && (
        <span className="text-[9px] text-[var(--muted)]" title="Edited after the verdict; the edit is kept as the correction">
          corrected
        </span>
      )}
      {error && <span role="alert" className="text-[9px] text-red-400 truncate">{error}</span>}
    </div>
  );
}
