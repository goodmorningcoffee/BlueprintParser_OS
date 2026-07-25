# CSI gold-set labeling protocol

**Status:** authored 2026-07-25 for PLAN §3 P1. The frame and rules below are fixed
before any page is labeled, on purpose — a protocol written after seeing the labels
is a protocol shaped by them.

This document defines *what a correct label is*. `select-gold-frame.ts` implements
*which pages get labeled*. Neither may be changed once labeling starts without
re-labeling the affected pages and saying so in `STATE.md`.

---

## 1 · What this gold set is for

To answer one question: **is the rebuilt tagger better than the old one, per division,
and by how much?** PLAN §2 sets the bar — F-β with β=0.5 (precision-weighted),
P and R reported separately per division, and no division regressing more than 2 pt.

It is *not* a training set. Nothing may be tuned on the test half (§8).

The old engine's output over the same corpus is already captured in
`baseline-old-engine.json` (471 pages, 19,761 codes, mean 42.4/page). That file says
what the old engine *emits*. This gold set is the only thing that can say what it
*should have* emitted.

---

## 2 · The frame

All **466** corpus pages that carry usable OCR text. The 5 Textract-failed pages
(`rawText` null) are excluded: the engine returns `[]` for them by the `< 10 chars`
guard, so they measure nothing about matching quality.

The frame is the whole corpus, not a subset. Sampling happens *within* the frame to
pick which pages get labeled (§3), but the population every metric generalizes to is
these 466 pages.

---

## 3 · Stratification — and the bias rule that shapes it

### 3.1 The rule: never stratify on old-engine output divisions

**Do not build strata from the divisions the old engine emitted.** It is the obvious
move and it is wrong. The old engine's documented failure mode (plan 2 §1, BRITTLE-1)
is that entire code families are *mathematically un-taggable* by it — `08 71 00 Door
Hardware`, `09 65 00 Resilient Flooring`, `09 68 00 Carpeting` all score below
threshold no matter what the page says. A gold set stratified by what the old engine
found would sample those pages in proportion to a distribution that, by construction,
contains none of them — and would then report excellent recall because it never
looked where the misses are.

Plan 2 §0 states the requirement directly: *"misses must be UNBIASED."* This is the
mechanism that keeps them so.

### 3.2 What the strata ARE built from

Two axes, both independent of the CSI engine:

- **Discipline**, from `pageIntelligence.classification.disciplinePrefix`, falling back
  to the first letter of `drawingNumber`. Collapsed into 4 groups to avoid unusable
  cells (raw distribution is `A` 249, `E` 41, `M` 34, `P` 27, `S` 20, then a long tail
  of 1–19):
  | group | members |
  |---|---|
  | `A` | A, ID |
  | `MEP` | M, E, P, FP, FA, H, HG, K, T |
  | `S` | S, SP, C, B, BR, Q, R |
  | `OTHER` | G, DM, DWG, ?, null, and anything unmatched |
- **Bundle** (project) is recorded per page and reported, but is not a stratum axis —
  with 7 bundles it would shatter the cells. It is used as a *tie-break* in selection
  so no single project dominates a stratum.

### 3.3 The third axis, used deliberately and named honestly

**Old-engine output volume** — the bucket a page falls in by how many codes the old
engine emitted (`0`, `1-10`, `11-50`, `51-150`, `151+`; population 100/121/146/69/35).

This *is* derived from old-engine output, which §3.1 just forbade as a stratum. The
distinction is what it is used for:

- It is **not** used to decide which *divisions* are represented. That would reintroduce
  the blind spot.
- It **is** used to guarantee both failure modes are observable: the 100 silent pages
  are where the old engine's **misses** live, and the 35 pages emitting 151+ codes are
  where its **false positives** live. Sampling proportionally without this axis would
  still cover both, but with no floor — and the 151+ bucket is 7% of the frame.

Every stratum's population size and sampling weight is written into the manifest, so
any metric can be reported per-stratum or reweighted back to the 466-page population.
**Report reweighted numbers when quoting a single headline figure**; a raw mean over a
non-proportional sample is not the corpus number.

### 3.4 Size and allocation

Target **240 pages** (PLAN §3 P1 asks for 150–300; 240 is the middle with room to drop
pages that turn out unlabelable). Allocation is proportional to stratum population with
a **floor of 3** per non-empty stratum, capped at the stratum's population.

Selection within a stratum is deterministic: pages are ranked by
`sha256(bundle + ":" + pageNumber)` and the first *k* taken. No RNG, no timestamp, no
corpus-order dependence. Re-running the selector on the same corpus reproduces the
manifest byte-for-byte.

---

## 4 · Label schema

Per page, extending the draft's `gold_single_pdf.json` shape (which the eval harness
in `run-eval.ts` already scores against — keeping the shape means the harness ports
rather than gets rewritten):

```jsonc
{
  "bundle": "b7014f2e-….json",
  "page": 17,
  "drawingNumber": "A-601.00",
  "discipline": "A",
  "stratum": "A|51-150",
  "split": "dev",                    // or "test" — see §8
  "acceptable_divisions": ["07","08","09","10"],
  "expected_groups": [
    { "id": "door_hardware", "tier": "primary", "division": "08",
      "codes": ["08 71 00"], "evidence": "pemko/overly, hinge, closer, panic",
      "note": "optional free text" }
  ],
  "should_not_codes": ["04 42 00"],
  "should_not_divisions": ["00","01"],
  "labeler": "llm:<model>@<date>",   // §9
  "reviewed_by": null,               // set by the human spot-check; null = NOT certified
  "confidence": "high|medium|low"    // labeler's own, used to route spot-checks
}
```

### 4.1 `expected_groups` — why a group, not a code

MasterFormat routinely offers several defensible codes for one physical thing
(`08 71 00 Door Hardware` vs `08 71 13 Automatic Door Operators`). A group is **hit if
the engine emits ANY code in it**. This measures "did the tagger identify the thing"
without punishing a defensible choice between siblings.

Groups are the unit of **recall**. Individual emitted codes are the unit of
**precision**.

### 4.2 `tier`

- `primary` — the sheet is substantially about this. A tagger that misses it is broken.
- `secondary` — genuinely present and a competent estimator would tag it.
- `tertiary` — defensible but thin; a single generic token. Missing it is not a real
  failure.

Report recall **overall and for `primary` alone**. The primary-only number is the one
that matters; the overall number is inflated by tertiary judgment calls.

### 4.3 `acceptable_divisions` and `should_not_*`

- `acceptable_divisions` — divisions that could legitimately appear. Anything outside
  is a **cross-division false positive**, the old engine's signature failure.
- `should_not_codes` — specific codes that are wrong *and expected to be tempting*.
  Seed these from `baseline-old-engine.json` for that page: an old-engine code the
  labeler judges wrong is exactly the case worth pinning. **This is the one permitted
  use of old-engine output during labeling** (§9.3), and it can only ever add negative
  labels — it cannot manufacture a positive one.
- `should_not_divisions` — whole divisions that are wrong for the sheet. `00` and `01`
  (procurement/general-requirements boilerplate) are the common ones.

---

## 5 · Matching, specificity, and the scoring rule

### 5.0 When an emitted code is a true or false positive

The first draft of this protocol said "groups are the unit of recall, emitted codes
are the unit of precision" and stopped there. That leaves the decisive case
undefined — an emitted code that matches no group but sits inside
`acceptable_divisions` — and three incompatible readings were available. The rule:

| emitted code | verdict |
|---|---|
| section-matches any `expected_groups[].codes` entry | **TP** |
| in `should_not_codes`, or its division in `should_not_divisions` | **FP** (hard) |
| division outside `acceptable_divisions` | **FP** (cross-division) |
| anything else — no group match, division acceptable | **FP** (unadjudicated), and counted separately |

Precision = TP / (TP + all FP). The fourth row is reported as its own column
because it is the row where **gold incompleteness, not the tagger, may be at
fault** — the labeler simply did not think of that code. If it is a large share
of a phase's FPs, the adjudication in §5.0.1 is what resolves it; do not quietly
reclassify it.

#### 5.0.1 Pooled adjudication — required before any OLD-vs-NEW comparison

Labels authored blind (§9.3) enumerate the *old* engine's wrong codes explicitly
via `should_not_codes`, but cannot anticipate a *new* engine's novel-yet-correct
codes. Scoring both engines against such a gold set is asymmetric: the old
engine's mistakes are named, the new engine's defensible-but-unlisted codes are
punished as FPs. Whichever way the fourth row above is treated, one engine is
favored.

So, at P2, before any comparison: **pool the union of both engines' emitted codes
for each gold page, strip which engine produced each, and have the labeler
adjudicate every pooled code not already covered by the labels** (standard TREC
pooling). Blinding to *which engine* emitted a code is what §9.3 is protecting;
blinding to the codes themselves is what makes precision unmeasurable. Adjudicated
codes are folded back into `expected_groups` or `should_not_codes` and the gold
version is bumped.

Until pooling has run, precision figures are **provisional** and must be labeled
as such.

### 5.1 Specificity

Two scoring modes, **both reported**:

| mode | rule | role |
|---|---|---|
| **SECTION** | first 4 digits (`NN NN`) must match | **primary** — drives F0.5 and the −2 pt regression gate |
| **EXACT** | full code incl. any `.NN` level-4 suffix | strict secondary, reported per division |

Rationale for SECTION as primary: MasterFormat level-4 codes are refinements of their
parent (`07 42 13` → `07 42 13.16 formed metal wall panels`), and 5,089 of the old
engine's 19,761 emitted codes carry a dotted suffix. Requiring level-4 exactness would
score a *more specific correct answer* as a false positive. SECTION still separates
`08 71` (door hardware) from `08 41` (storefront), which is the discrimination that
matters. The draft's harness already scores this way.

**Flagged for the owner, not decided unilaterally:** plan 2 §0 says "optimize for
EXACT-code precision". Read strictly that means level-4 exactness; read as "not merely
division-level", SECTION satisfies it. This protocol takes the second reading and
reports EXACT alongside so the choice is visible and reversible. See `STATE.md` owner
question.

#### 5.1.1 Dedupe by section before scoring precision

SECTION scoring is inflatable by sibling-spraying: emitting `08 71 00`,
`08 71 13` and `08 71 13.16` yields three SECTION true positives for one fact.
**Collapse emitted codes to their distinct sections before computing SECTION
precision.** EXACT precision uses the raw list.

Level-2 flooding is *not* a viable exploit and needs no separate guard: `08 00 00`
has section `0800`, which does not match `0871`, so spraying division roots scores
nothing.

### 5.2 Code canonicalization — required, because the formats disagree

Gold labels are written in **canonical spaced form** (`08 71 00`). The engine currently
emits nospace (`087100`, `074213.16`) — P0 finding F2. The eval harness **must**
canonicalize both sides before comparing, by stripping ` `, `.`, `-` and comparing
digit strings (SECTION = first 4 digits).

This is not cosmetic: without it every single comparison fails and the eval reports
0.0 precision. It also decouples the gold set from owner question #4 — whichever code
format the engine ends up emitting, these labels stay valid.

---

## 6 · What a labeler must look at

The page's OCR text (`rawText`) and word list. **Not** the rendered image — the engine
never sees the image (plan 2 §2.1), so labeling from it would create a ceiling the
tagger cannot reach by construction and would make recall look artificially bad.

If a page's text is too degraded to label confidently, mark `confidence: "low"` and
let the human reviewer decide; do not guess.

---

## 7 · Unlabelable pages

A page may be dropped from the gold set only for: null/empty text, or text with no
construction content at all (a blank sheet, a revision-history-only page). Dropping is
recorded in the manifest with a reason. **A page may never be dropped because the
labels were hard, or because the old engine did something surprising on it** — those
are the informative pages.

---

## 8 · dev / test split

**The unit of splitting is a correlation CLUSTER, never a page.** A cluster is the
transitive closure of two relations within one project: *same drawing series*
(`A-601.00` and `A-602` are both series `A6`) and *adjacent page number*. Pages
without a drawing number fall back to contiguous 8-page blocks.

Why: consecutive sheets of one series share title blocks, keynote legends and
vocabulary. Tuning on `A-804` and measuring on `A-805` is measuring on train.

The split assigns whole clusters greedily in size-descending order, choosing the
side currently thinner in **both** the cluster's strata and its project. Largest
clusters place first because a 15-page cluster has no good home once the halves
are nearly full.

An earlier version of this protocol split by parity of rank within a stratum. It
was wrong twice and an adversarial review caught both: rank was congruent to
project index (so whole projects landed on one side), and 54 pairs of consecutive
sheets straddled the split. Both are now zero and one, respectively — measured
every run into `splitQuality` in the manifest and asserted by
`csi-gold-frame.test.ts`.

**Balance is approximate, and that is the correct trade.** The result is 123/117,
not exactly 50/50; a cluster cannot be halved. Where cluster integrity and balance
conflict, **integrity wins** — an imbalanced split adds variance, a leaked split
invalidates the measurement.

Two consequences to state rather than hide:
- A stratum whose selected pages form a single cluster goes wholly to one side.
  None currently do, but the manifest records it if one ever does.
- Six small strata (2–8 selected pages, drawn from 2–4 projects) have dev and test
  halves with no project in common. That is arithmetic, not a defect: 3 pages from
  2 projects cannot put both projects on both sides. **No stratum larger than 8
  pages is project-disjoint**, which is the condition the test enforces.

- **dev** — inspect freely; tune thresholds, weights, lexicon against it.
- **test** — **look at it once, at the end of P2.** Do not iterate against it.

Every threshold, weight, prior, and lexicon entry is a parameter fitted to dev. Fitting
to test converts the acceptance bar into a number about itself. If test is inspected
mid-P2 for any reason, say so in `STATE.md` and treat the resulting figure as advisory.

The pilot slice (§9.1) is drawn **from dev only**, so calibration cannot contaminate test.

---

## 9 · Procedure — LLM proposes, human disposes

Plan 2 §0: an LLM may label the gold set **once, offline**; it *proposes*, a human
*spot-checks*, it **never self-certifies**. `reviewed_by: null` means uncertified, and
uncertified labels may not be used to compute an acceptance number.

### 9.1 Pilot first

Label ~20 dev pages spanning all four discipline groups and including at least one
silent page, one 151+ page, and one page touching a thin division (25/42/45). Take
*those* to the owner. Calibration disagreements found on 20 pages are cheap; found on
240 they mean relabeling everything.

### 9.2 Then the full pass

Only after the pilot's disagreement rate is known and the protocol is amended to
resolve it.

### 9.2.1 How much gets human review — resolve this before labeling

An earlier draft promised "spot-checks" in this section while §10 excluded any
label without `reviewed_by` from acceptance metrics. Those two cannot both hold:
spot-checking 20% would silently shrink the acceptance sample to ~48 pages and make
the per-division numbers (§11) even noisier than they already are.

The rule: **every page used for an acceptance number must be reviewed.** Review
depth may vary, and only two depths exist:

| depth | what the reviewer does | applies to |
|---|---|---|
| `full` | reads the page text and every group; may add, delete, retier | the pilot, plus the random audit slice |
| `confirm` | reads the labeler's groups against the page and accepts or bounces | everything else |

Budget accordingly: 240 pages at `confirm` depth is the real cost of this phase.
If the owner will not fund 240, **cut the page count, not the review** — a smaller
fully-reviewed set beats a larger uncertified one, because the uncertified part
cannot legally enter the metric anyway.

### 9.2.2 Random audit slice

Routing review by the labeler's own `confidence` field audits exactly where the
labeler already doubts itself; confidently-wrong labels escape by construction.
So: **10% of pages are drawn at random (by hash) for `full` review regardless of
stated confidence**, and the disagreement rate on that slice — not on the
self-flagged pages — is the number that describes label quality.

### 9.3 What the labeler may and may not see

- **May see:** the page text, `drawingNumber`, discipline, the MasterFormat list.
- **May see, for negative labels only:** the old engine's codes for that page, to
  populate `should_not_codes` (§4.3). It cannot create a positive label.
- **Must not see:** the new engine's output, ever. That is the thing being measured.

---

## 10 · Quality checks before the set is usable

1. Every stratum has ≥1 labeled page in each of dev and test.
2. All 4 discipline groups present in both halves.
3. Disagreement rate recorded from the **random audit slice** (§9.2.2), not from
   the self-flagged low-confidence pages.
4. No page appears in both halves; no page appears twice; **no correlation cluster
   straddles the split** and no stratum larger than 8 pages is project-disjoint (§8).
5. Every page contributing to an acceptance number has `reviewed_by` set (§9.2.1).

Checks 1, 2 and 4 are mechanical and enforced by `src/lib/__tests__/csi-gold-frame.test.ts`.
Checks 3 and 5 need labels and are enforced when the labels land.

---

## 11 · Metric aggregation, and where the −2 pt gate can actually be read

### 11.1 Aggregation — specify it, because the labeler controls the denominator

Recall's denominator is `expected_groups`, which the labeler authors. An LLM that
writes 3 groups for a door schedule and one that writes 12 for the same sheet
produce different recall for identical tagger behavior.

- **Recall: weighted micro-average over groups.** Pool all groups across pages,
  weight each by its stratum weight, and divide hits by total. Macro-average over
  pages is reported as a diagnostic only — it lets a 1-group page outvote a
  20-group page.
- **Precision: weighted micro-average over emitted codes**, same weighting.
- **Always reweight by stratum weight when quoting a corpus figure.** The sample is
  not proportional and a raw mean is not the corpus number. The eval harness must
  take the weights from `gold-frame.json`; a harness that ignores them silently
  reports a sample statistic as a population one.
- Report recall **overall and for `primary` groups alone** (§4.2).

Before the pilot, write a **group-granularity rubric with worked examples** — one
group per distinct construction system, not per mention, not per code. Without it,
the pilot calibrates the labeler on codes while leaving the denominator free.

### 11.2 The −2 pt per-division gate cannot be read for most divisions

PLAN §2 sets a gate of "no division regressing more than 2 pt". At this sample
size that is not measurable for most divisions, and reporting it as if it were
would be the most misleading thing this whole exercise could produce.

Concretely: on the 240 selected pages, division 25 appears on ~11 pages, 42 on ~14,
45 on ~17 — and those counts come from old-engine emissions, which are inflated by
its false positives. True gold scoring units for thin divisions will be single
digits. With n≈10, one flipped item moves that division by ~10 pt. A 2 pt
difference is far inside the noise; the gate would fire or pass essentially at
random for roughly two thirds of the 35 divisions.

**Therefore:**

| division has | treatment |
|---|---|
| ≥50 gold scoring units | the −2 pt gate applies as written |
| < 50 units | **reported as "not powered", never as "passed"** — decided by paired-bootstrap CI over pages, and only a *significant* regression blocks |

A division that lacks the data to detect a regression has not passed a regression
test. Saying so is the difference between a measurement and a decoration.

**This changes a gate PLAN §2 states, so it is an owner decision, not mine** — see
the owner question in `STATE.md`. Recorded here so the constraint is visible at the
point of use.
