/**
 * Printed title of a parse box (table pipeline WP-3.B; PLAN §1.3 E-8, §1.5 "printed title (deriveName)").
 * Server-only by design: it reaches `classifier-engine/derive-name`, which the client-safe `headers.ts`
 * must never import. Pure (no DB, no I/O), deterministic (E-7).
 *
 * Same bands as the classifier's candidate evidence (`classifier-engine/evidence.ts`
 * `buildCandidateEvidence`), so the engine and the detect half name a box alike:
 * - words are those whose centre is in the box; rows are `groupRows` (segments split at 1.6 × word height);
 * - the header band = the rows starting within 3 line heights of the first row (at most 3 rows);
 * - "above" = words outside the box, centred at most 2.5 line heights above its top and inside its x range;
 * - `deriveName` scores every line and every joined row; its confidence is the title's `conf`, and a line
 *   below `CONFIDENT_NAME` (.6, the classifier's display bar) is not a title (a lone tag "D1" scores .1).
 * `src` is "header-band" or "above". With no derived line, a proposal's display name (when the caller passes
 * one) is the title, `src: "proposal"`, `conf` = the proposal's p. `titleBottom` is the bottom of the in-box
 * title row (only when that row has ≤ 2 segments, so a column-header row is never skipped), so `headers.ts` can skip that row (`detectHeaderRows({ skip })`); null otherwise.
 */

import { CONFIDENT_NAME, deriveName } from "@/lib/classifier-engine/derive-name";
import { groupRows, type EvLine, type EvWord } from "@/lib/classifier-engine/evidence";
import type { BboxMinMax } from "@/lib/parse-engine/types";
import type { ColWord, TitlePick } from "@/lib/parse-engine/types-cols";

export const TITLE_VERSION = 1;
/** `classifier-engine/evidence.ts` constants (not exported there; repeated so the two bands agree). */
const ABOVE_LINES = 2.5;
const HEADER_LINES = 3;
const HEADER_ROWS_MAX = 3;
/** A title row is one segment, or two (a title and its scale text). */
const TITLE_ROW_MAX_SEGMENTS = 2;

const median = (xs: readonly number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function toEvWord(w: ColWord): EvWord | null {
  const b = w.b;
  if (typeof w.t !== "string" || !b.every((v) => Number.isFinite(v)) || b[2] < b[0] || b[3] < b[1]) return null;
  const bbox: BboxMinMax = [b[0], b[1], b[2], b[3]];
  return {
    up: w.t.toUpperCase(),
    bbox,
    c: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2],
    h: Math.max(b[3] - b[1], 1e-4),
    raw: { text: w.t, confidence: 100, bbox: [b[0], b[1], b[2] - b[0], b[3] - b[1]] },
  };
}

const inside = (c: readonly [number, number], b: BboxMinMax): boolean => c[0] >= b[0] && c[0] <= b[2] && c[1] >= b[1] && c[1] <= b[3];

export interface DeriveTitleOptions {
  /** The classifier proposal's display name and probability, used when no printed line qualifies. */
  proposal?: { title: string | null | undefined; p: number } | null;
}

/** The printed title of `box` from the page's words (see the file header). */
export function deriveTitle(words: readonly ColWord[], box: BboxMinMax, opts: DeriveTitleOptions = {}): TitlePick {
  const all = words.map(toEvWord).filter((w): w is EvWord => w !== null);
  const inBox = all.filter((w) => inside(w.c, box));
  const rows = groupRows(inBox);
  const lh = median(inBox.map((w) => w.h)) || median(all.map((w) => w.h)) || 0.01;
  const above = all.filter((w) => !inside(w.c, box) && w.c[1] < box[1] && w.c[1] >= box[1] - ABOVE_LINES * lh && w.c[0] >= box[0] && w.c[0] <= box[2]);
  const firstTop = Math.max(box[1], rows[0]?.[0].bbox[1] ?? box[1]);
  const headerRows = rows.filter((r) => r[0].bbox[1] < firstTop + HEADER_LINES * lh).slice(0, HEADER_ROWS_MAX);
  const derived = deriveName({ headerRows, aboveRows: groupRows(above), lineHeight: lh });
  if (derived && derived.confidence >= CONFIDENT_NAME) {
    let titleBottom: number | null = null;
    if (derived.source === "header") {
      const row = headerRows.find((r) => r.some((l: EvLine) => l.text === derived.line) || r.map((l) => l.text).join(" ") === derived.line);
      // Only a title-shaped row is skipped: a column-header row (many segments) is never dropped as a title.
      if (row && row.length <= TITLE_ROW_MAX_SEGMENTS) titleBottom = Math.max(...row.map((l) => l.bbox[3]));
    }
    return { title: { text: derived.text, src: derived.source === "header" ? "header-band" : "above", conf: derived.confidence }, titleBottom };
  }
  const p = opts.proposal;
  if (p && typeof p.title === "string" && p.title.trim()) {
    return { title: { text: p.title.trim(), src: "proposal", conf: Math.max(0, Math.min(1, Number.isFinite(p.p) ? p.p : 0)) }, titleBottom: null };
  }
  return { titleBottom: null };
}
