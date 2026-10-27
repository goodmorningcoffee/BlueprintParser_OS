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
- `*` in the fixture column covers every fixture of that path (use it only when a change is meant to
  touch all of them).
- Path ids: `ocr-positions`, `textract`, `shape-rows`, `merger`, `guided-extract`, `manual`,
  `keynote-manual`, `keynote-guided`, `notes-auto`, `notes-guided`, `notes-paragraph`,
  `spec-paragraph`, `notes-fast-manual`, `notes-manual`, `spec-auto`.

## Declared diffs

| fixture | path | K | WP | why (no drawing text) |
|---|---|---|---|---|
