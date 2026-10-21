// Line diff for near pairs (the admin sees what changed between a permit set and its re-issue).
// LCS over normalized lines; only the changed lines are returned, capped.

import { normalizedLines } from "./normalize";

export interface DiffLine {
  op: "-" | "+";
  text: string;
}

const MAX_LINES = 600;

/** Lines only in `a` ("-") and only in `b` ("+"), in order, at most `limit` entries. */
export function lineDiff(aRaw: string | null, bRaw: string | null, limit = 40): DiffLine[] {
  const a = normalizedLines(aRaw).slice(0, MAX_LINES);
  const b = normalizedLines(bRaw).slice(0, MAX_LINES);
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const lcs = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j]
        ? lcs[(i + 1) * width + j + 1] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while ((i < n || j < m) && out.length < limit) {
    if (i < n && j < m && a[i] === b[j]) {
      i++;
      j++;
    } else if (j >= m || (i < n && lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) {
      out.push({ op: "-", text: a[i++] });
    } else {
      out.push({ op: "+", text: b[j++] });
    }
  }
  return out;
}
