/** The Zustand slice hook map. Verified against src/stores/viewerStore.ts:
 *  useViewerStore (main) + 17 slice selectors starting at L1675 and ending at L1977.
 *  Each slice exposes a narrow subset so components re-render only on their own
 *  state changes. This is how the 1986-LOC store doesn't blow up re-render cost. */
const SLICES = [
  { name: "useNavigation",           line: 1675, purpose: "pageNumber, numPages, mode" },
  { name: "usePanels",               line: 1686, purpose: "12 showX flags + toggles" },
  { name: "useSelection",            line: 1726, purpose: "multi-select ids + helpers" },
  { name: "useAnnotationGroups",     line: 1737, purpose: "groups, memberships, upsert" },
  { name: "useDrawingState",         line: 1751, purpose: "_drawing/_drawStart/_drawEnd/_mousePos" },
  { name: "useSymbolSearch",         line: 1764, purpose: "results, confidence, dismissed" },
  { name: "useChat",                 line: 1792, purpose: "messages, scope" },
  { name: "useTableParse",           line: 1803, purpose: "step, region, grid, col/row BBs" },
  { name: "useKeynoteParse",         line: 1832, purpose: "step, region, yolo-class bind" },
  { name: "useProject",              line: 1859, purpose: "projectId, publicId, dataUrl, isDemo" },
  { name: "usePageData",             line: 1882, purpose: "pageNames, pageDrawingNumbers" },
  { name: "useDetection",            line: 1901, purpose: "annotations, showDetections, filters" },
  { name: "useYoloTags",             line: 1921, purpose: "tags, activeId, visibility, picking mode" },
  { name: "useTextAnnotationDisplay",line: 1940, purpose: "shown types + colors + hidden set" },
  { name: "useAnnotationFilters",    line: 1956, purpose: "active filter, csi filter, trade filter" },
  { name: "useQtoWorkflow",          line: 1969, purpose: "active wf, cell structure, toggleCellHighlight" },
  { name: "useSummaries",            line: 1977, purpose: "summary arrays + chunk loader state" },
];

export function StoreSliceHookMap() {
  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox="0 0 960 780"
        className="w-full h-auto text-[var(--fg)]"
        fill="currentColor"
        role="img"
        aria-label="Viewer store slice hook map — central store with 17 slice selectors"
      >
        <text x="480" y="22" textAnchor="middle" fontSize="14" fontWeight="bold">
          viewerStore.ts — 17 slice hooks around one Zustand store
        </text>
        <text x="480" y="38" textAnchor="middle" fontSize="10" opacity="0.6">
          Subscribe via slice hooks (not individual fields) to minimize re-renders. Line numbers are verbatim.
        </text>

        {/* Central store */}
        <g>
          <circle cx="480" cy="400" r="78" fill="none" stroke="#60a5fa" strokeWidth="2.5" />
          <text x="480" y="390" textAnchor="middle" fontSize="13" fontWeight="bold" fill="#60a5fa">useViewerStore</text>
          <text x="480" y="408" textAnchor="middle" fontSize="10" opacity="0.75" fontFamily="monospace">L609</text>
          <text x="480" y="424" textAnchor="middle" fontSize="9" opacity="0.6">(ViewerState, ~1400 LOC body)</text>
        </g>

        {/* Ring of slice hooks */}
        {SLICES.map((slice, i) => {
          const angle = (i / SLICES.length) * 2 * Math.PI - Math.PI / 2;
          const rx = 310;
          const ry = 270;
          const cx = 480 + rx * Math.cos(angle);
          const cy = 400 + ry * Math.sin(angle);
          const labelOffsetX = Math.cos(angle) * 6;
          const labelOffsetY = Math.sin(angle) * 6;

          return (
            <g key={slice.name}>
              {/* connecting line */}
              <line
                x1={480 + 78 * Math.cos(angle)}
                y1={400 + 78 * Math.sin(angle)}
                x2={cx - 15 * Math.cos(angle)}
                y2={cy - 15 * Math.sin(angle)}
                stroke="currentColor"
                opacity="0.2"
                strokeWidth="1"
              />
              {/* node */}
              <rect
                x={cx - 88}
                y={cy - 18}
                width="176"
                height="36"
                rx="4"
                fill="none"
                stroke="#a855f7"
                strokeWidth="1.4"
                opacity="0.85"
              />
              <text x={cx} y={cy - 4} textAnchor="middle" fontSize="10.5" fontWeight="bold" fill="#a855f7" fontFamily="monospace">
                {slice.name}
              </text>
              <text x={cx} y={cy + 11} textAnchor="middle" fontSize="8" opacity="0.65">
                L{slice.line} — {slice.purpose}
              </text>
              {/* stub so SVG validators don't complain about unused vars */}
              <g style={{ display: "none" }}>
                <text x={cx + labelOffsetX} y={cy + labelOffsetY}>.</text>
              </g>
            </g>
          );
        })}

        {/* Legend */}
        <g>
          <rect x="30" y="740" width="900" height="32" rx="4" fill="none" stroke="currentColor" opacity="0.35" />
          <text x="50" y="760" fontSize="10" opacity="0.75">
            Rule: prefer a slice hook over <tspan fontFamily="monospace">useViewerStore(s =&gt; s.field)</tspan>. Slice hooks use <tspan fontFamily="monospace">useShallow</tspan>, so components only re-render when their slice actually changes.
          </text>
        </g>
      </svg>
    </div>
  );
}
