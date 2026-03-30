# Auto-QTO Feature Specification

## Version: 1.0 (March 29, 2026)
## Status: Design Complete — Ready for Implementation

---

## 1. Executive Summary

Auto-QTO is a guided, material-specific Quantity Takeoff workflow for BlueprintParser. It walks the estimator through a standardized process: identify a schedule on the drawings → parse it → map tag identifiers to drawing instances across all pages → review counts and locations → edit and export a CSV takeoff report.

**Key principles:**
- **User-initiated, not automatic** — the estimator drives each step, the system assists
- **Multi-signal detection** — OCR text matching (always) + YOLO shape proximity (when available)
- **One workflow at a time** — finish doors, export, start finishes
- **Database persistence** — workflows survive page refresh
- **Reuses existing infrastructure** — table parsing, tag engine, page classification, YOLO detection

**What makes an estimator say "wow":**
- "I picked Doors, it found the door schedule page instantly, I parsed it, and in 5 seconds it found every door tag across 40 pages with counts and locations"
- "It caught that tag D-14 is in the schedule but doesn't appear on any drawing"
- "The CSV export has all the hardware specs from the schedule already filled in — I just add quantities"

---

## 2. Estimator's Current Manual Workflow (What We're Replacing)

1. Open door schedule on sheet A-601 → see 23 door types with specs (size, frame, hardware, rating)
2. Flip through 40+ architectural pages looking for door tags (A, B, C-1, D-01, etc.)
3. For each tag found, tally: "Type A = 14, Type B = 8, Type C-1 = 3..."
4. Cross-reference specs from schedule: "Type A = 3070, HM frame, solid core, hardware set #2"
5. Enter into estimating software: tag + specs + quantity + page locations
6. Repeat for finish schedule, equipment schedule, plumbing fixtures, electrical panels...

**Time:** 2-4 hours per schedule for a 40-page set. An estimator might have 5-10 schedules per project.

**With Auto-QTO:** Same result in 5-10 minutes per schedule, with higher accuracy (system doesn't miss pages).

---

## 3. Workflow State Machine

```
┌─────────────┐     ┌──────────────────┐     ┌────────────────┐
│  Step 1:     │     │  Step 2:         │     │  Step 3:       │
│  Pick        │────▶│  Find Schedule   │────▶│  Parse         │
│  Material    │     │  Page            │     │  Schedule      │
└─────────────┘     └──────────────────┘     └────────┬───────┘
                                                       │
                                                       ▼
┌─────────────┐     ┌──────────────────┐     ┌────────────────┐
│  Step 6:     │     │  Step 5:         │     │  Step 4:       │
│  CSV Editor  │◀────│  Review          │◀────│  Map Tags to   │
│  + Export    │     │  Counts          │     │  Drawings      │
└─────────────┘     └──────────────────┘     └────────────────┘
```

Each step is a distinct UI state in the Auto-QTO tab. User can go back to previous steps to adjust. Workflow state persists to DB at each step transition.

---

## 4. Detailed Step Descriptions

### Step 1: Pick Material Type

**UI:** Auto-QTO tab in TakeoffPanel shows a list of material categories.

**Built-in categories:**
- Doors (heuristic: `door-schedule`)
- Finishes (heuristic: `finish-schedule`)
- Equipment (heuristic: `material-schedule`)
- Plumbing Fixtures
- Electrical Panels
- **Custom** (user names it, picks schedule type manually)

**Each category shows:**
- Material name
- Heuristic badge if schedule auto-detected: "Door schedule found on p.12 (87%)"
- Badge count if previously completed: "✓ 23 items exported"

**Optional configuration (expandable section):**

```
Material Name: [Hex Tile]
Schedule Type: [finish-schedule ▾]

YOLO Shape Filter (optional):
  Model: [interior-finishes-v2 ▾]
  Class: [hexagon ▾]

Tag Pattern hint (optional): [T-##]
```

The YOLO class filter is NOT required. When provided, it acts as a confidence booster — OCR always runs regardless.

**On "Start Workflow →":**
- Create DB row in `qtoWorkflows` table
- Set workflow step to `"find-schedule"`
- If heuristic already detected a matching schedule page, pre-populate `schedulePageNumber`

### Step 2: Find Schedule Page

**UI:** The Auto-QTO tab shows:
- "Navigate to the page with the [Door] schedule"
- List of suggested pages from heuristics (classifiedTables matching the category)
- Each suggestion: page name, confidence score, click to navigate
- "I'm on the right page" button to confirm

**PageSidebar integration:**
- When this step is active, PageSidebar applies a schedule-type filter
- Pages with matching `classifiedTables` category get highlighted badges
- Other pages are dimmed but still accessible (in case heuristic missed)

**Heuristic detection (already exists in table-classifier.ts):**

```typescript
// Existing classification patterns
{
  category: "door-schedule",
  keywords: ["DOOR"],              // REQUIRED in region text
  keywordsAny: ["SCHEDULE"],       // At least one must match
  requiredRegionType: "table-like",
  csiDivisionAffinity: ["08"],     // Boost if CSI Division 08 codes present
}

{
  category: "finish-schedule",
  keywords: ["FINISH"],
  keywordsAny: ["SCHEDULE"],
  requiredRegionType: "table-like",
  csiDivisionAffinity: ["09"],
}
```

These run during processing. The Auto-QTO step just reads `pageIntelligence[pageNum].classifiedTables` and filters by category.

**On "I'm on the right page":**
- Save `schedulePageNumber` to workflow
- If heuristic found a table region bbox, pre-fill it for Step 3
- Transition to `"parse"` step

### Step 3: Parse Schedule + Define Tag Column

**UI:** Reuses the existing table parsing flow (AutoParseTab pattern) but embedded in the QTO workflow context.

**Sub-steps:**
1. If pre-detected region exists: show "Auto-detected region — parse now or draw your own"
2. User draws BB around schedule grid (excluding title text — per existing "no header assumption")
3. System runs multi-method parse (OCR positions + Textract tables + OpenCV lines)
4. Shows parsed grid: headers + rows
5. User confirms/edits:
   - Cell editing for OCR errors (reuse existing CompareEdit pattern)
   - Column renaming
6. **User explicitly marks the Tag Column** — clicks a column header → it gets the "Tag" designation
   - Auto-suggested based on heuristic (regex match + header keywords)
   - But user confirms or overrides — this is a first-class action, not buried

**The Tag Column is a signal word for the entire system:**
- When a column is marked as "Tag", it tells every downstream tool: "these values are identifiers that appear on the drawings"
- The tag engine scans for these values across all pages (OCR-first, always)
- YOLO-tag engine links shapes to these values (boost, when available)
- Auto-QTO counts these values for the takeoff report
- The tag column is OCR-searchable regardless of YOLO — works on day one for any project

**Tag Column Tool (alternative to full parse):**
Instead of parsing the entire table, user can draw a BB over just the tag column:
1. Draw BB over the tag column (e.g., "MARK" or "NO." column)
2. System Y-clusters OCR words → extracts one tag per row
3. User reviews tags inline, fixes OCR errors
4. If YOLO shapes detected in/near the column → YOLO-tag engine links them
5. Tags become the canonical list — ready for cross-page scanning

This is faster when the user only needs counts, not full spec data. If they also parsed the full table, the spec columns (hardware, size, frame) merge with the tag counts to produce the complete takeoff.

**Tag column detection heuristic:**
```typescript
const RE_TAG = /^[A-Z]{0,3}-?\d{1,4}[A-Z]?$/i;
// Score each column: what % of values match the tag regex?
// Column with highest ratio (≥50%) is suggested as tag column
// Also check column headers: "TAG", "MARK", "NO", "NO.", "NUMBER", "ITEM", "TYPE"
```

**On "Confirm Schedule":**
- Save `parsedSchedule` to workflow: `{ headers, rows, tagColumn, tableName }`
- Also save to `pageIntelligence.parsedRegions` (existing pattern — makes it visible in All Tables tab)
- Transition to `"map-tags"` step

### Step 4: Map Tags to Drawings

**UI:** Shows progress as the system scans all pages for each tag.

**Process:**
```
For each unique tag value in parsedSchedule.rows[tagColumn]:
  1. Call findTagInstances({
       tagText: tag,
       yoloClass: workflow.yoloClassFilter || undefined,
       yoloModel: workflow.yoloModelFilter || undefined,
       scope: "project",
       annotations: allAnnotations,
       textractData: allTextractData,
     })
  2. Store results as QtoLineItem:
     - tag, description (from schedule), all spec columns
     - instances: [{pageNumber, bbox, confidence, signals}]
     - autoQuantity: instances.length
     - flags: detect discrepancies
```

**YOLO class picker (same as existing MapTagsSection):**
- Shows YOLO classes detected in the project
- User can optionally select one to boost matching confidence
- "No shape — OCR only" option always available

**Progress UI:**
- "Scanning 40 pages... Tag A (14 found), Tag B (8 found)..."
- Progress bar or spinner
- Can be done in a single pass if batched (scan all pages once, check all tags per page)

**On completion:**
- Save `lineItems[]` to workflow
- Transition to `"review"` step

### Step 5: Review Counts

**UI:** Table view in the Auto-QTO tab showing all line items.

**Columns:**
| Tag | Description | QTY | Pages | Confidence | Flags |
|-----|-------------|-----|-------|------------|-------|
| A   | Solid Core, HM Frame, 3070 | 14 | 101,102,103,201... | 92% | |
| B   | Glass, Alum Frame, 3070 | 8 | 101,104,201 | 88% | |
| D-2 | Rated, HM Frame, 4070 | 0 | — | — | ⚠️ Not found |
| X   | — | 2 | 301 | 45% | ⚠️ Not in schedule |

**Interactions:**
- **Click QTY number** → enters "instance review" mode: navigates through each instance on the canvas, highlighting the tag + nearby YOLO shape
- **Click a flag** → jumps to the relevant page for manual inspection
- **"Add Instance" button** → user clicks on canvas to manually add a missed instance (small crosshair mode, similar to takeoff count marker placement)
- **"Remove" on an instance** → marks it as false positive, decrements count
- **Manual quantity override** → user can type a number to override the auto-count

**Flag logic:**
```typescript
// In schedule but 0 found on drawings
if (lineItem.instances.length === 0) flags.push("not-found");

// Found on drawings but tag not in any schedule row
// (detected during scan — OCR text matches tag pattern but isn't in parsed schedule)
if (!scheduleHasTag(tag)) flags.push("extra");

// Low average confidence across instances
if (avgConfidence < 0.5) flags.push("low-confidence");

// Schedule has a QTY column and it doesn't match our count
if (scheduleQty && scheduleQty !== instances.length) flags.push("qty-mismatch");
```

**On "Proceed to CSV":**
- Transition to `"done"` step
- Open the CSV editor view

### Step 6: CSV Editor + Export

**UI:** Full-screen modal (same pattern as TableCompareModal) showing an editable spreadsheet.

**Why modal instead of bottom panel:**
- Zero performance cost when viewing the canvas (modal is unmounted)
- Full screen real estate for the spreadsheet
- No layout reflows or scroll context conflicts with the canvas
- Existing pattern (TableCompareModal) already proven
- Estimator workflow is sequential: verify on canvas → edit spreadsheet → export

**Spreadsheet columns:**
All schedule columns (from parsed headers) + auto-generated columns:

| Tag | Type | Size | Frame | Hardware | ... | QTY | Pages | CSI | Notes |
|-----|------|------|-------|----------|-----|-----|-------|-----|-------|
| A | Solid Core | 3070 | HM | Set #2 | ... | 14 | 101,102... | 08 11 16 | |
| B | Glass | 3070 | AL | Set #5 | ... | 8 | 101,104... | 08 11 13 | |

- Schedule columns auto-populated from parsed data
- QTY from auto-count (editable — user can override)
- Pages from instance locations
- CSI from auto-detection
- Notes column for estimator's annotations

**Interactions:**
- Click any cell to edit
- Tab/Enter to navigate cells
- Add row (for items not in schedule)
- Delete row (remove a line item)
- Undo (Ctrl+Z)
- **Export CSV** → downloads file named `{projectName}_{materialType}_takeoff.csv`
- **Save** → persists to DB without exporting

**Cell types:**
- Text (default)
- Number (QTY column — shows warning if differs from auto-count)
- Read-only (Pages — computed, not editable)

---

## 5. Multi-Signal Tag Engine

### Current State: `mapYoloToOcrText` in `yolo-tag-engine.ts`

The existing function already does OCR + optional YOLO proximity matching. But it:
- Doesn't separate signal sources in the return value
- Doesn't return confidence breakdowns
- Doesn't report unmatched YOLO shapes
- Has a YOLO-specific name despite working without YOLO

### Proposed: `findTagInstances` in `tag-engine.ts`

**Rename and enhance the existing engine:**

```typescript
// src/lib/tag-engine.ts (renamed from yolo-tag-engine.ts)

interface TagSearchParams {
  tagText: string;
  yoloClass?: string;           // optional YOLO shape filter
  yoloModel?: string;           // optional model filter
  scope: "page" | "project";
  pageNumber?: number;          // required if scope === "page"
  annotations: ClientAnnotation[];
  textractData: Record<number, TextractPageData>;
  fuzzyMatch?: boolean;         // T-01 matches T-1, T01 (future)
}

interface TagInstance {
  pageNumber: number;
  bbox: BboxMinMax;             // location of the OCR text match
  confidence: number;           // 0-1 combined confidence
  signals: {
    ocr: boolean;               // found via OCR text match
    ocrConfidence: number;      // word-level OCR confidence from Textract
    yolo: boolean;              // YOLO shape found nearby
    yoloClass?: string;         // which class matched
    yoloBbox?: BboxMinMax;      // the YOLO shape's bbox
    yoloDistance?: number;       // normalized distance between tag text and shape
  };
}

interface TagSearchResult {
  tag: string;
  instances: TagInstance[];
  unmatchedYolo: {              // YOLO shapes with no nearby tag text
    pageNumber: number;
    bbox: BboxMinMax;
    className: string;
    modelName: string;
  }[];
}

function findTagInstances(params: TagSearchParams): TagSearchResult;
```

### Confidence Scoring Algorithm

```
For each OCR word match of tagText on a page:

  baseConfidence = 0.5  (OCR text match alone)

  // Signal 1: OCR quality
  if (wordConfidence > 0.95) baseConfidence += 0.1   // Textract is very sure
  if (exactMatch) baseConfidence += 0.1               // not partial/fuzzy

  // Signal 2: YOLO proximity
  if (yoloClass configured):
    nearbyShapes = find YOLO annotations of matching class within proximity
    if (nearbyShapes.length > 0):
      closest = shape with smallest distance to OCR word
      baseConfidence += 0.3 * (1 - closest.distance)  // closer = more confident
      signals.yolo = true
      signals.yoloBbox = closest.bbox
    else:
      baseConfidence -= 0.1  // expected YOLO shape but didn't find one

  // Signal 3: Context (future)
  // Is the tag near other tags from the same schedule? (spatial clustering)
  // Is the tag in a title block or revision area? (likely false positive)

  finalConfidence = clamp(baseConfidence, 0, 1)
```

### Unmatched YOLO Shapes

After processing all tags, check for YOLO shapes of the configured class that have NO nearby tag match:

```typescript
const matchedYoloBboxes = new Set(allInstances.flatMap(i =>
  i.signals.yoloBbox ? [bboxKey(i.signals.yoloBbox)] : []
));

const unmatchedYolo = yoloAnnotations
  .filter(a => a.name === yoloClass && !matchedYoloBboxes.has(bboxKey(a.bbox)))
  .map(a => ({ pageNumber: a.pageNumber, bbox: a.bbox, className: a.name, modelName: a.data?.modelName }));
```

These represent potential instances where:
- The drawing has the shape but the tag label is missing or illegible
- The YOLO detection is a false positive
- User should manually verify

### Backwards Compatibility

The existing `mapYoloToOcrText` function stays as a thin wrapper:

```typescript
// Deprecated — use findTagInstances() for new code
export function mapYoloToOcrText(params) {
  const result = findTagInstances(params);
  return result.instances.map(i => ({
    pageNumber: i.pageNumber,
    bbox: i.bbox,
  }));
}
```

Existing callers (KeynotePanel, TableParsePanel, ParsedTableItem) continue to work unchanged. New Auto-QTO code uses `findTagInstances()` directly for the richer return type.

---

## 6. UI Layout

```
┌─ Toolbar ──────────────────────────────────────────────────┐
├────────────────────────────────────────────────────────────┤
│            │                        │                      │
│ PageSidebar│     Canvas + Overlays  │   TakeoffPanel       │
│  (filtered │                        │   ┌─ Count (EA)      │
│   by QTO   │                        │   ├─ Area (SF)       │
│   material │                        │   └─ Auto-QTO ◄──── NEW TAB
│   when     │                        │     │                │
│   active)  │                        │     ├─ Step indicator│
│            │                        │     ├─ Material config│
│            │                        │     ├─ Current step UI│
│            │                        │     └─ Action buttons │
│            │                        │                      │
├────────────┴────────────────────────┴──────────────────────┤
│                                                            │
│   [QTO Spreadsheet Modal — fullscreen when opened]         │
│   (same pattern as TableCompareModal)                      │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

---

## 7. Data Model

### New Database Table

```sql
CREATE TABLE qto_workflows (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  material_type TEXT NOT NULL,           -- "doors", "finishes", "hex-tile", etc.
  material_label TEXT,                   -- user-facing display name
  step TEXT NOT NULL DEFAULT 'pick',     -- workflow step
  schedule_page_number INTEGER,
  yolo_model_filter TEXT,                -- optional: model name for YOLO boost
  yolo_class_filter TEXT,                -- optional: class name for YOLO boost
  tag_pattern TEXT,                      -- optional: regex hint for tag detection
  parsed_schedule JSONB,                 -- { headers, rows, tagColumn, tableName }
  line_items JSONB,                      -- QtoLineItem[]
  user_edits JSONB,                      -- manual overrides (qty changes, added/removed instances)
  exported_at TIMESTAMP,                 -- null until first export
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_qto_workflows_project ON qto_workflows(project_id);
```

### Drizzle Schema

```typescript
export const qtoWorkflows = pgTable("qto_workflows", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id),
  materialType: text("material_type").notNull(),
  materialLabel: text("material_label"),
  step: text("step").notNull().default("pick"),
  schedulePageNumber: integer("schedule_page_number"),
  yoloModelFilter: text("yolo_model_filter"),
  yoloClassFilter: text("yolo_class_filter"),
  tagPattern: text("tag_pattern"),
  parsedSchedule: jsonb("parsed_schedule"),
  lineItems: jsonb("line_items"),
  userEdits: jsonb("user_edits"),
  exportedAt: timestamp("exported_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_qto_workflows_project").on(table.projectId),
]);
```

### TypeScript Types

```typescript
interface QtoWorkflow {
  id: number;
  projectId: number;
  materialType: string;
  materialLabel: string;
  step: "pick" | "find-schedule" | "parse" | "map-tags" | "review" | "done";
  schedulePageNumber: number | null;
  yoloModelFilter: string | null;
  yoloClassFilter: string | null;
  tagPattern: string | null;
  parsedSchedule: QtoParsedSchedule | null;
  lineItems: QtoLineItem[] | null;
  userEdits: QtoUserEdits | null;
  exportedAt: string | null;
}

interface QtoParsedSchedule {
  headers: string[];
  rows: Record<string, string>[];
  tagColumn: string;
  tableName: string;
  scheduleCategory: string;        // "door-schedule", "finish-schedule", etc.
  sourcePageNumber: number;
  sourceBbox: BboxMinMax;
}

interface QtoLineItem {
  tag: string;
  specs: Record<string, string>;   // all schedule columns for this row
  autoQuantity: number;            // from findTagInstances()
  manualQuantity?: number;         // user override (if different from auto)
  instances: TagInstance[];         // from tag engine
  unmatchedYolo: number;           // count of YOLO shapes without tags for this class
  pages: number[];                 // unique page numbers where found
  csiCodes: string[];
  flags: QtoFlag[];
  notes: string;                   // estimator's notes
}

type QtoFlag = "not-found" | "extra" | "low-confidence" | "qty-mismatch" | "manual-override";

interface QtoUserEdits {
  addedInstances: { tag: string; pageNumber: number; bbox: BboxMinMax }[];
  removedInstances: { tag: string; pageNumber: number; bbox: BboxMinMax }[];
  quantityOverrides: Record<string, number>;  // tag → manual qty
  addedRows: Record<string, string>[];        // manually added line items
  deletedTags: string[];                      // tags removed from takeoff
  cellEdits: Record<string, string>;          // "tag:column" → edited value
}
```

### Store Slice

```typescript
// New slice: useQtoWorkflow()
export const useQtoWorkflow = () =>
  useViewerStore(useShallow((s) => ({
    activeQtoWorkflow: s.activeQtoWorkflow,
    setActiveQtoWorkflow: s.setActiveQtoWorkflow,
    updateQtoWorkflow: s.updateQtoWorkflow,
    qtoWorkflowStep: s.qtoWorkflowStep,
    setQtoWorkflowStep: s.setQtoWorkflowStep,
  })));
```

---

## 8. API Endpoints

```
POST   /api/qto-workflows              — Create new workflow
GET    /api/qto-workflows?projectId=X   — List workflows for project
GET    /api/qto-workflows/[id]          — Get workflow details
PUT    /api/qto-workflows/[id]          — Update workflow (step, data)
DELETE /api/qto-workflows/[id]          — Delete workflow
POST   /api/qto-workflows/[id]/scan     — Trigger tag scan (Step 4)
```

The `/scan` endpoint runs `findTagInstances()` server-side for all tags in the parsed schedule. This is potentially slow (scanning all pages for all tags) so it could:
- Run client-side using store data (faster, no API call needed)
- Or run server-side if we want to use server-only resources

**Recommendation:** Run client-side. The client already has all textractData and annotations in the store. No need for a round-trip.

---

## 9. Implementation Phases

### Phase A: Foundation (~1 session)
**Goal:** Skeleton that you can click through

- New DB table + Drizzle migration
- New store state: `activeQtoWorkflow`, basic setters
- New `AutoQtoTab.tsx` in TakeoffPanel (3rd tab)
- Material picker UI (Step 1)
- API endpoints (CRUD)
- Wire up: pick material → create workflow → show Step 2 shell

**Deliverable:** User can start a QTO workflow, see it persisted, navigate steps (shells only)

### Phase B: Schedule Finding + Parsing (~1 session)
**Goal:** Steps 2-3 fully functional

- PageSidebar schedule-type filter integration
- Suggested pages from classifiedTables heuristics
- Embedded table parse flow (reuse AutoParseTab pattern)
- Tag column picker with auto-detection
- Save parsed schedule to workflow

**Deliverable:** User can find a schedule page, parse it, confirm tag column, see parsed rows

### Phase C: Tag Engine Upgrade + Mapping (~1 session)
**Goal:** Step 4 fully functional

- Rename `yolo-tag-engine.ts` → `tag-engine.ts`
- Add `findTagInstances()` with multi-signal return type
- Keep `mapYoloToOcrText()` as backwards-compatible wrapper
- Wire up Step 4: scan all pages, populate lineItems
- Progress UI during scan
- Save results to workflow

**Deliverable:** After parsing schedule, system finds all tag instances with confidence scores

### Phase D: Review + CSV Editor (~1 session)
**Goal:** Steps 5-6 fully functional

- Review table UI (tag, description, qty, pages, flags)
- Click-to-navigate through instances on canvas
- Manual add/remove instance interactions
- QTO spreadsheet modal (fullscreen, like TableCompareModal)
- Cell editing, row add/delete
- CSV export
- Save/persist workflow state

**Deliverable:** Complete end-to-end workflow from material pick to CSV export

### Phase E: Polish + Edge Cases (~1 session)
**Goal:** Production-ready

- Unmatched YOLO shapes display ("possible untagged instances")
- Discrepancy flags in review UI
- Custom material type creation
- Workflow list (show past/completed workflows)
- Re-open completed workflow for editing
- Keyboard shortcuts in spreadsheet (Tab, Enter, Escape, Ctrl+Z)
- Error handling for failed scans, missing OCR data, etc.

---

## 10. Existing Code to Reuse

| Existing Code | Location | Used For |
|--------------|----------|----------|
| Table classifier | `src/lib/table-classifier.ts` | Schedule type detection heuristics |
| Tag engine | `src/lib/yolo-tag-engine.ts` → rename to `tag-engine.ts` | Core tag instance finding |
| Table parse API | `src/app/api/table-parse/route.ts` | Multi-method schedule parsing |
| AutoParseTab pattern | `src/components/viewer/AutoParseTab.tsx` | Draw BB → parse → review flow |
| MapTagsSection | `src/components/viewer/MapTagsSection.tsx` | YOLO class picker UI |
| TableCompareModal | `src/components/viewer/TableCompareModal.tsx` | Cell editing pattern for spreadsheet |
| PageSidebar filters | `src/components/viewer/PageSidebar.tsx` | Schedule page highlighting |
| Page classification | `pageIntelligence.classifiedTables` | Pre-detected schedule locations |
| api-utils | `src/lib/api-utils.ts` | Auth for new API endpoints |
| TakeoffPanel tabs | `src/components/viewer/TakeoffPanel.tsx` | Tab pattern for Auto-QTO tab |
| Store slices | `src/stores/viewerStore.ts` | Pattern for new useQtoWorkflow() slice |

---

## 11. New Files to Create

```
src/lib/tag-engine.ts                          — renamed + enhanced tag instance finder
src/lib/db/schema.ts                           — add qtoWorkflows table
src/stores/viewerStore.ts                      — add QTO workflow state + slice
src/components/viewer/AutoQtoTab.tsx            — main Auto-QTO tab (workflow steps)
src/components/viewer/QtoMaterialPicker.tsx     — Step 1: material selection + config
src/components/viewer/QtoScheduleFinder.tsx     — Step 2: find schedule page
src/components/viewer/QtoScheduleParser.tsx     — Step 3: parse schedule (wraps table parse)
src/components/viewer/QtoTagMapper.tsx          — Step 4: map tags progress UI
src/components/viewer/QtoReviewTable.tsx        — Step 5: review counts + flags
src/components/viewer/QtoSpreadsheetModal.tsx   — Step 6: fullscreen CSV editor
src/app/api/qto-workflows/route.ts             — CRUD API (POST, GET)
src/app/api/qto-workflows/[id]/route.ts        — CRUD API (GET, PUT, DELETE)
```

---

## 12. Design Decisions Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| User-initiated vs automatic | User-initiated | Estimators need to control the process; automatic = black box they won't trust |
| One workflow vs multiple | One at a time | Simpler UX, less state management, sequential estimating workflow |
| Persistence | Database | Workflows can take time; estimator needs to close browser and come back |
| Bottom panel vs modal for CSV | Fullscreen modal | Zero performance cost, full screen real estate, proven pattern |
| YOLO required vs optional | Optional (OCR always, YOLO boosts) | Many projects don't have YOLO models; OCR-only must work |
| Tag engine rename | `findTagInstances()` in `tag-engine.ts` | Clearer name, richer return type, backwards compatible |
| Scan location (client vs server) | Client-side | All data already in store, no round-trip needed |

---

## 13. Open Questions for Future Sessions

1. **Fuzzy tag matching:** Should T-01 match T-1 and T01? How aggressive should fuzzy matching be?
2. **Multi-page schedules:** Some schedules span 2+ pages. How do we handle this? Parse each page separately and merge?
3. **Schedule updates:** If the estimator re-parses a schedule (corrections), should existing tag mappings be preserved or re-run?
4. **Takeoff integration:** Should Auto-QTO line items flow into the existing Count/Area takeoff system, or stay separate?
5. **LLM assistance:** Could the LLM help resolve ambiguous tag matches or suggest missing instances? (Future feature)
6. **Batch export:** Export all completed workflows as a single combined CSV/Excel workbook?
