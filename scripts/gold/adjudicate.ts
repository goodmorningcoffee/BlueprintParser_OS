#!/usr/bin/env -S npx tsx
/**
 * adjudicate.ts — compare the two labellers of a gold batch, queue the disagreements, merge the decisions
 * (WP-2.G; PLAN §6.1 protocol: κ on the double labels, prefill-vs-scratch agreement, owner ≤ 20 disagreements only).
 *
 *   npx tsx scripts/gold/adjudicate.ts --batch b1 [--private-dir <dir>] [--max-owner 20]
 *       → <batch>/adjudication/report.json (agreement, κ, prefill-vs-scratch) + queue.json (disagreements, most
 *         different first; the first --max-owner go to the owner, the rest need a third label)
 *   npx tsx scripts/gold/adjudicate.ts --batch b1 --decisions <decisions.json> [--private-dir <dir>]
 *       decisions: [{goldId, pick: "a" | "b"} | {goldId, line: <bp-gold/1 line>}]
 *       decisions may carry `by` (default "owner"; e.g. the third labeller of a `third-label` queue item)
 *       → <batch>/adjudication/final.jsonl and the batch's lines merged into <dir>/gold/<G-SET>.v1.jsonl (lines of
 *         the same goldIds are replaced; every other line is kept), validated before anything is written. An
 *         existing gold file with ANY problem (schema or semantic) is refused, never filtered: fix it with
 *         validate.ts first. The previous gold file is kept as <G-SET>.v1.jsonl.bak before it is replaced.
 *
 * Merge rule: labeller A's label is the base. A double-labelled unit both agree on → adjudicated, labellers [a, b];
 * a decided disagreement → the decision, labellers [a, b, owner]; an undecided one → A's label, adjudicated false;
 * a single-labelled unit → A's label, adjudicated false. Reads and writes only under the private dir. Prints counts.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { paraMetrics, tabMetrics } from "../lib/parse-measure";
import type { Assignment } from "./label-pack";
import { argOf, canonicalJson, normKey, normText, privateDirOf, readJsonl, toJsonl, validateRecords, writePrivate, type GoldLine } from "./gold-lib";

const iou = (a: readonly number[], b: readonly number[]): number => {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const i = ix * iy, u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i;
  return u > 0 ? i / u : 0;
};

/** The comparable content of a label: text normalised, geometry (edges, item boxes) left out. */
function signature(l: GoldLine): string {
  if (l.gold === "G-TAB") return canonicalJson({ s: l.stratum, h: l.truth.headerRows.map((r) => r.map(normText)), r: l.truth.rows.map((r) => [r.section ? 1 : 0, ...r.cells.map(normText)]), t: l.truth.tagColumn ?? null });
  if (l.gold === "G-PARA") return canonicalJson({ s: l.stratum, i: l.truth.items.map((x) => [normKey(x.key), normText(x.text), x.header ? 1 : 0]) });
  return canonicalJson({ s: l.stratum, scope: l.truth.scope, t: l.truth.tags.map((t) => normText(t.tag)).sort() });
}

/** Agreement of two labels of one unit: exact (normalised) and a [0, 1] similarity used to rank disagreements. */
export function agreement(a: GoldLine, b: GoldLine): { agree: boolean; score: number } {
  let score: number;
  if (a.gold === "G-TAB" && b.gold === "G-TAB") {
    const grid = (l: typeof a) => l.truth.rows.map((r) => r.cells);
    score = (tabMetrics(a.truth, grid(b)).cellExact + tabMetrics(b.truth, grid(a)).cellExact) / 2;
  } else if (a.gold === "G-PARA" && b.gold === "G-PARA") {
    score = (paraMetrics(a.truth, b.truth.items).itemF1 + paraMetrics(b.truth, a.truth.items).itemF1) / 2;
  } else if (a.gold === "G-TAGMAP" && b.gold === "G-TAGMAP") {
    const inst = (l: typeof a) => l.truth.tags.flatMap((t) => t.instances.map((x) => ({ tag: normText(t.tag), ...x })));
    const ia = inst(a), ib = inst(b), used = new Set<number>();
    let tp = 0;
    for (const x of ia) {
      const j = ib.findIndex((y, k) => !used.has(k) && y.tag === x.tag && y.page === x.page && iou(x.bbox, y.bbox) >= 0.5);
      if (j >= 0) { used.add(j); tp++; }
    }
    score = ia.length + ib.length ? (2 * tp) / (ia.length + ib.length) : 1;
    if (signature(a) === signature(b) && tp === ia.length && tp === ib.length) return { agree: true, score: 1 };
    return { agree: false, score };
  } else {
    return { agree: false, score: 0 };
  }
  return { agree: signature(a) === signature(b), score: Math.round(score * 1e4) / 1e4 };
}

/** Cohen's κ of two raters' categorical labels over the same units (1 when both are constant and equal). */
export function cohenKappa(a: readonly string[], b: readonly string[]): number {
  const n = a.length;
  if (!n || n !== b.length) return NaN;
  const po = a.filter((x, i) => x === b[i]).length / n;
  const cats = [...new Set([...a, ...b])];
  const pe = cats.reduce((s, c) => s + (a.filter((x) => x === c).length / n) * (b.filter((x) => x === c).length / n), 0);
  return pe === 1 ? 1 : Math.round(((po - pe) / (1 - pe)) * 1e4) / 1e4;
}

export interface QueueItem { qid: string; goldId: string; gold: string; mode: "scratch" | "prefill"; score: number; to: "owner" | "third-label"; a: GoldLine; b: GoldLine }

export function compare(asg: Assignment, A: ReadonlyMap<string, GoldLine>, B: ReadonlyMap<string, GoldLine>, maxOwner = 20) {
  const double = [...asg.bScratch, ...asg.bPrefill].filter((id) => A.has(id) && B.has(id)).sort();
  const rows = double.map((id) => ({ id, mode: asg.bScratch.includes(id) ? ("scratch" as const) : ("prefill" as const), ...agreement(A.get(id)!, B.get(id)!) }));
  const rate = (xs: typeof rows) => ({ n: xs.length, agree: xs.length ? Math.round((xs.filter((x) => x.agree).length / xs.length) * 1e4) / 1e4 : NaN, meanScore: xs.length ? Math.round((xs.reduce((s, x) => s + x.score, 0) / xs.length) * 1e4) / 1e4 : NaN });
  const pair = (f: (l: GoldLine) => string, gold?: string) => {
    const ids = double.filter((id) => !gold || A.get(id)!.gold === gold);
    return { n: ids.length, kappa: cohenKappa(ids.map((id) => f(A.get(id)!)), ids.map((id) => f(B.get(id)!))) };
  };
  const report = {
    schema: "bp-gold-adjudication/1", batch: asg.batch, a: asg.a, b: asg.b,
    units: asg.aUnits.length, labelledByA: asg.aUnits.filter((id) => A.has(id)).length,
    missing: { a: asg.aUnits.filter((id) => !A.has(id)).length, b: [...asg.bScratch, ...asg.bPrefill].filter((id) => !B.has(id)).length },
    double: rate(rows), prefillVsScratch: rate(rows.filter((r) => r.mode === "scratch")), prefillVsPrefill: rate(rows.filter((r) => r.mode === "prefill")),
    kappa: {
      stratum: pair((l) => l.stratum),
      tableRowCount: pair((l) => (l.gold === "G-TAB" ? String(l.truth.rows.length) : ""), "G-TAB"),
      paraItemCount: pair((l) => (l.gold === "G-PARA" ? String(l.truth.items.length) : ""), "G-PARA"),
    },
  };
  const dis = rows.filter((r) => !r.agree).sort((x, y) => x.score - y.score || (x.id < y.id ? -1 : 1));
  const queue: QueueItem[] = dis.map((r, i) => ({ qid: `q${String(i + 1).padStart(2, "0")}`, goldId: r.id, gold: A.get(r.id)!.gold, mode: r.mode, score: r.score, to: i < maxOwner ? "owner" : "third-label", a: A.get(r.id)!, b: B.get(r.id)! }));
  return { report, queue, agreed: new Set(rows.filter((r) => r.agree).map((r) => r.id)) };
}

export type Decision = ({ goldId: string; pick: "a" | "b" } | { goldId: string; line: GoldLine }) & { by?: string };

/** The batch's final lines (see the merge rule in the header). */
export function mergeBatch(asg: Assignment, A: ReadonlyMap<string, GoldLine>, B: ReadonlyMap<string, GoldLine>, agreed: ReadonlySet<string>, decisions: readonly Decision[]): GoldLine[] {
  const dec = new Map(decisions.map((d) => [d.goldId, d]));
  const out: GoldLine[] = [];
  for (const id of asg.aUnits) {
    const a = A.get(id);
    if (!a) continue;
    const b = B.get(id);
    const d = dec.get(id);
    if (b && agreed.has(id)) out.push({ ...a, labellers: [asg.a, asg.b], adjudicated: true });
    else if (b && d) {
      if ("line" in d && d.line.gold !== a.gold) throw new Error(`decision for ${id}: a ${d.line.gold} line for a ${a.gold} unit`);
      const chosen = "line" in d ? d.line : d.pick === "b" ? b : a;
      out.push({ ...chosen, goldId: id, labellers: [asg.a, asg.b, d.by ?? "owner"], adjudicated: true } as GoldLine);
    } else out.push({ ...a, labellers: [asg.a], adjudicated: false });
  }
  return out.sort((x, y) => (x.goldId < y.goldId ? -1 : 1));
}

/** Decisions mergeBatch ignores (unit agreed, single-labelled, or unknown), each with the reason — printed as warnings. */
export function ignoredDecisions(asg: Assignment, A: ReadonlyMap<string, GoldLine>, B: ReadonlyMap<string, GoldLine>, agreed: ReadonlySet<string>, decisions: readonly Decision[]): string[] {
  const units = new Set(asg.aUnits);
  return decisions.flatMap((d) => {
    const why = !units.has(d.goldId) ? "not a unit of this batch" : !A.has(d.goldId) ? "A did not label it"
      : !B.has(d.goldId) ? "single-labelled (B has no label)" : agreed.has(d.goldId) ? "the labellers agree" : null;
    return why ? [`${d.goldId}: ${why}`] : [];
  });
}

/** One labeller's labels; a tag map may name any table of the batch (the labeller may not have labelled that table). */
function readLabels(file: string, who: string, batchTables: ReadonlySet<string>): Map<string, GoldLine> {
  if (!existsSync(file)) return new Map();
  const { lines, problems } = validateRecords(readJsonl(file), batchTables);
  if (problems.length) throw new Error(`${who}'s labels have ${problems.length} problems (first: ${problems[0]}); run validate.ts --file ${file}`);
  return new Map(lines.map((l) => [l.goldId, l]));
}

export function main(argv: readonly string[]): number {
  const batch = argOf(argv, "batch");
  if (!batch) { console.error("usage: adjudicate.ts --batch <b1> [--private-dir d] [--max-owner 20] [--decisions decisions.json]"); return 2; }
  const privateDir = privateDirOf(argOf(argv, "private-dir"));
  const dir = join(privateDir, "gold", "batches", batch);
  const asg = JSON.parse(readFileSync(join(dir, "packs", "assignment.json"), "utf8")) as Assignment;
  let A: Map<string, GoldLine>, B: Map<string, GoldLine>;
  const batchTables = new Set(asg.aUnits.filter((id) => id.startsWith("tab-")));
  try { A = readLabels(join(dir, "labels", `${asg.a}.jsonl`), asg.a, batchTables); B = readLabels(join(dir, "labels", `${asg.b}.jsonl`), asg.b, batchTables); } catch (e) { console.error(`adjudicate: ${(e as Error).message}`); return 1; }
  const { report, queue, agreed } = compare(asg, A, B, Number(argOf(argv, "max-owner") ?? 20));
  const decFile = argOf(argv, "decisions");
  if (!decFile) {
    writePrivate(join(dir, "adjudication", "report.json"), JSON.stringify(report, null, 1) + "\n", privateDir);
    writePrivate(join(dir, "adjudication", "queue.json"), JSON.stringify(queue, null, 1) + "\n", privateDir);
    console.log(`adjudicate: ${report.double.n} double-labelled, agree ${report.double.agree}; κ stratum ${report.kappa.stratum.kappa}; prefill-vs-scratch agree ${report.prefillVsScratch.agree} (n ${report.prefillVsScratch.n}); ${queue.filter((q) => q.to === "owner").length} to the owner, ${queue.filter((q) => q.to === "third-label").length} need a third label`);
    return 0;
  }
  const decisions = JSON.parse(readFileSync(resolve(decFile), "utf8")) as Decision[];
  for (const w of ignoredDecisions(asg, A, B, agreed, decisions)) console.error(`adjudicate: warning: decision ignored — ${w}`);
  const final = mergeBatch(asg, A, B, agreed, decisions);
  const ids = new Set(final.map((l) => l.goldId));
  const goldFile = (g: string) => join(privateDir, "gold", `${g}.v1.jsonl`);
  // Existing gold is read whole and must be valid: a filtered read would silently drop the bad lines on rewrite.
  const SETS = ["G-TAB", "G-PARA", "G-TAGMAP"] as const;
  const raw = new Map<string, unknown[]>();
  try { for (const g of SETS) raw.set(g, existsSync(goldFile(g)) ? readJsonl(goldFile(g)) : []); } catch (e) { console.error(`adjudicate: ${(e as Error).message}; nothing written`); return 1; }
  const tabIdOf = (r: unknown) => { const x = r as { gold?: unknown; goldId?: unknown }; return x?.gold === "G-TAB" && typeof x.goldId === "string" ? [x.goldId] : []; };
  const tables = new Set([...raw.get("G-TAB")!.flatMap(tabIdOf), ...final.filter((l) => l.gold === "G-TAB").map((l) => l.goldId)]);
  const existing = new Map<string, GoldLine[]>();
  for (const g of SETS) {
    const { lines, problems } = validateRecords(raw.get(g)!, tables);
    if (problems.length) { console.error(`adjudicate: existing ${goldFile(g)} has ${problems.length} problems (first: ${problems[0]}); fix it with validate.ts — nothing written`); return 1; }
    existing.set(g, lines);
  }
  const { problems: fp } = validateRecords(final, tables);
  if (fp.length) { console.error(`adjudicate: merged batch has ${fp.length} problems (first: ${fp[0]})`); return 1; }
  const writes: Array<{ file: string; lines: GoldLine[]; mine: GoldLine[] }> = [];
  for (const gold of SETS) {
    const mine = final.filter((l) => l.gold === gold);
    if (!mine.length) continue;
    const merged = [...existing.get(gold)!.filter((l) => !ids.has(l.goldId)), ...mine].sort((x, y) => (x.goldId < y.goldId ? -1 : 1));
    const { problems } = validateRecords(merged, tables);
    if (problems.length) { console.error(`adjudicate: ${goldFile(gold)} would have ${problems.length} problems (first: ${problems[0]}); nothing written`); return 1; }
    writes.push({ file: goldFile(gold), lines: merged, mine });
  }
  writePrivate(join(dir, "adjudication", "final.jsonl"), toJsonl(final), privateDir);
  for (const w of writes) {
    if (existsSync(w.file)) writePrivate(`${w.file}.bak`, readFileSync(w.file, "utf8"), privateDir);
    writePrivate(w.file, toJsonl(w.lines), privateDir);
    console.log(`adjudicate: ${w.mine[0].gold} ${w.mine.length} lines from ${batch} (${w.mine.filter((l) => l.adjudicated).length} adjudicated) → ${w.file} (${w.lines.length} total)`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
