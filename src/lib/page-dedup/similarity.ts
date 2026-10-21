// 3-word shingles hashed to uint32 (FNV-1a), Jaccard by sorted merge. Pure; no DB, no I/O.

export const SHINGLE_K = 3;

/** FNV-1a 32-bit over a string's UTF-16 code units. */
export function fnv1a32(text: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Two independent FNV-1a passes → a 16-hex-char key (cross-project exact-text matching). */
export function textHash64(text: string): string {
  const a = fnv1a32(text).toString(16).padStart(8, "0");
  const b = fnv1a32(text, 0x9747b28c).toString(16).padStart(8, "0");
  return a + b;
}

/** Sorted, de-duplicated shingle hashes. Fewer than k tokens → one shingle of all of them. */
export function shingles(tokens: readonly string[], k = SHINGLE_K): Uint32Array {
  if (tokens.length === 0) return new Uint32Array(0);
  const set = new Set<number>();
  if (tokens.length < k) {
    set.add(fnv1a32(tokens.join(" ")));
  } else {
    for (let i = 0; i + k <= tokens.length; i++) {
      set.add(fnv1a32(tokens.slice(i, i + k).join(" ")));
    }
  }
  const out = Uint32Array.from(set);
  out.sort();
  return out;
}

/** |A ∩ B| / |A ∪ B| over two sorted unique arrays; 0 when both are empty. */
export function jaccard(a: Uint32Array, b: Uint32Array): number {
  if (a.length === 0 && b.length === 0) return 0;
  let i = 0;
  let j = 0;
  let inter = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      inter++;
      i++;
      j++;
    } else if (a[i] < b[j]) {
      i++;
    } else {
      j++;
    }
  }
  return inter / (a.length + b.length - inter);
}

/** Upper bound on Jaccard from set sizes alone (min/max) — the cheap prefilter. */
export function jaccardUpperBound(sizeA: number, sizeB: number): number {
  const max = Math.max(sizeA, sizeB);
  return max === 0 ? 0 : Math.min(sizeA, sizeB) / max;
}

/**
 * |A △ B| (shingles in one set only) recovered from the sizes and their Jaccard j:
 * |A ∩ B| = j(|A|+|B|)/(1+j), so |A △ B| = (|A|+|B|)(1−j)/(1+j). One changed interior word
 * moves k shingles out of each side, i.e. 2k = 6 for k = 3, whatever the page size.
 */
export function changedShingles(sizeA: number, sizeB: number, j: number): number {
  return Math.round(((sizeA + sizeB) * (1 - j)) / (1 + j));
}
