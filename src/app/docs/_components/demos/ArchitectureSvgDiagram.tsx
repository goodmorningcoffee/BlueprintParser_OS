/** AWS + app topology diagram. Inline SVG because (a) zero runtime deps,
 *  (b) themeable via currentColor + CSS variables, (c) git-diffable.
 *  Shared between the landing hero and Section 11. */
export function ArchitectureSvgDiagram() {
  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox="0 0 900 420"
        className="w-full h-auto text-[var(--fg)]"
        fill="currentColor"
        role="img"
        aria-label="BlueprintParser AWS architecture diagram"
      >
        <defs>
          <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" opacity="0.6" />
          </marker>
        </defs>

        {/* Title */}
        <text x="450" y="26" textAnchor="middle" fontSize="18" fontWeight="bold" fill="currentColor">
          BlueprintParser &mdash; AWS runtime
        </text>

        {/* Row 1: Ingress */}
        <g>
          <rect x="20" y="58" width="130" height="60" rx="6" fill="none" stroke="currentColor" opacity="0.6" strokeWidth="1.8" />
          <text x="85" y="84" textAnchor="middle" fontSize="14" fontWeight="bold">User browser</text>
          <text x="85" y="104" textAnchor="middle" fontSize="12" opacity="0.75">/home, /project, /docs</text>
        </g>

        <line x1="150" y1="88" x2="200" y2="88" stroke="currentColor" strokeWidth="1.8" opacity="0.5" markerEnd="url(#arr)" />

        <g>
          <rect x="200" y="58" width="140" height="60" rx="6" fill="none" stroke="#60a5fa" strokeWidth="1.8" />
          <text x="270" y="84" textAnchor="middle" fontSize="14" fontWeight="bold" fill="#60a5fa">CloudFront</text>
          <text x="270" y="104" textAnchor="middle" fontSize="12" opacity="0.75">assets.*, CORS at edge</text>
        </g>

        <line x1="340" y1="88" x2="390" y2="88" stroke="currentColor" strokeWidth="1.8" opacity="0.5" markerEnd="url(#arr)" />

        <g>
          <rect x="390" y="58" width="130" height="60" rx="6" fill="none" stroke="#60a5fa" strokeWidth="1.8" />
          <text x="455" y="84" textAnchor="middle" fontSize="14" fontWeight="bold" fill="#60a5fa">ALB</text>
          <text x="455" y="104" textAnchor="middle" fontSize="12" opacity="0.75">HTTPS → 3000 / 8080</text>
        </g>

        <line x1="520" y1="88" x2="570" y2="88" stroke="currentColor" strokeWidth="1.8" opacity="0.5" markerEnd="url(#arr)" />

        <g>
          <rect x="570" y="46" width="160" height="84" rx="6" fill="none" stroke="#22c55e" strokeWidth="1.8" />
          <text x="650" y="70" textAnchor="middle" fontSize="14" fontWeight="bold" fill="#22c55e">ECS Fargate</text>
          <text x="650" y="90" textAnchor="middle" fontSize="12" opacity="0.85">blueprintparser-app</text>
          <text x="650" y="106" textAnchor="middle" fontSize="11" opacity="0.7">2 vCPU / 4 GB</text>
          <text x="650" y="121" textAnchor="middle" fontSize="11" opacity="0.7">Next.js 16</text>
        </g>

        <g>
          <rect x="750" y="46" width="140" height="84" rx="6" fill="none" stroke="#22c55e" strokeWidth="1.8" opacity="0.85" />
          <text x="820" y="70" textAnchor="middle" fontSize="14" fontWeight="bold" fill="#22c55e">Label Studio</text>
          <text x="820" y="90" textAnchor="middle" fontSize="12" opacity="0.85">ECS + EFS</text>
          <text x="820" y="108" textAnchor="middle" fontSize="11" opacity="0.7">labelstudio.*</text>
        </g>

        {/* Row 2: Stores */}
        <line x1="620" y1="130" x2="620" y2="178" stroke="currentColor" strokeWidth="1.8" opacity="0.5" markerEnd="url(#arr)" />
        <line x1="680" y1="130" x2="760" y2="178" stroke="currentColor" strokeWidth="1.8" opacity="0.5" markerEnd="url(#arr)" />
        <line x1="580" y1="130" x2="470" y2="178" stroke="currentColor" strokeWidth="1.8" opacity="0.5" markerEnd="url(#arr)" />

        <g>
          <rect x="380" y="178" width="170" height="62" rx="6" fill="none" stroke="#f97316" strokeWidth="1.8" />
          <text x="465" y="204" textAnchor="middle" fontSize="14" fontWeight="bold" fill="#f97316">RDS PostgreSQL 16</text>
          <text x="465" y="223" textAnchor="middle" fontSize="12" opacity="0.75">projects, pages, annotations</text>
        </g>

        <g>
          <rect x="570" y="178" width="160" height="62" rx="6" fill="none" stroke="#f97316" strokeWidth="1.8" />
          <text x="650" y="204" textAnchor="middle" fontSize="14" fontWeight="bold" fill="#f97316">S3</text>
          <text x="650" y="223" textAnchor="middle" fontSize="12" opacity="0.75">PDFs, page PNGs, YOLO out</text>
        </g>

        <g>
          <rect x="750" y="178" width="140" height="62" rx="6" fill="none" stroke="#f97316" strokeWidth="1.8" />
          <text x="820" y="204" textAnchor="middle" fontSize="14" fontWeight="bold" fill="#f97316">Secrets Manager</text>
          <text x="820" y="223" textAnchor="middle" fontSize="12" opacity="0.75">DB, NEXTAUTH, LLM keys</text>
        </g>

        {/* Row 3: Processing side-car */}
        <line x1="620" y1="130" x2="210" y2="270" stroke="currentColor" strokeWidth="1.8" opacity="0.5" strokeDasharray="4 3" markerEnd="url(#arr)" />

        <g>
          <rect x="30" y="270" width="200" height="70" rx="6" fill="none" stroke="#a855f7" strokeWidth="1.8" />
          <text x="130" y="296" textAnchor="middle" fontSize="14" fontWeight="bold" fill="#a855f7">Step Functions</text>
          <text x="130" y="316" textAnchor="middle" fontSize="12" opacity="0.75">blueprintparser-</text>
          <text x="130" y="332" textAnchor="middle" fontSize="12" opacity="0.75">process-blueprint</text>
        </g>

        <line x1="230" y1="305" x2="275" y2="305" stroke="currentColor" strokeWidth="1.8" opacity="0.5" markerEnd="url(#arr)" />

        <g>
          <rect x="275" y="270" width="200" height="70" rx="6" fill="none" stroke="#22c55e" strokeWidth="1.8" />
          <text x="375" y="294" textAnchor="middle" fontSize="14" fontWeight="bold" fill="#22c55e">ECS Fargate</text>
          <text x="375" y="312" textAnchor="middle" fontSize="12" opacity="0.85">cpu-pipeline task</text>
          <text x="375" y="328" textAnchor="middle" fontSize="11" opacity="0.7">process-worker.js</text>
        </g>

        <line x1="475" y1="305" x2="520" y2="305" stroke="currentColor" strokeWidth="1.8" opacity="0.5" markerEnd="url(#arr)" />

        <g>
          <rect x="520" y="270" width="190" height="70" rx="6" fill="none" stroke="#60a5fa" strokeWidth="1.8" />
          <text x="615" y="296" textAnchor="middle" fontSize="14" fontWeight="bold" fill="#60a5fa">Textract</text>
          <text x="615" y="316" textAnchor="middle" fontSize="12" opacity="0.75">(Tesseract fallback)</text>
        </g>

        <line x1="710" y1="305" x2="755" y2="305" stroke="currentColor" strokeWidth="1.8" opacity="0.5" markerEnd="url(#arr)" />

        <g>
          <rect x="755" y="270" width="130" height="70" rx="6" fill="none" stroke="#f97316" strokeWidth="1.8" />
          <text x="820" y="296" textAnchor="middle" fontSize="14" fontWeight="bold" fill="#f97316">S3</text>
          <text x="820" y="316" textAnchor="middle" fontSize="12" opacity="0.75">pages/*.png</text>
        </g>

        {/* Row 4: SageMaker on-demand */}
        <line x1="375" y1="340" x2="375" y2="360" stroke="currentColor" strokeWidth="1.8" opacity="0.5" strokeDasharray="4 3" markerEnd="url(#arr)" />

        <g>
          <rect x="230" y="358" width="360" height="52" rx="6" fill="none" stroke="#ec4899" strokeWidth="1.8" />
          <text x="410" y="384" textAnchor="middle" fontSize="14" fontWeight="bold" fill="#ec4899">SageMaker Processing — ml.g4dn.xlarge</text>
          <text x="410" y="402" textAnchor="middle" fontSize="12" opacity="0.75">YOLO inference (admin-initiated)</text>
        </g>
      </svg>
    </div>
  );
}
