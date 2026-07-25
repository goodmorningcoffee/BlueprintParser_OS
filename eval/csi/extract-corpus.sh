#!/usr/bin/env bash
# extract-corpus.sh — Stage A of the CSI freeze-first corpus baseline (PLAN P0).
#
# Pulls ONLY the engine's inputs out of the bp-export/1 bundles into a compact
# NDJSON, one line per page. The bundles are 438 MB of mostly-textractData; the
# engine reads just `rawText` + `textractData.words`, so this drops ~90% of the
# bytes and lets Stage B (capture.ts) stay a plain streaming read.
#
# Why a separate jq stage instead of parsing the bundles in TS: the largest
# bundle is 141 MB and node would have to hold the whole parsed tree; jq does
# one file at a time and exits, so peak RSS stays bounded regardless of corpus
# growth.
#
# DETERMINISM: bundles are iterated in sorted filename order and pages in
# bundle order, so the NDJSON is byte-stable across runs for a fixed corpus.
# That is what makes the committed baseline reproducible.
#
# Usage: eval/csi/extract-corpus.sh <bundles-dir> <out.ndjson>
set -euo pipefail

BUNDLES_DIR="${1:?usage: extract-corpus.sh <bundles-dir> <out.ndjson>}"
OUT="${2:?usage: extract-corpus.sh <bundles-dir> <out.ndjson>}"

if [ ! -d "$BUNDLES_DIR" ]; then
  echo "extract-corpus: no such directory: $BUNDLES_DIR" >&2
  exit 1
fi

# Sorted glob → stable bundle order.
mapfile -t FILES < <(find "$BUNDLES_DIR" -maxdepth 1 -name '*.json' -type f | sort)
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "extract-corpus: no *.json bundles in $BUNDLES_DIR" >&2
  exit 1
fi

: > "$OUT"
for f in "${FILES[@]}"; do
  base="$(basename "$f")"
  echo "[extract] $base ($(du -h "$f" | cut -f1))" >&2
  # `// null` / `// []` guards: rawText is null on Textract-failed pages and
  # textractData is absent when the export omitted it — both are real states in
  # this corpus (5 failed pages), and both must survive to Stage B rather than
  # crashing here, because "engine returns [] for a null-text page" is itself
  # behavior worth freezing.
  jq -c --arg src "$base" '
    .project.publicId as $pid
    | .pages[]
    | {
        bundle:       $src,
        publicId:     $pid,
        pageNumber:   .pageNumber,
        drawingNumber:(.drawingNumber // null),
        discipline:   (.pageIntelligence.classification.disciplinePrefix // null),
        rawText:      (.rawText // null),
        words:        [ (.textractData.words // [])[] | { text: .text, bbox: .bbox } ],
        priorCodes:   [ (.csiCodes // [])[] | .code ]
      }
  ' "$f" >> "$OUT"
done

echo "[extract] wrote $(wc -l < "$OUT") page records → $OUT ($(du -h "$OUT" | cut -f1))" >&2
