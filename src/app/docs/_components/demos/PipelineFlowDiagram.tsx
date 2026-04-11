/** Per-page pre-processing pipeline. Stages verified against
 *  src/lib/processing.ts:processProject() per-page body (lines ~124-326). */
const STAGES = [
  { n: 1, name: "Rasterize 300 DPI", code: "rasterizePage()", lib: "pdf-rasterize.ts" },
  { n: 2, name: "Upload PNG + thumb", code: "uploadToS3()", lib: "s3.ts" },
  { n: 3, name: "Re-raster if > 9500 px", code: "rasterizePage(safeDpi)", lib: "pdf-rasterize.ts" },
  { n: 4, name: "OCR", code: "analyzePageImageWithFallback()", lib: "textract.ts" },
  { n: 5, name: "Raw text extract", code: "extractRawText()", lib: "textract.ts" },
  { n: 6, name: "Drawing number", code: "extractDrawingNumber()", lib: "title-block.ts" },
  { n: 7, name: "CSI detection", code: "detectCsiCodes()", lib: "csi-detect.ts" },
  { n: 8, name: "Text annotations", code: "detectTextAnnotations()", lib: "text-annotations.ts" },
  { n: 9, name: "Page intelligence", code: "analyzePageIntelligence()", lib: "page-analysis.ts" },
  { n: 10, name: "Text regions", code: "classifyTextRegions()", lib: "text-region-classifier.ts" },
  { n: 11, name: "Heuristic engine (text-only)", code: "runHeuristicEngine()", lib: "heuristic-engine.ts" },
  { n: 12, name: "Table classify", code: "classifyTables()", lib: "table-classifier.ts" },
  { n: 13, name: "CSI spatial map", code: "computeCsiSpatialMap()", lib: "csi-spatial.ts" },
  { n: 14, name: "Upsert + search vector", code: "db.insert(pages)", lib: "db/schema.ts" },
];

export function PipelineFlowDiagram() {
  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox="0 0 960 600"
        className="w-full h-auto text-[var(--fg)]"
        fill="currentColor"
        role="img"
        aria-label="Per-page pre-processing pipeline diagram"
      >
        <defs>
          <marker id="arr2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" opacity="0.5" />
          </marker>
        </defs>

        <text x="480" y="24" textAnchor="middle" fontSize="14" fontWeight="bold">
          processProject() &mdash; per-page stages (concurrency 8)
        </text>
        <text x="480" y="40" textAnchor="middle" fontSize="10" opacity="0.6">
          Each stage is wrapped in try/catch — a failure does not stop subsequent stages.
        </text>

        {STAGES.map((s, i) => {
          const row = Math.floor(i / 2);
          const col = i % 2;
          const x = 40 + col * 460;
          const y = 60 + row * 70;
          return (
            <g key={s.n}>
              <rect
                x={x}
                y={y}
                width="420"
                height="54"
                rx="4"
                fill="none"
                stroke="currentColor"
                opacity="0.5"
                strokeWidth="1.2"
              />
              <circle cx={x + 26} cy={y + 27} r="14" fill="none" stroke="#60a5fa" strokeWidth="1.5" />
              <text x={x + 26} y={y + 31} textAnchor="middle" fontSize="12" fontWeight="bold" fill="#60a5fa">
                {s.n}
              </text>
              <text x={x + 52} y={y + 22} fontSize="12" fontWeight="bold">
                {s.name}
              </text>
              <text x={x + 52} y={y + 38} fontSize="10" opacity="0.75" fontFamily="monospace">
                {s.code}
              </text>
              <text x={x + 412} y={y + 38} fontSize="9" opacity="0.55" fontFamily="monospace" textAnchor="end">
                {s.lib}
              </text>
            </g>
          );
        })}

        {/* Arrows between stages */}
        {STAGES.slice(0, -1).map((_, i) => {
          const row = Math.floor(i / 2);
          const col = i % 2;
          const x = 40 + col * 460;
          const y = 60 + row * 70;
          const nextRow = Math.floor((i + 1) / 2);
          const nextCol = (i + 1) % 2;
          const nx = 40 + nextCol * 460;
          const ny = 60 + nextRow * 70;
          if (nextRow === row) {
            return (
              <line
                key={i}
                x1={x + 420}
                y1={y + 27}
                x2={nx}
                y2={ny + 27}
                stroke="currentColor"
                opacity="0.35"
                markerEnd="url(#arr2)"
              />
            );
          }
          return (
            <line
              key={i}
              x1={x + 30}
              y1={y + 54}
              x2={nx + 30}
              y2={ny}
              stroke="currentColor"
              opacity="0.35"
              markerEnd="url(#arr2)"
            />
          );
        })}

        {/* Project-level footer */}
        <rect x="40" y={60 + Math.ceil(STAGES.length / 2) * 70 + 10} width="880" height="40" rx="4" fill="none" stroke="#a855f7" strokeWidth="1.5" />
        <text x="480" y={60 + Math.ceil(STAGES.length / 2) * 70 + 34} textAnchor="middle" fontSize="11" fontWeight="bold" fill="#a855f7">
          After all pages: analyzeProject() → computeProjectSummaries() → buildCsiGraph() → warmCloudFrontCache()
        </text>
      </svg>
    </div>
  );
}
