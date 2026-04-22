/** Bucket fill worker pipeline. Verified against
 *  src/workers/bucket-fill.worker.ts:processFill (L453+). Text is treated as a
 *  dark region like any other (text-as-wall, post-2026-04-22 rewrite — pre-2026
 *  the worker erased text first). The maxDimension knob is dominant:
 *  downscale happens before Otsu, so resolution controls whether thin walls
 *  survive the threshold. */
const STAGES = [
  { n: 1, name: "ImageBitmap",      sub: "from canvas" },
  { n: 2, name: "Downscale",         sub: "maxDimension (1k/2k/3k/4k)" },
  { n: 3, name: "Otsu threshold",    sub: "tolerance offset" },
  { n: 4, name: "morphClose",        sub: "dilation radius" },
  { n: 5, name: "Burn barriers",     sub: "user lines + polys" },
  { n: 6, name: "Flood fill",        sub: "stops at dark pixels" },
  { n: 7, name: "Trace border",      sub: "+ holes (RETR_CCOMP)" },
  { n: 8, name: "Simplify polygon",  sub: "Douglas-Peucker" },
];

export function BucketFillStagesDiagram() {
  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox="0 0 1040 240"
        className="w-full h-auto text-[var(--fg)]"
        fill="currentColor"
        role="img"
        aria-label="Bucket fill worker — 8 stage pipeline from ImageBitmap to simplified polygon"
      >
        <defs>
          <marker id="bf-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" opacity="0.6" />
          </marker>
        </defs>

        <text x="520" y="20" textAnchor="middle" fontSize="14" fontWeight="bold">
          bucket-fill.worker.ts — 8-stage pipeline
        </text>
        <text x="520" y="36" textAnchor="middle" fontSize="10" opacity="0.6">
          maxDimension is the dominant tuning knob. Text is a wall. areaFraction from the worker is decorative — real sqft flows through computeRealArea().
        </text>

        {STAGES.map((s, i) => {
          const cols = 4;
          const row = Math.floor(i / cols);
          const col = i % cols;
          const x = 40 + col * 245;
          const y = 60 + row * 80;
          return (
            <g key={s.n}>
              <rect x={x} y={y} width="220" height="62" rx="6" fill="none" stroke="#60a5fa" strokeWidth="1.5" opacity="0.9" />
              <circle cx={x + 24} cy={y + 30} r="14" fill="none" stroke="#60a5fa" strokeWidth="1.5" />
              <text x={x + 24} y={y + 34} textAnchor="middle" fontSize="12" fontWeight="bold" fill="#60a5fa">
                {s.n}
              </text>
              <text x={x + 48} y={y + 26} fontSize="12" fontWeight="bold">
                {s.name}
              </text>
              <text x={x + 48} y={y + 42} fontSize="10" opacity="0.65" fontFamily="monospace">
                {s.sub}
              </text>

              {/* arrows between stages */}
              {i < STAGES.length - 1 && col === cols - 1 && (
                <g>
                  {/* wrap down-left */}
                  <path
                    d={`M ${x + 110} ${y + 62} Q ${x + 110} ${y + 70} ${x + 80} ${y + 70}`}
                    stroke="currentColor"
                    strokeWidth="1.4"
                    fill="none"
                    opacity="0.35"
                  />
                </g>
              )}
              {i < STAGES.length - 1 && col < cols - 1 && (
                <line
                  x1={x + 220}
                  y1={y + 30}
                  x2={x + 245}
                  y2={y + 30}
                  stroke="currentColor"
                  strokeWidth="1.4"
                  opacity="0.5"
                  markerEnd="url(#bf-arr)"
                />
              )}
            </g>
          );
        })}

        {/* Output */}
        <g>
          <rect x="40" y="220" width="960" height="4" fill="#22c55e" opacity="0.2" />
        </g>
      </svg>
    </div>
  );
}
