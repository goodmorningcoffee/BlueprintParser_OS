/**
 * gold-lib.ts — shared core of the table-pipeline gold tools (WP-2.G; PLAN §6.1).
 *
 * Gold holds REAL drawing text, so it lives only in the private docs repo. Every gold tool reads and writes
 * only under the private dir (`--private-dir`, else `$BP_PRIVATE_GOLD_DIR`, else the docs-repo default below)
 * and refuses any path inside a BP2 checkout (PLAN §1.6 rule 12). Nothing here prints drawing text.
 *
 * Private dir layout (one root, the same env var the 2.0a private goldens read):
 *   <dir>/slices/<sliceId>.json          page slices (`bp-parse-fixture/1`), shared with the 2.0a private goldens
 *   <dir>/gold/<G-SET>.v1.jsonl          adjudicated gold, one `bp-gold/1` line per unit
 *   <dir>/gold/batches/<batch>/…         sample.json, prefill.jsonl, packs/, labels/, adjudication/
 *   <dir>/reports/                       parse-engine-measure reports (numbers + opaque ids)
 *
 * The line format (`bp-gold/1`): `{schema, gold, goldId, setId, page, sheet?, stratum, tags?, labellers[],
 * adjudicated, protocol:"v1", mode?, sliceId?, region, truth}` where `truth` depends on `gold`:
 *   G-TAB    {headerRows: string[][], rows: {cells: string[], section?: true}[], colEdges?, rowEdges?, tagColumn?}
 *   G-PARA   {items: {key, text, level?, header?, bbox?}[]}           (reading order)
 *   G-TAGMAP {table: <G-TAB goldId>, scope: "project"|"sheet", tags: {tag, qty?, instances: {page, bbox}[]}[]}
 * G-ROW is derived from G-TAB (rows + rowEdges), so it has no file of its own.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

export const DEFAULT_PRIVATE_DIR = "/workspaces/projects/gitignore/projects/table_pipeline/fixtures_private";

/** The private dir: `--private-dir`, else `$BP_PRIVATE_GOLD_DIR`, else the docs-repo default. */
export function privateDirOf(arg?: string | null, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(arg || env.BP_PRIVATE_GOLD_DIR || DEFAULT_PRIVATE_DIR);
}

// ─── the write guard ─────────────────────────────────────────────────────────

/** Paths that mark a BP2 checkout (the same markers as parse-engine-fixtures/synthesize.ts). */
const BP2_MARKERS = ["scripts/prepush-check.sh", "src/components/viewer", "scripts/parse-engine-fixtures/synthesize.ts"];

/** Real path of `p`, resolving symlinks on its deepest existing ancestor (the file itself may not exist yet). */
function realish(p: string): string {
  let dir = resolve(p);
  const rest: string[] = [];
  while (!existsSync(dir) && dirname(dir) !== dir) { rest.unshift(basename(dir)); dir = dirname(dir); }
  return join(realpathSync(dir), ...rest);
}

const within = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
};

/** True when `p` (or any ancestor) is a BP2 checkout or worktree. */
export function insideBp2Checkout(p: string): boolean {
  for (let d = realish(p); ; d = dirname(d)) {
    if (BP2_MARKERS.some((m) => existsSync(join(d, m)))) return true;
    if (dirname(d) === d) return false;
  }
}

/** Why a gold tool may not write `target`, or null. `requireUnder` (default on) also confines it to the private dir. */
export function refuseWrite(target: string, privateDir: string, requireUnder = true): string | null {
  if (insideBp2Checkout(privateDir)) return `the private dir ${privateDir} is inside a BP2 checkout; gold holds real drawing text and stays in the docs repo`;
  if (insideBp2Checkout(target)) return `${target} is inside a BP2 checkout; gold tools never write there (PLAN §1.6 rule 12)`;
  if (requireUnder && !within(realish(target), realish(privateDir))) return `${target} is outside the private dir ${privateDir}`;
  return null;
}

/** Write `content` to `target` after the guard; throws with the reason when refused. */
export function writePrivate(target: string, content: string, privateDir: string, requireUnder = true): void {
  const refused = refuseWrite(target, privateDir, requireUnder);
  if (refused) throw new Error(`refused: ${refused}`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

// ─── canonical JSON / JSONL ──────────────────────────────────────────────────

/** JSON with object keys sorted (recursively) and undefined dropped, so a parse → serialize round trip is byte-equal. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) out[k] = norm(x);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

export const toJsonl = (records: readonly unknown[]): string => records.map((r) => canonicalJson(r)).join("\n") + (records.length ? "\n" : "");

/** Parse a JSONL file; blank lines skipped. Throws with the line number on malformed JSON. */
export function readJsonl(file: string): unknown[] {
  const out: unknown[] = [];
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try { out.push(JSON.parse(line)); } catch (e) { throw new Error(`${file}:${i + 1}: malformed JSON (${(e as Error).message})`); }
  });
  return out;
}

// ─── deterministic randomness ────────────────────────────────────────────────

/** mulberry32: a seeded PRNG in [0, 1). The same seed gives the same stream on every machine. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates with a seeded PRNG (a copy; the input is untouched). */
export function seededShuffle<T>(xs: readonly T[], rand: () => number): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── the gold line schema ────────────────────────────────────────────────────

export const GOLD_SETS = ["G-TAB", "G-PARA", "G-TAGMAP"] as const;
export type GoldSet = (typeof GOLD_SETS)[number];
export const GOLD_ID_PREFIX: Record<GoldSet, string> = { "G-TAB": "tab", "G-PARA": "para", "G-TAGMAP": "tagmap" };

/** Primary strata per gold set (PLAN §6.1). Secondary strata go in `tags`. */
export const STRATA: Record<GoldSet, readonly string[]> = {
  "G-TAB": ["shape-tag-schedule", "keynote-legend-shapes", "symbol-legend", "kv-legend", "ruled-no-shape", "unruled", "two-tier-wrapped", "continued-split"],
  "G-PARA": ["spec-hierarchy", "multi-column-notes", "notes"],
  "G-TAGMAP": ["schedule-project", "keynote-sheet"],
};

const unit = z.number().min(0).max(1);
export const MinMaxSchema = z.tuple([unit, unit, unit, unit]).refine((b) => b[0] < b[2] && b[1] < b[3], "bbox must be [x0,y0,x1,y1] with x0 < x1 and y0 < y1");
const increasing = (xs: readonly number[]): boolean => xs.every((v, i) => i === 0 || v > xs[i - 1]);
const edges = z.array(unit).min(2).refine(increasing, "edges must be strictly increasing");

const base = {
  schema: z.literal("bp-gold/1"),
  goldId: z.string().regex(/^(tab|para|tagmap)-[0-9a-z]+(-[0-9a-z]+)*$/, "goldId: <tab|para|tagmap>-<opaque>"),
  setId: z.string().regex(/^set-\d+$/, "setId: set-<n> (opaque set number; odd/even by n)"),
  page: z.number().int().min(1),
  sheet: z.string().nullable().optional(),
  stratum: z.string(),
  tags: z.array(z.string().regex(/^[a-z0-9-]+$/)).optional(),
  labellers: z.array(z.string().regex(/^[A-Za-z0-9:._-]+$/)).min(1),
  adjudicated: z.boolean(),
  protocol: z.literal("v1"),
  mode: z.enum(["prefill", "scratch", "owner", "import", "synthetic"]).optional(),
  sliceId: z.string().regex(/^(prv|syn)-[0-9a-z-]+$/).optional(),
  region: MinMaxSchema,
};

export const TabTruthSchema = z.object({
  headerRows: z.array(z.array(z.string())).max(4),
  rows: z.array(z.object({ cells: z.array(z.string()).min(1), section: z.literal(true).optional() }).strict()).min(1),
  colEdges: edges.optional(),
  rowEdges: edges.optional(),
  tagColumn: z.number().int().min(0).nullable().optional(),
}).strict();

export const ParaTruthSchema = z.object({
  items: z.array(z.object({
    key: z.string(), text: z.string(), level: z.number().int().min(0).optional(), header: z.boolean().optional(), bbox: MinMaxSchema.optional(),
  }).strict()).min(1),
}).strict();

export const TagmapTruthSchema = z.object({
  table: z.string().regex(/^tab-[0-9a-z]+(-[0-9a-z]+)*$/),
  scope: z.enum(["project", "sheet"]),
  tags: z.array(z.object({
    tag: z.string().min(1), qty: z.number().int().min(0).optional(),
    instances: z.array(z.object({ page: z.number().int().min(1), bbox: MinMaxSchema }).strict()),
  }).strict()).min(1),
}).strict();

export const GoldLineSchema = z.discriminatedUnion("gold", [
  z.object({ ...base, gold: z.literal("G-TAB"), truth: TabTruthSchema }).strict(),
  z.object({ ...base, gold: z.literal("G-PARA"), truth: ParaTruthSchema }).strict(),
  z.object({ ...base, gold: z.literal("G-TAGMAP"), truth: TagmapTruthSchema }).strict(),
]);
export type GoldLine = z.infer<typeof GoldLineSchema>;
export type TabLine = Extract<GoldLine, { gold: "G-TAB" }>;
export type ParaLine = Extract<GoldLine, { gold: "G-PARA" }>;
export type TagmapLine = Extract<GoldLine, { gold: "G-TAGMAP" }>;
export type TabTruth = TabLine["truth"];
export type ParaTruth = ParaLine["truth"];

/** The set number behind an opaque `set-<n>` id; parity decides the odd (fit) / even (held-out) split. */
export const setNumber = (setId: string): number => Number(setId.replace(/^set-/, ""));
export const setParity = (setId: string): "odd" | "even" => (setNumber(setId) % 2 === 1 ? "odd" : "even");
export const inSplit = (setId: string, sets: string): boolean => sets === "all" || setParity(setId) === sets;

/** Semantic checks the schema cannot express on one line. Returns problems (empty = valid). */
export function lineProblems(l: GoldLine): string[] {
  const p: string[] = [];
  if (!l.goldId.startsWith(`${GOLD_ID_PREFIX[l.gold]}-`)) p.push(`goldId ${l.goldId} does not start with ${GOLD_ID_PREFIX[l.gold]}-`);
  if (!STRATA[l.gold].includes(l.stratum)) p.push(`stratum "${l.stratum}" is not one of ${STRATA[l.gold].join(", ")}`);
  if (l.adjudicated && l.labellers.length < 2 && !l.labellers.some((x) => x.startsWith("owner"))) {
    p.push("adjudicated needs two labellers or an owner decision");
  }
  if (l.gold === "G-TAB") {
    const t = l.truth;
    const ncols = Math.max(...t.headerRows.map((r) => r.length), ...t.rows.filter((r) => !r.section).map((r) => r.cells.length), 0);
    t.headerRows.forEach((r, i) => { if (r.length !== ncols) p.push(`headerRows[${i}] has ${r.length} cells, the table has ${ncols} columns`); });
    t.rows.forEach((r, i) => {
      if (r.section ? r.cells.length !== 1 && r.cells.length !== ncols : r.cells.length !== ncols) p.push(`rows[${i}] has ${r.cells.length} cells, the table has ${ncols} columns`);
    });
    if (t.colEdges && t.colEdges.length !== ncols + 1) p.push(`colEdges has ${t.colEdges.length} edges, ${ncols} columns need ${ncols + 1}`);
    const nRows = t.headerRows.length + t.rows.length;
    if (t.rowEdges && t.rowEdges.length !== nRows + 1) p.push(`rowEdges has ${t.rowEdges.length} edges, ${nRows} rows (header + body) need ${nRows + 1}`);
    if (t.tagColumn != null && t.tagColumn >= ncols) p.push(`tagColumn ${t.tagColumn} ≥ ${ncols} columns`);
  }
  return p;
}

/** Validate raw records: schema + semantics + uniqueness + G-TAGMAP references. Problems carry the line number. */
export function validateRecords(records: readonly unknown[], knownTables: ReadonlySet<string> = new Set()): { lines: GoldLine[]; problems: string[] } {
  const lines: GoldLine[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  records.forEach((r, i) => {
    const parsed = GoldLineSchema.safeParse(r);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) problems.push(`line ${i + 1}: ${issue.path.join(".") || "(line)"}: ${issue.message}`);
      return;
    }
    const l = parsed.data;
    for (const msg of lineProblems(l)) problems.push(`line ${i + 1} ${l.goldId}: ${msg}`);
    if (seen.has(l.goldId)) problems.push(`line ${i + 1}: duplicate goldId ${l.goldId}`);
    seen.add(l.goldId);
    lines.push(l);
  });
  const tables = new Set([...knownTables, ...lines.filter((l) => l.gold === "G-TAB").map((l) => l.goldId)]);
  for (const l of lines) {
    if (l.gold === "G-TAGMAP" && !tables.has(l.truth.table)) problems.push(`${l.goldId}: truth.table ${l.truth.table} names no G-TAB line`);
  }
  return { lines, problems };
}

/** Text normalisation used by every comparison: NFKC, upper case, whitespace collapsed. */
export const normText = (s: string): string => s.normalize("NFKC").toUpperCase().replace(/\s+/g, " ").trim();
/** Key normalisation: `1.` = `1` = `(1)`; `A.` = `a`. */
export const normKey = (s: string): string => normText(s).replace(/^[([]+|[)\].:]+$/g, "").trim();

/** CLI helper: the value after `--name`, or undefined. */
export function argOf(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
