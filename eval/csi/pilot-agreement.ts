/**
 * pilot-agreement.ts — merges the two independent pilot labeling passes and
 * measures how much they agree (PLAN §3 P1, LABELING_PROTOCOL §9.1).
 *
 * WHY TWO PASSES. One pass produces labels but says nothing about which pages
 * are hard. The pilot's job is calibration, and the number the owner actually
 * needs — to size the review budget in protocol §9.2.1 — is the disagreement
 * rate. Two independent labelers under identical instructions give that
 * directly, and they name the specific pages where human attention buys the most.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not merge the two passes into one
 * "consensus" gold label. Two uncertified opinions averaged together are still
 * uncertified, and collapsing them would destroy the disagreement signal that is
 * the entire point. Both passes stay visible; a human adjudicates.
 *
 * Every page comes out with `reviewed_by: null`. Per protocol §9.2.1 that means
 * these labels MAY NOT produce an acceptance number until a human has reviewed
 * them. Neither the labelers nor this script is that human.
 *
 * Build + run (from blueprintparser_2/):
 *   npx esbuild eval/csi/pilot-agreement.ts --bundle --platform=node \
 *     --target=node20 --outfile=build/csi-pilot.js
 *   node build/csi-pilot.js <pilot-dir> eval/csi/gold-pilot.json
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

interface Group {
  id: string;
  tier: "primary" | "secondary" | "tertiary";
  division: string;
  codes: string[];
  evidence?: string;
  note?: string;
}

interface PageLabel {
  bundle: string;
  page: number;
  drawingNumber: string | null;
  sheetSubject?: string;
  expected_groups: Group[];
  confidence: "high" | "medium" | "low";
  note?: string;
}

/** Canonical comparison key: digits only, first 4 = SECTION (protocol §5.1/§5.2). */
const section = (code: string) => code.replace(/[\s.\-]/g, "").slice(0, 4);

const sectionsOf = (groups: Group[]) => new Set(groups.flatMap(g => g.codes.map(section)));

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1; // both said "nothing here" — agreement
  const inter = [...a].filter(x => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 1 : inter / union;
}

/**
 * Containment: how much of the SMALLER set is inside the larger.
 *
 * Jaccard alone conflates two very different situations. If one labeler finds 8
 * sections and the other finds 3 that are all among the 8, Jaccard is 0.375 —
 * the same score as two labelers who found 8 and 3 with only one in common. The
 * first is a thoroughness gap (one went deeper); the second is real
 * disagreement. High containment with low Jaccard means the passes differ in
 * DEPTH, which a reviewer resolves cheaply. Low containment means they differ in
 * SUBSTANCE, which is what actually needs adjudicating.
 */
function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return a.size === b.size ? 1 : 0;
  const inter = [...a].filter(x => b.has(x)).length;
  return inter / Math.min(a.size, b.size);
}

function loadPass(dir: string, pass: "A" | "B"): Map<string, PageLabel> {
  const out = new Map<string, PageLabel>();
  for (let i = 1; i <= 4; i++) {
    const f = join(dir, `labels_pass${pass}_batch${i}.json`);
    if (!existsSync(f)) {
      console.error(`[pilot] MISSING ${f} — that batch's pages will be reported as unlabeled`);
      continue;
    }
    const arr = JSON.parse(readFileSync(f, "utf-8")) as PageLabel[];
    for (const p of arr) out.set(`${p.bundle}:${p.page}`, p);
  }
  return out;
}

function main(): void {
  const [dir, outPath] = process.argv.slice(2);
  if (!dir || !outPath) {
    console.error("usage: node csi-pilot.js <pilot-dir> <out.json>");
    process.exit(1);
  }

  const frame = JSON.parse(readFileSync(join(process.cwd(), "eval/csi/gold-frame.json"), "utf-8")) as {
    pilot: { bundle: string; page: number; stratum: string; drawingNumber: string | null }[];
  };

  const A = loadPass(dir, "A");
  const B = loadPass(dir, "B");

  const rows = frame.pilot
    .map(p => {
      const k = `${p.bundle}:${p.page}`;
      const a = A.get(k);
      const b = B.get(k);
      const sa = a ? sectionsOf(a.expected_groups) : new Set<string>();
      const sb = b ? sectionsOf(b.expected_groups) : new Set<string>();
      const j = a && b ? jaccard(sa, sb) : null;

      // Divisions are the coarser question: did the two labelers even agree on
      // which trades are on this sheet? A page can disagree at section level
      // while agreeing on divisions, which is a much milder problem.
      const da = new Set([...sa].map(s => s.slice(0, 2)));
      const db = new Set([...sb].map(s => s.slice(0, 2)));

      return {
        bundle: p.bundle,
        page: p.page,
        drawingNumber: p.drawingNumber,
        stratum: p.stratum,
        passA: a ? { groups: a.expected_groups, confidence: a.confidence, sheetSubject: a.sheetSubject ?? null, note: a.note ?? null } : null,
        passB: b ? { groups: b.expected_groups, confidence: b.confidence, sheetSubject: b.sheetSubject ?? null, note: b.note ?? null } : null,
        agreement: {
          sectionJaccard: j === null ? null : +j.toFixed(3),
          sectionContainment: a && b ? +containment(sa, sb).toFixed(3) : null,
          divisionJaccard: a && b ? +jaccard(da, db).toFixed(3) : null,
          groupCountA: a ? a.expected_groups.length : null,
          groupCountB: b ? b.expected_groups.length : null,
          sharedSections: [...sa].filter(x => sb.has(x)).sort(),
          onlyA: [...sa].filter(x => !sb.has(x)).sort(),
          onlyB: [...sb].filter(x => !sa.has(x)).sort(),
        },
        /** §9.2.1: null means UNCERTIFIED. No acceptance number may use this page. */
        reviewed_by: null,
      };
    })
    .sort((x, y) => x.bundle.localeCompare(y.bundle) || x.page - y.page);

  const scored = rows.filter(r => r.agreement.sectionJaccard !== null);
  const js = scored.map(r => r.agreement.sectionJaccard!);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  // Does the labeler's own stated confidence predict disagreement? Protocol
  // §9.2.2 asserts it does not, and adds a random audit slice on that basis.
  // Measure it rather than assume it.
  const lowConf = scored.filter(r => r.passA?.confidence === "low" || r.passB?.confidence === "low");
  const highConf = scored.filter(r => r.passA?.confidence === "high" && r.passB?.confidence === "high");

  const manifest = {
    schemaVersion: "csi-gold-pilot/1",
    what: "20-page calibration pilot: two INDEPENDENT blind labeling passes, with agreement measured.",
    protocol: "eval/csi/LABELING_PROTOCOL.md",
    rubric: "eval/csi/GRANULARITY_RUBRIC.md",
    generatedAt: new Date().toISOString(),
    generatedAtGitSha: (() => {
      try {
        return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
      } catch {
        return "unknown";
      }
    })(),
    certification: {
      reviewed: false,
      statement:
        "Every page here is reviewed_by: null. Both passes were produced by LLM labelers; " +
        "protocol §9 requires that an LLM proposes and a HUMAN disposes, and neither pass " +
        "nor this analysis is that human. These labels may NOT produce an acceptance number " +
        "until reviewed. They exist to calibrate the protocol and to size the review budget.",
    },
    method: {
      passes: 2,
      independence: "8 separate labelers, 4 per pass, identical instructions, different page batching; no pass saw the other",
      blinding: "labelers saw only page rawText — no engine output of any kind",
      scope: "positive expected_groups only; should_not_codes and acceptable_divisions are a later step",
      agreementMetric: "Jaccard over the set of SECTIONs (first 4 digits) covered by each pass's groups",
    },
    summary: {
      pilotPages: rows.length,
      pagesLabeledBoth: scored.length,
      pagesMissingAPass: rows.length - scored.length,
      meanSectionJaccard: +mean(js).toFixed(3),
      medianSectionJaccard: +[...js].sort((a, b) => a - b)[Math.floor(js.length / 2)]?.toFixed(3),
      meanSectionContainment: +mean(scored.map(r => r.agreement.sectionContainment!)).toFixed(3),
      meanDivisionJaccard: +mean(scored.map(r => r.agreement.divisionJaccard!)).toFixed(3),
      /** Low Jaccard but high containment = the passes differ in DEPTH, not substance. */
      depthNotSubstance: scored.filter(
        r => r.agreement.sectionJaccard! < 0.5 && r.agreement.sectionContainment! >= 0.7,
      ).length,
      strongAgreement_ge_0_6: scored.filter(r => r.agreement.sectionJaccard! >= 0.6).length,
      weakAgreement_lt_0_4: scored.filter(r => r.agreement.sectionJaccard! < 0.4).length,
      meanGroupsA: +mean(scored.map(r => r.agreement.groupCountA!)).toFixed(2),
      meanGroupsB: +mean(scored.map(r => r.agreement.groupCountB!)).toFixed(2),
      confidencePredictsDisagreement: {
        lowConfidencePages: lowConf.length,
        meanJaccardWhenLowConfidence: lowConf.length ? +mean(lowConf.map(r => r.agreement.sectionJaccard!)).toFixed(3) : null,
        bothHighConfidencePages: highConf.length,
        meanJaccardWhenBothHighConfidence: highConf.length ? +mean(highConf.map(r => r.agreement.sectionJaccard!)).toFixed(3) : null,
        note: "If these two means are close, stated confidence does NOT predict difficulty and protocol §9.2.2's random audit slice is justified.",
      },
    },
    /** Ranked worst-first: where a human reviewer's time buys the most. */
    reviewPriority: [...scored]
      .sort((a, b) => a.agreement.sectionJaccard! - b.agreement.sectionJaccard!)
      .slice(0, 10)
      .map(r => ({
        bundle: r.bundle,
        page: r.page,
        drawingNumber: r.drawingNumber,
        sectionJaccard: r.agreement.sectionJaccard,
        sectionContainment: r.agreement.sectionContainment,
        subjectA: r.passA?.sheetSubject ?? null,
        subjectB: r.passB?.sheetSubject ?? null,
      })),
    pages: rows,
  };

  writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");
  const s = manifest.summary;
  console.error(
    `[pilot] ${s.pagesLabeledBoth}/${s.pilotPages} pages labeled by both passes · ` +
      `mean section Jaccard ${s.meanSectionJaccard} (containment ${s.meanSectionContainment}) · division ${s.meanDivisionJaccard} · ` +
      `weak(<0.4) ${s.weakAgreement_lt_0_4} · groups ${s.meanGroupsA} vs ${s.meanGroupsB} → ${outPath}`,
  );
}

main();
