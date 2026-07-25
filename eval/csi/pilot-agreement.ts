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

/**
 * Match groups ACROSS passes, then diff. Section-set Jaccard alone was wrong and
 * a usability review caught it: when both labelers identify the same system but
 * list different alternative codes for it — "topping trench" as 03 30 00/03 01 00
 * vs 03 81 00/02 41 19 — every one of those sections reads as a disagreement.
 * Roughly HALF the disputes it produced were this: the same group twice, wearing
 * different codes. Two labelers agreeing on the work and differing on which
 * MasterFormat entry names it is a far milder thing than one of them missing the
 * work entirely, and the two must not be counted alike.
 *
 * Match rule: groups pair if they share any code SECTION, else if their ids are
 * token-similar. Greedy, highest overlap first — good enough at 5-8 groups/page,
 * and deterministic because ties break on the sorted id.
 */
export interface GroupMatch {
  a: Group | null;
  b: Group | null;
  /** both found it — but check codesDiffer/tiersDiffer for the residual question */
  matched: boolean;
  codesDiffer: boolean;
  tiersDiffer: boolean;
}

const idTokens = (id: string) => new Set(id.toLowerCase().split(/[_\s-]+/).filter(t => t.length > 2));

function idSimilar(x: string, y: string): boolean {
  const a = idTokens(x);
  const b = idTokens(y);
  if (!a.size || !b.size) return false;
  const shared = [...a].filter(t => b.has(t)).length;
  return shared / Math.min(a.size, b.size) >= 0.5;
}

export function matchGroups(ga: Group[], gb: Group[]): GroupMatch[] {
  const secs = (g: Group) => new Set(g.codes.map(section));
  const pairs: { i: number; j: number; overlap: number }[] = [];
  for (let i = 0; i < ga.length; i++) {
    for (let j = 0; j < gb.length; j++) {
      const sa = secs(ga[i]);
      const sb = secs(gb[j]);
      const overlap = [...sa].filter(x => sb.has(x)).length;
      if (overlap > 0) pairs.push({ i, j, overlap: overlap + 1 });
      else if (idSimilar(ga[i].id, gb[j].id)) pairs.push({ i, j, overlap: 1 });
    }
  }
  pairs.sort((p, q) => q.overlap - p.overlap || ga[p.i].id.localeCompare(ga[q.i].id) || gb[p.j].id.localeCompare(gb[q.j].id));

  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const out: GroupMatch[] = [];
  for (const { i, j } of pairs) {
    if (usedA.has(i) || usedB.has(j)) continue;
    usedA.add(i);
    usedB.add(j);
    const A = ga[i];
    const B = gb[j];
    const ca = [...new Set(A.codes.map(c => c.replace(/[\s.\-]/g, "")))].sort().join(",");
    const cb = [...new Set(B.codes.map(c => c.replace(/[\s.\-]/g, "")))].sort().join(",");
    out.push({ a: A, b: B, matched: true, codesDiffer: ca !== cb, tiersDiffer: A.tier !== B.tier });
  }
  for (let i = 0; i < ga.length; i++) if (!usedA.has(i)) out.push({ a: ga[i], b: null, matched: false, codesDiffer: false, tiersDiffer: false });
  for (let j = 0; j < gb.length; j++) if (!usedB.has(j)) out.push({ a: null, b: gb[j], matched: false, codesDiffer: false, tiersDiffer: false });
  return out;
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

/** Negative labels for one page, as produced by the S3 labelers. */
interface Negatives {
  bundle: string;
  page: number;
  acceptable_divisions: string[];
  should_not_divisions: string[];
  should_not_codes: { code: string; why: string }[];
  confidence?: string;
  note?: string;
}

function loadNegatives(dir: string): Map<string, Negatives & { source: string }> {
  const out = new Map<string, Negatives & { source: string }>();
  for (let i = 1; i <= 4; i++) {
    const f = join(dir, `negatives_batch${i}.json`);
    if (!existsSync(f)) {
      console.error(`[pilot] no ${f} — those pages get no negative labels`);
      continue;
    }
    const parsed = JSON.parse(readFileSync(f, "utf-8")) as { pages: Negatives[] };
    for (const n of parsed.pages) out.set(`${n.bundle}:${n.page}`, { ...n, source: `llm:negatives_batch${i}` });
  }
  return out;
}

function main(): void {
  const [dir, outPath, negativesDir] = process.argv.slice(2);
  if (!dir || !outPath) {
    console.error("usage: node csi-pilot.js <pilot-dir> <out.json> [negatives-dir]");
    process.exit(1);
  }

  const frame = JSON.parse(readFileSync(join(process.cwd(), "eval/csi/gold-frame.json"), "utf-8")) as {
    pilot: { bundle: string; page: number; stratum: string; drawingNumber: string | null }[];
  };

  const A = loadPass(dir, "A");
  const B = loadPass(dir, "B");
  const N = negativesDir ? loadNegatives(negativesDir) : new Map<string, Negatives & { source: string }>();
  const floorRepairs: { page: string; added: string[] }[] = [];

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
        groupMatches: a && b ? matchGroups(a.expected_groups, b.expected_groups) : null,
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
        ...(() => {
          const n = N.get(k);
          if (!n) return {};
          // The floor is MECHANICAL and is never left to the labeler: every
          // division appearing in any positive group's codes must be acceptable,
          // or the tagger is scored as making a cross-division error on a code
          // this gold set itself calls correct (GRANULARITY_RUBRIC §1.1). Union
          // it in and RECORD that we did, so a labeler's omission is visible
          // rather than silently patched.
          const floor = new Set(
            [...(a?.expected_groups ?? []), ...(b?.expected_groups ?? [])]
              .flatMap(g => g.codes)
              .map(c => c.replace(/[^0-9]/g, "").slice(0, 2)),
          );
          const stated = new Set(n.acceptable_divisions.map(d => d.replace(/[^0-9]/g, "").padStart(2, "0")));
          const added = [...floor].filter(d => !stated.has(d)).sort();
          if (added.length) floorRepairs.push({ page: k, added });
          return {
            acceptable_divisions: [...new Set([...stated, ...floor])].sort(),
            should_not_divisions: [...new Set(n.should_not_divisions.map(d => d.replace(/[^0-9]/g, "").padStart(2, "0")))].sort(),
            should_not_codes: n.should_not_codes.map(c => c.code),
            negativesProvenance: {
              source: n.source,
              confidence: n.confidence ?? null,
              note: n.note ?? null,
              reasons: n.should_not_codes,
              floorDivisionsAddedMechanically: added,
            },
          };
        })(),
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
      // GROUP-level agreement — the honest headline. Section-level counts a
      // shared system named by different codes as a disagreement; this does not.
      groupLevel: (() => {
        let matched = 0, onlyOne = 0, codeOnly = 0, tierOnly = 0;
        for (const r of scored) {
          for (const m of r.groupMatches ?? []) {
            if (m.matched) { matched++; if (m.codesDiffer) codeOnly++; if (m.tiersDiffer) tierOnly++; }
            else onlyOne++;
          }
        }
        return {
          groupsBothFound: matched,
          groupsOnlyOnePassFound: onlyOne,
          agreementRate: +(matched / (matched + onlyOne)).toFixed(3),
          ofMatched_codesDiffer: codeOnly,
          ofMatched_tiersDiffer: tierOnly,
          note: "A matched pair with codesDiffer/tiersDiffer is a MILD question (which code, which tier), not a missed system. Section-level Jaccard conflates the two and therefore understates agreement.",
        };
      })(),
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
    negatives: {
      pagesWithNegatives: N.size,
      /**
       * Audit findings on the negative pass, recorded rather than silently
       * cleaned. A gold set that hides its own known weak spots is worse than
       * one that names them.
       */
      auditFlags: [
        {
          page: "fb9ce1b6-62d0-45d1-aba0-3df20225c0c3.json:67",
          issue:
            "The recorded reason quotes 'NON-STRUCTURAL TOPPING' as the trigger; that phrase occurs ZERO times " +
            "in the page rawText (verified). The verdict may still be right — the only FRAMING hit is a " +
            "verification note, not scope — but the quoted mechanism was smoothed rather than transcribed. " +
            "Treat this page's negatives as needing human ratification before use.",
        },
      ],
      /** Divisions a labeler omitted from acceptable_divisions that the gold's own
       *  positive codes required. Repaired mechanically; listed so the omission is
       *  auditable rather than invisible. */
      floorRepairs,
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
