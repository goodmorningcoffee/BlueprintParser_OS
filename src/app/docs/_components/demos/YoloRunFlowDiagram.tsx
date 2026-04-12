/** End-to-end YOLO run flow: admin button click → SageMaker Processing job →
 *  S3 output → webhook ingest → annotations table + CSI/heuristic re-run.
 *  Verified against src/lib/yolo.ts startYoloJob() and POST /api/yolo/load. */
export function YoloRunFlowDiagram() {
  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox="0 0 960 460"
        className="w-full h-auto text-[var(--fg)]"
        fill="currentColor"
        role="img"
        aria-label="YOLO run flow: admin → SageMaker → S3 → webhook → annotations"
      >
        <defs>
          <marker id="yarr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" opacity="0.6" />
          </marker>
        </defs>

        <text x="480" y="24" textAnchor="middle" fontSize="14" fontWeight="bold">
          YOLO run flow &mdash; admin click to loaded annotations
        </text>
        <text x="480" y="40" textAnchor="middle" fontSize="10" opacity="0.6">
          The viewer&apos;s YOLO toggle only displays results. Inference is initiated only here.
        </text>

        {/* Row 1 */}
        <g>
          <rect x="30" y="70" width="180" height="74" rx="6" fill="none" stroke="#60a5fa" strokeWidth="1.8" />
          <text x="120" y="94" textAnchor="middle" fontSize="12" fontWeight="bold" fill="#60a5fa">Admin → AI Models</text>
          <text x="120" y="112" textAnchor="middle" fontSize="10" opacity="0.75">pick model + project</text>
          <text x="120" y="128" textAnchor="middle" fontSize="10" opacity="0.75">click Run</text>
        </g>
        <line x1="210" y1="107" x2="260" y2="107" stroke="currentColor" strokeWidth="1.6" opacity="0.5" markerEnd="url(#yarr)" />

        <g>
          <rect x="260" y="70" width="200" height="74" rx="6" fill="none" stroke="#22c55e" strokeWidth="1.8" />
          <text x="360" y="92" textAnchor="middle" fontSize="12" fontWeight="bold" fill="#22c55e">POST /api/yolo/run</text>
          <text x="360" y="110" textAnchor="middle" fontSize="10" opacity="0.75" fontFamily="monospace">processingJobs row</text>
          <text x="360" y="126" textAnchor="middle" fontSize="10" opacity="0.75" fontFamily="monospace">startYoloJob()</text>
        </g>
        <line x1="460" y1="107" x2="510" y2="107" stroke="currentColor" strokeWidth="1.6" opacity="0.5" markerEnd="url(#yarr)" />

        <g>
          <rect x="510" y="56" width="220" height="100" rx="6" fill="none" stroke="#ec4899" strokeWidth="2" />
          <text x="620" y="80" textAnchor="middle" fontSize="13" fontWeight="bold" fill="#ec4899">SageMaker Processing</text>
          <text x="620" y="98" textAnchor="middle" fontSize="11" opacity="0.8">ml.g4dn.xlarge</text>
          <text x="620" y="116" textAnchor="middle" fontSize="10" opacity="0.65">YOLO ECR image</text>
          <text x="620" y="134" textAnchor="middle" fontSize="9" opacity="0.55" fontFamily="monospace">in: pages/ · out: yolo-output/</text>
        </g>
        <line x1="730" y1="107" x2="780" y2="107" stroke="currentColor" strokeWidth="1.6" opacity="0.5" markerEnd="url(#yarr)" />

        <g>
          <rect x="780" y="70" width="150" height="74" rx="6" fill="none" stroke="#f97316" strokeWidth="1.8" />
          <text x="855" y="92" textAnchor="middle" fontSize="12" fontWeight="bold" fill="#f97316">S3 yolo-output</text>
          <text x="855" y="110" textAnchor="middle" fontSize="10" opacity="0.75">per-page detection JSON</text>
          <text x="855" y="126" textAnchor="middle" fontSize="9" opacity="0.55" fontFamily="monospace">page-N.json</text>
        </g>

        {/* Drop down to row 2 from S3 */}
        <line x1="855" y1="144" x2="855" y2="200" stroke="currentColor" strokeWidth="1.6" opacity="0.5" markerEnd="url(#yarr)" />

        {/* Row 2 — webhook ingest */}
        <g>
          <rect x="700" y="200" width="230" height="74" rx="6" fill="none" stroke="#22c55e" strokeWidth="1.8" />
          <text x="815" y="224" textAnchor="middle" fontSize="12" fontWeight="bold" fill="#22c55e">POST /api/yolo/load</text>
          <text x="815" y="242" textAnchor="middle" fontSize="10" opacity="0.75">webhook on job complete</text>
          <text x="815" y="258" textAnchor="middle" fontSize="9" opacity="0.55" fontFamily="monospace">normalize → annotations</text>
        </g>
        <line x1="700" y1="237" x2="650" y2="237" stroke="currentColor" strokeWidth="1.6" opacity="0.5" markerEnd="url(#yarr)" />

        <g>
          <rect x="450" y="200" width="200" height="74" rx="6" fill="none" stroke="#f97316" strokeWidth="1.8" />
          <text x="550" y="224" textAnchor="middle" fontSize="12" fontWeight="bold" fill="#f97316">annotations table</text>
          <text x="550" y="242" textAnchor="middle" fontSize="10" opacity="0.75" fontFamily="monospace">source = &quot;yolo&quot;</text>
          <text x="550" y="258" textAnchor="middle" fontSize="9" opacity="0.55">composite-classifier post-hook</text>
        </g>
        <line x1="450" y1="237" x2="400" y2="237" stroke="currentColor" strokeWidth="1.6" opacity="0.5" markerEnd="url(#yarr)" />

        <g>
          <rect x="190" y="200" width="210" height="74" rx="6" fill="none" stroke="#a855f7" strokeWidth="1.8" />
          <text x="295" y="224" textAnchor="middle" fontSize="12" fontWeight="bold" fill="#a855f7">Refresh CSI heatmap</text>
          <text x="295" y="242" textAnchor="middle" fontSize="10" opacity="0.75">+ heuristic engine</text>
          <text x="295" y="258" textAnchor="middle" fontSize="9" opacity="0.55">YOLO-augmented mode</text>
        </g>

        {/* Status polling note */}
        <g>
          <rect x="30" y="200" width="140" height="74" rx="6" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.55" strokeDasharray="3 3" />
          <text x="100" y="222" textAnchor="middle" fontSize="11" fontWeight="bold" opacity="0.75">UI polls</text>
          <text x="100" y="240" textAnchor="middle" fontSize="10" opacity="0.6" fontFamily="monospace">/api/yolo/status</text>
          <text x="100" y="256" textAnchor="middle" fontSize="9" opacity="0.5">~5s while job runs</text>
        </g>

        {/* Safety toggles row */}
        <text x="30" y="320" fontSize="11" fontWeight="bold" opacity="0.8">Safety layers (all must pass):</text>
        {[
          { x: 30,  label: "sagemakerEnabled", sub: "company toggle, password-gated" },
          { x: 250, label: "quota cap", sub: "concurrent processingJobs" },
          { x: 460, label: "canRunModels", sub: "per-user permission" },
          { x: 670, label: "modelAccess", sub: "root admin grants per-company" },
        ].map((s) => (
          <g key={s.label}>
            <rect x={s.x} y="335" width="200" height="56" rx="4" fill="none" stroke="#f59e0b" strokeWidth="1.4" opacity="0.85" />
            <text x={s.x + 100} y="358" textAnchor="middle" fontSize="11" fontWeight="bold" fill="#f59e0b">{s.label}</text>
            <text x={s.x + 100} y="376" textAnchor="middle" fontSize="9" opacity="0.65">{s.sub}</text>
          </g>
        ))}

        <text x="30" y="430" fontSize="10" opacity="0.55" fontFamily="monospace">
          src/lib/yolo.ts:startYoloJob → infrastructure/terraform/sagemaker.tf
        </text>
      </svg>
    </div>
  );
}
