/**
 * build-kb-v2.ts — MasterFormat 2018 PDF + TSVs → src/data/csi-kb.json (CSI tagger v2, step S2).
 *
 * Spec: PLAN.md §5.2–§5.6, IMPLEMENTATION.md §II S2 and §IV E2, E3, E6, E7, E12 (D1–D7, E12a–d).
 * The KB is REGENERATED from the PDF on every run (E12: never trust build/); nothing under
 * build/ is read. Inputs, each hashed (raw bytes) into `header.sources`:
 *   - the MasterFormat PDF (parsed here with `eval/csi/mf-parse.ts`; skipped by the runtime check)
 *   - `src/data/csi-masterformat.tsv` (trade, TSV titles → aliases, TSV-only codes per D5)
 *   - `src/data/csi.tsv` (hash only in S2; its alt titles are add-on P7)
 *   - `src/data/csi_terms.tsv` (the ONE curated table, `source:'term'`)
 *   - `src/lib/csi-tokenize.ts` (the tokenizer IS an input: a fold change re-shapes every token)
 *
 * Pipeline (each step names the rule it implements):
 *   1. codes   — master codes minus "Unassigned"; TSV-only codes kept per D5 (a TSV-only title whose
 *                token set equals ANY master title is dropped — E12e); `parentOf` by digit shape
 *                skipping absent codes; titles per PLAN §5.2 (PDF wins, `^(for|see)` → TSV).
 *   2. sources — title · index phrase (set) · alt term · see synonym (D7) · term row · tsv (D5).
 *   3. folds   — FOLD ALWAYS (owner ruling 2026-10-20, kb-v2.4): every source string is tokenized
 *                with the vocab OMITTED, so every FOLD_MAP word form folds (replaces E12b's V0 gate).
 *                Stored tokens are unique per pattern, in first-occurrence order.
 *   4. filters — a term row owns its set (E13); a code's MF title owns its set against other codes'
 *                alt/index/see, process titles (div 40–49) excepted for building codes (kb-v2.4);
 *                empty, ≤2-char (non-term, PLAN §5.3), index facet rows (sub-entry text ⊆ head, E12e),
 *                alt/index/see ≡ a descendant's title (D6 as extended by E12e), dedupe (E12c);
 *                S5 (kb-v2.5): a title that lost a one-letter word owns nothing and every pattern of
 *                its code with its reduced set is dropped; CURATED_DROPS (measured wrong on drawings).
 *   5. weights — codeDF over every token source; idf = ln(N/codeDF); floor = codeDF ≥ 200;
 *                boilerplate and filler as CANONICAL tokens (D4); anchor = rarest non-floored
 *                NON-FILLER token, else the rarest non-floored filler token (E12e), else null.
 *   6. lattice — E3 subset enumeration (n ≤ 10, else a posting scan); up = maximal subsets of OTHER
 *                codes; E2 diff; filler never in diff; E6 hintOnly. Regex rows stay out (E12c).
 *   7. gate    — PLAN §5.6 / E12a report counters must be 0 (the two reach counters are printed).
 *
 * Usage (from blueprintparser_2/; the outfile MUST contain `csi-kbv2` — see the guard below):
 *   npx esbuild eval/csi/build-kb-v2.ts --bundle --platform=node --target=node24 \
 *     --alias:@=./src --external:pg-native --outfile=build/csi-kbv2-build.js
 *   node build/csi-kbv2-build.js [pdfPath]
 * Writes `src/data/csi-kb.json` (gitignored, see below) and `eval/csi/kb-report.json` (numbers only,
 * tracked: counts, hashes and single-token frequencies — no MasterFormat phrase).
 *
 * Why `src/data/csi-kb.json` is not in git (owner ruling D1, 2026-10-20): it holds ~11,500 keyword
 * phrases taken from the MasterFormat PDF, which are not redistributed on the public GitHub repo.
 * It is "gitignored but shipped": the anchored `/src/data/csi-kb.json` line in .gitignore keeps it
 * out (scripts/prepush-check.sh refuses a push that tracks it, ever added it, or whose committed
 * .gitignore lacks that line), and the image still carries it because it is built from the working
 * tree. A fresh clone has no copy: put the PDF at `DEFAULT_PDF` (eval/csi/mf-parse.ts:
 * `../../gitignore/csi_masterformat.pdf` from the repo root, or set BP_MF_PDF) or pass its path,
 * then run the two Usage commands above. Without it the KB tests skip (announced by
 * src/test/global-setup.ts; a failure under BP_REQUIRE_CSI_KB=1) and no image builds: the
 * Dockerfile runs scripts/verify-csi-kb.mjs, which also refuses a stub or a KB stale against the
 * tree's TSVs or tokenizer, and deploy-aws.sh runs it before release/bootstrap touch docker or AWS.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { indexForms, tokenize } from "@/lib/csi-tokenize";
import type { CsiKb, CsiKbHeader, KbCode, KbPattern, KbSource } from "@/lib/csi-kb-types";
import { DEFAULT_PDF, REJECT_TITLE_RE, TITLE_STRIP_RE, dedupeAdjacentWords, extractPages, levelOf, parseDocument, stripTitle, type MfParsed } from "./mf-parse";

/** Manual constant (D3): bump on ANY builder-logic change; the artifact test pins it. */
export const BUILDER_VERSION = "kb-v2.5";
export const SCHEMA_VERSION = "csi-kb/2" as const;
export const KB_OUT = "src/data/csi-kb.json";
export const REPORT_OUT = "eval/csi/kb-report.json";
export const PDF_SOURCE = "csi_masterformat.pdf";
/** Repo-relative inputs hashed into `header.sources`, in header order after the PDF. */
export const SOURCE_PATHS = [
  "src/data/csi-masterformat.tsv",
  "src/data/csi.tsv",
  "src/data/csi_terms.tsv",
  "src/lib/csi-tokenize.ts",
] as const;

// ── constants (PLAN §12; tags: guess unless noted) ──
export const FLOOR_DF = 200;                       // guess (D2), swept in S5
export const FILLER_FACTOR = 0.5;                  // guess
export const MAX_ENUM_TOKENS = 10;                 // E3
export const SEE_MAX_FANOUT = 3;                   // D7
export const FILLER_WORDS = ["system", "assembly", "accessory", "equipment", "work", "product", "common", "result"]; // D4
export const BOILERPLATE_WORDS = [
  "provide", "contractor", "work", "existing", "see", "required", "general", "project", "drawing",
  "plan", "detail", "scale", "type", "location", "all", "any", "new", "no",
]; // PLAN §5.5
/** S5 (kb-v2.5, logs/s5-20261021T0510Z-tuning-variants.txt row e4): a one-letter word other than
 *  "a" that the tokenizer drops ("Wood I-Joists" → {wood, joist}). Such a title's reduced token set
 *  says less than the title, so it owns nothing (title-owns rule), and when another code prints that
 *  set too, every pattern of its code with the set is dropped (3× WOOD JOISTS: 06 17 33 → 06 11 00
 *  Wood Framing, W3 → R3). */
export const LOST_LETTER_RE = /(^|[\s\-\/(])[B-Zb-z](?=[\s\-\/),]|$)/;
/** S5 (kb-v2.5): patterns judged wrong on drawings, dropped by (code, sorted canonical token set),
 *  every source. Measured rows of logs/s5-20261021T0510Z-tuning-variants.txt: b (05 45 00 −9 W9;
 *  33 82 63.16 −8 W8; 28 40 00 −13 W7 D3 R3) and j (07 80 00 −16 W13 D3: on drawings "fire
 *  protection" means sprinkler / NFPA, not Fire and Smoke Protection); gold Δ 0 or −1 FP each.
 *  A dropped title still owns its set against other codes (it did in the measured KB). */
export const CURATED_DROPS: readonly (readonly [code: string, setKey: string])[] = [
  ["05 45 00", "device mount"],
  ["07 80 00", "fire protection"],
  ["28 40 00", "life safety"],
  ["33 82 63.16", "control panel"],
];
/** D5: a TSV-only title that is junk (a code, the index banner, `api`, no letters). */
export const TSV_JUNK_RE = /^\d\d \d\d \d\d\b|keyword index|^api$|^[^a-z]*$/i;
const SOURCE_RANK: Record<KbSource, number> = { title: 0, tsv: 1, alt: 2, index: 3, see: 4, term: 5 };
/** Divisions 40–49 (process/industrial). Their MF titles do not own a token set against a
 *  building-division code's alt/index/see (owner ruling 2026-10-20: Hose Bibbs 40 05 81.33 must not
 *  take "hose bibbs" from 22 11 19). */
export const isProcessDivision = (code: string): boolean => code >= "40" && code < "50";

// ───────────────────────────── codes ─────────────────────────────

/** COPIED from v1 `build-kb.ts` (E12d: never imported — that file carries its own argv guard). */
export function canonCode(code: string): string {
  const parts = code.trim().split(/[\s.]+/);
  if (parts.length > 1 && /^\d$/.test(parts[0])) parts[0] = "0" + parts[0];
  return parts.join("").replace(/\D/g, "");
}

/** '081113' → '08 11 13'; '08111313' → '08 11 13.13'. */
export function spaceCode(digits: string): string {
  const base = `${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 6)}`;
  return digits.length > 6 ? `${base}.${digits.slice(6, 8)}` : base;
}

/** PLAN P1: parent by digit shape `.NN → NNNNNN → NNNN00 → NNN000 → NN0000`, skipping codes
 *  `has` does not know. Returns null at a division root (or when no shape ancestor exists). */
export function parentOf(code: string, has: (c: string) => boolean): string | null {
  const d = canonCode(code);
  const six = d.slice(0, 6);
  const chain = [d.length > 6 ? six : "", `${six.slice(0, 4)}00`, `${six.slice(0, 3)}000`, `${six.slice(0, 2)}0000`];
  for (const c of chain) {
    if (!c || c === d) continue;
    const spaced = spaceCode(c);
    if (spaced !== code && has(spaced)) return spaced;
  }
  return null;
}

interface TsvRow { code: string; title: string; trade: string }

/** `csi-masterformat.tsv`: col 2 = 2004 code (unspaced), col 3 = title, col 4 = trade. */
export function readMasterformatTsv(raw: string): Map<string, TsvRow> {
  const out = new Map<string, TsvRow>();
  for (const line of raw.split(/\r?\n/).slice(1)) {
    const c = line.split("\t");
    if (c.length < 6 || !c[2].trim()) continue;
    const code = spaceCode(canonCode(c[2]));
    out.set(code, { code, title: c[3].trim(), trade: c[4].trim() });
  }
  return out;
}

export interface TermRow {
  term: string; code: string; kind: "abbrev" | "vernacular" | "regex"; discipline: string; oneWordOk: boolean; note: string;
  /** oneWordOk `<=N` (S5 d3): the one-word row matches only in a unit of at most N tokens. */
  oneWordMaxUnit?: number;
}
const TERM_HEADER = "term\tcode\tkind\tdiscipline\toneWordOk\tnote";
const DISCIPLINES = new Set(["", "A", "S", "M", "P", "E", "FP", "C"]);

/** `csi_terms.tsv` (IMPLEMENTATION §I). Throws on any malformed row — the table is curated.
 *  oneWordOk is `0`, `1`, or `<=N` (S5, kb-v2.5): one word is enough, but only in a unit of ≤ N tokens. */
export function parseTermsTsv(raw: string): TermRow[] {
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines[0] !== TERM_HEADER) throw new Error(`[kbv2] csi_terms.tsv header must be: ${TERM_HEADER}`);
  return lines.slice(1).map((line, i) => {
    const [term = "", code = "", kind = "", discipline = "", ok = "", note = ""] = line.split("\t");
    const where = `csi_terms.tsv row ${i + 2}`;
    if (!term.trim()) throw new Error(`[kbv2] ${where}: empty term`);
    if (!/^\d\d \d\d \d\d(?:\.\d\d)?$/.test(code)) throw new Error(`[kbv2] ${where}: bad code '${code}'`);
    if (kind !== "abbrev" && kind !== "vernacular" && kind !== "regex") throw new Error(`[kbv2] ${where}: bad kind '${kind}'`);
    if (!DISCIPLINES.has(discipline)) throw new Error(`[kbv2] ${where}: bad discipline '${discipline}'`);
    const cap = /^<=([1-9]\d*)$/.exec(ok);
    if (ok !== "0" && ok !== "1" && !cap) throw new Error(`[kbv2] ${where}: oneWordOk must be 0|1|<=N`);
    if (kind === "regex") new RegExp(term, "i"); // throws on an invalid pattern
    const row: TermRow = { term: term.trim(), code, kind, discipline, oneWordOk: ok !== "0", note };
    if (cap) row.oneWordMaxUnit = Number(cap[1]);
    return row;
  });
}

// ───────────────────────────── helpers ─────────────────────────────

const EMPTY_VOCAB: ReadonlySet<string> = new Set<string>();
const uniq = (xs: string[]) => [...new Set(xs)];
/** Unique tokens, first-occurrence order. `vocab` OMITTED = every FOLD_MAP fold applies (the kb-v2.4
 *  build rule); EMPTY_VOCAB = no word-form fold (D5's pre-vocabulary comparison only). */
const toks = (text: string, vocab?: ReadonlySet<string>) => uniq(tokenize(text, vocab).map((t) => t.t));
const setKey = (ts: string[]) => [...ts].sort().join(" ");
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const norm = (s: string) => s.toLowerCase().replace(/[‐-―]/g, "-").replace(/\s+/g, " ").trim().replace(/[.,;:]+$/, "");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortedRecord = (r: Record<string, number>) =>
  Object.fromEntries(Object.keys(r).sort(cmp).map((k) => [k, r[k]]));
const isSubset = (a: Set<string>, b: Set<string>) => [...a].every((t) => b.has(t));

/** Canonical form of a configured word list (D4: lists are stored as CANONICAL tokens). */
function canonicalList(words: string[], vocab: ReadonlySet<string>, label: string): string[] {
  const out = new Set<string>();
  for (const w of words) {
    const t = toks(w, vocab);
    if (t.length !== 1) throw new Error(`[kbv2] ${label} word '${w}' tokenizes to [${t.join(", ")}], expected one token`);
    out.add(t[0]);
  }
  return [...out].sort(cmp);
}

// ───────────────────────────── build ─────────────────────────────

export interface BuildInputs {
  parsed: MfParsed;
  masterformatTsv: string;
  terms: string;
  sources: { path: string; sha256: string }[];
}

interface Cand {
  code: string; source: KbSource; kind: "tokens" | "regex"; text: string; order: number;
  tokens: string[]; oneWordOk?: boolean; oneWordMaxUnit?: number; discipline?: string; regex?: string;
  /** index rows with a head only: the sub-entry text and its head (for the E12e facet filter). */
  sub?: string; head?: string;
}

export interface BuildResult { kb: CsiKb; codeDF: Map<string, number>; reach: Record<string, number> }

/** PLAN §5.1 goldens, checked on the parse this KB is built from (E12a `misHeadedGoldens`). */
function misHeadedGoldens(parsed: MfParsed): number {
  const ix = parsed.index;
  const ok = [
    ix.some((e) => e.page === 642 && e.code === "03 01 00" && e.phrase === "cleaning, maintenance, concrete"),
    ix.some((e) => e.page === 653 && e.text === "dry cleaning" && e.head !== null && e.head !== "epoxy mortar"),
    ix.some((e) => e.page === 665 && e.code === "23 40 00" && e.phrase === "air cleaning devices, HVAC"),
  ];
  return ok.filter((x) => !x).length;
}

export function buildKb(inp: BuildInputs): BuildResult {
  const { parsed } = inp;
  const counts: Record<string, number> = {};
  const bump = (k: string, n = 1) => { counts[k] = (counts[k] ?? 0) + n; };
  const tsv = readMasterformatTsv(inp.masterformatTsv);
  const termRows = parseTermsTsv(inp.terms);

  // ── 1. codes ──
  const masterAll = new Set(parsed.master.map((e) => e.code));
  const unassigned = new Set(parsed.master.filter((e) => /^unassigned$/i.test(e.title.trim())).map((e) => e.code));
  const master = parsed.master.filter((e) => !unassigned.has(e.code));
  const masterSet = new Set(master.map((e) => e.code));
  counts.unassignedCodes = unassigned.size;
  const titleOf = new Map<string, string>();
  for (const e of master) {
    let title = stripTitle(e.title).title;
    if (!title || REJECT_TITLE_RE.test(title)) {
      title = tsv.get(e.code)?.title ?? "";
      bump("titleFromTsv");
    }
    titleOf.set(e.code, title);
  }
  // D5 (as extended by E12e): TSV-only codes. A TSV-only title is dropped when its token set equals
  // the set of ANY master title (not only a sibling's: 09 62 23 "bamboo flooring" = 09 64 36). The
  // comparison uses UNFOLDED tokens (EMPTY_VOCAB), as in kb-v2.3: the fold-always ruling (§3) left it.
  const tsvOnly = [...tsv.values()].filter((r) => !masterAll.has(r.code)).sort((a, b) => cmp(a.code, b.code));
  counts.tsvOnlyCandidates = tsvOnly.length;
  const masterTitleKeys = new Set(master.map((e) => setKey(toks(titleOf.get(e.code) ?? "", EMPTY_VOCAB))));
  const keptTsv: TsvRow[] = [];
  for (const r of tsvOnly) {
    if (TSV_JUNK_RE.test(r.title)) { bump("tsvOnlyDropped"); continue; }
    const key = setKey(toks(r.title, EMPTY_VOCAB));
    if (!key || masterTitleKeys.has(key)) { bump("tsvOnlyDropped"); continue; }
    keptTsv.push(r);
    titleOf.set(r.code, r.title);
  }
  counts.tsvOnlyKept = keptTsv.length;
  const codeSet = new Set<string>([...masterSet, ...keptTsv.map((r) => r.code)]);
  const has = (c: string) => codeSet.has(c);
  const parent = new Map<string, string | null>();
  for (const c of codeSet) parent.set(c, parentOf(c, has));

  // ── 2. candidate patterns ──
  const cands: Cand[] = [];
  let order = 0;
  const add = (c: Omit<Cand, "order" | "tokens">) => cands.push({ ...c, order: order++, tokens: [] });
  for (const e of master) {
    const title = titleOf.get(e.code) ?? "";
    if (title) add({ code: e.code, source: "title", kind: "tokens", text: title });
  }
  for (const r of keptTsv) add({ code: r.code, source: "tsv", kind: "tokens", text: r.title });
  for (const e of master) for (const a of e.altTerms) add({ code: e.code, source: "alt", kind: "tokens", text: a });
  for (const e of parsed.index) {
    if (unassigned.has(e.code)) { bump("unassignedIndexRows"); continue; }
    if (!has(e.code)) { bump("danglingIndexRows"); continue; }
    add({ code: e.code, source: "index", kind: "tokens", text: e.phrase, ...(e.head ? { sub: e.text, head: e.head } : {}) });
  }
  // D7: "X – see Y" index synonym lines. Resolve Y: index text/phrase → index head → master title.
  const byText = new Map<string, Set<string>>(), byHead = new Map<string, Set<string>>(), byTitle = new Map<string, Set<string>>();
  const put = (m: Map<string, Set<string>>, k: string, c: string) => {
    if (!has(c)) return;
    const s = m.get(k) ?? new Set<string>();
    s.add(c);
    m.set(k, s);
  };
  for (const e of parsed.index) {
    put(byText, norm(e.text), e.code);
    put(byText, norm(e.phrase), e.code);
    if (e.head) put(byHead, norm(e.head), e.code);
  }
  for (const [c, t] of titleOf) put(byTitle, norm(t), c);
  const seeAliases = new Map<string, Set<string>>();
  for (const s of parsed.synonyms) {
    const k = norm(s.to);
    const tier = byText.get(k) ? "Text" : byHead.get(k) ? "Head" : byTitle.get(k) ? "Title" : "";
    const codes = [...((tier === "Text" ? byText : tier === "Head" ? byHead : byTitle).get(k) ?? [])].sort(cmp);
    if (!codes.length) { bump("seeUnresolved"); continue; }
    if (codes.length > SEE_MAX_FANOUT) { bump("seeFanoutDropped"); continue; }
    bump("seeResolved");
    bump(`seeResolvedVia${tier}`);
    for (const c of codes) {
      add({ code: c, source: "see", kind: "tokens", text: s.from });
      const al = seeAliases.get(c) ?? new Set<string>();
      al.add(s.from);
      seeAliases.set(c, al);
    }
  }
  for (const r of termRows) {
    if (!has(r.code)) throw new Error(`[kbv2] csi_terms row '${r.term}' → ${r.code}: code not in the KB`);
    const base = {
      code: r.code, source: "term" as const, text: r.term, oneWordOk: r.oneWordOk,
      ...(r.oneWordMaxUnit ? { oneWordMaxUnit: r.oneWordMaxUnit } : {}), ...(r.discipline ? { discipline: r.discipline } : {}),
    };
    if (r.kind === "regex") add({ ...base, kind: "regex", regex: r.term });
    else add({ ...base, kind: "tokens" });
  }

  // ── 3. folds: FOLD ALWAYS (owner ruling 2026-10-20, kb-v2.4; replaces E12b's two-pass V0 gate) ──
  // Every source string is tokenized with the vocab OMITTED, which `canonToken` defines as "apply
  // every FOLD_MAP fold": FIRESTOPPING → firestop although no source spells FIRESTOP, so the drawing
  // word FIRESTOP reaches 07 84 13. (kb-v2.3 folded only when the stem was itself a pass-1 token.)
  // Runtime contract (E12b, unchanged): the matcher tokenizes with vocab = the KB token set (the
  // loader's `idf` key set) and gets the SAME match. canonToken(w, V) differs from canonToken(w) only
  // for a FOLD_MAP key w whose stem s ∉ V. No stored token is a FOLD_MAP key (every one folded here),
  // so w ∉ V too: both outputs are out-of-vocabulary, one token each at the same position, and match
  // nothing either way. For every token that can match, runtime ≡ build. The artifact test pins the
  // premise (no FOLD_MAP key is a KB token) and the fold fixpoint. Omitting the vocab at runtime is
  // equally exact; the loader's contract is kept so E12b's fixpoint test still describes the KB.
  for (const c of cands) if (c.kind === "tokens") c.tokens = toks(c.text);
  for (const r of termRows) {
    if (r.kind !== "regex" && toks(r.term).length === 0) throw new Error(`[kbv2] csi_terms row '${r.term}' has no tokens`);
  }

  // ── 4. filters ──
  const titleTokens = new Map<string, string[]>();
  for (const c of cands) if (c.source === "title" || c.source === "tsv") titleTokens.set(c.code, c.tokens);
  const descTitleKeys = new Map<string, Set<string>>();
  for (const [c, ts] of titleTokens) {
    if (!ts.length) continue;
    for (let a = parent.get(c) ?? null; a; a = parent.get(a) ?? null) {
      const s = descTitleKeys.get(a) ?? new Set<string>();
      s.add(setKey(ts));
      descTitleKeys.set(a, s);
    }
  }
  // Owner ruling 2026-10-20 (review §1b, "drop"): a curated term row OWNS its token set. Any MF/TSV
  // pattern of a DIFFERENT code with exactly that set is dropped (e.g. 40 05 63 'Ball Valves' loses
  // its {ball,valve} title/index patterns to the BALL VALVE rows @ 22 05 23 P / 23 05 23 M).
  const termSetCodes = new Map<string, Set<string>>();
  for (const c of cands) {
    if (c.source !== "term" || c.kind !== "tokens" || !c.tokens.length) continue;
    const k = setKey(c.tokens);
    termSetCodes.set(k, (termSetCodes.get(k) ?? new Set<string>()).add(c.code));
  }
  // Owner ruling 2026-10-20 (kb-v2.4, variant E of notes/FOLD_EXPERIMENT_2026-10-20.md): a code's
  // MasterFormat TITLE owns its token set. An alt/index/see pattern of a DIFFERENT code with exactly
  // that set is dropped (INSULATION BOARD keeps 07 21 13, not 07 22 00/07 24 00/09 81 00). A set a
  // term row owns is decided by the term rule alone, so its titles own nothing here (that covers
  // every title the term rule dropped). Process exemption: a 40–49 title does not own against a
  // building-division pattern; a process pattern yields to any title. TSV-only titles own nothing.
  const titleSetCodes = new Map<string, Set<string>>();
  for (const c of cands) {
    if (c.source !== "title" || c.kind !== "tokens" || !c.tokens.length) continue;
    const k = setKey(c.tokens);
    if (termSetCodes.has(k)) continue;
    if (LOST_LETTER_RE.test(c.text)) { bump("titleLostLetterNoOwn"); continue; } // S5 e4
    titleSetCodes.set(k, (titleSetCodes.get(k) ?? new Set<string>()).add(c.code));
  }
  const titleOwnersOf = (c: Cand): string[] => {
    const all = [...(titleSetCodes.get(setKey(c.tokens)) ?? [])];
    return isProcessDivision(c.code) ? all : all.filter((x) => !isProcessDivision(x));
  };
  // S5 (kb-v2.5): `code|setKey` pairs dropped from every source — a lost-letter title's reduced set
  // (row e4) and CURATED_DROPS (rows b, j). Term rows are never dropped here.
  const s5Drop = new Set<string>(CURATED_DROPS.map(([code, k]) => `${code}|${k}`));
  // A lost-letter title's set is dropped only when ANOTHER code also prints it (alt/index/see): there the
  // reduced set names that code's thing (WOOD JOISTS = 06 11 00), and the title would shadow it. A set no
  // other code prints stays (X-RAY SHIELDING keeps 13 49 13) — same corpus result, no code made unreachable.
  const otherSets = new Map<string, Set<string>>();
  for (const c of cands) {
    if (c.kind !== "tokens" || (c.source !== "alt" && c.source !== "index" && c.source !== "see")) continue;
    otherSets.set(setKey(c.tokens), (otherSets.get(setKey(c.tokens)) ?? new Set<string>()).add(c.code));
  }
  for (const c of cands) {
    if (c.source !== "title" || c.kind !== "tokens" || !c.tokens.length || !LOST_LETTER_RE.test(c.text)) continue;
    if ([...(otherSets.get(setKey(c.tokens)) ?? [])].some((x) => x !== c.code)) s5Drop.add(`${c.code}|${setKey(c.tokens)}`);
  }
  const seen = new Set<string>();
  const kept: Cand[] = [];
  for (const c of cands) {
    if (c.kind === "tokens" && c.source !== "term" && s5Drop.has(`${c.code}|${setKey(c.tokens)}`)) { bump(`s5Dropped_${c.source}`); continue; }
    if (c.kind === "tokens" && c.source !== "term") {
      const owners = termSetCodes.get(setKey(c.tokens));
      if (owners && !owners.has(c.code)) { bump(`${c.source}EqOtherCodeTermRow`); continue; }
    }
    if (c.kind === "tokens") {
      if (!c.tokens.length) { bump(`emptyTokenDropped_${c.source}`); continue; }
      if (c.source !== "term" && c.tokens.every((t) => t.length <= 2)) { bump(`le2CharDropped_${c.source}`); continue; }
      // E12e facet rows: an index sub-entry whose own text adds nothing to its head ('doors' under
      // 'hollow metal doors and frames' → 08 13 13) yields the HEAD's token set under another code.
      // A sub-entry with NO token (the bare NAICS numbers under 'NAICS group manufacturing
      // equipment') is the same case and is counted apart. Same fold rule as the stored tokens.
      if (c.sub !== undefined && c.head !== undefined) {
        const headSet = new Set(toks(c.head));
        const subTokens = toks(c.sub);
        if (subTokens.every((t) => headSet.has(t))) { bump(subTokens.length ? "indexFacetRows" : "indexEmptySubEntryRows"); continue; }
      }
      // D6, extended by E12e to every MF-derived non-title source: a pattern whose token set equals a
      // DESCENDANT's title would shadow that title in the frontier (it would be an ancestor-code
      // pattern with the same set, never a proper subset). Curated term rows are exempt.
      if ((c.source === "alt" || c.source === "index" || c.source === "see") && descTitleKeys.get(c.code)?.has(setKey(c.tokens))) {
        bump(`${c.source}DupOfDescendantTitle`);
        continue;
      }
      // kb-v2.4 title-owns (above). Checked AFTER the facet and D6 filters, which it mostly subsumes,
      // so their counters keep describing the same rows and `*EqOtherCodeTitle` counts only what the
      // ruling added. Every drop rule is a predicate on the candidate alone, so the order changes
      // counters, never the kept set.
      if (c.source === "alt" || c.source === "index" || c.source === "see") {
        const owners = titleOwnersOf(c);
        if (owners.length && !owners.includes(c.code)) { bump(`${c.source}EqOtherCodeTitle`); continue; }
      }
    }
    const dk = `${c.code}|${c.source}|${c.kind === "regex" ? `re:${c.regex}` : setKey(c.tokens)}`;
    if (seen.has(dk)) { bump("dedupedPatterns"); bump(`dedupedPatterns_${c.source}`); continue; }
    seen.add(dk);
    kept.push(c);
  }
  kept.sort((a, b) => cmp(a.code, b.code) || SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.order - b.order);
  // E2 title-diff reads the parent's title from what the KB KEEPS: a parent whose title pattern was
  // dropped (owner term-row ruling) counts as untitled, so the artifact alone re-derives every diff.
  const keptTitleTokens = new Map<string, string[]>();
  for (const c of kept) if (c.source === "title" || c.source === "tsv") keptTitleTokens.set(c.code, c.tokens);

  // ── 5. weights ──
  const tokPats = kept.filter((c) => c.kind === "tokens");
  const vocab = new Set<string>();
  for (const c of tokPats) for (const t of c.tokens) vocab.add(t);
  // codeDF over every token source (title, index, alt, see, term — and tsv, the title of a TSV-only
  // code). A FOLD_EXCEPTIONS surface form also counts toward its stem when the stem is vocabulary,
  // because the loader posts such a pattern under both forms (`indexForms`).
  const dfCodes = new Map<string, Set<string>>();
  for (const c of tokPats) {
    for (const t of c.tokens) {
      for (const f of indexForms(t)) {
        if (!vocab.has(f)) continue;
        const s = dfCodes.get(f) ?? new Set<string>();
        s.add(c.code);
        dfCodes.set(f, s);
      }
    }
  }
  const codeDF = new Map<string, number>([...dfCodes].map(([t, s]) => [t, s.size]));
  const N = new Set(kept.map((c) => c.code)).size;
  const idf = (t: string) => Math.log(N / (codeDF.get(t) ?? 1));
  const floor = new Set([...codeDF].filter(([, n]) => n >= FLOOR_DF).map(([t]) => t));
  const filler = canonicalList(FILLER_WORDS, vocab, "filler");
  const fillerSet = new Set(filler);
  const boilerplate = canonicalList(BOILERPLATE_WORDS, vocab, "boilerplate");
  const noAnchor = new Set([...floor, ...boilerplate]);
  /** Rarest non-floored NON-FILLER token (lowest codeDF; ties → first printed); when every
   *  non-floored token is filler, the rarest of those (E12e: a filler anchor is never in diff, so a
   *  filler anchor beside a usable non-filler token left 61 patterns with an empty diff). null ⇒
   *  generic list. */
  const anchorOf = (ts: string[]): number | null => {
    let best = -1;
    for (const wantFiller of [false, true]) {
      for (let i = 0; i < ts.length; i++) {
        if (noAnchor.has(ts[i]) || fillerSet.has(ts[i]) !== wantFiller) continue;
        if (best < 0 || (codeDF.get(ts[i]) ?? 0) < (codeDF.get(ts[best]) ?? 0)) best = i;
      }
      if (best >= 0) return best;
    }
    return null;
  };

  // ── 6. lattice (E3) ──
  const ids = new Map<string, number>([...vocab].sort(cmp).map((t, i) => [t, i]));
  const sortedIds = (ts: string[]) => ts.map((t) => ids.get(t) ?? -1).sort((a, b) => a - b);
  const byKey = new Map<string, number[]>();
  const postings = new Map<string, number[]>();
  const sets = kept.map((c) => new Set(c.tokens));
  const push = (m: Map<string, number[]>, k: string, id: number) => {
    const l = m.get(k);
    if (l) l.push(id);
    else m.set(k, [id]);
  };
  kept.forEach((c, id) => {
    if (c.kind !== "tokens") return;
    push(byKey, sortedIds(c.tokens).join(","), id);
    for (const t of c.tokens) push(postings, t, id);
  });
  const upOf = (id: number): number[] => {
    const c = kept[id];
    const n = c.tokens.length;
    const cand = new Set<number>();
    if (n <= MAX_ENUM_TOKENS) {
      const sid = sortedIds(c.tokens);
      for (let mask = 1; mask < (1 << n) - 1; mask++) {
        const sub: number[] = [];
        for (let i = 0; i < n; i++) if (mask & (1 << i)) sub.push(sid[i]);
        for (const q of byKey.get(sub.join(",")) ?? []) if (kept[q].code !== c.code) cand.add(q);
      }
    } else {
      bump("latticePostingScan");
      for (const t of c.tokens) {
        for (const q of postings.get(t) ?? []) {
          if (kept[q].code !== c.code && kept[q].tokens.length < n && isSubset(sets[q], sets[id])) cand.add(q);
        }
      }
    }
    const bySize = [...cand].sort((a, b) => kept[b].tokens.length - kept[a].tokens.length || a - b);
    const maximal: number[] = [];
    for (const q of bySize) {
      const dominated = maximal.some((r) => kept[r].tokens.length > kept[q].tokens.length && isSubset(sets[q], sets[r]));
      if (!dominated) maximal.push(q);
    }
    return maximal.sort((a, b) => a - b);
  };

  const patterns: KbPattern[] = kept.map((c, id) => {
    if (c.kind === "regex") {
      return {
        id, code: c.code, source: c.source, kind: "regex", tokens: [], mass: [], diff: [], anchor: null, up: [],
        orderFree: true, oneWordOk: c.oneWordOk, ...(c.discipline ? { discipline: c.discipline } : {}), regex: c.regex, text: c.text,
      };
    }
    const ts = c.tokens;
    const anchor = anchorOf(ts);
    if (anchor !== null && fillerSet.has(ts[anchor])) bump("fillerAnchors");
    const up = upOf(id);
    const diff = new Set<number>();
    if (anchor !== null) diff.add(anchor);
    if (c.source === "title") {
      const p = parent.get(c.code) ?? null;
      const pt = p ? new Set(keptTitleTokens.get(p) ?? []) : null;
      if (p && !keptTitleTokens.get(p)?.length) bump("titleDiffParentUntitled");
      if (pt && pt.size) ts.forEach((t, i) => { if (!pt.has(t)) diff.add(i); });
    }
    if (up.length) {
      const covered = new Set(up.flatMap((q) => kept[q].tokens));
      ts.forEach((t, i) => { if (!covered.has(t)) diff.add(i); });
    }
    const opt: Pick<KbPattern, "oneWordOk" | "oneWordMaxUnit" | "hintOnly" | "discipline"> = {};
    if (c.source === "term") opt.oneWordOk = c.oneWordOk === true;
    if (c.oneWordMaxUnit && ts.length === 1) opt.oneWordMaxUnit = c.oneWordMaxUnit;
    if (ts.length === 1 && c.oneWordOk !== true) opt.hintOnly = true; // E6
    if (c.discipline) opt.discipline = c.discipline;
    return {
      id, code: c.code, source: c.source, kind: "tokens", tokens: ts,
      mass: ts.map((t) => round4(idf(t) * (fillerSet.has(t) ? FILLER_FACTOR : 1))),
      diff: [...diff].filter((i) => !fillerSet.has(ts[i])).sort((a, b) => a - b),
      anchor, up, orderFree: c.source === "index" || c.source === "term", ...opt, text: c.text,
    };
  });

  // ── codes ──
  const tradeOf = (c: string): string => {
    for (let a: string | null = c; a; a = parent.get(a) ?? parentOf(a, (x) => tsv.has(x))) {
      const t = tsv.get(a)?.trade;
      if (t) { if (a !== c) bump("tradeInherited"); return t; }
    }
    bump("tradeMissing");
    return "";
  };
  const patIds = new Map<string, number[]>();
  for (const p of patterns) push(patIds, p.code, p.id);
  const codes: KbCode[] = [...codeSet].sort(cmp).map((c) => {
    const title = titleOf.get(c) ?? "";
    const aliases: string[] = [];
    const t = tsv.get(c)?.title;
    if (t && norm(t) !== norm(title)) { aliases.push(t); bump("tsvTitleAliases"); }
    for (const a of [...(seeAliases.get(c) ?? [])].sort(cmp)) if (!aliases.includes(a)) aliases.push(a);
    const ids2 = patIds.get(c) ?? [];
    if (!ids2.length) bump("codesWithoutPattern");
    return {
      code: c, level: levelOf(c), parent: parent.get(c) ?? null, title, trade: tradeOf(c),
      division: `${c.slice(0, 2)} 00 00`, aliases, patternIds: ids2,
    };
  });

  // ── 7. report (E12a: EXACT keys) ──
  const l3 = (c: string): string => {
    for (let a: string | null = c; a; a = parent.get(a) ?? null) if (levelOf(a) <= 3) return a;
    return c;
  };
  const oneWord = new Map<string, Set<string>>();
  for (const r of termRows) {
    if (r.kind === "regex") continue;
    const ts = toks(r.term, vocab);
    if (ts.length !== 1) continue;
    const s = oneWord.get(ts[0]) ?? new Set<string>();
    s.add(l3(r.code));
    oneWord.set(ts[0], s);
  }
  let reachDen = 0, reachOne = 0, reachDiff = 0;
  const reachBySource: Record<string, number> = {};
  for (const p of patterns) {
    if (p.kind !== "tokens" || p.tokens.length < 2) continue;
    reachDen++;
    const total = p.mass.reduce((a, b) => a + b, 0);
    const diffSet = new Set(p.diff);
    const one = p.mass.some((m, i) => !diffSet.has(i) && total - m >= 0.8 * total);
    const dm = p.diff.reduce((a, i) => a + p.mass[i], 0) >= 0.8 * total;
    if (one) { reachOne++; reachBySource[`oneTokenTolerance_${p.source}`] = (reachBySource[`oneTokenTolerance_${p.source}`] ?? 0) + 1; }
    if (dm) { reachDiff++; reachBySource[`diffMassGE80_${p.source}`] = (reachBySource[`diffMassGE80_${p.source}`] ?? 0) + 1; }
    reachBySource[`denominator_${p.source}`] = (reachBySource[`denominator_${p.source}`] ?? 0) + 1;
  }
  const finalTitles = codes.map((c) => c.title);
  const report: Record<string, number> = {
    overGrabResidual: finalTitles.filter((t) => TITLE_STRIP_RE.test(t)).length,
    dupWords: finalTitles.filter((t) => dedupeAdjacentWords(t).removed > 0).length,
    danglingInPatterns: patterns.filter((p) => !has(p.code)).length,
    unassignedInPatterns: patterns.filter((p) => unassigned.has(p.code)).length,
    numericOrLen1Tokens: patterns.reduce((n, p) => n + p.tokens.filter((t) => t.length < 2 || /^\d+$/.test(t)).length, 0),
    le2CharPatterns: patterns.filter((p) => p.source !== "term" && p.kind === "tokens" && p.tokens.every((t) => t.length <= 2)).length,
    misHeadedGoldens: misHeadedGoldens(parsed),
    oneWordTermMultiFamily: [...oneWord.values()].filter((s) => s.size > 1).length,
    reach_oneTokenTolerance: reachOne,
    reach_diffMassGE80: reachDiff,
  };

  // ── header ──
  counts.codes = codes.length;
  counts.codesMaster = masterSet.size;
  counts.N = N;
  counts.patterns = patterns.length;
  for (const s of Object.keys(SOURCE_RANK)) counts[`patterns_${s}`] = patterns.filter((p) => p.source === s).length;
  counts.patterns_regex = patterns.filter((p) => p.kind === "regex").length;
  counts.genericPatterns = patterns.filter((p) => p.kind === "tokens" && p.anchor === null).length;
  counts.hintOnlyPatterns = patterns.filter((p) => p.hintOnly).length;
  counts.vocab = vocab.size;
  counts.floorTokens = floor.size;
  counts.reachDenominator = reachDen;
  counts.headless = parsed.report.headless;
  counts.danglingIndexCodesParsed = parsed.report.danglingIndexCodes;
  counts.danglingSeeParsed = parsed.report.danglingSee;
  counts.indexEntriesParsed = parsed.index.length;
  counts.synonymsParsed = parsed.synonyms.length;
  counts.abbrevRowsPdf = parsed.abbrevRows.length;
  const termAbbrevs = new Set(termRows.filter((r) => r.kind === "abbrev").map((r) => r.term.toUpperCase()));
  counts.abbrevRowsPdfInTerms = parsed.abbrevRows.filter((r) => termAbbrevs.has(r.abbr.toUpperCase())).length;
  counts.headerLeakResidual = parsed.master.reduce(
    (n, e) => n + [...e.altTerms, ...e.includes, ...e.notes, ...e.see.map((s) => s.text)].filter((t) => /N ?UMBER/.test(t)).length, 0);
  counts.termRows = termRows.length;
  // E12e: the runtime `known` set. A one-token abbrev row contributes its token; a multi-token abbrev
  // row (GYP BD, MTL STUD) contributes only the tokens that are NOT MasterFormat title words, so the
  // abbreviation pieces (gyp, bd, mtl) are known and an ordinary word (stud) is not.
  const titleWords = new Set(patterns.filter((p) => p.source === "title").flatMap((p) => p.tokens));
  const abbrevTokens = uniq(termRows.filter((r) => r.kind === "abbrev").flatMap((r) => {
    const ts = toks(r.term, vocab);
    return ts.length === 1 ? ts : ts.filter((t) => !titleWords.has(t));
  })).sort(cmp);
  const header: CsiKbHeader = {
    schemaVersion: SCHEMA_VERSION,
    builderVersion: BUILDER_VERSION,
    sources: inp.sources,
    counts: sortedRecord(counts),
    report,
    floorTokens: [...floor].sort(cmp),
    fillerTokens: filler,
    boilerplateTokens: boilerplate,
    abbrevTokens,
  };
  return { kb: { header, codes, patterns }, codeDF, reach: { denominator: reachDen, ...sortedRecord(reachBySource) } };
}

// ───────────────────────────── output ─────────────────────────────

/** D1 layout: header on one line, then one record per line for codes and patterns. Key order
 *  is the construction order above, which is fixed; numbers are already rounded. */
export function serializeKb(kb: CsiKb): string {
  return (
    `{"header":${JSON.stringify(kb.header)},\n"codes":[\n` +
    kb.codes.map((c) => JSON.stringify(c)).join(",\n") +
    `\n],\n"patterns":[\n` +
    kb.patterns.map((p) => JSON.stringify(p)).join(",\n") +
    `\n]}\n`
  );
}

/** The gate (PLAN §5.6): every E12a counter except the two reach counters must be 0. */
export function gateFailures(report: Record<string, number>): string[] {
  return Object.entries(report)
    .filter(([k, v]) => !k.startsWith("reach_") && v !== 0)
    .map(([k, v]) => `${k}=${v}`);
}

function main(): void {
  const t0 = Date.now();
  const root = process.cwd();
  const pdf = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? DEFAULT_PDF;
  if (!existsSync(pdf)) throw new Error(`[kbv2] PDF not found: ${pdf}`);
  for (const p of SOURCE_PATHS) if (!existsSync(join(root, p))) throw new Error(`[kbv2] missing input ${p} (run from blueprintparser_2/)`);
  const sources = [
    { path: PDF_SOURCE, sha256: sha256(readFileSync(pdf)) },
    ...SOURCE_PATHS.map((p) => ({ path: p, sha256: sha256(readFileSync(join(root, p))) })),
  ];
  extractPages(pdf)
    .then((pages) => {
      const t1 = Date.now();
      const parsed: MfParsed = parseDocument(pages);
      const res = buildKb({
        parsed,
        masterformatTsv: readFileSync(join(root, SOURCE_PATHS[0]), "utf-8"),
        terms: readFileSync(join(root, SOURCE_PATHS[2]), "utf-8"),
        sources,
      });
      const fails = gateFailures(res.kb.header.report);
      if (fails.length) throw new Error(`[kbv2] BUILD GATE FAILED (PLAN §5.6): ${fails.join(", ")}`);
      const text = serializeKb(res.kb);
      const kbPath = join(root, KB_OUT);
      mkdirSync(dirname(kbPath), { recursive: true });
      writeFileSync(kbPath, text);
      const bytes = Buffer.byteLength(text);
      const pct = (n: number) => round4(n / Math.max(1, res.reach.denominator));
      const reportJson = {
        schemaVersion: "csi-kb-report/1",
        builderVersion: BUILDER_VERSION,
        kbBytes: bytes,
        kbSha256: sha256(text),
        counts: res.kb.header.counts,
        report: res.kb.header.report,
        reach: {
          ...res.reach,
          oneTokenToleranceShare: pct(res.kb.header.report.reach_oneTokenTolerance),
          diffMassGE80Share: pct(res.kb.header.report.reach_diffMassGE80),
        },
        patternsBySource: Object.fromEntries(Object.keys(SOURCE_RANK).map((s) => [s, res.kb.header.counts[`patterns_${s}`]])),
        floorTokens: Object.fromEntries(res.kb.header.floorTokens.map((t) => [t, res.codeDF.get(t) ?? 0])),
        boilerplateTokens: Object.fromEntries(res.kb.header.boilerplateTokens.map((t) => [t, res.codeDF.get(t) ?? 0])),
        fillerTokens: Object.fromEntries(res.kb.header.fillerTokens.map((t) => [t, res.codeDF.get(t) ?? 0])),
        topCodeDF: [...res.codeDF].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).slice(0, 50),
      };
      writeFileSync(join(root, REPORT_OUT), JSON.stringify(reportJson, null, 2) + "\n");
      const h = res.kb.header;
      console.error(
        `[kbv2] ${h.counts.codes} codes · ${h.counts.patterns} patterns · N=${h.counts.N} · floor=${h.floorTokens.length} · ` +
          `${bytes} bytes · sha256 ${reportJson.kbSha256} · parse ${t1 - t0} ms · total ${Date.now() - t0} ms\n` +
          `[kbv2] report ${JSON.stringify(h.report)}\n[kbv2] → ${KB_OUT}, ${REPORT_OUT}`,
      );
    })
    .catch((e: unknown) => {
      console.error(e);
      process.exit(1);
    });
}

// Entry guard — only the `csi-kbv2` bundle runs the CLI (a test importing this must not).
if (process.argv[1]?.includes("csi-kbv2")) main();
