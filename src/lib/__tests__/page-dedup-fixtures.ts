// Synthetic drawing-set text for the duplicate-page goldens. Deterministic pseudo-random
// words from a fixed construction vocabulary — NO client text (corpus pages are client data).
import type { DedupPageInput } from "@/lib/page-dedup";

const VOCAB = (
  "wall door frame steel concrete slab beam column footing joist stud gypsum board insulation " +
  "membrane flashing parapet roof deck truss anchor bolt weld plate angle channel grout mortar " +
  "brick block veneer sheathing vapor barrier sealant caulk lintel header sill jamb threshold " +
  "hardware hinge closer panic device finish paint primer tile ceiling grid diffuser duct " +
  "damper valve pipe conduit panel breaker fixture lamp switch outlet receptacle stair rail " +
  "guard tread riser landing ramp curb gutter downspout drain trench pit sump pump"
).split(" ");

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `words` body words in lines of 8, plus a number tag per line so lines are distinct. */
export function body(seed: number, words = 160): string[] {
  const next = rng(seed);
  const lines: string[] = [];
  let line: string[] = [];
  for (let i = 0; i < words; i++) {
    line.push(VOCAB[Math.floor(next() * VOCAB.length)]);
    if (line.length === 8) {
      lines.push(`${line.join(" ")} ${seed}x${lines.length}`);
      line = [];
    }
  }
  if (line.length) lines.push(line.join(" "));
  return lines;
}

export const TITLE_BLOCK = [
  "SYNTHETIC ARCHITECTS LLP",
  "123 EXAMPLE AVENUE SAMPLETOWN",
  "PROJECT: TEST TOWER RENOVATION",
  "DRAWN BY: XX   CHECKED BY: YY",
  "NOT FOR CONSTRUCTION UNLESS STAMPED",
];

export function page(pageNumber: number, drawingNumber: string | null, lines: string[], titleBlock = true): DedupPageInput {
  const all = [...lines, ...(titleBlock ? TITLE_BLOCK : []), ...(drawingNumber ? [drawingNumber] : [])];
  return { pageNumber, drawingNumber, rawText: all.join("\n") };
}

/** Replace word `index` of line `lineIndex` (a small OCR-level change). */
export function tweak(lines: string[], lineIndex: number, replacement = "revised"): string[] {
  return lines.map((l, i) => (i === lineIndex ? `${replacement} ${l.split(" ").slice(1).join(" ")}` : l));
}
