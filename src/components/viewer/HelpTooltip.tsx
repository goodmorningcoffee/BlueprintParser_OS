"use client";

import { useState, useRef, useCallback, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useViewerStore } from "@/stores/viewerStore";
import { HELP_TOOLTIPS } from "@/data/help-tooltips";

interface HelpTooltipProps {
  id: string;
  children: ReactNode;
  position?: "above" | "below";
}

const TOOLTIP_WIDTH = 256; // w-64

export default function HelpTooltip({ id, children, position = "below" }: HelpTooltipProps) {
  const helpMode = useViewerStore((s) => s.helpMode);
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number; arrowLeft: number; actualPos: "above" | "below" } | null>(null);

  const tooltip = HELP_TOOLTIPS[id];

  const handleEnter = useCallback(() => {
    if (!helpMode || !tooltip) return;
    timerRef.current = setTimeout(() => setVisible(true), 100);
  }, [helpMode, tooltip]);

  const handleLeave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setVisible(false);
  }, []);

  // Compute position when visible
  useEffect(() => {
    if (!visible || !containerRef.current) { setCoords(null); return; }
    const rect = containerRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Center horizontally on the element
    let left = rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2;
    const arrowLeft = TOOLTIP_WIDTH / 2; // default: centered

    // Clamp to viewport edges with 8px padding
    if (left < 8) left = 8;
    if (left + TOOLTIP_WIDTH > vw - 8) left = vw - 8 - TOOLTIP_WIDTH;

    // Compute arrow offset (how far from tooltip left edge the arrow should be)
    const elementCenterX = rect.left + rect.width / 2;
    const clampedArrowLeft = Math.max(16, Math.min(TOOLTIP_WIDTH - 16, elementCenterX - left));

    // Vertical: prefer requested position, flip if not enough space
    const spaceBelow = vh - rect.bottom;
    const spaceAbove = rect.top;
    const tooltipHeight = 80; // approximate
    let actualPos = position;
    if (position === "below" && spaceBelow < tooltipHeight && spaceAbove > tooltipHeight) {
      actualPos = "above";
    } else if (position === "above" && spaceAbove < tooltipHeight && spaceBelow > tooltipHeight) {
      actualPos = "below";
    }

    const top = actualPos === "below" ? rect.bottom + 8 : rect.top - tooltipHeight - 8;

    setCoords({ top, left, arrowLeft: clampedArrowLeft, actualPos });
  }, [visible, position]);

  if (!tooltip) return <>{children}</>;

  return (
    <div
      ref={containerRef}
      className="relative inline-flex"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      {children}
      {visible && helpMode && coords && createPortal(
        <div
          style={{
            position: "fixed",
            top: coords.top,
            left: coords.left,
            width: TOOLTIP_WIDTH,
            zIndex: 9999,
            pointerEvents: "none",
          }}
          className="px-3 py-2 rounded-lg shadow-xl border border-[var(--border)] bg-[var(--surface)] opacity-95 backdrop-blur-sm"
        >
          {/* Arrow */}
          <div
            className={`absolute w-2 h-2 rotate-45 bg-[var(--surface)] border-[var(--border)] ${
              coords.actualPos === "above"
                ? "bottom-[-5px] border-b border-r"
                : "top-[-5px] border-t border-l"
            }`}
            style={{ left: coords.arrowLeft - 4 }}
          />
          <p className="text-xs font-semibold text-[var(--accent)] mb-0.5">{tooltip.title}</p>
          <p className="text-[11px] text-[var(--fg)]/80 leading-relaxed">{tooltip.body}</p>
        </div>,
        document.body,
      )}
    </div>
  );
}
