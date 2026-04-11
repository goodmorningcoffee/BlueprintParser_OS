/** AWS + app topology diagram. Inline SVG because (a) zero runtime deps,
 *  (b) themeable via currentColor + CSS variables, (c) git-diffable.
 *  Shared between the landing hero and Section 11. */
export function ArchitectureSvgDiagram() {
  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox="0 0 900 420"
        className="w-full h-auto text-[var(--fg)]"
        role="img"
        aria-label="BlueprintParser AWS architecture diagram"
      >
        <defs>
          <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" opacity="0.5" />
          </marker>
        </defs>

        {/* Title */}
        <text x="450" y="22" textAnchor="middle" fontSize="14" fontWeight="bold" fill="currentColor">
          BlueprintParser &mdash; AWS runtime
        </text>

        {/* Row 1: Ingress */}
        <g>
          <rect x="20" y="50" width="120" height="54" rx="6" fill="none" stroke="currentColor" opacity="0.6" strokeWidth="1.5" />
          <text x="80" y="72" textAnchor="middle" fontSize="11" fontWeight="bold">User browser</text>
          <text x="80" y="88" textAnchor="middle" fontSize="10" opacity="0.7">/home, /project, /docs</text>
        </g>

        <line x1="140" y1="77" x2="190" y2="77" stroke="currentColor" strokeWidth="1.5" opacity="0.4" markerEnd="url(#arr)" />

        <g>
          <rect x="190" y="50" width="130" height="54" rx="6" fill="none" stroke="#60a5fa" strokeWidth="1.5" />
          <text x="255" y="72" textAnchor="middle" fontSize="11" fontWeight="bold" fill="#60a5fa">CloudFront</text>
          <text x="255" y="88" textAnchor="middle" fontSize="10" opacity="0.7">assets.*, CORS at edge</text>
        </g>

        <line x1="320" y1="77" x2="370" y2="77" stroke="currentColor" strokeWidth="1.5" opacity="0.4" markerEnd="url(#arr)" />

        <g>
          <rect x="370" y="50" width="120" height="54" rx="6" fill="none" stroke="#60a5fa" strokeWidth="1.5" />
          <text x="430" y="72" textAnchor="middle" fontSize="11" fontWeight="bold" fill="#60a5fa">ALB</text>
          <text x="430" y="88" textAnchor="middle" fontSize="10" opacity="0.7">HTTPS → 3000 / 8080</text>
        </g>

        <line x1="490" y1="77" x2="540" y2="77" stroke="currentColor" strokeWidth="1.5" opacity="0.4" markerEnd="url(#arr)" />

        <g>
          <rect x="540" y="40" width="160" height="74" rx="6" fill="none" stroke="#22c55e" strokeWidth="1.5" />
          <text x="620" y="60" textAnchor="middle" fontSize="11" fontWeight="bold" fill="#22c55e">ECS Fargate</text>
          <text x="620" y="76" textAnchor="middle" fontSize="10" opacity="0.85">blueprintparser-app</text>
          <text x="620" y="90" textAnchor="middle" fontSize="9" opacity="0.6">2 vCPU / 4 GB</text>
          <text x="620" y="104" textAnchor="middle" fontSize="9" opacity="0.6">Next.js 16</text>
        </g>

        <g>
          <rect x="720" y="40" width="160" height="74" rx="6" fill="none" stroke="#22c55e" strokeWidth="1.5" opacity="0.8" />
          <text x="800" y="60" textAnchor="middle" fontSize="11" fontWeight="bold" fill="#22c55e">Label Studio</text>
          <text x="800" y="76" textAnchor="middle" fontSize="10" opacity="0.85">ECS + EFS</text>
          <text x="800" y="90" textAnchor="middle" fontSize="9" opacity="0.6">labelstudio.*</text>
        </g>

        {/* Row 2: Stores */}
        <line x1="600" y1="114" x2="600" y2="170" stroke="currentColor" strokeWidth="1.5" opacity="0.4" markerEnd="url(#arr)" />
        <line x1="640" y1="114" x2="740" y2="170" stroke="currentColor" strokeWidth="1.5" opacity="0.4" markerEnd="url(#arr)" />
        <line x1="560" y1="114" x2="460" y2="170" stroke="currentColor" strokeWidth="1.5" opacity="0.4" markerEnd="url(#arr)" />

        <g>
          <rect x="380" y="170" width="160" height="54" rx="6" fill="none" stroke="#f97316" strokeWidth="1.5" />
          <text x="460" y="192" textAnchor="middle" fontSize="11" fontWeight="bold" fill="#f97316">RDS PostgreSQL 16</text>
          <text x="460" y="208" textAnchor="middle" fontSize="10" opacity="0.7">projects, pages, annotations</text>
        </g>

        <g>
          <rect x="560" y="170" width="160" height="54" rx="6" fill="none" stroke="#f97316" strokeWidth="1.5" />
          <text x="640" y="192" textAnchor="middle" fontSize="11" fontWeight="bold" fill="#f97316">S3</text>
          <text x="640" y="208" textAnchor="middle" fontSize="10" opacity="0.7">PDFs, page PNGs, YOLO out</text>
        </g>

        <g>
          <rect x="740" y="170" width="140" height="54" rx="6" fill="none" stroke="#f97316" strokeWidth="1.5" />
          <text x="810" y="192" textAnchor="middle" fontSize="11" fontWeight="bold" fill="#f97316">Secrets Manager</text>
          <text x="810" y="208" textAnchor="middle" fontSize="10" opacity="0.7">DB, NEXTAUTH, LLM keys</text>
        </g>

        {/* Row 3: Processing side-car */}
        <line x1="600" y1="114" x2="200" y2="260" stroke="currentColor" strokeWidth="1.5" opacity="0.4" strokeDasharray="3 3" markerEnd="url(#arr)" />

        <g>
          <rect x="100" y="260" width="180" height="56" rx="6" fill="none" stroke="#a855f7" strokeWidth="1.5" />
          <text x="190" y="282" textAnchor="middle" fontSize="11" fontWeight="bold" fill="#a855f7">Step Functions</text>
          <text x="190" y="298" textAnchor="middle" fontSize="10" opacity="0.7">blueprintparser-</text>
          <text x="190" y="310" textAnchor="middle" fontSize="10" opacity="0.7">process-blueprint</text>
        </g>

        <line x1="280" y1="288" x2="330" y2="288" stroke="currentColor" strokeWidth="1.5" opacity="0.4" markerEnd="url(#arr)" />

        <g>
          <rect x="330" y="260" width="180" height="56" rx="6" fill="none" stroke="#22c55e" strokeWidth="1.5" />
          <text x="420" y="280" textAnchor="middle" fontSize="11" fontWeight="bold" fill="#22c55e">ECS Fargate</text>
          <text x="420" y="294" textAnchor="middle" fontSize="10" opacity="0.85">cpu-pipeline task</text>
          <text x="420" y="308" textAnchor="middle" fontSize="9" opacity="0.6">process-worker.js</text>
        </g>

        <line x1="510" y1="288" x2="560" y2="288" stroke="currentColor" strokeWidth="1.5" opacity="0.4" markerEnd="url(#arr)" />

        <g>
          <rect x="560" y="260" width="170" height="56" rx="6" fill="none" stroke="#60a5fa" strokeWidth="1.5" />
          <text x="645" y="282" textAnchor="middle" fontSize="11" fontWeight="bold" fill="#60a5fa">Textract</text>
          <text x="645" y="298" textAnchor="middle" fontSize="10" opacity="0.7">(Tesseract fallback)</text>
        </g>

        <line x1="730" y1="288" x2="780" y2="288" stroke="currentColor" strokeWidth="1.5" opacity="0.4" markerEnd="url(#arr)" />

        <g>
          <rect x="780" y="260" width="100" height="56" rx="6" fill="none" stroke="#f97316" strokeWidth="1.5" />
          <text x="830" y="282" textAnchor="middle" fontSize="11" fontWeight="bold" fill="#f97316">S3</text>
          <text x="830" y="298" textAnchor="middle" fontSize="10" opacity="0.7">pages/*.png</text>
        </g>

        {/* Row 4: SageMaker on-demand */}
        <line x1="420" y1="316" x2="420" y2="360" stroke="currentColor" strokeWidth="1.5" opacity="0.4" strokeDasharray="3 3" markerEnd="url(#arr)" />

        <g>
          <rect x="280" y="360" width="300" height="44" rx="6" fill="none" stroke="#ec4899" strokeWidth="1.5" />
          <text x="430" y="382" textAnchor="middle" fontSize="11" fontWeight="bold" fill="#ec4899">SageMaker Processing — ml.g4dn.xlarge</text>
          <text x="430" y="396" textAnchor="middle" fontSize="10" opacity="0.7">YOLO inference (admin-initiated)</text>
        </g>

        {/* Legend */}
        <g fontSize="9" opacity="0.65">
          <circle cx="30" cy="400" r="4" fill="#60a5fa" />
          <text x="42" y="403">Ingress / edge</text>
          <circle cx="130" cy="400" r="4" fill="#22c55e" />
          <text x="142" y="403">Compute</text>
          <circle cx="210" cy="400" r="4" fill="#f97316" />
          <text x="222" y="403">Storage</text>
          <circle cx="270" cy="400" r="4" fill="#a855f7" />
          <text x="282" y="403">Orchestration</text>
          <circle cx="370" cy="400" r="4" fill="#ec4899" />
          <text x="382" y="403">GPU (on-demand)</text>
        </g>
      </svg>
    </div>
  );
}
