"use client";

import { useMemo, useState, useCallback } from "react";
import { useViewerStore, useNavigation, usePanels, useProject, useDetection, useYoloTags } from "@/stores/viewerStore";
import { TWENTY_COLORS } from "@/types";
import type { ClientAnnotation, YoloTag } from "@/types";
import ClassGroupHeader from "./ClassGroupHeader";
import HelpTooltip from "./HelpTooltip";
import AnnotationListItem from "./AnnotationListItem";

function classColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  return TWENTY_COLORS[Math.abs(hash) % TWENTY_COLORS.length];
}

export default function DetectionPanel() {
  const { pageNumber, setPage } = useNavigation();
  const { toggleDetectionPanel } = usePanels();
  const { pageNames } = useProject();
  const {
    annotations, activeModels, setModelActive,
    confidenceThreshold, setConfidenceThreshold,
    activeAnnotationFilter, setAnnotationFilter, setSearch,
    hiddenAnnotationIds, toggleAnnotationVisibility,
  } = useDetection();
  const {
    yoloTags, activeYoloTagId, setActiveYoloTagId,
    setYoloTagFilter, yoloTagVisibility, setYoloTagVisibility,
    removeYoloTag, updateYoloTag, yoloTagPickingMode, setYoloTagPickingMode,
  } = useYoloTags();

  const [detectionTab, setDetectionTab] = useState<"models" | "tags">("models");
  const [expandedModels, setExpandedModels] = useState<Record<string, boolean>>({});
  const [expandedClasses, setExpandedClasses] = useState<Record<string, boolean>>({});
  const [expandedTagModels, setExpandedTagModels] = useState<Record<string, boolean>>({});
  const [expandedTagClasses, setExpandedTagClasses] = useState<Record<string, boolean>>({});
  const [expandedTagItems, setExpandedTagItems] = useState<Record<string, boolean>>({});
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [editingTagName, setEditingTagName] = useState("");
  const [showCsiTags, setShowCsiTags] = useState(false);
  const [csiEdits, setCsiEdits] = useState<Record<string, string>>({});
  const [savingCsi, setSavingCsi] = useState(false);
  const [csiMessage, setCsiMessage] = useState("");

  const yoloAnnotations = useMemo(() => annotations.filter((a) => {
    if (a.source !== "yolo") return false;
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

  function handleTagClick(tag: YoloTag) {
    if (activeYoloTagId === tag.id) {
      setActiveYoloTagId(null);
      setYoloTagFilter(null);
    } else {
      setActiveYoloTagId(tag.id);
      setYoloTagFilter(tag.id);
    }
  }

  function handleToggleFilter(name: string) {
    if (activeAnnotationFilter === name) { setAnnotationFilter(null); setSearch(""); }
    else setAnnotationFilter(name);
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
        <h3 className="text-sm font-medium text-[var(--fg)]">YOLO</h3>
        <button onClick={toggleDetectionPanel} className="text-[var(--muted)] hover:text-[var(--fg)] text-lg leading-none">&times;</button>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-[var(--border)]">
        {(["models", "tags"] as const).map((tab) => (
          <button key={tab} onClick={() => setDetectionTab(tab)}
            className={`flex-1 px-3 py-1.5 text-[11px] font-medium capitalize ${
              detectionTab === tab
                ? "text-[var(--accent)] border-b-2 border-[var(--accent)]"
                : "text-[var(--muted)] hover:text-[var(--fg)]"
            }`}>
            {tab === "tags" ? `Tags${yoloTags.length > 0 ? ` (${yoloTags.length})` : ""}` : "Models"}
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
                          isVisible={modelVisible} onToggleVisibility={() => setModelActive(modelName, !modelVisible)}
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
                                  const pageCount = new Set(tag.instances.map((i) => i.pageNumber)).size;
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
    </div>
  );
}
