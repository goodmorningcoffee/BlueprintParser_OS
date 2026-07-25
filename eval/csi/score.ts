/**
 * score.ts — the CSI evaluation harness (PLAN §3 P1/P2, LABELING_PROTOCOL §5/§11).
 *
 * Scores an engine's emitted codes against a gold set. This is the instrument the
 * whole rebuild is judged by, so it is built to refuse to lie in three specific
 * ways that a naive scorer would.
 *
 * ── 1. IT WILL NOT EMIT AN ACCEPTANCE NUMBER FROM UNCERTIFIED GOLD ──
 *
 * Protocol §9 requires an LLM to propose labels and a HUMAN to dispose. Pages with
 * `reviewed_by: null` are uncertified and may not produce an acceptance figure.
 * The scorer still runs on them — you need numbers during development — but stamps
 * `acceptance: null` and `provisional: true`, and says why. There is no flag to
 * override this.
 *
 * ── 2. UNCERTIFIED GOLD PRODUCES A RANGE, NOT A POINT ──
 *
 * The pilot holds two independent opinions per page, and neither is authoritative.
 * Picking one would be arbitrary; averaging them would invent a consensus nobody
 * agreed to. So the scorer computes both plausible golds:
 *
 *   - STRICT gold   = only systems BOTH labelers found.
 *   - GENEROUS gold = every system EITHER labeler found.
 *
 * ⚠ These are a SENSITIVITY RANGE, not mathematical bounds. An earlier version of
 * this comment claimed strict gives an upper bound on recall, reasoning that a
 * smaller denominator lifts it. That is wrong, and the first run disproved it:
 * strict recall came in at 0.2253 against generous 0.2341. Adding a labeler's
 * unshared groups changes the numerator too, and whether recall rises or falls
 * depends on whether those extra groups happen to be ones the engine hit. Neither
 * variant bounds the other in either direction.
 *
 * What the interval DOES tell you is how sensitive the answer is to labeler
 * disagreement. Narrow ⇒ certification would barely move the number, so the
 * provisional figure is directionally trustworthy. Wide ⇒ the disagreement is
 * load-bearing and the number should not be quoted until adjudicated. Reporting a
 * single value would hide precisely that distinction.
 *
 * ── 3. IT REPORTS "NOT POWERED" RATHER THAN "PASSED" ──
 *
 * §11.2: a division with fewer than `minUnits` gold scoring units cannot detect a
 * 2-point regression — one flipped item moves it ~10 points. Such a division is
 * reported `powered: false` and is never counted as having passed a gate. A
 * division without the data to detect a regression has not passed a regression test.
 *
 * Build + run (from blueprintparser_2/):
 *   npx esbuild eval/csi/score.ts --bundle --platform=node --target=node20 \
 *     --outfile=build/csi-score.js
 *   node build/csi-score.js <gold.json> <engine.json> <out.json> [--specificity=section|exact] [--min-units=50]
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ═══════════════════════════════════════════════════════════════
// Code canonicalization (protocol §5.2)
// ═══════════════════════════════════════════════════════════════

/** Digits only. `"08 71 00"`, `"087100"` and `"08-71-00"` all collapse together. */
export const digits = (code: string) => code.replace(/[^0-9]/g, "");
/** SECTION key — first 4 digits, `NN NN`. Separates 08 71 from 08 41. */
export const section = (code: string) => digits(code).slice(0, 4);
/** EXACT key — every digit, so level-4 siblings stay distinct. */
export const exact = (code: string) => digits(code);
export const division = (code: string) => digits(code).slice(0, 2);

type Mode = "section" | "exact";
const keyFor = (mode: Mode) => (mode === "section" ? section : exact);

// ═══════════════════════════════════════════════════════════════
// Inputs
// ═══════════════════════════════════════════════════════════════

interface Group {
  id: string;
  tier: "primary" | "secondary" | "tertiary";
  division: string;
  codes: string[];
}

export interface GoldPage {
  bundle: string;
  page: number;
  /** Certified shape: one adjudicated list. */
  expected_groups?: Group[];
  /** Uncertified shape: two independent opinions. */
  passA?: { groups: Group[] } | null;
  passB?: { groups: Group[] } | null;
  should_not_codes?: string[];
  should_not_divisions?: string[];
  acceptable_divisions?: string[];
  reviewed_by: string | null;
  stratum?: string;
}

interface EnginePage {
  bundle: string;
  page: number;
  codes: string[];
}

/** Per-page result for one gold variant. */
interface PageScore {
  tp: string[];
  fpHard: string[];
  fpCrossDivision: string[];
  fpUnadjudicated: string[];
  groupsTotal: number;
  groupsHit: number;
  /** §4.2 — recall over `primary` groups alone is "the number that matters". */
  primaryTotal: number;
  primaryHit: number;
  weight: number;
  perDivision: Map<string, DivBucket>;
}

interface DivBucket {
  emitted: number;
  tp: number;
  groupsTotal: number;
  groupsHit: number;
  /** UNWEIGHTED gold-group count. Statistical power is about how many real
   *  observations exist, so it must never be a weighted population estimate and
   *  must never include engine emissions. See §11.2 and the note in
   *  perDivisionRollup. */
  rawGroups: number;
}

// ═══════════════════════════════════════════════════════════════
// Scoring
// ═══════════════════════════════════════════════════════════════

export function scorePage(gold: Group[], g: GoldPage, emitted: string[], mode: Mode, weight: number): PageScore {
  const key = keyFor(mode);

  // §5.1.1 — collapse emitted codes to distinct keys BEFORE precision, or
  // sibling-spraying (08 71 00 + 08 71 13 + 08 71 13.16) inflates one fact into
  // three true positives.
  const emittedKeys = [...new Set(emitted.map(key))];

  const goldKeys = new Set(gold.flatMap(x => x.codes.map(key)));
  const shouldNot = new Set((g.should_not_codes ?? []).map(key));
  const shouldNotDiv = new Set((g.should_not_divisions ?? []).map(division));
  const acceptable = g.acceptable_divisions?.length ? new Set(g.acceptable_divisions.map(division)) : null;

  const tp: string[] = [];
  const fpHard: string[] = [];
  const fpCrossDivision: string[] = [];
  const fpUnadjudicated: string[] = [];

  for (const k of emittedKeys) {
    const d = k.slice(0, 2);
    // Order matters and follows §5.0's table top-down: a code that both matches
    // a group AND appears in should_not is a gold contradiction, and the group
    // match wins — a labeler naming it correct is the stronger signal.
    if (goldKeys.has(k)) tp.push(k);
    else if (shouldNot.has(k) || shouldNotDiv.has(d)) fpHard.push(k);
    else if (acceptable && !acceptable.has(d)) fpCrossDivision.push(k);
    else fpUnadjudicated.push(k);
  }

  // Recall is over GROUPS: a group is hit if the engine emitted any of its codes.
  const emittedSet = new Set(emittedKeys);
  let groupsHit = 0;
  const perDivision = new Map<string, DivBucket>();
  const bucket = (d: string) => {
    let b = perDivision.get(d);
    if (!b) {
      b = { emitted: 0, tp: 0, groupsTotal: 0, groupsHit: 0, rawGroups: 0 };
      perDivision.set(d, b);
    }
    return b;
  };

  let primaryTotal = 0;
  let primaryHit = 0;
  for (const grp of gold) {
    const hit = grp.codes.some(c => emittedSet.has(key(c)));
    if (hit) groupsHit++;
    if (grp.tier === "primary") {
      primaryTotal++;
      if (hit) primaryHit++;
    }
    const b = bucket(grp.division);
    b.groupsTotal++;
    b.rawGroups++;
    if (hit) b.groupsHit++;
  }
  for (const k of emittedKeys) {
    const b = bucket(k.slice(0, 2));
    b.emitted++;
    if (tp.includes(k)) b.tp++;
  }

  return {
    tp, fpHard, fpCrossDivision, fpUnadjudicated,
    groupsTotal: gold.length, groupsHit,
    primaryTotal, primaryHit,
    weight, perDivision,
  };
}

export const fbeta = (p: number, r: number, beta: number) => {
  const b2 = beta * beta;
  return p + r === 0 ? 0 : ((1 + b2) * p * r) / (b2 * p + r);
};

interface Totals {
  tp: number;
  fpHard: number;
  fpCross: number;
  fpUnadj: number;
  groupsTotal: number;
  groupsHit: number;
  primaryTotal: number;
  primaryHit: number;
}

export function aggregate(
  scores: PageScore[],
): Totals & { precision: number | null; recall: number | null; primaryRecall: number | null; f05: number | null } {
  // §11.1 — weighted micro-average. Stratum weights come from gold-frame.json;
  // without them a non-proportional sample's raw mean is reported as if it were
  // the corpus figure.
  const t: Totals = {
    tp: 0, fpHard: 0, fpCross: 0, fpUnadj: 0,
    groupsTotal: 0, groupsHit: 0, primaryTotal: 0, primaryHit: 0,
  };
  for (const s of scores) {
    t.tp += s.tp.length * s.weight;
    t.fpHard += s.fpHard.length * s.weight;
    t.fpCross += s.fpCrossDivision.length * s.weight;
    t.fpUnadj += s.fpUnadjudicated.length * s.weight;
    t.groupsTotal += s.groupsTotal * s.weight;
    t.groupsHit += s.groupsHit * s.weight;
    t.primaryTotal += s.primaryTotal * s.weight;
    t.primaryHit += s.primaryHit * s.weight;
  }
  const emitted = t.tp + t.fpHard + t.fpCross + t.fpUnadj;
  // NULL, not 0, when there is no denominator. An engine that emitted nothing
  // has undefined precision, not zero precision; a division with no gold groups
  // has undefined recall. Reporting 0 presents "no evidence" as "measured zero",
  // which reads as a real result and is the more dangerous lie.
  const precision = emitted ? t.tp / emitted : null;
  const recall = t.groupsTotal ? t.groupsHit / t.groupsTotal : null;
  const primaryRecall = t.primaryTotal ? t.primaryHit / t.primaryTotal : null;
  const f05 = precision === null || recall === null ? null : fbeta(precision, recall, 0.5);
  return { ...t, precision, recall, primaryRecall, f05 };
}

export function perDivisionRollup(scores: PageScore[], minUnits: number) {
  const acc = new Map<string, { emitted: number; tp: number; groupsTotal: number; groupsHit: number; rawGroups: number }>();
  for (const s of scores) {
    for (const [d, b] of s.perDivision) {
      const a = acc.get(d) ?? { emitted: 0, tp: 0, groupsTotal: 0, groupsHit: 0, rawGroups: 0 };
      a.emitted += b.emitted * s.weight;
      a.tp += b.tp * s.weight;
      a.groupsTotal += b.groupsTotal * s.weight;
      a.groupsHit += b.groupsHit * s.weight;
      a.rawGroups += b.rawGroups; // UNWEIGHTED — see below
      acc.set(d, a);
    }
  }
  return [...acc.entries()]
    .sort((x, y) => x[0].localeCompare(y[0]))
    .map(([d, a]) => {
      const precision = a.emitted ? a.tp / a.emitted : null;
      const recall = a.groupsTotal ? a.groupsHit / a.groupsTotal : null;
      // §11.2 — power is GOLD evidence, UNWEIGHTED.
      //
      // The first version used `emitted + groupsTotal`, weighted. Both halves of
      // that were wrong and an audit caught it. Including `emitted` lets the
      // ENGINE manufacture its own statistical power: divisions 00, 01 and 40
      // came out `powered: true` on this corpus with ZERO gold groups, purely on
      // false-positive volume — and power would then differ between two engines
      // scored against identical gold, which is incoherent. Weighting is wrong
      // too: power depends on how many real observations exist, not on their
      // reweighted population estimate, so 5 groups at weight 12 must not read
      // as 60.
      const units = a.rawGroups;
      return {
        division: d,
        goldUnits: units,
        /** false ⇒ this division CANNOT be gated; never report it as passed. */
        powered: units >= minUnits,
        emitted: +a.emitted.toFixed(1),
        tp: +a.tp.toFixed(1),
        groupsTotal: +a.groupsTotal.toFixed(1),
        groupsHit: +a.groupsHit.toFixed(1),
        precision: precision === null ? null : +precision.toFixed(4),
        recall: recall === null ? null : +recall.toFixed(4),
        f05: precision === null || recall === null ? null : +fbeta(precision, recall, 0.5).toFixed(4),
      };
    });
}

// ═══════════════════════════════════════════════════════════════
// Certification
// ═══════════════════════════════════════════════════════════════

/**
 * Is this gold page genuinely human-certified?
 *
 * Certification must be EARNED, not merely un-negated. Testing `reviewed_by ===
 * null` alone is forgeable three ways — `""`, `0`, and a missing key all fail
 * that test — and an empty `pages` array trivially satisfies "no uncertified
 * pages". Any of those would let a one-character edit produce a real-looking
 * acceptance figure computed from unadjudicated LLM labels.
 *
 * So: a non-empty reviewer name AND an adjudicated `expected_groups`. A page
 * still carrying only the two raw labeler opinions has not been adjudicated,
 * whatever `reviewed_by` says.
 */
export function isCertifiedPage(p: GoldPage): boolean {
  return (
    typeof p.reviewed_by === "string" &&
    p.reviewed_by.trim().length > 0 &&
    Array.isArray(p.expected_groups) &&
    p.expected_groups.length > 0
  );
}

// ═══════════════════════════════════════════════════════════════
// Driver
// ═══════════════════════════════════════════════════════════════

function main(): void {
  const args = process.argv.slice(2);
  const positional = args.filter(a => !a.startsWith("--"));
  const flag = (name: string, dflt: string) =>
    (args.find(a => a.startsWith(`--${name}=`))?.split("=")[1] ?? dflt);

  const [goldPath, enginePath, outPath] = positional;
  if (!goldPath || !enginePath || !outPath) {
    console.error(
      "usage: node csi-score.js <gold.json> <engine.json> <out.json> [--specificity=section|exact] [--min-units=50]",
    );
    process.exit(1);
  }

  // Q7 lives here as a flag, deliberately: whichever way the owner answers,
  // switching is a one-word change and BOTH modes are always reported.
  const primaryMode = flag("specificity", "section") as Mode;
  if (primaryMode !== "section" && primaryMode !== "exact") {
    console.error(`--specificity must be section|exact, got ${primaryMode}`);
    process.exit(1);
  }
  // Q6 lives here as a flag for the same reason.
  const minUnits = Number(flag("min-units", "50"));

  const gold = JSON.parse(readFileSync(goldPath, "utf-8")) as { pages: GoldPage[] };
  const engine = JSON.parse(readFileSync(enginePath, "utf-8")) as { pages: EnginePage[] };
  const emittedBy = new Map(engine.pages.map(p => [`${p.bundle}:${p.page}`, p.codes]));

  // Stratum weights (§11.1). Resolved next to the GOLD file, not relative to cwd —
  // a cwd-relative lookup silently fails open when the tool is run from anywhere
  // else, and "no weights" quietly turns a population estimate into a sample
  // statistic while still printing a confident number.
  const framePath = resolve(flag("frame", join(dirname(resolve(goldPath)), "gold-frame.json")));
  let weightOf = (_stratum: string | undefined) => 1;
  let weightsApplied = false;
  let frameSha: string | null = null;
  const unknownStrata: string[] = [];
  if (existsSync(framePath)) {
    const raw = readFileSync(framePath, "utf-8");
    frameSha = createHash("sha256").update(raw).digest("hex").slice(0, 16);
    const frame = JSON.parse(raw) as { strata: { stratum: string; weight: number }[] };
    const map = new Map(frame.strata.map(s => [s.stratum, s.weight]));
    for (const [k, v] of map) {
      if (!(v > 0)) throw new Error(`stratum ${k} has non-positive weight ${v} — refusing to score`);
    }
    weightOf = (st?: string) => {
      if (!st) return 1;
      const w = map.get(st);
      // Fail LOUD: an unknown stratum silently weighted 1 skews every aggregate
      // in a direction nobody can see from the output.
      if (w === undefined) {
        if (!unknownStrata.includes(st)) unknownStrata.push(st);
        return 1;
      }
      return w;
    };
    weightsApplied = true;
  }

  // Certification must be EARNED, not merely un-negated. `reviewed_by === null`
  // alone is forgeable three ways: "" / 0 / a missing key all fail `=== null`,
  // and an empty pages array trivially satisfies "no uncertified pages". A
  // one-character edit would then produce a real-looking acceptance figure from
  // unadjudicated LLM labels. Require a non-empty reviewer string AND an
  // adjudicated `expected_groups` on every page, and require pages to exist.
  const uncertified = gold.pages.filter(p => !isCertifiedPage(p));
  const certified = gold.pages.length > 0 && uncertified.length === 0;

  /** Build the gold group list for a page under a given variant. */
  function goldFor(p: GoldPage, variant: "certified" | "strict" | "generous"): Group[] | null {
    if (p.expected_groups) return p.expected_groups;
    const a = p.passA?.groups ?? null;
    const b = p.passB?.groups ?? null;
    if (!a || !b) return null;
    if (variant === "generous") {
      // Union by section signature — every system either labeler saw.
      const seen = new Set<string>();
      const out: Group[] = [];
      for (const g of [...a, ...b]) {
        const sig = g.codes.map(section).sort().join("|");
        if (seen.has(sig)) continue;
        seen.add(sig);
        out.push(g);
      }
      return out;
    }
    // Strict: only systems BOTH labelers found (any shared section).
    const bSecs = b.map(g => new Set(g.codes.map(section)));
    return a.filter(g => {
      const s = new Set(g.codes.map(section));
      return bSecs.some(t => [...s].some(x => t.has(x)));
    });
  }

  const missingFromEngine: string[] = [];
  const unusableGold: string[] = [];

  function runVariant(variant: "certified" | "strict" | "generous", mode: Mode) {
    const scores: PageScore[] = [];
    for (const p of gold.pages) {
      const key = `${p.bundle}:${p.page}`;
      const g = goldFor(p, variant);
      if (!g) {
        if (!unusableGold.includes(key)) unusableGold.push(key);
        continue;
      }
      // A gold page the engine did not report is NOT a page that does not count.
      // Skipping it removes its groups from the recall denominator, so an engine
      // that fails on hard pages scores higher for failing. Score it as having
      // emitted nothing — every group missed — and name it in the output.
      const emitted = emittedBy.get(key);
      if (emitted === undefined && !missingFromEngine.includes(key)) missingFromEngine.push(key);
      scores.push(scorePage(g, p, emitted ?? [], mode, weightOf(p.stratum)));
    }
    const agg = aggregate(scores);
    const r4 = (x: number | null) => (x === null ? null : +x.toFixed(4));
    return {
      pagesScored: scores.length,
      precision: r4(agg.precision),
      recall: r4(agg.recall),
      /** §4.2 — recall over `primary` groups alone; the plan calls this the number that matters. */
      primaryRecall: r4(agg.primaryRecall),
      f05: r4(agg.f05),
      truePositives: +agg.tp.toFixed(1),
      falsePositives: {
        hard: +agg.fpHard.toFixed(1),
        crossDivision: +agg.fpCross.toFixed(1),
        /** §5.0 row 4 — where GOLD INCOMPLETENESS, not the tagger, may be at fault. */
        unadjudicated: +agg.fpUnadj.toFixed(1),
      },
      /**
       * What precision could be, given that `unadjudicated` codes are of unknown
       * correctness. The floor assumes every one of them is wrong (which is what
       * `precision` above reports); the ceiling assumes every one is right.
       *
       * This is the honest shape of precision under an incomplete gold set. With
       * no negative labels at all the ceiling is 1.0 and the bracket says
       * nothing; every should_not label narrows it. Watching this interval close
       * is how you tell whether more adjudication is still worth buying.
       */
      precisionBracket: (() => {
        const denom = agg.tp + agg.fpHard + agg.fpCross + agg.fpUnadj;
        if (!denom) return null;
        return {
          floor: +(agg.tp / denom).toFixed(4),
          ceiling: +((agg.tp + agg.fpUnadj) / denom).toFixed(4),
          unadjudicatedShare: +(agg.fpUnadj / denom).toFixed(4),
        };
      })(),
      groupsTotal: +agg.groupsTotal.toFixed(1),
      groupsHit: +agg.groupsHit.toFixed(1),
      perDivision: perDivisionRollup(scores, minUnits),
    };
  }

  const variants = certified ? (["certified"] as const) : (["strict", "generous"] as const);
  const results: Record<string, unknown> = {};
  for (const v of variants) {
    results[v] = { section: runVariant(v, "section"), exact: runVariant(v, "exact") };
  }

  const anyAcceptable = gold.pages.some(p => p.acceptable_divisions?.length);
  const anyShouldNot = gold.pages.some(p => p.should_not_codes?.length || p.should_not_divisions?.length);

  const out = {
    schemaVersion: "csi-score/1",
    generatedAt: new Date().toISOString(),
    gold: goldPath,
    engine: enginePath,
    config: { primarySpecificity: primaryMode, minUnitsToGate: minUnits, fBeta: 0.5 },

    certification: {
      certified,
      uncertifiedPages: uncertified.length,
      /** The acceptance figure. `null` unless every scored page is human-reviewed. */
      acceptance: certified
        ? (results.certified as Record<Mode, { f05: number | null }>)[primaryMode].f05
        : null,
      provisional: !certified,
      statement: certified
        ? "All scored pages are human-reviewed; this figure may be used for acceptance."
        : `${uncertified.length} of ${gold.pages.length} gold pages are reviewed_by:null. ` +
          "Protocol §9 forbids an acceptance number from uncertified labels, so `acceptance` is null. " +
          "The strict/generous pair below BRACKETS the certified number rather than guessing at it.",
    },

    caveats: [
      weightsApplied
        ? `Stratum weights applied from ${framePath} (sha ${frameSha}) per §11.1.`
        : `NO stratum weights found at ${framePath} — every page weighted 1. These are SAMPLE statistics, not corpus estimates.`,
      unknownStrata.length
        ? `UNKNOWN STRATA weighted 1 by fallback: ${unknownStrata.join(", ")}. Aggregates are skewed by an unmeasured amount.`
        : null,
      missingFromEngine.length
        ? `${missingFromEngine.length} gold page(s) absent from the engine output were scored as emitting NOTHING (all groups missed), not skipped: ${missingFromEngine.slice(0, 5).join(", ")}${missingFromEngine.length > 5 ? " …" : ""}`
        : null,
      anyAcceptable
        ? null
        : "Gold has no acceptable_divisions, so cross-division false positives CANNOT be separated; they fall into `unadjudicated`.",
      anyShouldNot ? null : "Gold has no should_not_codes, so no false positive can be classified as `hard` yet.",
      certified
        ? null
        : "Pooled adjudication (§5.0.1) has not run. Precision is provisional for BOTH engines and is not a fair OLD-vs-NEW comparison.",
      // The direction of the error matters and is easy to get backwards.
      "PRECISION AS REPORTED IS A FLOOR, NOT AN ESTIMATE. Every emitted code the gold " +
        "does not name counts as a false positive, but some of those may be correct codes " +
        "no labeler happened to think of. True precision is therefore >= the figure shown. " +
        "Pooled adjudication (§5.0.1) is what converts this floor into an estimate.",
      "RECALL is bracketed rather than bounded: the strict/generous pair spans labeler " +
        "disagreement about what is on the page. A NARROW span means certification would " +
        "barely move the number; a wide one means it would.",
    ].filter(Boolean),

    /** The single cell to quote. Without this the reader picks among four. */
    headline: {
      variant: certified ? "certified" : "strict",
      specificity: primaryMode,
      note: certified
        ? "Quote `results.certified." + primaryMode + "`."
        : "Quote the strict/generous PAIR as a range, never one alone. `strict` is named here only " +
          "as the conventional first cell; it is not a bound on `generous`.",
    },
    dataCompleteness: {
      goldPages: gold.pages.length,
      /** Gold pages the engine did not report. Scored as emitting nothing, NOT skipped. */
      missingFromEngine,
      unusableGold,
    },
    results,
  };

  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");

  const headVariant = certified ? "certified" : "strict";
  const head = (results[headVariant] as Record<Mode, {
    precision: number | null; recall: number | null; f05: number | null; perDivision: { powered: boolean }[];
  }>)[primaryMode];
  const powered = head.perDivision.filter(d => d.powered).length;
  console.error(
    `[score] ${certified ? "CERTIFIED" : "PROVISIONAL"} · ${headVariant}/${primaryMode} · ` +
      `P=${head.precision} R=${head.recall} F0.5=${head.f05} · ` +
      `${powered}/${head.perDivision.length} divisions gateable (>=${minUnits} gold groups) → ${outPath}`,
  );
}

// Only run the CLI when this file IS the entry point. Without the guard a test
// that imports the pure scoring helpers would execute main(), read argv from
// vitest, and exit the process.
if (process.argv[1]?.includes("csi-score")) main();
