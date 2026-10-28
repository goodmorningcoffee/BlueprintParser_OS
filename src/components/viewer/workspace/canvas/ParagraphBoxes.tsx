"use client";

// [TP-3 WP-3.O] A notes / spec item on its page: each block outlined (dashed) and each paragraph boxed with its key
// badge as printed ("4", "2.3", "A"), unnumbered lead-ins without a badge. Display only (`pointer-events: none`):
// split / merge / rekey happen in the Structure step's paragraph list (WP-3.N).

import type { StructureParagraphDoc } from "@/lib/parse-engine/types";
import { boxStyle } from "./StructureLines";

export const PARAGRAPH_COLOR = "#00b8d4";

export default function ParagraphBoxes({ doc }: { doc: StructureParagraphDoc }) {
  return (
    <div data-workspace-paragraphs="" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {doc.blocks.map((block) => (
        <div
          key={block.id}
          data-paragraph-block={block.id}
          style={{ ...boxStyle(block.b), boxSizing: "border-box", border: `1.5px dashed ${PARAGRAPH_COLOR}` }}
        />
      ))}
      {doc.paragraphs.map((p) => (
        <div
          key={p.id}
          data-paragraph={p.id}
          style={{ ...boxStyle(p.b), boxSizing: "border-box", border: `1px solid ${PARAGRAPH_COLOR}99`, background: `${PARAGRAPH_COLOR}0d` }}
        >
          {p.key !== null && (
            <span
              data-paragraph-key={p.id}
              style={{
                position: "absolute", left: 0, top: 0, transform: "translate(-100%, 0)", padding: "0 3px",
                fontSize: 10, lineHeight: "14px", color: "#fff", background: PARAGRAPH_COLOR, borderRadius: 2, whiteSpace: "nowrap",
              }}
            >
              {p.key}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
