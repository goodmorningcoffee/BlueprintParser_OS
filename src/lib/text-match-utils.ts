/**
 * text-match-utils.ts
 *
 * Shared keyword-matching helpers for classifiers. Replaces ad-hoc
 * `text.includes(keyword)` substring matching with word-boundary-aware
 * matching so "DOOR" no longer partial-matches "INDOOR"/"OUTDOOR" and
 * "SCHEDULE" no longer partial-matches "RESCHEDULE".
 *
 * Consumers:
 *   - `src/lib/heuristic-engine.ts` scoreRule keyword matching
 *   - `src/lib/table-classifier.ts` scoreRegionForCategory keyword matching
 *   - `src/lib/composite-classifier.ts` findHeaderKeyword (previously had
 *     a local copy of this function, now imports from here)
 */

/**
 * Case-insensitive whole-word match. Handles keywords with special regex
 * characters. For multi-word phrases ("GENERAL NOTES"), matches the phrase
 * with word boundaries at both ends. For keywords ending in non-word chars
 * ("NOTES:"), the trailing boundary is relaxed (a `:` is already a
 * word→non-word transition).
 */
export function isWholeWordMatch(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const escaped = needle.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const startsWithWord = /^\w/.test(needle);
  const endsWithWord = /\w$/.test(needle);
  const pattern = `${startsWithWord ? "\\b" : ""}${escaped}${endsWithWord ? "\\b" : ""}`;
  const re = new RegExp(pattern, "i");
  return re.test(haystack);
}
