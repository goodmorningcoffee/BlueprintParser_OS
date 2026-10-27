/**
 * Column-header dedupe (K06). Legacy rows are `Record<header, string>`, so two columns that share a
 * printed name ("TYPE" under DOOR and under FRAME) collapse into one key and the second column's
 * values overwrite the first. Every producer of header-keyed rows runs its headers through
 * `uniqueHeaders` so each column keeps its own key.
 *
 * Rule: the first occurrence keeps its label; later ones become `X (2)`, `X (3)`, … (the suffix the
 * shape-rows method already used). A suffix that would collide with a label already taken (a header
 * literally printed `X (2)`) moves on to the next free number. A blank or whitespace-only label
 * becomes `Column <n>` (1-based position), the codebase's generic name. Comparison is exact and
 * case-sensitive, because record keys are. Pure, client-safe.
 */
export function uniqueHeaders(headers: readonly string[]): string[] {
  const base = headers.map((h, i) => (typeof h === "string" && h.trim() !== "" ? h : `Column ${i + 1}`));
  const taken = new Set<string>();
  const nextSuffix = new Map<string, number>();
  // Labels as printed claim their key first, so a printed "X (2)" is never renamed to "X (2) (2)"
  // only because an earlier duplicate "X" would have generated it.
  const firstAt = new Map<string, number>();
  base.forEach((h, i) => {
    if (!firstAt.has(h)) firstAt.set(h, i);
  });
  for (const h of firstAt.keys()) taken.add(h);
  return base.map((h, i) => {
    if (firstAt.get(h) === i) return h;
    let n = nextSuffix.get(h) ?? 2;
    while (taken.has(`${h} (${n})`)) n++;
    const label = `${h} (${n})`;
    nextSuffix.set(h, n + 1);
    taken.add(label);
    return label;
  });
}

/**
 * The name a renamed column may take without colliding (K06 on rename): `name` itself when no other
 * column uses it, else the next free `name (n)` by the `uniqueHeaders` rule. The other columns never
 * change, so their row keys stay valid. A blank name becomes `Column <index + 1>`. Exact and
 * case-sensitive, like `uniqueHeaders`.
 */
export function renamedHeader(headers: readonly string[], index: number, name: string): string {
  const taken = new Set(headers.filter((_, i) => i !== index));
  const label = typeof name === "string" && name.trim() !== "" ? name : `Column ${index + 1}`;
  if (!taken.has(label)) return label;
  let n = 2;
  while (taken.has(`${label} (${n})`)) n++;
  return `${label} (${n})`;
}
