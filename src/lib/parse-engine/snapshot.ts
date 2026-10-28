/**
 * Structure snapshots (table pipeline WP-3.D; PLAN §2.1 `StructureSnapshot`, `ParseLabel`; C3-m4). Pure,
 * client-safe (E-8: imports only `./types` and `./legacy-view`), deterministic (E-7).
 *
 * A snapshot is the comparable shape of a model: row and column boundaries (4 dp), the header row count, the tag
 * column index, one short hash per cell and the paragraph keys and bands. The commit (WP-3.G) stores the MACHINE
 * snapshot (recomputed server-side from the re-run parse) and the ACCEPTED one next to a label, and infers
 * "corrected" when they differ; a rebase reports `changedRows` from `diffSnapshots`.
 *
 *   snapshotOf(model)          → StructureSnapshot
 *   snapshotHash(snapshot)     → "ss1:<hex>" (`ParseLabel.snapshotHash`)
 *   diffSnapshots(a, b)        → what changed (rows, columns, header, tag, cells, paragraphs, kind)
 *   stableHash(value)          → "h1:<hex>" over canonical JSON (the engine's `paramsHash`)
 *
 * Rows are listed in model order (part order, then top to bottom), so a two-part table's `rowY` is the two parts'
 * boundary lists concatenated, exactly like `FusedRows.rowLines` (R11).
 */

import { canonicalJson } from "./legacy-view";
import type { StructureModel, StructureSnapshot } from "./types";

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/** cyrb53 (public domain), seeded, 53 bits as 14 hex digits. Detects change; not cryptographic. */
function cyrb53(text: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** A 106-bit hash of `value`'s canonical JSON (sorted keys, `undefined` dropped). */
export function stableHash(value: unknown): string {
  const text = canonicalJson(value);
  return `h1:${cyrb53(text, 11)}${cyrb53(text, 12)}`;
}

const isParagraphModel = (m: StructureModel): m is Extract<StructureModel, { kind: "notes" | "spec" }> => m.kind === "notes" || m.kind === "spec";

/** The comparable snapshot of a model (see the file header). */
export function snapshotOf(model: StructureModel): StructureSnapshot {
  if (isParagraphModel(model)) {
    return {
      kind: model.kind,
      rowY: [],
      colX: [],
      headerRows: 0,
      cellHash: model.paragraphs.map((p) => cyrb53(`${p.keyNorm}\u0000${p.text}`, 7)),
      paragraphs: model.paragraphs.map((p) => ({ key: p.key, y0: r4(p.b[1]), y1: r4(p.b[3]) })),
    };
  }
  const rows = model.rows;
  const rowY: number[] = [];
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    if (i === 0 || (prev.part ?? 0) !== (r.part ?? 0)) rowY.push(r4(r.y0));
    rowY.push(r4(r.y1));
  });
  const colX = model.cols.length ? [r4(model.cols[0].x0), ...model.cols.map((c) => r4(c.x1))] : [];
  const ri = new Map(rows.map((r, i) => [r.id, i]));
  const ci = new Map(model.cols.map((c, i) => [c.id, i]));
  const cellHash = model.cells
    .filter((c) => ri.has(c.row) && ci.has(c.col))
    .map((c) => ({ r: ri.get(c.row)!, c: ci.get(c.col)!, rs: c.rs ?? 1, cs: c.cs ?? 1, t: c.text }))
    .sort((a, b) => a.r - b.r || a.c - b.c)
    .map((c) => cyrb53(`${c.r}:${c.c}:${c.rs}x${c.cs}\u0000${c.t}`, 7));
  const tagCol = model.tag ? ci.get(model.tag.col) : undefined;
  return {
    kind: model.kind,
    rowY,
    colX,
    headerRows: model.headerRows,
    ...(tagCol !== undefined ? { tagCol } : {}),
    cellHash,
  };
}

/** `ParseLabel.snapshotHash`. */
export function snapshotHash(s: StructureSnapshot): string {
  return `ss1:${stableHash(s).slice(3)}`;
}

export interface SnapshotDiff {
  same: boolean;
  kindChanged: boolean;
  /** Row boundaries that moved, appeared or disappeared (beyond `tol`). */
  rowsChanged: number;
  colsChanged: number;
  headerChanged: boolean;
  tagChanged: boolean;
  /** Cells (or paragraphs) whose text / span hash is not in the other snapshot. */
  cellsChanged: number;
  paragraphsChanged: number;
}

/** Boundaries of `a` with no partner in `b` within `tol`, plus the reverse (a count of changed lines). */
function lineChanges(a: readonly number[], b: readonly number[], tol: number): number {
  const unmatched = (xs: readonly number[], ys: readonly number[]): number => {
    const used = new Set<number>();
    let n = 0;
    for (const x of xs) {
      let best = -1;
      for (let j = 0; j < ys.length; j++) if (!used.has(j) && Math.abs(ys[j] - x) <= tol && (best < 0 || Math.abs(ys[j] - x) < Math.abs(ys[best] - x))) best = j;
      if (best < 0) n++;
      else used.add(best);
    }
    return n;
  };
  return Math.max(unmatched(a, b), unmatched(b, a));
}

function multisetDiff(a: readonly string[], b: readonly string[]): number {
  const count = new Map<string, number>();
  for (const x of a) count.set(x, (count.get(x) ?? 0) + 1);
  let missing = 0;
  for (const x of b) {
    const n = count.get(x) ?? 0;
    if (n > 0) count.set(x, n - 1);
    else missing++;
  }
  let left = 0;
  for (const n of count.values()) left += n;
  return Math.max(missing, left);
}

/** What changed between two snapshots (`tol` in normalised page units; default .0015 ≈ a fifth of a text line). */
export function diffSnapshots(a: StructureSnapshot, b: StructureSnapshot, tol = 0.0015): SnapshotDiff {
  const pa = a.paragraphs ?? [];
  const pb = b.paragraphs ?? [];
  const paraKey = (p: { key: string | null; y0: number; y1: number }): string => `${p.key ?? ""}@${p.y0}:${p.y1}`;
  const d: SnapshotDiff = {
    same: false,
    kindChanged: a.kind !== b.kind,
    rowsChanged: lineChanges(a.rowY, b.rowY, tol),
    colsChanged: lineChanges(a.colX, b.colX, tol),
    headerChanged: a.headerRows !== b.headerRows,
    tagChanged: a.tagCol !== b.tagCol,
    cellsChanged: multisetDiff(a.cellHash, b.cellHash),
    paragraphsChanged: multisetDiff(pa.map(paraKey), pb.map(paraKey)),
  };
  d.same = !d.kindChanged && d.rowsChanged === 0 && d.colsChanged === 0 && !d.headerChanged && !d.tagChanged && d.cellsChanged === 0 && d.paragraphsChanged === 0;
  return d;
}
