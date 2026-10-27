# Parse engine — intended diffs against the TP-1 legacy goldens

The legacy goldens were captured at the TP-1 head `67492cc` (table-pipeline WP-2.0a) by
`src/lib/parse-engine/__tests__/legacy-golden.test.ts` (synthetic fixtures, committed:
`src/lib/parse-engine/__fixtures__/legacy-goldens.synthetic.json`) and
`legacy-golden-private.test.ts` (real slices, private docs repo only). They are a baseline and are
never re-captured to absorb a change.

A work package that changes a legacy path **on purpose** declares every changed `(fixture, path)` pair
in the table below. The golden tests fail on:
- an **undeclared** diff (a legacy output changed and nobody said so), and
- a **stale** row (a declared pair that no longer differs).

## Rules for this file

- **Ids only, never text.** Cite fixture ids (`syn-…` synthetic, `prv-…` private) and path ids; never
  quote a cell, a word, a header or a note. This file is public.
- Every row cites at least one defect number (`K07`, …) from the table-pipeline inventory.
- `*` in the fixture column covers every fixture of that path, synthetic and private. The tests refuse a
  `*` row unless the path's output changed on **every** fixture where it is non-null; otherwise list the
  changed fixtures one row per id, so that an unintended change on another fixture still fails.
- Path ids: `ocr-positions`, `textract`, `shape-rows`, `merger`, `guided-extract`, `manual`,
  `keynote-manual`, `keynote-guided`, `notes-auto`, `notes-guided`, `notes-paragraph`,
  `spec-paragraph`, `notes-fast-manual`, `notes-manual`, `spec-auto`.

## Declared diffs

| fixture | path | K | WP | why (no drawing text) |
|---|---|---|---|---|
| syn-sched-shapes-centred-3line | shape-rows | K13 | WP-2.C | midpoint bands: each centred 3-line description stays in its row; the header no longer takes row 0's upper line |
| syn-sched-shapes-centred-3line | merger | K13 | WP-2.C | the shape-rows base changes as above |
| syn-sched-shapes-tall-last | shape-rows | K13 | WP-2.C | the last band runs to the last word in the region: the tall last row keeps its trailing lines |
| syn-sched-shapes-tall-last | merger | K13 | WP-2.C | the shape-rows base changes as above |
| syn-sched-shapes-classical-dotted | shape-rows | K13 | WP-2.C | C2-m4: two crop-read keys get their dropped separator back from the sibling keys; row boundaries are midpoints |
| syn-sched-shapes-classical-dotted | merger | K13 | WP-2.C | C2-m4: the repaired keys reach the merged grid (row text unchanged) |
| syn-sched-shapes-hex | shape-rows | K13 | WP-2.C | row boundaries only (midpoints, last band to the last word); every cell unchanged |
| syn-keynote-shapes | shape-rows | K13 | WP-2.C | row boundaries only (midpoints, last band to the last word); every cell unchanged |
| syn-keynote-shapes | merger | K13 | WP-2.C | row boundaries only; every cell unchanged |
| syn-kv-symbol-legend | shape-rows | K13 | WP-2.C | row boundaries only (midpoints, last band to the last word); every cell unchanged |
| syn-kv-symbol-legend | merger | K13 | WP-2.C | row boundaries only; every cell unchanged |
| syn-notes-keynote-bubbles | shape-rows | K13 | WP-2.C | top-aligned column keeps the shape-top cuts; only the last band now runs to the last word; every cell unchanged |
| syn-notes-keynote-bubbles | merger | K13 | WP-2.C | row boundaries only; every cell unchanged |
