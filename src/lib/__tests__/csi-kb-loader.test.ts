// @vitest-environment node
/**
 * csi-kb-loader.test.ts — CSI tagger v2, S2: the server-only loader `src/lib/csi-kb.ts`.
 *
 * IMPLEMENTATION §II S2 (loader tests), §I `LoadedKb`, §IV E10 / E12d; PLAN §5.7.
 *   - lazy: importing the module reads nothing and leaves the globalThis memo empty
 *   - memo identity: two `loadCsiKb()` calls return the same object and read the file once
 *   - fail closed: missing file, bad schemaVersion, a recorded source sha that does not match the
 *     live input, a missing source entry — each throws a descriptive Error
 *   - the PDF source entry is skipped, and a relocated copy is verified against the REPO inputs
 *   - index sanity (anchor / generic postings, `up`, idf, `known`, `byCode`)
 *   - the "server-only" walk: no client-side file imports `@/lib/csi-kb` except `import type`
 *     (the `server-only` package is not installed; this walk is the guard)
 * Every load is a 6.5 MB parse + four sha256s, so tests that load carry a generous timeout.
 *
 * The KB is GITIGNORED BY DESIGN (owner ruling D1, 2026-10-20), so a fresh clone (GitHub CI) has
 * none: the describes that load or tamper with the REAL file are `skipIf(!HAS_KB)` (announced by
 * src/test/global-setup.ts; a hard failure under BP_REQUIRE_CSI_KB=1, bp-suite's default). The
 * missing-file / invalid-JSON / image-contract / verifier-drift checks and the server-only walk need
 * no KB and always run.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { CsiKb, LoadedKb } from "@/lib/csi-kb-types";
import { FILLER_FACTOR } from "../../../eval/csi/build-kb-v2";
import { CSI_KB_REL as VERIFIER_KB_REL, REQUIRED_SOURCES as VERIFIER_REQUIRED_SOURCES } from "../../../scripts/verify-csi-kb.mjs";

// Wrap fs.readFileSync (the loader imports it from "fs") so the test can count KB reads.
const h = vi.hoisted(() => ({ reads: [] as string[] }));
vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  const spy = ((...args: Parameters<typeof real.readFileSync>) => {
    h.reads.push(String(args[0]));
    return real.readFileSync(...args);
  }) as typeof real.readFileSync;
  return { ...real, default: { ...real, readFileSync: spy }, readFileSync: spy };
});

import {
  CSI_KB_BUILD_ONLY_SOURCES,
  CSI_KB_FILE,
  CSI_KB_FILLER_FACTOR,
  CSI_KB_RUNTIME_SOURCES,
  __resetCsiKbMemoForTests,
  loadCsiKb,
  loadCsiKbFromFile,
} from "@/lib/csi-kb";

const root = process.cwd();
const KB_PATH = join(root, "src/data/csi-kb.json");
/** Absent on a fresh clone by design (D1, 2026-10-20) — see the file header. */
const HAS_KB = existsSync(KB_PATH);
if (!HAS_KB) {
  console.warn(
    "[csi-kb-loader] SKIPPING the describes that need the real KB (lazy + memo, tampered copies, indexes): " +
      "src/data/csi-kb.json is absent (gitignored by design, owner ruling D1). Rebuild it from the MasterFormat PDF — " +
      "see the header of eval/csi/build-kb-v2.ts (esbuild bundle → node build/csi-kbv2-build.js).",
  );
}
const LOAD_TIMEOUT = 60_000;
const kbReads = () => h.reads.filter((p) => p.endsWith("csi-kb.json")).length;

let tmp: string;
let rawKb: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "csi-kb-loader-"));
  rawKb = HAS_KB ? readFileSync(KB_PATH, "utf-8") : "";
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  __resetCsiKbMemoForTests();
});

/** Write a modified copy of the committed artifact into the tmp dir and return its path. */
function tamperedCopy(name: string, mutate: (kb: CsiKb) => void): string {
  const kb = JSON.parse(rawKb) as CsiKb;
  mutate(kb);
  const p = join(tmp, name);
  writeFileSync(p, JSON.stringify(kb));
  return p;
}
const flipHex = (sha: string) => (sha[0] === "0" ? "1" : "0") + sha.slice(1);

describe.skipIf(!HAS_KB)("csi-kb loader: lazy + memo", () => {
  it("importing the module reads nothing; the first call reads once; the second is the same object", async () => {
    __resetCsiKbMemoForTests();
    expect(globalThis.__bpCsiKbV2).toBeUndefined();
    vi.resetModules();
    const before = kbReads();
    const mod = await import("@/lib/csi-kb");
    expect(kbReads(), "import alone must not read the KB").toBe(before);
    expect(globalThis.__bpCsiKbV2, "import alone must not populate the memo").toBeUndefined();

    const a = mod.loadCsiKb();
    expect(kbReads()).toBe(before + 1);
    expect(globalThis.__bpCsiKbV2).toBe(a);
    const b = mod.loadCsiKb();
    expect(b).toBe(a);
    expect(kbReads(), "the memo must not re-read").toBe(before + 1);
    // The statically imported copy of the module shares the same globalThis memo.
    expect(loadCsiKb()).toBe(a);
    expect(kbReads()).toBe(before + 1);
  }, LOAD_TIMEOUT);

  it("__resetCsiKbMemoForTests drops the memo; loadCsiKbFromFile is uncached", () => {
    const a = loadCsiKb();
    __resetCsiKbMemoForTests();
    expect(globalThis.__bpCsiKbV2).toBeUndefined();
    const fresh = loadCsiKbFromFile(KB_PATH);
    expect(fresh).not.toBe(a);
    expect(globalThis.__bpCsiKbV2, "loadCsiKbFromFile must not touch the memo").toBeUndefined();
    expect(fresh.patterns.length).toBe(a.patterns.length);
  }, LOAD_TIMEOUT);
});

describe("csi-kb loader: fail closed (no KB needed)", () => {
  it("missing file throws a descriptive error", () => {
    const p = join(tmp, "does-not-exist.json");
    expect(() => loadCsiKbFromFile(p)).toThrow(/cannot read the KB file/);
    expect(() => loadCsiKbFromFile(p)).toThrow(p);
  });

  it("invalid JSON throws", () => {
    const p = join(tmp, "broken.json");
    writeFileSync(p, '{"header":{"schemaVersion":"csi-kb/2","sources":[{"path":"csi_masterformat.pdf"'); // truncated
    expect(() => loadCsiKbFromFile(p)).toThrow(/not valid JSON/);
  });

  it("image contract: every runtime input lives under src/data, which the Dockerfile copies into the runner", () => {
    for (const rel of [...CSI_KB_RUNTIME_SOURCES, "src/data/csi-kb.json"]) expect(rel.startsWith("src/data/"), rel).toBe(true);
    const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^COPY --from=builder \/app\/src\/data \.\/src\/data\s*$/m);
  });

  it("the image-build verifier (scripts/verify-csi-kb.mjs) hashes exactly the loader's runtime + build-only inputs", () => {
    expect(VERIFIER_REQUIRED_SOURCES).toEqual([...CSI_KB_RUNTIME_SOURCES, ...CSI_KB_BUILD_ONLY_SOURCES]);
    expect(VERIFIER_KB_REL).toBe(CSI_KB_FILE);
  });
});

describe.skipIf(!HAS_KB)("csi-kb loader: fail closed (tampered copies of the real KB)", () => {
  it("a bad schemaVersion throws", () => {
    const p = tamperedCopy("bad-schema.json", (kb) => {
      Object.assign(kb.header, { schemaVersion: "csi-kb/1" });
    });
    expect(() => loadCsiKbFromFile(p)).toThrow(/schemaVersion is "csi-kb\/1", expected "csi-kb\/2"/);
  }, LOAD_TIMEOUT);

  it("a source sha that does not match the live input throws (one per in-repo input)", () => {
    for (const rel of CSI_KB_RUNTIME_SOURCES) {
      const p = tamperedCopy(`bad-sha-${rel.replace(/\W+/g, "_")}.json`, (kb) => {
        const s = kb.header.sources.find((x) => x.path === rel);
        if (!s) throw new Error(`fixture: no source entry ${rel}`);
        s.sha256 = flipHex(s.sha256);
      });
      expect(() => loadCsiKbFromFile(p)).toThrow(new RegExp(`input "${rel.replace(/\./g, "\\.")}".*the KB is stale`));
    }
  }, LOAD_TIMEOUT);

  it("a header missing a source entry, or naming an unknown input, throws", () => {
    const missing = tamperedCopy("no-terms-entry.json", (kb) => {
      kb.header.sources = kb.header.sources.filter((s) => s.path !== "src/data/csi_terms.tsv");
    });
    expect(() => loadCsiKbFromFile(missing)).toThrow(/no entry for "src\/data\/csi_terms\.tsv"/);
    const extra = tamperedCopy("extra-entry.json", (kb) => {
      kb.header.sources.push({ path: "src/data/other.tsv", sha256: "0".repeat(64) });
    });
    expect(() => loadCsiKbFromFile(extra)).toThrow(/does not verify/);
  }, LOAD_TIMEOUT);

  it("the PDF entry is skipped, and a relocated copy verifies against the repo inputs", () => {
    const p = tamperedCopy("pdf-sha-altered.json", (kb) => {
      const pdf = kb.header.sources.find((s) => s.path.endsWith(".pdf"));
      if (!pdf) throw new Error("fixture: no pdf source entry");
      pdf.sha256 = flipHex(pdf.sha256);
    });
    const kb = loadCsiKbFromFile(p);
    expect(kb.header.schemaVersion).toBe("csi-kb/2");
    expect(kb.patterns.length).toBeGreaterThan(0);
  }, LOAD_TIMEOUT);

  it("the tokenizer entry is build-only: not re-hashed at load (the image has no src/lib)", () => {
    expect(CSI_KB_BUILD_ONLY_SOURCES).toEqual(["src/lib/csi-tokenize.ts"]);
    const p = tamperedCopy("tokenizer-sha-altered.json", (kb) => {
      const t = kb.header.sources.find((s) => s.path === "src/lib/csi-tokenize.ts");
      if (!t) throw new Error("fixture: no tokenizer source entry");
      t.sha256 = flipHex(t.sha256);
    });
    h.reads.length = 0;
    expect(loadCsiKbFromFile(p).header.schemaVersion).toBe("csi-kb/2");
    expect(h.reads.some((r) => r.endsWith("csi-tokenize.ts"))).toBe(false);
  }, LOAD_TIMEOUT);

  it("a structural break (non-dense ids, same-code up, foreign patternId) throws", () => {
    const dense = tamperedCopy("not-dense.json", (kb) => {
      kb.patterns[5].id = 6;
    });
    expect(() => loadCsiKbFromFile(dense)).toThrow(/not dense/);
    const selfUp = tamperedCopy("self-up.json", (kb) => {
      kb.patterns[1].up = [0]; // patterns 0 and 1 are both 00 00 00
    });
    expect(() => loadCsiKbFromFile(selfUp)).toThrow(/same code/);
    const foreign = tamperedCopy("foreign-pid.json", (kb) => {
      kb.codes[0].patternIds = [...kb.codes[0].patternIds, kb.patterns.length - 1];
    });
    expect(() => loadCsiKbFromFile(foreign)).toThrow(/does not belong/);
    const badDiff = tamperedCopy("diff-out-of-range.json", (kb) => {
      kb.patterns[10].diff = [99];
    });
    expect(() => loadCsiKbFromFile(badDiff)).toThrow(/pattern 10: diff index 99 out of range/);
  }, LOAD_TIMEOUT);

  it("a malformed shape (source entry without path, pattern without tokens) throws a descriptive error", () => {
    const noPath = tamperedCopy("source-no-path.json", (kb) => {
      kb.header.sources = kb.header.sources.map((s, i) => (i === 1 ? ({ sha256: s.sha256 } as typeof s) : s));
    });
    expect(() => loadCsiKbFromFile(noPath)).toThrow(/^CSI KB \(.*\): malformed artifact/);
    const noTokens = tamperedCopy("pattern-no-tokens.json", (kb) => {
      kb.patterns[10] = { ...kb.patterns[10], tokens: undefined } as unknown as (typeof kb.patterns)[number];
    });
    expect(() => loadCsiKbFromFile(noTokens)).toThrow(/^CSI KB \(.*\): malformed artifact/);
  }, LOAD_TIMEOUT);
});

describe.skipIf(!HAS_KB)("csi-kb loader: indexes (E10)", () => {
  let kb: LoadedKb;
  beforeAll(() => {
    kb = loadCsiKb();
  }, LOAD_TIMEOUT);

  const postingKey = (m: Map<number, Int32Array>) => {
    const seen = new Map<number, number>(); // pattern id → tokenId it is posted under
    const dup: number[] = [];
    const unsorted: number[] = [];
    for (const [tid, ids] of m) {
      for (let i = 0; i < ids.length; i++) {
        if (i > 0 && ids[i] <= ids[i - 1]) unsorted.push(tid);
        if (seen.has(ids[i])) dup.push(ids[i]);
        seen.set(ids[i], tid);
      }
    }
    return { seen, dup, unsorted };
  };

  it("the loader's filler factor equals the builder's", () => {
    expect(CSI_KB_FILLER_FACTOR).toBe(FILLER_FACTOR);
  });

  it("tokenId / idf key sets equal the set of stored pattern tokens; ids are dense", () => {
    const stored = new Set(kb.patterns.flatMap((p) => p.tokens));
    expect(new Set(kb.tokenId.keys())).toEqual(stored);
    expect(new Set(kb.idf.keys())).toEqual(stored);
    expect([...kb.tokenId.values()].sort((a, b) => a - b)).toEqual([...Array(stored.size).keys()]);
    expect(kb.tokenId.size).toBe(kb.header.counts.vocab);
  });

  it("idf is un-halved ln(N/codeDF) (checked against kb-report.json's measured codeDF)", () => {
    const report = JSON.parse(readFileSync(join(root, "eval/csi/kb-report.json"), "utf-8")) as {
      topCodeDF: [string, number][];
      floorTokens: Record<string, number>;
    };
    const N = kb.header.counts.N;
    const df = new Map<string, number>([...report.topCodeDF, ...Object.entries(report.floorTokens)]);
    expect(df.get("equipment")).toBeGreaterThan(0); // a filler token: stored mass is halved
    const off: string[] = [];
    for (const [t, n] of df) {
      const got = kb.idf.get(t);
      if (got === undefined || Math.abs(got - Math.log(N / n)) > 2e-4) off.push(`${t}: ${got} vs ${Math.log(N / n)}`);
    }
    expect(off).toEqual([]);
  });

  it("every pattern with an anchor is posted once in anchorIndex, under its anchor token", () => {
    const { seen, dup, unsorted } = postingKey(kb.anchorIndex);
    expect(dup).toEqual([]);
    expect(unsorted).toEqual([]);
    const bad: number[] = [];
    let n = 0;
    for (const p of kb.patterns) {
      if (p.anchor === null) {
        if (seen.has(p.id)) bad.push(p.id);
        continue;
      }
      n++;
      if (seen.get(p.id) !== kb.tokenId.get(p.tokens[p.anchor])) bad.push(p.id);
    }
    expect(bad).toEqual([]);
    expect(seen.size).toBe(n);
  });

  it("every anchor-null token pattern is posted once in genericIndex, under its rarest token", () => {
    const { seen, dup, unsorted } = postingKey(kb.genericIndex);
    expect(dup).toEqual([]);
    expect(unsorted).toEqual([]);
    const floorish = new Set([...kb.header.floorTokens, ...kb.header.boilerplateTokens]);
    const bad: string[] = [];
    let n = 0;
    for (const p of kb.patterns) {
      const generic = p.anchor === null && p.kind !== "regex";
      if (!generic) {
        if (seen.has(p.id)) bad.push(`${p.id} posted but not generic`);
        continue;
      }
      n++;
      const tid = seen.get(p.id);
      const key = p.tokens.findIndex((t) => kb.tokenId.get(t) === tid);
      if (key < 0) {
        bad.push(`${p.id} missing`);
        continue;
      }
      const max = Math.max(...p.tokens.map((t) => kb.idf.get(t) ?? 0));
      const first = p.tokens.findIndex((t) => (kb.idf.get(t) ?? 0) >= max - 2.5e-4);
      if (key !== first) bad.push(`${p.id} keyed ${p.tokens[key]}, rarest ${p.tokens[first]}`);
      if (!p.tokens.every((t) => floorish.has(t))) bad.push(`${p.id} has a non-floored token`);
    }
    expect(bad).toEqual([]);
    expect(seen.size).toBe(n);
    expect(n).toBe(kb.header.counts.genericPatterns);
    expect(n).toBeGreaterThan(0);
  });

  it("regex patterns are in neither index", () => {
    const regex = kb.patterns.filter((p) => p.kind === "regex").map((p) => p.id);
    expect(regex.length).toBe(kb.header.counts.patterns_regex);
    const posted = new Set([...kb.anchorIndex.values(), ...kb.genericIndex.values()].flatMap((a) => [...a]));
    expect(regex.filter((id) => posted.has(id))).toEqual([]);
    expect(posted.size + regex.length).toBe(kb.patterns.length);
  });

  it("up is one Int32Array per pattern, equal to the stored up, referencing other codes only", () => {
    expect(kb.up.length).toBe(kb.patterns.length);
    const bad: number[] = [];
    let edges = 0;
    for (const p of kb.patterns) {
      const u = kb.up[p.id];
      if (!(u instanceof Int32Array) || u.length !== p.up.length) {
        bad.push(p.id);
        continue;
      }
      for (let i = 0; i < u.length; i++) {
        edges++;
        if (u[i] !== p.up[i] || kb.patterns[u[i]].code === p.code) bad.push(p.id);
      }
    }
    expect(bad).toEqual([]);
    expect(edges).toBeGreaterThan(0);
  });

  it("known = header.abbrevTokens; byCode covers every code", () => {
    expect([...kb.known].sort()).toEqual([...kb.header.abbrevTokens].sort());
    expect(kb.known.has("gwb") && kb.known.has("cmu") && kb.known.has("hm")).toBe(true);
    expect(kb.byCode.size).toBe(kb.codes.length);
    expect(kb.byCode.get("08 11 13")?.title).toBe(kb.codes.find((c) => c.code === "08 11 13")?.title);
  });
});

// ── server-only walk ────────────────────────────────────────────────────────────────────────
const SPEC_RE = /(^|\/)csi-kb(\.ts)?$/;
/** Module specifiers of csi-kb pulled in at RUNTIME by `src` (anything but `import type`/`export type`). */
function valueImportsOfCsiKb(src: string): string[] {
  const out: string[] = [];
  const stmt = /\b(import|export)\s+(type\s+)?[^;'"`]*?\bfrom\s*["']([^"']+)["']/g;
  for (let m = stmt.exec(src); m; m = stmt.exec(src)) {
    if (SPEC_RE.test(m[3]) && !m[2]) out.push(m[0]);
  }
  const bare = /\b(?:import\s*\(\s*|require\s*\(\s*|import\s+)["']([^"']+)["']/g;
  for (let m = bare.exec(src); m; m = bare.exec(src)) {
    if (SPEC_RE.test(m[1])) out.push(m[0]);
  }
  return out;
}

function walk(dir: string, keep: (rel: string) => boolean, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, keep, acc);
    else if (keep(relative(root, p))) acc.push(p);
  }
  return acc;
}

describe("csi-kb is server-only (no client value import)", () => {
  it("the detector flags value imports and passes type-only ones", () => {
    expect(valueImportsOfCsiKb('import { loadCsiKb } from "@/lib/csi-kb";')).toHaveLength(1);
    expect(valueImportsOfCsiKb("import {\n  loadCsiKb,\n  loadCsiKbFromFile,\n} from '../lib/csi-kb'")).toHaveLength(1);
    expect(valueImportsOfCsiKb('import * as kb from "@/lib/csi-kb"')).toHaveLength(1);
    expect(valueImportsOfCsiKb('export { loadCsiKb } from "@/lib/csi-kb";')).toHaveLength(1);
    expect(valueImportsOfCsiKb('const m = await import("@/lib/csi-kb");')).toHaveLength(1);
    expect(valueImportsOfCsiKb('import "@/lib/csi-kb";')).toHaveLength(1);
    expect(valueImportsOfCsiKb('import { type LoadedKb } from "@/lib/csi-kb";')).toHaveLength(1);
    expect(valueImportsOfCsiKb('import type { LoadedKb } from "@/lib/csi-kb";')).toEqual([]);
    expect(valueImportsOfCsiKb('export type { LoadedKb } from "@/lib/csi-kb";')).toEqual([]);
    expect(valueImportsOfCsiKb('import type { KbCode } from "@/lib/csi-kb-types";')).toEqual([]);
    expect(valueImportsOfCsiKb('import { tokenize } from "@/lib/csi-tokenize";')).toEqual([]);
  });

  it("no file under src/components, src/stores, src/queries, src/hooks, an app page/layout, or any \"use client\" file value-imports it", () => {
    const code = (rel: string) => /\.(ts|tsx|js|jsx|mjs)$/.test(rel) && !rel.includes("__tests__");
    const USE_CLIENT = /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*["']use client["']/;
    const clientFiles = walk(join(root, "src"), code).filter((f) => USE_CLIENT.test(readFileSync(f, "utf-8")));
    const files = [...new Set([
      ...walk(join(root, "src/components"), code),
      ...walk(join(root, "src/stores"), code),
      ...walk(join(root, "src/queries"), code),
      ...walk(join(root, "src/hooks"), code),
      ...walk(join(root, "src/app"), (rel) => /(^|\/)(page|layout)\.tsx$/.test(rel)),
      ...clientFiles,
    ])];
    expect(files.length).toBeGreaterThan(100);
    // The "use client" scan reaches files the four directories miss (e.g. src/app/admin/tabs/CsiTab.tsx).
    expect(clientFiles.some((f) => relative(root, f) === "src/app/admin/tabs/CsiTab.tsx")).toBe(true);
    const hits = files.flatMap((f) => valueImportsOfCsiKb(readFileSync(f, "utf-8")).map((s) => `${relative(root, f)}: ${s}`));
    expect(hits).toEqual([]);
  });
});
