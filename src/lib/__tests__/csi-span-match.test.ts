// @vitest-environment node
/**
 * csi-span-match.test.ts — CSI tagger v2, S3: the span matcher (`src/lib/csi-span-match.ts`,
 * `src/lib/csi-span-own.ts`) over the REAL committed KB (no toy KB: a hand-made KB has
 * negative / meaningless IDF and certifies nothing).
 *
 * The KB is gitignored by design (owner ruling D1, 2026-10-20), so every describe here is
 * `skipIf(!HAS_KB)`; under BP_REQUIRE_CSI_KB=1 (scripts/bp-suite's default) src/test/global-setup.ts
 * fails the run instead of letting it go green on skips.
 *
 * Spec: IMPLEMENTATION §II S3; the design ruling
 * `gitignore/projects/csi_tagger_v2/notes/S3_DESIGN_20261020T2320Z.md` §7 (decisions J1–J21).
 * EVERY expectation below was MEASURED with the real matcher before it was pinned (2026-10-20, kb-v2.4):
 *   the table rows: generator gitignore/projects/csi_tagger_v2/logs/s3-20261020T2320Z-table-gen.ts.txt
 *   (matchUnit over each input, printed in this exact row format; its output is
 *   …/logs/s3-20261020T2320Z-table-measured.txt) — re-measure with (copied to gen.ts)
 *     npx esbuild gen.ts --bundle --platform=node --alias:@=./src --outfile=/tmp/gen.cjs && node /tmp/gen.cjs src/data/csi-kb.json
 *   the floors and S400 numbers: `eval/csi/span-measure.ts` (see its header), log
 *     gitignore/projects/csi_tagger_v2/logs/s3-20261020T2320Z-span-measure.txt
 * fix2 (2026-10-21): the self-retrieval triple and the index breakdown are pinned EXACTLY (floors let
 * mutants that moved the metric the "good" way pass); rows pin the ±(n+1) radius alone, diff slots left
 * of the anchor and on index patterns, by_others under every ownership step, and the marker regex's
 * case / trailing-punctuation / spaced-N.I.C. features; a long-single-unit perf test pins linear cost.
 * fix3 (2026-10-21): E2 at diff shares <= 0.15 (where the rest of the pattern clears even 0.85, so E2
 * alone decides) and the printed-order tie-break for equidistant occurrences; measured and mutant-checked
 * in gitignore/projects/csi_tagger_v2/logs/s3c-20261021T0140Z-fix3-*.
 * S5 tune (2026-10-21, kb-v2.5 + the S5 runtime rules): every pin that moved was RE-MEASURED before it was
 *   re-pinned — table rows by a regenerator over this TABLE, trace facts and probes by
 *   gitignore/projects/csi_tagger_v2/logs/s5t-20261021T0640Z-span-facts.txt, the self-retrieval / S400 / index
 *   numbers by `eval/csi/span-measure.ts` (log …/logs/s5t-20261021T0640Z-span-measure.txt). Rows marked S5.
 * Two §II table claims are FALSE on kb-v2.4 and are pinned as measured: `PAINTING` → 09 91 00 via
 * the oneWordOk term row PAINT (not a hint; J11), and the window row is not `GYPSUM QQQ…` (J12).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCsiKbFromFile } from "@/lib/csi-kb";
import type { LoadedKb } from "@/lib/csi-kb-types";
import {
  NEGATION_TAIL_RE, csiTokenizeForKb, matchUnit, traceUnit, unitFromCell, unitFromText, unitFromWords, unitsFromText,
  type Context, type MatchTrace, type Span, type Unit,
} from "@/lib/csi-span-match";
import { FAMILY_DISCOUNT, groupRanges, isAncestorIdx, ownRanges, prepareKb, type Prepared, type SupportedSpan } from "@/lib/csi-span-own";

const root = process.cwd();
const KB_REL = "src/data/csi-kb.json";
/** Absent on a fresh clone by design (D1, 2026-10-20) — see the file header. */
const HAS_KB = existsSync(join(root, KB_REL));
if (!HAS_KB) {
  console.warn(
    `[csi-span-match] SKIPPING every test in this file: ${KB_REL} is absent (gitignored by design, owner ruling D1). ` +
      "Rebuild it from the MasterFormat PDF — see the header of eval/csi/build-kb-v2.ts.",
  );
}

let kb: LoadedKb;
let prep: Prepared;
beforeAll(() => {
  if (!HAS_KB) return;
  kb = loadCsiKbFromFile(join(root, KB_REL));
  prep = prepareKb(kb);
});

type Cell = { header?: string; title?: string; text: string };
type In = string | Cell;
const unitOf = (inp: In): Unit => (typeof inp === "string" ? unitFromText(inp, kb) : unitFromCell(inp, kb));
const ctxOf = (d?: string): Context | undefined => (d ? { discipline: d } : undefined);
const fmt = (s: Span) => `${s.code}@${s.s.toFixed(3)} ${s.source} [${s.tokenStart}-${s.tokenEnd}]${s.familyOf ? " family" : ""}${s.scope ? " by_others" : ""}`;
const fmtSup = (s: SupportedSpan) => `${prep.codes[s.codeIdx]}@${s.s.toFixed(3)} ${kb.patterns[s.pid].source}${s.isRegex ? "(regex)" : ""} [${s.lo}-${s.hi}]`;
const supCodes = (ss: SupportedSpan[]) => [...new Set(ss.map((s) => prep.codes[s.codeIdx]))].sort();
const codesOf = (spans: Span[]) => [...new Set(spans.map((s) => s.code))].sort();
const trace = (inp: In, d?: string): MatchTrace => traceUnit(unitOf(inp), kb, ctxOf(d));
const isAnc = (a: string, d: string) => {
  const ai = prep.codeIndex.get(a), di = prep.codeIndex.get(d);
  return ai !== undefined && di !== undefined && isAncestorIdx(prep, ai, di);
};

/** [group, input, discipline, owned spans "code@s source [lo-hi] (family) (by_others)", divisionHints] — all MEASURED. */
const TABLE: [string, In, string | undefined, string[], string[]][] = [
  // ── 4/5 vs 3/5
  ["4/5 vs 3/5", "AUTOCLAVED AERATED CONCRETE UNIT MASONRY", undefined, ["04 22 26@1.000 title [0-4]"], []],
  ["4/5 vs 3/5", "AUTOCLAVED AERATED UNIT MASONRY", undefined, ["04 22 26@0.884 title [0-3]"], []],
  ["4/5 vs 3/5", "AUTOCLAVED AERATED MASONRY", undefined, [], ["04 00 00"]],
  // ── diff mandatory
  ["diff mandatory", "PLAIN STEEL REINFORCEMENT BARS", undefined, ["03 21 11@1.000 title [0-3]"], []],
  ["diff mandatory", "PLAIN REINFORCEMENT BARS", undefined, ["03 21 00@1.000 title [1-2]"], []],
  // fix1: the diff token IS in the unit but beyond a boundary — only the per-placement E2 check
  // (not the presence prefilter) stops 03 21 11 @0.817 here
  ["diff mandatory", "STEEL: PLAIN REINFORCEMENT BARS", undefined, ["03 21 00@1.000 title [2-3]"], []],
  ["diff mandatory", "PLAIN REINFORCEMENT BARS; STEEL", undefined, ["03 21 00@1.000 title [1-2]"], []],
  // fix2: a diff token LEFT of the anchor, behind a boundary — a title (00 31 26.36, `existing` slot 0,
  // anchor `drum` slot 3) and an INDEX pattern (00 31 32, `soil` slot 0, anchor `boring` slot 1)
  ["diff mandatory", "EXISTING HAZARDOUS WASTE DRUM INFORMATION", undefined, ["00 31 26.36@1.000 title [0-4]"], []],
  // S5 (kb-v2.5): `information` is a HINT_STOP_TOKENS word, so its 28 00 00 hint is gone
  ["diff mandatory", "EXISTING: HAZARDOUS WASTE DRUM INFORMATION", undefined, [], []],
  ["diff mandatory", "SOIL BORING AVAILABLE INFORMATION DATA", undefined, ["00 31 32@1.000 index [0-4]"], []],
  ["diff mandatory", "SOIL: BORING AVAILABLE INFORMATION DATA", undefined, ["00 30 00@1.000 title [2-3]"], []],
  // fix3: a diff token carrying <= 0.15 of the mass, so the REST clears even a 0.85 coverage bar — E2 is the
  // only gate. Omitted, behind a boundary, and (09 05 61.13) present but beyond the ±(n+1) radius. Right of
  // the anchor: 09 05 61.13 title (`control` 0.132), 33 05 19 index (`pipe` 0.145); left of it: 02 83 13
  // title (`control` 0.127; 0.126 at kb-v2.4), 23 83 16 index (`water` 0.140). Each full form first, to show it is a real match.
  ["diff mandatory", "MOISTURE VAPOR EMISSION CONTROL", undefined, ["09 05 61.13@1.000 title [0-3]"], []],
  ["diff mandatory", "MOISTURE VAPOR EMISSION", undefined, [], []],
  ["diff mandatory", "MOISTURE VAPOR EMISSION; CONTROL", undefined, [], []],
  ["diff mandatory", "MOISTURE VAPOR EMISSION QQQ QQQ QQQ QQQ QQQ CONTROL", undefined, [], []],
  ["diff mandatory", "DUCTILE IRON UTILITY PIPING", undefined, ["33 05 19@1.000 title [0-3]"], []],
  ["diff mandatory", "DUCTILE IRON UTILITY", undefined, [], ["33 00 00"]],
  ["diff mandatory", "DUCTILE IRON UTILITY; PIPING", undefined, [], ["33 00 00"]],
  ["diff mandatory", "LEAD HAZARD CONTROL ACTIVITIES", undefined, ["02 83 13@1.000 title [0-3]"], []],
  ["diff mandatory", "LEAD HAZARD ACTIVITIES", undefined, [], []],
  ["diff mandatory", "CONTROL: LEAD HAZARD ACTIVITIES", undefined, [], []],
  ["diff mandatory", "HOT WATER BASEBOARD RADIATION", undefined, ["23 83 16@1.000 index [0-3]"], []],
  ["diff mandatory", "HOT BASEBOARD RADIATION", undefined, ["23 83 00@1.000 index [1-2]"], []],
  ["diff mandatory", "WATER: HOT BASEBOARD RADIATION", undefined, ["23 83 00@1.000 index [2-3]"], []],
  // ── window
  ["window", "CONCRETE QQQ FOOTING ZZZ SCHEDULE", undefined, ["03 06 30.13@0.850 title [0-4]"], []],
  ["window", "CONCRETE QQQ ZZZ FOOTING XXX WWW SCHEDULE", undefined, [], ["03 00 00"]],
  // fix1: width n+2 vs n+3 with every token inside the ±(n+1) radius — the E5 gate alone decides
  ["window", "CONCRETE QQQ ZZZ FOOTING XXX SCHEDULE", undefined, [], ["03 00 00"]],
  // S5: STEEL after BARS is out of printed order for the strict-order title → OUT_OF_ORDER_FACTOR 0.7 (was 0.85)
  ["window", "PLAIN REINFORCEMENT BARS QQQ ZZZ STEEL", undefined, ["03 21 11@0.700 title [0-5]"], []],
  ["window", "PLAIN REINFORCEMENT BARS QQQ ZZZ XXX STEEL", undefined, ["03 21 00@1.000 title [1-2]"], []],
  ["window", "BAMBOO QQQ FLOORING", undefined, ["09 64 36@0.850 title [0-2]"], []],
  ["window", "BAMBOO QQQ RRR FLOORING", undefined, ["09 64 36@0.850 title [0-3]"], []],
  // fix2 relabel: BOTH rules reject this one — FLOORING is 4 from BAMBOO (outside radius 3) and the
  // span would be 5 wide (> n + 2) — so it pins neither alone; the radius rows below do
  ["window", "BAMBOO QQQ RRR SSS FLOORING", undefined, [], ["09 00 00"]],
  // fix2: the ±(n+1) RADIUS alone. 00 01 20 index "separately bound schedules list" (n 4, anchor
  // `bound` slot 1, `schedule` non-diff at 0.128 of the mass). SCHEDULE at n+1 = 5 from BOUND is found
  // and the 7-wide span fails the gate; at n+2 = 6 it is NOT found and the rest passes on 0.872
  ["radius", "SEPARATELY BOUND LIST QQQ QQQ SCHEDULE", undefined, ["00 01 20@0.850 index [0-5]"], []],
  ["radius", "SEPARATELY BOUND LIST QQQ QQQ QQQ SCHEDULE", undefined, [], []],
  ["radius", "SEPARATELY BOUND LIST QQQ QQQ QQQ QQQ SCHEDULE", undefined, ["00 01 20@0.872 index [0-2]"], []],
  ["radius", "SEPARATELY BOUND LIST QQQ QQQ QQQ QQQ QQQ QQQ SCHEDULE", undefined, ["00 01 20@0.872 index [0-2]"], []],
  ["window", "GYPSUM QQQ ZZZ XXX BOARD", undefined, ["09 21 16@0.707 title [0-4]"], []],
  // ── punctuation
  ["punctuation", "GYPSUM, BOARD", undefined, ["09 29 00@1.000 title [0-1]"], []],
  ["punctuation", "GYPSUM. BOARD", undefined, [], []],
  ["punctuation", "GYPSUM; BOARD", undefined, [], []],
  ["punctuation", "GYPSUM: BOARD", undefined, [], []],
  ["punctuation", "GYPSUM (BOARD)", undefined, [], []],
  ["punctuation", "GYP. BD.", undefined, ["09 29 00@1.000 term [0-1]"], []],
  ["punctuation", "GYPSUM BOARD: TYPE X", undefined, ["09 29 00@1.000 title [0-1]"], []],
  // fix1: segment-restricted search (a deviation from E5's letter — see csi-span-match.ts 5.3):
  // CONCRETE beyond the boundary is NOT FOUND, 04 22 26 passes on 0.884 of its mass; the literal
  // "nearest, then reject if a boundary is inside" rule would own 04 20 00 [3-4] instead
  ["punctuation", "CONCRETE: AUTOCLAVED AERATED UNIT MASONRY", undefined, ["04 22 26@0.884 title [1-4]"], ["03 00 00"]],
  ["punctuation", "AUTOCLAVED AERATED UNIT MASONRY (CONCRETE)", undefined, ["04 22 26@0.884 title [0-3]"], ["03 00 00"]],
  // ── order
  ["order", "GYPSUM BOARD", undefined, ["09 29 00@1.000 title [0-1]"], []],
  ["order", "BOARD GYPSUM", undefined, ["09 29 00@1.000 index [0-1]"], []],
  ["order", "GYPSUM WALL BOARD", undefined, ["09 29 00@1.000 term [0-2]"], []],
  // fix3: the printed-order tie-break for two occurrences EQUIDISTANT from the anchor (design §0 E1/E5 row):
  // a slot right of the anchor takes the right one, a slot left of it the left one
  ["tie-break", "THERMAL INSULATION", undefined, ["07 21 00@1.000 title [0-1]"], []],
  // S5: the INSULATION term row (07 21 00, oneWordOk) owns the lone first word; the title still takes [1-2]
  ["tie-break", "INSULATION THERMAL INSULATION", undefined, ["07 21 00@1.000 term [0-0]","07 21 00@1.000 title [1-2]"], []],
  ["tie-break", "ROOF REPLACEMENT ROOF", undefined, ["07 01 50.81@1.000 title [0-1]"], []],
  ["tie-break", "CONCRETE ACCELERATOR CONCRETE", undefined, ["03 05 00@1.000 index [1-2]"], ["03 00 00"]],
  ["tie-break", "CONCRETE ADMIXTURE CONCRETE", undefined, ["03 05 00@1.000 index [0-1]"], ["03 00 00"]],
  // ── one-word
  ["one-word", "CMU", undefined, ["04 22 00@1.000 term [0-0]"], []],
  ["one-word", "CONCRETE", undefined, [], ["03 00 00"]],
  ["one-word", "ELEVATORS", undefined, [], ["14 00 00"]],
  ["one-word", "MASONRY", undefined, [], ["04 00 00"]],
  ["one-word", "GLAZING", undefined, [], ["08 00 00"]],
  ["one-word", "CASEWORK", undefined, [], ["12 00 00"]],
  ["one-word", "FIRESTOPPING", undefined, [], ["07 00 00"]],
  ["one-word", "OFFICE", undefined, [], []],
  ["one-word", "KITCHEN", undefined, [], []],
  ["one-word", "SECURITY", undefined, [], []],
  ["one-word", "OTHERS", undefined, [], []],
  ["one-word", "FINISH", undefined, [], ["09 00 00"]],
  ["one-word", "PAINTING", undefined, ["09 91 00@1.000 term [0-0]"], []],
  // ── 08 11 family
  ["08 11 family", "METAL DOORS", undefined, ["08 13 00@1.000 title [0-1]"], []],
  ["08 11 family", "HOLLOW METAL DOORS", undefined, ["08 13 13@1.000 title [0-2]"], []],
  ["08 11 family", "HOLLOW METAL FRAME", undefined, ["08 12 13@1.000 title [0-2]"], []],
  ["08 11 family", "HOLLOW METAL DOORS AND FRAMES", undefined, ["08 11 13@1.000 title [0-3]"], []],
  ["08 11 family", "STANDARD HOLLOW METAL DOORS AND FRAMES", undefined, ["08 11 13.13@1.000 title [0-4]"], []],
  ["08 11 family", "CUSTOM HOLLOW METAL DOORS AND FRAMES", undefined, ["08 11 13.16@1.000 title [0-4]"], []],
  ["08 11 family", "WOOD DOORS", undefined, ["08 14 00@1.000 title [0-1]"], []],
  ["08 11 family", "FIRE ALARM SYSTEM", undefined, ["28 46 21@1.000 title [0-1]"], []],
  // ── term rows
  ["term rows", "RIGID INSULATION", undefined, ["07 21 13@1.000 term [0-1]"], []],
  ["term rows", "BATT INSULATION", undefined, ["07 21 16@1.000 term [0-1]"], []],
  ["term rows", "SPRINKLER SYSTEM", undefined, ["21 13 00@1.000 term [0-1]"], []],
  ["term rows", "SEWAGE PUMP", undefined, ["22 13 29@1.000 term [0-1]"], []],
  // ── cross-division
  ["cross-division", "BALL VALVE", "P", ["22 05 23@1.000 term [0-1]"], []],
  ["cross-division", "BALL VALVE", "M", ["23 05 23@1.000 term [0-1]"], []],
  ["cross-division", "BALL VALVE", undefined, [], ["22 00 00","23 00 00"]],
  ["cross-division", "BALL VALVE", "A", [], ["22 00 00","23 00 00"]],
  ["cross-division", "BALL VALVE", "E", [], ["22 00 00","23 00 00"]],
  ["cross-division", "BALL VALVE", "FA", [], ["22 00 00","23 00 00"]],
  ["cross-division", "GATE VALVE", "P", ["22 05 23@1.000 term [0-1]"], []],
  ["cross-division", "GATE VALVE", "M", ["23 05 23@1.000 term [0-1]"], []],
  ["cross-division", "GATE VALVE", undefined, [], ["22 00 00","23 00 00"]],
  // ── negation
  ["negation", "DOOR HARDWARE BY OTHERS", undefined, ["08 71 00@1.000 title [0-1] by_others"], []],
  ["negation", "DOOR HARDWARE", undefined, ["08 71 00@1.000 title [0-1]"], []],
  ["negation", "CARPET (N.I.C.)", undefined, ["09 68 00@1.000 term [0-0] by_others"], []],
  ["negation", "CARPET N.I.C.", undefined, ["09 68 00@1.000 term [0-0] by_others"], []],
  ["negation", "CARPET BY OWNER", undefined, ["09 68 00@1.000 term [0-0] by_others"], []],
  ["negation", "CARPET NOT IN CONTRACT", undefined, ["09 68 00@1.000 term [0-0] by_others"], []],
  ["negation", "CARPET BY OTHERS UNLESS NOTED", undefined, ["09 68 00@1.000 term [0-0]"], []],
  ["negation", "CLINIC CARPET", undefined, ["09 68 00@1.000 term [1-1]"], []],
  ["negation", "PANIC HARDWARE", undefined, [], ["08 00 00"]],
  // fix1: units ENDING in …NIC — only the regex's non-alphanumeric lead keeps these un-negated
  ["negation", "CARPET CLINIC", undefined, ["09 68 00@1.000 term [0-0]"], []],
  ["negation", "DOOR HARDWARE PANIC", undefined, ["08 71 00@1.000 title [0-1]"], []],
  ["negation", "CARPET ELECTRONIC", undefined, ["09 68 00@1.000 term [0-0]"], []],
  // fix1: EVERY owned span of a negated unit is by_others (§6.6), not just the first
  ["negation", "PTD GWB BY OTHERS", undefined, ["09 91 00@1.000 term [0-0] by_others","09 29 00@1.000 term [1-1] by_others"], []],
  ["negation", "HOLLOW METAL DOOR GYPSUM BOARD N.I.C.", undefined, ["08 13 13@1.000 title [0-2] by_others","09 29 00@1.000 title [3-4] by_others"], []],
  ["negation", "EQUIPMENT BY OTHERS", undefined, [], ["11 00 00"]],
  // fix2: the marker regex — case-insensitive, trailing punctuation, spaced / undotted N.I.C.
  ["negation", "carpet by others", undefined, ["09 68 00@1.000 term [0-0] by_others"], []],
  ["negation", "Door Hardware by Others", undefined, ["08 71 00@1.000 title [0-1] by_others"], []],
  ["negation", "CARPET BY OTHERS.", undefined, ["09 68 00@1.000 term [0-0] by_others"], []],
  ["negation", "DOOR HARDWARE BY OTHERS;", undefined, ["08 71 00@1.000 title [0-1] by_others"], []],
  ["negation", "CARPET N. I. C.", undefined, ["09 68 00@1.000 term [0-0] by_others"], []],
  ["negation", "CARPET N I C", undefined, ["09 68 00@1.000 term [0-0] by_others"], []],
  ["negation", "CARPET, N.I.C.", undefined, ["09 68 00@1.000 term [0-0] by_others"], []],
  ["negation", "CARPET - BY OTHERS", undefined, ["09 68 00@1.000 term [0-0] by_others"], []],
  // fix2: by_others whatever ownership step decided — family, discipline, term-discipline (J8)
  ["negation+owner", "METALLIC NON-SHRINK GROUTING BY OTHERS", undefined, ["03 62 00@0.900 title [0-3] family by_others"], []],
  ["negation+owner", "TILT-UP PRECAST CONCRETE N.I.C.", undefined, ["03 40 00@0.900 index [0-3] family by_others"], []],
  ["negation+owner", "BALL VALVE BY OTHERS", "P", ["22 05 23@1.000 term [0-1] by_others"], []],
  ["negation+owner", "BALL VALVE N.I.C.", "M", ["23 05 23@1.000 term [0-1] by_others"], []],
  ["negation+owner", "DISCONNECT SWITCH WALL BASE", undefined, ["26 28 16@1.000 term [0-1]"], []],
  ["negation+owner", "DISCONNECT SWITCH WALL BASE BY OTHERS", undefined, ["26 28 16@1.000 term [0-1] by_others"], []],
  ["negation+owner", "DISCONNECT SWITCH WALL BASE", "E", ["26 20 00@0.900 term [0-2] family"], []],
  ["negation+owner", "DISCONNECT SWITCH WALL BASE BY OTHERS", "E", ["26 20 00@0.900 term [0-2] family by_others"], []],
  ["negation", "N.I.C.", undefined, [], []],
  ["negation", {"header":"CARPET","text":"N.I.C."}, undefined, ["09 68 00@1.000 term [0-0] by_others"], []],
  ["negation", {"header":"WALL BASE","text":"N.I.C."}, undefined, ["09 65 13@1.000 term [0-1] by_others"], []],
  // ── E4 amended
  ["E4 amended", "PRELIMINARY CONSTRUCTION SCHEDULE", undefined, ["00 31 13.16@1.000 title [0-2]"], []],
  ["E4 amended", "BAMBOO FLOORING", undefined, ["09 64 36@1.000 title [0-1]"], []],
  // ── E9 cells
  ["E9 cells", {"header":"DOOR MATERIAL","text":"HM"}, undefined, ["08 13 13@0.850 term [0-2]"], []],
  ["E9 cells", {"header":"FRAME MATERIAL","text":"HM"}, undefined, ["08 12 13@0.850 term [0-2]"], []],
  ["E9 cells", {"header":"FINISH:","text":"GWB"}, undefined, ["09 29 00@1.000 term [1-1]"], ["09 00 00"]],
  ["E9 cells", {"header":"FINISH:","text":"GYP BD"}, undefined, ["09 29 00@1.000 term [1-2]"], ["09 00 00"]],
  ["E9 cells", {"title":"DOOR SCHEDULE","header":"MATERIAL","text":"HM"}, undefined, ["08 06 10@1.000 title [0-1]"], []],
  // ── E7 regex
  ["E7 regex", "R-19 BATT INSULATION", undefined, ["07 21 16@1.000 term [0-1]"], []],
  ["E7 regex", "R-30 INSUL", undefined, ["07 21 00@1.000 term [0-0]"], []],
  ["E7 regex", "R-13 INSULATION", undefined, ["07 21 00@1.000 term [0-0]"], []],
  ["E7 regex", "P-LAM", undefined, ["06 41 00@1.000 term [0-0]"], []],
  ["E7 regex", "P-LAM COUNTERTOP", undefined, ["06 41 00@1.000 term [0-0]"], ["12 00 00"]],
  // ── ACT
  ["ACT", "ACT", undefined, ["09 51 00@1.000 term [0-0]"], []],
  ["ACT", "ACT LAY-IN", undefined, ["09 51 13@1.000 term [0-1]"], []],
  ["ACT", "ACT 2x4 LAY-IN", undefined, ["09 51 13@0.850 term [0-2]"], []],
  // S5 d3 (csi_terms ACT oneWordOk `<=4`): the one-word ACT row needs a unit of <= 4 tokens — 4 owns, 5 does not
  ["ACT", "ACT ABOVE OFFICE CORRIDOR", undefined, ["09 51 00@1.000 term [0-0]"], []],
  ["ACT", "ACT ABOVE OFFICE CORRIDOR LOBBY", undefined, [], []],
  ["ACT", "OWNER MAY ACT ON BEHALF OF TENANT REPRESENTATIVE", undefined, [], []],
  // ── two ranges
  ["two ranges", "PTD GWB", undefined, ["09 91 00@1.000 term [0-0]","09 29 00@1.000 term [1-1]"], []],
  ["two ranges", "HOLLOW METAL DOOR GYPSUM BOARD", undefined, ["08 13 13@1.000 title [0-2]","09 29 00@1.000 title [3-4]"], []],
  // ── family
  ["family", "METALLIC NON-SHRINK GROUTING", undefined, ["03 62 00@0.900 title [0-3] family"], []],
  ["family", "TILT-UP PRECAST CONCRETE", undefined, ["03 40 00@0.900 index [0-3] family"], []],
  // ── no owner
  ["no owner", "PLASTIC LAMINATE", undefined, [], ["06 00 00","12 00 00"]],
  // ── J1 subset
  ["J1 subset", "MAINTENANCE OF CAST-IN-PLACE CONCRETE", undefined, ["03 01 30@1.000 title [0-3]"], []],
  // ── J3 maxS
  ["J3 maxS", "SPRAY FOAM INSULATION", undefined, ["07 21 19@1.000 term [0-1]"], []],
  // ── J2 guard
  ["J2 guard", "MAINTENANCE OF UNIT MASONRY", undefined, ["04 01 20@1.000 title [0-2]"], []],
  ["J2 guard", "PLASTER AND GYPSUM BOARD", undefined, ["09 20 00@1.000 title [0-2]"], []],
  ["J2 guard", "RESILIENT FLOORING AND BASE", undefined, ["09 65 00@1.000 title [0-1]"], []],
  // ── E13 cost
  ["E13 cost", "PRODUCT REQUIREMENTS", undefined, ["01 60 00@1.000 title [0-1]"], []],
  ["E13 cost", "COMMON PRODUCT REQUIREMENTS", undefined, ["01 61 00@1.000 title [0-2]"], []],
  // fix1: E13 drops an ancestor only ON THE OVERLAPPING RANGE — one in a separate range keeps its own span
  ["E13 overlap", "THERMAL INSULATION; BATT INSULATION", undefined, ["07 21 00@1.000 title [0-1]","07 21 16@1.000 term [2-3]"], []],
  ["E13 overlap", "CONCRETE REINFORCING; PLAIN STEEL REINFORCEMENT BARS", undefined, ["03 20 00@1.000 title [0-1]","03 21 11@1.000 title [2-5]"], []],
  // ── E14
  ["E14", "HEATING, VENTILATING, AND AIR CONDITIONING", undefined, ["23 00 00@1.000 title [0-3]"], []],
  // S5 (kb-v2.5): term row AIR CONDITIONING → 23 00 00; `hvac` is a HINT_STOP_TOKENS word; the lost-letter
  // title 06 17 33 "Wood I-Joists" owns nothing and its {wood, joist} patterns are dropped → 06 11 00 index
  ["E14", "VENTILATING AND AIR CONDITIONING", undefined, ["23 00 00@1.000 term [1-2]"], []],
  ["E14", "AIR CONDITIONING", undefined, ["23 00 00@1.000 term [0-1]"], []],
  ["E14", "HVAC", undefined, [], []],
  ["E14", "WOOD JOISTS", undefined, ["06 11 00@1.000 index [0-1]"], []],
  // ── known misses
  ["known misses", "UNIT PAVERS", undefined, [], []],
  // S5: the INSULATION term row owns INSULATION here — a known WRONG code (pipe insulation is 22 07 19);
  // the S5 sample judged 8 of 40 INSULATION additions W for exactly this, accepted for the net gain
  ["known misses", "PIPE INSULATION", undefined, ["07 21 00@1.000 term [1-1]"], []],
  ["known misses", "GROUNDING AND BONDING", undefined, [], []],
  ["known misses", "CHAIN LINK FENCES", undefined, [], ["05 00 00","32 00 00"]],
  ["known misses", "ELASTOMERIC ROOFING", undefined, [], []],
  ["known misses", "ROOFTOP UNITS", undefined, [], []],
];

describe.skipIf(!HAS_KB)("S3 decided table (design §7.1) — owned spans and hints", () => {
  it.each(TABLE)("%s: %j ctx=%s", (_g, inp, d, own, hints) => {
    const m = matchUnit(unitOf(inp), kb, ctxOf(d));
    expect(m.spans.map(fmt)).toEqual(own);
    expect(m.divisionHints).toEqual(hints);
  });
});

describe.skipIf(!HAS_KB)("S3 trace facts — each rule falsifiable through traceUnit", () => {
  it("4/5 vs 3/5: the 3/5 unit supports nothing; the 4/5 unit kills the 04 20 00 / 04 22 00 subsets (E4)", () => {
    expect(trace("AUTOCLAVED AERATED MASONRY").supported).toEqual([]);
    const t5 = trace("AUTOCLAVED AERATED CONCRETE UNIT MASONRY");
    expect(supCodes(t5.supported)).toEqual(["04 20 00", "04 22 00", "04 22 26"]);
    expect(supCodes(t5.frontier)).toEqual(["04 22 26"]);
    const t4 = trace("AUTOCLAVED AERATED UNIT MASONRY");
    expect(supCodes(t4.supported)).toEqual(["04 20 00", "04 22 26"]);
    expect(supCodes(t4.frontier)).toEqual(["04 22 26"]);
  });

  it("diff mandatory: `steel` is a diff token of 03 21 11 with mass share 0.183 — mass alone (0.817) would pass", () => {
    const p = kb.patterns[kb.byCode.get("03 21 11")?.patternIds.find((id) => kb.patterns[id].source === "title") ?? -1];
    const steel = p.tokens.indexOf("steel");
    expect(p.diff).toContain(steel);
    const total = p.mass.reduce((a, b) => a + b, 0);
    expect((p.mass[steel] / total).toFixed(3)).toBe("0.183");
    expect(supCodes(trace("PLAIN REINFORCEMENT BARS").supported)).toEqual(["03 21 00"]);
    // present in the unit but outside the anchor's segment: still missing for E2 (fix1)
    expect(supCodes(trace("STEEL: PLAIN REINFORCEMENT BARS").supported)).toEqual(["03 21 00"]);
    expect(supCodes(trace("PLAIN REINFORCEMENT BARS; STEEL").supported)).toEqual(["03 21 00"]);
  });

  it("diff mandatory (fix2): the per-placement check binds slots LEFT of the anchor, and index patterns too", () => {
    const pat = (code: string, text: string) => kb.patterns[kb.byCode.get(code)?.patternIds.find((id) => kb.patterns[id].text === text) ?? -1];
    const drum = pat("00 31 26.36", "Existing Hazardous Waste Drum Information");
    expect([drum.source, drum.anchor, drum.diff.includes(drum.tokens.indexOf("existing")), drum.tokens.indexOf("existing")]).toEqual(["title", 3, true, 0]);
    const soil = pat("00 31 32", "soil boring, available information, data");
    expect([soil.source, soil.anchor, soil.diff.includes(soil.tokens.indexOf("soil")), soil.tokens.indexOf("soil")]).toEqual(["index", 1, true, 0]);
    expect(trace("EXISTING: HAZARDOUS WASTE DRUM INFORMATION").supported).toEqual([]);
    expect(supCodes(trace("SOIL: BORING AVAILABLE INFORMATION DATA").supported)).toEqual(["00 30 00"]);
  });

  it("diff mandatory (fix3): a missing diff token is fatal even at <= 0.15 of the mass, left or right of the anchor, title or index", () => {
    const pat = (code: string, text: string) => kb.patterns[kb.byCode.get(code)?.patternIds.find((id) => kb.patterns[id].text === text) ?? -1];
    const share = (code: string, text: string, tok: string) => {
      const p = pat(code, text);
      const i = p.tokens.indexOf(tok);
      const total = p.mass.reduce((a, b) => a + b, 0);
      return [p.source, i, p.anchor, p.diff.includes(i), (p.mass[i] / total).toFixed(3), 1 - p.mass[i] / total >= 0.85];
    };
    // [source, diff slot, anchor slot, is diff, share, rest of the pattern >= 0.85 of the mass] — all MEASURED (kb-v2.5;
    // 02 83 13 was 0.126 at kb-v2.4: S5 changed N 8,933 → 8,930 and a few codeDFs, so every IDF moved slightly)
    expect(share("09 05 61.13", "Moisture Vapor Emission Control", "control")).toEqual(["title", 3, 2, true, "0.132", true]);
    expect(share("33 05 19", "ductile-iron utility, piping", "pipe")).toEqual(["index", 3, 0, true, "0.145", true]);
    expect(share("02 83 13", "Lead Hazard Control Activities", "control")).toEqual(["title", 2, 3, true, "0.127", true]);
    expect(share("23 83 16", "hot water, baseboard radiation", "water")).toEqual(["index", 1, 2, true, "0.140", true]);
    // omitted (the presence prefilter), behind a boundary and beyond the radius (the per-placement check):
    // NOTHING of these codes is supported, though the matched rest would score 0.868 / 0.855 / 0.874 / 0.860
    for (const t of ["MOISTURE VAPOR EMISSION", "MOISTURE VAPOR EMISSION; CONTROL", "MOISTURE VAPOR EMISSION QQQ QQQ QQQ QQQ QQQ CONTROL",
      "DUCTILE IRON UTILITY", "DUCTILE IRON UTILITY; PIPING", "LEAD HAZARD ACTIVITIES", "CONTROL: LEAD HAZARD ACTIVITIES"]) {
      expect(trace(t).supported.map(fmtSup)).toEqual([]);
    }
    expect(trace("HOT BASEBOARD RADIATION").supported.map(fmtSup)).toEqual(["23 83 00@1.000 index [1-2]"]);
    expect(trace("WATER: HOT BASEBOARD RADIATION").supported.map(fmtSup)).toEqual(["23 83 00@1.000 index [2-3]"]);
  });

  it("tie-break (fix3): equidistant occurrences resolve by printed order — a slot right of the anchor takes the right one, a slot left of it the left one", () => {
    const pat = (code: string, text: string) => kb.patterns[kb.byCode.get(code)?.patternIds.find((id) => kb.patterns[id].text === text) ?? -1];
    // [source, anchor slot, slot of the repeated token]
    const facts = (code: string, text: string, tok: string) => { const p = pat(code, text); return [p.source, p.anchor, p.tokens.indexOf(tok)]; };
    expect(facts("07 21 00", "Thermal Insulation", "insulate")).toEqual(["title", 0, 1]);
    expect(facts("07 01 50.81", "Roof Replacement", "roof")).toEqual(["title", 1, 0]);
    expect(facts("03 05 00", "accelerators, concrete", "concrete")).toEqual(["index", 0, 1]);
    expect(facts("03 05 00", "concrete, admixtures", "concrete")).toEqual(["index", 1, 0]);
    // strict order: the wrong pick is out of order, [0-1] @0.700 / [1-2] @0.700 (S5); order-free: the span moves.
    // S5: the INSULATION term row (oneWordOk) adds its own one-word spans on both INSULATION tokens
    expect(trace("INSULATION THERMAL INSULATION").supported.map(fmtSup)).toEqual([
      "07 21 00@1.000 term [0-0]", "07 21 00@1.000 term [2-2]", "07 21 00@1.000 title [1-2]",
    ]);
    expect(trace("ROOF REPLACEMENT ROOF").supported.map(fmtSup)).toEqual(["07 01 50.81@1.000 title [0-1]"]);
    expect(trace("CONCRETE ACCELERATOR CONCRETE").supported.map(fmtSup)).toEqual(["03 05 00@1.000 index [1-2]"]);
    expect(trace("CONCRETE ADMIXTURE CONCRETE").supported.map(fmtSup)).toEqual(["03 05 00@1.000 index [0-1]"]);
  });

  it("window: a 5-wide CONCRETE … SCHEDULE span (= n + 2) is supported, 6- (n + 3) and 7-wide ones are not; GYPSUM QQQ ZZZ XXX BOARD is a legal weak span (J12)", () => {
    const ok = trace("CONCRETE QQQ FOOTING ZZZ SCHEDULE");
    expect(ok.supported.map(fmtSup)).toEqual(["03 06 30.13@0.850 title [0-4]"]);
    expect(trace("CONCRETE QQQ ZZZ FOOTING XXX WWW SCHEDULE").supported).toEqual([]);
    // fix1: n + 3 is already out (every token within the ±(n+1) radius, so only the gate decides)
    expect(trace("CONCRETE QQQ ZZZ FOOTING XXX SCHEDULE").supported).toEqual([]);
    // S5: STEEL after BARS is out of printed order → OUT_OF_ORDER_FACTOR 0.7 (was 0.85)
    expect(trace("PLAIN REINFORCEMENT BARS QQQ ZZZ STEEL").supported.map(fmtSup)).toContain("03 21 11@0.700 title [0-5]");
    expect(supCodes(trace("PLAIN REINFORCEMENT BARS QQQ ZZZ XXX STEEL").supported)).toEqual(["03 21 00"]);
    // fix2, the radius alone: SCHEDULE at n+1 from the BOUND pivot is placed (then the gate rejects), at n+2 it is not
    expect(trace("SEPARATELY BOUND LIST QQQ QQQ QQQ SCHEDULE").supported).toEqual([]);
    expect(trace("SEPARATELY BOUND LIST QQQ QQQ QQQ QQQ SCHEDULE").supported.map(fmtSup)).toEqual(["00 01 20@0.872 index [0-2]"]);
    // 09 21 16 "Gypsum Board Assemblies" (3 tokens) reaches 0.707 inside its len+2 = 5 window; S4's s >= 0.8 gate removes it.
    expect(trace("GYPSUM QQQ ZZZ XXX BOARD").supported.map(fmtSup)).toEqual([
      "09 21 16@0.707 title [0-4]", "09 21 16@0.707 index [0-4]", "09 29 00@0.692 index [0-4]",
    ]);
  });

  it("punctuation: `[.;:(]` between the words is a boundary — nothing is supported across it", () => {
    for (const t of ["GYPSUM. BOARD", "GYPSUM; BOARD", "GYPSUM: BOARD", "GYPSUM (BOARD)"]) expect(trace(t).supported).toEqual([]);
    expect(unitFromText("GYP. BD.", kb).tokens.map((x) => !!x.boundaryBefore)).toEqual([false, false]);
    // fix1, segment search (E5 deviation): the token beyond the boundary is not found, the rest supports
    expect(trace("CONCRETE: AUTOCLAVED AERATED UNIT MASONRY").supported.map(fmtSup)).toEqual([
      "04 22 26@0.884 title [1-4]", "04 20 00@1.000 title [3-4]", "04 20 00@1.000 index [3-4]",
    ]);
  });

  it("order (J10): GYPSUM BOARD supports 09 21 16 at 0.831 and E4 drops it; BOARD GYPSUM's strict-order title is 0.7 (S5 OUT_OF_ORDER_FACTOR), the order-free index wins", () => {
    const g = trace("GYPSUM BOARD");
    expect(g.supported.map(fmtSup)).toContain("09 21 16@0.831 title [0-1]");
    expect(supCodes(g.frontier)).toEqual(["09 29 00"]);
    const b = trace("BOARD GYPSUM");
    expect(b.supported.map(fmtSup)).toContain("09 29 00@0.700 title [0-1]");
    expect(b.supported.map(fmtSup)).toContain("09 29 00@1.000 index [0-1]");
    expect(trace("GYPSUM WALL BOARD").supported.map(fmtSup)).toContain("09 29 00@0.850 title [0-2]");
  });

  it("one-word (J5): OFFICE supports nothing (a multi-token pattern matched by one token is dropped, no hint)", () => {
    for (const t of ["OFFICE", "KITCHEN", "SECURITY", "OTHERS", "FINISH"]) expect(trace(t).supported).toEqual([]);
  });

  it("WOOD DOORS is an anchor pattern (anchor = door), not generic; FIRE ALARM SYSTEM has one owner because 28 46 20 is not in the KB", () => {
    const p = kb.patterns[kb.byCode.get("08 14 00")?.patternIds.find((id) => kb.patterns[id].source === "title") ?? -1];
    expect(p.tokens).toEqual(["wood", "door"]);
    expect(p.anchor).toBe(1);
    expect(p.diff.map((i) => p.tokens[i]).sort()).toEqual(["door", "wood"]);
    expect(kb.byCode.has("28 46 20")).toBe(false);
    expect(matchUnit(unitFromText("FIRE ALARM SYSTEM", kb), kb).spans).toHaveLength(1);
  });

  it("term rows: RIGID INSULATION ties a see pattern at 1.0 and the source rank decides; SPRINKLER SYSTEM's one-word row [0-0] loses on width", () => {
    expect(trace("RIGID INSULATION").survivors.map(fmtSup)).toEqual(["07 21 13@1.000 see [0-1]", "07 21 13@1.000 term [0-1]"]);
    expect(trace("SPRINKLER SYSTEM").survivors.map(fmtSup)).toEqual(["21 13 00@1.000 term [0-0]", "21 13 00@1.000 term [0-1]"]);
  });

  it("cross-division: the range rule names the step that decided", () => {
    expect(trace("BALL VALVE", "P").ranges.map((r) => r.rule)).toEqual(["discipline"]);
    expect(trace("BALL VALVE", "M").ranges.map((r) => r.rule)).toEqual(["discipline"]);
    expect(trace("BALL VALVE").ranges.map((r) => r.rule)).toEqual(["none"]);
    expect(trace("SEWAGE PUMP").ranges.map((r) => r.rule)).toEqual(["single"]);
    expect(trace("METALLIC NON-SHRINK GROUTING").ranges.map((r) => r.rule)).toEqual(["family"]);
  });

  it("negation (J6): the negated flag, the marker offset, and masking", () => {
    const t = trace("DOOR HARDWARE BY OTHERS");
    expect(t.negated).toBe(true);
    expect(t.negFrom).toBe("DOOR HARDWARE ".length);
    expect(trace("DOOR HARDWARE").negated).toBe(false);
    expect(trace("DOOR HARDWARE").negFrom).toBe(-1);
    for (const s of ["CLINIC CARPET", "PANIC HARDWARE", "CARPET BY OTHERS UNLESS NOTED", "CARPET CLINIC", "DOOR HARDWARE PANIC", "CARPET ELECTRONIC"]) expect(NEGATION_TAIL_RE.test(s), s).toBe(false);
    expect(trace("CARPET CLINIC").negated).toBe(false);
    // every owned span of a negated unit carries scope by_others (fix1)
    const two = trace("PTD GWB BY OTHERS");
    expect(two.spans).toHaveLength(2);
    expect(two.spans.map((x) => x.scope)).toEqual(["by_others", "by_others"]);
    for (const s of ["CARPET (N.I.C.)", "CARPET N.I.C.", "CARPET NIC", "CARPET BY OWNER", "CARPET NOT IN CONTRACT", "N.I.C.",
      "carpet by others", "Door Hardware by Others", "CARPET BY OTHERS.", "DOOR HARDWARE BY OTHERS;", "CARPET N. I. C.", "CARPET N I C"]) expect(NEGATION_TAIL_RE.test(s), s).toBe(true);
    // fix2: scope is set whichever §6.5 step owned the range
    for (const [s, d, rule] of [["METALLIC NON-SHRINK GROUTING BY OTHERS", undefined, "family"], ["BALL VALVE BY OTHERS", "P", "discipline"],
      ["DISCONNECT SWITCH WALL BASE BY OTHERS", undefined, "termDiscipline"], ["DISCONNECT SWITCH WALL BASE BY OTHERS", "E", "discipline"]] as const) {
      const tr = trace(s, d);
      expect(tr.ranges.map((r) => r.rule), s).toEqual([rule]);
      expect(tr.spans.map((x) => x.scope), s).toEqual(["by_others"]);
    }
    // masked: `equipment` before the marker is a hint, `others` after it never reaches a pattern
    const e = trace("EQUIPMENT BY OTHERS");
    expect(e.negated).toBe(true);
    expect(e.supported).toEqual([]);
  });

  it("E4 amended / E13: PRELIMINARY CONSTRUCTION SCHEDULE — 00 62 00 and 01 32 16 die in E4, 00 31 13's surviving index span dies in E13", () => {
    const t = trace("PRELIMINARY CONSTRUCTION SCHEDULE");
    expect(t.supported.map(fmtSup)).toEqual([
      "00 31 13@0.850 title [0-2]", "00 31 13@0.693 index [0-2]", "00 31 13.16@1.000 title [0-2]", "00 62 00@1.000 alt [1-2]", "01 32 16@1.000 index [1-2]",
    ]);
    expect(t.frontier.map(fmtSup)).toEqual(["00 31 13@0.693 index [0-2]", "00 31 13.16@1.000 title [0-2]"]);
    expect(t.survivors.map(fmtSup)).toEqual(["00 31 13.16@1.000 title [0-2]"]);
  });

  it("E9 cells: the join boundary is cleared; the HM one-word row is killed by E4 under the order-free `HM DOOR` row", () => {
    const u = unitFromCell({ header: "FINISH:", text: "GWB" }, kb);
    expect(u.kind).toBe("cell");
    expect(u.text).toBe("FINISH: GWB");
    expect(u.tokens.map((x) => !!x.boundaryBefore)).toEqual([false, false]);
    expect(unitFromText("FINISH: GWB", kb).tokens.map((x) => !!x.boundaryBefore)).toEqual([false, true]);
    const t = trace({ header: "DOOR MATERIAL", text: "HM" });
    expect(t.supported.map(fmtSup)).toEqual(["08 11 13@1.000 term [2-2]", "08 13 13@0.850 term [0-2]"]);
    expect(t.frontier.map(fmtSup)).toEqual(["08 13 13@0.850 term [0-2]"]);
  });

  it("E7 regex: the R-value regex 07 21 00 is supported on R-19 BATT INSULATION and dropped by E13 (07 21 16 descends from it)", () => {
    const t = trace("R-19 BATT INSULATION");
    expect(t.supported.map(fmtSup)).toContain("07 21 00@1.000 term(regex) [0-1]");
    expect(supCodes(t.survivors)).toEqual(["07 21 16"]);
  });

  it("E13 overlap (fix1): an ancestor in a SEPARATE range survives beside its descendant", () => {
    // S5: the INSULATION term row's [1-1] span survives beside the title; its [3-3] span dies to 07 21 16 (E13)
    expect(trace("THERMAL INSULATION; BATT INSULATION").survivors.map(fmtSup)).toEqual([
      "07 21 00@1.000 title [0-1]", "07 21 00@1.000 term [1-1]", "07 21 16@1.000 see [2-3]", "07 21 16@1.000 term [2-3]",
    ]);
    expect(supCodes(trace("CONCRETE REINFORCING; PLAIN STEEL REINFORCEMENT BARS").survivors)).toEqual(["03 20 00", "03 21 11"]);
  });

  it("family (E11): s is exactly 0.9 × the best member's s, familyOf lists the member codes, patternId is the best member's (J17)", () => {
    const t = trace("METALLIC NON-SHRINK GROUTING");
    const [w] = t.spans;
    expect(w.familyOf).toEqual(["03 62 13", "03 62 16"]);
    const bestMember = Math.max(...t.ranges[0].top.map((s) => s.s));
    expect(w.s).toBe(bestMember * FAMILY_DISCOUNT);
    expect(kb.patterns[w.patternId].code).not.toBe(w.code);
    expect(w.familyOf).toContain(kb.patterns[w.patternId].code);
    expect(trace("TILT-UP PRECAST CONCRETE").spans[0].familyOf).toEqual(["03 45 13", "03 47 13"]);
  });

  it("no owner: PLASTIC LAMINATE has three alt spans at 1.0 with no common ancestor", () => {
    const t = trace("PLASTIC LAMINATE");
    expect(t.survivors.map(fmtSup)).toEqual(["06 41 00@1.000 alt [0-1]", "12 32 00@1.000 alt [0-1]", "12 36 00@1.000 alt [0-1]"]);
    expect(t.ranges.map((r) => [r.rule, r.owner])).toEqual([["none", null]]);
  });

  it("J1 subset dominance: MAINTENANCE OF CAST-IN-PLACE CONCRETE leaves only 03 01 30 in the frontier", () => {
    expect(supCodes(trace("MAINTENANCE OF CAST-IN-PLACE CONCRETE").frontier)).toEqual(["03 01 30"]);
  });

  it("J3 maxS: on SPRAY FOAM INSULATION only the 1.0 term span competes (three 0.85 spans of 07/09 also survive)", () => {
    const t = trace("SPRAY FOAM INSULATION");
    expect(t.survivors.map(fmtSup)).toEqual(["07 21 29@0.850 index [0-2]", "09 81 00@0.850 alt [0-2]", "07 21 19@1.000 term [0-1]"]);
    expect(t.ranges[0].top.map(fmtSup)).toEqual(["07 21 19@1.000 term [0-1]"]);
  });

  it("J2 E13 guard: 04 01 20.51 at 0.7 (S5: out of printed order) survives (it is not >= 04 01 20's 1.0) but does not own", () => {
    const t = trace("MAINTENANCE OF UNIT MASONRY");
    expect(t.survivors.map(fmtSup)).toEqual(["04 01 20@1.000 title [0-2]", "04 01 20.51@0.700 title [0-2]"]);
    expect(codesOf(t.spans)).toEqual(["04 01 20"]);
  });

  it("E13 cost (accepted): E4, not E13, decides COMMON PRODUCT REQUIREMENTS", () => {
    const t = trace("COMMON PRODUCT REQUIREMENTS");
    expect(supCodes(t.supported)).toEqual(["01 60 00", "01 61 00"]);
    expect(supCodes(t.frontier)).toEqual(["01 61 00"]);
  });

  it("E14 (J14, S3 known misses fixed by S5 data): VENTILATING AND AIR CONDITIONING → the 23 00 00 term row; WOOD JOISTS → 06 11 00", () => {
    // kb-v2.4: the first supported nothing and the second went to 06 17 33 (lost-letter title "Wood I-Joists")
    expect(trace("VENTILATING AND AIR CONDITIONING").supported.map(fmtSup)).toEqual(["23 00 00@1.000 term [1-2]"]);
    expect(codesOf(trace("WOOD JOISTS").spans)).toEqual(["06 11 00"]);
  });
});

describe.skipIf(!HAS_KB)("S3 unit builders", () => {
  it("csiTokenizeForKb folds with the KB vocab and keeps known-abbreviation dots", () => {
    expect(csiTokenizeForKb("GYP. BD.", kb).map((t) => t.t)).toEqual(["gyp", "bd"]);
    expect(csiTokenizeForKb("PAINTING", kb).map((t) => t.t)).toEqual(["paint"]);
  });

  it("unitFromText / unitsFromText / unitFromWords", () => {
    const u = unitFromText("WOOD DOORS", kb, { kind: "line", lineIndex: 3 });
    expect([u.kind, u.lineIndex]).toEqual(["line", 3]);
    expect(unitFromText("WOOD DOORS", kb).kind).toBe("text");
    expect(unitsFromText("WOOD DOORS\nGYPSUM BOARD", kb).map((x) => x.text)).toEqual(["WOOD DOORS", "GYPSUM BOARD"]);
    const w = unitFromWords([{ text: "HOLLOW", bbox: [0, 0, 1, 1] }, { text: "METAL-DOORS", bbox: [1, 0, 1, 1] }], kb, 7);
    expect(w.text).toBe("HOLLOW METAL-DOORS");
    expect(w.tokens.map((t) => [t.t, t.bbox?.[0]])).toEqual([["hollow", 0], ["metal", 1], ["door", 1]]);
    expect(matchUnit(w, kb).spans.map(fmt)).toEqual(["08 13 13@1.000 title [0-2]"]);
  });

  it("an empty unit yields nothing", () => {
    expect(matchUnit(unitFromText("", kb), kb)).toEqual({ spans: [], divisionHints: [] });
    expect(matchUnit(unitFromText("12 34 -- ##", kb), kb)).toEqual({ spans: [], divisionHints: [] });
  });
});

/** E13 variants composed from the exported passes, for the pinned comparison (the matcher has no knobs). */
function ownedUnderPlainE13(t: MatchTrace): string[] {
  const fr = t.frontier;
  const surv = fr.filter((x) => !fr.some((y) => y !== x && y.codeIdx !== x.codeIdx && x.lo <= y.hi && y.lo <= x.hi && isAncestorIdx(prep, x.codeIdx, y.codeIdx)));
  return codesOf(ownRanges(prep, groupRanges(surv), undefined, new Set()).flatMap((r) => (r.owner ? [r.owner] : [])));
}

describe.skipIf(!HAS_KB)("S3 invariants + self-retrieval over ALL multi-token titles (design §7.2; superset of §II's 200)", () => {
  it("0 violations on every unit; owned exact / present / empty pinned EXACTLY (measured 8,442 / 8,442 / 91)", () => {
    const titles = kb.patterns.filter((p) => p.source === "title" && p.kind === "tokens" && p.tokens.length >= 2);
    expect(titles).toHaveLength(8625); // kb-v2.5: S5 dropped 5 titles (3 lost-letter: 06 17 33, 12 24 16.13, 31 62 16.16; 28 40 00; 33 82 63.16); 8,630 at kb-v2.4
    let exact = 0, present = 0, empty = 0;
    const bad: string[] = [];
    for (const p of titles) {
      const u = unitFromText(p.text, kb);
      const t = traceUnit(u, kb);
      const sp = t.spans;
      const oc = codesOf(sp);
      if (oc.length === 1 && oc[0] === p.code) exact++;
      if (oc.includes(p.code)) present++;
      if (!sp.length) empty++;
      if (sp.length > t.ranges.length) bad.push(`owned>ranges: ${p.code}`);
      for (let i = 0; i < sp.length; i++) {
        if (!(sp[i].s > 0 && sp[i].s <= 1)) bad.push(`s out of range: ${p.code}`);
        if (i > 0 && (sp[i - 1].tokenStart > sp[i].tokenStart || (sp[i - 1].tokenStart === sp[i].tokenStart && sp[i - 1].tokenEnd > sp[i].tokenEnd))) bad.push(`unsorted: ${p.code}`);
        for (let j = i + 1; j < sp.length; j++) if (sp[i].tokenStart <= sp[j].tokenEnd && sp[j].tokenStart <= sp[i].tokenEnd) bad.push(`owned overlap: ${p.code}`);
      }
      for (const r of t.ranges) if (r.owner?.familyOf) {
        const b = Math.max(...r.top.filter((m) => r.owner?.familyOf?.includes(prep.codes[m.codeIdx])).map((m) => m.s));
        if (r.owner.s !== b * FAMILY_DISCOUNT) bad.push(`family s: ${p.code}`);
      }
      for (const x of t.survivors) for (const y of t.survivors) {
        if (x !== y && x.lo <= y.hi && y.lo <= x.hi && isAncestorIdx(prep, x.codeIdx, y.codeIdx) && y.s >= x.s - 1e-9) bad.push(`ancestor beside descendant: ${p.code}`);
      }
      for (const s of t.supported) {
        if (s.isRegex) continue;
        for (let k = s.lo + 1; k <= s.hi; k++) if (u.tokens[k].boundaryBefore) bad.push(`boundary inside span: ${p.code}`);
      }
    }
    expect(bad).toEqual([]);
    console.log(`[csi-span-match] titles n=${titles.length}: owned exact ${exact} · present ${present} · empty ${empty}`);
    // fix2: exact, not floors — a one-sided floor let behaviour changes that moved the metric the
    // "good" way (8,447 / 8,447 / 90) pass; any change to these must be re-measured and re-pinned.
    // S5 (kb-v2.5): 8,446 / 8,446 / 91 → 8,442 / 8,442 / 91 (span-measure "ALL E13=guard", log s5t-20261021T0640Z)
    expect([exact, present, empty]).toEqual([8442, 8442, 91]);
  }, 60_000);

  it("E13 descendant rule on the 400-title stride sample: guard 393 exact / 1 empty, plain 391 (measured kb-v2.5; J2 keeps the guard)", () => {
    const titles = kb.patterns.filter((p) => p.source === "title" && p.kind === "tokens" && p.tokens.length >= 2);
    const step = Math.floor(titles.length / 400);
    const s400 = titles.filter((_, i) => i % step === 0).slice(0, 400);
    let guardExact = 0, guardEmpty = 0, plainExact = 0;
    for (const p of s400) {
      const t = traceUnit(unitFromText(p.text, kb), kb);
      const oc = codesOf(t.spans);
      if (oc.length === 1 && oc[0] === p.code) guardExact++;
      if (!oc.length) guardEmpty++;
      const pl = ownedUnderPlainE13(t);
      if (pl.length === 1 && pl[0] === p.code) plainExact++;
    }
    // S5 (kb-v2.5): kb-v2.4 measured 392 / 2 and plain 390; the stride sample shifted with the 5 dropped titles
    expect([s400.length, guardExact, guardEmpty]).toEqual([400, 393, 1]);
    // plain E13 (no s guard), same ownership: 391 measured (span-measure "S400 E13=plain", log s5t-20261021T0640Z)
    expect(plainExact).toBe(391);
  }, 30_000);
});

describe.skipIf(!HAS_KB)("S3 index self-test (design §7.3; page gates off)", () => {
  it("every multi-token index phrase fed back owns its code, an ancestor, or a family containing it — 9,769 / 9,850 pinned exactly", () => {
    const pats = kb.patterns.filter((p) => p.source === "index" && p.kind === "tokens" && p.tokens.length >= 2);
    expect(pats).toHaveLength(9850); // kb-v2.5 (S5 drops; 9,852 at kb-v2.4)
    let own = 0, anc = 0, fam = 0, empty = 0, other = 0;
    for (const p of pats) {
      const sp = matchUnit(unitFromText(p.text, kb), kb).spans;
      const cs = codesOf(sp);
      if (cs.includes(p.code)) own++;
      else if (cs.some((x) => isAnc(x, p.code))) anc++;
      else if (sp.some((w) => w.familyOf?.includes(p.code))) fam++;
      else if (!cs.length) empty++;
      else other++;
    }
    const pass = own + anc + fam;
    console.log(`[csi-span-match] index self-test n=${pats.length}: PASS ${pass} (own ${own} · ancestor ${anc} · familyOf ${fam}) · other ${other} · empty ${empty}`);
    expect(pass).toBeGreaterThanOrEqual(9769);
    // fix2: the breakdown is pinned exactly too (measured), so a shift between buckets fails
    // S5 (kb-v2.5, span-measure M2 "index", log s5t-20261021T0640Z): own 9,741 → 9,739, the rest unchanged
    expect([own, anc, fam, other, empty]).toEqual([9739, 30, 0, 16, 65]);
  }, 60_000);
});

interface Probe {
  text: string; expect: string[]; acceptAncestor?: boolean; hints?: string[];
  ctx?: { discipline: string }; cell?: { header?: string; title?: string }; scope?: 'by_others'; knownMiss?: boolean; note?: string;
}
const PROBES: Probe[] = JSON.parse(readFileSync(join(root, "src/lib/__tests__/fixtures/csi-v2/probe-set.json"), "utf-8")) as Probe[];

function probePasses(r: Probe): boolean {
  const u = r.cell ? unitFromCell({ text: r.text, ...r.cell }, kb) : unitFromText(r.text, kb);
  const m = matchUnit(u, kb, r.ctx);
  const owned = codesOf(m.spans);
  const rel = (e: string, o: string) => e === o || isAnc(o, e) || isAnc(e, o) || m.spans.some((s) => s.code === o && !!s.familyOf?.includes(e));
  let ok = r.acceptAncestor
    ? r.expect.every((e) => owned.some((o) => rel(e, o))) && owned.every((o) => r.expect.some((e) => rel(e, o)))
    : owned.join() === [...r.expect].sort().join();
  if (r.hints && !r.hints.every((h) => m.divisionHints.some((d) => d.startsWith(h)))) ok = false;
  if (r.scope ? !(m.spans.length > 0 && m.spans.every((s) => s.scope === r.scope)) : m.spans.some((s) => s.scope)) ok = false;
  return ok;
}

describe.skipIf(!HAS_KB)("S3 probe set (fixtures/csi-v2/probe-set.json; generic trade phrases only)", () => {
  it("is well-formed: known codes, 2-digit hint prefixes, no duplicate rows", () => {
    const keys = new Set<string>();
    for (const r of PROBES) {
      for (const c of r.expect) expect(kb.byCode.has(c), c).toBe(true);
      for (const h of r.hints ?? []) expect(h).toMatch(/^\d\d$/);
      const k = JSON.stringify([r.text, r.ctx ?? null, r.cell ?? null]);
      expect(keys.has(k), k).toBe(false);
      keys.add(k);
    }
    expect(PROBES.length).toBe(150);
  });

  it("every non-knownMiss row passes and the pass rate is >= 90% (measured 143/143; 7 knownMiss rows — S5 cleared 3, flagged HVAC)", () => {
    const live = PROBES.filter((r) => !r.knownMiss);
    const failed = live.filter((r) => !probePasses(r)).map((r) => r.text);
    expect(failed).toEqual([]);
    const pass = live.length - failed.length;
    expect(pass / live.length).toBeGreaterThanOrEqual(0.9);
    const nowPassing = PROBES.filter((r) => r.knownMiss && probePasses(r)).map((r) => r.text);
    if (nowPassing.length) console.warn(`[csi-span-match] knownMiss probe rows now PASS (review and clear the flag): ${nowPassing.join(" | ")}`);
    console.log(`[csi-span-match] probe set: ${pass}/${live.length} non-knownMiss pass; knownMiss ${PROBES.length - live.length} (now passing ${nowPassing.length})`);
  });
});

describe.skipIf(!HAS_KB)("S3 perf (design §6, J18)", () => {
  it("matchUnit p90 <= 5 ms per >= 300-token unit set (60 mid-density sets, best of 3)", () => {
    const titles = kb.patterns.filter((p) => p.source === "title" && p.kind === "tokens" && p.tokens.length >= 2);
    const build = (k: number, dense: boolean): Unit[] => {
      const units: Unit[] = [];
      let toks = 0;
      for (let i = 0; toks < 300; i++) {
        const pick = (j: number) => titles[(k * 977 + (i * 3 + j) * 131) % titles.length].text;
        const text = dense ? `${pick(0)} ${pick(1)} ${pick(2)}` : `${pick(0)} QQQ ZZZ XXX`;
        const u = unitFromText(text, kb);
        units.push(u);
        toks += u.tokens.length;
      }
      return units;
    };
    const timeSets = (sets: Unit[][]): number[] => sets.map((units) => {
      const t0 = performance.now();
      for (const u of units) matchUnit(u, kb);
      return performance.now() - t0;
    }).sort((a, b) => a - b);
    const mid = Array.from({ length: 60 }, (_, k) => build(k, false));
    const dense = Array.from({ length: 60 }, (_, k) => build(k, true));
    for (const s of mid) expect(s.reduce((a, u) => a + u.tokens.length, 0)).toBeGreaterThanOrEqual(300);
    for (let w = 0; w < 3; w++) { timeSets(mid); timeSets(dense); }
    const runs = [timeSets(mid), timeSets(mid), timeSets(mid)];
    const p90s = runs.map((r) => r[54]);
    const best = Math.min(...p90s);
    const denseP90 = timeSets(dense)[54];
    const tokT = mid.map((units) => { const t0 = performance.now(); for (const u of units) csiTokenizeForKb(u.text, kb); return performance.now() - t0; }).sort((a, b) => a - b)[54];
    console.log(`[csi-span-match] perf p90 (ms): mid best ${best.toFixed(2)} (runs ${p90s.map((x) => x.toFixed(2)).join("/")}) · dense ${denseP90.toFixed(2)} (not asserted) · tokenize ${tokT.toFixed(2)} (not asserted)`);
    if (best > 5) console.log(`[csi-span-match] perf distribution (ms): ${runs.map((r) => r.map((x) => x.toFixed(2)).join(",")).join(" | ")}`);
    expect(best).toBeLessThanOrEqual(5);
  }, 60_000);

  it("ONE long unit (an E9 cell can be one) stays linear: <= 50 ms per ~3,000-token unit, best of 5 (fix2)", () => {
    const titles = kb.patterns.filter((p) => p.source === "title" && p.kind === "tokens" && p.tokens.length >= 2);
    const cat: string[] = [];
    for (let i = 0, w = 0; w < 3000; i++) { const t = titles[(977 + i * 131) % titles.length].text; cat.push(t); w += t.split(" ").length; }
    const units: [string, Unit][] = [
      ["BOARD GYPSUM WALL x1000", unitFromCell({ text: Array(1000).fill("BOARD GYPSUM WALL").join(" ") }, kb)],
      ["concatenated titles", unitFromCell({ text: cat.join(" ") }, kb)],
    ];
    for (const [label, u] of units) {
      expect(u.tokens.length, label).toBeGreaterThanOrEqual(2800);
      matchUnit(u, kb);
      const ts: number[] = [];
      for (let r = 0; r < 5; r++) { const t0 = performance.now(); matchUnit(u, kb); ts.push(performance.now() - t0); }
      const b = Math.min(...ts);
      console.log(`[csi-span-match] long unit ${label}: ${u.tokens.length} tokens · best ${b.toFixed(2)} ms (runs ${ts.map((x) => x.toFixed(1)).join("/")})`);
      // pre-fix2 measured 541.78 and 144.88 ms (the all-pairs loops were quadratic); post-fix2 ≈ 11 and 13 ms
      expect(b, label).toBeLessThanOrEqual(50);
    }
  }, 60_000);
});
