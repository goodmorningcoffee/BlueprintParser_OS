"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useViewerStore, useProject, useNavigation, useQtoWorkflow, useSummaries, isDemoFeatureEnabled } from "@/stores/viewerStore";
import type { QtoWorkflow, QtoLineItem, QtoFlag, QtoItemType } from "@/types";
import type { ScoredMatch, DropReason } from "@/lib/tag-mapping";
import { extractDisciplinePrefix, disciplineOrder, DISCIPLINE_NAMES } from "@/lib/page-utils";
import { escCsv } from "@/lib/table-parse-utils";
import { computeScheduleDetections } from "@/lib/auto-qto/schedule-detections";
import TakeoffCsvModal from "./TakeoffCsvModal";

/** Step progression (used for progress bar + step labels) */
const STEP_SEQUENCE = ["select-schedule", "confirm-tags", "map-tags", "review", "done"] as const;

/** Material categories with heuristic schedule types */
const MATERIALS = [
  { type: "doors", label: "Doors", scheduleCategory: "door-schedule", icon: "D" },
  { type: "finishes", label: "Finishes", scheduleCategory: "finish-schedule", icon: "F" },
  { type: "equipment", label: "Equipment", scheduleCategory: "material-schedule", icon: "E" },
  { type: "plumbing", label: "Plumbing", scheduleCategory: "plumbing-schedule", icon: "P" },
  { type: "electrical", label: "Electrical", scheduleCategory: "electrical-schedule", icon: "Z" },
];

/**
 * Keywords (singular stems) for matching schedules to material types.
 * Needed because materialType is plural ("doors") but schedule categories
 * and names use singular ("door-schedule", "DOOR SCHEDULE").
 */
const MATERIAL_KEYWORDS: Record<string, string[]> = {
  doors: ["door"],
  finishes: ["finish"],
  equipment: ["equipment", "material"],
  plumbing: ["plumbing", "fixture"],
  electrical: ["electrical", "lighting", "panel"],
};

function keywordsForMaterial(materialType: string): string[] {
  const explicit = MATERIAL_KEYWORDS[materialType];
  if (explicit) return explicit;
  // Custom material: strip trailing "s" as a rough singularization
  const stem = materialType.toLowerCase().replace(/s$/, "");
  return [stem];
}

// ═══════════════════════════════════════════════════════════════
// SHIP 2 preflight — duplicated inline instead of imported from
// composite-classifier because AutoQtoTab is a client component and we
// want zero runtime coupling to the server-side lib. These two arrays
// mirror STRICT_EXCLUSION_CLASSES + RECOMMENDED_CLASSES in composite-classifier.ts
// — keep in sync if you ever tweak the exclusion zone rules.
// ═══════════════════════════════════════════════════════════════

const QTO_STRICT_EXCLUSION_CLASSES = ["tables", "title_block", "drawings"] as const;
const QTO_RECOMMENDED_CLASSES = ["grid", "vertical_area", "horizontal_area"] as const;

/** List of YOLO primitive classes that count as "tag shapes" for Type 4.
 *  Mirrors project_yolo_model_classes.md TAG_SHAPE_CLASSES — used to filter
 *  the tag-shape picker in the ConfigureStep. */
const QTO_TAG_SHAPE_CLASSES = [
  "circle", "arch_sheet_circle", "dot_small_circle",
  "hexagon", "hex_pill",
  "diamond", "triangle",
  "pill", "oval",
  "rectangle", "square",
] as const;

interface QtoPreflightResult {
  ok: boolean;
  missingStrict: string[];
  missingRecommended: string[];
  hasTables: boolean;
  hasTitleBlock: boolean;
  hasDrawings: boolean;
}

function computeQtoPreflight(
  categoryCounts: Record<string, { count: number }> | undefined,
): QtoPreflightResult {
  const cats = categoryCounts || {};
  const missingStrict = QTO_STRICT_EXCLUSION_CLASSES.filter((c) => !cats[c] || cats[c].count === 0);
  const missingRecommended = QTO_RECOMMENDED_CLASSES.filter((c) => !cats[c] || cats[c].count === 0);
  return {
    ok: missingStrict.length === 0,
    missingStrict,
    missingRecommended,
    hasTables: (cats.tables?.count ?? 0) > 0,
    hasTitleBlock: (cats.title_block?.count ?? 0) > 0,
    hasDrawings: (cats.drawings?.count ?? 0) > 0,
  };
}

export default function AutoQtoTab() {
  const { publicId } = useProject();
  const { setPage } = useNavigation();
  const { activeQtoWorkflow, setActiveQtoWorkflow, qtoWorkflows, setQtoWorkflows } = useQtoWorkflow();
  const pageIntelligence = useViewerStore((s) => s.pageIntelligence);
  const pageNames = useViewerStore((s) => s.pageNames);
  const isDemo = useViewerStore((s) => s.isDemo);
  const { summaries } = useSummaries();

  const [creating, setCreating] = useState(false);
  const [customName, setCustomName] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [loadingScheduleKey, setLoadingScheduleKey] = useState<string | null>(null);

  const scheduleDetections = useMemo(
    () => computeScheduleDetections(pageIntelligence as any, summaries?.schedules, pageNames),
    [summaries, pageIntelligence, pageNames],
  );

  // Find already-parsed schedules — merge pageIntelligence (user-parsed, has full data) + summaries (pre-computed, all pages)
  const parsedSchedules = useMemo(() => {
    const schedules: { pageNum: number; region: any; name: string; rowCount: number; colCount: number; category: string }[] = [];
    const seen = new Set<string>();

    // Source 1: pageIntelligence (includes user-parsed during this session, has region with data)
    for (const [pn, intel] of Object.entries(pageIntelligence)) {
      const pi = intel as any;
      if (pi?.parsedRegions) {
        for (const pr of pi.parsedRegions) {
          if (pr.type === "schedule" || pr.type === "keynote") {
            const name = pr.data?.tableName || pr.category || "Unnamed";
            const key = `${pn}:${name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            schedules.push({
              pageNum: Number(pn),
              region: pr,
              name,
              rowCount: pr.data?.rowCount || pr.data?.rows?.length || 0,
              colCount: pr.data?.columnCount || pr.data?.headers?.length || 0,
              category: pr.category || "",
            });
          }
        }
      }
    }

    // Source 2: summaries.parsedTables (pre-computed, covers all pages, region is null)
    if (summaries?.parsedTables) {
      for (const pt of summaries.parsedTables) {
        const key = `${pt.pageNum}:${pt.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        schedules.push({
          pageNum: pt.pageNum,
          region: null,
          name: pt.name,
          rowCount: pt.rowCount,
          colCount: pt.colCount,
          category: pt.category,
        });
      }
    }

    return schedules;
  }, [summaries, pageIntelligence]);

  // SHIP 2: preflight validation — does this project have the YOLO classes
  // required for Auto-QTO's exclusion/inclusion logic? Hard-blocks the
  // material picker AND the Run Mapping button when strict classes missing.
  const preflight = useMemo(
    () => computeQtoPreflight(summaries?.annotationSummary?.categoryCounts),
    [summaries],
  );

  // Load workflows from API on mount (skip for demo — no persisted workflows)
  useEffect(() => {
    if (!publicId || isDemo) return;
    const controller = new AbortController();
    fetch(`/api/qto-workflows?projectId=${publicId}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : []))
      .then(setQtoWorkflows)
      .catch((err) => {
        if (err.name === "AbortError") return;
        console.error("[auto-qto] Failed to load workflows:", err);
      });
    return () => controller.abort();
  }, [publicId, isDemo, setQtoWorkflows]);

  const startWorkflow = useCallback(async (materialType: string, materialLabel: string) => {
    if (!publicId) return;

    // Demo mode: create workflow locally in Zustand (no API, session-only)
    if (isDemo) {
      const tempWorkflow: QtoWorkflow = {
        id: -Date.now(),
        projectId: 0,
        materialType,
        materialLabel,
        step: "select-schedule",
        schedulePageNumber: null,
        yoloClassFilter: null,
        itemType: "yolo-with-inner-text",
        tagShapeClass: null,
        parsedSchedule: null,
        lineItems: null,
        userEdits: null,
        exportedAt: null,
      };
      setActiveQtoWorkflow(tempWorkflow);
      setQtoWorkflows([tempWorkflow, ...qtoWorkflows]);
      return;
    }

    setCreating(true);
    try {
      const res = await fetch("/api/qto-workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: publicId, materialType, materialLabel }),
      });
      if (res.ok) {
        const workflow = await res.json();
        setActiveQtoWorkflow(workflow);
        setQtoWorkflows([workflow, ...qtoWorkflows]);
      }
    } catch (err) {
      console.error("[auto-qto] Failed to create workflow:", err);
    } finally {
      setCreating(false);
    }
  }, [publicId, isDemo, qtoWorkflows, setActiveQtoWorkflow, setQtoWorkflows]);

  const updateWorkflowStep = useCallback(async (workflow: QtoWorkflow, updates: Partial<QtoWorkflow>) => {
    // Always update Zustand
    const updated = { ...workflow, ...updates };
    setActiveQtoWorkflow(updated);
    setQtoWorkflows(qtoWorkflows.map((w) => w.id === updated.id ? updated : w));

    // Skip API for demo (session-only, lost on reload)
    if (isDemo) return;

    try {
      const res = await fetch(`/api/qto-workflows/${workflow.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (res.ok) {
        const serverUpdated = await res.json();
        setActiveQtoWorkflow(serverUpdated);
        setQtoWorkflows(qtoWorkflows.map((w) => w.id === serverUpdated.id ? serverUpdated : w));
      }
    } catch (err) {
      console.error("[auto-qto] Failed to update workflow:", err);
    }
  }, [isDemo, qtoWorkflows, setActiveQtoWorkflow, setQtoWorkflows]);

  // ─── Demo feature gate ─────────────────────────────────
  if (isDemo && !isDemoFeatureEnabled("autoQto")) {
    return <div className="text-[10px] text-[var(--muted)] text-center py-8 px-2">Auto-QTO is not available in demo mode.</div>;
  }

  // ─── Active workflow view ──────────────────────────────
  if (activeQtoWorkflow) {
    return (
      <div className="flex-1 overflow-y-auto flex flex-col">
        {/* Header */}
        <div className="px-3 py-2 border-b border-[var(--border)] flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-[var(--fg)]">{activeQtoWorkflow.materialLabel}</div>
            <div className="text-[9px] text-[var(--muted)]">Step: {activeQtoWorkflow.step}</div>
          </div>
          <button
            onClick={() => setActiveQtoWorkflow(null)}
            className="text-[10px] text-[var(--muted)] hover:text-[var(--fg)] px-2 py-0.5 rounded border border-[var(--border)]"
          >
            &larr; Back
          </button>
        </div>

        {/* Step 2: Find & Parse Schedule */}
        {activeQtoWorkflow.step === "select-schedule" && (
          <div className="px-3 py-3 space-y-3">
            <div className="text-[11px] text-[var(--fg)] font-medium">
              Step 1: Find & Parse {activeQtoWorkflow.materialLabel} Schedule
            </div>
            <div className="text-[10px] text-[var(--muted)]">
              Navigate to the page with your {(activeQtoWorkflow.materialLabel || activeQtoWorkflow.materialType).toLowerCase()} schedule, then parse it using Table Parse or Guided Parse. It will appear below automatically.
            </div>

            {/* Suggested pages from heuristic detection */}
            {(() => {
              const cat = MATERIALS.find((m) => m.type === activeQtoWorkflow.materialType)?.scheduleCategory;
              const detected = cat ? (scheduleDetections[cat] || []).sort((a, b) => b.confidence - a.confidence) : [];
              if (detected.length === 0) return null;
              return (
                <div className="space-y-1">
                  <div className="text-[9px] text-[var(--muted)] uppercase tracking-wide">Suggested pages</div>
                  {detected.map((d, i) => (
                    <button
                      key={i}
                      onClick={() => setPage(d.pageNum)}
                      className="w-full text-left text-[10px] px-2 py-1.5 rounded border border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/10 flex items-center justify-between"
                    >
                      <span className="text-[var(--fg)] font-medium">{d.name}</span>
                      <span className="text-emerald-400 text-[9px]">{Math.round(d.confidence * 100)}% match</span>
                    </button>
                  ))}
                </div>
              );
            })()}

            {/* Parse tools */}
            <div className="space-y-1">
              <div className="text-[9px] text-[var(--muted)] uppercase tracking-wide">Parse tools</div>
              <div className="flex gap-1">
                <button
                  onClick={() => {
                    const store = useViewerStore.getState();
                    if (!store.showTableParsePanel) store.toggleTableParsePanel();
                  }}
                  className="flex-1 text-[10px] px-2 py-1.5 rounded border border-pink-500/30 text-pink-300 hover:bg-pink-500/10"
                >
                  Table Parse
                </button>
                <button
                  onClick={() => {
                    const store = useViewerStore.getState();
                    if (!store.showSpecsNotesPanel) store.toggleSpecsNotesPanel();
                    store.setSpecsNotesTab("keynotes");
                  }}
                  className="flex-1 text-[10px] px-2 py-1.5 rounded border border-amber-500/30 text-amber-300 hover:bg-amber-500/10"
                >
                  Keynote Parse
                </button>
              </div>
            </div>

            {/* Parsed schedules (reactive — appears when user parses a table) */}
            <div className="space-y-1">
              <div className="text-[9px] text-[var(--muted)] uppercase tracking-wide">Parsed schedules</div>
              {(() => {
                const keywords = keywordsForMaterial(activeQtoWorkflow.materialType);
                const matchesKeywords = (s: typeof parsedSchedules[0]) =>
                  keywords.some((kw) =>
                    s.name.toLowerCase().includes(kw) ||
                    s.category.toLowerCase().includes(kw)
                  );
                // Show all parsed schedules, highlight matching ones
                const matching = parsedSchedules.filter(matchesKeywords);
                const other = parsedSchedules.filter((s) => !matchesKeywords(s));

                if (parsedSchedules.length === 0) {
                  return (
                    <div className="text-[10px] text-[var(--muted)] italic px-2 py-3 text-center border border-dashed border-[var(--border)] rounded">
                      No parsed schedules yet. Parse a table and it will appear here.
                    </div>
                  );
                }

                const renderScheduleButton = (s: typeof parsedSchedules[0], isMatch: boolean) => {
                  const key = `${s.pageNum}-${s.name}`;
                  return (
                  <button
                    key={key}
                    disabled={loadingScheduleKey === key}
                    onClick={async () => {
                      setScheduleError(null);
                      let headers: string[] = [];
                      let rows: Record<string, string>[] = [];
                      let tagColumn = "";

                      if (s.region?.data) {
                        headers = s.region.data.headers || [];
                        rows = s.region.data.rows || [];
                        tagColumn = s.region.data.tagColumn || headers[0] || "";
                      } else {
                        const localIntel = useViewerStore.getState().pageIntelligence[s.pageNum] as any;
                        const localPr = localIntel?.parsedRegions?.find((r: any) =>
                          r.data?.tableName === s.name || r.category === s.category
                        );
                        if (localPr?.data) {
                          headers = localPr.data.headers || [];
                          rows = localPr.data.rows || [];
                          tagColumn = localPr.data.tagColumn || headers[0] || "";
                        } else {
                          setLoadingScheduleKey(key);
                          try {
                            const res = await fetch(`/api/projects/${publicId}/pages?from=${s.pageNum}&to=${s.pageNum}`);
                            if (res.ok) {
                              const data = await res.json();
                              const pageData = data.pages?.[0];
                              const pr = pageData?.pageIntelligence?.parsedRegions?.find((r: any) =>
                                r.data?.tableName === s.name || r.category === s.category
                              );
                              if (pr?.data) {
                                headers = pr.data.headers || [];
                                rows = pr.data.rows || [];
                                tagColumn = pr.data.tagColumn || headers[0] || "";
                              }
                              if (pageData?.pageIntelligence) {
                                useViewerStore.getState().setPageIntelligence(s.pageNum, pageData.pageIntelligence);
                              }
                            } else {
                              setScheduleError(`Failed to load schedule data (HTTP ${res.status})`);
                            }
                          } catch (err) {
                            console.error("[AUTO_QTO] Failed to fetch schedule data:", err);
                            setScheduleError("Network error while loading schedule. Check your connection.");
                          } finally {
                            setLoadingScheduleKey(null);
                          }
                        }
                      }

                      if (headers.length === 0) {
                        setScheduleError("Could not load schedule data. Try parsing the schedule first.");
                        return;
                      }

                      updateWorkflowStep(activeQtoWorkflow, {
                        step: "confirm-tags",
                        schedulePageNumber: s.pageNum,
                        parsedSchedule: {
                          headers,
                          rows,
                          tagColumn,
                          tableName: s.name,
                          scheduleCategory: s.category,
                          sourcePageNumber: s.pageNum,
                        },
                      });
                    }}
                    className={`w-full text-left px-2 py-1.5 rounded border space-y-0.5 ${
                      isMatch
                        ? "border-green-500/30 bg-green-500/5 hover:bg-green-500/10"
                        : "border-[var(--border)] hover:bg-[var(--surface-hover)]"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-medium text-[var(--fg)]">{s.name}</span>
                      <span className={`text-[9px] ${isMatch ? "text-green-400" : "text-[var(--muted)]"}`}>
                        {loadingScheduleKey === key ? "Loading..." : isMatch ? "Use This" : "Use"}
                      </span>
                    </div>
                    <div className="text-[9px] text-[var(--muted)]">
                      {pageNames[s.pageNum] || `p.${s.pageNum}`} &middot; {s.rowCount} rows, {s.colCount} cols
                    </div>
                  </button>
                  );
                };

                return (
                  <div className="space-y-1">
                    {scheduleError && (
                      <div className="text-[10px] text-red-400 px-2 py-1 rounded bg-red-500/5 border border-red-500/20">
                        {scheduleError}
                      </div>
                    )}
                    {matching.map((s) => renderScheduleButton(s, true))}
                    {other.map((s) => renderScheduleButton(s, false))}
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* Step 3: Configure Workflow */}
        {activeQtoWorkflow.step === "confirm-tags" && (
          <ConfigureStep
            workflow={activeQtoWorkflow}
            updateWorkflowStep={updateWorkflowStep}
            pageNames={pageNames}
            summaries={summaries}
          />
        )}

        {/* Step 4: Run Mapping */}
        {activeQtoWorkflow.step === "map-tags" && (
          <MappingStep
            workflow={activeQtoWorkflow}
            updateWorkflowStep={updateWorkflowStep}
            publicId={publicId}
          />
        )}

        {/* Step 5: Review */}
        {(activeQtoWorkflow.step === "review" || activeQtoWorkflow.step === "done") && (
          <ReviewStep
            workflow={activeQtoWorkflow}
            updateWorkflowStep={updateWorkflowStep}
            setPage={setPage}
          />
        )}

        {/* Step progress indicator */}
        <div className="mt-auto px-3 py-2 border-t border-[var(--border)]">
          <div className="flex gap-1">
            {STEP_SEQUENCE.map((s, i) => (
              <div
                key={s}
                className={`flex-1 h-1 rounded-full ${
                  s === activeQtoWorkflow.step
                    ? "bg-emerald-400"
                    : STEP_SEQUENCE.indexOf(activeQtoWorkflow.step as typeof STEP_SEQUENCE[number]) > i
                    ? "bg-emerald-400/40"
                    : "bg-[var(--border)]"
                }`}
              />
            ))}
          </div>
          <div className="text-[8px] text-[var(--muted)] text-center mt-1">
            Step {STEP_SEQUENCE.indexOf(activeQtoWorkflow.step as typeof STEP_SEQUENCE[number]) + 1} of {STEP_SEQUENCE.length}
          </div>
        </div>
      </div>
    );
  }

  // ─── Material Picker (Step 1) ──────────────────────────
  return (
    <div className="flex-1 overflow-y-auto flex flex-col">
      <div className="px-3 py-2 border-b border-[var(--border)]">
        <div className="text-[11px] text-[var(--fg)] font-medium">Auto-QTO</div>
        <div className="text-[9px] text-[var(--muted)]">Pick a material to take off</div>
      </div>

      {/* SHIP 2 — Preflight hard block: if yolo_medium exclusion classes are
          missing, Auto-QTO can't produce a defensible count. Show the error
          + disable all start buttons until the user runs yolo_medium. */}
      {!preflight.ok && (
        <div className="mx-2 mt-2 px-3 py-3 rounded border border-amber-500/40 bg-amber-500/5 space-y-2">
          <div className="text-[11px] font-medium text-amber-300">Can&apos;t run Auto-QTO yet</div>
          <div className="text-[10px] text-[var(--muted)] leading-relaxed">
            Auto-QTO needs YOLO exclusion zones (tables, title blocks, drawings) to
            produce a defensible count. This project is missing:
          </div>
          <ul className="text-[10px] text-amber-200 pl-4 list-disc space-y-0.5">
            {preflight.missingStrict.map((c) => (
              <li key={c}><code className="text-amber-100">{c}</code></li>
            ))}
          </ul>
          <div className="text-[10px] text-[var(--muted)] leading-relaxed">
            Run <code className="text-[var(--fg)]">yolo_medium</code> on this project
            (Admin → Models → Run), then reload this tab.
          </div>
        </div>
      )}

      {/* Soft warning: recommended classes missing but not a hard block */}
      {preflight.ok && preflight.missingRecommended.length > 0 && (
        <div className="mx-2 mt-2 px-3 py-2 rounded border border-yellow-500/20 bg-yellow-500/5">
          <div className="text-[9px] text-yellow-200/80 leading-relaxed">
            Tip: run <code className="text-yellow-100">yolo_primitive</code> for
            higher classifier confidence. Missing:{" "}
            {preflight.missingRecommended.join(", ")}
          </div>
        </div>
      )}

      <div className="px-2 py-2 space-y-1">
        {MATERIALS.map((mat) => {
          const cat = mat.scheduleCategory;
          const detected = scheduleDetections[cat];
          const keywords = keywordsForMaterial(mat.type);
          const parsed = parsedSchedules.filter((s) =>
            keywords.some((kw) =>
              s.name.toLowerCase().includes(kw) || s.category.toLowerCase().includes(kw)
            )
          );

          return (
            <button
              key={mat.type}
              disabled={creating || !preflight.ok}
              onClick={() => startWorkflow(mat.type, mat.label)}
              className="w-full text-left px-3 py-2.5 rounded border border-[var(--border)] hover:border-emerald-500/40 hover:bg-emerald-500/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-[var(--border)] disabled:hover:bg-transparent"
            >
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 rounded bg-emerald-500/20 text-emerald-400 text-[10px] font-bold flex items-center justify-center">
                  {mat.icon}
                </span>
                <span className="text-xs font-medium text-[var(--fg)] flex-1">{mat.label}</span>
                {parsed.length > 0 && (
                  <span className="text-[9px] text-green-400 px-1.5 py-0.5 rounded bg-green-500/10">
                    {parsed.length} parsed
                  </span>
                )}
              </div>
              {detected && detected.length > 0 && (
                <div className="text-[9px] text-[var(--muted)] mt-0.5 ml-8">
                  Schedule detected on {detected[0].name} ({Math.round(detected[0].confidence * 100)}%)
                </div>
              )}
            </button>
          );
        })}

        {/* Custom material */}
        {showCustom ? (
          <div className="px-3 py-2 rounded border border-[var(--border)] space-y-1.5">
            <input
              autoFocus
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && customName.trim() && preflight.ok) startWorkflow(customName.trim().toLowerCase(), customName.trim());
                if (e.key === "Escape") { setShowCustom(false); setCustomName(""); }
              }}
              placeholder="Material name..."
              className="w-full text-xs px-2 py-1 bg-[var(--bg)] border border-[var(--border)] rounded outline-none focus:border-emerald-500"
            />
            <div className="flex gap-1">
              <button
                onClick={() => { setShowCustom(false); setCustomName(""); }}
                className="text-[10px] text-[var(--muted)] hover:text-[var(--fg)]"
              >Cancel</button>
              <button
                disabled={!customName.trim() || creating || !preflight.ok}
                onClick={() => startWorkflow(customName.trim().toLowerCase(), customName.trim())}
                className="text-[10px] px-2 py-0.5 rounded bg-emerald-600 text-white disabled:opacity-40 disabled:cursor-not-allowed"
              >Start</button>
            </div>
          </div>
        ) : (
          <button
            disabled={!preflight.ok}
            onClick={() => setShowCustom(true)}
            className="w-full text-left px-3 py-2 rounded border border-dashed border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-emerald-500/30 text-xs disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-[var(--muted)] disabled:hover:border-[var(--border)]"
          >
            + Custom material...
          </button>
        )}
      </div>

      {/* Previous workflows */}
      {qtoWorkflows.length > 0 && (
        <div className="px-2 py-2 border-t border-[var(--border)] mt-auto">
          <div className="text-[9px] text-[var(--muted)] uppercase tracking-wide px-1 pb-1">Previous workflows</div>
          {qtoWorkflows.map((w) => (
            <button
              key={w.id}
              onClick={() => setActiveQtoWorkflow(w)}
              className="w-full text-left px-2 py-1.5 rounded hover:bg-[var(--surface-hover)] text-[10px]"
            >
              <span className="text-[var(--fg)]">{w.materialLabel || w.materialType}</span>
              <span className="text-[var(--muted)] ml-1">
                ({w.step === "done" ? "completed" : `step ${STEP_SEQUENCE.indexOf(w.step as typeof STEP_SEQUENCE[number]) + 1}/${STEP_SEQUENCE.length}`})
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Step 3: Configure Workflow
// ═══════════════════════════════════════════════════════════════

const TAG_HEADER_HINTS = ["TAG", "MARK", "NO", "NO.", "NUMBER", "NUM", "ITEM", "TYPE", "ID"];
const RE_TAG = /^[A-Z]{0,3}-?\d{1,4}[A-Z]?$/i;

function ConfigureStep({ workflow, updateWorkflowStep, pageNames, summaries }: {
  workflow: QtoWorkflow;
  updateWorkflowStep: (w: QtoWorkflow, u: Partial<QtoWorkflow>) => Promise<void>;
  pageNames: Record<number, string>;
  summaries: any;
}) {
  const schedule = workflow.parsedSchedule;
  const numPages = useViewerStore((s) => s.numPages);

  // SHIP 2: item-type drives which sub-controls are rendered + how the
  // engine dispatches. Defaults to "yolo-with-inner-text" for backward compat.
  const [itemType, setItemType] = useState<QtoItemType>(workflow.itemType || "yolo-with-inner-text");
  const [tagShapeClass, setTagShapeClass] = useState(workflow.tagShapeClass || "");

  // Derived flags per item type — controls which sub-pickers render.
  const needsSchedule = itemType !== "yolo-only";       // Type 1 ignores tag column
  const needsYoloClass = itemType !== "text-only";       // Type 2 is pure text
  const needsTagShape = itemType === "yolo-object-with-tag-shape"; // Type 4 only

  // SHIP 2: preflight — duplicate of the top-level preflight so the Run
  // Mapping button gates even if user started the workflow before classes
  // were ready, or if they got deleted since.
  const preflight = useMemo(
    () => computeQtoPreflight(summaries?.annotationSummary?.categoryCounts),
    [summaries],
  );

  // 3a: Tag column
  const [tagColumn, setTagColumn] = useState(schedule?.tagColumn || "");

  // Auto-suggest tag column on mount
  useEffect(() => {
    if (tagColumn || !schedule?.headers?.length) return;
    // Check headers
    const headerMatch = schedule.headers.find((h: string) =>
      TAG_HEADER_HINTS.includes(h.toUpperCase().trim())
    );
    if (headerMatch) { setTagColumn(headerMatch); return; }
    // Check data values
    for (const h of schedule.headers) {
      const values = (schedule.rows || []).map((r: Record<string, string>) => r[h]?.trim()).filter(Boolean);
      const tagRatio = values.filter((v: string) => RE_TAG.test(v)).length / Math.max(values.length, 1);
      if (tagRatio >= 0.5) { setTagColumn(h); return; }
    }
    // Default to first column
    if (schedule.headers.length > 0) setTagColumn(schedule.headers[0]);
  }, [schedule, tagColumn]);

  const uniqueTags = useMemo(() => {
    if (!schedule?.rows || !tagColumn) return [];
    return [...new Set(
      (schedule.rows as Record<string, string>[]).map((r) => r[tagColumn]?.trim()).filter(Boolean)
    )];
  }, [schedule, tagColumn]);

  // 3b: YOLO class
  const [yoloClass, setYoloClass] = useState(workflow.yoloClassFilter || "");
  const availableClasses = useMemo(() => {
    const cats = summaries?.annotationSummary?.categoryCounts;
    if (!cats) return [];
    return Object.entries(cats as Record<string, { count: number }>)
      .map(([name, data]) => ({ name, count: data.count }))
      .sort((a, b) => b.count - a.count);
  }, [summaries]);

  // Tag-shape class list for Type 4 — filtered to only primitive tag shapes
  // (circle, hexagon, etc.) so users don't accidentally pick "door_single"
  // as a tag shape.
  const tagShapeOptions = useMemo(() => {
    const validSet = new Set<string>(QTO_TAG_SHAPE_CLASSES);
    return availableClasses.filter((c) => validSet.has(c.name));
  }, [availableClasses]);

  // 3c: Page selection
  const allPageNums = useMemo(() =>
    Array.from({ length: numPages }, (_, i) => i + 1), [numPages]);

  const pageGroups = useMemo(() => {
    const groups: Record<string, number[]> = {};
    for (const pn of allPageNums) {
      const prefix = extractDisciplinePrefix(pageNames[pn] || `Page ${pn}`);
      if (!groups[prefix]) groups[prefix] = [];
      groups[prefix].push(pn);
    }
    return Object.entries(groups).sort(([a], [b]) => disciplineOrder(a) - disciplineOrder(b));
  }, [allPageNums, pageNames]);

  const [selectedPages, setSelectedPages] = useState<Set<number>>(() => {
    const saved = workflow.userEdits?.selectedPages;
    return saved ? new Set(saved) : new Set(allPageNums);
  });

  const toggleGroup = (pages: number[]) => {
    setSelectedPages((prev) => {
      const next = new Set(prev);
      const allSelected = pages.every((p) => next.has(p));
      if (allSelected) pages.forEach((p) => next.delete(p));
      else pages.forEach((p) => next.add(p));
      return next;
    });
  };

  // canProceed now depends on itemType — different types have different
  // required inputs. Also gated on preflight.ok.
  const canProceed = (() => {
    if (!preflight.ok) return false;
    if (selectedPages.size === 0) return false;
    // Type 1 — only needs a yolo class
    if (itemType === "yolo-only") return !!yoloClass;
    // Type 4 — needs tag column, object class, and tag shape class
    if (itemType === "yolo-object-with-tag-shape") {
      return !!tagColumn && uniqueTags.length > 0 && !!yoloClass && !!tagShapeClass;
    }
    // Types 2, 3, 5 — need a tag column + at least one tag
    if (!tagColumn || uniqueTags.length === 0) return false;
    // Types 3, 5 — also need a yolo class. Type 2 — no yolo class needed.
    if (needsYoloClass && !yoloClass) return false;
    return true;
  })();

  const handleRun = async () => {
    await updateWorkflowStep(workflow, {
      step: "map-tags",
      yoloClassFilter: yoloClass || null,
      itemType,
      tagShapeClass: itemType === "yolo-object-with-tag-shape" ? (tagShapeClass || null) : null,
      parsedSchedule: { ...schedule!, tagColumn },
      userEdits: {
        ...(workflow.userEdits || { quantityOverrides: {} }),
        selectedPages: [...selectedPages],
      },
    });
  };

  return (
    <div className="px-3 py-3 space-y-4 flex-1 overflow-y-auto">
      <div className="text-[11px] text-green-400 font-medium">
        Schedule: {schedule?.tableName} ({schedule?.rows?.length || 0} rows)
      </div>

      {/* SHIP 2 — Preflight hard block inside the workflow: if the user
          started this workflow before yolo_medium was run (or the classes
          got deleted), show the block here. */}
      {!preflight.ok && (
        <div className="px-3 py-2.5 rounded border border-amber-500/40 bg-amber-500/5 space-y-1.5">
          <div className="text-[10px] font-medium text-amber-300">Can&apos;t run mapping yet</div>
          <div className="text-[9px] text-[var(--muted)] leading-relaxed">
            Missing YOLO exclusion classes: {preflight.missingStrict.map((c) => <code key={c} className="text-amber-200 mx-0.5">{c}</code>)}.
            Run <code className="text-[var(--fg)]">yolo_medium</code> on this project first.
          </div>
        </div>
      )}

      {/* 3-0: SHIP 2 item-type picker — drives which sub-controls render. */}
      <div>
        <div className="text-[10px] text-[var(--muted)] uppercase tracking-wide mb-1.5">Item Type</div>
        <div className="space-y-1">
          {([
            { value: "yolo-with-inner-text", label: "Shape with inner text", hint: "Most schedules — tag text sits inside the object bbox (doors, rooms)" },
            { value: "yolo-only", label: "Shape only (count all)", hint: "Every instance of a YOLO class counts, no text matching (outlets, diffusers)" },
            { value: "yolo-object-with-tag-shape", label: "Object with tag shape", hint: "Main object tagged by a separate shape (door + circle containing 'D-101')" },
            { value: "yolo-object-with-nearby-text", label: "Object with nearby text", hint: "Object label floats next to the object, no enclosing tag shape" },
            { value: "text-only", label: "Free-floating text", hint: "Pure OCR text match, no object binding" },
          ] as const).map((opt) => (
            <button
              key={opt.value}
              onClick={() => setItemType(opt.value)}
              className={`w-full text-left px-2 py-1.5 rounded border transition-colors ${
                itemType === opt.value
                  ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-200"
                  : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--muted)]/40"
              }`}
            >
              <div className="text-[10px] font-medium">{opt.label}</div>
              <div className="text-[9px] text-[var(--muted)] leading-snug">{opt.hint}</div>
            </button>
          ))}
        </div>
      </div>

      {/* 3a: Tag Column — hidden for yolo-only (tags are ignored) */}
      {needsSchedule && (
        <div>
          <div className="text-[10px] text-[var(--muted)] uppercase tracking-wide mb-1.5">Tag Column</div>
          <div className="flex flex-wrap gap-1">
            {(schedule?.headers || []).map((h: string) => (
              <button
                key={h}
                onClick={() => setTagColumn(h)}
                className={`px-2 py-1 rounded text-[10px] border transition-colors ${
                  tagColumn === h
                    ? "border-green-500/50 bg-green-500/10 text-green-300"
                    : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--muted)]/40"
                }`}
              >
                {h}
              </button>
            ))}
          </div>
          {uniqueTags.length > 0 && (
            <div className="text-[9px] text-[var(--muted)] mt-1.5">
              {uniqueTags.length} tags: {uniqueTags.slice(0, 8).join(", ")}{uniqueTags.length > 8 ? "..." : ""}
            </div>
          )}
          {tagColumn && uniqueTags.length === 0 && (
            <div className="text-[9px] text-amber-400 mt-1.5">
              No tags found in &quot;{tagColumn}&quot; column. Pick a different column.
            </div>
          )}
        </div>
      )}

      {/* Type 1 hint — tag column is ignored */}
      {!needsSchedule && (
        <div className="text-[9px] text-[var(--muted)] italic leading-relaxed">
          Shape-only mode counts every instance of the selected YOLO class on the
          selected pages. Tag column and schedule rows are ignored.
        </div>
      )}

      {/* 3b: YOLO Object Class — shown for all types except text-only */}
      {needsYoloClass && (
        <div>
          <div className="text-[10px] text-[var(--muted)] uppercase tracking-wide mb-1.5">
            {needsTagShape ? "Object Class" : "Detection Shape"}
          </div>
          <div className="space-y-1">
            {availableClasses.map((cls) => (
              <button
                key={cls.name}
                onClick={() => setYoloClass(cls.name)}
                className={`w-full text-left px-2 py-1.5 rounded text-[10px] border transition-colors ${
                  yoloClass === cls.name
                    ? "border-cyan-500/50 bg-cyan-500/10 text-cyan-300"
                    : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--muted)]/40"
                }`}
              >
                {cls.name} <span className="text-[var(--muted)]">({cls.count})</span>
              </button>
            ))}
            {availableClasses.length === 0 && (
              <div className="text-[9px] text-amber-400 px-1">
                No YOLO detections in project. Run a YOLO model first.
              </div>
            )}
          </div>
        </div>
      )}

      {/* 3b2: Tag Shape Class (Type 4 only) */}
      {needsTagShape && (
        <div>
          <div className="text-[10px] text-[var(--muted)] uppercase tracking-wide mb-1.5">Tag Shape Class</div>
          <div className="text-[9px] text-[var(--muted)] leading-relaxed mb-1">
            The primitive shape that contains the tag text (e.g. a circle
            containing &quot;D-101&quot; next to a door).
          </div>
          <div className="space-y-1">
            {tagShapeOptions.map((cls) => (
              <button
                key={cls.name}
                onClick={() => setTagShapeClass(cls.name)}
                className={`w-full text-left px-2 py-1.5 rounded text-[10px] border transition-colors ${
                  tagShapeClass === cls.name
                    ? "border-violet-500/50 bg-violet-500/10 text-violet-300"
                    : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--muted)]/40"
                }`}
              >
                {cls.name} <span className="text-[var(--muted)]">({cls.count})</span>
              </button>
            ))}
            {tagShapeOptions.length === 0 && (
              <div className="text-[9px] text-amber-400 px-1">
                No tag-shape primitives in project. Run <code>yolo_primitive</code> first.
              </div>
            )}
          </div>
        </div>
      )}

      {/* 3c: Page Selection */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] text-[var(--muted)] uppercase tracking-wide">Pages ({selectedPages.size}/{numPages})</span>
          <button
            onClick={() => setSelectedPages(selectedPages.size === numPages ? new Set() : new Set(allPageNums))}
            className="text-[9px] text-[var(--accent)] hover:underline"
          >
            {selectedPages.size === numPages ? "Exclude All" : "Include All"}
          </button>
        </div>
        <div className="space-y-0.5 max-h-40 overflow-y-auto">
          {pageGroups.map(([prefix, pages]) => {
            const selected = pages.filter((p) => selectedPages.has(p)).length;
            return (
              <button
                key={prefix}
                onClick={() => toggleGroup(pages)}
                className={`w-full flex items-center justify-between px-2 py-1 rounded text-[10px] border transition-colors ${
                  selected === pages.length
                    ? "border-emerald-500/30 bg-emerald-500/5 text-[var(--fg)]"
                    : selected > 0
                    ? "border-amber-500/30 bg-amber-500/5 text-[var(--fg)]"
                    : "border-[var(--border)] text-[var(--muted)]"
                }`}
              >
                <span>{DISCIPLINE_NAMES[prefix] || prefix} ({prefix})</span>
                <span className="text-[9px]">{selected}/{pages.length}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Run button */}
      <button
        disabled={!canProceed}
        onClick={handleRun}
        className="w-full py-2 rounded bg-emerald-600 text-white text-xs font-medium disabled:opacity-40 hover:bg-emerald-500 transition-colors"
      >
        {itemType === "yolo-only"
          ? `Run Mapping (count all ${yoloClass || "shapes"}, ${selectedPages.size} pages)`
          : `Run Mapping (${uniqueTags.length} tags, ${selectedPages.size} pages)`}
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Step 4: Run Mapping
// ═══════════════════════════════════════════════════════════════

function MappingStep({ workflow, updateWorkflowStep, publicId }: {
  workflow: QtoWorkflow;
  updateWorkflowStep: (w: QtoWorkflow, u: Partial<QtoWorkflow>) => Promise<void>;
  publicId: string;
}) {
  const [mapping, setMapping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasRun = useRef(false);

  const schedule = workflow.parsedSchedule;
  const tags = useMemo(() => {
    if (!schedule?.rows || !schedule?.tagColumn) return [];
    return [...new Set(
      (schedule.rows as Record<string, string>[]).map((r) => r[schedule.tagColumn]?.trim()).filter(Boolean)
    )];
  }, [schedule]);

  const selectedPages = workflow.userEdits?.selectedPages;

  // SHIP 2: Type 1 bypasses tag matching — count all shapes of the yolo
  // class. We send tags[yoloClass] so the route still has a key to respond
  // with, but MappingStep later builds just ONE line item keyed by the
  // yolo class name (not N duplicated line items).
  const isYoloOnly = workflow.itemType === "yolo-only";
  const effectiveTags = isYoloOnly
    ? (workflow.yoloClassFilter ? [workflow.yoloClassFilter] : [])
    : tags;

  useEffect(() => {
    if (hasRun.current || mapping || !schedule) return;
    if (effectiveTags.length === 0) return;
    hasRun.current = true;
    setMapping(true);
    setError(null);

    const controller = new AbortController();
    fetch(`/api/projects/${publicId}/map-tags-batch`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tags: effectiveTags,
        yoloClass: workflow.yoloClassFilter || undefined,
        itemType: workflow.itemType,
        tagShapeClass: workflow.tagShapeClass || undefined,
        selectedPages,
        // Auto-QTO always runs strict. Only tier=high matches survive —
        // reproduces the pre-Phase-2 applyExclusionFilter behavior
        // (drops inside_table + inside_title_block + outside_drawings).
        strictnessMode: "strict",
      }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        return res.json();
      })
      .then(({ results }: { results: Record<string, ScoredMatch[]> }) => {
        // Build QtoLineItems. Auto-QTO filters to tier=high server-side, so
        // everything arriving here is kept. We preserve confidenceTier +
        // dropReason on the line-item instances so the review UI can still
        // surface per-instance audit info (even though for strict mode every
        // instance is tier="high").
        let lineItems: QtoLineItem[];

        const buildInstance = (i: ScoredMatch) => ({
          pageNumber: i.pageNumber,
          bbox: i.bbox,
          confidence: i.confidence,
          confidenceTier: i.confidenceTier,
          dropReason: i.dropReason,
        });

        const computeFlags = (instances: ScoredMatch[]): QtoFlag[] => {
          const flags: QtoFlag[] = [];
          if (instances.length === 0) flags.push("not-found");
          const mediumCount = instances.filter((i) => i.confidenceTier === "medium").length;
          const lowCount = instances.filter((i) => i.confidenceTier === "low").length;
          // Fallback for pre-Phase-2 instances missing tier: use confidence
          const fuzzyCount = instances.filter((i) =>
            i.confidenceTier === undefined && i.confidence < 1.0
          ).length;
          if (mediumCount > 0) flags.push("medium-confidence");
          if (lowCount > 0 || fuzzyCount > 0) flags.push("low-confidence");
          return flags;
        };

        if (isYoloOnly) {
          // Type 1 — single line item keyed by yolo class
          const yoloKey = workflow.yoloClassFilter || "";
          const instances = results[yoloKey] || [];
          lineItems = [{
            tag: yoloKey,
            specs: {},
            autoQuantity: instances.length,
            instances: instances.map(buildInstance),
            pages: [...new Set(instances.map((i) => i.pageNumber))].sort((a, b) => a - b),
            flags: computeFlags(instances),
            notes: "",
          }];
        } else {
          // Types 2, 3, 4, 5 — per-tag line items
          lineItems = tags.map((tag) => {
            const instances = results[tag] || [];
            const scheduleRow = (schedule.rows as Record<string, string>[]).find(
              (r) => r[schedule.tagColumn]?.trim() === tag
            );
            const specs: Record<string, string> = {};
            for (const h of schedule.headers) {
              if (h !== schedule.tagColumn) specs[h] = scheduleRow?.[h] || "";
            }
            return {
              tag,
              specs,
              autoQuantity: instances.length,
              instances: instances.map(buildInstance),
              pages: [...new Set(instances.map((i) => i.pageNumber))].sort((a, b) => a - b),
              flags: computeFlags(instances),
              notes: "",
            };
          });
        }

        updateWorkflowStep(workflow, { step: "review", lineItems });
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        setError(err.message || "Mapping failed");
        setMapping(false);
      });

    return () => controller.abort();
  }, [tags, effectiveTags, isYoloOnly, schedule, workflow, publicId, updateWorkflowStep, mapping, selectedPages]);

  return (
    <div className="px-3 py-6 flex flex-col items-center gap-3">
      {error ? (
        <>
          <div className="text-red-400 text-xs text-center">{error}</div>
          <button
            onClick={() => { hasRun.current = false; setMapping(false); setError(null); }}
            className="text-xs px-3 py-1 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
          >
            Retry
          </button>
        </>
      ) : (
        <>
          <div className="w-8 h-8 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
          <div className="text-xs text-[var(--fg)]">Mapping {tags.length} tags</div>
          <div className="text-[10px] text-[var(--muted)]">
            across {selectedPages?.length || "all"} pages...
          </div>
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Step 5: Review
// ═══════════════════════════════════════════════════════════════

function ReviewStep({ workflow, updateWorkflowStep, setPage }: {
  workflow: QtoWorkflow;
  updateWorkflowStep: (w: QtoWorkflow, u: Partial<QtoWorkflow>) => Promise<void>;
  setPage: (n: number) => void;
}) {
  const lineItems = workflow.lineItems || [];
  const schedule = workflow.parsedSchedule;
  // Track which page index is currently visible per-tag for ◀/▶ cycling
  const [pageIdxByTag, setPageIdxByTag] = useState<Record<string, number>>({});
  const [csvModalOpen, setCsvModalOpen] = useState(false);

  const activateTag = useCallback((li: QtoLineItem) => {
    const store = useViewerStore.getState();
    const existing = store.yoloTags.find((t) => t.tagText === li.tag && t.source === "schedule");
    if (existing) {
      store.setActiveYoloTagId(existing.id);
      store.setYoloTagFilter(existing.id);
    } else {
      const newTag = {
        id: `qto-${li.tag}-${Date.now()}`,
        name: li.tag,
        tagText: li.tag,
        yoloClass: workflow.yoloClassFilter || "",
        yoloModel: "",
        source: "schedule" as const,
        scope: "project" as const,
        instances: li.instances.map((inst) => ({
          pageNumber: inst.pageNumber,
          annotationId: -1,
          bbox: inst.bbox,
          confidence: inst.confidence,
        })),
      };
      store.addYoloTag(newTag);
      store.setActiveYoloTagId(newTag.id);
      store.setYoloTagFilter(newTag.id);
    }
  }, [workflow.yoloClassFilter]);

  const cyclePage = useCallback((li: QtoLineItem, delta: number) => {
    if (li.pages.length === 0) return;
    const current = pageIdxByTag[li.tag] ?? 0;
    const next = (current + delta + li.pages.length) % li.pages.length;
    setPageIdxByTag((s) => ({ ...s, [li.tag]: next }));
    setPage(li.pages[next]);
    activateTag(li);
  }, [pageIdxByTag, setPage, activateTag]);

  const totalInstances = lineItems.reduce((s, li) => s + li.autoQuantity, 0);
  const uniquePages = new Set(lineItems.flatMap((li) => li.pages)).size;
  const notFoundCount = lineItems.filter((li) => li.flags.includes("not-found")).length;

  const specHeaders = useMemo(
    () => schedule ? schedule.headers.filter((h: string) => h !== schedule.tagColumn) : [],
    [schedule]
  );

  // Row data for the editable CSV modal. Includes tag + specs + QTY (with manual override) + Notes.
  const csvModalHeaders = ["Tag", ...specHeaders, "QTY", "Pages", "Flags", "Notes"];
  const csvModalReadOnly = useMemo(
    () => new Set(["Tag", ...specHeaders, "Pages", "Flags"]),
    [specHeaders]
  );
  const csvModalRows = useMemo(() => lineItems.map((li) => {
    const override = workflow.userEdits?.quantityOverrides?.[li.tag];
    const qty = override ?? li.autoQuantity;
    const row: Record<string, string> = {
      Tag: li.tag,
      QTY: String(qty),
      Pages: li.pages.join(", "),
      Flags: li.flags.join(", "),
      Notes: li.notes || "",
    };
    for (const h of specHeaders) row[h] = li.specs[h] || "";
    return row;
  }), [lineItems, specHeaders, workflow.userEdits?.quantityOverrides]);

  const handleCsvCellChange = (rowIndex: number, column: string, value: string) => {
    const li = lineItems[rowIndex];
    if (!li) return;
    const newLineItems = [...lineItems];
    const currentEdits = workflow.userEdits || { quantityOverrides: {} };

    if (column === "Notes") {
      newLineItems[rowIndex] = { ...li, notes: value };
      updateWorkflowStep(workflow, { lineItems: newLineItems });
    } else if (column === "QTY") {
      const num = parseInt(value, 10);
      const overrides = { ...(currentEdits.quantityOverrides || {}) };
      if (!isNaN(num) && num >= 0 && num !== li.autoQuantity) {
        overrides[li.tag] = num;
        newLineItems[rowIndex] = {
          ...li,
          manualQuantity: num,
          flags: li.flags.includes("manual-override") ? li.flags : [...li.flags, "manual-override"],
        };
      } else {
        // Clearing or matching auto — remove override
        delete overrides[li.tag];
        newLineItems[rowIndex] = {
          ...li,
          manualQuantity: undefined,
          flags: li.flags.filter((f) => f !== "manual-override"),
        };
      }
      updateWorkflowStep(workflow, {
        lineItems: newLineItems,
        userEdits: { ...currentEdits, quantityOverrides: overrides },
      });
    }
  };

  const exportCsv = () => {
    if (!schedule) return;
    const headers = ["Tag", ...specHeaders, "QTY", "Pages", "Flags", "Notes"];
    const rows = lineItems.map((li) => {
      const override = workflow.userEdits?.quantityOverrides?.[li.tag];
      const qty = override ?? li.autoQuantity;
      return [
        escCsv(li.tag),
        ...specHeaders.map((h: string) => escCsv(li.specs[h] || "")),
        String(qty),
        escCsv(li.pages.join(", ")),
        escCsv(li.flags.join(", ")),
        escCsv(li.notes || ""),
      ].join(",");
    });
    const csv = [headers.map(escCsv).join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `qto_${workflow.materialType}_export.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex-1 overflow-y-auto flex flex-col">
      {/* Summary */}
      <div className="px-3 py-2 border-b border-[var(--border)]">
        <div className="text-[11px] text-emerald-400 font-medium">
          {totalInstances} instances of {lineItems.length} tags across {uniquePages} pages
        </div>
        {notFoundCount > 0 && (
          <div className="text-[10px] text-red-400">{notFoundCount} tags not found on drawings</div>
        )}
      </div>

      {/* Results table */}
      <div className="flex-1 overflow-y-auto">
        {lineItems.map((li) => {
          const descParts = Object.values(li.specs).filter(Boolean).slice(0, 3);
          const currentIdx = pageIdxByTag[li.tag] ?? 0;
          const hasMultiPages = li.pages.length > 1;
          return (
            <div
              key={li.tag}
              onClick={() => {
                if (li.instances.length === 0) return;
                setPage(li.pages[0] ?? li.instances[0].pageNumber);
                setPageIdxByTag((s) => ({ ...s, [li.tag]: 0 }));
                activateTag(li);
              }}
              className="w-full text-left px-3 py-1.5 border-b border-[var(--border)]/50 hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono font-medium text-[var(--fg)] w-12 shrink-0">{li.tag}</span>
                <span className="text-[10px] text-[var(--muted)] truncate flex-1">
                  {descParts.join(" / ") || "-"}
                </span>
                <span className={`text-[11px] font-medium w-6 text-right shrink-0 ${
                  li.autoQuantity > 0 ? "text-emerald-400" : "text-red-400"
                }`}>
                  {li.autoQuantity}
                </span>
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                {hasMultiPages ? (
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      onClick={(e) => { e.stopPropagation(); cyclePage(li, -1); }}
                      className="text-[10px] w-4 h-4 rounded hover:bg-[var(--surface-hover)] text-[var(--muted)] hover:text-[var(--fg)] flex items-center justify-center"
                      title="Previous page"
                    >&#9664;</button>
                    <span className="text-[9px] text-[var(--muted)] tabular-nums w-10 text-center">
                      {currentIdx + 1}/{li.pages.length}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); cyclePage(li, 1); }}
                      className="text-[10px] w-4 h-4 rounded hover:bg-[var(--surface-hover)] text-[var(--muted)] hover:text-[var(--fg)] flex items-center justify-center"
                      title="Next page"
                    >&#9654;</button>
                  </div>
                ) : (
                  <span className="text-[9px] text-[var(--muted)] w-12 shrink-0">
                    {li.pages.length > 0 ? `${li.pages.length} pg` : ""}
                  </span>
                )}
                <span className="text-[9px] text-[var(--muted)] truncate flex-1">
                  {li.pages.slice(0, 5).join(", ")}{li.pages.length > 5 ? "..." : ""}
                </span>
                {li.flags.includes("not-found") && (
                  <span className="text-[8px] px-1 py-0.5 rounded bg-red-500/10 text-red-400 shrink-0">Not Found</span>
                )}
                {li.flags.includes("medium-confidence") && (() => {
                  const medium = li.instances.filter((i) => i.confidenceTier === "medium").length;
                  return (
                    <span
                      className="text-[8px] px-1 py-0.5 rounded bg-amber-500/10 text-amber-400 shrink-0"
                      title={`${medium} of ${li.instances.length} instances are medium-tier (e.g., unclassified region, weak pattern match)`}
                    >
                      {medium} med
                    </span>
                  );
                })()}
                {li.flags.includes("low-confidence") && (() => {
                  // Prefer tier-based count when available; fall back to
                  // fuzzy-confidence count for pre-Phase-2 data.
                  const lowTier = li.instances.filter((i) => i.confidenceTier === "low").length;
                  const fuzzy = li.instances.filter((i) =>
                    i.confidenceTier === undefined && i.confidence < 1.0
                  ).length;
                  const count = lowTier + fuzzy;
                  const label = lowTier > 0 ? "low" : "fuzzy";
                  return (
                    <span
                      className="text-[8px] px-1 py-0.5 rounded bg-red-500/10 text-red-400 shrink-0"
                      title={`${count} of ${li.instances.length} instances are ${label}-tier matches`}
                    >
                      {count} {label}
                    </span>
                  );
                })()}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer actions */}
      <div className="px-3 py-2 border-t border-[var(--border)] space-y-1.5">
        <div className="flex gap-1.5">
          <button
            onClick={() => setCsvModalOpen(true)}
            className="flex-1 py-1.5 rounded border border-cyan-500/40 text-cyan-400 text-xs font-medium hover:bg-cyan-500/10"
          >
            View as CSV
          </button>
          <button
            onClick={exportCsv}
            className="flex-1 py-1.5 rounded bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-500"
          >
            Export CSV
          </button>
        </div>
        <div className="flex gap-1.5">
          <button
            onClick={() => updateWorkflowStep(workflow, { step: "confirm-tags" })}
            className="flex-1 py-1 rounded border border-[var(--border)] text-[10px] text-[var(--muted)] hover:text-[var(--fg)]"
          >
            Back
          </button>
          <button
            onClick={() => updateWorkflowStep(workflow, { step: "done", exportedAt: new Date().toISOString() })}
            className="flex-1 py-1 rounded border border-emerald-500/40 text-[10px] text-emerald-400 hover:bg-emerald-500/10"
          >
            Done
          </button>
        </div>
      </div>
      <TakeoffCsvModal
        open={csvModalOpen}
        onClose={() => setCsvModalOpen(false)}
        title={`${workflow.materialLabel || workflow.materialType} — QTO Results`}
        headers={csvModalHeaders}
        rows={csvModalRows}
        readOnlyColumns={csvModalReadOnly}
        onCellChange={handleCsvCellChange}
        onExport={exportCsv}
        onRowClick={(rowIdx) => {
          const li = lineItems[rowIdx];
          if (!li || li.pages.length === 0) return;
          setPage(li.pages[0]);
        }}
      />
    </div>
  );
}
