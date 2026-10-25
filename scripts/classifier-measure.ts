#!/usr/bin/env -S npx tsx
/**
 * classifier-measure.ts — run the classifier engine (built-in recipes) over the corpus_v2 research
 * sample exactly as region-classifier-v2-parity.ts does (same loader: scripts/lib/corpus-v2-marks.ts),
 * join the kind labels, and report accuracy against the legacy region v2 L2 names.
 *
 *   npx tsx scripts/classifier-measure.ts [--sets odd|even|all|16,19] [--labels <kinds.v1.json>] [--json out.json] [--no-textract]
 *     --corpus / --research   as the parity script
 *     --no-textract           [shape-tags] leave the bundles' Textract tables out (the marks never carry them; default: loaded
 *                             per pid from data/bundles, as production holds them in pages.textractData.tables)
 *     --labels                default gitignore/projects/classifier_builder/labels/kinds.v1.json (optional:
 *                             without it the run still prints proposal counts, fallback rate, timing)
 *     --sets                  odd | even | all (default) | comma-separated set numbers
 *
 * Labels file (clf-kind-labels/1, or any of): an array, or {labeller, labels | items: [...]}; each item
 * {set, page, regionId?, bbox? (MinMax), kind, printedTitle? | name?}. A label joins a proposal by
 * regionId, else by bbox IoU ≥ .5 on the same set + page. Kind ids are the vocabulary
 * (src/lib/classifier-engine/vocabulary.ts), "not-a-schedule" or "unreadable" (skipped). Pages come from
 * the research sample plus the labeller's page list (labels/tools/out/pages.json: set + page → pid).
 *
 * Reports per group and per kind top-1 accuracy, the top confusions, the fallback ("Other schedule")
 * count with derived-name agreement (the label's kind name words appear in the derived name, or the
 * label's own `name` matches), and the same accuracy for legacy region v2 className mapped onto the
 * vocabulary. Projects are reported as "set N"; no OCR text is printed (derived names are not shown).
 *
 * [shape-tags 2026-10-25] DETECT / TABLE-NESS block: the recipe is run with the detect threshold OPEN (0) so every
 * labelled candidate carries its p; kind accuracy still counts only proposals that pass the real threshold. Reports
 * schedule-vs-not AUC (hand p, and the bare structureScore as the pre-shape-tags baseline), precision / recall / fp at
 * p ≥ threshold, table-ness AUC (label: schedule ∪ legend-keynote from the labeller's note) with precision / recall at
 * tableP ≥ .5, and the tag-map coverage (boxes with a column, rows with text) by label group.
 */
import { writeFileSync } from "node:fs";
import { classifyRegionsV2 } from "@/lib/region-classifier-v2";
import { iou } from "@/lib/region-classifier-v2/geometry";
import { BUILT_IN_RECIPES, OTHER_SCHEDULE, runClassifierEngine, scheduleKind, type ClassifierProposal } from "@/lib/classifier-engine";
import { createCsiBoxTagger } from "@/lib/classifier-engine/csi-box-tagger";
import { DEFAULT_CORPUS, DEFAULT_RESEARCH, loadPage, textractTablesOf } from "./lib/corpus-v2-marks";
import { DEFAULT_LABELS, isTableLabel, labelledSamplePages, labelsByPage, matchLabel, noteGroup, readKindLabels, type KindLabel as Label } from "./lib/classifier-labels";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const CORPUS = opt("corpus") ?? DEFAULT_CORPUS;
const RESEARCH = opt("research") ?? DEFAULT_RESEARCH;
const LABELS = opt("labels") ?? DEFAULT_LABELS;
const setsArg = opt("sets") ?? "all";
const setFilter = (set: number): boolean => setsArg === "all" ? true : setsArg === "odd" ? set % 2 === 1 : setsArg === "even" ? set % 2 === 0 : setsArg.split(",").map(Number).includes(set);

/** Legacy region v2 table class → vocabulary kind (null = no kind-level equivalent; compared at group level only). */
const LEGACY_TO_KIND: Record<string, { kind: string | null; group: string }> = {
  "door schedule": { kind: "door", group: "arch" }, "window schedule": { kind: "window", group: "arch" }, "hardware schedule": { kind: "door-hardware", group: "arch" },
  "finish schedule": { kind: "room-finish", group: "arch" }, "room schedule": { kind: "room-area", group: "arch" },
  "plumbing fixture schedule": { kind: "plumbing-fixture", group: "plumb" }, "HVAC equipment schedule": { kind: "hvac-air-handling", group: "hvac" },
  "air distribution schedule": { kind: "air-distribution", group: "hvac" }, "lighting fixture schedule": { kind: "lighting-fixture", group: "elec" },
  "electrical panel schedule": { kind: "panel", group: "elec" }, "other electrical equipment schedule": { kind: null, group: "elec" },
  "structural schedule": { kind: null, group: "struct" }, "drawing list": { kind: "drawing-list", group: "arch" },
};

const USE_TEXTRACT = !args.includes("--no-textract");
const sample = labelledSamplePages(RESEARCH, LABELS, opt("pages")).filter((s) => setFilter(s.set));
const hand = BUILT_IN_RECIPES.find((r) => r.id === "schedules.v1")!;
const openDetect = { ...hand, detect: { ...hand.detect, threshold: 0 } };
/** [shape-tags] per labelled candidate: scores + labels for the detect / table-ness block. */
interface Scored { set: number; group: string; isSchedule: boolean; isTable: boolean; p: number; structure: number; tableP: number | null; tagRows: number | null; tagRowsWithText: number }
const scored: Scored[] = [];
const labels = readKindLabels(LABELS);
const tagger = createCsiBoxTagger();
const byKey = labelsByPage(labels?.items ?? []);

const bump = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const acc = () => ({ n: 0, ok: 0 });
type Acc = { n: number; ok: number };
const stats = {
  pages: 0, ms: 0, proposals: 0, schedules: 0, fallbacks: 0, labelled: 0, unmatchedLabels: 0,
  engine: { top1: acc(), byGroup: new Map<string, Acc>(), byKind: new Map<string, Acc>(), confusion: new Map<string, number>(), fallbackLabelled: 0, fallbackNameAgree: 0, notASchedule: { n: 0, proposed: 0 } },
  legacy: { top1: acc(), group: acc(), byGroup: new Map<string, Acc>(), confusion: new Map<string, number>() },
  perSet: new Map<number, { pages: number; proposals: number; labelled: number; ok: number }>(),
};
const hit = (m: Map<string, Acc>, k: string, ok: boolean) => { const a = m.get(k) ?? acc(); a.n++; if (ok) a.ok++; m.set(k, a); };
const nameAgrees = (p: ClassifierProposal, l: Label): boolean => {
  const derived = (p.derivedName?.text ?? "").toUpperCase();
  if (!derived) return false;
  if (l.name && derived.includes(l.name.toUpperCase())) return true;
  const kindName = scheduleKind(l.kind)?.name.toUpperCase() ?? "";
  const stems = kindName.replace(/[^A-Z ]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !["SCHEDULE", "TABLE", "LIST", "LEGEND"].includes(w));
  return stems.some((w) => derived.includes(w));
};

for (const s of sample) {
  const loaded = loadPage(s, CORPUS);
  if (!loaded) continue;
  const { detections, words, csiCodes, drawingNumber } = loaded;
  const tables = USE_TEXTRACT ? textractTablesOf(s.pid, s.page, CORPUS) : [];
  const regionsV2 = classifyRegionsV2({ pageNumber: s.page, detections, textractData: { words, tables }, csiCodes });
  // drawingNumber: production feeds `pages.drawingNumber` (sheet discipline signals); the corpus run's sheets.json is the same value.
  const run = runClassifierEngine({ pageNumber: s.page, detections, textractData: { words, tables }, csiCodes, regionsV2, drawingNumber, tagger, keynotes: loaded.keynotes }, [openDetect]);
  stats.pages++; stats.ms += run.ms;
  const ps = stats.perSet.get(s.set) ?? { pages: 0, proposals: 0, labelled: 0, ok: 0 };
  ps.pages++;
  const candidates = run.result.proposals;
  for (const l of byKey.get(`${s.set}:${s.page}`) ?? []) {
    const c = matchLabel(candidates, l);
    if (!c) continue;
    scored.push({
      set: s.set, group: noteGroup(l), isSchedule: l.kind !== "not-a-schedule", isTable: isTableLabel(l), p: c.p, structure: c.features["detect.structure"] ?? 0,
      tableP: typeof c.tableP === "number" ? c.tableP : null, tagRows: c.tagMap ? c.tagMap.rows.length : null, tagRowsWithText: c.tagMap ? c.tagMap.rows.filter((r) => r.rowText).length : 0,
    });
  }
  const proposals = candidates.filter((p) => p.p >= hand.detect.threshold);
  stats.proposals += proposals.length; ps.proposals += proposals.length;
  for (const p of proposals) { stats.schedules++; if (!p.classId) stats.fallbacks++; }
  const pageLabels = byKey.get(`${s.set}:${s.page}`) ?? [];
  const regionById = new Map(regionsV2.regions.map((r) => [r.id, r]));
  for (const l of pageLabels) {
    stats.labelled++;
    const p = matchLabel(proposals, l);
    const region = (l.regionId && regionById.get(l.regionId)) || regionsV2.regions.find((r) => l.bbox && iou(r.bbox, l.bbox) >= 0.5);
    if (l.kind === "not-a-schedule") { stats.engine.notASchedule.n++; if (p) stats.engine.notASchedule.proposed++; continue; }
    if (!p) { stats.unmatchedLabels++; continue; }
    ps.labelled++;
    const group = scheduleKind(l.kind)?.group ?? "other";
    const predicted = p.classId ?? OTHER_SCHEDULE;
    const ok = predicted === l.kind;
    stats.engine.top1.n++; if (ok) { stats.engine.top1.ok++; ps.ok++; }
    hit(stats.engine.byGroup, group, ok); hit(stats.engine.byKind, l.kind, ok);
    if (!ok) bump(stats.engine.confusion, `${l.kind} → ${predicted}`);
    if (!p.classId) { stats.engine.fallbackLabelled++; if (nameAgrees(p, l)) stats.engine.fallbackNameAgree++; }
    if (region) {
      const legacy = LEGACY_TO_KIND[region.className] ?? { kind: region.className === "unclassified" ? OTHER_SCHEDULE : null, group: "other" };
      const lok = legacy.kind === l.kind;
      stats.legacy.top1.n++; if (lok) stats.legacy.top1.ok++;
      stats.legacy.group.n++; if (legacy.group === group) stats.legacy.group.ok++;
      hit(stats.legacy.byGroup, group, lok);
      if (!lok) bump(stats.legacy.confusion, `${l.kind} → ${legacy.kind ?? `(${region.className})`}`);
    }
  }
  stats.perSet.set(s.set, ps);
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)} % (${a}/${b})` : "n/a");
const lines: string[] = [];
lines.push(`classifier-measure — ${stats.pages} pages (sets ${setsArg}), ${stats.proposals} schedule proposals, ${stats.fallbacks} fell back to "${OTHER_SCHEDULE}"; engine ${(stats.ms / Math.max(1, stats.pages)).toFixed(1)} ms/page`);
if (!labels) {
  lines.push(`no labels file at ${LABELS} — accuracy not measured (the file is produced by track L)`);
} else {
  lines.push(`labels: ${labels.items.length} (labeller: ${labels.labeller}); ${stats.labelled} on these pages, ${stats.unmatchedLabels} without a proposal (engine gate / no candidate), not-a-schedule ${stats.engine.notASchedule.n} of which proposed anyway ${stats.engine.notASchedule.proposed}`);
  lines.push("");
  lines.push(`ENGINE (schedules.v1)  top-1 kind ${pct(stats.engine.top1.ok, stats.engine.top1.n)}`);
  for (const [g, a] of [...stats.engine.byGroup].sort()) lines.push(`  group ${g.padEnd(6)} ${pct(a.ok, a.n)}`);
  for (const [k, a] of [...stats.engine.byKind].sort()) lines.push(`    ${k.padEnd(24)} ${pct(a.ok, a.n)}`);
  lines.push(`  fallbacks among labelled ${stats.engine.fallbackLabelled}, derived name agrees with the label ${pct(stats.engine.fallbackNameAgree, stats.engine.fallbackLabelled)}`);
  lines.push("  top confusions (label → predicted):");
  for (const [k, v] of [...stats.engine.confusion].sort((a, b) => b[1] - a[1]).slice(0, 15)) lines.push(`    ${k} ×${v}`);
  lines.push("");
  lines.push(`LEGACY region v2 L2 (className → vocabulary)  top-1 kind ${pct(stats.legacy.top1.ok, stats.legacy.top1.n)}  group ${pct(stats.legacy.group.ok, stats.legacy.group.n)}`);
  for (const [g, a] of [...stats.legacy.byGroup].sort()) lines.push(`  group ${g.padEnd(6)} ${pct(a.ok, a.n)}`);
  for (const [k, v] of [...stats.legacy.confusion].sort((a, b) => b[1] - a[1]).slice(0, 10)) lines.push(`    ${k} ×${v}`);
}
// ── [shape-tags] detect / table-ness block ──
const auc = (xs: Array<{ s: number; y: boolean }>): number | null => {
  const pos = xs.filter((x) => x.y).map((x) => x.s);
  const neg = xs.filter((x) => !x.y).map((x) => x.s);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (pos.length * neg.length);
};
const f3 = (v: number | null) => (v === null ? "n/a" : v.toFixed(3));
const pr = (xs: Array<{ s: number; y: boolean }>, t: number) => {
  const tp = xs.filter((x) => x.y && x.s >= t).length, fp = xs.filter((x) => !x.y && x.s >= t).length, fn = xs.filter((x) => x.y && x.s < t).length;
  return `precision ${f3(tp + fp ? tp / (tp + fp) : null)} recall ${f3(tp + fn ? tp / (tp + fn) : null)} (tp ${tp} fp ${fp} fn ${fn})`;
};
lines.push("");
lines.push(`DETECT (schedule vs not; ${scored.length} labelled candidates${USE_TEXTRACT ? ", bundle Textract tables loaded" : ", NO Textract tables"})`);
lines.push(`  AUC hand p ${f3(auc(scored.map((x) => ({ s: x.p, y: x.isSchedule }))))} · structureScore alone ${f3(auc(scored.map((x) => ({ s: x.structure, y: x.isSchedule }))))}`);
lines.push(`  at p ≥ ${hand.detect.threshold}: ${pr(scored.map((x) => ({ s: x.p, y: x.isSchedule })), hand.detect.threshold)}`);
const withTable = scored.filter((x) => x.tableP !== null).map((x) => ({ s: x.tableP!, y: x.isTable }));
lines.push(`TABLE-NESS (schedule ∪ legend-keynote vs the rest; ${withTable.length} with tableP)`);
lines.push(`  AUC tableP ${f3(auc(withTable))} · structureScore alone ${f3(auc(scored.map((x) => ({ s: x.structure, y: x.isTable }))))} · at tableP ≥ .5: ${pr(withTable, 0.5)}`);
const legNotes = scored.filter((x) => x.group === "legend-keynote" || x.group === "notes");
lines.push(`  legend-keynote vs notes AUC (tableP) ${f3(auc(legNotes.filter((x) => x.tableP !== null).map((x) => ({ s: x.tableP!, y: x.group === "legend-keynote" }))))} (n ${legNotes.length})`);
lines.push("TAG MAP coverage: group · labelled · with a column · rows · rows with text");
for (const g of ["schedule", "legend-keynote", "notes", "title-block", "other-nonschedule"]) {
  const xs = scored.filter((x) => x.group === g);
  const col = xs.filter((x) => x.tagRows !== null);
  const rows = col.reduce((a, x) => a + (x.tagRows ?? 0), 0);
  const txt = col.reduce((a, x) => a + x.tagRowsWithText, 0);
  lines.push(`  ${g.padEnd(18)} ${String(xs.length).padStart(4)} · ${String(col.length).padStart(4)} · ${String(rows).padStart(5)} · ${pct(txt, rows)}`);
}
lines.push("");
lines.push("PER SET: set · pages · proposals · labelled · engine top-1");
for (const [set, p] of [...stats.perSet].sort((a, b) => a[0] - b[0])) lines.push(`  set ${set} · ${p.pages} · ${p.proposals} · ${p.labelled} · ${pct(p.ok, p.labelled)}`);
console.log(lines.join("\n"));
const jsonOut = opt("json");
if (jsonOut) {
  const plain = (m: Map<string, unknown>) => Object.fromEntries(m);
  writeFileSync(jsonOut, JSON.stringify({
    ...stats, perSet: Object.fromEntries(stats.perSet),
    engine: { ...stats.engine, byGroup: plain(stats.engine.byGroup), byKind: plain(stats.engine.byKind), confusion: plain(stats.engine.confusion) },
    legacy: { ...stats.legacy, byGroup: plain(stats.legacy.byGroup), confusion: plain(stats.legacy.confusion) },
  }, null, 1));
}
