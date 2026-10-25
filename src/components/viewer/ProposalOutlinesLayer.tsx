"use client";

// [clf visibility 2026-10-25] Every classifier proposal on this page, drawn when the View All panel's
// "Proposed tables" eye is on (proposalFocusStore.outlinesVisible): a dashed outline with a small kind
// label, dimmed once the user has given a verdict (rejected / accepted / renamed). The focused proposal
// is left to ProposalFocusLayer, which mounts this layer beneath its hover / focus boxes. Pure overlay:
// no pointer events, no fetch — the items come from the same project-bootstrap summary the lists read.

import type { ProposalSummaryItem } from "@/lib/classifier-engine/types";
import { useProposals } from "@/queries/useProposals";
import { useProposalFocusStore } from "@/stores/proposalFocusStore";

export const OUTLINE_COLOR = "#00E676";
export const VERDICT_ALPHA = 0.35;

const VERDICT_SUFFIX = { accept: "accepted", reject: "not a table", rename: "renamed" } as const;

export function outlineLabel(item: ProposalSummaryItem): string {
  return item.verdict ? `${item.displayName} · ${VERDICT_SUFFIX[item.verdict]}` : item.displayName;
}

export default function ProposalOutlinesLayer({ pageNumber, focusedId }: { pageNumber: number; focusedId: string | null }) {
  const visible = useProposalFocusStore((s) => s.outlinesVisible);
  const summary = useProposals();
  if (!visible || !summary) return null;
  const items = summary.items.filter((i) => i.pageNumber === pageNumber && i.id !== focusedId);
  if (items.length === 0) return null;
  return (
    <div data-proposal-outlines={items.length} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {items.map((item) => {
        const [minX, minY, maxX, maxY] = item.bbox;
        const dim = item.verdict !== undefined;
        return (
          <div
            key={item.id}
            data-proposal-outline={item.id}
            data-proposal-verdict={item.verdict ?? "none"}
            style={{
              position: "absolute",
              left: `${minX * 100}%`,
              top: `${minY * 100}%`,
              width: `${(maxX - minX) * 100}%`,
              height: `${(maxY - minY) * 100}%`,
              boxSizing: "border-box",
              border: `2px dashed ${OUTLINE_COLOR}`,
              borderRadius: 2,
              opacity: dim ? VERDICT_ALPHA : 0.9,
            }}
          >
            <span
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                transform: "translateY(-100%)",
                padding: "0 3px",
                fontSize: 10,
                lineHeight: "14px",
                whiteSpace: "nowrap",
                color: "#000",
                background: OUTLINE_COLOR,
                borderRadius: "2px 2px 0 0",
                textDecoration: item.verdict === "reject" ? "line-through" : undefined,
              }}
            >
              {outlineLabel(item)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
