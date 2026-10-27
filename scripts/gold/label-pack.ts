#!/usr/bin/env -S npx tsx
/**
 * label-pack.ts — split a prefilled gold batch into labeller packs (WP-2.G; PLAN §6.1 protocol, DR-2.2).
 *
 *   npx tsx scripts/gold/label-pack.ts --batch b1 [--private-dir <dir>] [--a agent-a] [--b agent-b]
 *       [--scratch 30] [--double 0.15] [--seed 20261027] [--force]
 *
 * Protocol: labeller A corrects the prefill of EVERY unit. Labeller B labels `--scratch` G-TAB tables FROM SCRATCH
 * (no prefill; drawn round-robin over the table strata) and `--double` of the remaining units WITH the prefill —
 * always blind to A. Writes under <dir>/gold/batches/<batch>/packs/: `<labeller>.jsonl` (one work item per unit:
 * opaque ids, region, the slice's text lines inside the region in reading order, the prefill or a blank template),
 * `assignment.json` (who labels what, in which mode: adjudicate.ts reads it), `tables.json` (the batch's table ids
 * only, so a labeller validates tag maps without seeing the prefill) and `README.md` (instructions). Labels come back
 * as `bp-gold/1` lines in <dir>/gold/batches/<batch>/labels/<labeller>.jsonl. Once labels exist, re-packing is
 * refused without --force (a new seed / scratch / labeller would pair the labels against the wrong modes). Prints
 * counts only.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { LegacySlice } from "@/lib/legacy-joins/legacy-paths";
import type { Sample } from "./select-sample";
import { STRATA, argOf, mulberry32, privateDirOf, readJsonl, seededShuffle, toJsonl, validateRecords, writePrivate, type GoldLine } from "./gold-lib";

export interface Assignment { schema: "bp-gold-assignment/1"; batch: string; seed: number; a: string; b: string; aUnits: string[]; bScratch: string[]; bPrefill: string[] }

/** Seeded assignment: B's scratch tables round-robin over table strata, then `double` of the rest with prefill. */
export function assign(lines: readonly GoldLine[], o: { batch: string; a: string; b: string; scratch: number; double: number; seed: number }): Assignment {
  const rand = mulberry32(o.seed);
  const ids = lines.map((l) => l.goldId).sort();
  const byStratum = STRATA["G-TAB"].map((s) => seededShuffle(lines.filter((l) => l.gold === "G-TAB" && l.stratum === s).map((l) => l.goldId).sort(), rand));
  const scratch: string[] = [];
  while (scratch.length < o.scratch && byStratum.some((q) => q.length)) {
    for (const q of byStratum) if (q.length && scratch.length < o.scratch) scratch.push(q.shift()!);
  }
  const rest = seededShuffle(ids.filter((id) => !scratch.includes(id)), rand);
  const prefill = rest.slice(0, Math.ceil(rest.length * o.double));
  return { schema: "bp-gold-assignment/1", batch: o.batch, seed: o.seed, a: o.a, b: o.b, aUnits: ids, bScratch: scratch.sort(), bPrefill: prefill.sort() };
}

/** The slice's text lines whose centre is inside the region, top to bottom then left to right. */
export function evidenceLines(slice: Pick<LegacySlice, "page">, region: readonly number[]): string[] {
  return slice.page.lines
    .filter((l) => { const cx = l.bbox[0] + l.bbox[2] / 2, cy = l.bbox[1] + l.bbox[3] / 2; return cx >= region[0] && cx <= region[2] && cy >= region[1] && cy <= region[3]; })
    .sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0])
    .map((l) => l.text);
}

/** A blank label of the unit's gold set (what a scratch labeller fills in). */
function blank(l: GoldLine): GoldLine["truth"] {
  if (l.gold === "G-TAB") return { headerRows: [], rows: [{ cells: [""] }] };
  if (l.gold === "G-PARA") return { items: [{ key: "", text: "" }] };
  return { table: l.truth.table, scope: l.truth.scope, tags: [{ tag: "", instances: [] }] };
}

const README = (batch: string, a: string, b: string) => `# Gold batch ${batch}: labelling packs (PRIVATE — real drawing text; never copy into BP2)

Packs: \`${a}.jsonl\` (every unit, correct the prefill) and \`${b}.jsonl\` (scratch units have no prefill; label from the
evidence and the crop). Do not look at the other labeller's pack or labels.

Return one \`bp-gold/1\` line per unit in \`../labels/<you>.jsonl\`: copy \`template\`, replace \`truth\`, set
\`labellers: ["<you>"]\`, keep \`mode\`, \`adjudicated: false\`. Fix \`stratum\` (and add \`tags\`) when the guess is wrong.
- G-TAB: \`headerRows\` (0–4 rows) and body \`rows\` as printed, every row the same number of cells (a section row
  between body rows is \`{cells:[text], section:true}\`); add \`colEdges\`/\`rowEdges\` (normalised page x / y, header + body)
  when you can read them off the crop; \`tagColumn\` = the column holding the tag shapes.
- G-PARA: \`items\` in reading order: \`key\` as printed (\`1.\`, \`A.\`, \`(b)\`, or ""), \`text\` with line breaks joined by one
  space; a block header is an item with \`header:true\`.
- G-TAGMAP: every tag of the table and every instance on the drawings (\`page\` + normalised bbox); \`qty\` when printed.
Check with: \`npx tsx scripts/gold/validate.ts --file <labels file> --known-tables <batch>/packs/tables.json\` (the batch's
table ids only, so a tag map that points at a table you did not label still resolves). Do not open \`prefill.jsonl\`.
`;

export function main(argv: readonly string[]): number {
  const batch = argOf(argv, "batch");
  if (!batch) { console.error("usage: label-pack.ts --batch <b1> [--private-dir d] [--a agent-a] [--b agent-b] [--scratch 30] [--double 0.15] [--seed n]"); return 2; }
  const privateDir = privateDirOf(argOf(argv, "private-dir"));
  const dir = join(privateDir, "gold", "batches", batch);
  const a = argOf(argv, "a") ?? "agent-a", b = argOf(argv, "b") ?? "agent-b";
  if (a === b) { console.error("label-pack: the two labellers must differ"); return 2; }
  const labelsDir = join(dir, "labels");
  if (!argv.includes("--force") && existsSync(join(dir, "packs", "assignment.json")) && existsSync(labelsDir) && readdirSync(labelsDir).some((f) => f.endsWith(".jsonl"))) {
    console.error(`label-pack: ${batch} already has labels under ${labelsDir}; re-packing would change the assignment adjudicate.ts pairs them by (use --force to re-pack anyway)`);
    return 1;
  }
  const sample = JSON.parse(readFileSync(join(dir, "sample.json"), "utf8")) as Sample;
  const { lines, problems } = validateRecords(readJsonl(join(dir, "prefill.jsonl")));
  if (problems.length) { console.error(`label-pack: prefill.jsonl has ${problems.length} problems (first: ${problems[0]})`); return 1; }
  const asg = assign(lines, { batch, a, b, scratch: Number(argOf(argv, "scratch") ?? 30), double: Number(argOf(argv, "double") ?? 0.15), seed: Number(argOf(argv, "seed") ?? 20261027) });
  const byId = new Map(sample.items.map((x) => [x.goldId, x]));
  const work = (l: GoldLine, mode: "prefill" | "scratch") => {
    const sf = l.sliceId ? join(privateDir, "slices", `${l.sliceId}.json`) : null;
    const slice = sf && existsSync(sf) ? (JSON.parse(readFileSync(sf, "utf8")) as LegacySlice) : null;
    const template = { ...l, labellers: ["<you>"], mode, adjudicated: false, truth: mode === "scratch" ? blank(l) : l.truth };
    return { goldId: l.goldId, gold: l.gold, stratum: l.stratum, setId: l.setId, page: l.page, sheet: l.sheet ?? null, region: l.region, sliceId: l.sliceId ?? null,
      table: byId.get(l.goldId)?.table ?? null, mode, evidence: { lines: slice ? evidenceLines(slice, l.region) : [] }, template };
  };
  const ln = new Map(lines.map((l) => [l.goldId, l]));
  const packA = asg.aUnits.map((id) => work(ln.get(id)!, "prefill"));
  const packB = [...asg.bScratch.map((id) => work(ln.get(id)!, "scratch")), ...asg.bPrefill.map((id) => work(ln.get(id)!, "prefill"))];
  writePrivate(join(dir, "packs", `${a}.jsonl`), toJsonl(packA), privateDir);
  writePrivate(join(dir, "packs", `${b}.jsonl`), toJsonl(packB), privateDir);
  writePrivate(join(dir, "packs", "assignment.json"), JSON.stringify(asg, null, 1) + "\n", privateDir);
  writePrivate(join(dir, "packs", "tables.json"), JSON.stringify(lines.filter((l) => l.gold === "G-TAB").map((l) => l.goldId).sort()) + "\n", privateDir);
  writePrivate(join(dir, "packs", "README.md"), README(batch, a, b), privateDir);
  console.log(`label-pack: ${a} ${packA.length} units (prefill); ${b} ${asg.bScratch.length} scratch + ${asg.bPrefill.length} prefill → ${join(dir, "packs")}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
