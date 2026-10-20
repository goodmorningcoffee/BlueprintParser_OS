// @vitest-environment node
/**
 * csi-kb-artifact.test.ts — CSI tagger v2, S2: the built KB `src/data/csi-kb.json`.
 *
 * The KB is GITIGNORED BY DESIGN (owner ruling D1, 2026-10-20: its ~11,500 MasterFormat phrases are
 * not redistributed on GitHub). A fresh clone — GitHub CI included — has no copy, so every describe
 * here is `skipIf(!HAS_KB)`. The skip is announced by src/test/global-setup.ts, whose output the
 * default reporter prints (the console.warn below shows only under --reporter=verbose), and under
 * BP_REQUIRE_CSI_KB=1 — scripts/bp-suite's default — an absent KB fails the run instead.
 *
 * The artifact is built by `eval/csi/build-kb-v2.ts` from the MasterFormat PDF + three TSVs +
 * the tokenizer (IMPLEMENTATION §II S2, §IV E12). The full-PDF rebuild is deliberately NOT a
 * vitest case (parse + lattice ≈ 9 s); instead:
 *   - FRESHNESS: every in-repo input's raw-byte sha256 must equal `header.sources` — change
 *     `csi-masterformat.tsv`, `csi.tsv`, `csi_terms.tsv` or `csi-tokenize.ts` (or the builder's
 *     `BUILDER_VERSION`) without rebuilding and this file fails. The PDF entry is not checked
 *     (it is outside the repo); `eval/csi/kb-report.json` is the committed record of the build.
 *   - STRUCTURE + RULES: the §5.6 gate counters, parent(), the 08 11 lattice family, anchors,
 *     the E2 diff rule (recomputed for every pattern), the D6/E12e shadow filters, the generic
 *     list, the fold fixpoint and csi_terms parity, read off the artifact itself.
 *   - OWNER RULING 2026-10-20 (kb-v2.4, variant E): fold always; a code's MF title owns its token
 *     set; process-division (40–49) titles do not own against building codes. Each has its own
 *     test below, and disabling any one rule in the builder fails that test.
 * Rebuild: see the header of `eval/csi/build-kb-v2.ts` (bundle → build/csi-kbv2-build.js).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FOLD_MAP, tokenize } from "@/lib/csi-tokenize";
import { loadCsiKbFromFile } from "@/lib/csi-kb";
import type { CsiKb, KbCode, KbPattern } from "@/lib/csi-kb-types";
import {
  BOILERPLATE_WORDS,
  BUILDER_VERSION,
  FILLER_WORDS,
  PDF_SOURCE,
  SOURCE_PATHS,
  TSV_JUNK_RE,
  isProcessDivision,
  parentOf,
  parseTermsTsv,
  readMasterformatTsv,
} from "../../../eval/csi/build-kb-v2";

const root = process.cwd();
const KB_REL = "src/data/csi-kb.json";
/** Absent on a fresh clone by design (D1, 2026-10-20) — see the file header. */
const HAS_KB = existsSync(join(root, KB_REL));
if (!HAS_KB) {
  console.warn(
    `[csi-kb-artifact] SKIPPING every test in this file: ${KB_REL} is absent (gitignored by design, owner ruling D1). ` +
      "Rebuild it from the MasterFormat PDF — see the header of eval/csi/build-kb-v2.ts (esbuild bundle → node build/csi-kbv2-build.js).",
  );
}
const read = (p: string) => readFileSync(join(root, p), "utf-8");
const sha256File = (p: string) => createHash("sha256").update(readFileSync(join(root, p))).digest("hex");
/** vocab omitted = every FOLD_MAP fold (the kb-v2.4 build rule). */
const uniqTokens = (text: string, vocab?: ReadonlySet<string>) => [...new Set(tokenize(text, vocab).map((t) => t.t))];
const setKey = (ts: string[]) => [...ts].sort().join(" ");

/** E12a: the EXACT report key list. */
const REPORT_KEYS = [
  "overGrabResidual", "dupWords", "danglingInPatterns", "unassignedInPatterns", "numericOrLen1Tokens",
  "le2CharPatterns", "misHeadedGoldens", "oneWordTermMultiFamily", "reach_oneTokenTolerance", "reach_diffMassGE80",
];
/** ONE measured generic title (every token floored), chosen from the built KB (D2). */
const PINNED_GENERIC = { code: "33 10 00", text: "Water Utilities", tokens: ["water", "utility"] };

let kb: CsiKb;
let byCode: Map<string, KbCode>;
let vocab: Set<string>;
const titleOf = (code: string): KbPattern => {
  const p = kb.patterns.find((x) => x.code === code && x.source === "title");
  if (!p) throw new Error(`no title pattern for ${code}`);
  return p;
};
const tokensAt = (p: KbPattern, idx: number[]) => idx.map((i) => p.tokens[i]);

beforeAll(() => {
  if (!HAS_KB) return;
  kb = JSON.parse(read(KB_REL)) as CsiKb;
  byCode = new Map(kb.codes.map((c) => [c.code, c]));
  vocab = new Set(kb.patterns.flatMap((p) => p.tokens));
});

describe.skipIf(!HAS_KB)("csi-kb.json header + freshness (no PDF needed)", () => {
  it("is schema csi-kb/2 at the builder's current version", () => {
    expect(kb.header.schemaVersion).toBe("csi-kb/2");
    expect(kb.header.builderVersion).toBe(BUILDER_VERSION);
  });

  it("lists the five sources in order, and every in-repo input hashes to its recorded sha256", () => {
    expect(kb.header.sources.map((s) => s.path)).toEqual([PDF_SOURCE, ...SOURCE_PATHS]);
    expect(kb.header.sources[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    for (const s of kb.header.sources.slice(1)) {
      expect(sha256File(s.path), `${s.path} changed since the KB was built — rebuild it`).toBe(s.sha256);
    }
  });

  it("report holds exactly the E12a keys; all gate counters are 0; the two reach counters are printed", () => {
    const r = kb.header.report;
    expect(Object.keys(r)).toEqual(REPORT_KEYS);
    for (const k of REPORT_KEYS.filter((x) => !x.startsWith("reach_"))) expect(r[k], k).toBe(0);
    const den = kb.header.counts.reachDenominator;
    console.log(
      `[csi-kb] reach_oneTokenTolerance=${r.reach_oneTokenTolerance} reach_diffMassGE80=${r.reach_diffMassGE80} of ${den} multi-token patterns`,
    );
    for (const k of ["reach_oneTokenTolerance", "reach_diffMassGE80"]) {
      expect(r[k]).toBeGreaterThan(0);
      expect(r[k]).toBeLessThanOrEqual(den);
    }
  });

  it("counts agree with the arrays they describe", () => {
    const c = kb.header.counts;
    expect(c.codes).toBe(kb.codes.length);
    expect(c.patterns).toBe(kb.patterns.length);
    for (const s of ["title", "tsv", "alt", "index", "see", "term"]) {
      expect(c[`patterns_${s}`], s).toBe(kb.patterns.filter((p) => p.source === s).length);
    }
    expect(c.N).toBe(new Set(kb.patterns.map((p) => p.code)).size);
    // D5 as extended by E12e: 16 junk rows + 28 46 20 (= 28 46 21) + 09 62 23 (= 09 64 36 Bamboo Flooring).
    expect(c.tsvOnlyDropped).toBe(18);
    expect(c.tsvOnlyKept).toBe(1);
  });
});

describe.skipIf(!HAS_KB)("csi-kb.json structure", () => {
  // Each check collects violations and asserts ONE empty list: ~21k patterns × per-item
  // `expect` calls exceed vitest's 5 s budget, and a list names every offender at once.
  it("pattern ids are dense, codes are sorted, and patternIds/code links agree both ways", () => {
    const bad: string[] = [];
    kb.patterns.forEach((p, i) => { if (p.id !== i) bad.push(`id ${p.id} at ${i}`); });
    const codes = kb.codes.map((c) => c.code);
    expect(codes).toEqual([...codes].sort());
    for (const c of kb.codes) {
      for (const id of c.patternIds) if (kb.patterns[id]?.code !== c.code) bad.push(`${c.code} → ${id}`);
      if (c.division !== `${c.code.slice(0, 2)} 00 00`) bad.push(`${c.code} division ${c.division}`);
    }
    const linked = new Set(kb.codes.flatMap((c) => c.patternIds));
    for (const p of kb.patterns) if (!byCode.has(p.code) || !linked.has(p.id)) bad.push(`pattern ${p.id} unlinked`);
    expect(bad).toEqual([]);
  });

  it("every pattern is internally consistent (mass, diff, anchor, up, hintOnly, regex)", () => {
    const bad: string[] = [];
    const massOf = new Map<string, number>();
    const filler = new Set(kb.header.fillerTokens);
    for (const p of kb.patterns) {
      const why = (m: string) => bad.push(`${p.id} ${p.code} '${p.text}': ${m}`);
      if (p.kind === "regex") {
        if (p.tokens.length || p.up.length || p.diff.length || p.anchor !== null) why("regex pattern carries lattice fields");
        try { new RegExp(p.regex ?? "", "i"); } catch { why("invalid regex"); }
        continue;
      }
      if (!p.tokens.length) why("no tokens");
      if (new Set(p.tokens).size !== p.tokens.length) why("duplicate tokens");
      if (p.mass.length !== p.tokens.length) why("mass length");
      if (p.diff.some((i) => i < 0 || i >= p.tokens.length)) why("diff index out of range");
      if (p.anchor !== null && !filler.has(p.tokens[p.anchor]) && !p.diff.includes(p.anchor)) why("anchor not in diff");
      if ((p.hintOnly === true) !== (p.tokens.length === 1 && p.oneWordOk !== true)) why("hintOnly ≠ E6 rule");
      if (tokensAt(p, p.diff).some((t) => filler.has(t))) why("filler token in diff");
      const own = new Set(p.tokens);
      for (const q of p.up) {
        const u = kb.patterns[q];
        if (!u || u.code === p.code || u.tokens.length >= p.tokens.length || !u.tokens.every((t) => own.has(t))) why(`up ${q} is not a proper subset of another code`);
      }
      p.tokens.forEach((t, i) => {
        const m = massOf.get(t);
        if (m === undefined) massOf.set(t, p.mass[i]);
        else if (m !== p.mass[i]) why(`mass of '${t}' ${p.mass[i]} ≠ ${m}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it("E2 diff, recomputed for EVERY token pattern: {anchor} ∪ titleDiff (titles) ∪ (tokens \\ ∪up, only when up ≠ ∅), minus filler", () => {
    // Roots (up = []) therefore carry only the anchor (+ the title-diff for titles): a non-title
    // root must never require all its tokens, which would silently turn 4/5 into 5/5.
    const filler = new Set(kb.header.fillerTokens);
    const titleTok = new Map<string, string[]>();
    for (const p of kb.patterns) if (p.source === "title" || p.source === "tsv") titleTok.set(p.code, p.tokens);
    const bad: string[] = [];
    let roots = 0;
    for (const p of kb.patterns) {
      if (p.kind !== "tokens") continue;
      const d = new Set<number>();
      if (p.anchor !== null) d.add(p.anchor);
      if (p.source === "title") {
        const parent = byCode.get(p.code)?.parent ?? null;
        const pt = new Set(parent ? titleTok.get(parent) ?? [] : []);
        if (pt.size) p.tokens.forEach((t, i) => { if (!pt.has(t)) d.add(i); });
      }
      if (p.up.length) {
        const covered = new Set(p.up.flatMap((q) => kb.patterns[q].tokens));
        p.tokens.forEach((t, i) => { if (!covered.has(t)) d.add(i); });
      } else if (p.source !== "title" && p.tokens.length > 1) {
        roots++;
      }
      const want = [...d].filter((i) => !filler.has(p.tokens[i])).sort((a, b) => a - b);
      if (want.join(",") !== p.diff.join(",")) bad.push(`${p.id} ${p.code} '${p.text}': diff [${p.diff}] ≠ [${want}]`);
    }
    expect(bad.slice(0, 20)).toEqual([]);
    expect(roots).toBeGreaterThan(1000); // the rule is exercised (≈3.5k non-title multi-token roots)
  });

  it("owner ruling 2026-10-20: a curated term row owns its token set; no other code keeps an equal MF/TSV pattern", () => {
    const key = (ts: string[]) => [...new Set(ts)].sort().join(" ");
    const owners = new Map<string, Set<string>>();
    for (const p of kb.patterns) {
      if (p.source !== "term" || p.kind !== "tokens") continue;
      owners.set(key(p.tokens), (owners.get(key(p.tokens)) ?? new Set<string>()).add(p.code));
    }
    const residual = kb.patterns.filter((p) => p.source !== "term" && p.kind === "tokens" && owners.get(key(p.tokens)) && !owners.get(key(p.tokens))?.has(p.code));
    expect(residual.map((p) => `${p.code} ${p.source} '${p.text}'`)).toEqual([]);
    const c = kb.header.counts;
    const dropped = ["title", "tsv", "alt", "index", "see"].reduce((n, s) => n + (c[`${s}EqOtherCodeTermRow`] ?? 0), 0);
    expect(dropped).toBe(27); // measured 2026-10-20 at kb-v2.3: title 2 · alt 20 · index 4 · see 1
    // The visible cost: division 40's Ball/Gate Valves lose every text pattern to the 22/23 05 23 term rows.
    for (const code of ["40 05 61", "40 05 63"]) {
      expect(kb.patterns.filter((p) => p.code === code && p.kind === "tokens"), code).toEqual([]);
    }
    expect(kb.patterns.filter((p) => p.source === "term" && key(p.tokens) === "ball valve").map((p) => p.code).sort()).toEqual(["22 05 23", "23 05 23"]);
  });

  it("owner ruling 2026-10-20 (kb-v2.4): a code's MF title owns its token set against other codes' alt/index/see", () => {
    // Recomputed from the artifact exactly as the builder decides it: owners = codes whose KEPT title
    // has the set (a term-owned set is the term rule's alone); a building-code pattern ignores
    // process-division (40–49) titles. Every surviving alt/index/see must be one of its owners.
    const termKeys = new Set(kb.patterns.filter((p) => p.source === "term" && p.kind === "tokens").map((p) => setKey(p.tokens)));
    const owners = new Map<string, Set<string>>();
    for (const p of kb.patterns) {
      if (p.source !== "title" || termKeys.has(setKey(p.tokens))) continue;
      owners.set(setKey(p.tokens), (owners.get(setKey(p.tokens)) ?? new Set<string>()).add(p.code));
    }
    const residual: string[] = [];
    for (const p of kb.patterns) {
      if (p.kind !== "tokens" || (p.source !== "alt" && p.source !== "index" && p.source !== "see")) continue;
      const o = [...(owners.get(setKey(p.tokens)) ?? [])].filter((c) => isProcessDivision(p.code) || !isProcessDivision(c));
      if (o.length && !o.includes(p.code)) residual.push(`${p.id} ${p.code}/${p.source} '${p.text}' = title of ${o.join(",")}`);
    }
    expect(residual).toEqual([]);
    // Measured at kb-v2.4 (counted AFTER the facet and D6 filters, so only what the ruling added).
    const c = kb.header.counts;
    expect([c.altEqOtherCodeTitle, c.indexEqOtherCodeTitle, c.seeEqOtherCodeTitle]).toEqual([29, 135, 2]);
  });

  it("owner ruling 2026-10-20 (kb-v2.4): process-division titles (40–49) do not take a building code's pattern", () => {
    // Measured: 10 building-code alt/index/see patterns survive only because the title with their set
    // is a process title; the two adjudicated in notes/FOLD_EXPERIMENT_2026-10-20.md are pinned.
    expect(isProcessDivision("40 05 81.33") && isProcessDivision("49 00 00") && !isProcessDivision("39 00 00") && !isProcessDivision("50 00 00")).toBe(true);
    const pairs: [string, string, string][] = [["22 11 19", "40 05 81.33", "bibb hose"], ["22 13 19", "46 25 23", "grease trap"]];
    for (const [building, proc, set] of pairs) {
      expect(setKey(titleOf(proc).tokens), proc).toBe(set);
      expect(kb.patterns.filter((p) => p.code === building && p.source === "index" && setKey(p.tokens) === set), building).toHaveLength(1);
    }
    const procTitleKeys = new Map<string, string[]>();
    for (const p of kb.patterns) {
      if (p.source === "title" && isProcessDivision(p.code)) procTitleKeys.set(setKey(p.tokens), [...(procTitleKeys.get(setKey(p.tokens)) ?? []), p.code]);
    }
    const nonProcTitleKeys = new Set(kb.patterns.filter((p) => p.source === "title" && !isProcessDivision(p.code)).map((p) => setKey(p.tokens)));
    const exempted = kb.patterns.filter((p) => (p.source === "alt" || p.source === "index" || p.source === "see") && !isProcessDivision(p.code) &&
      procTitleKeys.has(setKey(p.tokens)) && !nonProcTitleKeys.has(setKey(p.tokens)));
    expect(exempted.map((p) => p.code)).toHaveLength(10);
  });

  it("D6 (extended by E12e): no alt/index/see pattern has the token set of a DESCENDANT's title", () => {
    const c = kb.header.counts;
    expect(c.altDupOfDescendantTitle).toBeGreaterThan(0);
    expect(c.indexDupOfDescendantTitle).toBeGreaterThanOrEqual(1);
    const descKeys = new Map<string, Set<string>>();
    for (const p of kb.patterns) {
      if (p.source !== "title" && p.source !== "tsv") continue;
      for (let a = byCode.get(p.code)?.parent ?? null; a; a = byCode.get(a)?.parent ?? null) {
        descKeys.set(a, new Set([...(descKeys.get(a) ?? []), setKey(p.tokens)]));
      }
    }
    const resid = kb.patterns.filter((p) =>
      (p.source === "alt" || p.source === "index" || p.source === "see") && descKeys.get(p.code)?.has(setKey(p.tokens)));
    expect(resid.map((p) => `${p.id} ${p.code}/${p.source} '${p.text}'`)).toEqual([]);
    // The two measured cases: 08 13 00 alt "hollow metal doors" (= 08 13 13) and 00 31 13 index
    // "preliminary, construction schedules" (= 00 31 13.16).
    expect(kb.patterns.some((p) => p.code === "08 13 00" && p.source === "alt" && setKey(p.tokens) === setKey(titleOf("08 13 13").tokens))).toBe(false);
    expect(kb.patterns.some((p) => p.code === "00 31 13" && setKey(p.tokens) === setKey(titleOf("00 31 13.16").tokens))).toBe(false);
  });

  it("E12e index facet rows (sub-entry text ⊆ head) are dropped: 3 facets + 20 token-less NAICS sub-entries", () => {
    expect(kb.header.counts.indexFacetRows).toBe(3); // 'doors' / 'frames' under 'hollow metal doors and frames'; 'process equipment'
    expect(kb.header.counts.indexEmptySubEntryRows).toBe(20); // bare NAICS group numbers under one head
    const t0811 = setKey(titleOf("08 11 13").tokens);
    const facet = kb.patterns.filter((p) => (p.code === "08 12 13" || p.code === "08 13 13") && p.source === "index" && setKey(p.tokens) === t0811);
    expect(facet.map((p) => `${p.id} ${p.code} '${p.text}'`)).toEqual([]);
  });

  it("no pattern has a numeric or length-1 token; no non-term pattern is all ≤2-char tokens", () => {
    const bad = kb.patterns.filter((p) =>
      p.tokens.some((t) => t.length < 2 || /^\d+$/.test(t)) ||
      (p.source !== "term" && p.kind === "tokens" && p.tokens.every((t) => t.length <= 2)));
    expect(bad.map((p) => `${p.id}:${p.text}`)).toEqual([]);
  });
});

describe.skipIf(!HAS_KB)("parent() by digit shape", () => {
  it("walks .NN → NNNNNN → NNNN00 → NNN000 → NN0000", () => {
    const has = (c: string) => byCode.has(c);
    expect(parentOf("08 11 13.13", has)).toBe("08 11 13");
    expect(parentOf("08 11 13", has)).toBe("08 11 00");
    expect(parentOf("08 11 00", has)).toBe("08 10 00");
    expect(parentOf("08 10 00", has)).toBe("08 00 00");
    expect(parentOf("08 00 00", has)).toBeNull();
  });

  it("skips absent codes, and every stored parent equals parentOf over the KB's code set", () => {
    expect(parentOf("08 11 13", (c) => c === "08 10 00")).toBe("08 10 00");
    const has = (c: string) => byCode.has(c);
    expect(kb.codes.filter((c) => c.parent !== parentOf(c.code, has)).map((c) => c.code)).toEqual([]);
  });
});

describe.skipIf(!HAS_KB)("lattice (IMPLEMENTATION §II S2 as amended 2026-10-20)", () => {
  it("08 11 13 Hollow Metal Doors and Frames: diff ⊇ {hollow}; up ⊇ titles of 08 11 00, 08 12 13, 08 13 13", () => {
    const p = titleOf("08 11 13");
    expect(tokensAt(p, p.diff)).toContain("hollow");
    for (const c of ["08 11 00", "08 12 13", "08 13 13"]) expect(p.up, c).toContain(titleOf(c).id);
  });

  it("08 11 13.13 Standard Hollow Metal Doors and Frames: diff ⊇ {standard}", () => {
    const p = titleOf("08 11 13.13");
    expect(tokensAt(p, p.diff)).toContain("standard");
  });

  it("the generic list is non-empty and holds the pinned measured title", () => {
    const generic = kb.patterns.filter((p) => p.kind === "tokens" && p.anchor === null);
    expect(generic.length).toBeGreaterThan(0);
    const floor = new Set([...kb.header.floorTokens, ...kb.header.boilerplateTokens]);
    expect(generic.filter((p) => !p.tokens.every((t) => floor.has(t))).map((p) => p.id)).toEqual([]);
    const pinned = titleOf(PINNED_GENERIC.code);
    expect(pinned.text).toBe(PINNED_GENERIC.text);
    expect(pinned.tokens).toEqual(PINNED_GENERIC.tokens);
    expect(pinned.anchor).toBeNull();
  });

  it("METAL DOORS (08 13 00) is NOT generic: its anchor is door (codeDF 193 < floor 200)", () => {
    const p = titleOf("08 13 00");
    expect(p.anchor).not.toBeNull();
    expect(p.tokens[p.anchor ?? -1]).toBe("door");
  });

  it("an anchor is the rarest non-floored NON-FILLER token, a filler token only when no other is free (E12e)", () => {
    const blocked = new Set([...kb.header.floorTokens, ...kb.header.boilerplateTokens]);
    const filler = new Set(kb.header.fillerTokens);
    const bad: string[] = [];
    let fillerAnchors = 0;
    for (const p of kb.patterns) {
      if (p.kind !== "tokens") continue;
      const idf = (i: number) => p.mass[i] * (filler.has(p.tokens[i]) ? 2 : 1);
      const free = p.tokens.map((_, i) => i).filter((i) => !blocked.has(p.tokens[i]));
      if ((p.anchor === null) !== (free.length === 0)) bad.push(`${p.id}: anchor/free mismatch`);
      if (p.anchor === null) continue;
      if (blocked.has(p.tokens[p.anchor])) bad.push(`${p.id}: floored anchor`);
      const solid = free.filter((i) => !filler.has(p.tokens[i]));
      if (filler.has(p.tokens[p.anchor])) {
        fillerAnchors++;
        if (solid.length) bad.push(`${p.id} '${p.text}': filler anchor beside non-filler ${solid.map((i) => p.tokens[i])}`);
      }
      const a = idf(p.anchor);
      for (const i of solid.length ? solid : free) if (idf(i) > a + 1e-3) bad.push(`${p.id}:${p.tokens[i]}`);
    }
    expect(bad).toEqual([]);
    expect(fillerAnchors).toBe(kb.header.counts.fillerAnchors);
    // 01 61 00 Common Product Requirements: anchored on `requirement`, not the filler `product`.
    const cpr = titleOf("01 61 00");
    expect(cpr.tokens[cpr.anchor ?? -1]).toBe("requirement");
  });
});

describe.skipIf(!HAS_KB)("token lists and fold vocabulary", () => {
  it("header.floorTokens is pinned (fixtures/csi-v2/floor-tokens.json)", () => {
    const fixture = JSON.parse(read("src/lib/__tests__/fixtures/csi-v2/floor-tokens.json")) as string[];
    expect(kb.header.floorTokens).toEqual(fixture);
    expect(fixture).toHaveLength(19);
  });

  it("floor, filler, boilerplate and abbrev lists are canonical tokens (D4)", () => {
    const h = kb.header;
    for (const t of [...h.floorTokens, ...h.fillerTokens, ...h.boilerplateTokens, ...h.abbrevTokens]) {
      expect(uniqTokens(t, vocab), t).toEqual([t]);
    }
    expect(h.fillerTokens).toEqual([...new Set(FILLER_WORDS.flatMap((w) => uniqTokens(w, vocab)))].sort());
    expect(h.boilerplateTokens).toEqual([...new Set(BOILERPLATE_WORDS.flatMap((w) => uniqTokens(w, vocab)))].sort());
    for (const t of ["gwb", "cmu", "hm"]) expect(h.abbrevTokens).toContain(t);
  });

  it("abbrevTokens (E12e): one-token abbrev rows give their token; multi-token rows only non-title words", () => {
    const h = kb.header;
    for (const t of ["gyp", "bd", "mtl"]) expect(h.abbrevTokens, t).toContain(t); // GYP BD, MTL STUD
    expect(h.abbrevTokens).not.toContain("stud"); // a MasterFormat title word, not an abbreviation
    expect(h.abbrevTokens).not.toContain("lam"); // P-LAM is a regex row now
    const rows = parseTermsTsv(read("src/data/csi_terms.tsv")).filter((r) => r.kind === "abbrev");
    const titleWords = new Set(kb.patterns.filter((p) => p.source === "title").flatMap((p) => p.tokens));
    const want = new Set(rows.flatMap((r) => {
      const ts = uniqTokens(r.term, vocab);
      return ts.length === 1 ? ts : ts.filter((t) => !titleWords.has(t));
    }));
    expect(h.abbrevTokens).toEqual([...want].sort());
  });

  it("fold fixpoint (E12b): re-tokenizing every pattern text with vocab = the KB token set reproduces its tokens", () => {
    const bad = kb.patterns.filter((p) => p.kind === "tokens" && uniqTokens(p.text, vocab).join(" ") !== p.tokens.join(" "));
    expect(bad.map((p) => `${p.id}:${p.text}`)).toEqual([]);
  });

  it("owner ruling 2026-10-20 (kb-v2.4): FOLD ALWAYS — every pattern is its text's NO-vocab tokenization; no FOLD_MAP key is a token", () => {
    // The second line is the premise of the runtime-equivalence proof (eval/csi/build-kb-v2.ts §3): a
    // fold the runtime skips (stem ∉ KB tokens) then maps one out-of-vocabulary word to another.
    const bad = kb.patterns.filter((p) => p.kind === "tokens" && uniqTokens(p.text).join(" ") !== p.tokens.join(" "));
    expect(bad.map((p) => `${p.id}:${p.text}`)).toEqual([]);
    expect(Object.keys(FOLD_MAP).filter((k) => vocab.has(k))).toEqual([]);
    expect(Object.hasOwn(FOLD_MAP, "cooling")).toBe(false); // deleted at kb-v2.4: a pure token rename under fold-always
  });

  it("fold probe: FIRESTOP / FIRESTOPPING ALL PENETRATIONS, through the LOADER's vocab, both set-match only 07 84 13", () => {
    // Stand-in for the S3 matcher: a probe hits a pattern whose token set equals the probe's non-boilerplate
    // tokens (`all` is boilerplate, PLAN §5.5). FIRESTOPPING is the FOLD_MAP key, so it is the vocab-sensitive
    // form: the loader's vocab folds it (it holds `firestop`), an empty vocab does not. MEASURED 2026-10-20:
    // at kb-v2.3 the title was stored `firestopping`, so the FIRESTOP probe hit nothing and the loader left
    // FIRESTOPPING unfolded; at kb-v2.4 both surface forms reach the same two patterns.
    const loaderVocab = new Set(loadCsiKbFromFile(join(root, KB_REL)).idf.keys());
    expect(loaderVocab).toEqual(vocab);
    expect(uniqTokens("FIRESTOPPING", loaderVocab)).toEqual(["firestop"]);
    expect(uniqTokens("FIRESTOPPING", new Set())).toEqual(["firestopping"]); // the fold above is the vocab's doing
    const boiler = new Set(kb.header.boilerplateTokens);
    const setMatch = (text: string) => {
      const key = setKey(uniqTokens(text, loaderVocab).filter((t) => !boiler.has(t)));
      return kb.patterns.filter((p) => p.kind === "tokens" && setKey(p.tokens) === key).map((p) => `${p.code}/${p.source}`);
    };
    for (const text of ["FIRESTOP ALL PENETRATIONS", "FIRESTOPPING ALL PENETRATIONS"]) {
      expect(uniqTokens(text, loaderVocab), text).toEqual(["firestop", "all", "penetration"]);
      expect(setMatch(text), text).toEqual(["07 84 13/title", "07 84 13/index"]);
    }
    expect(setKey(titleOf("07 84 13").tokens)).toBe("firestop penetration"); // kb-v2.3 stored `firestopping`
  });
});

describe.skipIf(!HAS_KB)("TSV sources", () => {
  it("trade comes from csi-masterformat.tsv (08 71 00)", () => {
    const tsv = readMasterformatTsv(read("src/data/csi-masterformat.tsv"));
    expect(byCode.get("08 71 00")?.trade).toBe(tsv.get("08 71 00")?.trade);
    expect(byCode.get("08 71 00")?.trade).toBe("Openings");
  });

  it("D5 TSV-only hygiene: junk rows, 28 46 20 and 09 62 23 are absent; 28 27 00 is the one tsv pattern", () => {
    const tsv = readMasterformatTsv(read("src/data/csi-masterformat.tsv"));
    const titled = new Set(kb.patterns.filter((p) => p.source === "title").map((p) => p.code));
    for (const r of tsv.values()) {
      if (!TSV_JUNK_RE.test(r.title)) continue;
      expect(byCode.has(r.code) && !titled.has(r.code), `${r.code} '${r.title}'`).toBe(false);
    }
    expect(byCode.has("28 46 20")).toBe(false);
    expect(byCode.has("09 62 23")).toBe(false); // = 09 64 36 Bamboo Flooring (E12e: all titles, not siblings)
    expect(kb.patterns.filter((p) => p.source === "tsv").map((p) => p.code)).toEqual(["28 27 00"]);
    const titleKeys = new Set(kb.patterns.filter((p) => p.source === "title").map((p) => setKey(p.tokens)));
    expect(kb.patterns.filter((p) => p.source === "tsv" && titleKeys.has(setKey(p.tokens))).map((p) => p.code)).toEqual([]);
  });

  it("csi_terms.tsv parity: every row tokenizes through the same tokenizer and is present as a term pattern", () => {
    const rows = parseTermsTsv(read("src/data/csi_terms.tsv"));
    expect(rows).toHaveLength(55); // 61 seed rows − 6 dropped by the S2 term review (2026-10-20)
    const terms = kb.patterns.filter((p) => p.source === "term");
    for (const r of rows) {
      const hit = r.kind === "regex"
        ? terms.find((p) => p.code === r.code && p.kind === "regex" && p.regex === r.term)
        : terms.find((p) => p.code === r.code && p.kind === "tokens" && setKey(p.tokens) === setKey(uniqTokens(r.term, vocab)));
      expect(hit, `${r.term} → ${r.code}`).toBeDefined();
      if (r.discipline) expect(hit?.discipline).toBe(r.discipline);
    }
  });

  it("one-word term rows each map to exactly one L3 family (E12d)", () => {
    const rows = parseTermsTsv(read("src/data/csi_terms.tsv"));
    const family = (code: string): string => {
      for (let c: string | null = code; c; c = byCode.get(c)?.parent ?? null) if ((byCode.get(c)?.level ?? 5) <= 3) return c;
      return code;
    };
    const fam = new Map<string, Set<string>>();
    for (const r of rows) {
      if (r.kind === "regex") continue;
      const ts = uniqTokens(r.term, vocab);
      if (ts.length !== 1) continue;
      fam.set(ts[0], new Set([...(fam.get(ts[0]) ?? []), family(r.code)]));
    }
    expect(fam.size).toBeGreaterThan(0);
    for (const [t, s] of fam) expect([...s], t).toHaveLength(1);
  });
});
