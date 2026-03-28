"use client";

import { useMemo, useState } from "react";
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
          const modelExpanded = expandedModels[modelName] !== false;
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
