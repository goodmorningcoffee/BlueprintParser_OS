// [evidence T4 2026-10-24] Text fusion: Textract words × yolo_text boxes.
// Rules from gitignore/projects/master_plan_2026-10-24/research/text/REPORT.md §7.2 (MEASURED on
// 400 pages / 280,411 words / 146,696 yolo_text boxes):
//   1. Match by WORD CENTRE inside the yolo_text box, never by IoU (IoU ≥ .5 loses 16 pts of true pairs).
//   2. Textract is authoritative: no OCR word is dropped or scored down (OCR-only words are real 97.5 %).
//   3. Both saw it → p_text = 1 − (1 − c_ocr)(1 − q(c_yolo)).   4. OCR only → p_text = c_ocr.
//   5. yolo_text box with no word centre → hole, p_text = q(c_yolo) — unless the fragment test says it
//      is a piece of a read word on the same line (8/37 real yolo-only crops were fragments).
// Pure; a uniform grid keeps it ~linear (pages carry up to ~3.5k words and ~6k yolo_text boxes).

import type { BboxMinMax, TextractWord } from "@/types";
import { ltwh2minmax } from "@/lib/bbox-utils";
import type { TextEvidenceCounts, TextEvidenceItem, TextHole } from "./types";

/**
 * P(a yolo_text box holds real text | its confidence), the measured step curve of §7.2.3
 * (0.66 below .3 … 0.98 at ≥ .8). Re-estimate it whenever the yolo_text model changes (§7.3).
 */
export function qYolo(conf: number): number {
  if (conf >= 0.8) return 0.98;
  if (conf >= 0.7) return 0.94;
  if (conf >= 0.6) return 0.89;
  if (conf >= 0.5) return 0.8;
  if (conf >= 0.3) return 0.7;
  return 0.66;
}

/** Textract and the Tesseract fallback store 0-100; tolerate rows already in 0-1. */
export function normaliseOcrConfidence(conf: number): number {
  if (!Number.isFinite(conf) || conf <= 0) return 0;
  return Math.min(1, conf > 1 ? conf / 100 : conf);
}

/**
 * Fragment test slack (INFERRED, not measured): a hole whose x-range comes within half its own
 * height of a word on the same line (vertical centres within 0.5 × the box height) is that word's
 * fragment. The report's rule says "touches"; half a glyph height absorbs the boxes' looseness.
 */
const FRAGMENT_X_SLACK = 0.5;
const FRAGMENT_Y_BAND = 0.5;

const GRID = 64;

/** Uniform grid over [0,1]²: each box is filed in every cell it overlaps. */
class BoxGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly stamp: Uint32Array;
  private tick = 0;

  constructor(boxes: readonly BboxMinMax[]) {
    this.stamp = new Uint32Array(boxes.length);
    boxes.forEach((b, i) => {
      this.forCells(b, (key) => {
        const list = this.cells.get(key);
        if (list) list.push(i);
        else this.cells.set(key, [i]);
      });
    });
  }

  /** Ids of every box filed in a cell `b` overlaps (each id once). */
  query(b: BboxMinMax): number[] {
    this.tick += 1;
    const out: number[] = [];
    this.forCells(b, (key) => {
      for (const id of this.cells.get(key) ?? []) {
        if (this.stamp[id] === this.tick) continue;
        this.stamp[id] = this.tick;
        out.push(id);
      }
    });
    return out;
  }

  private forCells(b: BboxMinMax, fn: (key: number) => void): void {
    const x0 = cell(b[0]), x1 = cell(b[2]), y0 = cell(b[1]), y1 = cell(b[3]);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) fn(y * GRID + x);
  }
}

function cell(v: number): number {
  return Math.max(0, Math.min(GRID - 1, Math.floor(v * GRID)));
}

export interface YoloTextBox {
  bbox: BboxMinMax;
  confidence: number;
}

export interface TextFusion {
  /** One per Textract word, in input order; `zone` is filled by the caller. */
  items: Array<Omit<TextEvidenceItem, "zone">>;
  holes: Array<Omit<TextHole, "zone">>;
  counts: TextEvidenceCounts;
}

/** Fuse a page's Textract words with its yolo_text boxes. */
export function fuseText(words: readonly TextractWord[], boxes: readonly YoloTextBox[]): TextFusion {
  const wordBoxes = words.map((w) => ltwh2minmax(w.bbox));
  const centres = wordBoxes.map((b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] as const);
  const cYolo: Array<number | null> = words.map(() => null);
  const grid = new BoxGrid(wordBoxes);
  const holes: TextFusion["holes"] = [];
  let fragments = 0;

  for (const box of boxes) {
    const [minX, minY, maxX, maxY] = box.bbox;
    let holdsWord = false;
    for (const id of grid.query(box.bbox)) {
      const [cx, cy] = centres[id];
      if (cx < minX || cx > maxX || cy < minY || cy > maxY) continue;
      holdsWord = true;
      const prev = cYolo[id];
      if (prev === null || box.confidence > prev) cYolo[id] = box.confidence;
    }
    if (holdsWord) continue;
    if (isFragment(box.bbox, wordBoxes, centres, grid)) { fragments++; continue; }
    holes.push({ bbox: box.bbox, cYolo: box.confidence, pText: qYolo(box.confidence) });
  }

  let both = 0;
  const items = words.map((w, i) => {
    const cOcr = normaliseOcrConfidence(w.confidence);
    const cy = cYolo[i];
    if (cy === null) return { text: w.text, bbox: wordBoxes[i], cOcr, cYolo: null, source: "ocr" as const, pText: cOcr };
    both++;
    const pText = 1 - (1 - cOcr) * (1 - qYolo(cy));
    return { text: w.text, bbox: wordBoxes[i], cOcr, cYolo: cy, source: "both" as const, pText };
  });

  return {
    items,
    holes,
    counts: {
      ocrWords: words.length,
      both,
      ocrOnly: words.length - both,
      yoloTextBoxes: boxes.length,
      holes: holes.length,
      fragments,
    },
  };
}

/** Same text line as a read word (centres within half the box height) and touching it in x. */
function isFragment(
  box: BboxMinMax,
  wordBoxes: readonly BboxMinMax[],
  centres: ReadonlyArray<readonly [number, number]>,
  grid: BoxGrid,
): boolean {
  const h = box[3] - box[1];
  const cy = (box[1] + box[3]) / 2;
  const slack = h * FRAGMENT_X_SLACK;
  const band = h * FRAGMENT_Y_BAND;
  const probe: BboxMinMax = [box[0] - slack, cy - band, box[2] + slack, cy + band];
  for (const id of grid.query(probe)) {
    if (Math.abs(centres[id][1] - cy) > band) continue;
    const w = wordBoxes[id];
    if (box[0] <= w[2] + slack && box[2] >= w[0] - slack) return true;
  }
  return false;
}
