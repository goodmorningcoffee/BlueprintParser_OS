/**
 * primitives/pattern-infer.ts — Schedule-column pattern inference.
 *
 * Given the raw values from the tag column of a parsed schedule, derive a
 * regex that describes the tag format. Strongly-patterned schedules (most
 * door/panel/equipment schedules) produce `strength: "strong"`; weakly-
 * patterned schedules (pure numeric like ["01","02","03"]) produce
 * `strength: "weak"`.
 *
 * Consumer-agnostic: works on any column of discrete values. Future
 * note-mapping or spec-reference mapping can reuse for their own keyed
 * source vocabularies.
 */

import type { InferredPattern } from "../types";

/**
 * Tokenize a value to a shape signature: letters → 'L', digits → 'D',
 * punctuation preserved literally. `-` and `.` are common in tag codes.
 * Unknown characters are preserved too so the signature round-trips.
 *
 * Examples:
 *   "D-101"   → "L-DDD"
 *   "CF-3A"   → "LL-DL"
 *   "01"      → "DD"
 *   "01.1"    → "DD.D"
 */
function shapeOf(value: string): string {
  let out = "";
  for (const ch of value) {
    if (/[A-Z]/.test(ch)) out += "L";
    else if (/[0-9]/.test(ch)) out += "D";
    else out += ch;
  }
  return out;
}

/** Build a regex from a shape signature.
 *
 *  - Letters (`L`): emit observed character class per position.
 *    Uniform letter → literal (e.g. `D`). Divergent → `[DW]`.
 *  - Digits (`D`): always emit `\d` (not observed values) so the regex
 *    generalizes to other values following the same format. Example:
 *    schedule has `D-101, D-102, D-103` → pattern `^D-\d{3}$` matches
 *    `D-999` even though it wasn't observed in the schedule.
 *  - Punctuation: emit literal (escape if regex-special).
 *
 *  Consecutive digit positions collapse to `\d{n}`; consecutive letter
 *  positions with identical character class also collapse.
 */
function buildRegex(shape: string, values: string[]): RegExp {
  const parts: string[] = [];
  let i = 0;
  while (i < shape.length) {
    const ch = shape[i];
    if (ch === "D") {
      // Gather run of digit positions
      let j = i;
      while (j < shape.length && shape[j] === "D") j++;
      const runLen = j - i;
      parts.push(runLen === 1 ? "\\d" : `\\d{${runLen}}`);
      i = j;
    } else if (ch === "L") {
      // Gather run of letter positions; emit observed character class per pos
      let j = i;
      while (j < shape.length && shape[j] === "L") j++;
      // Per-position character class
      const perPosClasses: string[] = [];
      for (let k = i; k < j; k++) {
        const chars = new Set<string>();
        for (const v of values) chars.add(v[k]);
        perPosClasses.push(
          chars.size === 1
            ? [...chars][0]
            : `[${[...chars].sort().join("")}]`,
        );
      }
      // Collapse consecutive identical classes with a quantifier
      let k = 0;
      while (k < perPosClasses.length) {
        let runEnd = k + 1;
        while (runEnd < perPosClasses.length && perPosClasses[runEnd] === perPosClasses[k]) {
          runEnd++;
        }
        const run = runEnd - k;
        parts.push(run === 1 ? perPosClasses[k] : `${perPosClasses[k]}{${run}}`);
        k = runEnd;
      }
      i = j;
    } else {
      if (/[.*+?^${}()|[\]\\]/.test(ch)) parts.push("\\" + ch);
      else parts.push(ch);
      i++;
    }
  }
  return new RegExp("^" + parts.join("") + "$");
}

/**
 * Infer a pattern from a list of column values. Returns null when the
 * input is too heterogeneous, too small, or a single unique value (trivial).
 *
 * Strength:
 *   - "strong" — one shape covers ≥75% of values, OR two shapes cover ≥85%.
 *   - "weak"   — strong pattern but digits-only (e.g., `^\d{2}$`). These
 *     match too much on real blueprints (dimensions, stair risers, etc.)
 *     so scoring should attenuate without hard-zero.
 */
export function inferTagPattern(values: string[]): InferredPattern | null {
  const cleaned = values
    .map((v) => v.trim().toUpperCase())
    .filter((v) => v.length > 0);

  if (cleaned.length < 3) return null;

  // Histogram by shape
  const shapes = new Map<string, string[]>();
  for (const v of cleaned) {
    const s = shapeOf(v);
    const list = shapes.get(s);
    if (list) list.push(v);
    else shapes.set(s, [v]);
  }

  // Need at least 2 distinct values for a pattern to be predictive
  const distinctCount = new Set(cleaned).size;
  if (distinctCount < 2) return null;

  const sorted = [...shapes.entries()].sort((a, b) => b[1].length - a[1].length);
  const [topShape, topValues] = sorted[0];
  const topRatio = topValues.length / cleaned.length;

  let selectedShape: string;
  let selectedValues: string[];

  if (topRatio >= 0.75) {
    // Single-shape dominant
    selectedShape = topShape;
    selectedValues = topValues;
  } else if (sorted.length >= 2) {
    const [, secondValues] = sorted[1];
    const combinedRatio = (topValues.length + secondValues.length) / cleaned.length;
    if (combinedRatio >= 0.85) {
      // Two shapes dominate — build a regex that ORs both
      const r1 = buildRegex(topShape, topValues);
      const r2 = buildRegex(sorted[1][0], secondValues);
      const combined = new RegExp(
        "^(?:" + r1.source.replace(/^\^|\$$/g, "") + "|" + r2.source.replace(/^\^|\$$/g, "") + ")$",
      );
      return {
        pattern: combined,
        strength: isWeakPattern(combined) ? "weak" : "strong",
      };
    }
    return null;
  } else {
    return null;
  }

  const regex = buildRegex(selectedShape, selectedValues);
  return {
    pattern: regex,
    strength: isWeakPattern(regex) ? "weak" : "strong",
  };
}

/**
 * Weak-pattern heuristic: a regex is "weak" if it would match a lot of
 * noise on real blueprint text. Digits-only patterns (e.g., `^\d{2}$`,
 * `^\d{3}$`) are the canonical weak case — they hit dimensions, stair
 * risers, sheet index numbers, keynote references, and room numbers.
 */
function isWeakPattern(regex: RegExp): boolean {
  const src = regex.source;
  // Strip ^$ anchors
  const bare = src.replace(/^\^/, "").replace(/\$$/, "");
  // Remove the \d escape sequences before scanning for literal letters,
  // else `\d` false-positives as "contains letter d".
  const noDigitEscape = bare.replace(/\\d/g, "");
  // Letter anchor: an actual literal letter outside a digit escape, OR
  // a character class containing letters.
  const hasLetter = /[A-Za-z]/.test(noDigitEscape);
  if (hasLetter) return false;
  // Digits-only or digits+punctuation → weak
  return true;
}
