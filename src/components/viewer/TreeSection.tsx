"use client";

import type { ReactNode } from "react";

interface TreeSectionProps {
  title: string;
  count: number;
  isExpanded: boolean;
  onToggleExpand: () => void;
  children: ReactNode;
  badge?: ReactNode;
}

/**
 * Shared collapsible section wrapper used across ViewAllPanel sections.
 * Matches the chevron/title/count-badge pattern repeated in DetectionPanel
 * and TakeoffPanel, extracted so new sections don't each re-invent it.
 */
export default function TreeSection({
  title,
  count,
  isExpanded,
  onToggleExpand,
  children,
  badge,
}: TreeSectionProps) {
  return (
    <div className="border-b border-[var(--border)]">
      <button
        onClick={onToggleExpand}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/5 text-left"
      >
        <span className="text-[10px] text-[var(--muted)] w-3 shrink-0">
          {isExpanded ? "\u25BC" : "\u25B6"}
        </span>
        <span className="text-sm font-medium text-[var(--fg)] flex-1 truncate">
          {title}
        </span>
        {badge}
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface)] text-[var(--muted)] shrink-0">
          {count}
        </span>
      </button>
      {isExpanded && <div className="pb-1">{children}</div>}
    </div>
  );
}
