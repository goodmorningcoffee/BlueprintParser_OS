"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import { refreshPageCsiSpatialMap } from "@/lib/csi-spatial-refresh";
import { unionBboxes } from "@/lib/specnote-parser";
import type { CsiCode, PageIntelligence, ParsedRegion, SpecData } from "@/types";

type SpecSubMode = "auto" | "paragraph" | "manual";

interface PreviewSpec {
  sections: Array<{ sectionHeader: string; body: string }>;
  rowBoundaries?: number[];
  csiTags?: CsiCode[];
}

/**
 * SpecParser — Stage 5 commit tool for spec-family regions.
 * Sub-modes:
 *   - Auto: POST /api/spec-parse → preview → Save
 *   - Paragraph: ParagraphOverlay gated via paragraphOverlayActive; user
 *     double-clicks paragraphs, batch accumulates, Save promotes as one
 *     ParsedRegion{type:"spec"}.
 *   - Manual: user edits section headers + bodies directly (placeholder UI
 *     for ship 1; iterates post-ship).
 */
export default function SpecParser() {
  const projectId = useViewerStore((s) => s.projectId);
  const pageNumber = useViewerStore((s) => s.pageNumber);
  const setPageIntelligence = useViewerStore((s) => s.setPageIntelligence);

  const specParseRegion = useViewerStore((s) => s.specParseRegion);
  const setSpecParseRegion = useViewerStore((s) => s.setSpecParseRegion);
  const setSpecParseStep = useViewerStore((s) => s.setSpecParseStep);
  const resetSpecParse = useViewerStore((s) => s.resetSpecParse);

  const paragraphBatch = useViewerStore((s) => s.paragraphBatch);
  const setParagraphBatch = useViewerStore((s) => s.setParagraphBatch);
  const removePendingParagraph = useViewerStore((s) => s.removePendingParagraph);
  const setParagraphOverlayActive = useViewerStore((s) => s.setParagraphOverlayActive);
  const upsertPendingParagraph = useViewerStore((s) => s.upsertPendingParagraph);

  const setParseDraftRegion = useViewerStore((s) => s.setParseDraftRegion);

  const [mode, setMode] = useState<SpecSubMode>("auto");
  const [preview, setPreview] = useState<PreviewSpec | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isSavingRef = useRef(false);

  // Draft region preview for ParseRegionLayer — union-bbox of batch when in
  // paragraph mode, else the auto/manual preview region.
  const draft = useMemo<ParsedRegion | null>(() => {
    if (mode === "paragraph" && paragraphBatch.length > 0) {
      const unionMinMax = unionBboxes(paragraphBatch.map((p) => p.bbox));
      const [x0, y0, x1, y1] = unionMinMax;
      return {
        id: "draft-spec",
        type: "spec",
        category: "spec-preview",
        bbox: [x0, y0, x1, y1],
        confidence: 0.85,
        source: "user",
        data: {
          sections: paragraphBatch.map((p) => ({
            sectionHeader: p.rowText.sectionHeader ?? "",
            body: p.rowText.body ?? "",
          })),
          tableName: `(draft — ${paragraphBatch.length} paragraph${paragraphBatch.length === 1 ? "" : "s"})`,
        } satisfies SpecData,
      };
    }
    if (!preview || !specParseRegion) return null;
    const [x0, y0, x1, y1] = specParseRegion;
    return {
      id: "draft-spec",
      type: "spec",
      category: "spec-preview",
      bbox: [x0, y0, x1, y1],
      confidence: 0.85,
      source: "user",
      data: {
        sections: preview.sections,
        tableName: "(preview)",
      } satisfies SpecData,
    };
  }, [mode, paragraphBatch, preview, specParseRegion]);

  useEffect(() => {
    setParseDraftRegion(draft);
  }, [draft, setParseDraftRegion]);

  useEffect(() => {
    return () => setParseDraftRegion(null);
  }, [setParseDraftRegion]);

  // Toggle ParagraphOverlay activation on paragraph sub-mode entry/exit.
  useEffect(() => {
    setParagraphOverlayActive(mode === "paragraph" && !!specParseRegion);
    return () => setParagraphOverlayActive(false);
  }, [mode, specParseRegion, setParagraphOverlayActive]);

  const regionReady = !!specParseRegion;

  const runAuto = async () => {
    if (!projectId || !specParseRegion) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/spec-parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, pageNumber, regionBbox: specParseRegion }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Parse failed" }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const payload = (await res.json()) as PreviewSpec & { note?: string };
      if (!payload.sections?.length) {
        setError(payload.note ?? "No spec section headers detected in region");
        setPreview(null);
      } else {
        setPreview(payload);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Parse failed");
    } finally {
      setLoading(false);
    }
  };

  const saveFromPreview = async () => {
    if (!projectId || !specParseRegion || !preview || isSavingRef.current) return;
    isSavingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const data: SpecData = {
        sections: preview.sections,
        tableName: `Spec p.${pageNumber}`,
        csiTags: preview.csiTags,
      };
      const res = await fetch("/api/regions/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          pageNumber,
          type: "spec",
          overrides: {
            bbox: specParseRegion,
            data,
            category: "spec-dense-columns",
            csiTags: preview.csiTags ?? [],
          },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Save failed" }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const payload = (await res.json()) as { updatedIntelligence: PageIntelligence };
      setPageIntelligence(pageNumber, payload.updatedIntelligence);
      refreshPageCsiSpatialMap(pageNumber);
      resetSpecParse();
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      isSavingRef.current = false;
      setSaving(false);
    }
  };

  const saveFromBatch = async () => {
    if (!projectId || !specParseRegion || paragraphBatch.length === 0 || isSavingRef.current) return;
    isSavingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const unionBbox = unionBboxes(paragraphBatch.map((p) => p.bbox));
      const data: SpecData = {
        sections: paragraphBatch.map((p) => ({
          sectionHeader: p.rowText.sectionHeader ?? "",
          body: p.rowText.body ?? "",
        })),
        tableName: `Spec p.${pageNumber} — ${paragraphBatch.length} section${paragraphBatch.length === 1 ? "" : "s"}`,
      };
      const res = await fetch("/api/regions/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          pageNumber,
          type: "spec",
          overrides: {
            bbox: unionBbox,
            data,
            category: "spec-dense-columns",
          },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Save failed" }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const payload = (await res.json()) as { updatedIntelligence: PageIntelligence };
      setPageIntelligence(pageNumber, payload.updatedIntelligence);
      refreshPageCsiSpatialMap(pageNumber);
      setParagraphBatch([]);
      resetSpecParse();
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      isSavingRef.current = false;
      setSaving(false);
    }
  };

  const handleRepeatPlusOne = () => {
    if (paragraphBatch.length === 0) return;
    const last = paragraphBatch[paragraphBatch.length - 1];
    const [x0, y0, x1, y1] = last.bbox;
    const h = y1 - y0;
    const newBbox: [number, number, number, number] = [x0, y1, x1, y1 + h];
    upsertPendingParagraph({
      id: `para-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      bbox: newBbox,
      lines: [],
      rowText: { sectionHeader: "", body: "" },
    });
  };

  const handleSave = () => {
    if (mode === "paragraph") return saveFromBatch();
    return saveFromPreview();
  };

  const handleClear = () => {
    setPreview(null);
    setError(null);
    setSpecParseRegion(null);
    setSpecParseStep("idle");
    setParagraphBatch([]);
    resetSpecParse();
  };

  const regionLabel = useMemo(() => {
    if (!specParseRegion) return "Draw a region to begin";
    const [x0, y0, x1, y1] = specParseRegion;
    return `Region: ${(x0 * 100).toFixed(1)},${(y0 * 100).toFixed(1)} → ${(x1 * 100).toFixed(1)},${(y1 * 100).toFixed(1)} (%)`;
  }, [specParseRegion]);

  const canSave = mode === "paragraph" ? paragraphBatch.length > 0 : !!preview;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex border-b border-[var(--border)]">
        {(["auto", "paragraph", "manual"] as const).map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m);
              setPreview(null);
              setError(null);
            }}
            className={`flex-1 px-1 py-1.5 text-[9px] font-medium ${
              mode === m
                ? "text-violet-300 border-b-2 border-violet-400"
                : "text-[var(--muted)] hover:text-[var(--fg)]"
            }`}
          >
            {m === "auto" ? "Auto" : m === "paragraph" ? "Paragraph" : "Manual"}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-2">
        <div className="flex items-center gap-1.5">
          <div className="text-[10px] text-[var(--muted)] flex-1 truncate">{regionLabel}</div>
          {!regionReady ? (
            <button
              onClick={() => {
                setSpecParseStep("select-region");
                useViewerStore.getState().setMode("pointer");
              }}
              className="text-[10px] px-2 py-0.5 rounded border border-violet-500/40 text-violet-300 hover:bg-violet-500/10"
            >
              Draw region
            </button>
          ) : (
            <button
              onClick={() => {
                resetSpecParse();
                setSpecParseStep("select-region");
                useViewerStore.getState().setMode("pointer");
              }}
              className="text-[9px] px-1.5 py-0.5 rounded text-[var(--muted)] hover:text-red-400"
            >
              Redraw
            </button>
          )}
        </div>

        {mode === "auto" && (
          <div className="space-y-1.5">
            <button
              onClick={runAuto}
              disabled={!regionReady || loading}
              className="w-full text-[10px] px-2 py-1 rounded border border-violet-500/40 text-violet-300 hover:bg-violet-500/10 disabled:opacity-40"
            >
              {loading ? "Parsing…" : "Run Auto-Parse"}
            </button>
            {!regionReady && (
              <div className="text-[9px] text-[var(--muted)]/70 italic">
                Draw a bbox around the spec region; headers like PART 1 / SECTION XX / GENERAL NOTES will split into rows.
              </div>
            )}
          </div>
        )}

        {mode === "paragraph" && (
          <div className="space-y-1.5">
            <div className="text-[9px] text-[var(--muted)]/70 italic leading-snug">
              Hover a paragraph to preview, double-click to commit. First line
              becomes the section header; remaining lines the body. Drag edge
              handles to adjust. Cmd+C / Cmd+V copies column boundaries across
              paragraphs. Press Delete to remove a focused paragraph.
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={handleRepeatPlusOne}
                disabled={paragraphBatch.length === 0}
                title="Clone the last paragraph's bbox one row down — fast path for uniform-height lists"
                className="flex-1 text-[10px] px-2 py-1 rounded border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 disabled:opacity-40"
              >
                Repeat +1 single
              </button>
              <button
                onClick={() => setParagraphBatch([])}
                disabled={paragraphBatch.length === 0}
                className="text-[10px] px-2 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-red-400 disabled:opacity-40"
              >
                Discard
              </button>
            </div>
            <div className="text-[9.5px] text-[var(--muted)]">
              {paragraphBatch.length} paragraph{paragraphBatch.length === 1 ? "" : "s"} in batch
            </div>
            {paragraphBatch.length > 0 && (
              <ul className="space-y-1 max-h-32 overflow-y-auto text-[9px] font-mono">
                {paragraphBatch.map((p, i) => (
                  <li key={p.id} className="flex items-start gap-1 px-1 py-0.5 rounded bg-[var(--surface-2)]/50">
                    <span className="text-violet-300 font-semibold shrink-0">#{i + 1}</span>
                    <span className="flex-1 truncate text-[var(--fg)]/80">
                      {p.rowText.sectionHeader || "(empty header)"}
                      {p.rowText.body ? ` · ${p.rowText.body.slice(0, 48)}${p.rowText.body.length > 48 ? "…" : ""}` : ""}
                    </span>
                    <button
                      onClick={() => removePendingParagraph(p.id)}
                      className="text-red-400/70 hover:text-red-400 shrink-0"
                      title="Remove"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {mode === "manual" && (
          <div className="space-y-1.5">
            <div className="text-[9px] text-[var(--muted)]/70 leading-snug">
              Manual mode placeholder — iterate via a sections form once the
              paragraph-overlay flow has been validated post-ship.
            </div>
          </div>
        )}

        {error && <div className="text-[9.5px] text-red-400 px-1">{error}</div>}

        {preview && mode !== "paragraph" && (
          <div className="rounded border border-[var(--border)] bg-[var(--surface-2)]/50 p-2 space-y-1">
            <div className="text-[10px] font-semibold text-violet-300">
              Preview: {preview.sections.length} section{preview.sections.length === 1 ? "" : "s"}
            </div>
            {preview.csiTags && preview.csiTags.length > 0 && (
              <div className="text-[9px] text-[var(--muted)]">
                {preview.csiTags.length} CSI tag{preview.csiTags.length === 1 ? "" : "s"} detected
              </div>
            )}
            <div className="max-h-32 overflow-y-auto text-[9px] font-mono text-[var(--fg)]/80 leading-tight space-y-0.5">
              {preview.sections.slice(0, 8).map((s, i) => (
                <div key={i}>
                  <span className="text-violet-300 font-semibold">{s.sectionHeader || "(no header)"}</span>
                  {s.body && (
                    <span className="text-[var(--muted)]">
                      {" · "}
                      {s.body.slice(0, 60)}
                      {s.body.length > 60 ? "…" : ""}
                    </span>
                  )}
                </div>
              ))}
              {preview.sections.length > 8 && (
                <div className="text-[var(--muted)]/70 italic">… and {preview.sections.length - 8} more</div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-[var(--border)] px-2 py-1.5 flex gap-1">
        <button
          onClick={handleClear}
          className="flex-1 text-[10px] px-2 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
        >
          Clear
        </button>
        <button
          onClick={handleSave}
          disabled={!canSave || saving}
          className="flex-1 text-[10px] px-2 py-1 rounded border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save Spec"}
        </button>
      </div>
    </div>
  );
}
