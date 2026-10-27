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

### WP-2.B: text assembly at the root (K06, K07, K09, C04-03)

Generated from the golden diff at the WP-2.B tree (one row per changed pair; `*` only for `notes-guided`, which
changed on every fixture). `notes-fast-manual` is deliberately unchanged (one row = one OCR LINE, whose word
order is already the reading order).

| fixture | path | K | WP | why (no drawing text) |
|---|---|---|---|---|
| * | notes-guided | K07 | WP-2.B | proposal rows closed at the region bottom so the last note is extracted (C04-03); cells read line by line |
| syn-keynote-basic | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| syn-keynote-multiline | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| syn-keynote-shapes | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| syn-keynote-sheet-keys | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| syn-notes-keynote-bubbles | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| syn-sched-basic | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| syn-sched-center-align | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| syn-sched-dup-headers | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| syn-sched-ef-tags | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| syn-sched-long | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| syn-sched-multiline-middle | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| syn-sched-multiline-top | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| syn-sched-no-header | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| syn-sched-section-rows | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| syn-sched-shapes-centred-3line | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| syn-sched-shapes-hex | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| syn-sched-shapes-tall-last | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| syn-sched-sparse | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| syn-sched-textract-header-row | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| syn-sched-textract-merged | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| syn-sched-textract-multiline | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| syn-sched-two-blocks | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| syn-sched-two-tier | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| syn-sched-yjitter-multiline | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| syn-sched-yjitter | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| syn-keynote-multiline | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-keynote-shapes | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-notes-dimension-start | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-notes-keynote-bubbles | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-notes-lettered | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-notes-paren-keys | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-notes-preamble | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-notes-single-line | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-notes-subblocks | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-notes-two-column | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-notes-wrapped-hanging | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-notes-wrapped-tight-gap | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-sched-multiline-middle | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-sched-multiline-top | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-sched-row-lines | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-sched-shapes-centred-3line | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-sched-shapes-tall-last | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-sched-textract-multiline | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-sched-yjitter-multiline | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-spec-multicolumn-dense | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-spec-section | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-spec-sentence-header-trap | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-spec-two-sections | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-keynote-multiline | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| syn-keynote-shapes | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| syn-notes-dimension-start | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| syn-notes-keynote-bubbles | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| syn-notes-lettered | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| syn-notes-paren-keys | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| syn-notes-preamble | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| syn-notes-subblocks | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| syn-notes-two-column | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| syn-notes-wrapped-hanging | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| syn-notes-wrapped-tight-gap | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| syn-sched-dup-headers | manual | K06, K07 | WP-2.B | manual headers deduped (uniqueHeaders) and cells read line by line |
| syn-sched-multiline-middle | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| syn-sched-multiline-top | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| syn-sched-row-lines | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| syn-sched-shapes-centred-3line | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| syn-sched-shapes-tall-last | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| syn-sched-textract-multiline | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| syn-sched-yjitter-multiline | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| syn-spec-multicolumn-dense | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| syn-spec-section | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| syn-spec-sentence-header-trap | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| syn-spec-two-sections | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| syn-keynote-multiline | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| syn-keynote-shapes | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| syn-notes-dimension-start | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| syn-notes-keynote-bubbles | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| syn-notes-lettered | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| syn-notes-paren-keys | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| syn-notes-preamble | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| syn-notes-subblocks | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| syn-notes-two-column | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| syn-notes-wrapped-hanging | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| syn-notes-wrapped-tight-gap | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| syn-sched-multiline-middle | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| syn-sched-multiline-top | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| syn-sched-row-lines | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| syn-sched-shapes-centred-3line | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| syn-sched-shapes-tall-last | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| syn-sched-textract-multiline | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| syn-sched-yjitter-multiline | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| syn-spec-multicolumn-dense | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| syn-spec-section | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| syn-spec-sentence-header-trap | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| syn-spec-two-sections | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| syn-keynote-multiline | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-keynote-shapes | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-notes-dimension-start | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-notes-keynote-bubbles | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-notes-lettered | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-notes-paren-keys | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-notes-preamble | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-notes-single-line | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-notes-subblocks | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-notes-two-column | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-notes-wrapped-hanging | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-notes-wrapped-tight-gap | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-sched-multiline-middle | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-sched-multiline-top | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-sched-row-lines | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-sched-shapes-centred-3line | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-sched-shapes-tall-last | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-sched-textract-multiline | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-sched-yjitter-multiline | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-spec-multicolumn-dense | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-spec-section | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-spec-sentence-header-trap | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-spec-two-sections | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| syn-keynote-multiline | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| syn-keynote-shapes | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| syn-notes-dimension-start | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| syn-notes-keynote-bubbles | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| syn-notes-lettered | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| syn-notes-paren-keys | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| syn-notes-preamble | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| syn-notes-subblocks | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| syn-notes-two-column | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| syn-notes-wrapped-hanging | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| syn-notes-wrapped-tight-gap | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| syn-sched-multiline-middle | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| syn-sched-multiline-top | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| syn-sched-row-lines | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| syn-sched-shapes-centred-3line | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| syn-sched-shapes-tall-last | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| syn-sched-textract-multiline | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| syn-sched-yjitter-multiline | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| syn-spec-multicolumn-dense | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| syn-spec-section | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| syn-spec-sentence-header-trap | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| syn-spec-two-sections | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| syn-sched-dup-headers | ocr-positions | K06 | WP-2.B | duplicate printed headers deduped (uniqueHeaders) |
| syn-sched-two-blocks | ocr-positions | K06 | WP-2.B | duplicate printed headers deduped (uniqueHeaders) |
| syn-sched-two-tier | ocr-positions | K06 | WP-2.B | duplicate printed headers deduped (uniqueHeaders) |
| syn-sched-dup-headers | merger | K06 | WP-2.B | merges ocr-positions, whose duplicate headers are now deduped |
| syn-sched-two-blocks | merger | K06 | WP-2.B | merges ocr-positions, whose duplicate headers are now deduped |
| syn-sched-two-tier | merger | K06 | WP-2.B | merges ocr-positions, whose duplicate headers are now deduped |
| prv-0001 | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| prv-0003 | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| prv-0005 | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| prv-0007 | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| prv-0008 | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| prv-0010 | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| prv-0015 | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| prv-0018 | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| prv-0019 | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| prv-0020 | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| prv-0024 | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| prv-0028 | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| prv-0030 | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| prv-0032 | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| prv-0034 | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| prv-0036 | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| prv-0037 | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| prv-0038 | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| prv-0039 | notes-auto | K09 | WP-2.B | notes catch-all key/value binder pairs LINEs that share a visual line (kv-pairs) |
| prv-0002 | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| prv-0010 | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| prv-0012 | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| prv-0016 | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| prv-0019 | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| prv-0022 | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| prv-0027 | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| prv-0030 | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| prv-0034 | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| prv-0035 | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| prv-0036 | guided-extract | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| prv-0002 | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| prv-0010 | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| prv-0012 | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| prv-0016 | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| prv-0019 | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| prv-0022 | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| prv-0027 | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| prv-0030 | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| prv-0034 | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| prv-0035 | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| prv-0036 | manual | K07 | WP-2.B | manual cell join reads line by line (assembleText) |
| prv-0002 | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| prv-0010 | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| prv-0012 | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| prv-0016 | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| prv-0019 | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| prv-0022 | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| prv-0027 | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| prv-0030 | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| prv-0034 | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| prv-0035 | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| prv-0036 | keynote-manual | K07 | WP-2.B | keynote intersection join reads line by line (assembleText) |
| prv-0002 | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| prv-0010 | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| prv-0012 | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| prv-0016 | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| prv-0019 | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| prv-0022 | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| prv-0027 | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| prv-0030 | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| prv-0034 | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| prv-0035 | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| prv-0036 | keynote-guided | K07 | WP-2.B | extractCellsFromGrid reads cells line by line (assembleText) |
| prv-0002 | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| prv-0010 | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| prv-0012 | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| prv-0016 | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| prv-0019 | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| prv-0022 | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| prv-0027 | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| prv-0030 | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| prv-0034 | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| prv-0035 | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| prv-0036 | notes-manual | K07 | WP-2.B | notes manual join reads line by line (assembleText) |
| prv-0034 | ocr-positions | K06 | WP-2.B | duplicate printed headers deduped (uniqueHeaders) |
| prv-0034 | merger | K06 | WP-2.B | merges ocr-positions, whose duplicate headers are now deduped |
