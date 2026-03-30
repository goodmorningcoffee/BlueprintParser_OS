# BlueprintParser Refactoring Log — March 29, 2026

## Overview

This session completed the full 4-phase architecture refactoring described in `REFACTORING_RESEARCH.md`. The codebase went from a monolithic 238-field Zustand store with 5 components over 1000 lines and zero tests to a well-decomposed architecture with 12 slice selectors, 20+ focused component files, 60 unit tests, and standardized API auth patterns.

---

## Phase 3B: Slice Selector Migration (Medium-Difficulty Components)

### New Slice Selectors Created (3)

**`useDetection()`** — YOLO detection model state + annotation list + filters
- Fields: annotations, activeModels, setModelActive, confidenceThreshold, setConfidenceThreshold, activeAnnotationFilter, setAnnotationFilter, searchQuery, setSearch, hiddenAnnotationIds, toggleAnnotationVisibility
- Used by: DetectionPanel, AnnotationOverlay, ViewerToolbar, PageSidebar, TextPanel (MarkupsTab)

**`useYoloTags()`** — YOLO tag CRUD + visibility state
- Fields: yoloTags, activeYoloTagId, setActiveYoloTagId, yoloTagVisibility, setYoloTagVisibility, setYoloTagFilter, removeYoloTag, updateYoloTag, yoloTagPickingMode, setYoloTagPickingMode
- Used by: DetectionPanel, AnnotationOverlay, PageSidebar

**`useTextAnnotationDisplay()`** — Text annotation visibility + styling controls
- Fields: showTextAnnotations, toggleTextAnnotations, activeTextAnnotationTypes, setTextAnnotationType, setAllTextAnnotationTypes, hiddenTextAnnotations, toggleTextAnnotationVisibility, textAnnotationColors, setTextAnnotationColor, activeTextAnnotationFilter, setTextAnnotationFilter
- Used by: TextPanel (AnnotationsTab), TextAnnotationOverlay

### Existing Selectors Augmented (3)

- **`useProject()`** — added `projectIntelligenceData`
- **`usePageData()`** — added `allCsiCodes`, `activeCsiFilter`, `setCsiFilter`
- **`usePanels()`** — added `textPanelTab`, `setTextPanelTab`

### Components Migrated

| Component | Raw calls before | After | Notes |
|-----------|-----------------|-------|-------|
| CsiPanel.tsx | 10 | **0** | Fully migrated |
| DetectionPanel.tsx | 25 | **2** | 2 intentional getState() in event handlers |
| TextPanel.tsx | 29 | **1** | 1 orphan field (activeMarkupId) |

**Total: 64 raw `useViewerStore` calls eliminated.**

---

## Bug Fix: Table Auto-Parse Region Filtering

**Problem:** User draws BB around 6 rows of a schedule, auto-parse returns 26 rows.

**Root cause:** Method 2 (Textract Tables) in `/api/table-parse/route.ts` found a matching Textract pre-parsed table overlapping ≥30% with the user's region, then dumped ALL rows of that entire Textract table without filtering cells to the drawn region.

**Fix:** Added spatial filtering of Textract cells before building the grid. Each cell's center point (top + height/2, left + width/2) is checked against the region bounds. Surviving rows are re-indexed sequentially.

**File:** `src/app/api/table-parse/route.ts` — `methodTextractTables()` function

---

## Phase 2B: TableParsePanel Decomposition (1600 → 336 lines)

The largest component was decomposed into 7 files:

| File | Lines | Purpose |
|------|-------|---------|
| `TableParsePanel.tsx` | 336 | Orchestrator: tab bar, shared state/memos, All Tables tab inline |
| `ParsedTableItem.tsx` | 484 | Expandable table item: settings panel (color/opacity/CSI/notes), column editing, Map Tags modal, inline row editing |
| `AutoParseTab.tsx` | 238 | Auto Parse tab: draw region → API multi-method parse → review with method breakdown |
| `ManualParseTab.tsx` | 291 | Manual Parse tab: 4-step workflow (region → columns → rows → intersection parse) |
| `CompareEditTab.tsx` | 92 | Compare/Edit tab: table list grouped by current page vs other pages, opens TableCompareModal |
| `MapTagsSection.tsx` | 77 | Shared Map Tags UI: YOLO class picker, free-floating toggle, "Map Tags" button (deduplicated from Auto + Manual tabs) |
| `table-parse-utils.ts` | 26 | CSV export utilities: escCsv(), exportTableCsv() |

### Design Decisions
- **All Tables tab stays inline** in parent (only ~30 lines of JSX)
- **Shared callbacks** (detectCsiAndPersist, handleMapTags, saveParsedToIntelligence) stay in parent, passed as props
- **Tab components use slice selectors directly** for store state (useTableParse, useNavigation, etc.)
- **Parent memos** (allParsedTables, autoDetectedTables, existingParsed, yoloInTableRegion) stay in parent, passed as props
- **ParsedTableItem render-path bug fixed**: line 1555 used `getState().activeYoloTagId` during render (stale data) → converted to reactive selector

---

## Phase 2C: TakeoffPanel Decomposition (1315 → 98 lines)

| File | Lines | Purpose |
|------|-------|---------|
| `TakeoffPanel.tsx` | 98 | Orchestrator: tab bar, CSV export, "Stop Takeoff" button |
| `CountTab.tsx` | 256 | Count items: CRUD, shape/color picker, marker counts, page filter, edit panel |
| `AreaTab.tsx` | 274 | Area items: polygon area calculation, ScaleStatus bar, unit display |
| `CalibrationInput.tsx` | 139 | Scale calibration distance input — **independent/reusable by future tools** |
| `TakeoffShared.tsx` | 156 | TakeoffEditPanel (name/color/shape/size/notes), SHAPE_ICONS, ColorDot |

### Key Decision
- **CalibrationInput extracted as independent component** per user request — future measurement/drawing tools will need scale calibration

---

## Phase 2D: KeynotePanel Decomposition (1000 → 808 lines)

| File | Lines | Purpose |
|------|-------|---------|
| `KeynotePanel.tsx` | 808 | Orchestrator + 3 tabs inline (All Keynotes, Guided Parse, Manual Parse) |
| `KeynoteItem.tsx` | 172 | Collapsible keynote item: rename, per-key editing (CSI/notes), tag highlighting, YOLO tag click |

### Why Tabs Stayed Inline
The tab JSX is small (30-160 lines each). The bulk of KeynotePanel is shared callbacks (parseKeynotes, autoParseKeynote, proposeGrid, parseFromGuidedGrid) that both Guided and Manual tabs use. Extracting tabs would require heavy prop-threading with minimal gain.

---

## Phase 3C: Junction Component Slice Selector Migration

### PageSidebar.tsx
- **Before:** `useViewerStore()` bulk destructure subscribing to ALL 238 fields
- **After:** 8 slice selectors (`useNavigation`, `useProject`, `usePageData`, `useDetection`, `useTextAnnotationDisplay`, `useYoloTags`, `useSymbolSearch`) + 10 individual selectors for uncovered filter fields
- **Performance win:** No longer re-renders on every store change

### ViewerToolbar.tsx
- **Before:** `useViewerStore()` bulk destructure (48 fields)
- **After:** 6 slice selectors (`useNavigation`, `useProject`, `usePanels`, `usePageData`, `useDetection`, `useSymbolSearch`) + 14 individual selectors for uncovered fields (zoom, search loading, trade filter, detection toggles, etc.)

### AnnotationOverlay.tsx
- **Before:** 93 individual `useViewerStore((s) => s.field)` calls
- **After:** 66 calls — 7 slice selectors replacing 27 individual calls for navigation, project, table parse, keynote parse, YOLO tags, and symbol search fields
- **Remaining 66** are a mix of 1 import + ~35 individual selectors for fields not in any slice (drawing state setters, calibration, polygon, annotations CRUD) + ~30 getState() calls in event handlers (correct pattern)

---

## Bug Fixes: YOLO Visibility

### Bug 1: Tag Visibility Mismatch
- **DetectionPanel** checked `yoloTagVisibility[tag.id] !== false` (default visible)
- **AnnotationOverlay** checked `yoloTagVisibility[tag.id] !== true` (default hidden)
- Tags appeared visible in the panel but weren't rendered on canvas
- **Fix:** AnnotationOverlay now uses `=== false` (visible by default, matching panel)

### Bug 2: No Individual Annotation Visibility (New Feature)
- Added `hiddenAnnotationIds: Set<number>` + `toggleAnnotationVisibility(id)` to store
- Added to `useDetection()` slice selector
- AnnotationOverlay filters out hidden IDs in pageAnnotations memo
- AnnotationListItem gets `isHidden` + `onToggleVisibility` props — eye icon on hover

### Feature: Toggle All Models
- Added "Show All / Hide All" button next to detection count in DetectionPanel Models tab

---

## Phase 4B: API Route Auth Standardization

### Before
39 routes repeated a 3-4 line inline auth pattern:
```typescript
const session = await auth();
if (!session?.user || session.user.role !== "admin") {
  return NextResponse.json({ error: "Admin only" }, { status: 403 });
}
```

### After
34 routes use `requireAdmin()` or `requireAuth()`:
```typescript
const { session, error } = await requireAdmin();
if (error) return error;
```

### Migration Details
- **52 auth blocks replaced** across 34 route files
- **18 admin routes** → `requireAdmin()` (31 handler blocks)
- **16 user routes** → `requireAuth()` (21 handler blocks)
- **4 routes kept raw** `auth()` — intentional demo-bypass pattern (table-parse, yolo/load, labeling/credentials, ai/chat)
- **14 routes skipped** — public/demo endpoints (no auth needed)

---

## Test Infrastructure

### Setup
- **Vitest** installed with TypeScript + path alias support
- `vitest.config.ts` at project root
- `npm test` / `npm run test:watch` scripts
- Tests run in <500ms

### Test Coverage (60 tests)

**`src/lib/__tests__/bbox-utils.test.ts`** (35 tests)
- ltwh2minmax / minmax2ltwh format conversion (with floating-point handling)
- bboxCenterLTWH / bboxCenterMinMax (cross-format consistency)
- bboxContainsPoint (inside, edge, outside)
- bboxOverlap (non-overlapping, partial, full containment, adjacent)
- bboxIoU (non-overlapping, identical, partial)
- bboxAreaMinMax / bboxAreaLTWH (standard, zero-size)
- validateBbox (valid, non-array, wrong length, NaN, Infinity, out-of-range, min≥max, zero-dimension)
- isValidMinMax / isValidLTWH type guards

**`src/lib/__tests__/table-parse-utils.test.ts`** (6 tests)
- escCsv: plain text, commas, quotes, newlines, empty, all special chars

**`src/stores/__tests__/viewerStore.test.ts`** (19 tests)
- Navigation: default page, setPage with clamping, setScale, setMode
- Panels: toggle flips state
- Annotations: empty default, addAnnotation, removeAnnotation by id
- Detection visibility: hiddenAnnotationIds toggle
- Table parse: setStep, resetTableParse clears state
- YOLO tags: empty default, add, remove, visibility toggle
- resetProjectData: clears all project state

---

## Final File Inventory

### New Files Created This Session
```
src/components/viewer/ParsedTableItem.tsx      (484 lines)
src/components/viewer/AutoParseTab.tsx         (238 lines)
src/components/viewer/ManualParseTab.tsx       (291 lines)
src/components/viewer/CompareEditTab.tsx       (92 lines)
src/components/viewer/MapTagsSection.tsx       (77 lines)
src/components/viewer/CountTab.tsx             (256 lines)
src/components/viewer/AreaTab.tsx              (274 lines)
src/components/viewer/CalibrationInput.tsx     (139 lines)
src/components/viewer/TakeoffShared.tsx        (156 lines)
src/components/viewer/KeynoteItem.tsx          (172 lines)
src/lib/table-parse-utils.ts                  (26 lines)
src/lib/__tests__/bbox-utils.test.ts           (167 lines)
src/lib/__tests__/table-parse-utils.test.ts    (33 lines)
src/stores/__tests__/viewerStore.test.ts       (150 lines)
vitest.config.ts                               (14 lines)
```

### Files Significantly Modified
```
src/stores/viewerStore.ts          — 3 new selectors, 3 augmented, hiddenAnnotationIds state
src/components/viewer/TableParsePanel.tsx    — 1600 → 336 lines
src/components/viewer/TakeoffPanel.tsx       — 1315 → 98 lines
src/components/viewer/KeynotePanel.tsx       — 1000 → 808 lines
src/components/viewer/DetectionPanel.tsx     — slice selectors + visibility toggle
src/components/viewer/TextPanel.tsx          — slice selectors
src/components/viewer/CsiPanel.tsx           — slice selectors
src/components/viewer/PageSidebar.tsx        — bulk destructure → slice selectors
src/components/viewer/ViewerToolbar.tsx      — bulk destructure → slice selectors
src/components/viewer/AnnotationOverlay.tsx  — slice selectors + hiddenAnnotationIds filter
src/components/viewer/AnnotationListItem.tsx — eye toggle for individual visibility
src/app/api/table-parse/route.ts             — Method 2 region filtering fix
34 API route files                           — requireAuth/requireAdmin migration
package.json                                 — vitest deps + test scripts
```

---

## Design Principles Established

1. **Slice selectors over raw store access** — `useNavigation()` not `useViewerStore((s) => s.pageNumber)`
2. **getState() for event handlers** — write-only actions in callbacks don't need reactive subscriptions
3. **Props for computed values, selectors for store state** — parent memos passed as props, store fields accessed via selectors in child
4. **Leaf-first extraction** — extract nested components before tab bodies before restructuring parent
5. **No premature abstraction** — shared callbacks stay in parent until 3+ consumers need them
6. **Test critical paths first** — bbox math and store mutations before UI components
7. **Demo bypass stays raw** — routes with optional auth for demo projects keep `auth()` directly
8. **Drizzle migrations need journal entries** — SQL files alone are not enough; `drizzle/meta/_journal.json` must have a matching entry or the migration won't run
9. **NEVER npm install in devcontainer** — Node 24/npm 11 generates lock files incompatible with Docker's Node 20/npm 10

---

## Post-Refactoring Work (Late March 29 - March 30)

### Auto-QTO Phase A — Foundation Deployed

New feature: guided material-specific QTO workflow tab in TakeoffPanel.

**Files created:**
- `src/lib/db/schema.ts` — `qtoWorkflows` table added
- `drizzle/0015_add_qto_workflows.sql` + `drizzle/meta/_journal.json` entry
- `src/types/index.ts` — `QtoWorkflow`, `QtoLineItem`, `QtoParsedSchedule`, `QtoUserEdits`, `QtoFlag`, `QtoWorkflowStep` types; `TakeoffTab` extended with `"auto-qto"`
- `src/stores/viewerStore.ts` — `activeQtoWorkflow`, `qtoWorkflows` state + `useQtoWorkflow()` slice (13th selector)
- `src/app/api/qto-workflows/route.ts` — GET list + POST create
- `src/app/api/qto-workflows/[id]/route.ts` — GET + PUT + DELETE
- `src/components/viewer/AutoQtoTab.tsx` — material picker (Doors, Finishes, Equipment, Plumbing, Electrical, Custom) + Step 2 schedule selection (reads parsedRegions, links to Table/Keynote parse panels)
- `src/components/viewer/TakeoffPanel.tsx` — 3rd tab button "Auto-QTO"

Full spec: `plans/auto-qto-spec.md` (workflow state machine, data model, multi-signal tag engine, implementation phases A-E)

### Export CSV Modal

- `src/components/viewer/ExportCsvModal.tsx` — shared popup: select one or multiple tables → export as CSV
- `src/lib/table-parse-utils.ts` — added `exportMultiTableCsv()` for multi-table CSV (each table separated by header row)
- Wired into TableParsePanel All Tables tab + KeynotePanel All Keynotes tab

### UI Polish

- `src/app/globals.css` — dark theme brightened (bg, fg, muted, border, accent, surface all adjusted +10-15% contrast)
- `src/components/viewer/ViewerToolbar.tsx` — all panel toggle buttons changed from translucent red inactive to readable muted grey with white hover
- `src/components/viewer/AutoParseTab.tsx` — added table name input field + "Compare/Edit Cells" button (replaces "View All Tables")

### Bug Fixes

- `src/app/api/table-parse/route.ts` — Method 2 Textract region filtering (was returning all rows)
- `src/components/viewer/AnnotationOverlay.tsx` — YOLO tag visibility default mismatch fixed
- `src/components/viewer/AnnotationOverlay.tsx` — `hiddenAnnotationIds` filter for individual annotation visibility
- `src/components/viewer/DetectionPanel.tsx` — "Show All / Hide All" models button + per-annotation eye toggle
- `src/components/viewer/AnnotationListItem.tsx` — `isHidden`/`onToggleVisibility` props + eye icon
- `src/app/api/projects/[id]/route.ts` — added `labelingSessions` FK cleanup in DELETE (was causing project delete failure)
- `src/middleware.ts` — YOLO rate limit 5→9999/hour
- `Dockerfile` — `npm ci` → `npm install --ignore-scripts` (npm version mismatch workaround)
- `drizzle/meta/_journal.json` — added missing entry for migration 0015 (was causing crash-loop 504)
