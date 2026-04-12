/** Conceptual layout of the blueprint viewer chrome.
 *  Toolbar on top, sidebar on left, canvas in the middle, right-side panel
 *  stack, annotation panel along the bottom. Shape only — no real screenshot. */
export function ViewerAnatomyDiagram() {
  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox="0 0 900 500"
        className="w-full h-auto text-[var(--fg)]"
        fill="currentColor"
        role="img"
        aria-label="Viewer anatomy: toolbar, sidebar, canvas, right-side panels, annotation panel"
      >
        <text x="450" y="22" textAnchor="middle" fontSize="14" fontWeight="bold">
          Viewer chrome &mdash; one canvas, six toggleable panels
        </text>
        <text x="450" y="38" textAnchor="middle" fontSize="10" opacity="0.6">
          Every region is independently toggleable; panels remember their open state per session.
        </text>

        {/* Toolbar */}
        <g>
          <rect x="40" y="60" width="820" height="40" rx="4" fill="none" stroke="#60a5fa" strokeWidth="1.8" />
          <text x="60" y="86" fontSize="12" fontWeight="bold" fill="#60a5fa">Toolbar</text>
          <text x="160" y="86" fontSize="11" opacity="0.7" fontFamily="monospace">
            zoom · mode · symbol · menu · search · trade · CSI · YOLO · 6 panel toggles
          </text>
        </g>

        {/* Sidebar */}
        <g>
          <rect x="40" y="110" width="120" height="300" rx="4" fill="none" stroke="currentColor" opacity="0.55" strokeWidth="1.5" />
          <text x="100" y="138" textAnchor="middle" fontSize="12" fontWeight="bold">Sidebar</text>
          <text x="100" y="154" textAnchor="middle" fontSize="9" opacity="0.6">page thumbnails</text>
          {[0, 1, 2, 3].map((i) => (
            <rect key={i} x="60" y={170 + i * 56} width="80" height="44" rx="2" fill="none" stroke="currentColor" opacity="0.4" />
          ))}
        </g>

        {/* Canvas */}
        <g>
          <rect x="170" y="110" width="500" height="300" rx="4" fill="none" stroke="#22c55e" strokeWidth="2" />
          <text x="420" y="138" textAnchor="middle" fontSize="13" fontWeight="bold" fill="#22c55e">Canvas</text>
          <text x="420" y="156" textAnchor="middle" fontSize="10" opacity="0.7">PDF page + overlay layers</text>
          <text x="420" y="180" textAnchor="middle" fontSize="9" opacity="0.55" fontFamily="monospace">
            Search · TextAnnotation · Keynote · Annotation · ParseRegion · GuidedParse · DrawingPreview
          </text>
          {/* Conceptual page outline + a couple of fake bbox overlays */}
          <rect x="220" y="200" width="400" height="180" fill="none" stroke="currentColor" opacity="0.35" strokeDasharray="3 3" />
          <rect x="260" y="240" width="60" height="40" fill="none" stroke="#f59e0b" opacity="0.7" strokeWidth="1.4" />
          <rect x="360" y="280" width="80" height="50" fill="none" stroke="#ec4899" opacity="0.7" strokeWidth="1.4" />
          <circle cx="520" cy="260" r="18" fill="none" stroke="#a855f7" opacity="0.7" strokeWidth="1.4" />
        </g>

        {/* Right panel stack */}
        <g>
          <text x="745" y="124" textAnchor="middle" fontSize="11" fontWeight="bold" opacity="0.85">Right panels</text>
          {["Text", "CSI", "LLM Chat", "QTO", "Tables", "Keynotes"].map((label, i) => (
            <g key={label}>
              <rect x="690" y={134 + i * 46} width="170" height="38" rx="3" fill="none" stroke="#a855f7" opacity="0.7" strokeWidth="1.4" />
              <text x="775" y={158 + i * 46} textAnchor="middle" fontSize="11" fontWeight="bold" fill="#a855f7">
                {label}
              </text>
            </g>
          ))}
        </g>

        {/* Annotation panel */}
        <g>
          <rect x="40" y="420" width="820" height="50" rx="4" fill="none" stroke="#f97316" strokeWidth="1.8" />
          <text x="60" y="446" fontSize="12" fontWeight="bold" fill="#f97316">Annotation Panel</text>
          <text x="200" y="446" fontSize="10" opacity="0.7" fontFamily="monospace">
            grouped by source: MARKUPS · YOLO · TAKEOFF
          </text>
          <text x="60" y="460" fontSize="9" opacity="0.55">click an annotation to select; hover for tooltip</text>
        </g>
      </svg>
    </div>
  );
}
