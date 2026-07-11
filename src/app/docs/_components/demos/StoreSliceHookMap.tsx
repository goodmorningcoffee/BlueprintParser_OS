/** Viewer client-state access map. Project/session metadata has its own Zustand leaf; UI/tool state
 *  remains in viewerStore while server-owned collections sit behind project-keyed query facades.
 *  Keeping all three ownership families visible here
 *  prevents future features from reaching around their domain's public API. */
const SLICES = [
  { name: "useNavigation",           line: 1435, purpose: "pageNumber, numPages, mode" },
  { name: "usePanels",               line: 1446, purpose: "12 showX flags + toggles" },
  { name: "useSelection",            line: 1486, purpose: "multi-select ids + helpers" },
  // [refactor jul10 P2.2⑤] row rewritten: the store selector is deleted (its `line: 1737` was
  // already stale pre-migration); the facade lives in src/queries/useAnnotationGroups.ts
  // (groups+memberships in the query cache, Set indexes derived in-hook; selection stays zustand).
  { name: "useAnnotationGroups",     line: 170,  purpose: "→ src/queries facade (P2.2⑤): groups+memberships in query cache, selection stays zustand" },
  // [refactor jul11 P2.2⑥] Flat chunk-windowed annotation data + CRUD moved to the facade;
  // focus/selection/visibility/tool history remain zustand-owned.
  { name: "useAnnotations",          line: 308,  purpose: "→ src/queries facade (P2.2⑥): annotations in query cache; UI/tool state stays zustand" },
  { name: "useDrawingState",         line: 1501, purpose: "_drawing/_drawStart/_drawEnd/_mousePos" },
  { name: "useSymbolSearch",         line: 1514, purpose: "results, confidence, dismissed" },
  { name: "useChat",                 line: 1543, purpose: "chatScope (messages → query cache, P2.2①)" },
  { name: "useTableParse",           line: 1550, purpose: "step, region, grid, col/row BBs" },
  { name: "useKeynoteParse",         line: 1579, purpose: "step, region, yolo-class bind" },
  { name: "useProject",              line: 99,   purpose: "→ sessionStore (P2.3): identity, demo policy, page labels" },
  // [refactor jul11 P2.2⑦/⑧] Both server-data owners are gone; this compatibility slice now carries
  // only project-wide CSI UI/filter controls.
  { name: "usePageData",             line: 1607, purpose: "project-wide CSI filter controls only" },
  { name: "useDetection",            line: 1615, purpose: "detection models + visibility/search filters (annotation data → query cache)" },
  // [refactor jul11 P2.2⑨] Collection/CRUD + serialized debounce moved to the query facade;
  // only selection/visibility/picking/browse state remains in Zustand.
  { name: "useYoloTags",             line: 482,  purpose: "→ src/queries facade (P2.2⑨): tags in query cache; tag UI/tool state stays zustand" },
  { name: "useTextAnnotationDisplay",line: 1634, purpose: "shown types + colors + hidden set" },
  { name: "useAnnotationFilters",    line: 1650, purpose: "active filter, csi filter, trade filter" },
  // [refactor jul10 P2.2②] row rewritten: the old entry was doubly stale (line pointed at useChat;
  // purpose described table-parse state). The store selector is deleted; the facade lives in
  // src/queries/useQtoWorkflows.ts (list → query cache; activeQtoWorkflow stays zustand).
  { name: "useQtoWorkflows",         line: 39,   purpose: "→ src/queries facade (P2.2②): list in query cache, active stays zustand" },
  // [refactor jul11 P2.2⑦] The temporary summary→chunk passthrough is gone; summaries and the
  // active page window are independent cache domains with independent narrow subscriptions.
  { name: "useSummaries",            line: 108,  purpose: "→ src/queries facade (P2.2③): cache-only project summaries" },
  { name: "usePageWindow",           line: 43,   purpose: "→ src/queries facade (P2.2⑦): range + per-page keynote/CSI/text/PI maps" },
  // [refactor jul11 P2.2⑧] Heavy OCR is one Query per project/page with central 12-page+8MiB rails;
  // page readers are narrow and PageSidebar is the sole passive bounded-map exception.
  { name: "useTextractForPage",      line: 24,   purpose: "→ src/queries facade (P2.2⑧): bounded per-page OCR; headless 200ms loader" },
  // [refactor jul10 P2.2④] NEW row (takeoff never had a store slice selector — consumers read the
  // raw fields): items+groups now live in the query cache behind TWO deliberate hooks in
  // src/queries/useTakeoff.ts (no combined hook — canvas-adjacent items-only readers must not
  // gain group-write re-renders). UI fields (panel flag, active pointer, visibility set, tab)
  // stay zustand.
  { name: "useTakeoffItems/Groups",  line: 121,  purpose: "→ src/queries facade (P2.2④): items+groups in query cache (two hooks), takeoff UI state stays zustand" },
];

export function StoreSliceHookMap() {
  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox="0 0 960 780"
        className="w-full h-auto text-[var(--fg)]"
        fill="currentColor"
        role="img"
        aria-label="Viewer client-state map — Zustand slices and project-keyed query facades"
      >
        <text x="480" y="22" textAnchor="middle" fontSize="14" fontWeight="bold">
          Viewer client state — {SLICES.length} narrow access surfaces
        </text>
        <text x="480" y="38" textAnchor="middle" fontSize="10" opacity="0.6">
          Session/UI state uses separate Zustand leaves; server data uses project-keyed Query facades.
        </text>

        {/* Central store */}
        <g>
          <circle cx="480" cy="400" r="78" fill="none" stroke="#60a5fa" strokeWidth="2.5" />
          <text x="480" y="390" textAnchor="middle" fontSize="13" fontWeight="bold" fill="#60a5fa">useViewerStore</text>
          <text x="480" y="408" textAnchor="middle" fontSize="10" opacity="0.75" fontFamily="monospace">L577</text>
          <text x="480" y="424" textAnchor="middle" fontSize="9" opacity="0.6">(UI/tool state; session is a separate leaf)</text>
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
            Rule: use the domain facade shown here; direct store/cache access is reserved for documented handler-time bridges.
          </text>
        </g>
      </svg>
    </div>
  );
}
