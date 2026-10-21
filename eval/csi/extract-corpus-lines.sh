#!/usr/bin/env bash
# extract-corpus-lines.sh — CSI v2 S5 (IMPLEMENTATION §II S5, PLAN §8).
#
# The v2 engine reads Textract LINES (one matching unit per line, token bboxes from
# line.words), which the frozen corpus.ndjson does not carry — it kept only rawText +
# flat words. This writes a SIBLING file, one row per page, in the SAME order as
# corpus.ndjson (sorted bundle filename, then bundle page order), keyed bundle:pageNumber:
#
#   {bundle, pageNumber, lines:[{text, bbox, words:[{text, bbox}]}]}
#
# ⛔ corpus.ndjson is NEVER written here (its sha 5c3a9cde… is provenance). It is only
# READ, to verify the join: same row count (471), same bundle:pageNumber sequence, and
# the distinct-page count by rawText sha (378) that compare.ts dedupes on.
# `confidence` is dropped (not in the S5 schema); a consumer typing these as
# TextractLine supplies it.
#
# Usage: eval/csi/extract-corpus-lines.sh <bundles-dir> <out.ndjson> [corpus.ndjson]
#        (corpus defaults to corpus.ndjson beside <out>)
set -euo pipefail

BUNDLES_DIR="${1:?usage: extract-corpus-lines.sh <bundles-dir> <out.ndjson> [corpus.ndjson]}"
OUT="${2:?usage: extract-corpus-lines.sh <bundles-dir> <out.ndjson> [corpus.ndjson]}"
CORPUS="${3:-$(dirname "$OUT")/corpus.ndjson}"
EXPECT_ROWS="${CSI_EXPECT_ROWS:-471}"
EXPECT_DISTINCT="${CSI_EXPECT_DISTINCT:-378}"

[ -d "$BUNDLES_DIR" ] || { echo "extract-corpus-lines: no such directory: $BUNDLES_DIR" >&2; exit 1; }
case "$(basename "$OUT")" in corpus.ndjson) echo "extract-corpus-lines: refusing to write corpus.ndjson" >&2; exit 1;; esac
if [ -e "$CORPUS" ] && [ "$(realpath "$OUT" 2>/dev/null || echo "$OUT")" = "$(realpath "$CORPUS")" ]; then
  echo "extract-corpus-lines: <out> is the corpus file — refusing" >&2; exit 1
fi

mapfile -t FILES < <(find "$BUNDLES_DIR" -maxdepth 1 -name '*.json' -type f | sort)
[ "${#FILES[@]}" -gt 0 ] || { echo "extract-corpus-lines: no *.json bundles in $BUNDLES_DIR" >&2; exit 1; }

TMP="$OUT.tmp.$$"
trap 'rm -f "$TMP"' EXIT
: > "$TMP"
for f in "${FILES[@]}"; do
  base="$(basename "$f")"
  echo "[extract-lines] $base ($(du -h "$f" | cut -f1))" >&2
  jq -c --arg src "$base" '
    .pages[]
    | {
        bundle:     $src,
        pageNumber: .pageNumber,
        lines: [ (.textractData.lines // [])[]
                 | { text: .text, bbox: .bbox,
                     words: [ (.words // [])[] | { text: .text, bbox: .bbox } ] } ]
      }
  ' "$f" >> "$TMP"
done

rows=$(wc -l < "$TMP")
[ "$rows" -eq "$EXPECT_ROWS" ] || { echo "extract-corpus-lines: FAIL rows=$rows, expected $EXPECT_ROWS" >&2; exit 1; }

if [ -f "$CORPUS" ]; then
  # Join check + distinct-by-rawText-sha, read-only on the corpus.
  node -e '
    const fs = require("fs"), { createHash } = require("crypto");
    const [corpus, lines, expectDistinct] = process.argv.slice(1);
    const rd = p => fs.readFileSync(p, "utf-8").split("\n").filter(Boolean).map(l => JSON.parse(l));
    const c = rd(corpus), l = rd(lines);
    if (c.length !== l.length) { console.error(`FAIL corpus rows ${c.length} != lines rows ${l.length}`); process.exit(1); }
    for (let i = 0; i < c.length; i++) {
      if (c[i].bundle !== l[i].bundle || c[i].pageNumber !== l[i].pageNumber) {
        console.error(`FAIL row ${i}: corpus ${c[i].bundle}:${c[i].pageNumber} != lines ${l[i].bundle}:${l[i].pageNumber}`); process.exit(1);
      }
    }
    const d = new Set(c.map(r => createHash("sha256").update(r.rawText ?? "").digest("hex"))).size;
    const withLines = l.filter(r => r.lines.length > 0).length;
    console.error(`[extract-lines] join OK (${c.length} rows, keys aligned) · distinct by rawText sha = ${d} · pages with lines = ${withLines}`);
    if (d !== Number(expectDistinct)) { console.error(`FAIL distinct=${d}, expected ${expectDistinct}`); process.exit(1); }
  ' "$CORPUS" "$TMP" "$EXPECT_DISTINCT"
else
  echo "extract-corpus-lines: WARN no corpus at $CORPUS — join/distinct check skipped" >&2
fi

mv "$TMP" "$OUT"
trap - EXIT
echo "[extract-lines] wrote $rows page records → $OUT ($(du -h "$OUT" | cut -f1)) sha256 $(sha256sum "$OUT" | cut -c1-16)" >&2
