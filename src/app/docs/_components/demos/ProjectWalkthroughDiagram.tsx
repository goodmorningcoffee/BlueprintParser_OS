/** The 5-step non-tech walkthrough. Illustrates the happy path a first-time
 *  estimator takes: upload → wait → look → tag → export. Zero jargon. */
const STEPS = [
  {
    n: 1,
    title: "Upload a PDF",
    sub: "Drag your drawing set into the dashboard.",
    accent: "#60a5fa",
    icon: (x: number, y: number) => (
      <g transform={`translate(${x}, ${y})`}>
        <rect x="-20" y="-24" width="40" height="48" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <line x1="-10" y1="-12" x2="10" y2="-12" stroke="currentColor" strokeWidth="1" />
        <line x1="-10" y1="-4" x2="10" y2="-4" stroke="currentColor" strokeWidth="1" />
        <line x1="-10" y1="4" x2="10" y2="4" stroke="currentColor" strokeWidth="1" />
        <path d="M 0 26 L 0 36 M -5 31 L 0 36 L 5 31" stroke="currentColor" strokeWidth="1.5" fill="none" />
      </g>
    ),
  },
  {
    n: 2,
    title: "BP reads the pages",
    sub: "OCR, CSI codes, schedules, title blocks — automatic.",
    accent: "#a855f7",
    icon: (x: number, y: number) => (
      <g transform={`translate(${x}, ${y})`}>
        <rect x="-22" y="-22" width="44" height="44" rx="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M -12 -8 Q -6 -14 0 -8 T 12 -8" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <path d="M -12 2  Q -6 -4  0 2  T 12 2" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="14" cy="14" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <line x1="18" y1="18" x2="22" y2="22" stroke="currentColor" strokeWidth="1.5" />
      </g>
    ),
  },
  {
    n: 3,
    title: "Open the viewer",
    sub: "Pan, zoom, search. Panels on the right for every feature.",
    accent: "#22c55e",
    icon: (x: number, y: number) => (
      <g transform={`translate(${x}, ${y})`}>
        <rect x="-24" y="-20" width="48" height="40" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <line x1="-24" y1="-10" x2="24" y2="-10" stroke="currentColor" strokeWidth="1" />
        <rect x="-20" y="-5" width="12" height="20" fill="currentColor" opacity="0.15" />
        <circle cx="4" cy="4" r="8" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <rect x="16" y="-5" width="6" height="22" fill="currentColor" opacity="0.2" />
      </g>
    ),
  },
  {
    n: 4,
    title: "Run detection + tag",
    sub: "YOLO finds doors & windows. Map tags from schedules to drawings.",
    accent: "#f97316",
    icon: (x: number, y: number) => (
      <g transform={`translate(${x}, ${y})`}>
        <rect x="-22" y="-18" width="44" height="36" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <rect x="-16" y="-12" width="10" height="8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2 1" />
        <rect x="0" y="-4" width="14" height="10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2 1" />
        <circle cx="-12" cy="10" r="4" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <text x="-12" y="13" textAnchor="middle" fontSize="6" fontFamily="monospace" fill="currentColor">D1</text>
      </g>
    ),
  },
  {
    n: 5,
    title: "Export",
    sub: "Takeoff numbers + CSV / Excel for the bid package.",
    accent: "#ec4899",
    icon: (x: number, y: number) => (
      <g transform={`translate(${x}, ${y})`}>
        <rect x="-22" y="-22" width="44" height="44" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <line x1="-22" y1="-10" x2="22" y2="-10" stroke="currentColor" strokeWidth="1" />
        <line x1="0" y1="-22" x2="0" y2="22" stroke="currentColor" strokeWidth="1" />
        <text x="-11" y="-14" textAnchor="middle" fontSize="6" fill="currentColor">qty</text>
        <text x="11" y="-14" textAnchor="middle" fontSize="6" fill="currentColor">$</text>
        <path d="M 26 8 L 36 8 M 31 3 L 36 8 L 31 13" stroke="currentColor" strokeWidth="1.5" fill="none" />
      </g>
    ),
  },
];

export function ProjectWalkthroughDiagram() {
  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox="0 0 1060 220"
        className="w-full h-auto text-[var(--fg)]"
        fill="currentColor"
        role="img"
        aria-label="Five-step walkthrough: upload, read, view, detect, export"
      >
        <defs>
          <marker id="wt-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" opacity="0.6" />
          </marker>
        </defs>

        <text x="530" y="22" textAnchor="middle" fontSize="14" fontWeight="bold">
          Your first project — 5 steps from PDF to bid-ready numbers
        </text>

        {STEPS.map((s, i) => {
          const x = 40 + i * 202;
          const y = 80;
          return (
            <g key={s.n}>
              {/* icon area */}
              <circle cx={x + 50} cy={y} r="38" fill="none" stroke={s.accent} strokeWidth="2" opacity="0.9" />
              {s.icon(x + 50, y)}

              {/* number badge */}
              <circle cx={x + 82} cy={y - 30} r="12" fill="var(--bg)" stroke={s.accent} strokeWidth="1.6" />
              <text x={x + 82} y={y - 26} textAnchor="middle" fontSize="11" fontWeight="bold" fill={s.accent}>
                {s.n}
              </text>

              {/* label */}
              <text x={x + 50} y={y + 64} textAnchor="middle" fontSize="12" fontWeight="bold">
                {s.title}
              </text>
              <text x={x + 50} y={y + 84} textAnchor="middle" fontSize="10" opacity="0.7">
                {(() => {
                  // wrap long lines at commas for readability
                  const words = s.sub.split(" ");
                  const mid = Math.ceil(words.length / 2);
                  return words.slice(0, mid).join(" ");
                })()}
              </text>
              <text x={x + 50} y={y + 98} textAnchor="middle" fontSize="10" opacity="0.7">
                {(() => {
                  const words = s.sub.split(" ");
                  const mid = Math.ceil(words.length / 2);
                  return words.slice(mid).join(" ");
                })()}
              </text>

              {/* arrow to next */}
              {i < STEPS.length - 1 && (
                <line
                  x1={x + 98}
                  y1={y}
                  x2={x + 150}
                  y2={y}
                  stroke="currentColor"
                  strokeWidth="1.6"
                  opacity="0.45"
                  markerEnd="url(#wt-arr)"
                />
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
