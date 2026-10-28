#!/usr/bin/env -S npx tsx
/**
 * import-app-labels.ts — owner actions in the app → private gold (table-pipeline WP-3.Q; PLAN §6.5, §5 WP-3.Q).
 *
 *   NODE_OPTIONS=--max-old-space-size=3584 npx tsx scripts/gold/import-app-labels.ts --batch <name>
 *       --bundles <bundle.json|dir>[,…] [--private-dir <dir>] [--merge] [--research <dir>|none]
 *     --bundles  `bp-export/1` project exports (GET /api/projects/[id]/export, or corpus_v2 data/bundles/)
 *     --batch    writes <dir>/gold/imports/<batch>/: G-TAB / G-PARA / G-TAGMAP .v1.jsonl (every imported line,
 *                adjudicated or not), labels.v1.jsonl (`bp-app-label/1`: every verdict, incl. negatives and
 *                proposal / tag labels that are not gold lines), queue.json (the unadjudicated lines + why), summary.json
 *                (counts); slices to <dir>/slices/prv-<goldId>.json
 *     --merge    also merge the ADJUDICATED lines into <dir>/gold/<G-SET>.v1.jsonl (same goldId replaced, the rest kept;
 *                the previous file kept as .bak). An existing gold file with any problem is refused, never filtered.
 *
 * Label rules (PLAN §5 WP-3.Q, amended 2026-10-27 after the WP-2.F verify):
 *   ✓ `correct` (verdict bar), the region still matching the verdict's snapshot → adjudicated truth = the region's data
 *     (labeller `owner:app`). ✓/✗ stay adjudicated for their stored machine snapshot.
 *   `committed` (workspace accept) → adjudicated truth = the committed region (labeller `owner:app`).
 *   `corrected` (server-inferred: the region changed since a ✓/✗) → UNADJUDICATED (labeller `app:corrected`, owner
 *     queue): a TP-2 region carries no origin marker, and an Auto Parse re-run auto-saves under the same id, so a
 *     `corrected` pair may be (machine, machine). Never truth until the owner decides.
 *   ✗ `wrong` → a negative label record only (no gold line: the truth is unknown).
 *   `missedDetection` → a recall record. Proposal verdicts → detect / naming records; a `via:"parse"` accept is marked
 *     `weak` (weight `PARSE_ACCEPT_WEIGHT`, the same down-weight the classifier fit applies, K58).
 *   Tag statuses (`PJ.tagMaps`, TP-4) → per-instance records, and a G-TAGMAP line for an imported table: the confirmed
 *     instances, adjudicated only when no instance is still `auto`.
 * Sets: a project keeps ONE set number across every batch (else a project could sit in both halves): the pid → set
 * map is read from the corpus research sample (`--research`, default the classifier research dir; `none` skips it),
 * every `gold/batches/<b>/sample.json` and `gold/imports/set-map.json`; a new pid WITH owner labels gets the next free
 * number (in sorted pid order) and is appended to set-map.json. Reads only the bundles; writes only under the private
 * dir (refuses a BP2 checkout). Prints counts only, never drawing text.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PARSE_ACCEPT_WEIGHT } from "@/lib/classifier-engine/fit";
import type { ParseLabel, StructureTableModel } from "@/lib/parse-engine/types";
import { effectiveParseLabel } from "@/server/services/parse-labels";
import { enginePrediction } from "../lib/parse-engine-leg";
import { DEFAULT_RESEARCH } from "../lib/corpus-v2-marks";
import { cutSlice, tabTruthFrom, type SliceFile } from "./prefill";
import {
  argOf, GOLD_SETS, privateDirOf, readJsonl, toJsonl, validateRecords, writePrivate,
  type GoldLine, type GoldSet, type ParaTruth, type TabTruth,
} from "./gold-lib";

type MinMax = [number, number, number, number];
type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const hash = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 10);

/** One `bp-app-label/1` record (private: opaque ids, verdicts and counts; no drawing text). */
export interface AppLabel {
  schema: "bp-app-label/1";
  type: "parse" | "proposal" | "tag-instance";
  setId: string; page: number;
  /** The gold line it produced, when it produced one. */
  goldId?: string;
  verdict: string;
  adjudicated: boolean;
  reason: string;
  kind?: string; source?: string; snapshotHash?: string; proposalId?: string; recipeId?: string;
  classId?: string | null; proposedClassId?: string | null; weak?: boolean; weight?: number;
  secondsToAccept?: number; missedDetection?: true; ops?: { op: string; n: number }[];
  status?: string; tagMap?: string;
}

// ─── sets ────────────────────────────────────────────────────────────────────

/** pid → setId from the corpus research sample (the corpus's own set numbers), every batch sample and the import set map. */
export function readSetMap(privateDir: string, research: string | null = DEFAULT_RESEARCH): Map<string, string> {
  const map = new Map<string, string>();
  const rs = research ? join(research, "sample.json") : null;
  if (rs && existsSync(rs)) for (const p of JSON.parse(readFileSync(rs, "utf8")) as { pid?: string; set?: number }[]) if (p.pid && typeof p.set === "number" && !map.has(p.pid)) map.set(p.pid, `set-${p.set}`);
  const batches = join(privateDir, "gold", "batches");
  if (existsSync(batches)) {
    for (const b of readdirSync(batches).sort()) {
      const f = join(batches, b, "sample.json");
      if (!existsSync(f)) continue;
      const s = JSON.parse(readFileSync(f, "utf8")) as { items?: { pid?: string; setId?: string }[] };
      for (const it of s.items ?? []) if (it.pid && it.setId && !map.has(it.pid)) map.set(it.pid, it.setId);
    }
  }
  const f = join(privateDir, "gold", "imports", "set-map.json");
  if (existsSync(f)) for (const [pid, setId] of Object.entries(JSON.parse(readFileSync(f, "utf8")) as Record<string, string>)) if (!map.has(pid)) map.set(pid, setId);
  return map;
}

/** Give every new pid the next free set number, in sorted pid order (deterministic). Returns the pids added. */
export function assignSets(map: Map<string, string>, pids: readonly string[]): string[] {
  let next = Math.max(0, ...[...map.values()].map((s) => Number(s.replace(/^set-/, "")) || 0)) + 1;
  const added: string[] = [];
  for (const pid of [...new Set(pids)].sort()) if (!map.has(pid)) { map.set(pid, `set-${next++}`); added.push(pid); }
  return added;
}

// ─── region data → truth ─────────────────────────────────────────────────────

/** The gold truth of a saved region: its engine `structure` when present, else its legacy data. Null when unusable. */
export function regionTruth(region: Rec): { gold: "G-TAB"; truth: TabTruth } | { gold: "G-PARA"; truth: ParaTruth } | null {
  const type = str(region.type);
  const data = isObj(region.data) ? region.data : {};
  const structure = isObj(data.structure) ? data.structure : null;
  if (structure && Array.isArray(structure.rows) && Array.isArray(structure.cols) && Array.isArray(structure.cells)) return structureTruth(structure);
  if (structure && Array.isArray(structure.paragraphs)) return paraTruthOf((structure.paragraphs as Rec[]).map((p) => ({ key: str(p.key), text: str(p.text) })));
  if (type === "spec" && Array.isArray(data.sections)) return paraTruthOf((data.sections as unknown[]).filter(isObj).map((s) => ({ key: str(s.sectionHeader), text: str(s.body) })));
  if (type === "notes") {
    if (Array.isArray(data.rows)) {
      const headers = Array.isArray(data.headers) ? data.headers.map(str) : [];
      const [k, n] = [headers[0] ?? "Key", headers[1] ?? "Note"];
      return paraTruthOf((data.rows as unknown[]).filter(isObj).map((r) => ({ key: str(r[k]), text: headers.slice(1).map((h) => str(r[h])).filter((c) => c.trim()).join(" ") || str(r[n]) })));
    }
    if (Array.isArray(data.notes)) return paraTruthOf(data.notes.map((t) => ({ key: "", text: str(t) })));
    return null;
  }
  if (Array.isArray(data.keynotes)) return tabOf(tabTruthFrom(data.keynotes, "keynote-manual"), 0);
  if (Array.isArray(data.symbols)) {
    // a legend key is a drawn symbol: its cell is "" (gold convention), the description is the printed text
    const rows = (data.symbols as unknown[]).filter(isObj).map((s) => ({ cells: ["", str(s.description)] }));
    return rows.length ? { gold: "G-TAB", truth: { headerRows: [], rows, tagColumn: 0 } } : null;
  }
  if (Array.isArray(data.rows)) {
    const t = tabTruthFrom(data, "ocr-positions");
    const tagCol = t?.headerRows[0] ? t.headerRows[0].indexOf(str(data.tagColumn)) : -1;
    return tabOf(t, tagCol >= 0 ? tagCol : undefined);
  }
  return null;
}

function tabOf(t: TabTruth | null, tagColumn?: number): { gold: "G-TAB"; truth: TabTruth } | null {
  if (!t || !t.rows.some((r) => r.cells.some((c) => c.trim()))) return null;
  return { gold: "G-TAB", truth: tagColumn === undefined ? t : { ...t, tagColumn } };
}

function paraTruthOf(items: { key: string; text: string }[]): { gold: "G-PARA"; truth: ParaTruth } | null {
  const kept = items.filter((x) => (x.key + x.text).trim());
  return kept.length ? { gold: "G-PARA", truth: { items: kept } } : null;
}

/** A committed engine table → G-TAB truth (header rows kept as header rows; body + section rows from the model). */
function structureTruth(s: Rec): { gold: "G-TAB"; truth: TabTruth } | null {
  const model = s as unknown as StructureTableModel;
  const cols = model.cols.slice().sort((a, b) => a.x0 - b.x0);
  const header = model.rows.filter((r) => r.role === "header").map((r) => cols.map((c) => model.cells.filter((x) => x.row === r.id && x.col === c.id).map((x) => x.text.replace(/\s*\n\s*/g, " ")).join(" ")));
  const grid = enginePrediction(model).grid ?? [];
  const sections = model.rows.filter((r) => r.role === "body" || r.role === "section").map((r) => r.role === "section");
  const ncols = cols.length;
  const rows = grid.map((cells, i) => (sections[i] && cells.length === 1 ? { cells, section: true as const } : { cells: [...cells, ...new Array<string>(Math.max(0, ncols - cells.length)).fill("")].slice(0, Math.max(ncols, 1)) }));
  const tagIdx = model.tag ? cols.findIndex((c) => c.id === model.tag!.col) : -1;
  return tabOf({ headerRows: header, rows }, tagIdx >= 0 ? tagIdx : undefined);
}

/** A first-guess stratum (the labeller's conventions, §6.1); tagged `import` so it can be relabelled. */
export function stratumOf(type: string, gold: GoldSet, slice: SliceFile, truth: TabTruth | ParaTruth): string {
  if (gold === "G-PARA") return type === "spec" ? "spec-hierarchy" : "notes";
  const shapes = (slice.shapes ?? []).length > 0;
  if (type === "keynote") return shapes ? "keynote-legend-shapes" : "kv-legend";
  if (type === "legend") return "symbol-legend";
  if ("rows" in truth && truth.headerRows.length > 1) return "two-tier-wrapped";
  if (shapes) return "shape-tag-schedule";
  return ((slice.page as { tables?: unknown[] }).tables ?? []).length ? "ruled-no-shape" : "unruled";
}

// ─── one bundle ──────────────────────────────────────────────────────────────

interface BundlePage { pageNumber: number; drawingNumber?: string | null; textractData?: unknown; pageIntelligence?: unknown }
export interface Bundle { schemaVersion?: string; project?: { publicId?: string; projectIntelligence?: unknown }; pages?: BundlePage[]; annotations?: unknown[] }

export interface ImportResult { lines: GoldLine[]; slices: Map<string, SliceFile>; labels: AppLabel[]; queue: { goldId: string; reason: string }[]; counts: Record<string, number> }

const regionBox = (b: unknown): MinMax | null => (Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === "number" && Number.isFinite(v)) && b[2] > b[0] && b[3] > b[1]
  ? b.map((v) => Math.max(0, Math.min(1, v))) as MinMax : null);

/** True when the bundle holds any owner label (parse labels, proposal verdicts or tag maps). */
export function hasAppLabels(b: Bundle): boolean {
  const nonEmpty = (v: unknown) => isObj(v) && Object.keys(v).length > 0;
  return (b.pages ?? []).some((p) => isObj(p.pageIntelligence) && (nonEmpty(p.pageIntelligence.parseLabels) || nonEmpty(p.pageIntelligence.proposalVerdicts)))
    || (isObj(b.project?.projectIntelligence) && nonEmpty((b.project!.projectIntelligence as Rec).tagMaps));
}

/** Every owner label in one bundle → gold lines, label records and the owner queue (pure; no IO). */
export function importBundle(bundle: Bundle, setId: string, pid: string): ImportResult {
  const out: ImportResult = { lines: [], slices: new Map(), labels: [], queue: [], counts: {} };
  const bump = (k: string) => { out.counts[k] = (out.counts[k] ?? 0) + 1; };
  const anns = (bundle.annotations ?? []) as Parameters<typeof cutSlice>[4];
  const tableGold = new Map<string, string>(); // regionId → G-TAB goldId (for tag maps)
  for (const page of bundle.pages ?? []) {
    const pi = isObj(page.pageIntelligence) ? page.pageIntelligence : {};
    const regions = Array.isArray(pi.parsedRegions) ? (pi.parsedRegions as unknown[]).filter(isObj) : [];
    const labels = isObj(pi.parseLabels) ? pi.parseLabels : {};
    for (const regionId of Object.keys(labels).sort()) {
      const raw = labels[regionId];
      if (!isObj(raw) || typeof raw.verdict !== "string" || typeof raw.snapshotHash !== "string") { bump("parse: malformed label"); continue; }
      const region = regions.find((r) => r.id === regionId) ?? null;
      const label = effectiveParseLabel(raw as unknown as ParseLabel, region as never);
      const base: AppLabel = {
        schema: "bp-app-label/1", type: "parse", setId, page: page.pageNumber, verdict: label.verdict, adjudicated: false, reason: "",
        kind: label.kind, source: label.source, snapshotHash: label.snapshotHash,
        ...(label.proposalId ? { proposalId: label.proposalId } : {}), ...(label.secondsToAccept !== undefined ? { secondsToAccept: label.secondsToAccept } : {}),
        ...(label.missedDetection ? { missedDetection: true as const } : {}), ...(label.ops ? { ops: label.ops } : {}),
      };
      if (!region) { out.labels.push({ ...base, reason: "region gone (orphan label)" }); bump("parse: orphan"); continue; }
      if (label.verdict === "wrong") { out.labels.push({ ...base, adjudicated: true, reason: "negative: the stored machine snapshot is wrong" }); bump("parse: wrong (negative)"); continue; }
      const adjudicated = label.verdict === "correct" || label.verdict === "committed";
      if (!adjudicated && label.verdict !== "corrected") { out.labels.push({ ...base, reason: `verdict ${label.verdict} not imported` }); bump(`parse: ${label.verdict} skipped`); continue; }
      const t = regionTruth(region);
      const box = regionBox(region.bbox);
      if (!t || !box) { out.labels.push({ ...base, reason: "region data unusable as truth" }); bump("parse: no truth"); continue; }
      const goldId = `${t.gold === "G-TAB" ? "tab" : "para"}-app-${hash(`${pid}|${regionId}|${label.snapshotHash}|${label.verdict}`)}`;
      const slice = cutSlice(`prv-${goldId}`, "import", box, page as Parameters<typeof cutSlice>[3], anns);
      if (!slice) { out.labels.push({ ...base, reason: "no page evidence (no Textract words / lines)" }); bump("parse: no page evidence"); continue; }
      const stratum = stratumOf(str(region.type), t.gold, slice, t.truth);
      slice.kind = stratum;
      slice.title = `private ${stratum} app-label slice`;
      const common = {
        schema: "bp-gold/1" as const, goldId, setId, page: page.pageNumber, sheet: page.drawingNumber ?? null, stratum, tags: ["import"],
        labellers: [adjudicated ? "owner:app" : "app:corrected"], adjudicated, protocol: "v1" as const, mode: "import" as const, sliceId: slice.id, region: box,
      };
      const line = (t.gold === "G-TAB" ? { ...common, gold: "G-TAB", truth: t.truth } : { ...common, gold: "G-PARA", truth: t.truth }) as GoldLine;
      out.lines.push(line);
      out.slices.set(slice.id, slice);
      if (t.gold === "G-TAB") tableGold.set(regionId, goldId);
      const reason = adjudicated ? `${label.verdict}: owner truth` : `corrected: the region changed after a ${label.was ?? "verdict"}; an edit and a same-id re-parse look alike (owner queue)`;
      out.labels.push({ ...base, goldId, adjudicated, reason });
      if (!adjudicated) out.queue.push({ goldId, reason });
      bump(`parse: ${label.verdict}${adjudicated ? "" : " (queued)"}`);
    }
    const verdicts = isObj(pi.proposalVerdicts) ? pi.proposalVerdicts : {};
    for (const pidKey of Object.keys(verdicts).sort()) {
      const v = verdicts[pidKey];
      if (!isObj(v) || typeof v.verdict !== "string") { bump("proposal: malformed"); continue; }
      const weak = v.via === "parse" && v.verdict === "accept";
      out.labels.push({
        schema: "bp-app-label/1", type: "proposal", setId, page: page.pageNumber, verdict: v.verdict, adjudicated: !weak,
        reason: weak ? "accept posted by the save of a parse from this proposal: a table, not a confirmed class (K58)" : "owner verdict",
        proposalId: pidKey, recipeId: str(v.recipeId), classId: typeof v.classId === "string" ? v.classId : null,
        proposedClassId: typeof v.proposedClassId === "string" ? v.proposedClassId : null, ...(weak ? { weak: true, weight: PARSE_ACCEPT_WEIGHT } : {}),
      });
      bump(`proposal: ${v.verdict}${weak ? " (via parse, weak)" : ""}`);
    }
  }
  // tag statuses (PJ.tagMaps, TP-4): records per reviewed instance; a G-TAGMAP line for an imported table
  const tagMaps = isObj(bundle.project?.projectIntelligence) && isObj((bundle.project!.projectIntelligence as Rec).tagMaps) ? (bundle.project!.projectIntelligence as Rec).tagMaps as Rec : {};
  for (const regionId of Object.keys(tagMaps).sort()) {
    const m = tagMaps[regionId];
    if (!isObj(m) || !isObj(m.defs)) { bump("tag: malformed map"); continue; }
    let auto = 0;
    const tags: { tag: string; instances: { page: number; bbox: MinMax }[] }[] = [];
    for (const def of Object.values(m.defs).filter(isObj)) {
      const inst = Array.isArray(def.instances) ? def.instances.filter(isObj) : [];
      const confirmed: { page: number; bbox: MinMax }[] = [];
      for (const i of inst) {
        const status = str(i.status);
        if (status === "auto") { auto++; continue; }
        out.labels.push({ schema: "bp-app-label/1", type: "tag-instance", setId, page: Number(i.page) || 0, verdict: status, status, adjudicated: true, reason: "owner tag review", tagMap: regionId, ...(tableGold.has(regionId) ? { goldId: tableGold.get(regionId) } : {}) });
        bump(`tag: ${status}`);
        const b = regionBox(i.b);
        if (status === "confirmed" && b && Number.isInteger(i.page) && Number(i.page) >= 1) confirmed.push({ page: Number(i.page), bbox: b });
      }
      if (str(def.text).trim() && (confirmed.length || inst.some((i) => i.status === "rejected"))) tags.push({ tag: str(def.text), instances: confirmed });
    }
    const table = tableGold.get(regionId);
    if (!table || !tags.length) { if (tags.length) bump("tag: map of a table not imported"); continue; }
    const page = Number(m.page) || 1;
    const goldId = `tagmap-app-${hash(`${pid}|${regionId}|${table}`)}`;
    const adjudicated = auto === 0;
    const tableLine = out.lines.find((l) => l.goldId === table)!;
    out.lines.push({
      schema: "bp-gold/1", gold: "G-TAGMAP", goldId, setId, page, sheet: tableLine.sheet ?? null, stratum: m.scope === "sheet" ? "keynote-sheet" : "schedule-project",
      tags: ["import"], labellers: [adjudicated ? "owner:app" : "app:partial-review"], adjudicated, protocol: "v1", mode: "import", region: tableLine.region,
      truth: { table, scope: m.scope === "sheet" ? "sheet" : "project", tags },
    } as GoldLine);
    if (!adjudicated) out.queue.push({ goldId, reason: `${auto} instance(s) still auto (unreviewed)` });
    bump(adjudicated ? "tagmap: adjudicated" : "tagmap: queued (partial review)");
  }
  return out;
}

// ─── IO ──────────────────────────────────────────────────────────────────────

function bundleFiles(arg: string): string[] {
  return arg.split(",").flatMap((p) => {
    const abs = resolve(p);
    if (!existsSync(abs)) throw new Error(`--bundles ${p}: not found`);
    return statSync(abs).isDirectory() ? readdirSync(abs).filter((f) => f.endsWith(".json")).sort().map((f) => join(abs, f)) : [abs];
  });
}

/** Merge adjudicated lines into <dir>/gold/<G>.v1.jsonl (same goldId replaced). Refuses a gold file with problems. */
export function mergeIntoGold(privateDir: string, lines: readonly GoldLine[]): Record<string, number> {
  const merged: Record<string, number> = {};
  const all: Record<string, GoldLine[]> = {};
  for (const g of GOLD_SETS) {
    const f = join(privateDir, "gold", `${g}.v1.jsonl`);
    const existing = existsSync(f) ? readJsonl(f) : [];
    const { lines: ls, problems } = validateRecords(existing);
    if (problems.length) throw new Error(`${f}: ${problems.length} problems — fix with validate.ts first (first: ${problems[0]})`);
    all[g] = ls;
  }
  const known = new Set(Object.values(all).flat().filter((l) => l.gold === "G-TAB").map((l) => l.goldId));
  for (const g of GOLD_SETS) {
    const add = lines.filter((l) => l.gold === g && l.adjudicated);
    if (!add.length) continue;
    const ids = new Set(add.map((l) => l.goldId));
    const next = [...all[g].filter((l) => !ids.has(l.goldId)), ...add].sort((a, b) => (a.goldId < b.goldId ? -1 : 1));
    const { problems } = validateRecords(next, known);
    if (problems.length) throw new Error(`merge into ${g}: ${problems.length} problems (first: ${problems[0]})`);
    const f = join(privateDir, "gold", `${g}.v1.jsonl`);
    if (existsSync(f)) writePrivate(`${f}.bak`, readFileSync(f, "utf8"), privateDir);
    writePrivate(f, toJsonl(next), privateDir);
    merged[g] = add.length;
  }
  return merged;
}

export function main(argv: readonly string[]): number {
  const batch = argOf(argv, "batch"), bundles = argOf(argv, "bundles");
  if (!batch || !bundles || !/^[a-z0-9-]+$/.test(batch)) {
    console.error("usage: import-app-labels.ts --batch <name, [a-z0-9-]> --bundles <file|dir>[,…] [--private-dir d] [--merge]");
    return 2;
  }
  const privateDir = privateDirOf(argOf(argv, "private-dir"));
  const files = bundleFiles(bundles);
  const research = argOf(argv, "research");
  const sets = readSetMap(privateDir, research === "none" ? null : research ?? DEFAULT_RESEARCH);
  const valid = files.map((f) => JSON.parse(readFileSync(f, "utf8")) as Bundle).filter((b) => b.schemaVersion === "bp-export/1" && b.project?.publicId);
  // only a bundle with owner labels gets (and persists) a set number
  const parsed = valid.filter(hasAppLabels);
  const added = assignSets(sets, parsed.map((b) => b.project!.publicId!));
  const all: ImportResult = { lines: [], slices: new Map(), labels: [], queue: [], counts: { bundles: valid.length, "bundles with owner labels": parsed.length, "bundles skipped (not bp-export/1)": files.length - valid.length } };
  for (const b of parsed) {
    const pid = b.project!.publicId!;
    const r = importBundle(b, sets.get(pid)!, pid);
    all.lines.push(...r.lines); all.labels.push(...r.labels); all.queue.push(...r.queue);
    for (const [k, v] of r.slices) all.slices.set(k, v);
    for (const [k, n] of Object.entries(r.counts)) all.counts[k] = (all.counts[k] ?? 0) + n;
  }
  const { problems } = validateRecords(all.lines);
  if (problems.length) { console.error(`import-app-labels: ${problems.length} schema problems (first: ${problems[0]})`); return 1; }
  const dir = join(privateDir, "gold", "imports", batch);
  for (const [id, s] of all.slices) writePrivate(join(privateDir, "slices", `${id}.json`), JSON.stringify(s) + "\n", privateDir);
  for (const g of GOLD_SETS) writePrivate(join(dir, `${g}.v1.jsonl`), toJsonl(all.lines.filter((l) => l.gold === g)), privateDir);
  writePrivate(join(dir, "labels.v1.jsonl"), toJsonl(all.labels), privateDir);
  writePrivate(join(dir, "queue.json"), JSON.stringify(all.queue, null, 1) + "\n", privateDir);
  writePrivate(join(dir, "summary.json"), JSON.stringify(all.counts, null, 1) + "\n", privateDir);
  if (added.length) {
    const f = join(privateDir, "gold", "imports", "set-map.json");
    const prev = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) as Record<string, string> : {};
    for (const pid of added) prev[pid] = sets.get(pid)!;
    writePrivate(f, JSON.stringify(prev, null, 1) + "\n", privateDir);
  }
  const merged = argv.includes("--merge") ? mergeIntoGold(privateDir, all.lines) : {};
  const adj = all.lines.filter((l) => l.adjudicated).length;
  console.log(`import-app-labels: ${all.lines.length} gold lines (${adj} adjudicated, ${all.queue.length} queued), ${all.labels.length} label records, ${added.length} new set(s) → ${dir}` +
    (argv.includes("--merge") ? `; merged ${JSON.stringify(merged)}` : "; not merged (pass --merge)"));
  console.log(JSON.stringify(all.counts));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
