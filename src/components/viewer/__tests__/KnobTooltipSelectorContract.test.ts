// @vitest-environment node
/**
 * The perf spec drives the bucket knobs BY THEIR TOOLTIP PREFIXES. This test is that contract.
 *
 * ── THE COUPLING, AND WHY IT NEEDS A GUARD HERE ─────────────────────────────────────────
 * `e2e/viewer-perf-v2.spec.ts` selects the Resolution and Dilation sliders with CSS *prefix*
 * matchers — `[title^="Max pixel dimension"]`, `[title^="Gap-closing radius"]` — because the
 * sliders carry no test ids. PLAN §3.5 flags this as one of three ways this migration can turn the
 * timing suite red for a reason that has nothing to do with speed.
 *
 * The spec imports NOTHING from the app (one harness checkout runs against two app SHAs), and it
 * needs a browser this container does not have. So a tooltip edit can silently break it, the
 * breakage lands in a perf run days later, and it reads as a performance regression.
 *
 * ★ THIS TEST READS BOTH FILES AND CHECKS THEM AGAINST EACH OTHER. It converts a cross-repo
 * coupling that nothing could observe into an ordinary failing unit test, in the same commit that
 * touches the tooltips — which is precisely what PLAN asks for, achieved without editing a spec I
 * cannot run.
 *
 * ── WHY THE PHASE-3 CHANGE DID NOT MOVE THE SELECTORS ───────────────────────────────────
 * The knob honesty note is APPENDED to each tooltip, never prefixed. PLAN assumed any tooltip
 * change would force the selectors to move; that is only true of a change to the START of the
 * string. Appending keeps the contract intact, so the spec needed no edit at all.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SPEC = readFileSync(join(ROOT, "e2e/viewer-perf-v2.spec.ts"), "utf8");
const AREA_TAB = readFileSync(
  join(ROOT, "src/components/viewer/AreaTab.tsx"),
  "utf8",
);

/** Every `[title^="…"]` prefix the perf spec selects on. */
function specTitlePrefixes(): string[] {
  return [...SPEC.matchAll(/\[title\^="([^"]+)"\]/g)].map((m) => m[1]);
}

/** Every `title="…"` string rendered by AreaTab. */
function areaTabTitles(): string[] {
  return [...AREA_TAB.matchAll(/title="([^"]+)"/g)].map((m) => m[1]);
}

describe("★ the perf spec's tooltip-prefix selectors still resolve", () => {
  it("finds prefix selectors in the spec at all — the test must not pass vacuously", () => {
    // If the spec is refactored to use test ids, this fails and the guard should be RETIRED
    // deliberately rather than left silently matching nothing.
    expect(specTitlePrefixes().length).toBeGreaterThan(0);
  });

  it("every prefix the spec selects on is the START of a real AreaTab tooltip", () => {
    const titles = areaTabTitles();
    expect(titles.length).toBeGreaterThan(0);
    for (const prefix of specTitlePrefixes()) {
      const matches = titles.filter((t) => t.startsWith(prefix));
      expect(
        matches.length,
        `perf spec selects [title^="${prefix}"] but no AreaTab tooltip starts with it — ` +
          `the timing suite would fail as a phantom performance regression`,
      ).toBeGreaterThan(0);
    }
  });

  it("each prefix is UNAMBIGUOUS — exactly one tooltip starts with it", () => {
    // A second tooltip sharing a prefix would make the spec's locator resolve to two elements and
    // Playwright would fail on strict mode. Cheap to check, impossible to notice by reading.
    const titles = areaTabTitles();
    for (const prefix of specTitlePrefixes()) {
      const matches = titles.filter((t) => t.startsWith(prefix));
      expect(matches.length, `ambiguous prefix "${prefix}"`).toBe(1);
    }
  });
});

describe("the knob honesty note is APPENDED, which is what preserves the contract", () => {
  const NOTE = "Raster only — has no effect on pages measured from vector linework.";

  it("all three raster knobs carry it", () => {
    const carrying = areaTabTitles().filter((t) => t.includes(NOTE));
    expect(carrying).toHaveLength(3);
  });

  it("★ none of them STARTS with it — prefixing is what would break the spec", () => {
    for (const title of areaTabTitles()) {
      expect(title.startsWith(NOTE)).toBe(false);
    }
  });

  it("the note sits at the END of each tooltip it appears in", () => {
    for (const title of areaTabTitles().filter((t) => t.includes(NOTE))) {
      expect(title.endsWith(NOTE)).toBe(true);
    }
  });
});
