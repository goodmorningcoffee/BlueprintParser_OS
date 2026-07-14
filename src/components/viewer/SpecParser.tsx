"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useParseFlow } from "@/hooks/useParseFlow";
import { useProjectLifecycleGuard } from "@/hooks/useProjectLifecycleGuard";
import {
  commitParseOperation,
  useParseOperation,
  type ParseOperationToken,
} from "@/hooks/useParseOperation";
import {
  useParagraphWorkspaceExtensions,
  useParseFlowStore,
} from "@/stores/parseFlowStore";
import {
  claimParagraphWorkspaceForOperation,
  completeSpecParseOperation,
  invalidateParagraphParseOperationsForOperation,
  leaveSpecParserWorkspace,
  removeParagraphForUser,
  resetSpecParseWorkspace,
  setSpecParseStepWithTool,
  setParagraphBatchForUser,
  transitionSpecParserMode,
  upsertParagraphForUser,
  type ParseWorkspaceLease,
} from "@/stores/viewerCommands";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { useSessionStore } from "@/stores/sessionStore";
import { saveParsedRegion } from "@/queries/parsedRegions";
import { unionBboxes } from "@/lib/specnote-parser";
// [refactor jul5 S026] apiErrorMessage: spec-parse now serves {error:{code,message}}
import { canPersist, regionIdFor, apiErrorMessage } from "@/lib/client-persist";
import type { CsiCode, ParsedRegion, SpecData } from "@/types";

type SpecSubMode = "auto" | "paragraph" | "manual";

interface PreviewSpec {
  sections: Array<{ sectionHeader: string; body: string }>;
  rowBoundaries?: number[];
  csiTags?: CsiCode[];
}

type SpecBbox = [number, number, number, number];

type SpecOperationTarget = Readonly<{
  projectId: number;
  publicId: string | null;
  isDemo: boolean;
  pageNumber: number;
  region: SpecBbox;
}>;

function clonePreviewSpec(preview: PreviewSpec): PreviewSpec {
  return {
    sections: preview.sections.map((section) => ({ ...section })),
    rowBoundaries: preview.rowBoundaries ? [...preview.rowBoundaries] : undefined,
    csiTags: preview.csiTags?.map((tag) => ({ ...tag })),
  };
}

function specDraftFor(preview: PreviewSpec, region: SpecBbox): ParsedRegion {
  const [x0, y0, x1, y1] = region;
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
}

/**
 * SpecParser — Stage 5 commit tool for spec-family regions.
 * Sub-modes:
 *   - Auto: POST /api/spec-parse → preview → Save
 *   - Paragraph: ParagraphOverlay gated by the exact Notes/Spec workspace owner; user
 *     double-clicks paragraphs, batch accumulates, Save promotes as one
 *     ParsedRegion{type:"spec"}.
 *   - Manual: user edits section headers + bodies directly (placeholder UI
 *     for ship 1; iterates post-ship).
 */
export default function SpecParser() {
  const queryClient = useQueryClient();
  const projectId = useSessionStore((s) => s.projectId);
  const publicId = useSessionStore((s) => s.publicId);
  const isDemo = useSessionStore((s) => s.isDemo);
  const isRenderedLifecycleCurrent = useProjectLifecycleGuard(publicId, isDemo);
  const pageNumber = useViewerCoreStore((s) => s.pageNumber);

  const { region: specParseRegion } = useParseFlow("spec");
  const specOperation = useParseOperation("spec");
  const {
    paragraphBatch,
  } = useParagraphWorkspaceExtensions();
  const [mode, setMode] = useState<SpecSubMode>("auto");
  const [preview, setPreview] = useState<PreviewSpec | null>(null);
  const [loadingRevision, setLoadingRevision] = useState<number | null>(null);
  const [savingRevision, setSavingRevision] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loading = specOperation.busy && loadingRevision === specOperation.revision;
  const saving = specOperation.busy && savingRevision === specOperation.revision;
  const cleanupLeaseRef = useRef<ParseWorkspaceLease | null>(null);

  useEffect(() => () => {
    if (cleanupLeaseRef.current) {
      leaveSpecParserWorkspace(cleanupLeaseRef.current);
    }
  }, []);

  const regionReady = !!specParseRegion;

  const captureTarget = (region: SpecBbox): SpecOperationTarget => ({
    projectId,
    publicId,
    isDemo,
    pageNumber,
    region: [...region] as SpecBbox,
  });

  const runAuto = async () => {
    if (!projectId || !specParseRegion) return;
    const target = captureTarget(specParseRegion);
    const started = specOperation.begin();
    if (started.status !== "started") return;
    const token = started.token;
    try {
      const workspaceLease = invalidateParagraphParseOperationsForOperation(token);
      if (!workspaceLease) return;
      if (!commitParseOperation(token, () => {
        cleanupLeaseRef.current = workspaceLease;
        setLoadingRevision(token.revision);
        setSavingRevision(null);
        setError(null);
      })) return;
      const res = await fetch("/api/spec-parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: target.projectId,
          pageNumber: target.pageNumber,
          regionBbox: target.region,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Parse failed" }));
        throw new Error(apiErrorMessage(err) || `HTTP ${res.status}`);
      }
      const response = (await res.json()) as PreviewSpec & { note?: string };
      if (!specOperation.isCurrent(token)) return;
      const payload = clonePreviewSpec(response);
      if (!payload.sections?.length) {
        commitParseOperation(token, () => {
          setError(response.note ?? "No spec section headers detected in region");
          setPreview(null);
          useParseFlowStore.getState().setParseDraftRegion(null);
        });
      } else {
        const published = commitParseOperation(token, () => {
          setPreview(payload);
          setLoadingRevision(null);
          setSavingRevision(token.revision);
          setError(null);
          useParseFlowStore.getState().setParseDraftRegion(specDraftFor(payload, target.region));
        });
        if (!published || !specOperation.isCurrent(token)) return;
        await persistPreview(payload, target.region, token, target);
      }
    } catch (err) {
      commitParseOperation(token, () => {
        setError(err instanceof Error ? err.message : "Parse failed");
      });
    } finally {
      specOperation.finish(token);
    }
  };

  // Promote the preview to a committed ParsedRegion. Shared by the auto-fire
  // (on parse completion) and the manual "Save Spec" button. Pass the preview +
  // region explicitly so the auto path doesn't race React state updates.
  const persistPreview = async (
    p: PreviewSpec,
    region: SpecBbox,
    inheritedToken?: ParseOperationToken<"spec">,
    inheritedTarget?: SpecOperationTarget,
  ): Promise<boolean> => {
    if (!isRenderedLifecycleCurrent()) return false;
    const target = inheritedTarget ?? captureTarget(region);
    if (!canPersist(target.publicId, target.isDemo)) return false;
    const input = clonePreviewSpec(p);
    const ownsToken = inheritedToken === undefined;
    let token = inheritedToken;
    if (ownsToken) {
      const started = specOperation.begin();
      if (started.status !== "started") return false;
      token = started.token;
    }
    if (!token) return false;
    const activeToken = token;
    const canPublishCompletion = () =>
      isRenderedLifecycleCurrent() && specOperation.isCurrent(activeToken);
    try {
      if (ownsToken) {
        const workspaceLease = invalidateParagraphParseOperationsForOperation(token);
        if (!workspaceLease) return false;
        if (!commitParseOperation(token, () => {
          cleanupLeaseRef.current = workspaceLease;
          setSavingRevision(token.revision);
          setLoadingRevision(null);
          setError(null);
        })) return false;
      } else if (!specOperation.isCurrent(token)) {
        return false;
      }
      const data: SpecData = {
        sections: input.sections,
        tableName: `Spec p.${target.pageNumber}`,
        csiTags: input.csiTags,
      };
      await saveParsedRegion(
        queryClient,
        {
          publicId: target.publicId,
          isDemo: target.isDemo,
          pageNumber: target.pageNumber,
          canAdopt: isRenderedLifecycleCurrent,
        },
        {
          via: "parser",
          type: "spec",
          regionId: regionIdFor(target.pageNumber, target.region),
          bboxMinMax: target.region,
          data: data as unknown as Record<string, unknown>,
          category: "spec-dense-columns",
          csiTags: input.csiTags ?? [],
        },
      );
      if (!canPublishCompletion()) return false;
      let completed = false;
      commitParseOperation(token, () => {
        setPreview(null);
        completed = completeSpecParseOperation(token);
      });
      return completed;
    } catch (err) {
      if (!canPublishCompletion()) return false;
      commitParseOperation(token, () => {
        setError(err instanceof Error ? err.message : "Save failed");
      });
      return false;
    } finally {
      if (ownsToken && canPublishCompletion()) specOperation.finish(token);
    }
  };

  const saveFromPreview = async () => {
    if (!specParseRegion || !preview) return;
    return persistPreview(preview, specParseRegion);
  };

  const saveFromBatch = async () => {
    if (!isRenderedLifecycleCurrent()) return;
    if (!canPersist(publicId, isDemo) || !specParseRegion || paragraphBatch.length === 0) return;
    const target = captureTarget(specParseRegion);
    const capturedBatch = paragraphBatch.map((paragraph) => ({
      ...paragraph,
      bbox: [...paragraph.bbox] as SpecBbox,
      lines: [...paragraph.lines],
      rowText: { ...paragraph.rowText },
      colBoundaries: paragraph.colBoundaries ? [...paragraph.colBoundaries] : undefined,
    }));
    const started = specOperation.begin();
    if (started.status !== "started") return;
    const token = started.token;
    const canPublishCompletion = () =>
      isRenderedLifecycleCurrent() && specOperation.isCurrent(token);
    try {
      const workspaceLease = claimParagraphWorkspaceForOperation(
        token,
        "spec",
        specParseRegion,
      );
      if (!workspaceLease) return;
      if (!commitParseOperation(token, () => {
        cleanupLeaseRef.current = workspaceLease;
        setSavingRevision(token.revision);
        setLoadingRevision(null);
        setError(null);
      })) return;
      const unionBbox = unionBboxes(capturedBatch.map((p) => p.bbox));
      const data: SpecData = {
        sections: capturedBatch.map((p) => ({
          sectionHeader: p.rowText.sectionHeader ?? "",
          body: p.rowText.body ?? "",
        })),
        tableName: `Spec p.${target.pageNumber} — ${capturedBatch.length} section${capturedBatch.length === 1 ? "" : "s"}`,
      };
      await saveParsedRegion(
        queryClient,
        {
          publicId: target.publicId,
          isDemo: target.isDemo,
          pageNumber: target.pageNumber,
          canAdopt: isRenderedLifecycleCurrent,
        },
        {
          via: "parser",
          type: "spec",
          regionId: regionIdFor(target.pageNumber, unionBbox),
          bboxMinMax: unionBbox,
          data: data as unknown as Record<string, unknown>,
          category: "spec-dense-columns",
        },
      );
      if (!canPublishCompletion()) return;
      commitParseOperation(token, () => {
        setPreview(null);
        completeSpecParseOperation(token);
      });
    } catch (err) {
      if (!canPublishCompletion()) return;
      commitParseOperation(token, () => {
        setError(err instanceof Error ? err.message : "Save failed");
      });
    } finally {
      if (canPublishCompletion()) specOperation.finish(token);
    }
  };

  const handleRepeatPlusOne = () => {
    if (!specParseRegion || paragraphBatch.length === 0) return;
    const last = paragraphBatch[paragraphBatch.length - 1];
    const [x0, y0, x1, y1] = last.bbox;
    const h = y1 - y0;
    const newBbox: [number, number, number, number] = [x0, y1, x1, y1 + h];
    upsertParagraphForUser("spec", specParseRegion, {
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
    setMode("auto");
    setPreview(null);
    setError(null);
    resetSpecParseWorkspace();
  };

  const handleModeChange = (nextMode: SpecSubMode) => {
    if (nextMode === mode) return;
    const lease = transitionSpecParserMode(nextMode, specParseRegion);
    if (!lease) return;
    cleanupLeaseRef.current = lease;
    setMode(nextMode);
    setPreview(null);
    setError(null);
  };

  const handleRedraw = () => {
    if (!resetSpecParseWorkspace("select-region", "pointer")) return;
    setMode("auto");
    setPreview(null);
    setError(null);
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
            onClick={() => handleModeChange(m)}
            disabled={!regionReady && m !== "auto"}
            className={`flex-1 px-1 py-1.5 text-[9px] font-medium ${
              mode === m
                ? "text-violet-300 border-b-2 border-violet-400"
                : "text-[var(--muted)] hover:text-[var(--fg)] disabled:opacity-40"
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
                setSpecParseStepWithTool("select-region", "pointer");
              }}
              className="text-[10px] px-2 py-0.5 rounded border border-violet-500/40 text-violet-300 hover:bg-violet-500/10"
            >
              Draw region
            </button>
          ) : (
            <button
              onClick={handleRedraw}
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
                onClick={() => {
                  if (specParseRegion) {
                    setParagraphBatchForUser("spec", specParseRegion, []);
                  }
                }}
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
                      onClick={() => {
                        if (specParseRegion) {
                          removeParagraphForUser("spec", specParseRegion, p.id);
                        }
                      }}
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
