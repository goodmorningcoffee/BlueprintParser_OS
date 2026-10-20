/**
 * csi-kb.ts — loader for the CSI v2 knowledge base `src/data/csi-kb.json` (CSI tagger v2, S2).
 *
 * SERVER-ONLY (uses `readFileSync` and `node:crypto`) — keep out of client bundles. The
 * `server-only` package is not installed in this repo; the convention is this header comment
 * plus the walk in `__tests__/csi-kb-loader.test.ts`, which fails if any file under
 * src/components, src/stores, src/queries, src/hooks, an app page/layout, or any "use client"
 * file imports this module other than with `import type`. Client code that needs the shapes
 * imports `@/lib/csi-kb-types`.
 *
 * Spec: PLAN.md §5.7, IMPLEMENTATION.md §I (`LoadedKb`) and §IV E10, E12b, E12d.
 *   - Lazy: nothing is read at import time; the first `loadCsiKb()` reads and builds.
 *   - Memoised on `globalThis.__bpCsiKbV2` (several server chunks embed this module; one copy
 *     per process).
 *   - The KB file is found with the same 3-path probe as `csi-database.ts`.
 *   - Verified at load: `header.schemaVersion === 'csi-kb/2'`, and the sha256 of the RAW bytes
 *     (CRLF included) of every in-repo input recorded in `header.sources` — the three TSVs and
 *     the tokenizer. The PDF entry is skipped (it is not in the repo or the image). A stale KB
 *     (an input edited without a rebuild) therefore fails loudly here, not silently at match time.
 *   - Any failure — file missing, unparseable, wrong schema, sha mismatch, broken structure —
 *     throws a descriptive Error. There is no empty-KB fallback (fail closed).
 *   - Built at load (E10): tokens interned to ids; `anchorIndex` / `genericIndex` as
 *     Map<tokenId, Int32Array> of ascending pattern ids; `up` as one Int32Array per pattern;
 *     `idf` (token → idf; its key set is the fold vocab, E12b); `known` = header.abbrevTokens;
 *     `byCode`. The `up*` closure is NOT precomputed (E10).
 */

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { basename, join } from "path";
import type { CsiKb, CsiKbHeader, KbCode, KbPattern, LoadedKb } from "@/lib/csi-kb-types";

declare global {
  // The process-wide memo (E12d). `var` is required for a `declare global` binding on globalThis.
  var __bpCsiKbV2: LoadedKb | undefined;
}

export const CSI_KB_SCHEMA_VERSION = "csi-kb/2";
export const CSI_KB_FILE = "src/data/csi-kb.json";

/**
 * Inputs whose raw-byte sha256 is re-checked at every load (E12d). Each must appear in
 * `header.sources`; an entry for a path not listed here and not a `.pdf` is also rejected, so a
 * builder that adds an input cannot slip past an outdated loader.
 */
export const CSI_KB_RUNTIME_SOURCES: readonly string[] = [
  "src/data/csi-masterformat.tsv",
  "src/data/csi.tsv",
  "src/data/csi_terms.tsv",
  "src/lib/csi-tokenize.ts",
];

/**
 * Mass of a filler token is idf × this factor (PLAN §5.5, D4). Must equal the builder's
 * `FILLER_FACTOR` (eval/csi/build-kb-v2.ts); the loader test asserts the two agree. Used only to
 * recover the un-halved idf of filler tokens from the stored mass.
 */
export const CSI_KB_FILLER_FACTOR = 0.5;

/**
 * Two tokens whose idf differs by at most this much are a tie for "rarest token". The stored
 * mass is rounded to 4 decimals (D1) and a filler token's idf is mass / 0.5, so a recovered idf
 * is within 1e-4 of the builder's; distinct codeDF values ≤ 1,084 differ by ≥ ~9e-4 in idf.
 */
const IDF_TIE_EPS = 2.5e-4;

/** The 3-path probe of `csi-database.ts` (cwd-relative, cwd basename, module-relative). */
function probePaths(rel: string): string[] {
  return [
    join(process.cwd(), rel),
    join(process.cwd(), basename(rel)),
    join(__dirname, "../..", rel),
  ];
}

function readFirst(rel: string): { path: string; bytes: Buffer } | null {
  for (const p of probePaths(rel)) {
    try {
      return { path: p, bytes: readFileSync(p) };
    } catch {
      continue;
    }
  }
  return null;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(file: string, msg: string): never {
  throw new Error(`CSI KB (${file}): ${msg}`);
}

function verifyHeader(file: string, header: CsiKbHeader | undefined): void {
  if (!header || typeof header !== "object") fail(file, "no header object");
  if (header.schemaVersion !== CSI_KB_SCHEMA_VERSION) {
    fail(file, `schemaVersion is ${JSON.stringify(header.schemaVersion)}, expected "${CSI_KB_SCHEMA_VERSION}"`);
  }
  if (!Array.isArray(header.sources)) fail(file, "header.sources is not an array");
  const recorded = new Map<string, string>();
  for (const s of header.sources) {
    if (s.path.toLowerCase().endsWith(".pdf")) continue; // E12d: the PDF is not in the repo/image
    if (!CSI_KB_RUNTIME_SOURCES.includes(s.path)) {
      fail(file, `header.sources lists "${s.path}", which this loader does not verify — update csi-kb.ts`);
    }
    recorded.set(s.path, s.sha256);
  }
  for (const rel of CSI_KB_RUNTIME_SOURCES) {
    const want = recorded.get(rel);
    if (!want) fail(file, `header.sources has no entry for "${rel}"`);
    const found = readFirst(rel);
    if (!found) fail(file, `input "${rel}" not found (probed ${probePaths(rel).join(", ")})`);
    const got = sha256(found.bytes);
    if (got !== want) {
      fail(
        file,
        `input "${rel}" (${found.path}) has sha256 ${got} but the KB was built from ${want} — ` +
          "the KB is stale; rebuild it with eval/csi/build-kb-v2.ts",
      );
    }
  }
  for (const k of ["floorTokens", "fillerTokens", "boilerplateTokens", "abbrevTokens"] as const) {
    if (!Array.isArray(header[k])) fail(file, `header.${k} is not an array`);
  }
}

/** Index of the rarest token (highest idf; ties → first printed), the generic-list posting key. */
function rarestTokenIndex(p: KbPattern, idf: Map<string, number>): number {
  let best = 0;
  for (let i = 1; i < p.tokens.length; i++) {
    if ((idf.get(p.tokens[i]) ?? 0) > (idf.get(p.tokens[best]) ?? 0) + IDF_TIE_EPS) best = i;
  }
  return best;
}

function pushPosting(m: Map<number, number[]>, key: number, id: number): void {
  const list = m.get(key);
  if (list) list.push(id);
  else m.set(key, [id]);
}

function toInt32Index(m: Map<number, number[]>): Map<number, Int32Array> {
  const out = new Map<number, Int32Array>();
  for (const [k, ids] of m) out.set(k, Int32Array.from(ids)); // ids pushed in pattern-id order
  return out;
}

/** Structure checks + derived indexes (E10). Throws on any inconsistency. */
function buildLoaded(file: string, kb: CsiKb): LoadedKb {
  const { header, codes, patterns } = kb;
  if (!Array.isArray(codes) || !Array.isArray(patterns)) fail(file, "codes/patterns are not arrays");
  const P = patterns.length;
  const fillers = new Set(header.fillerTokens);

  const tokenId = new Map<string, number>();
  const idf = new Map<string, number>();
  for (let id = 0; id < P; id++) {
    const p = patterns[id];
    if (p.id !== id) fail(file, `pattern ids are not dense: index ${id} holds id ${p.id}`);
    if (p.tokens.length !== p.mass.length) fail(file, `pattern ${id}: ${p.tokens.length} tokens but ${p.mass.length} mass values`);
    if (p.kind === "regex") {
      if (typeof p.regex !== "string" || p.tokens.length !== 0) fail(file, `pattern ${id}: malformed regex pattern`);
      continue; // E12c: regex rows have no token set
    }
    if (p.tokens.length === 0) fail(file, `pattern ${id}: token pattern with no tokens`);
    if (p.anchor !== null && (p.anchor < 0 || p.anchor >= p.tokens.length)) fail(file, `pattern ${id}: anchor out of range`);
    for (const d of p.diff) if (!Number.isInteger(d) || d < 0 || d >= p.tokens.length) fail(file, `pattern ${id}: diff index ${d} out of range`);
    for (let i = 0; i < p.tokens.length; i++) {
      const t = p.tokens[i];
      if (!tokenId.has(t)) tokenId.set(t, tokenId.size);
      const v = fillers.has(t) ? p.mass[i] / CSI_KB_FILLER_FACTOR : p.mass[i];
      const prev = idf.get(t);
      if (prev === undefined) idf.set(t, v);
      else if (Math.abs(prev - v) > 1e-9) fail(file, `token "${t}" has inconsistent mass across patterns`);
    }
  }

  const anchorLists = new Map<number, number[]>();
  const genericLists = new Map<number, number[]>();
  const up: Int32Array[] = new Array<Int32Array>(P);
  for (let id = 0; id < P; id++) {
    const p = patterns[id];
    for (const u of p.up) {
      if (!Number.isInteger(u) || u < 0 || u >= P) fail(file, `pattern ${id}: up id ${u} out of range`);
      if (patterns[u].code === p.code) fail(file, `pattern ${id}: up id ${u} is the same code (E3 forbids)`);
    }
    up[id] = Int32Array.from(p.up);
    if (p.kind === "regex") continue;
    const key = p.anchor !== null ? p.anchor : rarestTokenIndex(p, idf);
    const tid = tokenId.get(p.tokens[key]);
    if (tid === undefined) fail(file, `pattern ${id}: posting token not interned`);
    pushPosting(p.anchor !== null ? anchorLists : genericLists, tid, id);
  }

  const byCode = new Map<string, KbCode>();
  for (const c of codes) {
    if (byCode.has(c.code)) fail(file, `duplicate code ${c.code}`);
    for (const pid of c.patternIds) {
      if (!Number.isInteger(pid) || pid < 0 || pid >= P || patterns[pid].code !== c.code) {
        fail(file, `code ${c.code}: patternId ${pid} does not belong to it`);
      }
    }
    byCode.set(c.code, c);
  }
  for (const p of patterns) if (!byCode.has(p.code)) fail(file, `pattern ${p.id}: code ${p.code} is not in codes`);

  return {
    header,
    codes,
    patterns,
    byCode,
    tokenId,
    anchorIndex: toInt32Index(anchorLists),
    genericIndex: toInt32Index(genericLists),
    up,
    idf,
    known: new Set(header.abbrevTokens),
  };
}

function parseAndBuild(file: string, bytes: Buffer): LoadedKb {
  let kb: CsiKb;
  try {
    kb = JSON.parse(bytes.toString("utf-8")) as CsiKb;
  } catch (e) {
    fail(file, `not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!kb || typeof kb !== "object") fail(file, "not a JSON object");
  try {
    verifyHeader(file, kb.header);
    return buildLoaded(file, kb);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("CSI KB (")) throw e;
    fail(file, `malformed artifact (${msg})`); // a missing field surfaces as a TypeError above
  }
}

/**
 * Load a KB from an explicit path, UNCACHED (test-only; E12). Inputs named in `header.sources`
 * are still resolved with the repo probe, not relative to `path`, so a copy of the artifact
 * elsewhere is verified against the live inputs.
 */
export function loadCsiKbFromFile(path: string): LoadedKb {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    fail(path, `cannot read the KB file (${e instanceof Error ? e.message : String(e)})`);
  }
  return parseAndBuild(path, bytes);
}

/** The process-wide KB: read, verified and indexed on first call, then memoised (PLAN §5.7). */
export function loadCsiKb(): LoadedKb {
  const memo = globalThis.__bpCsiKbV2;
  if (memo) return memo;
  const found = readFirst(CSI_KB_FILE);
  if (!found) fail(CSI_KB_FILE, `KB file not found (probed ${probePaths(CSI_KB_FILE).join(", ")})`);
  const loaded = parseAndBuild(found.path, found.bytes);
  globalThis.__bpCsiKbV2 = loaded;
  return loaded;
}

/** Test-only: drop the memo so the next `loadCsiKb()` reads the file again. */
export function __resetCsiKbMemoForTests(): void {
  globalThis.__bpCsiKbV2 = undefined;
}
