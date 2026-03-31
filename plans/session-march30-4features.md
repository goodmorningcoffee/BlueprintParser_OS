# Plan: 4 Features — LLM Context Wiring, YOLO Class Picker, CSI Spatial, Guided Parse

## Critical Review Notes
- Verified all imports/line numbers against actual code
- Confirmed `/api/table-parse/propose` endpoint exists (route.ts, 77 lines)
- Confirmed `guidedParse*` store fields exist (lines 325-328, 733-741)
- Confirmed `assembleContextWithConfig` returns `{ assembled: string, sectionMeta }` — must destructure
- Confirmed heuristic engine matches `yoloRequired` via bare class names against `d.name` (line 352) — NO model prefix needed, just fix the class name
- Confirmed `computeCsiSpatialMap` has optional trailing params — grid config can be appended without breaking callers

---

## A. LLM Context Admin Wiring (#10) — ~15 min

### Context
Admin tab fully built. Chat route still uses old `assembleContext()` ignoring admin config.

### Changes
**File: `src/app/api/ai/chat/route.ts`**
- Line 21: change import `assembleContext` → `assembleContextWithConfig` + import `type LlmSectionConfig`
- Lines 421-429: company config already fetched as `companyConfig`. After line 428, add:
  ```
  const sectionConfig = (companyConfig?.pipelineConfig as any)?.llm?.sectionConfig as LlmSectionConfig | undefined;
  ```
  Note: must widen `companyConfig` scope — currently declared inside the try block. Move declaration before try or capture in outer variable.
- Line 432: `assembleContext(sections, contextBudget)` → `assembleContextWithConfig(sections, contextBudget, sectionConfig).assembled`

### Gotcha
`companyConfig` is declared with `const` inside the try/catch (line 423). `sectionConfig` needs to be accessible at line 432 outside that block. Fix: declare `let sectionConfig` before the try block, assign inside.

### Verification
- Admin: disable "Raw OCR Text" → chat → OCR text absent
- Preview tool results should now match actual chat

---

## B. YOLO Class Picker (#6) — ~1 hr

### Context
Built-in rules say `"table"` but Medium model class is `"tables"`. Heuristic engine matches bare class names via `yoloByClass.get(cls)` (line 352). Fix: replace freeform text with dropdown populated from actual model classes.

### Key Insight — NO engine changes needed
The engine matches `rule.yoloRequired[i]` directly against `detection.name`. No model prefix format needed. Admin just picks the correct class name from a dropdown → stored as bare string → matches correctly. Simpler than my original plan.

### Changes
**File: `src/app/admin/tabs/HeuristicsTab.tsx`**
- For `yoloRequired` and `yoloBoosters` fields in rule editor (currently freeform text at ~lines 528-536):
  - Build flat list of all class names across all models (fetch via existing `/api/admin/models` call at lines 58-63)
  - Replace text input with multi-select chip picker showing all available classes
  - Group by model for clarity: "Medium: tables, door_single, ..." / "Primitives: horizontal_area, circle, ..."
  - Selected chips store bare class names: `["tables", "horizontal_area"]`
  - Reuse pageNaming chip pattern (lines 273-323): emerald toggle chips

**File: `src/lib/heuristic-engine.ts`** — NO CHANGES. Matching logic already correct for bare class names.

### Verification
- Admin: edit "Door Schedule" rule → see dropdown with actual model classes
- Select "tables" (from Medium) instead of old "table" → save
- Run YOLO + load → heuristic now fires for schedule pages

---

## C. CSI Spatial Grid Upgrade (#7) — ~1 hr

### Context
Hardcoded 3x3 grid. Thresholds at lines 91-94. `classifyZone()` at line 118.

### Changes
**File: `src/lib/csi-spatial.ts`**
- Add optional param to `computeCsiSpatialMap()`:
  ```
  gridConfig?: { rows: number; cols: number }
  ```
  Appended after last existing optional param (`dbAnnotations`). Existing callers unaffected.
- Replace module-level `COL_THRESHOLDS`/`ROW_THRESHOLDS` with dynamic calculation in `classifyZone()`:
  ```
  function classifyZone(cx: number, cy: number, nRows: number, nCols: number): string {
    if (cy > 0.85) return "title-block";
    if (cx > 0.75) return "right-margin";
    const col = Math.min(Math.floor(cx * nCols), nCols - 1);
    const row = Math.min(Math.floor(cy * nRows), nRows - 1);
    if (nRows === 3 && nCols === 3) return `${ROW_LABELS[row]}-${COL_LABELS[col]}`;
    return `r${row + 1}-c${col + 1}`;
  }
  ```
- Keep `ROW_LABELS`/`COL_LABELS` for 3x3 backwards compat
- `ZONE_DISPLAY` map: for non-3x3, generate display names dynamically

**File: `src/lib/csi-spatial-refresh.ts`**
- Pass grid config through. Client gets it from store (loaded with company config at project open).
- Add optional `gridConfig` param to `refreshPageCsiSpatialMap()`, pass to `computeCsiSpatialMap()`

**File: `src/lib/processing.ts`** (line ~232)
- Read `pipelineConfig.pipeline.csiSpatialGrid` from company config (already have `pipelineConfig`)
- Pass to `computeCsiSpatialMap()` call

**File: `src/app/admin/tabs/PipelineTab.tsx`**
- Add dropdown: "CSI Spatial Grid Resolution" — 3x3 / 6x6 / 9x9 / 12x12
- Saves to `pipelineConfig.pipeline.csiSpatialGrid`
- Helper: "Higher = more precise LLM spatial context. Requires reprocess."

**File: `src/lib/context-builder.ts`** — NO CHANGES. `buildCsiSpatialSection()` already iterates `map.zones` dynamically.

### Verification
- Set to 9x9 → reprocess → pageIntelligence shows finer zones (r1-c1 through r9-c9)
- LLM context preview shows coordinate-based zone names
- Default 3x3 still shows "top-left" etc.

---

## D. Guided Parse Universal Module (#3) — ~2 hrs

### Context
Guided parse locked in KeynotePanel with `columns: 2`. Core algorithm in `ocr-grid-detect.ts` has hardcoded `ROW_Y_TOL=0.006`, `MIN_COL_GAP=0.015`, `minHits=0.3`. Propose endpoint at `/api/table-parse/propose` (verified — 77 lines). Store fields `guidedParse*` exist (lines 325-328, 733-741).

### Algorithm: Parameterize Constants

**File: `src/lib/ocr-grid-detect.ts`**
- Add exported interface:
  ```
  export interface GridDetectOptions {
    rowTolerance?: number;    // default ROW_Y_TOL (0.006)
    minColGap?: number;       // default MIN_COL_GAP (0.015)
    minHitsRatio?: number;    // default 0.3
  }
  ```
- `detectRowsAndColumns(words, regionBbox, hint?, options?)`: new optional 4th param
- Pass options into `clusterRows(words, options?.rowTolerance ?? ROW_Y_TOL)` and `detectColumns(sorted, rowCount, options?.minColGap ?? MIN_COL_GAP, options?.minHitsRatio ?? 0.3)`
- Existing callers (3 total: propose/route.ts, table-parse/route.ts, KeynotePanel) continue to work — 4th param is optional

**File: `src/app/api/table-parse/propose/route.ts`**
- Accept optional `gridOptions` in body (line 19): `gridOptions?: GridDetectOptions`
- Pass to `detectRowsAndColumns(words, regionBbox, layoutHint, gridOptions)` at line 54

### New Component

**File: `src/components/viewer/GuidedParsePanel.tsx`** (NEW)
- Props:
  ```
  regionBbox: [number, number, number, number]  // MinMax
  layoutHint?: { columns?: number }
  onParsed: (grid: { headers: string[]; rows: Record<string,string>[] }) => void
  onCancel: () => void
  ```
- **Tuning sliders** (collapsible "Tune" section):
  - Row Sensitivity: range 0.002–0.02, default 0.006, step 0.001
  - Column Sensitivity: range 0.005–0.05, default 0.015, step 0.005
  - Column Confidence: range 0.1–0.8, default 0.3, step 0.05
  - Expected Columns: number 1–12, or "Auto" (null)
- **Auto-propose on mount** with defaults
- **Re-propose on slider change** (debounced 300ms)
- Writes `guidedParseRows`/`guidedParseCols` to store → canvas overlay renders grid
- **Repeat Down / Repeat Right** buttons (extract from KeynotePanel lines 414-435)
- **Parse button**: calls `extractCellsFromGrid()` client-side, returns via `onParsed`

### Wire Into Tables

**File: `src/components/viewer/AutoParseTab.tsx`** (or parent TableParsePanel)
- After user draws BB and clicks "Process", add option: "Guided Parse" alongside existing multi-method auto-parse
- Opens GuidedParsePanel inline with the region
- `onParsed` → saves to `pageIntelligence.parsedRegions` (existing pattern)

### Wire Into Keynotes

**File: `src/components/viewer/KeynotePanel.tsx`**
- Replace inline `proposeGrid()`, `parseFromGuidedGrid()`, `repeatRowDown()`, `repeatColumnRight()` (~200 lines) with `<GuidedParsePanel layoutHint={{ columns: 2 }} />`
- `onParsed` handler: existing logic that creates keynote entries from grid rows

### Store — NO CHANGES
Existing `guidedParse*` fields (lines 325-328, 733-741) are sufficient.

### Verification
- Tables: draw BB → "Guided Parse" → see proposed grid → adjust sliders → re-proposes → parse
- Keynotes: same flow with columns defaulting to 2
- Edge case: sparse table → increase Row Sensitivity slider → rows appear

---

## Build Order

1. **A. LLM Context Wiring** — 15 min, unblocks admin testing
2. **B. YOLO Class Picker** — 1 hr, fixes critical bug, no engine changes
3. **C. CSI Spatial Grid** — 1 hr, standalone
4. **D. Guided Parse** — 2 hrs, largest

Total: ~4-5 hours

## Files Summary

| Feature | File | Change |
|---------|------|--------|
| A | `src/app/api/ai/chat/route.ts` | Wire `assembleContextWithConfig` + sectionConfig |
| B | `src/app/admin/tabs/HeuristicsTab.tsx` | Class picker chips for yoloRequired/yoloBoosters |
| C | `src/lib/csi-spatial.ts` | Parameterize grid dimensions, dynamic zone naming |
| C | `src/lib/csi-spatial-refresh.ts` | Pass grid config through |
| C | `src/lib/processing.ts` | Read grid config, pass to spatial map |
| C | `src/app/admin/tabs/PipelineTab.tsx` | Grid resolution dropdown |
| D | `src/lib/ocr-grid-detect.ts` | `GridDetectOptions` param on `detectRowsAndColumns` |
| D | `src/app/api/table-parse/propose/route.ts` | Accept `gridOptions` in body |
| D | `src/components/viewer/GuidedParsePanel.tsx` | **NEW** — reusable guided parse + sliders |
| D | `src/components/viewer/AutoParseTab.tsx` | Add "Guided Parse" option |
| D | `src/components/viewer/KeynotePanel.tsx` | Replace inline logic with GuidedParsePanel |
