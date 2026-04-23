import type { TextractLine, BboxLTWH } from "@/types";

/**
 * Detect spec/notes section headers. Covers:
 *   PART 1 - GENERAL / PART 2 – PRODUCTS / PART 3 — EXECUTION
 *   SECTION 03 30 00 / SECTION 09 29 00.13
 *   SPECIFICATIONS (single-header boilerplate variant)
 *   GENERAL NOTES / GENERAL CONSTRUCTION NOTES (G-series drawings)
 *   1.01, 2.02 sub-section numbering (looser — only when embedded in a
 *         spec-like region that already has at least one strong header)
 *
 * Drawing-notes category headers (new, Step 3 extension):
 *   BUILDING DEPARTMENT NOTES / RENOVATION NOTES / DEMOLITION NOTES /
 *   FIRE PROTECTION NOTES / RCP NOTES / CEILING NOTES / etc.
 *   Generic shape: {ALL-CAPS WORDS} NOTES?
 *   Also ABBREVIATIONS / LEGEND / SYMBOLS for legend blocks.
 *
 * Kept case-insensitive. Regex anchored at the start of the trimmed line
 * so narrative sentences mentioning "part 1" mid-line don't false-trigger.
 * The category-prefix pattern is constrained (3–40 caps chars) so random
 * ALL-CAPS sentences don't match.
 */
const RE_STRONG_HEADER = /^\s*(PART\s+\d+\b|SECTION\s+\d{2,}(?:\s+\d{2,}){0,2}|SPECIFICATIONS?\b|(?:[A-Z][A-Z&]{0,15}(?:\s+[A-Z][A-Z&]{0,15}){0,3}\s+)?(?:GENERAL\s+(?:CONSTRUCTION\s+)?)?NOTES?\b|ABBREVIATIONS?\b|LEGEND\b|SYMBOLS?\b)/i;
const RE_SUB_SECTION = /^\s*(\d{1,2}\.\d{1,2})(?:\s|$)/;

export interface SpecSection {
  sectionHeader: string;
  body: string;
}

export interface BoundSpec {
  sections: SpecSection[];
  rowBoundaries?: number[];
}

interface BindSpecOpts {
  /** Allow `1.01` / `2.02` sub-section lines to open a new section.
   *  Only enable once a strong header has already been seen in the region. */
  includeSubSections?: boolean;
}

/**
 * Bind a set of TextractLines (already filtered to the user's region) into
 * ordered `{ sectionHeader, body }` sections.
 *
 * Sorts lines top-to-bottom (with left-to-right as a tie-break so
 * multi-column specs scan column-by-column if the caller already filtered
 * per-column), detects section headers, and accumulates the body text
 * between each header hit.
 *
 * Returns `undefined` when no strong header matches — caller can fall back
 * to a one-section pass that dumps everything as body.
 */
export function bindSpecSections(
  lines: readonly TextractLine[],
  opts: BindSpecOpts = {},
): BoundSpec | undefined {
  if (!lines.length) return undefined;

  const valid = lines.filter((l) => l.bbox && l.bbox.length >= 4 && l.text?.trim());
  if (!valid.length) return undefined;

  const ysorted = [...valid].sort(
    (a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0],
  );

  const sections: SpecSection[] = [];
  const rowBoundaries: number[] = [];
  let current: { header: string; parts: string[]; top: number } | undefined;

  let anyStrongSeen = false;

  for (const line of ysorted) {
    const text = line.text.trim();
    const strongMatch = RE_STRONG_HEADER.exec(text);
    const subMatch =
      opts.includeSubSections && anyStrongSeen ? RE_SUB_SECTION.exec(text) : null;

    const headerMatch = strongMatch ?? subMatch;

    if (headerMatch) {
      if (strongMatch) anyStrongSeen = true;
      if (current) {
        sections.push({
          sectionHeader: current.header,
          body: current.parts.join(" ").trim(),
        });
        rowBoundaries.push(current.top);
      }
      current = { header: text, parts: [], top: line.bbox[1] };
    } else if (current) {
      current.parts.push(text);
    } else {
      // Body text preceding any detected header — start an unheaded section
      // lazily so we don't lose the content. Its header is empty; callers can
      // decide to promote this to a generic "Preamble" label.
      current = { header: "", parts: [text], top: line.bbox[1] };
    }
  }

  if (current) {
    sections.push({
      sectionHeader: current.header,
      body: current.parts.join(" ").trim(),
    });
    rowBoundaries.push(current.top);
  }

  if (!anyStrongSeen && !opts.includeSubSections) return undefined;
  if (!sections.length) return undefined;

  return { sections, rowBoundaries };
}

/**
 * Filter TextractLines to those whose center falls inside `regionBbox`,
 * then bind into sections. Thin convenience wrapper for the API route /
 * promote flow.
 */
export function bindSpecSectionsInRegion(
  lines: readonly TextractLine[],
  regionBbox: BboxLTWH,
  opts: BindSpecOpts = {},
): BoundSpec | undefined {
  const [rx, ry, rw, rh] = regionBbox;
  const rRight = rx + rw;
  const rBottom = ry + rh;
  const inside = lines.filter((l) => {
    if (!l.bbox || l.bbox.length < 4) return false;
    const cx = l.bbox[0] + l.bbox[2] / 2;
    const cy = l.bbox[1] + l.bbox[3] / 2;
    return cx >= rx && cx <= rRight && cy >= ry && cy <= rBottom;
  });
  return bindSpecSections(inside, opts);
}
