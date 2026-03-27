"use client";

import { useMemo } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import { TWENTY_COLORS } from "@/types";

function labelColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return TWENTY_COLORS[Math.abs(hash) % TWENTY_COLORS.length];
}

export default function AnnotationPanel() {
  const annotations = useViewerStore((s) => s.annotations);
  const removeAnnotation = useViewerStore((s) => s.removeAnnotation);
  const setAnnotationFilter = useViewerStore((s) => s.setAnnotationFilter);
  const activeAnnotationFilter = useViewerStore((s) => s.activeAnnotationFilter);

  // Group annotations by category (YOLO, MARKUPS, QTO) then by name
  const categorized = useMemo(() => {
    const yolo: Map<string, { count: number; pages: Set<number> }> = new Map();
    const markups: Map<string, { count: number; pages: Set<number>; ids: number[] }> = new Map();
    const qto: Map<string, { count: number; pages: Set<number> }> = new Map();

    for (const ann of annotations) {
      if (ann.source === "yolo") {
        const existing = yolo.get(ann.name);
        if (existing) { existing.count++; existing.pages.add(ann.pageNumber); }
        else yolo.set(ann.name, { count: 1, pages: new Set([ann.pageNumber]) });
      } else if (ann.source === "takeoff" || ann.source === "takeoff-scale") {
        const existing = qto.get(ann.name);
        if (existing) { existing.count++; existing.pages.add(ann.pageNumber); }
        else qto.set(ann.name, { count: 1, pages: new Set([ann.pageNumber]) });
      } else {
        const existing = markups.get(ann.name);
        if (existing) { existing.count++; existing.pages.add(ann.pageNumber); existing.ids.push(ann.id); }
        else markups.set(ann.name, { count: 1, pages: new Set([ann.pageNumber]), ids: [ann.id] });
      }
    }

    return {
      yolo: [...yolo.entries()].sort(([, a], [, b]) => b.count - a.count),
      markups: [...markups.entries()].sort(([, a], [, b]) => b.count - a.count),
      qto: [...qto.entries()].sort(([, a], [, b]) => b.count - a.count),
    };
  }, [annotations]);

  const totalYolo = categorized.yolo.reduce((s, [, d]) => s + d.count, 0);
  const totalMarkups = categorized.markups.reduce((s, [, d]) => s + d.count, 0);
  const totalQto = categorized.qto.reduce((s, [, d]) => s + d.count, 0);

  if (annotations.length === 0) {
    return (
      <div className="border-t border-[var(--border)] p-3" style={{ backgroundColor: "#1e1e22" }}>
        <span className="text-xs" style={{ color: "#6b8aad" }}>
          No annotations. Run YOLO or switch to markup mode to draw.
        </span>
      </div>
    );
  }

  return (
    <div className="border-t border-[var(--border)] max-h-28 overflow-y-auto" style={{ backgroundColor: "#1e1e22" }}>
      <div className="p-2 space-y-1.5">
        {/* Active filter badge */}
        {activeAnnotationFilter && (
          <button
            onClick={() => setAnnotationFilter(null)}
            className="px-2 py-0.5 text-[10px] rounded bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/40 mb-1"
          >
            Filtered: {activeAnnotationFilter} x
          </button>
        )}

        {/* YOLO detections */}
        {categorized.yolo.length > 0 && (
          <div>
            <div className="text-[10px] text-purple-400/70 mb-0.5">YOLO ({totalYolo})</div>
            <div className="flex flex-wrap gap-1">
              {categorized.yolo.map(([name, data]) => (
                <button
                  key={`yolo-${name}`}
                  onClick={() => setAnnotationFilter(activeAnnotationFilter === name ? null : name)}
                  className={`px-1.5 py-0.5 text-[10px] rounded border transition-colors ${
                    activeAnnotationFilter === name
                      ? "bg-purple-500/20 border-purple-400/40 text-purple-300"
                      : "border-[var(--border)] text-[var(--muted)] hover:border-purple-400/30 hover:text-purple-300"
                  }`}
                >
                  {name} <span className="opacity-60">{data.count}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* User markups */}
        {categorized.markups.length > 0 && (
          <div>
            <div className="text-[10px] text-blue-400/70 mb-0.5">MARKUPS ({totalMarkups})</div>
            <div className="flex flex-wrap gap-1">
              {categorized.markups.map(([name, data]) => (
                <button
                  key={`markup-${name}`}
                  onClick={() => setAnnotationFilter(activeAnnotationFilter === name ? null : name)}
                  className={`px-1.5 py-0.5 text-[10px] rounded border transition-colors ${
                    activeAnnotationFilter === name
                      ? "bg-blue-500/20 border-blue-400/40 text-blue-300"
                      : "border-[var(--border)] text-[var(--muted)] hover:border-blue-400/30 hover:text-blue-300"
                  }`}
                  style={{ borderLeftColor: labelColor(name), borderLeftWidth: 2 }}
                >
                  {name} <span className="opacity-60">{data.count}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* QTO annotations */}
        {categorized.qto.length > 0 && (
          <div>
            <div className="text-[10px] text-emerald-400/70 mb-0.5">QTO ({totalQto})</div>
            <div className="flex flex-wrap gap-1">
              {categorized.qto.map(([name, data]) => (
                <button
                  key={`qto-${name}`}
                  onClick={() => setAnnotationFilter(activeAnnotationFilter === name ? null : name)}
                  className={`px-1.5 py-0.5 text-[10px] rounded border transition-colors ${
                    activeAnnotationFilter === name
                      ? "bg-emerald-500/20 border-emerald-400/40 text-emerald-300"
                      : "border-[var(--border)] text-[var(--muted)] hover:border-emerald-400/30 hover:text-emerald-300"
                  }`}
                >
                  {name} <span className="opacity-60">{data.count}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
