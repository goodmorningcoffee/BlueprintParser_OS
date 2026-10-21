// Block finding for the owner's "same sheets in the same order" rule, made revision-safe:
// a block is pages [s, s+L) matched in order to [s+d, s+d+L) with L ≥ 3 and d ≥ L (the two
// copies do not overlap — "100 pages, then the same 100"). Offset-1 chains (typical floors
// L3, L4, L5 that each look like the next) therefore never form a block.

export const MIN_RUN = 3;

export interface RawBlock {
  /** First page of the earlier (canonical) copy. */
  start: number;
  /** Page distance between the two copies (d). */
  offset: number;
  /** Pages per copy (L). */
  length: number;
}

/**
 * `links` are page pairs [a, b] (a < b) that may sit in a block. For each offset d the
 * maximal runs of consecutive a are taken; a run longer than d is a set repeated more than
 * twice (period d) and is cut into d-long chunks, so every chunk satisfies d ≥ L. Chunks
 * shorter than `minRun` are dropped.
 */
export function findBlocks(links: Iterable<readonly [number, number]>, minRun = MIN_RUN): RawBlock[] {
  const byOffset = new Map<number, number[]>();
  for (const [a, b] of links) {
    const d = b - a;
    if (d <= 0) continue;
    const list = byOffset.get(d);
    if (list) list.push(a);
    else byOffset.set(d, [a]);
  }
  const blocks: RawBlock[] = [];
  for (const [d, starts] of byOffset) {
    const sorted = [...new Set(starts)].sort((x, y) => x - y);
    let runStart = 0;
    for (let i = 1; i <= sorted.length; i++) {
      if (i < sorted.length && sorted[i] === sorted[i - 1] + 1) continue;
      const first = sorted[runStart];
      const runLength = sorted[i - 1] - first + 1;
      for (let off = 0; off < runLength; off += d) {
        const length = Math.min(d, runLength - off);
        if (length >= minRun && d >= length) blocks.push({ start: first + off, offset: d, length });
      }
      runStart = i;
    }
  }
  return blocks;
}

/**
 * Keep the blocks that add a duplicate page not already covered, nearest-to-root first
 * (lowest canonical start, then smallest offset). A set repeated three times (1–10, 11–20,
 * 21–30) yields 1–10→11–20 and 1–10→21–30; the redundant 11–20→21–30 is dropped.
 */
export function resolveBlockCoverage(blocks: readonly RawBlock[]): RawBlock[] {
  const ordered = [...blocks].sort(
    (x, y) => x.start - y.start || x.offset - y.offset || y.length - x.length,
  );
  const covered = new Set<number>();
  const kept: RawBlock[] = [];
  for (const block of ordered) {
    let adds = false;
    for (let i = 0; i < block.length; i++) {
      if (!covered.has(block.start + block.offset + i)) {
        adds = true;
        break;
      }
    }
    if (!adds) continue;
    kept.push(block);
    for (let i = 0; i < block.length; i++) covered.add(block.start + block.offset + i);
  }
  return kept.sort((x, y) => x.start + x.offset - (y.start + y.offset) || x.start - y.start);
}

export function blockId(block: RawBlock): string {
  return `b${block.start}d${block.offset}l${block.length}`;
}
