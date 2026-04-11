import { getDivColor, DIVISION_NAMES } from "../constants";

/** Representative 3x3 heatmap of a floor plan showing where CSI divisions
 *  concentrate. Static data for illustration — the real grid is 9x9 by
 *  default (computeCsiSpatialMap) and also maintains `title-block` and
 *  `right-margin` special zones. */
const ZONES: { row: number; col: number; div: string; instances: number }[] = [
  { row: 0, col: 0, div: "08", instances: 14 },
  { row: 0, col: 1, div: "09", instances: 8 },
  { row: 0, col: 2, div: "09", instances: 11 },
  { row: 1, col: 0, div: "22", instances: 22 },
  { row: 1, col: 1, div: "23", instances: 16 },
  { row: 1, col: 2, div: "26", instances: 18 },
  { row: 2, col: 0, div: "22", instances: 9 },
  { row: 2, col: 1, div: "26", instances: 24 },
  { row: 2, col: 2, div: "27", instances: 6 },
];

export function CsiSpatialHeatmapDemo() {
  const maxInstances = Math.max(...ZONES.map((z) => z.instances));

  return (
    <div className="space-y-3">
      <div className="inline-grid grid-cols-3 gap-1 p-2 bg-[var(--bg)] border border-[var(--border)] rounded">
        {ZONES.map((z) => {
          const { color } = getDivColor(z.div);
          const opacity = 0.25 + 0.65 * (z.instances / maxInstances);
          return (
            <div
              key={`${z.row}-${z.col}`}
              className="w-24 h-20 flex flex-col items-center justify-center gap-1 rounded border"
              style={{
                backgroundColor: `${color}${Math.round(opacity * 255).toString(16).padStart(2, "0")}`,
                borderColor: `${color}80`,
              }}
              title={`Zone (${z.row}, ${z.col}) — Div ${z.div} (${DIVISION_NAMES[z.div]}) × ${z.instances}`}
            >
              <span className="text-[11px] font-mono font-bold text-white/90">Div {z.div}</span>
              <span className="text-[10px] text-white/75">{z.instances}</span>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-4 text-[10px] text-[var(--muted)]">
        <div className="flex items-center gap-2">
          <div className="w-4 h-3 rounded-sm bg-white/20" />
          <span>Low</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-3 rounded-sm bg-white/60" />
          <span>High</span>
        </div>
        <div className="ml-auto italic">Real grid is 9×9 + title-block + right-margin zones.</div>
      </div>
    </div>
  );
}
