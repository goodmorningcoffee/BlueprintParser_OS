# eval/csi — CSI tagger baseline and gold set

> **Four artifacts are not in this repository.** `GRANULARITY_RUBRIC.md`, `gold-pilot.json`,
> `PILOT_ADJUDICATION_PACKET.md` and `lexicon-gap.json` quote sheet text from a client's drawings
> (title blocks, firm names, contact details), so they stay with the project owner outside the public
> repo. The tooling that produced them is here and runs against any corpus; the tests that asserted
> on those files were retired with them. The table below is kept as the record of what existed.
>
> **The CSI v2 lookup table `src/data/csi-kb.json` is not in git either** (owner ruling D1, 2026-10-20:
> MasterFormat phrases are not redistributed); rebuild it from the PDF per the header of `build-kb-v2.ts`.
> **Nor is the parser fixture `src/lib/__tests__/fixtures/csi-v2/mf-pages-excerpt.json`** (owner ruling
> 2026-10-20, same as D1: verbatim PDF page text); regenerate it per the header of `mf-fixture-extract.ts`.

| file | what it is | phase |
|---|---|---|
| `baseline-old-engine.json` | what the OLD engine **emits** over all 471 pages | P0.1 |
| `extract-corpus.sh` + `capture.ts` | the harness that produced it | P0.1 |
| `LABELING_PROTOCOL.md` | what a **correct** label is — read before labeling anything | P1.1 |
| `GRANULARITY_RUBRIC.md` | what counts as ONE group — the recall denominator, with worked examples | P1.2a |
| `select-gold-frame.ts` | which pages get labeled, deterministically | P1.1 |
| `gold-frame.json` | the resulting selection: 240 pages, 20 strata, dev/test split | P1.1 |
| `pilot-agreement.ts` | merges the two independent pilot passes and scores their agreement | P1.2b |
| `gold-pilot.json` | 20 calibration pages, both passes, agreement per page — **UNCERTIFIED** | P1.2b |
| `adjudication-packet.ts` → `PILOT_ADJUDICATION_PACKET.md` | the review document the owner works through to certify the pilot | S1b |
| `score.ts` → `score-old-engine.json` | **the eval harness** — P/R/F0.5 per division, and the thing that refuses to lie | S2 |

The baseline says what the engine *does*. The gold set is the only thing that can
say what it *should have done*. Neither alone is an acceptance bar.

**Before building the P2 knowledge base, read
`claude_notes/CSI_REBUILD/S4_TSV_AUDIT.md`.** Two things there change the plan:
the 26.4%-unreachable problem is a SCORING problem, not a data one (in-repo
synonyms rescue only 5.6% of it), and `src/data/csi.tsv` supplies 785 free
significant words as alternate titles for 212 existing codes.

`baseline-old-engine.json` is the **pre-rebuild measurement** of the live CSI text
engine. Everything the rebuild claims about precision is scored against this file.

## What it is

The live engine run over **every page of the 7-bundle `bp-export/1` corpus** —
471 pages, not a sample. Sampling was considered and rejected: the corpus is
small enough to score whole in ~30 s, so there is no sampling rule for a later
reader to argue with.

The call is fixed and recorded in the artifact:

```
detectCsiCodes(rawText, textractData.words, undefined, undefined)
```

`config=undefined` → `DEFAULT_CSI_DETECT_CONFIG`; `db=undefined` → builtin
`csi-masterformat.tsv`. That is the `companyId == null` path, which the jul9 C1
refactor pinned as byte-identical to the pre-refactor engine (invariant I-6).
Baselining through a company config instead would fold per-tenant slider drift
into the number and make later comparisons meaningless.

## Fidelity — why this baseline can be trusted

The corpus bundles carry the codes production actually persisted, so the capture
is self-checking. Re-running the engine reproduces them:

| | |
|---|---|
| pages whose emitted code set exactly equals what production stored | **466 / 471** |
| codes emitted that production did **not** have | **0** |
| codes stored that the re-run did not emit | **10** |

All 10 are on 5 pages and are the two YOLO-class-config sentinels (`08`,
`08 00 00`) that enter `pages.csiCodes` through the YOLO union path, not the
text engine. So the text engine reproduces at 100% and the residual is explained
by provenance, not by harness error.

Two consecutive captures are byte-identical apart from `capturedAt` and
`summary.elapsedMs`.

## Reproducing

```bash
# Stage A — pull engine inputs out of the bundles (~20 s, bounded memory)
eval/csi/extract-corpus.sh <bundles-dir> /path/to/work/corpus.ndjson

# Stage B — score with the live engine (~30 s)
npx esbuild eval/csi/capture.ts --bundle --platform=node --target=node20 \
  --outfile=build/csi-capture.js --alias:@=./src --external:pg-native
node build/csi-capture.js /path/to/work/corpus.ndjson eval/csi/baseline-old-engine.json
```

`corpus.ndjson` is ~48 MB and is **not** committed — keep it outside the repo.
The artifact records `corpusSha` so a later run can prove it scored the same
inputs, and `engineSha` for the four files that define engine behavior
(`csi-detect.ts`, `csi-detect-defs.ts`, `csi-database.ts`, the masterformat TSV).
**If any `engineSha` no longer matches the working tree, this baseline is stale
by construction** — recapture before comparing against it.

## Reading the artifact

- `summary` — corpus-level counts.
- `divisionHistogram` — an **array** sorted by count descending. It is not an
  object on purpose: JS objects reorder integer-like keys, which would silently
  destroy the sort and scatter `"00".."09"` after `"48"`.
- `pages[]` — one row per page: `codes` (sorted, human-diffable), `resultSha`
  (hash of the full unsorted result including triggers and bboxes, so drift the
  sorted list cannot see still shows up), `inputSha`, `triggers` counts by tier,
  and `priorCodes` (what production had stored).

`resultSha` is the drift detector; `codes` is what you read.
