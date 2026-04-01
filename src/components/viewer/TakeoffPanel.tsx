"use client";

import { useViewerStore } from "@/stores/viewerStore";
import { AREA_UNIT_MAP } from "@/types";
import type { AreaPolygonData, AreaUnitSq } from "@/types";
import { computeRealArea } from "@/lib/areaCalc";
import CountTab from "./CountTab";
import AreaTab from "./AreaTab";
import AutoQtoTab from "./AutoQtoTab";

export default function TakeoffPanel() {
  const takeoffTab = useViewerStore((s) => s.takeoffTab);
  const setTakeoffTab = useViewerStore((s) => s.setTakeoffTab);
  const annotations = useViewerStore((s) => s.annotations);
  const takeoffItems = useViewerStore((s) => s.takeoffItems);
  const pageDimensions = useViewerStore((s) => s.pageDimensions);
  const scaleCalibrations = useViewerStore((s) => s.scaleCalibrations);
  const activeTakeoffItemId = useViewerStore((s) => s.activeTakeoffItemId);

  function exportCSV() {
    const rows: string[] = [];
    for (const item of takeoffItems) {
      const isArea = item.shape === "polygon";
      if (isArea) {
        let totalArea = 0;
        const pages = new Set<number>();
        let hasCal = true;
        for (const ann of annotations) {
          if (ann.source !== "takeoff" || !ann.data) continue;
          const data = ann.data as any;
          if (data.type !== "area-polygon" || data.takeoffItemId !== item.id) continue;
          pages.add(ann.pageNumber);
          const vertices = (data as AreaPolygonData).vertices;
          const dim = pageDimensions[ann.pageNumber];
          const cal = scaleCalibrations[ann.pageNumber];
          if (vertices && dim && cal) { totalArea += computeRealArea(vertices, dim.width, dim.height, cal); }
          else { hasCal = false; }
        }
        const cals = Object.values(scaleCalibrations);
        const unitSq: AreaUnitSq = cals.length > 0 ? AREA_UNIT_MAP[cals[0].unit] : "SF";
        rows.push(`"${item.name.replace(/"/g, '""')}",area,polygon,${item.color},${hasCal ? totalArea.toFixed(1) : ""},${unitSq},"${Array.from(pages).sort((a, b) => a - b).join("; ")}"`);
      } else {
        let count = 0;
        const pages = new Set<number>();
        for (const ann of annotations) {
          if (ann.source !== "takeoff" || !ann.data) continue;
          const data = ann.data as any;
          if (data.takeoffItemId !== item.id) continue;
          if (data.type === "area-polygon") continue;
          count++;
          pages.add(ann.pageNumber);
        }
        rows.push(`"${item.name.replace(/"/g, '""')}",count,${item.shape},${item.color},${count},EA,"${Array.from(pages).sort((a, b) => a - b).join("; ")}"`);
      }
    }
    const csv = ["Item Name,Type,Shape,Color,Quantity,Unit,Pages", ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "takeoff.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="w-80 shrink-0 border border-[var(--border)] bg-[var(--surface)] flex flex-col shadow-lg">
      <div className="p-3 border-b border-[var(--border)] flex items-center justify-between">
        <span className="text-sm font-medium">Quantity Takeoff</span>
        <button onClick={exportCSV} className="text-xs px-2 py-0.5 rounded border border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)] hover:border-[var(--accent)]" title="Export CSV">CSV</button>
      </div>
      <div className="flex border-b border-[var(--border)]">
        {(["count", "area", "auto-qto"] as const).map((tab) => (
          <button key={tab} onClick={() => setTakeoffTab(tab)}
            className={`flex-1 text-xs py-2 text-center transition-colors ${takeoffTab === tab ? "text-[var(--fg)] border-b-2 border-[var(--accent)]" : "text-[var(--muted)] hover:text-[var(--fg)]"}`}>
            {tab === "count" ? "Count" : tab === "area" ? "Area" : "Auto-QTO"}
          </button>
        ))}
      </div>
      {takeoffTab === "count" && <CountTab />}
      {takeoffTab === "area" && <AreaTab />}
      {takeoffTab === "auto-qto" && <AutoQtoTab />}
      {activeTakeoffItemId !== null && (
        <div className="p-3 border-t border-[var(--border)] flex justify-end">
          <button
            onClick={() => {
              useViewerStore.getState().setActiveTakeoffItemId(null);
              useViewerStore.getState().resetPolygonDrawing();
              useViewerStore.getState().setMode("move");
            }}
            className="px-3 py-1.5 text-xs rounded border border-red-400/30 text-red-400/60 bg-red-400/5 hover:border-red-400/50 hover:text-red-400 transition-colors"
          >
            Stop Takeoff
          </button>
        </div>
      )}
    </div>
  );
}
