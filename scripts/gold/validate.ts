#!/usr/bin/env -S npx tsx
/**
 * validate.ts — check gold files against the `bp-gold/1` contract (WP-2.G; PLAN §6.1).
 *
 *   npx tsx scripts/gold/validate.ts [--private-dir <dir>] [--file <a.jsonl> …] [--roundtrip] [--no-slices]
 *     default      every <dir>/gold/*.v1.jsonl, validated together (a G-TAGMAP line may name a table in another file)
 *     --file       these files instead (labels returned by a labeller, a prefill, …); repeatable. Two labellers' files
 *                  share goldIds by design, so ids are unique per file here, not across files
 *     --roundtrip  also require each file to be canonical: parse → canonical JSONL is byte-equal to the file
 *     --no-slices  skip the check that every sliceId has <dir>/slices/<sliceId>.json
 *
 * Checks: the schema (ids, set ids, MinMax boxes, strictly increasing edges, enums, no unknown keys), the
 * semantics (stratum vocabulary, row widths vs columns, edge counts, adjudicated needs two labellers or the owner),
 * unique goldIds across files, G-TAGMAP → G-TAB references, slices present. Refuses any file outside the private dir
 * or inside a BP2 checkout: gold never lives in BP2. Prints problems with line numbers, never drawing text.
 * Exit 0 = valid, 1 = problems, 2 = usage / refused.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { insideBp2Checkout, privateDirOf, readJsonl, refuseWrite, toJsonl, validateRecords, type GoldLine } from "./gold-lib";

export interface ValidateResult { files: number; lines: number; byGold: Record<string, number>; problems: string[] }

export function validateFiles(files: readonly string[], o: { privateDir: string; roundtrip?: boolean; checkSlices?: boolean; uniqueAcrossFiles?: boolean }): ValidateResult {
  const problems: string[] = [];
  const all: GoldLine[] = [];
  const raw: Array<{ file: string; records: unknown[] }> = [];
  for (const f of files) {
    try { raw.push({ file: f, records: readJsonl(f) }); } catch (e) { problems.push((e as Error).message); }
  }
  // tables known across files, so a tag map may reference a table validated in another file
  const tables = new Set<string>();
  for (const { records } of raw) for (const r of records) {
    const x = r as { gold?: unknown; goldId?: unknown };
    if (x?.gold === "G-TAB" && typeof x.goldId === "string") tables.add(x.goldId);
  }
  const seen = new Map<string, string>();
  for (const { file, records } of raw) {
    const rel = relative(o.privateDir, file) || file;
    const { lines, problems: ps } = validateRecords(records, tables);
    for (const p of ps) problems.push(`${rel}: ${p}`);
    for (const l of lines) {
      const prev = seen.get(l.goldId);
      if (o.uniqueAcrossFiles !== false && prev && prev !== rel) problems.push(`${rel}: goldId ${l.goldId} also in ${prev}`);
      seen.set(l.goldId, rel);
      if (o.checkSlices !== false && l.sliceId && !existsSync(join(o.privateDir, "slices", `${l.sliceId}.json`))) problems.push(`${rel}: ${l.goldId}: slice ${l.sliceId} not found under slices/`);
    }
    if (o.roundtrip && ps.length === 0 && readFileSync(file, "utf8") !== toJsonl(records)) problems.push(`${rel}: not canonical JSONL (parse → serialize is not byte-equal; rewrite it with the gold tools)`);
    all.push(...lines);
  }
  const byGold: Record<string, number> = {};
  for (const l of all) byGold[l.gold] = (byGold[l.gold] ?? 0) + 1;
  return { files: files.length, lines: all.length, byGold, problems };
}

export function main(argv: readonly string[]): number {
  const privateDir = privateDirOf(argv.includes("--private-dir") ? argv[argv.indexOf("--private-dir") + 1] : undefined);
  const files = argv.flatMap((a, i) => (a === "--file" && argv[i + 1] ? [resolve(argv[i + 1])] : []));
  const explicit = files.length > 0;
  if (!files.length) {
    const gd = join(privateDir, "gold");
    if (existsSync(gd)) files.push(...readdirSync(gd).filter((f) => f.endsWith(".v1.jsonl")).sort().map((f) => join(gd, f)));
  }
  if (!files.length) { console.error(`validate: no gold files (looked in ${join(privateDir, "gold")})`); return 2; }
  for (const f of files) {
    if (insideBp2Checkout(f)) { console.error(`validate: refused ${f}: gold never lives inside a BP2 checkout`); return 2; }
    const refused = refuseWrite(f, privateDir);
    if (refused) { console.error(`validate: refused ${f}: ${refused}`); return 2; }
  }
  const r = validateFiles(files, { privateDir, roundtrip: argv.includes("--roundtrip"), checkSlices: !argv.includes("--no-slices"), uniqueAcrossFiles: !explicit });
  for (const p of r.problems.slice(0, 200)) console.error(`  ${p}`);
  if (r.problems.length > 200) console.error(`  … ${r.problems.length - 200} more`);
  console.log(`validate: ${r.files} files, ${r.lines} lines (${Object.entries(r.byGold).map(([g, n]) => `${g} ${n}`).join(", ") || "none"}), ${r.problems.length} problems`);
  return r.problems.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
