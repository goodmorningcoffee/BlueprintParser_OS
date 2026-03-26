"use client";

import { useState, useRef, useCallback, type ReactNode } from "react";
import { useViewerStore } from "@/stores/viewerStore";
import { HELP_TOOLTIPS } from "@/data/help-tooltips";

interface HelpTooltipProps {
  id: string;
  children: ReactNode;
  position?: "above" | "below";
}

export default function HelpTooltip({ id, children, position = "below" }: HelpTooltipProps) {
  const helpMode = useViewerStore((s) => s.helpMode);
  const mode = useViewerStore((s) => s.mode);
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const tooltip = HELP_TOOLTIPS[id];

  const handleEnter = useCallback(() => {
    if (!helpMode || mode !== "pointer" || !tooltip) return;
    timerRef.current = setTimeout(() => setVisible(true), 100);
  }, [helpMode, mode, tooltip]);

  const handleLeave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setVisible(false);
  }, []);

  if (!tooltip) return <>{children}</>;

  return (
    <div
      ref={containerRef}
      className="relative inline-flex"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      {children}
      {visible && helpMode && (
        <div
          className={`absolute z-[100] ${
            position === "above" ? "bottom-full mb-2" : "top-full mt-2"
          } left-1/2 -translate-x-1/2 w-64 px-3 py-2 rounded-lg shadow-xl border border-[var(--border)] bg-[#1a1a2e]/95 backdrop-blur-sm pointer-events-none`}
        >
          {/* Arrow */}
          <div
            className={`absolute left-1/2 -translate-x-1/2 w-2 h-2 rotate-45 bg-[#1a1a2e]/95 border-[var(--border)] ${
              position === "above"
                ? "bottom-[-5px] border-b border-r"
                : "top-[-5px] border-t border-l"
            }`}
          />
          <p className="text-xs font-semibold text-[var(--accent)] mb-0.5">{tooltip.title}</p>
          <p className="text-[11px] text-[var(--fg)]/80 leading-relaxed">{tooltip.body}</p>
        </div>
      )}
    </div>
  );
}
