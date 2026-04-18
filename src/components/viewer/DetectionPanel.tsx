"use client";

import { useMemo, useState } from "react";
import { useViewerStore, useNavigation, usePanels, useProject, useDetection, useYoloTags, usePageData } from "@/stores/viewerStore";
import { useShapeParseInteraction } from "@/hooks/useShapeParseInteraction";
import { TWENTY_COLORS, SHAPE_COLORS } from "@/types";
import type { ClientAnnotation, YoloTag, Shape } from "@/types";
import ClassGroupHeader from "./ClassGroupHeader";
import HelpTooltip from "./HelpTooltip";
import AnnotationListItem from "./AnnotationListItem";

function classColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  return TWENTY_COLORS[Math.abs(hash) % TWENTY_COLORS.length];
}

// Stable module-level const — hoisted so the Set identity doesn't change per
// render. Used by yoloAnnotations to filter out non-detection annotations.
const DETECTION_SOURCES: ReadonlySet<string> = new Set(["yolo", "shape-parse", "symbol-search"]);

export default function DetectionPanel() {
  const { pageNumber, setPage } = useNavigation();
  const { toggleDetectionPanel } = usePanels();
  const { pageNames } = useProject();
  const {
    annotations, activeModels, setModelActive,
    confidenceThreshold, setConfidenceThreshold,
    activeAnnotationFilter, setAnnotationFilter, setSearch,
    hiddenAnnotationIds, toggleAnnotationVisibility,
    hiddenClasses, toggleClassVisibility,
  } = useDetection();
  const {
    yoloTags, activeYoloTagId, setActiveYoloTagId,
    setYoloTagFilter, yoloTagVisibility, setYoloTagVisibility,
    removeYoloTag, updateYoloTag, yoloTagPickingMode, setYoloTagPickingMode,
    tagScanResults, setTagScanResults, tagAddingMode, setTagAddingMode,
  } = useYoloTags();

  const [detectionTab, setDetectionTab] = useState<"models" | "tags" | "shape">("models");
  const shapeParse = useShapeParseInteraction({ detectionTab });
  const [shapeSaving, setShapeSaving] = useState(false);
  const [shapeSaveSuccess, setShapeSaveSuccess] = useState<string | null>(null);
  const { keynotes, setKeynotes } = usePageData();
  const setMode = useViewerStore((s) => s.setMode);
  const showKeynotes = useViewerStore((s) => s.showKeynotes);
  const toggleKeynotes = useViewerStore((s) => s.toggleKeynotes);
  const activeKeynoteFilter = useViewerStore((s) => s.activeKeynoteFilter);
  const setKeynoteFilter = useViewerStore((s) => s.setKeynoteFilter);
  const projectId = useViewerStore((s) => s.projectId);

  const pageKeynotes = keynotes[pageNumber] || [];
  const hasMultiPageKeynotes = useMemo(() => Object.keys(keynotes).length > 1, [keynotes]);
  const totalKeynoteCount = useMemo(() => Object.values(keynotes).reduce((n, k) => n + (k?.length || 0), 0), [keynotes]);

  // Group detected shapes by type for the summary list
  const shapesByType = useMemo(() => {
    const groups: Record<string, { count: number; items: typeof pageKeynotes }> = {};
    for (const k of pageKeynotes) {
      if (!groups[k.shape]) groups[k.shape] = { count: 0, items: [] };
      groups[k.shape].count++;
      groups[k.shape].items.push(k);
    }
    return Object.entries(groups).sort(([, a], [, b]) => b.count - a.count);
  }, [pageKeynotes]);

  const [expandedModels, setExpandedModels] = useState<Record<string, boolean>>({});
  const [expandedClasses, setExpandedClasses] = useState<Record<string, boolean>>({});
  const [expandedTagModels, setExpandedTagModels] = useState<Record<string, boolean>>({});
  const [expandedTagClasses, setExpandedTagClasses] = useState<Record<string, boolean>>({});
  const [expandedTagItems, setExpandedTagItems] = useState<Record<string, boolean>>({});
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [editingTagName, setEditingTagName] = useState("");
  const [scanSelections, setScanSelections] = useState<Record<string, boolean>>({});
  const [showCsiTags, setShowCsiTags] = useState(false);
  const [csiEdits, setCsiEdits] = useState<Record<string, string>>({});
  const [savingCsi, setSavingCsi] = useState(false);
  const [csiMessage, setCsiMessage] = useState("");

  const yoloAnnotations = useMemo(() => annotations.filter((a) => {
    if (!DETECTION_SOURCES.has(a.source)) return false;
    return ((a.data?.confidence as number) ?? 1) >= confidenceThreshold;
  }), [annotations, confidenceThreshold]);

  const modelGroups = useMemo(() => {
    const models: Record<string, Record<string, {
      annotations: ClientAnnotation[]; csiCodes: Set<string>; keywords: Set<string>;
    }>> = {};
    for (const ann of yoloAnnotations) {
      const model = (ann.data?.modelName as string) || "Unknown Model";
      const cls = ann.name;
      if (!models[model]) models[model] = {};
      if (!models[model][cls]) models[model][cls] = { annotations: [], csiCodes: new Set(), keywords: new Set() };
      models[model][cls].annotations.push(ann);
      (ann.data?.csiCodes as string[] | undefined)?.forEach((c) => models[model][cls].csiCodes.add(c));
      (ann.data?.keywords as string[] | undefined)?.forEach((k) => models[model][cls].keywords.add(k));
    }
    return Object.entries(models)
      .map(([modelName, classes]) => ({
        modelName,
        classes: Object.entries(classes)
          .map(([className, d]) => ({ className, annotations: d.annotations, csiCodes: [...d.csiCodes], keywords: [...d.keywords] }))
          .sort((a, b) => b.annotations.length - a.annotations.length),
        totalCount: Object.values(classes).reduce((s, c) => s + c.annotations.length, 0),
      }))
      .sort((a, b) => b.totalCount - a.totalCount);
  }, [yoloAnnotations]);

  // Group yoloTags by model → class for hierarchy
  const tagGroups = useMemo(() => {
    const groups: Record<string, Record<string, YoloTag[]>> = {};
    for (const tag of yoloTags) {
      const model = tag.yoloModel || "[no shape]";
      const cls = tag.yoloClass || "[free-floating]";
      if (!groups[model]) groups[model] = {};
      if (!groups[model][cls]) groups[model][cls] = [];
      groups[model][cls].push(tag);
    }
    return Object.entries(groups).map(([modelName, classes]) => ({
      modelName,
      classes: Object.entries(classes).map(([className, tags]) => ({
        className,
        tags: tags.sort((a, b) => a.tagText.localeCompare(b.tagText)),
      })),
    }));
  }, [yoloTags]);

  // Per-tag page count — precomputed so the per-tag render row can do an O(1)
  // lookup instead of allocating a Set per tag per render. On a project with
  // 50 tags × 20 instances that's 1000 allocations saved on every list render.
  const pageCountByTag = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const tag of yoloTags) {
      counts[tag.id] = new Set(tag.instances.map((i) => i.pageNumber)).size;
    }
    return counts;
  }, [yoloTags]);

  function handleTagClick(tag: YoloTag) {
    if (activeYoloTagId === tag.id) {
      setActiveYoloTagId(null);
      setYoloTagFilter(null);
      setSearch("");
    } else {
      setActiveYoloTagId(tag.id);
      setYoloTagFilter(tag.id);
      // Populate search with tag text so OCR highlights appear on canvas
      setSearch(tag.tagText);
    }
  }

  function handleToggleFilter(name: string) {
    if (activeAnnotationFilter === name) { setAnnotationFilter(null); setSearch(""); }
    else setAnnotationFilter(name);
  }

  return (
    <div className="w-72 flex flex-col h-full overflow-hidden border border-[var(--border)] bg-[var(--surface)] shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
        <h3 className="text-sm font-medium text-[var(--fg)]">YOLO</h3>
        <button onClick={toggleDetectionPanel} className="text-[var(--muted)] hover:text-[var(--fg)] text-lg leading-none">&times;</button>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-[var(--border)]">
        {(["models", "tags", "shape"] as const).map((tab) => (
          <button key={tab} onClick={() => setDetectionTab(tab)}
            className={`flex-1 px-3 py-1.5 text-[11px] font-medium capitalize ${
              detectionTab === tab
                ? "text-[var(--accent)] border-b-2 border-[var(--accent)]"
                : "text-[var(--muted)] hover:text-[var(--fg)]"
            }`}>
            {tab === "tags"
              ? `Tags${yoloTags.length > 0 ? ` (${yoloTags.length})` : ""}`
              : tab === "shape"
                ? `Shape${pageKeynotes.length > 0 ? ` (${pageKeynotes.length})` : ""}`
                : "Models"}
          </button>
        ))}
      </div>

      {detectionTab === "models" && <>
      {/* Global confidence slider */}
      <div className="px-3 py-2 border-b border-[var(--border)] space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-[var(--muted)]">Min Confidence</span>
          <span className="text-[10px] text-[var(--fg)] font-medium">{Math.round(confidenceThreshold * 100)}%</span>
        </div>
        <input type="range" min="0" max="100" value={confidenceThreshold * 100}
          onChange={(e) => setConfidenceThreshold(Number(e.target.value) / 100)}
          className="w-full h-1 bg-[var(--border)] rounded-lg appearance-none cursor-pointer accent-[var(--accent)]" />
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-[var(--muted)]">
            {yoloAnnotations.length} detection{yoloAnnotations.length !== 1 ? "s" : ""} shown
          </span>
          {modelGroups.length > 0 && (
            <button
              onClick={() => {
                const allVisible = modelGroups.every(({ modelName }) => activeModels[modelName] !== false);
                for (const { modelName } of modelGroups) setModelActive(modelName, !allVisible);
              }}
              className="text-[10px] text-[var(--muted)] hover:text-[var(--fg)]"
            >
              {modelGroups.every(({ modelName }) => activeModels[modelName] !== false) ? "Hide All" : "Show All"}
            </button>
          )}
        </div>
      </div>

      {/* CSI Tags sub-menu */}
      {modelGroups.length > 0 && (
        <div className="border-b border-[var(--border)]">
          <button
            onClick={() => setShowCsiTags(!showCsiTags)}
            className="w-full flex items-center justify-between px-3 py-1.5 text-left hover:bg-[var(--surface-hover)]"
          >
            <span className="text-[10px] font-medium text-blue-400">CSI Tags</span>
            <span className="text-[10px] text-[var(--muted)]">{showCsiTags ? "▼" : "▶"}</span>
          </button>
          {showCsiTags && (
            <div className="px-3 pb-2 space-y-1.5">
              <p className="text-[9px] text-[var(--muted)]">CSI codes per class for this project. Edit here to override global defaults.</p>
              {csiMessage && <div className="text-[9px] text-blue-400">{csiMessage}</div>}
              {modelGroups.map(({ modelName, classes }) => (
                <div key={modelName} className="space-y-0.5">
                  <div className="text-[9px] text-[var(--muted)] font-medium">{modelName}</div>
                  {classes.map(({ className: cls, csiCodes }) => {
                    const editKey = `${modelName}:${cls}`;
                    const editVal = csiEdits[editKey];
                    const displayVal = editVal !== undefined ? editVal : csiCodes.join(", ");
                    return (
                      <div key={cls} className="flex items-center gap-1.5">
                        <span className="text-[9px] font-mono w-24 truncate shrink-0" title={cls}>{cls}</span>
                        <input
                          type="text"
                          value={displayVal}
                          onChange={(e) => setCsiEdits(p => ({ ...p, [editKey]: e.target.value }))}
                          placeholder="CSI codes..."
                          className="flex-1 px-1 py-0.5 text-[9px] bg-[var(--bg)] border border-[var(--border)] rounded text-[var(--fg)] outline-none focus:border-blue-400/50 font-mono"
                        />
                      </div>
                    );
                  })}
                </div>
              ))}
              {Object.keys(csiEdits).length > 0 && (
                <div className="flex items-center gap-2 pt-1">
                  <button
                    onClick={async () => {
                      setSavingCsi(true);
                      setCsiMessage("");
                      const publicId = useViewerStore.getState().publicId;
                      // Build overrides from edits
                      const overrides: Record<string, Record<string, string[]>> = {};
                      for (const [key, val] of Object.entries(csiEdits)) {
                        const [model, cls] = key.split(":", 2);
                        const codes = val.split(",").map(s => s.trim()).filter(Boolean);
                        if (!overrides[model]) overrides[model] = {};
                        overrides[model][cls] = codes;
                      }
                      try {
                        const res = await fetch(`/api/projects/${publicId}`, {
                          method: "PUT",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ classCsiOverrides: overrides }),
                        });
                        if (res.ok) {
                          setCsiMessage("Saved to project");
                          setTimeout(() => setCsiMessage(""), 3000);
                        } else {
                          setCsiMessage("Save failed");
                        }
                      } catch { setCsiMessage("Save failed"); }
                      setSavingCsi(false);
                    }}
                    disabled={savingCsi}
                    className="px-2 py-0.5 text-[9px] bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-40"
                  >
                    {savingCsi ? "Saving..." : "Save to Project"}
                  </button>
                  <button
                    onClick={() => { setCsiEdits({}); setCsiMessage(""); }}
                    className="px-2 py-0.5 text-[9px] text-[var(--muted)] hover:text-[var(--fg)]"
                  >
                    Revert to Global
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Active filter indicator */}
      {activeAnnotationFilter && (
        <div className="flex items-center gap-2 mx-2 mt-2 px-2 py-1.5 bg-[var(--accent)]/10 rounded text-xs">
          <span className="text-[var(--accent)] font-medium truncate flex-1">Filtering: {activeAnnotationFilter}</span>
          <button onClick={() => { setAnnotationFilter(null); setSearch(""); }} className="text-[var(--muted)] hover:text-[var(--fg)] shrink-0">&times;</button>
        </div>
      )}

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
        {modelGroups.length === 0 && (
          <div className="flex items-center justify-center h-32">
            <span className="text-[var(--muted)] text-sm">No YOLO detections loaded</span>
          </div>
        )}
        {modelGroups.map(({ modelName, classes, totalCount }) => {
          const modelExpanded = expandedModels[modelName] === true;
          const modelVisible = activeModels[modelName] !== false;
          return (
            <div key={modelName} className="border border-[var(--border)] rounded">
              <div className="flex items-center gap-2 px-2 py-1.5 bg-[var(--surface)]">
                <button onClick={() => setExpandedModels((p) => ({ ...p, [modelName]: !modelExpanded }))}
                  className="text-[10px] text-[var(--muted)] hover:text-[var(--fg)] shrink-0 w-3 text-center">
                  {modelExpanded ? "\u25BC" : "\u25B6"}
                </button>
                <span className="text-xs font-medium text-[var(--fg)] truncate flex-1">{modelName}</span>
                <span className="text-[10px] text-[var(--muted)]">{totalCount}</span>
                <button onClick={() => setModelActive(modelName, !modelVisible)}
                  className={`text-sm shrink-0 ${modelVisible ? "text-[var(--fg)]" : "text-[var(--muted)] opacity-40"}`}
                  title={modelVisible ? "Hide model" : "Show model"}>
                  {modelVisible ? "\u{1F441}" : "\u{1F441}\u200D\u{1F5E8}"}
                </button>
              </div>
              {modelExpanded && (
                <div className="space-y-px">
                  {classes.map(({ className: cls, annotations: classAnns, csiCodes, keywords }) => {
                    const gk = `${modelName}:${cls}`;
                    const classExp = expandedClasses[gk] === true;
                    const clr = classColor(cls);
                    return (
                      <div key={cls}>
                        <ClassGroupHeader className={cls} count={classAnns.length} isExpanded={classExp}
                          onToggleExpand={() => setExpandedClasses((p) => ({ ...p, [gk]: !classExp }))}
                          isVisible={modelVisible && hiddenClasses[gk] !== false}
                          onToggleVisibility={() => toggleClassVisibility(modelName, cls)}
                          isActive={activeAnnotationFilter === cls} onToggleFilter={handleToggleFilter}
                          color={clr} csiCodes={csiCodes} keywords={keywords} />
                        {classExp && (
                          <div className="ml-2 space-y-px">
                            {classAnns.map((ann) => (
                              <AnnotationListItem key={ann.id} annotation={ann}
                                isActive={activeAnnotationFilter === ann.name}
                                isHidden={hiddenAnnotationIds.has(ann.id)}
                                onToggleVisibility={toggleAnnotationVisibility}
                                onToggleFilter={handleToggleFilter} onSearchKeyword={(kw) => setSearch(kw)} color={clr} />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      </>}

      {/* ═══ Tags Tab ═══ */}
      {detectionTab === "tags" && (
        <div className="flex-1 overflow-y-auto flex flex-col">
          {/* Create Tag button */}
          <div className="px-3 py-2 border-b border-[var(--border)]">
            <HelpTooltip id="yolo-create-tag">
            <button
              onClick={() => {
                const next = !yoloTagPickingMode;
                setYoloTagPickingMode(next);
                if (next) useViewerStore.getState().setMode("pointer");
              }}
              className={`w-full px-2 py-1.5 text-[11px] rounded border ${
                yoloTagPickingMode
                  ? "border-amber-400 bg-amber-500/10 text-amber-300"
                  : "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--surface-hover)]"
              }`}
            >
              {yoloTagPickingMode ? "Click a YOLO annotation on canvas..." : "Create Tag"}
            </button>
            </HelpTooltip>
          </div>

          {/* ─── Class Scan Preview ─── */}
          {tagScanResults && (
            <div className="mx-2 mt-2 border border-amber-500/30 rounded bg-amber-500/5 overflow-hidden">
              <div className="px-2 py-1.5 bg-amber-500/10 flex items-center justify-between">
                <span className="text-[10px] font-medium text-amber-300">
                  Scan: {tagScanResults.yoloClass} ({tagScanResults.yoloModel})
                </span>
                <button onClick={() => setTagScanResults(null)} className="text-[var(--muted)] hover:text-[var(--fg)] text-xs">&times;</button>
              </div>
              <div className="px-2 py-1 text-[9px] text-[var(--muted)]">
                {tagScanResults.texts.length} unique text{tagScanResults.texts.length !== 1 ? "s" : ""} found
                {" "}({tagScanResults.texts.reduce((s, t) => s + t.count, 0)} annotations)
              </div>
              <div className="max-h-48 overflow-y-auto space-y-px">
                {tagScanResults.texts.slice(0, 100).map((t) => {
                  const key = t.text || "__empty__";
                  const checked = scanSelections[key] ?? (t.text !== "");
                  return (
                    <label key={key} className="flex items-center gap-2 px-2 py-1 hover:bg-[var(--surface-hover)] cursor-pointer text-[10px]">
                      <input type="checkbox" checked={checked}
                        onChange={() => setScanSelections((p) => ({ ...p, [key]: !checked }))}
                        className="accent-amber-400 w-3 h-3" />
                      <span className={`flex-1 truncate ${t.text ? "text-[var(--fg)] font-mono" : "text-[var(--muted)] italic"}`}>
                        {t.text || "(empty)"}
                      </span>
                      <span className="text-[var(--muted)] shrink-0">{t.count}</span>
                      <span className="text-[var(--muted)] shrink-0">{t.pages.length}pg</span>
                    </label>
                  );
                })}
              </div>
              {tagScanResults.texts.length > 100 && (
                <div className="px-2 py-1 text-[9px] text-[var(--muted)]">Showing 100 of {tagScanResults.texts.length}</div>
              )}
              <div className="flex gap-1 px-2 py-2 border-t border-amber-500/20">
                <button
                  onClick={() => {
                    const store = useViewerStore.getState();
                    for (const t of tagScanResults.texts) {
                      const key = t.text || "__empty__";
                      const checked = scanSelections[key] ?? (t.text !== "");
                      if (!checked || !t.text) continue;
                      // Skip if tag already exists
                      if (store.yoloTags.some((et) => et.tagText.toUpperCase() === t.text.toUpperCase() && et.yoloClass === tagScanResults.yoloClass)) continue;
                      store.addYoloTag({
                        id: `scan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                        name: t.text,
                        tagText: t.text,
                        yoloClass: tagScanResults.yoloClass,
                        yoloModel: tagScanResults.yoloModel,
                        source: "manual",
                        scope: "project",
                        instances: t.instances,
                      });
                    }
                    setTagScanResults(null);
                    setScanSelections({});
                  }}
                  className="flex-1 px-2 py-1 text-[10px] rounded bg-amber-600 text-white hover:bg-amber-500 font-medium"
                >
                  Accept Selected
                </button>
                <button
                  onClick={() => {
                    // Select all that have text
                    const all: Record<string, boolean> = {};
                    for (const t of tagScanResults.texts) {
                      if (t.text) all[t.text] = true;
                    }
                    setScanSelections(all);
                    // Then trigger accept
                    const store = useViewerStore.getState();
                    for (const t of tagScanResults.texts) {
                      if (!t.text) continue;
                      if (store.yoloTags.some((et) => et.tagText.toUpperCase() === t.text.toUpperCase() && et.yoloClass === tagScanResults.yoloClass)) continue;
                      store.addYoloTag({
                        id: `scan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                        name: t.text,
                        tagText: t.text,
                        yoloClass: tagScanResults.yoloClass,
                        yoloModel: tagScanResults.yoloModel,
                        source: "manual",
                        scope: "project",
                        instances: t.instances,
                      });
                    }
                    setTagScanResults(null);
                    setScanSelections({});
                  }}
                  className="px-2 py-1 text-[10px] rounded border border-amber-500/30 text-amber-300 hover:bg-amber-500/10"
                >
                  Accept All
                </button>
                <button onClick={() => { setTagScanResults(null); setScanSelections({}); }}
                  className="px-2 py-1 text-[10px] text-[var(--muted)] hover:text-[var(--fg)]">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Active tag filter indicator */}
          {activeYoloTagId && (
            <div className="flex items-center gap-2 mx-2 mt-2 px-2 py-1.5 bg-[var(--accent)]/10 rounded text-xs">
              <span className="text-[var(--accent)] font-medium truncate flex-1">
                Active: {yoloTags.find((t) => t.id === activeYoloTagId)?.tagText || activeYoloTagId}
              </span>
              <button onClick={() => { setActiveYoloTagId(null); setYoloTagFilter(null); }}
                className="text-[var(--muted)] hover:text-[var(--fg)] shrink-0">&times;</button>
            </div>
          )}

          {/* Tag hierarchy */}
          <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
            {tagGroups.length === 0 && (
              <div className="flex items-center justify-center h-32 text-center px-4">
                <span className="text-[var(--muted)] text-[11px]">
                  No tags yet. Parse keynotes or schedules, or use Create Tag to add tags manually.
                </span>
              </div>
            )}
            {tagGroups.map(({ modelName, classes }) => {
              const tmKey = modelName;
              const tmExpanded = expandedTagModels[tmKey] !== false; // default open
              const totalTags = classes.reduce((s, c) => s + c.tags.length, 0);
              return (
                <div key={tmKey} className="border border-[var(--border)] rounded">
                  {/* Model header */}
                  <div className="flex items-center gap-2 px-2 py-1.5 bg-[var(--surface)]">
                    <button onClick={() => setExpandedTagModels((p) => ({ ...p, [tmKey]: !tmExpanded }))}
                      className="text-[10px] text-[var(--muted)] hover:text-[var(--fg)] shrink-0 w-3 text-center">
                      {tmExpanded ? "\u25BC" : "\u25B6"}
                    </button>
                    <span className="text-xs font-medium text-[var(--fg)] truncate flex-1">{modelName}</span>
                    <span className="text-[10px] text-[var(--muted)]">{totalTags} tag{totalTags !== 1 ? "s" : ""}</span>
                  </div>
                  {tmExpanded && (
                    <div className="space-y-px">
                      {classes.map(({ className: cls, tags }) => {
                        const tcKey = `${tmKey}:${cls}`;
                        const tcExpanded = expandedTagClasses[tcKey] !== false;
                        const clr = classColor(cls);
                        return (
                          <div key={tcKey}>
                            {/* Class header */}
                            <div className="flex items-center gap-1.5 px-2 py-1 ml-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                              onClick={() => setExpandedTagClasses((p) => ({ ...p, [tcKey]: !tcExpanded }))}>
                              <span className="text-[10px] text-[var(--muted)] w-3 text-center shrink-0">
                                {tcExpanded ? "\u25BC" : "\u25B6"}
                              </span>
                              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: clr }} />
                              <span className="text-[11px] text-[var(--fg)] truncate flex-1">{cls}</span>
                              <span className="text-[10px] text-[var(--muted)]">{tags.length}</span>
                            </div>
                            {tcExpanded && (
                              <div className="ml-6 space-y-px">
                                {tags.map((tag) => {
                                  const isActive = activeYoloTagId === tag.id;
                                  const isVisible = yoloTagVisibility[tag.id] !== false;
                                  const tiExpanded = expandedTagItems[tag.id] === true;
                                  const pageCount = pageCountByTag[tag.id] ?? 0;
                                  const isEditing = editingTagId === tag.id;

                                  // Source badge color
                                  const srcColor = tag.source === "keynote" ? "text-amber-400" :
                                    tag.source === "schedule" ? "text-blue-400" : "text-green-400";

                                  return (
                                    <div key={tag.id} className={`rounded ${isActive ? "bg-[var(--accent)]/10 border border-[var(--accent)]/30" : ""}`}>
                                      {/* Tag row */}
                                      <div className="flex items-center gap-1 px-2 py-1 hover:bg-[var(--surface-hover)] cursor-pointer group"
                                        onClick={() => handleTagClick(tag)}>
                                        <button
                                          onClick={(e) => { e.stopPropagation(); setExpandedTagItems((p) => ({ ...p, [tag.id]: !tiExpanded })); }}
                                          className="text-[9px] text-[var(--muted)] hover:text-[var(--fg)] w-3 text-center shrink-0">
                                          {tiExpanded ? "\u25BC" : "\u25B6"}
                                        </button>
                                        <span className="text-[11px] font-mono font-medium text-[var(--fg)] shrink-0">{tag.tagText}</span>
                                        {tag.description && (
                                          <span className="text-[10px] text-[var(--muted)] truncate flex-1" title={tag.description}>
                                            &mdash; {tag.description}
                                          </span>
                                        )}
                                        {!tag.description && <span className="flex-1" />}
                                        <span className={`text-[8px] ${srcColor} shrink-0`}>{tag.source}</span>
                                        <span className="text-[9px] text-[var(--muted)] shrink-0">
                                          {tag.instances.length}
                                          {pageCount > 1 ? ` / ${pageCount}pg` : ""}
                                        </span>
                                        {/* Visibility toggle */}
                                        <button
                                          onClick={(e) => { e.stopPropagation(); setYoloTagVisibility(tag.id, !isVisible); }}
                                          className={`text-[10px] shrink-0 opacity-0 group-hover:opacity-100 ${isVisible ? "text-[var(--fg)]" : "text-[var(--muted)] opacity-40"}`}
                                          title={isVisible ? "Hide" : "Show"}>
                                          {isVisible ? "\u{1F441}" : "\u2014"}
                                        </button>
                                      </div>

                                      {/* Expanded: per-page instances + actions */}
                                      {tiExpanded && (
                                        <div className="ml-5 pb-1 space-y-0.5">
                                          {/* Edit name inline */}
                                          <div className="flex items-center gap-1 px-2 py-0.5">
                                            {isEditing ? (
                                              <input
                                                autoFocus
                                                value={editingTagName}
                                                onChange={(e) => setEditingTagName(e.target.value)}
                                                onBlur={() => { updateYoloTag(tag.id, { name: editingTagName }); setEditingTagId(null); }}
                                                onKeyDown={(e) => { if (e.key === "Enter") { updateYoloTag(tag.id, { name: editingTagName }); setEditingTagId(null); } if (e.key === "Escape") setEditingTagId(null); }}
                                                className="flex-1 px-1 py-0.5 text-[10px] bg-[var(--bg)] border border-[var(--accent)]/40 rounded text-[var(--fg)] outline-none"
                                              />
                                            ) : (
                                              <>
                                                <span className="text-[10px] text-[var(--muted)] truncate flex-1">{tag.name}</span>
                                                <button onClick={() => { setEditingTagId(tag.id); setEditingTagName(tag.name); }}
                                                  className="text-[9px] text-[var(--muted)] hover:text-[var(--fg)]" title="Rename">&#9998;</button>
                                              </>
                                            )}
                                            <button onClick={() => removeYoloTag(tag.id)}
                                              className="text-[9px] text-red-400 hover:text-red-300 shrink-0" title="Delete">&times;</button>
                                          </div>
                                          {tag.scope === "page" && tag.pageNumber && (
                                            <div className="px-2 text-[9px] text-[var(--muted)]">
                                              Scope: page {pageNames[tag.pageNumber] || tag.pageNumber}
                                            </div>
                                          )}
                                          {/* Per-page instance list */}
                                          {(() => {
                                            const byPage = new Map<number, number>();
                                            for (const inst of tag.instances) byPage.set(inst.pageNumber, (byPage.get(inst.pageNumber) || 0) + 1);
                                            return [...byPage.entries()]
                                              .sort((a, b) => a[0] - b[0])
                                              .map(([pn, count]) => (
                                                <button key={pn}
                                                  onClick={() => setPage(pn)}
                                                  className={`w-full text-left px-2 py-0.5 text-[10px] rounded hover:bg-[var(--surface-hover)] flex items-center gap-1 ${
                                                    pn === pageNumber ? "text-[var(--accent)]" : "text-[var(--muted)]"
                                                  }`}>
                                                  <span className="truncate flex-1">{pageNames[pn] || `Page ${pn}`}</span>
                                                  <span className="shrink-0">({count})</span>
                                                </button>
                                              ));
                                          })()}
                                          {/* Add missing instance */}
                                          <button
                                            onClick={() => {
                                              if (tagAddingMode === tag.id) {
                                                setTagAddingMode(null);
                                              } else {
                                                setTagAddingMode(tag.id);
                                                setActiveYoloTagId(tag.id);
                                                useViewerStore.getState().setMode("pointer");
                                              }
                                            }}
                                            className={`w-full text-left px-2 py-1 text-[9px] rounded border mt-1 ${
                                              tagAddingMode === tag.id
                                                ? "border-cyan-400 bg-cyan-500/10 text-cyan-300"
                                                : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
                                            }`}
                                          >
                                            {tagAddingMode === tag.id ? "Draw BB on canvas to add instance..." : "+ Add Missing"}
                                          </button>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ═══ Shape Parse Tab ═══ */}
      {detectionTab === "shape" && (
        <div className="flex-1 overflow-y-auto flex flex-col">
          {/* Run / Visibility controls */}
          <div className="px-3 py-2 border-b border-[var(--border)] space-y-1.5">
            {/* Action stack — broad-to-narrow scope, light→dark blue gradient,
                green when the button's state is engaged (loading, drawing, or
                has a region drawn). Follows the app's active-state convention:
                `border-[color]-400 bg-[color]-500/15 text-[color]-300`. */}
            <div className="flex flex-col gap-1.5">
              <button
                onClick={shapeParse.runOnAll}
                disabled={shapeParse.loading || !projectId}
                className={`w-full px-2 py-1.5 text-[11px] rounded border transition-colors disabled:opacity-40 ${
                  shapeParse.loading
                    ? "border-green-500/60 bg-green-500/15 text-green-300 cursor-wait"
                    : "border-sky-500/30 bg-sky-500/5 text-sky-300 hover:bg-sky-500/10"
                }`}
                title="Scan every page in the project (uses Lambda if available)"
              >
                {shapeParse.loading ? "Detecting…" : "Scan All Pages"}
              </button>
              <button
                onClick={shapeParse.runOnPage}
                disabled={shapeParse.loading || !projectId}
                className={`w-full px-2 py-1.5 text-[11px] rounded border transition-colors disabled:opacity-40 ${
                  shapeParse.loading
                    ? "border-green-500/60 bg-green-500/15 text-green-300 cursor-wait"
                    : "border-sky-500/40 bg-sky-500/10 text-sky-300 hover:bg-sky-500/15"
                }`}
                title={shapeParse.region
                  ? `Scan page ${pageNumber} within the drawn region`
                  : `Scan the full current page (${pageNumber})`}
              >
                {shapeParse.loading ? "Detecting…" : "Scan this Page"}
              </button>
              <button
                onClick={shapeParse.startRegionDraw}
                disabled={shapeParse.loading}
                aria-pressed={shapeParse.drawing || shapeParse.region !== null}
                className={`w-full px-2 py-1.5 text-[11px] rounded border transition-colors disabled:opacity-40 ${
                  shapeParse.drawing || shapeParse.region !== null
                    ? "border-green-500/60 bg-green-500/15 text-green-300"
                    : "border-sky-500/50 bg-sky-500/15 text-sky-300 hover:bg-sky-500/20"
                }`}
                title={shapeParse.drawing || shapeParse.region !== null
                  ? "Click to cancel region draw"
                  : "Draw a region on the page, then run Scan this Page"}
              >
                {shapeParse.region !== null
                  ? "Region drawn — click to clear"
                  : shapeParse.drawing
                    ? "Drawing… click to cancel"
                    : "Scan a specific region"}
              </button>
            </div>
            {shapeParse.region && (
              <div className="flex items-center gap-1 text-[9px] text-green-400/70">
                <span>Region: ({(shapeParse.region[0]*100).toFixed(0)}%,{(shapeParse.region[1]*100).toFixed(0)}%) to ({(shapeParse.region[2]*100).toFixed(0)}%,{(shapeParse.region[3]*100).toFixed(0)}%)</span>
                <button
                  onClick={() => { shapeParse.setRegion(null); shapeParse.setDrawing(false); }}
                  className="text-[var(--muted)] hover:text-red-400"
                >&times;</button>
              </div>
            )}
            {/* Debug / results area — consolidated error + warnings into one
                panel with a header so it reads as the tab's diagnostic output
                (the python pipeline emits the funnel counts here). */}
            {(shapeParse.error || shapeParse.warnings.length > 0) && (
              <div className="rounded border border-[var(--border)] bg-[var(--panel-secondary)]/40 px-2 py-1.5 space-y-1">
                <div className="text-[9px] uppercase tracking-wider text-[var(--muted)]">
                  Debug / Results
                </div>
                {shapeParse.error && (
                  <div className="text-[10px] text-red-400">{shapeParse.error}</div>
                )}
                {shapeParse.warnings.map((w, i) => (
                  <div key={i} className="text-[10px] text-amber-300 font-mono leading-snug">
                    {w}
                  </div>
                ))}
              </div>
            )}
            {pageKeynotes.length > 0 && (
              <button
                onClick={toggleKeynotes}
                className={`w-full px-2 py-1 text-[10px] rounded border ${
                  showKeynotes
                    ? "border-cyan-400/60 text-cyan-300 bg-cyan-500/10"
                    : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
                }`}
              >
                {showKeynotes ? "\u25C9 Showing on canvas" : "\u25CB Hidden — click to show"}
              </button>
            )}
            <div className="text-[9px] text-[var(--muted)] leading-tight">
              Detects circles, diamonds, hexagons etc. containing keynote text (A1, B-2…).
              OpenCV + Tesseract, no ML model needed.
            </div>
          </div>

          {/* Save as annotations buttons */}
          {pageKeynotes.length > 0 && (
            <div className="px-3 py-1.5 border-b border-[var(--border)] space-y-1">
              <button
                disabled={shapeSaving}
                onClick={async () => {
                  const store = useViewerStore.getState();
                  const { publicId, isDemo } = store;
                  if (!publicId || isDemo) {
                    shapeParse.setError(isDemo ? "Cannot save in demo mode" : "Project not loaded");
                    return;
                  }
                  setShapeSaving(true);
                  shapeParse.setError(null);
                  setShapeSaveSuccess(null);
                  try {
                    const annInputs = pageKeynotes.map((k) => ({
                      pageNumber,
                      name: k.shape,
                      bbox: k.bbox,
                      source: "shape-parse",
                      threshold: 0.9,
                      data: {
                        modelName: "shape-parse",
                        shapeType: k.shape,
                        text: k.text,
                        contour: k.contour,
                        confidence: 0.9,
                      },
                    }));
                    const res = await fetch("/api/annotations", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      // Append-only save: no deleteSource/deletePageNumbers,
                      // so multiple BB parses on the same page accumulate in
                      // the DB instead of wiping prior saves.
                      body: JSON.stringify({
                        projectId: publicId,
                        annotations: annInputs,
                      }),
                    });
                    if (!res.ok) {
                      const errBody = await res.json().catch(() => ({}));
                      throw new Error(errBody.error || `HTTP ${res.status}`);
                    }
                    const data = await res.json();
                    if (data.annotations) {
                      const current = useViewerStore.getState().annotations;
                      // Append the newly-saved rows; prior shape-parse rows
                      // stay untouched (server no longer deletes them).
                      useViewerStore.getState().setAnnotations([...current, ...data.annotations]);
                      // Clear the pending-shapes panel — they've moved from
                      // "pending" to "saved" (now visible via annotations overlay).
                      setKeynotes(pageNumber, []);
                      // Reset the BB draw state so the user can start a new
                      // region without a manual cancel-click.
                      shapeParse.setRegion(null);
                      setMode("move");
                      setShapeSaveSuccess(`Saved ${data.annotations.length} annotations`);
                      setTimeout(() => setShapeSaveSuccess(null), 3000);
                    }
                  } catch (err) {
                    console.error("[SHAPE_PARSE] Save failed:", err);
                    shapeParse.setError(err instanceof Error ? err.message : "Save failed");
                  } finally {
                    setShapeSaving(false);
                  }
                }}
                className={`w-full px-2 py-1 text-[10px] rounded border ${shapeSaving ? "border-[var(--border)] text-[var(--muted)] cursor-wait" : shapeSaveSuccess ? "border-green-500/60 text-green-300 bg-green-500/15" : "border-green-500/40 text-green-300 bg-green-500/5 hover:bg-green-500/10"}`}
              >
                {shapeSaving ? "Saving..." : shapeSaveSuccess || `Save page ${pageNumber} (${pageKeynotes.length} shapes)`}
              </button>
              {hasMultiPageKeynotes && (
                <button
                  disabled={shapeSaving}
                  onClick={async () => {
                    const store = useViewerStore.getState();
                    const { publicId, isDemo } = store;
                    if (!publicId || isDemo) {
                      shapeParse.setError(isDemo ? "Cannot save in demo mode" : "Project not loaded");
                      return;
                    }
                    setShapeSaving(true);
                    shapeParse.setError(null);
                    setShapeSaveSuccess(null);
                    try {
                      const allAnnotations: Array<{pageNumber: number; name: string; bbox: [number,number,number,number]; source: string; threshold: number; data: Record<string, unknown>}> = [];
                      const allPageNums: number[] = [];
                      for (const [pn, shapes] of Object.entries(keynotes)) {
                        const pageNum = Number(pn);
                        if (!shapes?.length) continue;
                        allPageNums.push(pageNum);
                        for (const k of shapes) {
                          allAnnotations.push({
                            pageNumber: pageNum,
                            name: k.shape,
                            bbox: k.bbox,
                            source: "shape-parse",
                            threshold: 0.9,
                            data: {
                              modelName: "shape-parse",
                              shapeType: k.shape,
                              text: k.text,
                              contour: k.contour,
                              confidence: 0.9,
                            },
                          });
                        }
                      }
                      const res = await fetch("/api/annotations", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        // Append-only — see single-page save comment above.
                        body: JSON.stringify({
                          projectId: publicId,
                          annotations: allAnnotations,
                        }),
                      });
                      if (!res.ok) {
                        const errBody = await res.json().catch(() => ({}));
                        throw new Error(errBody.error || `HTTP ${res.status}`);
                      }
                      const data = await res.json();
                      if (data.annotations) {
                        const current = store.annotations;
                        store.setAnnotations([...current, ...data.annotations]);
                        // Clear the pending-shapes panel for every page we saved.
                        for (const pn of allPageNums) {
                          store.setKeynotes(pn, []);
                        }
                        // Reset BB draw state so the next parse starts fresh.
                        shapeParse.setRegion(null);
                        setMode("move");
                        setShapeSaveSuccess(`Saved ${data.annotations.length} across ${allPageNums.length} pages`);
                        setTimeout(() => setShapeSaveSuccess(null), 3000);
                      }
                    } catch (err) {
                      console.error("[SHAPE_PARSE] Save all failed:", err);
                      shapeParse.setError(err instanceof Error ? err.message : "Save failed");
                    } finally {
                      setShapeSaving(false);
                    }
                  }}
                  className={`w-full px-2 py-1 text-[10px] rounded border ${shapeSaving ? "border-[var(--border)] text-[var(--muted)] cursor-wait" : "border-amber-500/40 text-amber-300 bg-amber-500/5 hover:bg-amber-500/10"}`}
                >
                  {shapeSaving ? "Saving..." : `Save all pages (${totalKeynoteCount} shapes)`}
                </button>
              )}
            </div>
          )}

          {/* Results summary */}
          {pageKeynotes.length > 0 ? (
            <div className="flex-1 overflow-y-auto">
              <div className="px-3 py-1.5 text-[10px] text-[var(--muted)] border-b border-[var(--border)]">
                {pageKeynotes.length} shape{pageKeynotes.length === 1 ? "" : "s"} detected
                {activeKeynoteFilter && (
                  <button
                    onClick={() => setKeynoteFilter(null)}
                    className="ml-2 text-[var(--accent)] hover:underline"
                  >
                    clear filter
                  </button>
                )}
              </div>
              {shapesByType.map(([shape, data]) => {
                const color = SHAPE_COLORS[shape as Shape] || "#e6194b";
                return (
                  <div key={shape} className="border-b border-[var(--border)]/50">
                    <div
                      className="px-3 py-1 text-[10px] font-medium flex items-center gap-1.5"
                      style={{ color }}
                    >
                      <span
                        className="inline-block w-2 h-2 rounded-full"
                        style={{ backgroundColor: color }}
                      />
                      <span className="capitalize">{shape}</span>
                      <span className="text-[var(--muted)]">({data.count})</span>
                    </div>
                    <div className="px-3 pb-1 flex flex-wrap gap-1">
                      {data.items.map((k, i) => {
                        const isActive =
                          activeKeynoteFilter?.shape === k.shape &&
                          activeKeynoteFilter?.text === k.text;
                        return (
                          <button
                            key={`${shape}-${i}`}
                            onClick={() =>
                              setKeynoteFilter(isActive ? null : { shape: k.shape, text: k.text })
                            }
                            className={`px-1.5 py-0.5 text-[10px] rounded border transition-colors ${
                              isActive
                                ? "bg-[var(--accent)]/20 border-[var(--accent)]/40 text-[var(--accent)]"
                                : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]"
                            }`}
                            title={`${k.shape}: "${k.text || "(no text)"}"`}
                          >
                            {k.text || "\u2014"}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : !shapeParse.loading ? (
            <div className="flex-1 flex items-center justify-center text-[10px] text-[var(--muted)] px-6 text-center">
              No shapes parsed for page {pageNumber} yet.
              <br />
              Click &quot;Run Shape Parse&quot; above.
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
