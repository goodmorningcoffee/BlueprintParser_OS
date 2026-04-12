/** Map Tags binding concept — schedule rows on the left, drawing pages on the
 *  right, dotted lines from each row's tag value to YOLO shape instances that
 *  contain that tag text. The bottom card represents the resulting yolo_tags
 *  rows. Verified against src/lib/yolo-tag-engine.ts:findItemOccurrences. */
export function MapTagsBindingDiagram() {
  const rows = [
    { tag: "D-01", desc: "3070 SC", color: "#60a5fa" },
    { tag: "D-02", desc: "3070 HM", color: "#22c55e" },
    { tag: "D-03", desc: "6080 SC", color: "#a855f7" },
  ];

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox="0 0 960 480"
        className="w-full h-auto text-[var(--fg)]"
        fill="currentColor"
        role="img"
        aria-label="Map Tags binding diagram: schedule rows to YOLO shape instances on drawing pages"
      >
        <defs>
          <marker id="marr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" opacity="0.6" />
          </marker>
        </defs>

        <text x="480" y="22" textAnchor="middle" fontSize="14" fontWeight="bold">
          Map Tags &mdash; bind schedule rows to YOLO shape instances
        </text>
        <text x="480" y="38" textAnchor="middle" fontSize="10" opacity="0.6">
          Each unique tag value becomes a yolo_tag with a list of matched annotation IDs across pages.
        </text>

        {/* Left: parsed schedule */}
        <g>
          <rect x="30" y="70" width="260" height="220" rx="6" fill="none" stroke="currentColor" opacity="0.6" strokeWidth="1.5" />
          <text x="160" y="92" textAnchor="middle" fontSize="12" fontWeight="bold">Parsed door schedule</text>
          <text x="160" y="108" textAnchor="middle" fontSize="9" opacity="0.55" fontFamily="monospace">
            parsedRegions[i].data
          </text>

          {/* header */}
          <line x1="50" y1="118" x2="270" y2="118" stroke="currentColor" opacity="0.4" />
          <text x="80" y="134" textAnchor="middle" fontSize="10" fontWeight="bold" opacity="0.85">tag</text>
          <text x="200" y="134" textAnchor="middle" fontSize="10" fontWeight="bold" opacity="0.85">description</text>
          <line x1="50" y1="142" x2="270" y2="142" stroke="currentColor" opacity="0.4" />

          {/* rows */}
          {rows.map((r, i) => {
            const y = 162 + i * 38;
            return (
              <g key={r.tag}>
                <rect x="58" y={y - 14} width="48" height="22" rx="3" fill="none" stroke={r.color} strokeWidth="1.5" />
                <text x="82" y={y + 1} textAnchor="middle" fontSize="11" fontWeight="bold" fill={r.color} fontFamily="monospace">
                  {r.tag}
                </text>
                <text x="200" y={y + 1} textAnchor="middle" fontSize="10" opacity="0.7" fontFamily="monospace">
                  {r.desc}
                </text>
                <line x1="50" y1={y + 16} x2="270" y2={y + 16} stroke="currentColor" opacity="0.25" />
              </g>
            );
          })}

          <text x="160" y="280" textAnchor="middle" fontSize="9" opacity="0.55">tagColumn highlighted in pink in the panel</text>
        </g>

        {/* Middle: arrows + label */}
        <g>
          {rows.map((r, i) => {
            const y = 162 + i * 38;
            return (
              <line
                key={r.tag}
                x1="290"
                y1={y - 4}
                x2="540"
                y2={140 + i * 60}
                stroke={r.color}
                strokeWidth="1.4"
                opacity="0.65"
                strokeDasharray="3 3"
                markerEnd="url(#marr)"
              />
            );
          })}
          <text x="415" y="62" textAnchor="middle" fontSize="11" fontWeight="bold" opacity="0.7">
            map-tags-batch
          </text>
          <text x="415" y="76" textAnchor="middle" fontSize="9" opacity="0.55" fontFamily="monospace">
            yolo-tag-engine.ts
          </text>
        </g>

        {/* Right: drawing pages with shape instances */}
        <g>
          <rect x="540" y="70" width="380" height="280" rx="6" fill="none" stroke="currentColor" opacity="0.6" strokeWidth="1.5" />
          <text x="730" y="92" textAnchor="middle" fontSize="12" fontWeight="bold">Drawing pages</text>
          <text x="730" y="108" textAnchor="middle" fontSize="9" opacity="0.55" fontFamily="monospace">
            yolo annotations · circle / hexagon class
          </text>

          {/* page 1 */}
          <rect x="560" y="124" width="160" height="96" rx="3" fill="none" stroke="currentColor" opacity="0.45" />
          <text x="640" y="140" textAnchor="middle" fontSize="9" opacity="0.55" fontFamily="monospace">A-201 floor plan</text>
          {[
            { tag: "D-01", cx: 600, cy: 168, color: "#60a5fa" },
            { tag: "D-02", cx: 660, cy: 184, color: "#22c55e" },
            { tag: "D-01", cx: 700, cy: 200, color: "#60a5fa" },
            { tag: "D-03", cx: 605, cy: 200, color: "#a855f7" },
          ].map((s, i) => (
            <g key={i}>
              <circle cx={s.cx} cy={s.cy} r="13" fill="none" stroke={s.color} strokeWidth="1.6" />
              <text x={s.cx} y={s.cy + 4} textAnchor="middle" fontSize="9" fontWeight="bold" fill={s.color} fontFamily="monospace">
                {s.tag}
              </text>
            </g>
          ))}

          {/* page 2 */}
          <rect x="740" y="124" width="160" height="96" rx="3" fill="none" stroke="currentColor" opacity="0.45" />
          <text x="820" y="140" textAnchor="middle" fontSize="9" opacity="0.55" fontFamily="monospace">A-202 floor plan</text>
          {[
            { tag: "D-02", cx: 770, cy: 168, color: "#22c55e" },
            { tag: "D-02", cx: 830, cy: 180, color: "#22c55e" },
            { tag: "D-03", cx: 880, cy: 200, color: "#a855f7" },
            { tag: "D-01", cx: 780, cy: 204, color: "#60a5fa" },
          ].map((s, i) => (
            <g key={i}>
              <circle cx={s.cx} cy={s.cy} r="13" fill="none" stroke={s.color} strokeWidth="1.6" />
              <text x={s.cx} y={s.cy + 4} textAnchor="middle" fontSize="9" fontWeight="bold" fill={s.color} fontFamily="monospace">
                {s.tag}
              </text>
            </g>
          ))}

          {/* exclusion note */}
          <text x="730" y="246" textAnchor="middle" fontSize="9" opacity="0.6">
            regions marked <tspan fontFamily="monospace" fill="#f97316">tables</tspan> /
            <tspan fontFamily="monospace" fill="#f97316"> title_block</tspan> are excluded
          </text>
          <text x="730" y="262" textAnchor="middle" fontSize="9" opacity="0.55">so the schedule&apos;s own tag column doesn&apos;t double-count</text>

          {/* per-page summary */}
          <text x="730" y="296" textAnchor="middle" fontSize="10" fontWeight="bold" opacity="0.8">
            8 instances across 2 pages
          </text>
          <text x="730" y="312" textAnchor="middle" fontSize="9" opacity="0.55">D-01: 3 · D-02: 3 · D-03: 2</text>
        </g>

        {/* Bottom: yolo_tags result card */}
        <g>
          <rect x="30" y="380" width="900" height="80" rx="6" fill="none" stroke="#ec4899" strokeWidth="1.8" />
          <text x="48" y="404" fontSize="12" fontWeight="bold" fill="#ec4899">yolo_tags rows (one per unique tag value)</text>
          <text x="48" y="424" fontSize="10" opacity="0.75" fontFamily="monospace">
            {`{ tagValue: "D-01", yoloClass: "circle", instances: [annId, annId, annId], pages: [201, 202], count: 3 }`}
          </text>
          <text x="48" y="442" fontSize="10" opacity="0.75" fontFamily="monospace">
            {`{ tagValue: "D-02", yoloClass: "circle", instances: [annId, annId, annId], pages: [201, 202], count: 3 }`}
          </text>
          <text x="900" y="424" fontSize="9" opacity="0.55" fontFamily="monospace" textAnchor="end">
            → Detection Panel · Tags sub-tab
          </text>
        </g>
      </svg>
    </div>
  );
}
