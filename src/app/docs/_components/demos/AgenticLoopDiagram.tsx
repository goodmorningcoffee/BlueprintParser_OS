/** LLM agentic tool loop. Verified against anthropic.ts:streamChatWithTools.
 *  Loop events: text_delta | tool_call_start | tool_call_result | done.
 *  Terminates on stop_reason !== "tool_use" or maxToolRounds (default 10). */
export function AgenticLoopDiagram() {
  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox="0 0 900 360"
        className="w-full h-auto text-[var(--fg)]"
        role="img"
        aria-label="LLM agentic tool-use loop diagram"
      >
        <defs>
          <marker id="arr3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" opacity="0.6" />
          </marker>
        </defs>

        <text x="450" y="24" textAnchor="middle" fontSize="14" fontWeight="bold">
          streamChatWithTools() &mdash; agentic round loop
        </text>
        <text x="450" y="40" textAnchor="middle" fontSize="10" opacity="0.6">
          maxToolRounds = 10 (default). Streams text deltas as they arrive; batches tool calls per round.
        </text>

        {/* User */}
        <g>
          <rect x="30" y="70" width="140" height="52" rx="6" fill="none" stroke="currentColor" opacity="0.6" strokeWidth="1.5" />
          <text x="100" y="94" textAnchor="middle" fontSize="11" fontWeight="bold">User message</text>
          <text x="100" y="110" textAnchor="middle" fontSize="10" opacity="0.6">+ system + history</text>
        </g>

        <line x1="170" y1="96" x2="220" y2="96" stroke="currentColor" strokeWidth="1.5" opacity="0.5" markerEnd="url(#arr3)" />

        {/* LLM */}
        <g>
          <rect x="220" y="60" width="180" height="72" rx="6" fill="none" stroke="#60a5fa" strokeWidth="2" />
          <text x="310" y="82" textAnchor="middle" fontSize="12" fontWeight="bold" fill="#60a5fa">LLM stream</text>
          <text x="310" y="98" textAnchor="middle" fontSize="10" opacity="0.75">Anthropic / OpenAI / Groq</text>
          <text x="310" y="114" textAnchor="middle" fontSize="9" opacity="0.55">BP_TOOLS injected</text>
        </g>

        {/* yield text_delta events */}
        <g>
          <path d="M 310 132 Q 310 170 170 170" stroke="#22c55e" strokeWidth="1.5" fill="none" markerEnd="url(#arr3)" strokeDasharray="4 2" opacity="0.7" />
          <text x="240" y="165" fontSize="9" fill="#22c55e" opacity="0.9" fontFamily="monospace">yield text_delta</text>
        </g>

        <line x1="400" y1="96" x2="450" y2="96" stroke="currentColor" strokeWidth="1.5" opacity="0.5" markerEnd="url(#arr3)" />

        {/* Decision: stop_reason */}
        <g>
          <polygon points="450,96 530,60 610,96 530,132" fill="none" stroke="#f59e0b" strokeWidth="1.5" />
          <text x="530" y="92" textAnchor="middle" fontSize="11" fontWeight="bold" fill="#f59e0b">stop_reason</text>
          <text x="530" y="106" textAnchor="middle" fontSize="9" opacity="0.7">=== &quot;tool_use&quot; ?</text>
        </g>

        {/* Yes → execute tools */}
        <line x1="610" y1="96" x2="670" y2="96" stroke="currentColor" strokeWidth="1.5" opacity="0.5" markerEnd="url(#arr3)" />
        <text x="640" y="86" fontSize="9" fill="#22c55e" fontFamily="monospace">yes</text>

        <g>
          <rect x="670" y="60" width="200" height="72" rx="6" fill="none" stroke="#22c55e" strokeWidth="2" />
          <text x="770" y="82" textAnchor="middle" fontSize="12" fontWeight="bold" fill="#22c55e">Execute tool calls</text>
          <text x="770" y="98" textAnchor="middle" fontSize="10" opacity="0.75">executeToolCall(name, input)</text>
          <text x="770" y="114" textAnchor="middle" fontSize="9" opacity="0.55">read db, run lib fns, mutate</text>
        </g>

        {/* Loopback */}
        <path d="M 770 132 Q 770 200 310 200 Q 310 180 310 132" stroke="#a855f7" strokeWidth="1.8" fill="none" markerEnd="url(#arr3)" />
        <text x="540" y="216" textAnchor="middle" fontSize="10" fill="#a855f7" fontFamily="monospace">
          append tool_result → round++ (cap 10)
        </text>

        {/* yield tool_call_start / _result */}
        <text x="770" y="158" textAnchor="middle" fontSize="9" fill="#22c55e" opacity="0.9" fontFamily="monospace">
          yield tool_call_start / _result
        </text>

        {/* No → done */}
        <line x1="530" y1="132" x2="530" y2="250" stroke="currentColor" strokeWidth="1.5" opacity="0.5" markerEnd="url(#arr3)" />
        <text x="540" y="165" fontSize="9" fill="#f87171" fontFamily="monospace">no → done</text>

        <g>
          <rect x="450" y="250" width="160" height="52" rx="6" fill="none" stroke="#f87171" strokeWidth="1.5" />
          <text x="530" y="274" textAnchor="middle" fontSize="11" fontWeight="bold" fill="#f87171">yield done</text>
          <text x="530" y="290" textAnchor="middle" fontSize="9" opacity="0.65">exit loop, return to caller</text>
        </g>

        {/* Footer */}
        <text x="30" y="330" fontSize="10" opacity="0.6" fontFamily="monospace">
          src/lib/llm/anthropic.ts → same interface in groq.ts, openai.ts
        </text>
        <text x="870" y="330" fontSize="10" opacity="0.6" fontFamily="monospace" textAnchor="end">
          round cap → emits &quot;(Reached maximum tool call rounds)&quot;
        </text>
      </svg>
    </div>
  );
}
