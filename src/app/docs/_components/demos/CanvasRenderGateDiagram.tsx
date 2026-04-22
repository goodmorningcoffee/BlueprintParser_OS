/** The AnnotationOverlay 4-point render gate. Adding a new canvas tool without
 *  touching ALL FOUR of these is the single most common source of silent
 *  regressions (lasso disappears, markup eats events, cursor drifts). Verified
 *  against src/components/viewer/AnnotationOverlay.tsx:2508-2527 (canvasWantsEvents
 *  + canvasShouldRender + if-return-null), :2550 (pointerEvents), :2554 (cursor). */
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
          A new canvas mode must be added to ALL FOUR conditions, or the canvas drifts (dead clicks, wrong cursor, stolen events).
        </text>

        {/* Box 1 — canvasWantsEvents */}
        <g>
          <rect x="30" y="70" width="440" height="180" rx="6" fill="none" stroke="#f59e0b" strokeWidth="1.8" />
          <text x="50" y="90" fontSize="12" fontWeight="bold" fill="#f59e0b">1. canvasWantsEvents  (L2510–2520)</text>
          <text x="50" y="106" fontSize="10" opacity="0.7" fontFamily="monospace">Boolean. True if any mode needs pointer events.</text>
          <text x="50" y="130" fontSize="11" fontFamily="monospace" opacity="0.85">activeTakeoffItemId !== null ||</text>
          <text x="50" y="146" fontSize="11" fontFamily="monospace" opacity="0.85">bucketFillActive ||</text>
          <text x="50" y="162" fontSize="11" fontFamily="monospace" opacity="0.85">calibrationMode !== &quot;idle&quot; ||</text>
          <text x="50" y="178" fontSize="11" fontFamily="monospace" opacity="0.85">polygonDrawingMode === &quot;drawing&quot; ||</text>
          <text x="50" y="194" fontSize="11" fontFamily="monospace" opacity="0.85">mode === &quot;markup&quot; | &quot;pointer&quot; | &quot;group&quot; ||</text>
          <text x="50" y="210" fontSize="11" fontFamily="monospace" opacity="0.85">tableParseStep / keynoteParseStep !== &quot;idle&quot; ||</text>
          <text x="50" y="226" fontSize="11" fontFamily="monospace" opacity="0.85">symbolSearchActive || splitAreaActive</text>
        </g>

        {/* Box 2 — canvasShouldRender */}
        <g>
          <rect x="490" y="70" width="440" height="180" rx="6" fill="none" stroke="#a855f7" strokeWidth="1.8" />
          <text x="510" y="90" fontSize="12" fontWeight="bold" fill="#a855f7">2. canvasShouldRender  (L2521–2527)</text>
          <text x="510" y="106" fontSize="10" opacity="0.7" fontFamily="monospace">If false, the whole canvas returns null.</text>
          <text x="510" y="130" fontSize="11" fontFamily="monospace" opacity="0.85">pageAnnotations.length &gt; 0 ||</text>
          <text x="510" y="146" fontSize="11" fontFamily="monospace" opacity="0.85">polygonDrawingMode !== &quot;idle&quot; ||</text>
          <text x="510" y="162" fontSize="11" fontFamily="monospace" opacity="0.85">pendingMarkup !== null ||</text>
          <text x="510" y="178" fontSize="11" fontFamily="monospace" opacity="0.85">canvasWantsEvents</text>
          <text x="510" y="210" fontSize="10" opacity="0.65">If false → <tspan fontFamily="monospace" opacity="0.85">return null</tspan> before any overlay renders.</text>
          <text x="510" y="226" fontSize="10" opacity="0.65">Annotations on page + drawing previews + pendingMarkup</text>
          <text x="510" y="240" fontSize="10" opacity="0.65">all independently force the canvas to mount.</text>
        </g>

        {/* Arrow from box 1 into box 2 (canvasWantsEvents feeds canvasShouldRender) */}
        <line x1="470" y1="160" x2="490" y2="160" stroke="currentColor" strokeWidth="1.5" opacity="0.5" markerEnd="url(#gate-arr)" />

        {/* Box 3 — pointerEvents */}
        <g>
          <rect x="30" y="280" width="440" height="120" rx="6" fill="none" stroke="#22c55e" strokeWidth="1.8" />
          <text x="50" y="300" fontSize="12" fontWeight="bold" fill="#22c55e">3. pointerEvents  (L2550)</text>
          <text x="50" y="316" fontSize="10" opacity="0.7" fontFamily="monospace">Inline style on the &lt;canvas&gt; element.</text>
          <text x="50" y="340" fontSize="11" fontFamily="monospace" opacity="0.85">tempPanMode</text>
          <text x="130" y="340" fontSize="11" fontFamily="monospace" opacity="0.85">? &quot;none&quot;</text>
          <text x="50" y="356" fontSize="11" fontFamily="monospace" opacity="0.85">: canvasWantsEvents ? &quot;auto&quot; : &quot;none&quot;</text>
          <text x="50" y="384" fontSize="10" opacity="0.65">Hold &quot;v&quot; (tempPanMode) and the canvas becomes transparent to events.</text>
        </g>

        {/* Box 4 — cursor */}
        <g>
          <rect x="490" y="280" width="440" height="120" rx="6" fill="none" stroke="#60a5fa" strokeWidth="1.8" />
          <text x="510" y="300" fontSize="12" fontWeight="bold" fill="#60a5fa">4. cursor  (L2554)</text>
          <text x="510" y="316" fontSize="10" opacity="0.7" fontFamily="monospace">Inline style chain. One ternary arm per mode.</text>
          <text x="510" y="340" fontSize="11" fontFamily="monospace" opacity="0.85">splitAreaActive ? &quot;crosshair&quot;</text>
          <text x="510" y="356" fontSize="11" fontFamily="monospace" opacity="0.85">: bucketFillActive ? (custom SVG cursor)</text>
          <text x="510" y="372" fontSize="11" fontFamily="monospace" opacity="0.85">: calibrationMode ? &quot;crosshair&quot;</text>
          <text x="510" y="388" fontSize="11" fontFamily="monospace" opacity="0.85">: polygonDrawingMode ? &quot;crosshair&quot; : ...</text>
        </g>

        {/* Bottom box — the trap */}
        <g>
          <rect x="30" y="430" width="900" height="72" rx="6" fill="none" stroke="#f87171" strokeWidth="1.8" />
          <text x="50" y="452" fontSize="12" fontWeight="bold" fill="#f87171">⚠ The drift hazard</text>
          <text x="50" y="472" fontSize="11" opacity="0.9">
            Adding a new tool means edits to <tspan fontFamily="monospace" fill="#f87171">all four</tspan> locations.
            Miss #1 and the canvas eats events it shouldn&apos;t. Miss #2 and the canvas vanishes.
          </text>
          <text x="50" y="490" fontSize="11" opacity="0.9">
            Miss #3 and clicks fall through to the underlying page. Miss #4 and the cursor lies about the mode.
            Group-tool 2026-04-19 fix: exactly this bug.
          </text>
        </g>
      </svg>
    </div>
  );
}
