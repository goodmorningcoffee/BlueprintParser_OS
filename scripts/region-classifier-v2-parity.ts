#!/usr/bin/env -S npx tsx
/**
 * region-classifier-v2-parity.ts — run the TS region classifier over corpus_v2 pages and compare
 * with the Python reference (`regions_rc.py` / `regions_rc2.py`, as re-implemented and
 * parity-checked in research/regions/extract.py → candidates.jsonl).
 *
 *   npx tsx scripts/region-classifier-v2-parity.ts [--sets 16,19,20] [--all] [--json out.json]
 *     --corpus    corpus_v2 root (default /workspaces/projects/gitignore/corpus_v2)
 *     --research  research/regions dir holding sample.json + candidates.jsonl
 *     --sets      comma-separated set numbers (default: the five sets with most detector tables)
 *     --all       every page of the 300-page research sample
 *
 * Inputs per page: `data/runs/<pid>/pages/page_NNNN.marks.json` (+ `.ytext.json` sidecar) — yolo marks
 * become detections, OCR marks become Textract-shaped words, CSI marks become csiCodes triggers.
 * Textract tables are not in the marks (bundle-only), so `textractTable` is 0 here — it does not
 * enter the L1 keep decision or the L2 class, only the structure score.
 *
 * What is compared, per detector box (matched by anchor bbox, |Δ| < 1e-4):
 *   • L1 keep: Python kept the box (not ≥ 70 % in a detected title_block, not an IoU ≥ .6 duplicate)
 *     vs the TS classifier emitted it. Divergence sources are named (title-block rule, dedupe, labels).
 *   • rc `s` arithmetic: the legacy structure formula recomputed from TS signals (+ din / ct / lined
 *     computed here from the same marks) vs Python `rc_s` — proves the geometry port.
 *   • L2 class: Python `rc_cls` / `rc2_cls` vs TS `className` ("table (unclassified)" and
 *     "schedule (other)" both map to "unclassified"); text boxes also compare the fallback bucket.
 * Projects are reported as "set N"; no OCR text is printed.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BboxMinMax, CsiCode, TextractWord } from "@/types";
import { classifyRegionsV2, type RegionDetection, type RegionV2 } from "@/lib/region-classifier-v2";
import { area, cover, inter, iou } from "@/lib/region-classifier-v2/geometry";

interface Mark {
  channel: string; label: string; bbox: BboxMinMax; center: [number, number]; confidence?: number;
  provenance?: string; text?: string | null; meta?: { modelName?: string; division?: string } | null;
}
interface Ref {
  set: number; page: number; kind: string; bbox: BboxMinMax; tb_share: number; rc_s: number; rc_cls: string;
  rc2_cls: string; rc2_fallback: string | null; rc_kept?: boolean; det_conf: number;
}

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const CORPUS = opt("corpus") ?? "/workspaces/projects/gitignore/corpus_v2";
const RESEARCH = opt("research") ?? "/workspaces/projects/gitignore/projects/master_plan_2026-10-24/research/regions";
const DEFAULT_SETS = [16, 15, 19, 20, 148];
const sets = args.includes("--all") ? null : new Set((opt("sets") ?? DEFAULT_SETS.join(",")).split(",").map(Number));

const modelOf = (m: Mark): string => m.meta?.modelName ?? (m.provenance ?? "").split(":")[0].split(".").pop() ?? "";
const minMaxToLtwh = (b: BboxMinMax): [number, number, number, number] => [b[0], b[1], b[2] - b[0], b[3] - b[1]];
const near = (a: BboxMinMax, b: BboxMinMax) => a.every((v, i) => Math.abs(v - b[i]) < 1e-4);
const normCls = (c: string) => (c === "table (unclassified)" || c === "schedule (other)" || c === "text (unclassified)" ? "unclassified" : c);

const sample = JSON.parse(readFileSync(join(RESEARCH, "sample.json"), "utf8")) as Array<{ pid: string; set: number; page: number; run: string }>;
const refs = new Map<string, Ref[]>();
for (const line of readFileSync(join(RESEARCH, "candidates.jsonl"), "utf8").split("\n")) {
  if (!line) continue;
  const r = JSON.parse(line) as Ref;
  if (!r.kind.startsWith("ymed_")) continue;
  const key = `${r.set}:${r.page}`;
  (refs.get(key) ?? refs.set(key, []).get(key)!).push(r);
}

const tally = {
  pages: 0, boxes: 0,
  tables: { n: 0, keepAgree: 0, pyKept: 0, tsKept: 0, sParity: 0, sCompared: 0, clsCompared: 0, clsAgree: 0, confusion: new Map<string, number>(), divergence: new Map<string, number>() },
  text: { n: 0, pyKept: 0, tsKept: 0, bothKept: 0, clsAgree: 0, named: 0, labelDropped: 0, fallbackAgree: 0, fallbackCompared: 0, divergence: new Map<string, number>() },
  perSet: new Map<number, { pages: number; tables: number; keepAgree: number; clsAgree: number; clsCompared: number }>(),
};
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

for (const s of sample) {
  if (sets && !sets.has(s.set)) continue;
  const base = join(CORPUS, "data", "runs", s.pid, "pages", `page_${String(s.page).padStart(4, "0")}`);
  if (!existsSync(`${base}.marks.json`)) continue;
  let marks = JSON.parse(readFileSync(`${base}.marks.json`, "utf8")) as Mark[];
  if (existsSync(`${base}.ytext.json`)) marks = marks.concat(JSON.parse(readFileSync(`${base}.ytext.json`, "utf8")) as Mark[]);
  const yolo = marks.filter((m) => m.channel === "yolo");
  const detections: RegionDetection[] = yolo.map((m) => ({
    name: m.label, minX: m.bbox[0], minY: m.bbox[1], maxX: m.bbox[2], maxY: m.bbox[3], confidence: m.confidence ?? 0, modelName: modelOf(m),
  }));
  const words: TextractWord[] = marks.filter((m) => m.channel === "ocr").map((m) => ({ text: m.text ?? m.label ?? "", confidence: 99, bbox: minMaxToLtwh(m.bbox) }));
  const csiCodes: CsiCode[] = marks.filter((m) => m.channel === "csi").map((m) => ({
    code: m.label, description: "", trade: "", division: m.meta?.division ?? m.label,
    triggers: [{ text: "", tier: 1 as const, bbox: minMaxToLtwh(m.bbox) }],
  }));
  const out = classifyRegionsV2({ pageNumber: s.page, detections, textractData: { words }, csiCodes });
  tally.pages++;
  const ps = tally.perSet.get(s.set) ?? { pages: 0, tables: 0, keepAgree: 0, clsAgree: 0, clsCompared: 0 };
  ps.pages++;
  tally.perSet.set(s.set, ps);

  // legacy rc terms not in the TS signals, from the same marks
  const drawings = yolo.filter((m) => m.label === "drawings" && modelOf(m) === "yolo_medium").map((m) => m.bbox);
  const areas = yolo.filter((m) => ["grid", "vertical_area", "horizontal_area"].includes(m.label) && modelOf(m) === "yolo_primitive").map((m) => m.bbox);
  const textBoxes = yolo.filter((m) => m.label === "text_box" && modelOf(m) !== "yolo_text").map((m) => m.bbox);

  for (const r of refs.get(`${s.set}:${s.page}`) ?? []) {
    tally.boxes++;
    const T = r.bbox;
    const emitted: RegionV2 | undefined = out.regions.find((x) => near(x.anchorBbox, T));
    const pyDroppedTb = r.tb_share >= 0.7;
    if (r.kind === "ymed_tables") {
      tally.tables.n++; ps.tables++;
      const pyKept = r.rc_kept ?? !pyDroppedTb;
      const tsKept = !!emitted;
      if (pyKept) tally.tables.pyKept++;
      if (tsKept) tally.tables.tsKept++;
      if (pyKept === tsKept) { tally.tables.keepAgree++; ps.keepAgree++; }
      else if (pyKept) bump(tally.tables.divergence, "TS dropped: IoU ≥ .6 duplicate ordering" /* the fixed-corner zone no longer drops (T5 fix), so this is the only TS-only drop */);
      else bump(tally.tables.divergence, "TS kept, Python dropped");
      if (emitted) {
        const aT = area(T);
        const din = Math.max(0, ...drawings.map((d) => inter(T, d) / aT));
        const dsc = din >= 0.8 ? 0.2 : din >= 0.3 ? 0.1 : 0;
        const ct = cover(T, textBoxes.filter((b) => inter(T, b) > 0));
        const lined = Math.max(0, ...areas.map((a) => iou(T, a))) >= 0.5;
        const sg = emitted.signals;
        const tgrid = sg.textRows >= 3 && sg.textCols >= 2;
        const legacyS = 0.4 * r.det_conf + dsc + 0.25 * sg.areaCover + 0.15 * ct + (lined ? 0.15 : 0) + 0.1 * Math.min(1, sg.tagShapes / 5) + (tgrid ? 0.15 : 0);
        tally.tables.sCompared++;
        if (Math.abs(legacyS - r.rc_s) < 2e-3) tally.tables.sParity++;
        if (pyKept) {
          tally.tables.clsCompared++; ps.clsCompared++;
          const py = normCls(r.rc_cls);
          if (py === emitted.className) { tally.tables.clsAgree++; ps.clsAgree++; } else bump(tally.tables.confusion, `${py} → ${emitted.className}`);
        }
      }
    } else {
      tally.text.n++;
      const pyKept = !pyDroppedTb;
      const tsKept = !!emitted;
      if (pyKept) tally.text.pyKept++;
      if (tsKept) tally.text.tsKept++;
      if (pyKept && tsKept) {
        tally.text.bothKept++;
        const py = normCls(r.rc2_cls);
        if (py !== "unclassified") { tally.text.named++; if (py === emitted.className) tally.text.clsAgree++; }
        else if (r.rc2_fallback) { tally.text.fallbackCompared++; if (r.rc2_fallback === emitted.className || (r.rc2_fallback === "table text (see Tables tab)" && false)) tally.text.fallbackAgree++; }
      } else if (pyKept && !tsKept) {
        const reason = r.rc2_fallback && ["short label", "view title / callout", "room / space labels", "address / project info", "existing / new / demo callouts", "material callouts", "dimensions / data"].includes(r.rc2_fallback)
          ? `TS dropped as page label (Python fallback: ${r.rc2_fallback})` : r.rc2_fallback === "table text (see Tables tab)" ? "TS dropped as table text"
          : "TS dropped: duplicate / folded into a legend";
        if (reason.startsWith("TS dropped as page label")) tally.text.labelDropped++;
        bump(tally.text.divergence, reason);
      } else if (!pyKept && tsKept) bump(tally.text.divergence, "TS kept, Python dropped (title-block rule differs)");
    }
  }
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)} % (${a}/${b})` : "n/a");
const lines: string[] = [];
lines.push(`region-classifier-v2 parity — ${tally.pages} pages, ${tally.boxes} detector boxes, sets ${sets ? [...sets].join(", ") : "all (research sample)"}`);
lines.push("");
lines.push(`TABLES (yolo_medium tables, n=${tally.tables.n})`);
lines.push(`  L1 keep agreement        ${pct(tally.tables.keepAgree, tally.tables.n)}   Python kept ${tally.tables.pyKept}, TS kept ${tally.tables.tsKept}`);
for (const [k, v] of tally.tables.divergence) lines.push(`    divergence: ${k} ×${v}`);
lines.push(`  rc structure s parity    ${pct(tally.tables.sParity, tally.tables.sCompared)}  (|Δ| < 2e-3; legacy formula recomputed from TS signals)`);
lines.push(`  L2 class agreement       ${pct(tally.tables.clsAgree, tally.tables.clsCompared)}  (both kept; unclassified ≡ table (unclassified) / schedule (other))`);
for (const [k, v] of [...tally.tables.confusion].sort((a, b) => b[1] - a[1]).slice(0, 12)) lines.push(`    ${k} ×${v}`);
lines.push("");
lines.push(`LEGENDS + TEXT BOXES (yolo_medium symbol_legend / text_box, n=${tally.text.n})`);
lines.push(`  Python kept ${tally.text.pyKept}, TS kept ${tally.text.tsKept}, both ${tally.text.bothKept}; TS dropped as page labels ${tally.text.labelDropped}`);
lines.push(`  L2 class agreement (Python named) ${pct(tally.text.clsAgree, tally.text.named)}`);
lines.push(`  fallback bucket agreement        ${pct(tally.text.fallbackAgree, tally.text.fallbackCompared)}  (boxes Python left to the checklist and TS kept)`);
for (const [k, v] of [...tally.text.divergence].sort((a, b) => b[1] - a[1])) lines.push(`    ${k} ×${v}`);
lines.push("");
lines.push("PER SET (tables): set · pages · boxes · L1 keep agreement · L2 class agreement");
for (const [set, p] of [...tally.perSet].sort((a, b) => a[0] - b[0])) lines.push(`  set ${set} · ${p.pages} · ${p.tables} · ${pct(p.keepAgree, p.tables)} · ${pct(p.clsAgree, p.clsCompared)}`);
console.log(lines.join("\n"));
const jsonOut = opt("json");
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({
    ...tally, perSet: Object.fromEntries(tally.perSet),
    tables: { ...tally.tables, confusion: Object.fromEntries(tally.tables.confusion), divergence: Object.fromEntries(tally.tables.divergence) },
    text: { ...tally.text, divergence: Object.fromEntries(tally.text.divergence) },
  }, null, 1));
}
