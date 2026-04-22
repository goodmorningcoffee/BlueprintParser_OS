/** The 5 tag-mapping matcher types. Verified against
 *  src/lib/tag-mapping/matchers/{type1,type2,type3,type4,type5}*.ts
 *  and src/lib/tag-mapping/find-occurrences.ts#dispatchMatcher. */
const TYPES = [
  {
    n: 1,
    name: "yolo-only",
    accent: "#60a5fa",
    description: "Count every YOLO annotation of a given class. No text, no anchor.",
    example: "find all CIRCLE annotations on floor plans",
    shapes: [
      { shape: "circle", x: 70, y: 140 },
      { shape: "circle", x: 140, y: 140 },
      { shape: "circle", x: 210, y: 140 },
    ],
  },
  {
    n: 2,
    name: "text-only",
    accent: "#a855f7",
    description: "Count occurrences of a literal OCR string. No YOLO anchor.",
    example: "find every occurrence of “D-01” in word sequences",
    shapes: [
      { shape: "text", label: "D-01", x: 70, y: 140 },
      { shape: "text", label: "D-01", x: 160, y: 140 },
      { shape: "text", label: "D-01", x: 240, y: 140 },
    ],
  },
  {
    n: 3,
    name: "yolo-with-inner-text",
    accent: "#22c55e",
    description: "YOLO shape containing the tag text (overlap-based). Merges with free-floating text hits as fallback.",
    example: "circles containing “T-05”",
    shapes: [
      { shape: "circle-with-text", label: "T-05", x: 100, y: 140 },
      { shape: "circle-with-text", label: "T-05", x: 220, y: 140 },
    ],
  },
  {
    n: 4,
    name: "yolo-object-with-tag-shape",
    accent: "#f97316",
    description: "Primary object (e.g. door) bound to a nearby tag shape (e.g. circle) that contains the tag text. The default for Auto-QTO.",
    example: "door + circle “D-01” nearby",
    shapes: [
      { shape: "object-with-tag", label: "D-01", x: 100, y: 140 },
      { shape: "object-with-tag", label: "D-02", x: 220, y: 140 },
    ],
  },
  {
    n: 5,
    name: "yolo-object-with-nearby-text",
    accent: "#ec4899",
    description: "YOLO object with free-floating text adjacent (not inside the object bbox). Distance-based.",
    example: "door with “D-01” next to it (no shape tag)",
    shapes: [
      { shape: "object-with-text", label: "D-01", x: 100, y: 140 },
      { shape: "object-with-text", label: "D-02", x: 220, y: 140 },
    ],
  },
];

function ShapeGlyph({ kind, label, accent }: { kind: string; label?: string; accent: string }) {
  if (kind === "circle") return <circle cx="0" cy="0" r="14" fill="none" stroke={accent} strokeWidth="1.6" />;
  if (kind === "text")
    return (
      <text x="0" y="4" textAnchor="middle" fontSize="11" fontFamily="monospace" fill={accent}>
        {label}
      </text>
    );
  if (kind === "circle-with-text")
    return (
      <>
        <circle cx="0" cy="0" r="16" fill="none" stroke={accent} strokeWidth="1.6" />
        <text x="0" y="4" textAnchor="middle" fontSize="9" fontFamily="monospace" fill={accent}>
          {label}
        </text>
      </>
    );
  if (kind === "object-with-tag")
    return (
      <>
        <rect x="-18" y="-12" width="26" height="20" rx="2" fill="none" stroke={accent} strokeWidth="1.4" />
        <line x1="8" y1="-4" x2="22" y2="-12" stroke={accent} strokeWidth="0.8" opacity="0.6" />
        <circle cx="28" cy="-14" r="10" fill="none" stroke={accent} strokeWidth="1.4" />
        <text x="28" y="-11" textAnchor="middle" fontSize="8" fontFamily="monospace" fill={accent}>
          {label}
        </text>
      </>
    );
  if (kind === "object-with-text")
    return (
      <>
        <rect x="-18" y="-12" width="26" height="20" rx="2" fill="none" stroke={accent} strokeWidth="1.4" />
        <text x="22" y="-2" fontSize="9" fontFamily="monospace" fill={accent}>
          {label}
        </text>
      </>
    );
  return null;
}

export function TagMappingTypesDiagram() {
  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox="0 0 960 1120"
        className="w-full h-auto text-[var(--fg)]"
        fill="currentColor"
        role="img"
        aria-label="The 5 tag-mapping matcher types side by side with example glyphs"
      >
        <text x="480" y="22" textAnchor="middle" fontSize="14" fontWeight="bold">
          Tag-mapping — 5 matcher types
        </text>
        <text x="480" y="38" textAnchor="middle" fontSize="10" opacity="0.6">
          findOccurrences() dispatches on item.itemType; scoring is shared across all 5.
        </text>

        {TYPES.map((t, i) => {
          const y = 60 + i * 210;
          return (
            <g key={t.n}>
              <rect x="30" y={y} width="900" height="190" rx="6" fill="none" stroke={t.accent} strokeWidth="1.8" opacity="0.85" />
              <circle cx="60" cy={y + 34} r="18" fill="none" stroke={t.accent} strokeWidth="1.8" />
              <text x="60" y={y + 39} textAnchor="middle" fontSize="14" fontWeight="bold" fill={t.accent}>
                {t.n}
              </text>
              <text x="100" y={y + 32} fontSize="14" fontWeight="bold" fill={t.accent} fontFamily="monospace">
                {t.name}
              </text>
              <text x="100" y={y + 52} fontSize="11" opacity="0.8">
                {t.description}
              </text>
              <text x="100" y={y + 72} fontSize="11" opacity="0.6" fontStyle="italic">
                Example: {t.example}
              </text>

              {/* Example canvas */}
              <rect x="30" y={y + 88} width="900" height="92" rx="4" fill="none" stroke="currentColor" opacity="0.15" strokeDasharray="3 3" />
              <text x="50" y={y + 106} fontSize="9" opacity="0.5" fontFamily="monospace">example canvas</text>
              {t.shapes.map((s, j) => (
                <g key={j} transform={`translate(${120 + j * 120}, ${y + 140})`}>
                  <ShapeGlyph kind={s.shape} label={(s as { label?: string }).label} accent={t.accent} />
                </g>
              ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
