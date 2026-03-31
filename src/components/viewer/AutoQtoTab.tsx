"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useViewerStore, useProject, useNavigation, useQtoWorkflow, useSummaries, isDemoFeatureEnabled } from "@/stores/viewerStore";
import type { QtoWorkflow, QtoLineItem, QtoFlag, YoloTagInstance } from "@/types";
import { extractDisciplinePrefix, disciplineOrder, DISCIPLINE_NAMES } from "@/lib/page-utils";
import { escCsv } from "@/lib/table-parse-utils";

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

  // Find pages with detected schedules for each material type
  // Uses summary catalog when available (works across all pages without loading them)
  const scheduleDetections = useMemo(() => {
    if (summaries?.schedules) {
      const detections: Record<string, { pageNum: number; name: string; confidence: number }[]> = {};
      for (const s of summaries.schedules) {
        if (!detections[s.category]) detections[s.category] = [];
        detections[s.category].push({
          pageNum: s.pageNum,
          name: pageNames[s.pageNum] || s.name,
          confidence: s.confidence,
        });
      }
      return detections;
    }
    // Fallback: iterate loaded pageIntelligence (old projects without summaries)
    const detections: Record<string, { pageNum: number; name: string; confidence: number }[]> = {};
    for (const [pn, intel] of Object.entries(pageIntelligence)) {
      const pi = intel as any;
      if (pi?.classifiedTables) {
        for (const t of pi.classifiedTables) {
          if (!detections[t.category]) detections[t.category] = [];
          detections[t.category].push({
            pageNum: Number(pn),
            name: pageNames[Number(pn)] || `Page ${pn}`,
            confidence: t.confidence,
          });
        }
      }
    }
    return detections;
  }, [summaries, pageIntelligence, pageNames]);

  // Find already-parsed schedules (from parsedRegions)
  const parsedSchedules = useMemo(() => {
    if (summaries?.parsedTables) {
      return summaries.parsedTables.map((pt) => ({
        pageNum: pt.pageNum,
        region: null,
        name: pt.name,
        rowCount: pt.rowCount,
        colCount: pt.colCount,
        category: pt.category,
      }));
    }
    // Fallback: iterate loaded pageIntelligence
    const schedules: { pageNum: number; region: any; name: string; rowCount: number; colCount: number; category: string }[] = [];
    for (const [pn, intel] of Object.entries(pageIntelligence)) {
      const pi = intel as any;
      if (pi?.parsedRegions) {
        for (const pr of pi.parsedRegions) {
          if (pr.type === "schedule" || pr.type === "keynote") {
            schedules.push({
              pageNum: Number(pn),
              region: pr,
              name: pr.data?.tableName || pr.category || "Unnamed",
              rowCount: pr.data?.rowCount || pr.data?.rows?.length || 0,
              colCount: pr.data?.columnCount || pr.data?.headers?.length || 0,
              category: pr.category || "",
            });
          }
        }
      }
    }
    return schedules;
  }, [summaries, pageIntelligence]);

  // Load workflows from API on mount (skip for demo — no persisted workflows)
  const [loaded, setLoaded] = useState(false);
  if (!loaded && publicId && !isDemo) {
    setLoaded(true);
    fetch(`/api/qto-workflows?projectId=${publicId}`)
      .then((r) => r.ok ? r.json() : [])
      .then(setQtoWorkflows)
      .catch(() => {});
  }

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
        yoloModelFilter: null,
        yoloClassFilter: null,
        tagPattern: null,
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

        {/* Step 2: Select Schedule */}
        {activeQtoWorkflow.step === "select-schedule" && (
          <div className="px-3 py-3 space-y-3">
            <div className="text-[11px] text-[var(--fg)] font-medium">Select {activeQtoWorkflow.materialLabel} Schedule</div>

            {/* Check for already-parsed schedules matching this material */}
            {(() => {
              const materialKey = activeQtoWorkflow.materialType.toLowerCase();
              const matching = parsedSchedules.filter((s) =>
                s.name.toLowerCase().includes(materialKey) ||
                s.category.toLowerCase().includes(materialKey)
              );

              if (matching.length > 0) {
                return (
                  <div className="space-y-1.5">
                    <div className="text-[10px] text-[var(--muted)]">Found parsed schedules:</div>
                    {matching.map((s, i) => (
                      <button
                        key={i}
                        onClick={() => {
                          updateWorkflowStep(activeQtoWorkflow, {
                            step: "confirm-tags",
                            schedulePageNumber: s.pageNum,
                            parsedSchedule: {
                              headers: s.region.data?.headers || [],
                              rows: s.region.data?.rows || [],
                              tagColumn: s.region.data?.tagColumn || s.region.data?.headers?.[0] || "",
                              tableName: s.name,
                              scheduleCategory: s.category,
                              sourcePageNumber: s.pageNum,
                            },
                          });
                        }}
                        className="w-full text-left px-3 py-2 rounded border border-green-500/30 bg-green-500/5 hover:bg-green-500/10 space-y-0.5"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-medium text-[var(--fg)]">{s.name}</span>
                          <span className="text-[9px] text-green-400">Use This</span>
                        </div>
                        <div className="text-[10px] text-[var(--muted)]">
                          {pageNames[s.pageNum] || `p.${s.pageNum}`} &middot; {s.rowCount} rows, {s.colCount} cols
                        </div>
                      </button>
                    ))}
                  </div>
                );
              }

              // No matching parsed schedules
              return (
                <div className="space-y-2">
                  <div className="text-[10px] text-[var(--muted)] px-1">
                    No {(activeQtoWorkflow.materialLabel || activeQtoWorkflow.materialType).toLowerCase()} schedule found. Parse one first:
                  </div>
                  <button
                    onClick={() => useViewerStore.getState().toggleTableParsePanel()}
                    className="w-full text-xs px-3 py-2 rounded border border-pink-500/30 text-pink-300 hover:bg-pink-500/10"
                  >
                    Open Table Parse Panel
                  </button>
                  <button
                    onClick={() => useViewerStore.getState().toggleKeynoteParsePanel()}
                    className="w-full text-xs px-3 py-2 rounded border border-amber-500/30 text-amber-300 hover:bg-amber-500/10"
                  >
                    Open Keynote Panel
                  </button>

                  {/* Show heuristic-detected pages as hints */}
                  {(() => {
                    const cat = MATERIALS.find((m) => m.type === activeQtoWorkflow.materialType)?.scheduleCategory;
                    const detected = cat ? scheduleDetections[cat] || [] : [];
                    if (detected.length === 0) return null;
                    return (
                      <div className="space-y-1 pt-1">
                        <div className="text-[9px] text-[var(--muted)] uppercase tracking-wide">Detected pages:</div>
                        {detected.sort((a, b) => b.confidence - a.confidence).map((d, i) => (
                          <button
                            key={i}
                            onClick={() => setPage(d.pageNum)}
                            className="w-full text-left text-[10px] px-2 py-1 rounded border border-[var(--border)] hover:bg-[var(--surface-hover)]"
                          >
                            <span className="text-[var(--fg)]">{d.name}</span>
                            <span className="text-[var(--muted)] ml-1">({Math.round(d.confidence * 100)}%)</span>
                          </button>
                        ))}
                      </div>
                    );
                  })()}

                  <div className="text-[9px] text-[var(--muted)] px-1 pt-1">
                    After parsing, come back here — the schedule will appear above.
                  </div>
                </div>
              );
            })()}
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

      <div className="px-2 py-2 space-y-1">
        {MATERIALS.map((mat) => {
          const cat = mat.scheduleCategory;
          const detected = scheduleDetections[cat];
          const parsed = parsedSchedules.filter((s) =>
            s.name.toLowerCase().includes(mat.type) || s.category.toLowerCase().includes(mat.type)
          );

          return (
            <button
              key={mat.type}
              disabled={creating}
              onClick={() => startWorkflow(mat.type, mat.label)}
              className="w-full text-left px-3 py-2.5 rounded border border-[var(--border)] hover:border-emerald-500/40 hover:bg-emerald-500/5 transition-colors"
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
                if (e.key === "Enter" && customName.trim()) startWorkflow(customName.trim().toLowerCase(), customName.trim());
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
                disabled={!customName.trim() || creating}
                onClick={() => startWorkflow(customName.trim().toLowerCase(), customName.trim())}
                className="text-[10px] px-2 py-0.5 rounded bg-emerald-600 text-white disabled:opacity-40"
              >Start</button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowCustom(true)}
            className="w-full text-left px-3 py-2 rounded border border-dashed border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-emerald-500/30 text-xs"
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

  const canProceed = tagColumn && selectedPages.size > 0;

  const handleRun = async () => {
    await updateWorkflowStep(workflow, {
      step: "map-tags",
      yoloClassFilter: yoloClass || null,
      parsedSchedule: { ...schedule!, tagColumn },
      userEdits: {
        ...(workflow.userEdits || { addedInstances: [], removedInstances: [], quantityOverrides: {}, addedRows: [], deletedTags: [], cellEdits: {} }),
        selectedPages: [...selectedPages],
      },
    });
  };

  return (
    <div className="px-3 py-3 space-y-4 flex-1 overflow-y-auto">
      <div className="text-[11px] text-green-400 font-medium">
        Schedule: {schedule?.tableName} ({schedule?.rows?.length || 0} rows)
      </div>

      {/* 3a: Tag Column */}
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
      </div>

      {/* 3b: YOLO Class */}
      <div>
        <div className="text-[10px] text-[var(--muted)] uppercase tracking-wide mb-1.5">Detection Shape</div>
        <div className="space-y-1">
          <button
            onClick={() => setYoloClass("")}
            className={`w-full text-left px-2 py-1.5 rounded text-[10px] border transition-colors ${
              !yoloClass
                ? "border-cyan-500/50 bg-cyan-500/10 text-cyan-300"
                : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--muted)]/40"
            }`}
          >
            Free-floating (OCR only)
          </button>
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
            <div className="text-[9px] text-[var(--muted)] px-1">No YOLO detections in project. Using OCR only.</div>
          )}
        </div>
      </div>

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
        Run Mapping ({uniqueTags.length} tags, {selectedPages.size} pages)
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

  useEffect(() => {
    if (hasRun.current || mapping || !schedule || tags.length === 0) return;
    hasRun.current = true;
    setMapping(true);
    setError(null);

    fetch(`/api/projects/${publicId}/map-tags-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tags,
        yoloClass: workflow.yoloClassFilter || undefined,
        yoloModel: workflow.yoloModelFilter || undefined,
        selectedPages,
      }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Server error ${res.status}`);
        return res.json();
      })
      .then(({ results }: { results: Record<string, YoloTagInstance[]> }) => {
        // Build QtoLineItems
        const lineItems: QtoLineItem[] = tags.map((tag) => {
          const instances = results[tag] || [];
          const scheduleRow = (schedule.rows as Record<string, string>[]).find(
            (r) => r[schedule.tagColumn]?.trim() === tag
          );
          const specs: Record<string, string> = {};
          for (const h of schedule.headers) {
            if (h !== schedule.tagColumn) specs[h] = scheduleRow?.[h] || "";
          }
          const flags: QtoFlag[] = [];
          if (instances.length === 0) flags.push("not-found");
          const avgConf = instances.length > 0
            ? instances.reduce((s, i) => s + i.confidence, 0) / instances.length
            : 0;
          if (avgConf > 0 && avgConf < 0.5) flags.push("low-confidence");

          return {
            tag,
            specs,
            autoQuantity: instances.length,
            instances: instances.map((i) => ({
              pageNumber: i.pageNumber,
              bbox: i.bbox,
              confidence: i.confidence,
            })),
            pages: [...new Set(instances.map((i) => i.pageNumber))].sort((a, b) => a - b),
            csiCodes: [],
            flags,
            notes: "",
          };
        });

        updateWorkflowStep(workflow, { step: "review", lineItems });
      })
      .catch((err) => {
        setError(err.message || "Mapping failed");
        setMapping(false);
      });
  }, [tags, schedule, workflow, publicId, updateWorkflowStep, mapping, selectedPages]);

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

  const totalInstances = lineItems.reduce((s, li) => s + li.autoQuantity, 0);
  const uniquePages = new Set(lineItems.flatMap((li) => li.pages)).size;
  const notFoundCount = lineItems.filter((li) => li.flags.includes("not-found")).length;

  const exportCsv = () => {
    if (!schedule) return;
    const specHeaders = schedule.headers.filter((h: string) => h !== schedule.tagColumn);
    const csvHeaders = ["Tag", ...specHeaders, "QTY", "Pages", "Flags"];
    const csvRows = lineItems.map((li) =>
      [
        escCsv(li.tag),
        ...specHeaders.map((h: string) => escCsv(li.specs[h] || "")),
        String(li.autoQuantity),
        escCsv(li.pages.join(", ")),
        escCsv(li.flags.join(", ")),
      ].join(",")
    );
    const csv = [csvHeaders.map(escCsv).join(","), ...csvRows].join("\n");
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
          return (
            <button
              key={li.tag}
              onClick={() => {
                if (li.instances.length > 0) setPage(li.instances[0].pageNumber);
              }}
              className="w-full text-left px-3 py-1.5 border-b border-[var(--border)]/50 hover:bg-[var(--surface-hover)] transition-colors"
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
                <span className="text-[9px] text-[var(--muted)] w-12 shrink-0">
                  {li.pages.length > 0 ? `${li.pages.length} pg` : ""}
                </span>
                <span className="text-[9px] text-[var(--muted)] truncate flex-1">
                  {li.pages.slice(0, 5).join(", ")}{li.pages.length > 5 ? "..." : ""}
                </span>
                {li.flags.includes("not-found") && (
                  <span className="text-[8px] px-1 py-0.5 rounded bg-red-500/10 text-red-400 shrink-0">Not Found</span>
                )}
                {li.flags.includes("low-confidence") && (
                  <span className="text-[8px] px-1 py-0.5 rounded bg-amber-500/10 text-amber-400 shrink-0">Low Conf</span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Footer actions */}
      <div className="px-3 py-2 border-t border-[var(--border)] space-y-1.5">
        <button
          onClick={exportCsv}
          className="w-full py-1.5 rounded bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-500"
        >
          Export CSV
        </button>
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
    </div>
  );
}
