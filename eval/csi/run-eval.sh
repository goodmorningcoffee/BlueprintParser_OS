#!/usr/bin/env bash
# run-eval.sh — CSI v2 S5 end-to-end eval (IMPLEMENTATION §II S5, PLAN §8).
#
#   eval/csi/run-eval.sh old   # scores the frozen OLD baseline only (runs today)
#   eval/csi/run-eval.sh v2    # capture v2 (± context) → score → compare → sweep τ (± context)
#
# Steps: verify corpus (wc=471, sha 5c3a9cde…) → esbuild bundles named csi-* (the scripts' argv
# guards key on those names) → capture → score.ts with --frame (HARD-FAIL on "NO stratum weights"
# / "UNKNOWN STRATA") → compare.ts (old vs new; flat cells cross-checked against score.ts) → τ sweep.
# Numbers-only results → eval/csi/results/<label>-<date>.json. Anything carrying text (score JSONs
# embed the gold path; top (code, pattern) pairs are KB text) → build/ or the private dir.
# Run from the repo root.
set -euo pipefail

LABEL="${1:?usage: eval/csi/run-eval.sh old|v2}"
case "$LABEL" in old|v2) ;; *) echo "run-eval: label must be old|v2, got $LABEL" >&2; exit 1;; esac

WORK="${CSI_WORK:-/workspaces/projects/gitignore/csi_baseline_work}"
CORPUS="${CSI_CORPUS:-$WORK/corpus.ndjson}"
LINES="${CSI_CORPUS_LINES:-$WORK/corpus-lines.ndjson}"
GOLD="${CSI_GOLD:-/workspaces/projects/gitignore/projects/csi_private_eval/gold-pilot.json}"
PRIVATE="${CSI_PRIVATE:-/workspaces/projects/gitignore/projects/csi_private_eval/v2}"
FRAME="eval/csi/gold-frame.json"
OLD_CAPTURE="eval/csi/baseline-old-engine.json"
CORPUS_SHA="5c3a9cdea5ff68379692364afd64013e908131b8ca506cc993178e5c4a9b029c"
STAMP="$(date -u +%Y-%m-%d)"
RESULTS="eval/csi/results/$LABEL-$STAMP.json"

[ -f eval/csi/score.ts ] || { echo "run-eval: run from the repo root" >&2; exit 1; }
for f in "$CORPUS" "$GOLD" "$FRAME" "$OLD_CAPTURE"; do [ -f "$f" ] || { echo "run-eval: missing $f" >&2; exit 1; }; done

# ── 1. corpus integrity (corpus.ndjson is frozen; never rewritten here) ─────────
rows=$(wc -l < "$CORPUS"); sha=$(sha256sum "$CORPUS" | cut -d' ' -f1)
[ "$rows" -eq 471 ] || { echo "run-eval: corpus rows=$rows, expected 471" >&2; exit 1; }
[ "$sha" = "$CORPUS_SHA" ] || { echo "run-eval: corpus sha $sha != $CORPUS_SHA" >&2; exit 1; }
echo "[run-eval] corpus OK: 471 rows, sha ${sha:0:16}" >&2

# ── 2. bundles (names must contain the argv-guard substring and nothing else's) ─
mkdir -p build eval/csi/results "$PRIVATE"
bundle() { npx esbuild "eval/csi/$1.ts" --bundle --platform=node --target=node24 --alias:@=./src \
  --external:pg-native --log-level=warning --outfile="build/$2.js"; }
bundle score csi-score
bundle compare csi-compare
bundle sweep-tau csi-sweep-tau

# ── 3. capture ─────────────────────────────────────────────────────────────────
ENGINES=(--engine=old="$OLD_CAPTURE")
if [ "$LABEL" = v2 ]; then
  lrows=$(wc -l < "$LINES" 2>/dev/null || echo 0)
  [ "$lrows" -eq 471 ] || { echo "run-eval: $LINES rows=$lrows, expected 471 — run eval/csi/extract-corpus-lines.sh" >&2; exit 1; }
  # capture-v2.ts joins corpus.ndjson + corpus-lines.ndjson on bundle:pageNumber and calls, per page,
  #   detectCsiV2({ lines, context: { discipline, drawingNumber } }, config, kb) → build/v2-engine.json
  #   detectCsiV2({ lines }, config, kb)                                         → build/v2-engine-noctx.json
  # `codes` at the default config (τ 0.75), `codeDetails` at τ=0 with confidence (the sweep re-derives
  # τ from them and step 6 checks derived(0.75) == codes); engineSha + kbSha in the header. Span dumps
  # (drawing text) → $PRIVATE only.
  bundle capture-v2 csi-capture-v2
  node build/csi-capture-v2.js "$CORPUS" "$LINES" build/v2-engine.json build/v2-engine-noctx.json "$PRIVATE"
  ENGINES+=(--engine=v2=build/v2-engine.json --engine=v2-noctx=build/v2-engine-noctx.json)
fi

# ── 4. score.ts per engine, hard-fail on missing strata ─────────────────────────
score() {  # <label> <capture>
  node build/csi-score.js "$GOLD" "$2" "build/score-$1.json" --frame="$FRAME"
  if jq -e '[.caveats[] | select(test("NO stratum weights|UNKNOWN STRATA"))] | length > 0' "build/score-$1.json" >/dev/null; then
    echo "run-eval: HARD FAIL — score-$1 ran without complete stratum weights:" >&2
    jq -r '.caveats[] | select(test("NO stratum weights|UNKNOWN STRATA"))' "build/score-$1.json" >&2
    exit 1
  fi
}
score old "$OLD_CAPTURE"
CHECKS=(--check-score=old=build/score-old.json)
if [ "$LABEL" = v2 ]; then
  score v2 build/v2-engine.json; score v2-noctx build/v2-engine-noctx.json
  CHECKS+=(--check-score=v2=build/score-v2.json --check-score=v2-noctx=build/score-v2-noctx.json)
fi

# ── 5. compare (distinct pages, strict/generous × section/exact × hierarchy) ─────
node build/csi-compare.js --gold="$GOLD" --frame="$FRAME" --corpus="$CORPUS" \
  "${ENGINES[@]}" "${CHECKS[@]}" --out="$RESULTS" --private-out="$PRIVATE/compare-$LABEL-$STAMP-toppairs.json"
echo "[run-eval] numbers → $RESULTS" >&2

# ── 6. τ sweep (v2 only), against OLD on the SAME deduped gold ───────────────────
if [ "$LABEL" = v2 ]; then
  OR=$(jq '.results.old.strict.section.recall' "$RESULTS"); OP=$(jq '.results.old.strict.section.precision' "$RESULTS")
  for cap in v2-engine v2-engine-noctx; do
    node build/csi-sweep-tau.js --gold="$GOLD" --frame="$FRAME" --corpus="$CORPUS" --capture="build/$cap.json" \
      --check=0.75="build/$cap.json" --old-recall="$OR" --old-precision="$OP" --out="build/sweep-$cap-$STAMP.json"
  done
fi

# ── 7. fold the sweeps (numbers only) into the committed results file ──────────────
if [ "$LABEL" = v2 ]; then
  jq --slurpfile a "build/sweep-v2-engine-$STAMP.json" --slurpfile b "build/sweep-v2-engine-noctx-$STAMP.json" \
    '.sweep = { "v2": $a[0], "v2-noctx": $b[0] }' "$RESULTS" > "$RESULTS.tmp" && mv "$RESULTS.tmp" "$RESULTS"
  echo "[run-eval] τ sweeps (± context) folded into $RESULTS" >&2
fi
