"use client";

import { useMemo, useState, useCallback } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import { TWENTY_COLORS } from "@/types";
import type { ClientAnnotation } from "@/types";
import ClassGroupHeader from "./ClassGroupHeader";
import AnnotationListItem from "./AnnotationListItem";

function classColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  return TWENTY_COLORS[Math.abs(hash) % TWENTY_COLORS.length];
}

export default function DetectionPanel() {
  const annotations = useViewerStore((s) => s.annotations);
  const toggleDetectionPanel = useViewerStore((s) => s.toggleDetectionPanel);
  const activeModels = useViewerStore((s) => s.activeModels);
  const setModelActive = useViewerStore((s) => s.setModelActive);
  const confidenceThreshold = useViewerStore((s) => s.confidenceThreshold);
  const setConfidenceThreshold = useViewerStore((s) => s.setConfidenceThreshold);
  const activeAnnotationFilter = useViewerStore((s) => s.activeAnnotationFilter);
  const setAnnotationFilter = useViewerStore((s) => s.setAnnotationFilter);
  const setSearch = useViewerStore((s) => s.setSearch);

  const [expandedModels, setExpandedModels] = useState<Record<string, boolean>>({});
  const [expandedClasses, setExpandedClasses] = useState<Record<string, boolean>>({});
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

  function handleToggleFilter(name: string) {
    if (activeAnnotationFilter === name) { setAnnotationFilter(null); setSearch(""); }
    else setAnnotationFilter(name);
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
        <h3 className="text-sm font-medium text-[var(--fg)]">Detections</h3>
        <button onClick={toggleDetectionPanel} className="text-[var(--muted)] hover:text-[var(--fg)] text-lg leading-none">&times;</button>
      </div>

      {/* Global confidence slider */}
      <div className="px-3 py-2 border-b border-[var(--border)] space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-[var(--muted)]">Min Confidence</span>
          <span className="text-[10px] text-[var(--fg)] font-medium">{Math.round(confidenceThreshold * 100)}%</span>
        </div>
        <input type="range" min="0" max="100" value={confidenceThreshold * 100}
          onChange={(e) => setConfidenceThreshold(Number(e.target.value) / 100)}
          className="w-full h-1 bg-[var(--border)] rounded-lg appearance-none cursor-pointer accent-[var(--accent)]" />
        <div className="text-[10px] text-[var(--muted)]">
          {yoloAnnotations.length} detection{yoloAnnotations.length !== 1 ? "s" : ""} shown
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
    </div>
  );
}
