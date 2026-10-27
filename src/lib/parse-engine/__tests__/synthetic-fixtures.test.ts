// [table-pipeline WP-2.0a] The synthetic fixture generator (scripts/parse-engine-fixtures/synthesize.ts):
// committed fixtures are exactly what the layouts render to, and the pseudonymizer keeps geometry and
// character classes while replacing every non-vocabulary word (PLAN §1.6 rule 12).
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LAYOUTS } from "../../../../scripts/parse-engine-fixtures/layouts";
import {
  VOCAB,
  maskPrivateSlice,
  pseudoText,
  pseudoToken,
  pseudonymizeFixture,
  renderLayout,
  renderRaw,
  refuseMaskedOut,
  stableJson,
} from "../../../../scripts/parse-engine-fixtures/synthesize";

const FIXTURE_DIR = join(__dirname, "../__fixtures__");
const charClass = (s: string): string => s.replace(/[A-Z]/g, "A").replace(/[a-z]/g, "a").replace(/[0-9]/g, "9");

describe("synthetic parse fixtures", () => {
  it("every layout renders byte-equal to its committed fixture, and no fixture lacks a layout", () => {
    const files = readdirSync(FIXTURE_DIR).filter((f) => /^syn-.*\.synthetic\.json$/.test(f)).sort();
    const ids = LAYOUTS.map((L) => `${L.id}.synthetic.json`).sort();
    expect(files).toEqual(ids);
    const drift = LAYOUTS.filter((L) => readFileSync(join(FIXTURE_DIR, `${L.id}.synthetic.json`), "utf8") !== stableJson(renderLayout(L)))
      .map((L) => L.id);
    expect(drift, "regenerate: npx tsx scripts/parse-engine-fixtures/synthesize.ts --layouts").toEqual([]);
  });

  it("every *.synthetic.json here is a layout fixture or the goldens file (no other name escapes the content check)", () => {
    const other = readdirSync(FIXTURE_DIR, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".json") && !/^syn-[a-z0-9-]+\.synthetic\.json$/.test(f) && f !== "legacy-goldens.synthetic.json");
    expect(other).toEqual([]);
  });

  it("is deterministic", () => {
    for (const L of LAYOUTS.slice(0, 6)) expect(stableJson(renderLayout(L))).toBe(stableJson(renderLayout(L)));
  });

  it("keeps geometry, word count and character classes; changes every non-vocabulary word", () => {
    for (const L of LAYOUTS) {
      const raw = renderRaw(L);
      const syn = renderLayout(L);
      expect(syn.page.words.map((w) => w.bbox), L.id).toEqual(raw.page.words.map((w) => w.bbox));
      expect(syn.page.lines.map((l) => l.bbox), L.id).toEqual(raw.page.lines.map((l) => l.bbox));
      expect(syn.shapes.map((s) => s.bbox), L.id).toEqual(raw.shapes.map((s) => s.bbox));
      expect(syn.region).toEqual(raw.region);
      syn.page.words.forEach((w, i) => {
        const before = raw.page.words[i].text;
        expect(charClass(w.text).length).toBe(before.length);
        // letters stay letters of the same case, digits stay digits, punctuation stays put
        expect(charClass(w.text)).toBe(charClass(before));
        const core = before.replace(/[^A-Za-z]/g, "");
        if (core.length >= 2 && !VOCAB.has(before.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "").toUpperCase())) {
          expect(w.text, `${L.id}: "${before}" survived`).not.toBe(before);
        }
      });
      // a LINE's text is its words' texts
      for (const l of syn.page.lines) expect(l.text).toBe(l.words.map((w) => w.text).join(" "));
    }
  });

  it("no layout placeholder word survives into any committed fixture", () => {
    const placeholder = /\b(lorem|ipsum|dolor|amet|magna|tempor|labore|vitae|porta|nulla|felis|ornare|lacus|metus|augue|risus|massa|justo|velit|quam|urna|elit)\b/i;
    for (const f of readdirSync(FIXTURE_DIR).filter((n) => n.endsWith(".synthetic.json"))) {
      expect(placeholder.test(readFileSync(join(FIXTURE_DIR, f), "utf8")), f).toBe(false);
    }
  });

  it("tag-like tokens keep their pattern and digits; a tag family keeps one prefix", () => {
    const a = pseudoToken("EF-10");
    expect(a).toMatch(/^[A-Z]{2}-10$/);
    expect(a).not.toBe("EF-10");
    expect(pseudoToken("EF-1").slice(0, 3)).toBe(a.slice(0, 3));
    expect(pseudoToken("D101A")).toMatch(/^[A-Z]101[A-Z]$/);
  });

  it("keeps keys, numbers and vocabulary; is consistent per token", () => {
    for (const t of ["2.3", "1.", "1.01", "a.", "(b)", "A", "3'-0\"", "08", "1:50", "2.5", "NOTES", "Notes:", "SECTION", "-"]) {
      expect(pseudoToken(t), t).toBe(t);
    }
    expect(pseudoText("LOREM QUAM")).toBe(`${pseudoToken("LOREM")} ${pseudoToken("QUAM")}`);
    expect(pseudoToken("QUAM")).toBe(pseudoToken("QUAM"));
    expect(pseudoToken("Lorem")).toMatch(/^[A-Z][a-z]{4}$/);
  });

  it("--from: a masked real slice stays private (prv- id, not synthetic) and masks numbers with a per-run salt", () => {
    const raw = { ...renderRaw(LAYOUTS[0]), id: "syn-x" };
    expect(raw.synthetic).toBe(false);
    const a = maskPrivateSlice(raw, "salt-a");
    expect(a).toMatchObject({ id: "prv-x", synthetic: false, privateOnly: true });
    expect(a.page.words.some((w, i) => w.text !== raw.page.words[i].text)).toBe(true);
    expect(a.page.words.map((w) => w.bbox)).toEqual(raw.page.words.map((w) => w.bbox));
    // invented phone-number and date shapes: digits change, punctuation stays
    for (const t of ["555-010-0199", "01/02/2000", "1,250"]) {
      const m = pseudoText(t, { salt: "salt-a", maskNumbers: true });
      expect(m, t).not.toBe(t);
      expect(charClass(m)).toBe(charClass(t));
    }
    expect(pseudoText("2.3 1.", { salt: "salt-a", maskNumbers: true })).toBe("2.3 1."); // keys stay keys
    // the map depends on the salt, so the public script alone gives no dictionary
    const b = maskPrivateSlice(raw, "salt-b");
    expect(b.page.words.map((w) => w.text)).not.toEqual(a.page.words.map((w) => w.text));
    expect(maskPrivateSlice(raw).page.words.map((w) => w.text)).not.toEqual(maskPrivateSlice(raw).page.words.map((w) => w.text));
    // the layout fixtures keep the fixed salt and their numbers
    expect(pseudonymizeFixture(raw).synthetic).toBe(true);
    expect(pseudoText("1,250")).toBe("1,250");
  });

  it("--from refuses a *.synthetic.json name and any output inside a BP2 checkout", () => {
    const repo = join(__dirname, "../../../..");
    expect(refuseMaskedOut("/tmp/x.synthetic.json")).toMatch(/not synthetic/);
    expect(refuseMaskedOut(join(repo, "src/lib/parse-engine/__fixtures__/a.masked.json"))).toMatch(/inside/);
    expect(refuseMaskedOut(join(repo, "scripts/parse-engine-fixtures/new/dir/a.masked.json"))).toMatch(/inside/);
    const tmp = mkdtempSync(join(tmpdir(), "mask-out-"));
    try {
      const other = join(tmp, "other-checkout");
      mkdirSync(join(other, "scripts/parse-engine-fixtures"), { recursive: true });
      writeFileSync(join(other, "scripts/parse-engine-fixtures/synthesize.ts"), "");
      expect(refuseMaskedOut(join(other, "eval/a.masked.json"), repo)).toMatch(/BP2 checkout/);
      const older = join(tmp, "older-checkout"); // a BP2 worktree from before this script existed
      mkdirSync(join(older, "scripts"), { recursive: true });
      writeFileSync(join(older, "scripts/prepush-check.sh"), "");
      expect(refuseMaskedOut(join(older, "eval/a.masked.json"), repo)).toMatch(/BP2 checkout/);
      expect(refuseMaskedOut(join(tmp, "private/a.masked.json"), repo)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
