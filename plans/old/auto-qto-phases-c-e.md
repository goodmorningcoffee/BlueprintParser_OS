# Auto-QTO Phases C-E Implementation Plan

## Date: March 31, 2026
## Status: Ready for Implementation
## Depends on: auto-qto-spec.md (Phases A-B complete)

---

## Current State (60% complete)

Phases A-B built the workflow skeleton:
- Steps 1 (Pick Material), 3 (Configure Tags), 4 (Map Tags), 5 (Review) are functional
- DB table `qto_workflows` with full schema
- 5 CRUD API endpoints at /api/qto-workflows
- Batch tag mapping API at /api/projects/[id]/map-tags-batch
- Store state: activeQtoWorkflow, qtoWorkflows with setters and useQtoWorkflow() slice
- Tag engine: `mapYoloToOcrText()` in yolo-tag-engine.ts — OCR + optional YOLO proximity matching
- Demo mode support, workflow persistence + resume
- Basic inline CSV export from review step

**Missing:** Richer tag engine signals, instance-level editing, fullscreen spreadsheet, polish.

---

## Architecture Decisions

1. **Tag engine upgrade: server-side** — `findTagInstances()` lives alongside `mapYoloToOcrText()` in `yolo-tag-engine.ts`. Batch API gets `rich: true` flag. Old callers unaffected.

2. **Spreadsheet: new component** — `QtoSpreadsheetModal.tsx`, NOT extending TableCompareModal. Different data model (line items vs parsed cells). Copy cell editing patterns from TableCompareModal.

3. **Instance highlighting: store-driven** — New `qtoHighlightInstance` field in viewerStore. AnnotationOverlay draws highlight only when matching page. Zero impact on non-QTO rendering.

4. **Extract AutoQtoTab into `src/components/viewer/qto/`** — One file per step. Main file reduces to ~150 LOC of step routing. Review step alone will grow to ~400 LOC.

---

## Phase C: Tag Engine Upgrade

### C1. Types + findTagInstances()

**`src/types/index.ts`** — Add new types:
```typescript
interface TagInstanceResult {
  pageNumber: number;
  bbox: BboxMinMax;
  confidence: number;
  signals: {
    ocr: boolean;
    ocrConfidence: number;
    yolo: boolean;
    yoloClass?: string;
    yoloBbox?: BboxMinMax;
    yoloDistance?: number;
  };
}

interface UnmatchedYoloShape {
  pageNumber: number;
  bbox: BboxMinMax;
  className: string;
  modelName: string;
}

interface TagScanResult {
  tag: string;
  instances: TagInstanceResult[];
  unmatchedYolo: UnmatchedYoloShape[];
}
```

**`src/lib/yolo-tag-engine.ts`** — Add `findTagInstances()`:
- Multi-signal confidence scoring:
  - Base 0.5 (OCR text match)
  - +0.1 if Textract word confidence > 0.95
  - +0.1 if exact match (not fuzzy)
  - +0.3 * (1 - YOLO distance) if YOLO configured and nearby shape found
  - -0.1 if YOLO configured but no nearby shape
- Returns `TagScanResult` with signal breakdown + unmatched YOLO shapes
- Keep `mapYoloToOcrText()` as thin wrapper for backwards compatibility

### C2. API + Mapping Step

**`src/app/api/projects/[id]/map-tags-batch/route.ts`**:
- Add `rich: true` option in request body
- When rich=true, return `Record<string, TagScanResult>` instead of `Record<string, YoloTagInstance[]>`
- Also return aggregate `unmatchedYolo` shapes across all tags

**`src/components/viewer/AutoQtoTab.tsx`** (MappingStep):
- Use `rich: true` in batch request
- Populate `instances[]` with signal data
- Track `unmatchedYolo` count per line item

---

## Phase D: Review + CSV Editor

### D1. Extract AutoQtoTab into sub-components

Create `src/components/viewer/qto/` directory:
```
qto/AutoQtoTab.tsx          — step router (~150 LOC)
qto/QtoMaterialPicker.tsx   — Step 1 (material picker + workflow list)
qto/QtoScheduleSelector.tsx — Step 2 (select from parsed schedules)
qto/QtoConfigureStep.tsx    — Step 3 (tag column + YOLO filter + page selection)
qto/QtoMappingStep.tsx      — Step 4 (tag scanning progress)
qto/QtoReviewStep.tsx       — Step 5 (review table + instance navigation)
qto/QtoSpreadsheetModal.tsx — Step 6 (fullscreen CSV editor)
```

### D2. Instance Review + Canvas Highlighting

**`src/stores/viewerStore.ts`** — Add:
- `qtoHighlightInstance: { pageNumber: number; bbox: BboxMinMax; tag: string } | null`
- `qtoReviewingTag: string | null`
- `qtoReviewIndex: number` (current instance index)
- `setQtoHighlight(instance | null)`
- `nextQtoInstance()` / `prevQtoInstance()`

**`src/components/viewer/AnnotationOverlay.tsx`**:
- Read `qtoHighlightInstance` from store
- When set and `pageNumber` matches: draw cyan pulsing rectangle around the bbox
- Zero impact when null (no extra re-renders)

**`qto/QtoReviewStep.tsx`**:
- Click QTY number → enter instance review mode for that tag
- Show prev/next arrows to navigate instances across pages
- Auto-navigates to the instance's page and highlights it

### D3. Manual Add/Remove Instances

**`src/stores/viewerStore.ts`** — Add:
- `qtoPlacementMode: boolean`
- `qtoPlacementTag: string | null`

**`src/components/viewer/AnnotationOverlay.tsx`**:
- When `qtoPlacementMode` active: click → capture click position → add instance

**`qto/QtoReviewStep.tsx`**:
- "Add Instance" button per tag → activates placement mode → user clicks on canvas
- "Remove" button per instance → removes from instances, adds to `userEdits.removedInstances`
- Updates `userEdits.addedInstances` / `removedInstances`
- Recalculates auto vs manual quantity

### D4. Fullscreen Spreadsheet Modal

**New `qto/QtoSpreadsheetModal.tsx`**:

Columns: Tag | [all schedule columns] | QTY | Pages | CSI | Flags | Notes

Features:
- Cell editing: click to edit, Tab (next cell), Enter (commit + down), Escape (cancel)
- Copy cell editing patterns from TableCompareModal lines 253-292 (startEdit/commitEdit/moveCell/handleCellKeyDown)
- Row add/delete buttons
- QTY column: editable, shows warning if differs from auto-count
- Pages column: read-only (computed)
- CSI column: auto-detected from line item specs
- Notes column: free text
- Undo stack (Ctrl+Z): simple array of previous cell states
- "Save" button → PUT workflow to DB (no download)
- "Export CSV" button → download `{projectName}_{materialType}_takeoff.csv`

Mounted from QtoReviewStep "Open Spreadsheet" button. Same fullscreen modal pattern as TableCompareModal.

---

## Phase E: Polish

### E1. Unmatched YOLO Shapes + Better Flags

**`qto/QtoReviewStep.tsx`**:
- "Possible untagged instances" section showing `unmatchedYolo` shapes
- Click → navigate to page + highlight shape
- New flags: `"extra"` (found on drawings but not in schedule), `"qty-mismatch"` (schedule QTY column vs auto-count)

### E2. CSI Code Auto-Detection

After tag mapping completes:
- Run `detectCsiCodes()` on each line item's spec text (description, type columns)
- Populate `lineItem.csiCodes`
- Shows in review table + spreadsheet CSI column

### E3. Step 2 PageSidebar Integration + Keyboard Shortcuts

**`src/components/viewer/PageSidebar.tsx`**:
- When `activeQtoWorkflow?.step === "select-schedule"`, highlight pages with matching classifiedTables category
- Dim non-matching pages

**`qto/QtoSpreadsheetModal.tsx`**:
- Tab (next cell), Shift+Tab (prev cell)
- Enter (commit + down), Escape (cancel edit)
- Ctrl+Z (undo)
- Delete (clear cell)

---

## Files Summary

### New Files
```
src/components/viewer/qto/AutoQtoTab.tsx          — step router
src/components/viewer/qto/QtoMaterialPicker.tsx    — Step 1
src/components/viewer/qto/QtoScheduleSelector.tsx  — Step 2
src/components/viewer/qto/QtoConfigureStep.tsx     — Step 3
src/components/viewer/qto/QtoMappingStep.tsx       — Step 4
src/components/viewer/qto/QtoReviewStep.tsx        — Step 5
src/components/viewer/qto/QtoSpreadsheetModal.tsx  — Step 6
```

### Modified Files
```
src/types/index.ts                                 — TagInstanceResult, UnmatchedYoloShape, TagScanResult
src/lib/yolo-tag-engine.ts                         — findTagInstances()
src/app/api/projects/[id]/map-tags-batch/route.ts  — rich return option
src/stores/viewerStore.ts                          — qtoHighlight, qtoPlacement, qtoReview state
src/components/viewer/AnnotationOverlay.tsx         — QTO highlighting + placement click handling
src/components/viewer/TakeoffPanel.tsx              — import from qto/ directory
src/components/viewer/PageSidebar.tsx               — schedule-type filter for Step 2
```

---

## Verification

1. **End-to-end**: Pick "Doors" → find door schedule → parse → confirm tag column → map tags → verify instances on canvas → edit in spreadsheet → export CSV
2. **Demo mode**: Session-only workflows, no API persistence
3. **OCR-only**: Works without YOLO data (no models loaded)
4. **YOLO-boosted**: With YOLO data, confidence scores are higher, unmatched shapes shown
5. **Resume**: Create workflow → refresh page → resume from last step
6. **Instance editing**: Add/remove instances → quantities update → reflected in spreadsheet
