/** End-to-end post-processing flows: YOLO load, area polygon, group create,
 *  bucket fill commit. Each starts at user action, crosses the API boundary,
 *  mutates DB / store, and re-renders. Simplified 4-lane view. */
const LANES = [
  {
    title: "Run YOLO → show detections",
    accent: "#ec4899",
    steps: [
      { label: "Admin clicks Run", sub: "AiModelsTab.tsx" },
      { label: "POST /api/yolo/run", sub: "SageMaker job ID" },
      { label: "SageMaker Processing", sub: "ml.g4dn.xlarge" },
      { label: "POST /api/yolo/load", sub: "webhook on complete" },
      { label: "annotations rows", sub: "source = yolo" },
      { label: "viewer re-renders", sub: "canvas + DetectionPanel" },
    ],
  },
  {
    title: "Draw an area polygon",
    accent: "#22c55e",
    steps: [
      { label: "Open AreaTab", sub: "set activeTakeoffItemId" },
      { label: "Click vertices", sub: "addPolygonVertex()" },
      { label: "Preview renders", sub: "DrawingPreviewLayer" },
      { label: "Double-click finalize", sub: "computeRealArea()" },
      { label: "POST /api/annotations", sub: "type=area-polygon" },
      { label: "AreaTab list refreshes", sub: "updateTakeoffItem()" },
    ],
  },
  {
    title: "Bucket fill commit",
    accent: "#60a5fa",
    steps: [
      { label: "Arm bucket fill", sub: "bucketFillActive=true" },
      { label: "Click seed point", sub: "clientBucketFill()" },
      { label: "Worker: flood + trace", sub: "bucket-fill.worker.ts" },
      { label: "Preview overlay", sub: "evenodd with holes" },
      { label: "User accepts", sub: "BucketFillAssignDialog" },
      { label: "POST /api/annotations", sub: "vertices + holes + area" },
    ],
  },
  {
    title: "Create annotation group",
    accent: "#a855f7",
    steps: [
      { label: "Lasso ≥ 2 items", sub: "mode=group" },
      { label: "GroupActionsBar appears", sub: "floating bar" },
      { label: "MarkupDialog opens", sub: "name + color" },
      { label: "POST /api/annotation-groups", sub: "auto-CSI from notes" },
      { label: "hydrateGroupMemberships", sub: "Zustand update" },
      { label: "Canvas ring outline", sub: "groupIdToColor map" },
    ],
  },
];

export function PostProcessingFlowDiagram() {
  const laneHeight = 160;
  const totalHeight = 60 + LANES.length * laneHeight + 20;

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 1080 ${totalHeight}`}
        className="w-full h-auto text-[var(--fg)]"
        fill="currentColor"
        role="img"
        aria-label="Four post-processing flows: YOLO, area, bucket fill, groups"
      >
        <defs>
          <marker id="ppf-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" opacity="0.6" />
          </marker>
        </defs>

        <text x="540" y="22" textAnchor="middle" fontSize="14" fontWeight="bold">
          Post-processing flows — user action to rendered result
        </text>
        <text x="540" y="38" textAnchor="middle" fontSize="10" opacity="0.6">
          Every feature follows the same shape: action → API → DB → store → re-render. Tools stack.
        </text>

        {LANES.map((lane, li) => {
          const y = 60 + li * laneHeight;
          const stepWidth = 160;
          const gap = 14;
          return (
            <g key={lane.title}>
              <text x="30" y={y + 20} fontSize="13" fontWeight="bold" fill={lane.accent}>
                {lane.title}
              </text>
              <line x1="30" y1={y + 28} x2="1050" y2={y + 28} stroke={lane.accent} strokeWidth="1" opacity="0.25" />

              {lane.steps.map((step, si) => {
                const x = 30 + si * (stepWidth + gap);
                return (
                  <g key={si}>
                    <rect x={x} y={y + 44} width={stepWidth} height="92" rx="4" fill="none" stroke={lane.accent} strokeWidth="1.4" opacity="0.85" />
                    <text x={x + stepWidth / 2} y={y + 70} textAnchor="middle" fontSize="11" fontWeight="bold" fill={lane.accent}>
                      {`${si + 1}.`}
                    </text>
                    <text x={x + stepWidth / 2} y={y + 94} textAnchor="middle" fontSize="11" fontWeight="bold">
                      {step.label}
                    </text>
                    <text x={x + stepWidth / 2} y={y + 114} textAnchor="middle" fontSize="9" opacity="0.65" fontFamily="monospace">
                      {step.sub}
                    </text>
                    {si < lane.steps.length - 1 && (
                      <line
                        x1={x + stepWidth}
                        y1={y + 90}
                        x2={x + stepWidth + gap - 2}
                        y2={y + 90}
                        stroke={lane.accent}
                        strokeWidth="1.4"
                        opacity="0.6"
                        markerEnd="url(#ppf-arr)"
                      />
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
