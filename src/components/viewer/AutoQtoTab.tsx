"use client";

import { useState, useMemo, useCallback } from "react";
import { useViewerStore, useProject, useNavigation, useQtoWorkflow, useSummaries } from "@/stores/viewerStore";
import type { QtoWorkflow } from "@/types";

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

  // Load workflows from API on mount
  const [loaded, setLoaded] = useState(false);
  if (!loaded && publicId) {
    setLoaded(true);
    fetch(`/api/qto-workflows?projectId=${publicId}`)
      .then((r) => r.ok ? r.json() : [])
      .then(setQtoWorkflows)
      .catch(() => {});
  }

  const startWorkflow = useCallback(async (materialType: string, materialLabel: string) => {
    if (isDemo || !publicId) return;
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
    if (isDemo) return;
    try {
      const res = await fetch(`/api/qto-workflows/${workflow.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (res.ok) {
        const updated = await res.json();
        setActiveQtoWorkflow(updated);
        setQtoWorkflows(qtoWorkflows.map((w) => w.id === updated.id ? updated : w));
      }
    } catch (err) {
      console.error("[auto-qto] Failed to update workflow:", err);
    }
  }, [isDemo, qtoWorkflows, setActiveQtoWorkflow, setQtoWorkflows]);

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

        {/* Step 3: Confirm Tags (placeholder for Phase B) */}
        {activeQtoWorkflow.step === "confirm-tags" && (
          <div className="px-3 py-3 space-y-2">
            <div className="text-[11px] text-green-400 font-medium">
              Schedule: {activeQtoWorkflow.parsedSchedule?.tableName}
            </div>
            <div className="text-[10px] text-[var(--muted)]">
              {activeQtoWorkflow.parsedSchedule?.rows?.length || 0} rows, tag column: {activeQtoWorkflow.parsedSchedule?.tagColumn || "?"}
            </div>
            <div className="text-[10px] text-[var(--muted)] border border-[var(--border)] rounded px-2 py-3 text-center">
              Step 3: Confirm Tag Column — coming in Phase B
            </div>
          </div>
        )}

        {/* Steps 4-6: Placeholders */}
        {(activeQtoWorkflow.step === "map-tags" || activeQtoWorkflow.step === "review" || activeQtoWorkflow.step === "done") && (
          <div className="px-3 py-3">
            <div className="text-[10px] text-[var(--muted)] border border-[var(--border)] rounded px-2 py-3 text-center">
              {activeQtoWorkflow.step === "map-tags" && "Step 4: Map Tags — coming in Phase C"}
              {activeQtoWorkflow.step === "review" && "Step 5: Review — coming in Phase D"}
              {activeQtoWorkflow.step === "done" && "Step 6: Export — coming in Phase D"}
            </div>
          </div>
        )}

        {/* Step progress indicator */}
        <div className="mt-auto px-3 py-2 border-t border-[var(--border)]">
          <div className="flex gap-1">
            {["select-schedule", "confirm-tags", "map-tags", "review", "done"].map((s, i) => (
              <div
                key={s}
                className={`flex-1 h-1 rounded-full ${
                  s === activeQtoWorkflow.step
                    ? "bg-emerald-400"
                    : ["select-schedule", "confirm-tags", "map-tags", "review", "done"].indexOf(activeQtoWorkflow.step) > i
                    ? "bg-emerald-400/40"
                    : "bg-[var(--border)]"
                }`}
              />
            ))}
          </div>
          <div className="text-[8px] text-[var(--muted)] text-center mt-1">
            Step {["select-schedule", "confirm-tags", "map-tags", "review", "done"].indexOf(activeQtoWorkflow.step) + 1} of 5
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
                ({w.step === "done" ? "completed" : `step ${["pick", "select-schedule", "confirm-tags", "map-tags", "review", "done"].indexOf(w.step)}/5`})
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
