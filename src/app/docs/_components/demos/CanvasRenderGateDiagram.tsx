/** The AnnotationOverlay 4-point render gate. Since the P3.4 registry delegation,
 *  condition #1 (canvasWantsEvents) is DERIVED from the tool registry — each
 *  controller owns its wantsEvents predicate — so a new canvas tool registers a
 *  predicate instead of editing AO's formula. Conditions #2–#4 still live in AO
 *  and still drift if missed. Verified against
 *  src/components/viewer/AnnotationOverlay.tsx:1484 (canvasWantsEvents),
 *  :1485-1491 (canvasShouldRender + if-return-null), :1540 (pointerEvents),
 *  :1493/:1544 (cursor). */
export function CanvasRenderGateDiagram() {
  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox="0 0 960 520"
        className="w-full h-auto text-[var(--fg)]"
        fill="currentColor"
        role="img"
        aria-label="Canvas render gate — four coupled conditions in AnnotationOverlay.tsx"
      >
        <defs>
          <marker id="gate-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" opacity="0.6" />
          </marker>
        </defs>

        <text x="480" y="22" textAnchor="middle" fontSize="14" fontWeight="bold">
          The 4-point render gate — AnnotationOverlay.tsx
        </text>
        <text x="480" y="38" textAnchor="middle" fontSize="10" opacity="0.6">
          Condition #1 is registry-derived since P3.4; a new tool registers wantsEvents on its controller. #2–#4 remain manual in AO.
        </text>

        {/* Box 1 — canvasWantsEvents (registry-derived) */}
        <g>
          <rect x="30" y="70" width="440" height="180" rx="6" fill="none" stroke="#f59e0b" strokeWidth="1.8" />
          <text x="50" y="90" fontSize="12" fontWeight="bold" fill="#f59e0b">1. canvasWantsEvents  (L1484 — registry-derived)</text>
          <text x="50" y="106" fontSize="10" opacity="0.7" fontFamily="monospace">Boolean. True if any registered tool needs pointer events.</text>
          <text x="50" y="130" fontSize="11" fontFamily="monospace" opacity="0.85">TOOLS.some((controller) =&gt;</text>
          <text x="50" y="146" fontSize="11" fontFamily="monospace" opacity="0.85">  controller.wantsEvents(canvasToolState))</text>
          <text x="50" y="170" fontSize="10" opacity="0.65">Each of the 13 controllers owns its eligibility predicate</text>
          <text x="50" y="184" fontSize="10" opacity="0.65">(activeTool/mode only — proven boolean-equivalent to the</text>
          <text x="50" y="198" fontSize="10" opacity="0.65">legacy manual formula before delegation; frozen in</text>
          <text x="50" y="212" fontSize="10" opacity="0.65" fontFamily="monospace">TableCellStructureCanvasGateTopologyFreeze</text>
          <text x="50" y="226" fontSize="10" opacity="0.65">). tempPan disables pointerEvents separately.</text>
        </g>

        {/* Box 2 — canvasShouldRender */}
        <g>
          <rect x="490" y="70" width="440" height="180" rx="6" fill="none" stroke="#a855f7" strokeWidth="1.8" />
          <text x="510" y="90" fontSize="12" fontWeight="bold" fill="#a855f7">2. canvasShouldRender  (L1485–1491)</text>
          <text x="510" y="106" fontSize="10" opacity="0.7" fontFamily="monospace">If false, the whole canvas returns null.</text>
          <text x="510" y="130" fontSize="11" fontFamily="monospace" opacity="0.85">pageAnnotations.length &gt; 0 ||</text>
          <text x="510" y="146" fontSize="11" fontFamily="monospace" opacity="0.85">polygonDrawingMode !== &quot;idle&quot; ||</text>
          <text x="510" y="162" fontSize="11" fontFamily="monospace" opacity="0.85">pendingMarkup !== null ||</text>
          <text x="510" y="178" fontSize="11" fontFamily="monospace" opacity="0.85">canvasWantsEvents ||</text>
          <text x="510" y="194" fontSize="11" fontFamily="monospace" opacity="0.85">(showTableCellStructure &amp;&amp;</text>
          <text x="510" y="210" fontSize="11" fontFamily="monospace" opacity="0.85"> tableCellStructure?.pageNumber === pageNumber)</text>
          <text x="510" y="230" fontSize="10" opacity="0.65">If false → <tspan fontFamily="monospace" opacity="0.85">return null</tspan> before any overlay renders. The keyboard</text>
          <text x="510" y="244" fontSize="10" opacity="0.65">dispatcher mounts BEFORE this gate, so shortcuts stay live.</text>
        </g>

        {/* Arrow from box 1 into box 2 (canvasWantsEvents feeds canvasShouldRender) */}
        <line x1="470" y1="160" x2="490" y2="160" stroke="currentColor" strokeWidth="1.5" opacity="0.5" markerEnd="url(#gate-arr)" />

        {/* Box 3 — pointerEvents */}
        <g>
          <rect x="30" y="280" width="440" height="120" rx="6" fill="none" stroke="#22c55e" strokeWidth="1.8" />
          <text x="50" y="300" fontSize="12" fontWeight="bold" fill="#22c55e">3. pointerEvents  (L1540)</text>
          <text x="50" y="316" fontSize="10" opacity="0.7" fontFamily="monospace">Inline style on the &lt;canvas&gt; element.</text>
          <text x="50" y="340" fontSize="11" fontFamily="monospace" opacity="0.85">tempPanMode</text>
          <text x="130" y="340" fontSize="11" fontFamily="monospace" opacity="0.85">? &quot;none&quot;</text>
          <text x="50" y="356" fontSize="11" fontFamily="monospace" opacity="0.85">: canvasWantsEvents ? &quot;auto&quot; : &quot;none&quot;</text>
          <text x="50" y="384" fontSize="10" opacity="0.65">Hold &quot;v&quot; (tempPanMode) and the canvas becomes transparent to events.</text>
        </g>

        {/* Box 4 — cursor */}
        <g>
          <rect x="490" y="280" width="440" height="120" rx="6" fill="none" stroke="#60a5fa" strokeWidth="1.8" />
          <text x="510" y="300" fontSize="12" fontWeight="bold" fill="#60a5fa">4. cursor  (L1493–1544)</text>
          <text x="510" y="316" fontSize="10" opacity="0.7" fontFamily="monospace">Inline style chain. One arm per mode.</text>
          <text x="510" y="340" fontSize="11" fontFamily="monospace" opacity="0.85">split | symbol | calibration | takeoff | tagAdd → crosshair</text>
          <text x="510" y="356" fontSize="11" fontFamily="monospace" opacity="0.85">bucketFill → wait | barrier | custom SVG cursor</text>
          <text x="510" y="372" fontSize="11" fontFamily="monospace" opacity="0.85">tagPick | keynote YOLO pick → pointer</text>
          <text x="510" y="388" fontSize="11" fontFamily="monospace" opacity="0.85">parseRect | base markup/group → crosshair</text>
        </g>

        {/* Bottom box — the trap */}
        <g>
          <rect x="30" y="430" width="900" height="72" rx="6" fill="none" stroke="#f87171" strokeWidth="1.8" />
          <text x="50" y="452" fontSize="12" fontWeight="bold" fill="#f87171">⚠ The drift hazard (narrowed, not gone)</text>
          <text x="50" y="472" fontSize="11" opacity="0.9">
            Miss-#1 bugs are structurally closed: forgetting <tspan fontFamily="monospace" fill="#f87171">wantsEvents</tspan> on a new controller
            now fails the registry equivalence freeze instead of silently eating events.
          </text>
          <text x="50" y="490" fontSize="11" opacity="0.9">
            #2–#4 still drift: miss #2 and the canvas vanishes; miss #3 and clicks fall through; miss #4 and the cursor lies.
            Group-tool 2026-04-19 fix: exactly this class of bug.
          </text>
        </g>
      </svg>
    </div>
  );
}
