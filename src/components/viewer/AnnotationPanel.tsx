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
  const setPage = useViewerStore((s) => s.setPage);
  const pageNumber = useViewerStore((s) => s.pageNumber);

  // Group annotations by label
  const groups = useMemo(() => {
    const map = new Map<
      string,
      { count: number; pages: Set<number>; ids: number[]; source: string }
    >();
    for (const ann of annotations) {
      if (ann.source === "takeoff") continue;
      const existing = map.get(ann.name);
      if (existing) {
        existing.count++;
        existing.pages.add(ann.pageNumber);
        existing.ids.push(ann.id);
      } else {
        map.set(ann.name, {
          count: 1,
          pages: new Set([ann.pageNumber]),
          ids: [ann.id],
          source: ann.source,
        });
      }
    }
    return Array.from(map.entries()).sort((a, b) => b[1].count - a[1].count);
  }, [annotations]);

  // Current page annotations
  const pageAnnotations = annotations.filter((a) => a.pageNumber === pageNumber);

  if (annotations.length === 0) {
    return (
      <div className="border-t border-[var(--border)] p-3" style={{ backgroundColor: "#1e1e22" }}>
        <span className="text-xs" style={{ color: "#6b8aad" }}>
          No markups. Switch to Add Markup mode to draw.
        </span>
      </div>
    );
  }

  return (
    <div className="border-t border-[var(--border)] max-h-24 overflow-y-auto" style={{ backgroundColor: "#1e1e22" }}>
      {/* Label groups */}
      <div className="p-2 flex flex-wrap gap-1.5">
        {activeAnnotationFilter && (
          <button
            onClick={() => setAnnotationFilter(null)}
            className="px-2 py-0.5 text-[10px] rounded bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/40"
          >
            {activeAnnotationFilter} ({groups.find(([n]) => n === activeAnnotationFilter)?.[1].pages.size || 0} pg) x
          </button>
        )}
        {groups.map(([name, data]) => {
          const color = labelColor(name);
          const isActive = activeAnnotationFilter === name;
          return (
            <button
              key={name}
              onClick={() =>
                setAnnotationFilter(isActive ? null : name)
              }
              className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
                isActive
                  ? "bg-[var(--accent)]/20 border-[var(--accent)]/40"
                  : "border-[var(--border)] hover:border-[var(--accent)]"
              }`}
              style={{ borderLeftColor: color, borderLeftWidth: 3 }}
            >
              {name}
              <span className="text-[var(--muted)] ml-1">
                {data.count} ({data.pages.size}pg)
              </span>
            </button>
          );
        })}
      </div>

      {/* Current page annotations list */}
      {pageAnnotations.length > 0 && (
        <div className="px-2 pb-2">
          <div className="text-[10px] text-[var(--muted)] mb-1">
            Page {pageNumber}
          </div>
          {pageAnnotations.map((ann) => (
            <div
              key={ann.id}
              className="flex items-center justify-between text-xs py-0.5"
            >
              <span style={{ color: labelColor(ann.name) }}>
                {ann.name}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-[var(--muted)] text-[10px]">
                  {ann.source}
                </span>
                <button
                  onClick={() => {
                    fetch(`/api/annotations/${ann.id}`, {
                      method: "DELETE",
                    }).catch(() => {});
                    removeAnnotation(ann.id);
                  }}
                  className="text-[var(--muted)] hover:text-red-400 text-[10px]"
                >
                  x
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
