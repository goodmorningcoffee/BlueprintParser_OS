/**
 * csi-adjudication-packet.test.ts — guards on the human-facing review document.
 *
 * [csi-rebuild S1b] `PILOT_ADJUDICATION_PACKET.md` is what the owner actually
 * works through to certify the pilot. Two things about it can fail silently, and
 * both would corrupt the gold set rather than merely annoy someone:
 *
 *  1. **A dispute renders without a decision line.** The owner works the file top
 *     to bottom, sees no prompt, and that disagreement is silently resolved in
 *     favor of whichever labeler happened to be rendered — shrinking the gold set
 *     without anyone deciding to.
 *
 *  2. **Engine output leaks into the packet.** The old engine emits ~42 codes per
 *     page. Showing that to a reviewer deciding "is this group real?" anchors them
 *     toward whatever it found, which inverts the whole point: the gold set judges
 *     the engine, not the reverse. Engine output has one legitimate use — proposing
 *     NEGATIVES — and that is a separate, later pass.
 *
 * Neither failure produces a visible error. Hence tests.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PACKET = join(process.cwd(), "eval/csi/PILOT_ADJUDICATION_PACKET.md");
const PILOT = join(process.cwd(), "eval/csi/gold-pilot.json");

interface Pilot {
  pages: {
    bundle: string;
    page: number;
    agreement: { sectionJaccard: number | null; onlyA: string[]; onlyB: string[] };
    groupMatches: { matched: boolean; codesDiffer: boolean; tiersDiffer: boolean }[] | null;
  }[];
}

const packet = () => readFileSync(PACKET, "utf-8");
const pilot = () => JSON.parse(readFileSync(PILOT, "utf-8")) as Pilot;

describe("pilot adjudication packet", () => {
  it("exists and is generated, not hand-written", () => {
    expect(existsSync(PACKET), `missing ${PACKET} — regenerate with eval/csi/adjudication-packet.ts`).toBe(true);
    expect(packet().length).toBeGreaterThan(10_000);
  });

  it("every open question gets a decision line — none renders silently", () => {
    const p = pilot();
    const scored = p.pages.filter(x => x.agreement.sectionJaccard !== null);

    // The unit is a GROUP MATCH, not a section. Sections were the original
    // defect: one shared system named by two different codes read as several
    // separate disagreements, inflating the count by ~3x and burying the
    // decisions that actually mattered.
    const open = scored.reduce(
      (n, x) => n + (x.groupMatches ?? []).filter(m => !m.matched || m.codesDiffer || m.tiersDiffer).length,
      0,
    );

    const decideLines = (packet().match(/^\s*- DECIDE:/gm) ?? []).length;
    expect(
      decideLines,
      `${open} open questions but ${decideLines} decision lines — something renders with no prompt`,
    ).toBe(open);
  });

  it("leads with the groups a labeler MISSED, not with vocabulary disputes", () => {
    // Ordering by section-agreement put S-200.00 first as the "worst" page when
    // both labelers had found all five of its systems and merely named them
    // differently. Missed work must outrank naming disputes.
    const p = pilot();
    const missedOf = (x: Pilot["pages"][number]) => (x.groupMatches ?? []).filter(m => !m.matched).length;
    const worst = Math.max(...p.pages.map(missedOf));
    expect(worst).toBeGreaterThan(0);

    const firstHeading = /^## 1\. (.+?) — page (\d+)/m.exec(packet());
    expect(firstHeading, "packet has no numbered first page").not.toBeNull();
    const firstPageNum = Number(firstHeading![2]);
    const first = p.pages.find(x => x.page === firstPageNum && missedOf(x) === worst);
    expect(first, `page ${firstPageNum} leads the packet but is not among the most-missed`).toBeDefined();
  });

  it("prints the labeling rules — a reviewer cannot apply rules they cannot see", () => {
    // Three test reviewers all fell back on personal judgment because the rubric
    // was referenced but not included. That produces decisions which cannot be
    // audited against the rules they were meant to apply.
    const text = packet();
    for (const marker of ["Trade test", "Title-block content is NEVER a group", "primary", "secondary", "tertiary"]) {
      expect(text.includes(marker), `packet omits rule/definition: ${marker}`).toBe(true);
    }
  });

  it("does not truncate labeler notes mid-sentence", () => {
    // The clipped clause was repeatedly the reviewer-addressed question itself
    // ("flagging for reviewer whether 22 40 00…"), so truncation removed exactly
    // the part written FOR the reviewer.
    //
    // Scope this to note blocks only. The raw OCR in the appendix legitimately
    // contains "..." and an unscoped check fails on the corpus rather than on
    // anything this file controls.
    const notes = (packet().match(/^> \*\*[AB]:\*\* .*$/gm) ?? []);
    expect(notes.length, "no labeler notes rendered at all").toBeGreaterThan(0);
    const clipped = notes.filter(n => /\.\.\.$|…$/.test(n.trim()));
    expect(clipped, "labeler notes truncated — the clipped clause is usually the question for the reviewer").toEqual([]);
  });

  it("does NOT show the reviewer any engine output (anti-anchoring)", () => {
    const text = packet();
    for (const marker of ["baseline-old-engine", "oldEngineCodeCount", "priorCodes", "resultSha"]) {
      expect(text.includes(marker), `packet leaks engine output via "${marker}" — this anchors the reviewer`).toBe(
        false,
      );
    }
  });

  it("the full sheet text is included for every pilot page", () => {
    // Without the text the reviewer is asked "is this real?" holding only a
    // truncated quote, which cannot catch a labeler that invented something.
    const anchors = (packet().match(/^<a id="page-/gm) ?? []).length;
    expect(anchors).toBe(pilot().pages.length);
  });

  it("asks for the one measurement the review budget depends on", () => {
    // Q5's cost estimate is currently a guess. The packet must collect the real
    // rate, or the 240-page decision stays guesswork.
    expect(packet()).toMatch(/MINUTES SPENT:/);
  });
});
