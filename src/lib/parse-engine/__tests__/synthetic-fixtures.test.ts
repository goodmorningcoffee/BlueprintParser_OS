// [table-pipeline WP-2.0a] The synthetic fixture generator (scripts/parse-engine-fixtures/synthesize.ts):
// committed fixtures are exactly what the layouts render to, and the pseudonymizer keeps geometry and
// character classes while replacing every non-vocabulary word (PLAN §1.6 rule 12).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LAYOUTS } from "../../../../scripts/parse-engine-fixtures/layouts";
import {
  VOCAB,
  pseudoText,
  pseudoToken,
  pseudonymizeFixture,
  renderLayout,
  renderRaw,
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

  it("--from: pseudonymizing a real-shaped slice marks it synthetic and replaces its text", () => {
    const raw = renderRaw(LAYOUTS[0]);
    expect(raw.synthetic).toBe(false);
    const out = pseudonymizeFixture(raw);
    expect(out.synthetic).toBe(true);
    expect(out.page.words.some((w, i) => w.text !== raw.page.words[i].text)).toBe(true);
  });
});
