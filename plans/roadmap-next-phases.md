# BlueprintParser — Next Phases Roadmap

## Overview

Five initiatives that close loops between existing systems. Each builds on infrastructure already deployed (chunking, Auto-QTO Phase B, pipeline control panel). Ordered by impact and dependency chain.

---

## 1. Pipeline Phase 1 Completion — Wire the Toggles

**Effort:** Small (1-2 hours)
**Depends on:** Pipeline Control Panel Phase 1 (done)
**Unlocks:** Admin can disable expensive steps for faster processing

### What exists
- PipelineTab.tsx: toggle UI saves `disabledSteps[]` to `pipelineConfig.pipeline`
- API: `GET/PUT /api/admin/pipeline` persists config
- processing.ts: runs all steps unconditionally (ignores config)

### What to build

**In `processing.ts`:** After fetching company config (line ~102), read `disabledSteps`:
```
const disabledSteps = new Set(
  ((company?.pipelineConfig as any)?.pipeline?.disabledSteps as string[]) || []
);
```

Then wrap each toggleable step with `if (!disabledSteps.has("step-id"))`. The step IDs match what PipelineTab.tsx already uses:

| Step ID | Variable | Safe to skip? | What breaks if skipped |
|---------|----------|---------------|------------------------|
| `csi-detection` | `csiCodes` | Yes | CSI panel empty, spatial map empty, heuristic signals weaker |
| `text-annotations` | `textAnnotationResult` | Yes | Text annotation overlay empty, spatial map misses annotations |
| `page-intelligence` | `pageIntelligence` (classification, crossRefs, noteBlocks) | Yes | No discipline classification, no cross-ref detection |
| `text-regions` | `pageIntelligence.textRegions` | Yes | Table classification has no input (won't run) |
| `heuristic-engine` | `pageIntelligence.heuristicInferences` | Yes | Table classification loses heuristic signal |
| `table-classification` | `pageIntelligence.classifiedTables` | Yes | Auto-QTO can't auto-detect schedule pages |
| `csi-spatial` | `pageIntelligence.csiSpatialMap` | Yes | CSI spatial heatmap empty |

**Dependency chain:** If `text-regions` is disabled, `table-classification` gets no input and produces nothing. This is the same behavior as when text-region classification fails (try-catch already handles it).

**In `yolo/load/route.ts`:** Same pattern for post-YOLO steps:
- `heuristic-yolo` → skip YOLO-augmented heuristic re-run
- `table-reclassify` → skip table reclassification
- `yolo-csi-merge` → skip YOLO CSI code merge

**In `reprocess/route.ts`:** Already updated to accept `projectIds` body param. Needs the same `disabledSteps` check in the intelligence scope.

### Files to modify
- `src/lib/processing.ts` — wrap 7 steps with disabledSteps checks
- `src/app/api/yolo/load/route.ts` — wrap 3 post-YOLO steps
- `src/app/api/admin/reprocess/route.ts` — respect disabledSteps in intelligence scope

---

## 2. Pipeline Phase 2 — Table Region Proposals

**Effort:** Medium (half day)
**Depends on:** Pipeline Phase 1 completion
**Unlocks:** YOLO detections feed into table parsing workflow. Second "close the loop" integration.

### The problem
The heuristic table classifier (`table-classifier.ts`) uses keyword matching + OCR text region analysis. It's often wrong — flags pages as having schedules when they don't, or misses real schedules. It only uses text signals.

### The solution
The user has a YOLO model with `table`, `text_box`, `symbol_legend` classes. When YOLO detects a `table` class bbox on a page, that's a strong spatial signal that a table actually exists there. This is more reliable than text-only classification.

### What to build

**Config (already in PipelineTab):**
Admin selects which YOLO model + classes represent tables. Stored in `pipelineConfig.pipeline.tableProposals`:
```typescript
tableProposals: {
  enabled: boolean;
  yoloSources: [{ modelId: 3, modelName: "text_detector", classes: ["table", "text_box"] }]
}
```

Add YOLO model/class picker UI (same pattern as pageNaming config in HeuristicsTab lines 226-378):
- Fetch models from `/api/admin/models`
- Dropdown to select model
- Show model's classes as toggleable chips
- Save to pipelineConfig

**Backend (in `yolo/load/route.ts`):**
After summary recompute, if `tableProposals.enabled`:
1. Collect all YOLO annotations matching configured classes
2. Group by page number
3. Convert to `ProposedTableRegion` objects (bbox in LTWH, source class, confidence, model name)
4. Save to `pageIntelligence.proposedTableRegions` per page

**Type:**
```typescript
interface ProposedTableRegion {
  bbox: BboxLTWH;           // [left, top, width, height] normalized 0-1
  source: string;            // "yolo:table", "yolo:text_box"
  confidence: number;
  modelName: string;
}
// Add to PageIntelligence:
proposedTableRegions?: ProposedTableRegion[];
```

**Viewer — canvas overlay:**
Render proposed regions as magenta filled rectangles (20% opacity fill + solid border) on `ParseRegionLayer`. Toggleable via Settings modal (`showProposedRegions` store field).

Color: `#e040a0` (magenta). These are confidence signals, NOT auto-parse triggers.

**Viewer — Table/Schedule panel:**
In the table list (All Tables tab + detected tables section), show YOLO-detected pages with magenta indicator alongside heuristic detections:
```
Detected Tables
  ■ Page A-601: table (87%) — YOLO detected     [magenta dot]
  ■ Page A-602: door-schedule (72%) — heuristic  [existing style]
```

User clicks to navigate to page, then manually draws BB to parse. No auto-suggest of parse regions.

### Files to modify
- `src/app/admin/tabs/PipelineTab.tsx` — YOLO model/class picker for table proposals
- `src/app/api/yolo/load/route.ts` — save proposed regions after YOLO load
- `src/types/index.ts` — `ProposedTableRegion`, extend `PageIntelligence`
- `src/components/viewer/ParseRegionLayer.tsx` — render magenta overlays
- `src/components/viewer/TableParsePanel.tsx` — show YOLO-detected pages in table list
- `src/stores/viewerStore.ts` — `showProposedRegions` toggle
- `src/components/viewer/SettingsModal.tsx` — toggle for proposed regions

---

## 3. Guided Parse as Universal Module

**Effort:** Medium-large (1 session)
**Depends on:** Nothing (standalone extraction)
**Unlocks:** Table parsing gets the same powerful grid-proposal tool that keynote parsing has

### The problem
KeynotePanel has a guided parse flow that's really good when it works:
1. User draws region BB
2. System calls `/api/table-parse/propose` — OCR auto-suggests row/column grid boundaries
3. User sees grid lines on canvas, can adjust them
4. User clicks "Parse" → `extractCellsFromGrid()` reads cells from adjusted grid
5. Result: clean structured table with accurate cell boundaries

This is locked inside KeynotePanel (~200 lines of guided parse logic). TableParsePanel has a separate "Manual Parse" tab that does something similar but less capable (user draws individual column/row BBs without auto-proposal).

### What to build

**Extract shared guided parse logic:**

Create `src/components/viewer/GuidedParsePanel.tsx` — a reusable component that:
- Accepts: `regionBbox`, `layoutHint?` (optional column count), `onParsed(grid)`
- Shows: "Proposing grid..." → grid overlay on canvas → "Adjust & Parse" button
- Calls `/api/table-parse/propose` for auto-suggestion
- Renders adjustable grid lines on canvas (row/column boundaries)
- Has "Repeat row down" / "Repeat column right" tools
- Calls `extractCellsFromGrid()` on parse
- Returns structured grid to parent

**Shared store slice:**

Create `useGuidedParse()` slice in viewerStore (or extract to separate store):
```typescript
guidedParseActive: boolean;
guidedParseRegion: BboxMinMax | null;
guidedParseRows: number[];       // Y boundaries
guidedParseCols: number[];       // X boundaries
```

Currently these live in the store but are named with `guided` prefix and used only by KeynotePanel. The extraction renames nothing — just makes the component accept the region as a prop instead of reading it from keynote-specific state.

**Wire into TableParsePanel:**

Replace ManualParseTab's separate column/row drawing with GuidedParsePanel:
- User draws region BB (existing auto-parse flow)
- Instead of sending to `/api/table-parse` (black-box multi-method), user can choose "Guided Parse" mode
- System proposes grid → user adjusts → parse → clean result
- Especially useful for complex schedules where the auto-parse multi-method approach struggles

**Wire into KeynotePanel:**

Replace inline guided parse logic with GuidedParsePanel component:
- `layoutHint: { columns: 2 }` (keynotes are always 2-column)
- `onParsed(grid)` → creates keynote entries from grid rows

### Key functions to extract from KeynotePanel

| Function | Lines | What it does |
|----------|-------|-------------|
| `proposeGrid()` | 282-309 | Calls `/api/table-parse/propose`, sets guidedParseRows/Cols |
| `parseFromGuidedGrid()` | 312-411 | Calls `extractCellsFromGrid()`, detects CSI, creates parsed region, saves to DB |
| `repeatRowDown()` | 414-423 | Duplicates last row height downward |
| `repeatColumnRight()` | 426-435 | Duplicates last column width rightward |

### OCR Grid Detection (already shared)

`src/lib/ocr-grid-detect.ts` is already a shared library:
- `detectRowsAndColumns(words, bbox, hint)` — clusters OCR words into rows/columns
- `extractCellsFromGrid(words, rowBounds, colBounds)` — reads cell contents from grid
- Row detection: Y-center clustering with `ROW_Y_TOL = 0.006`
- Column detection: X left-edge clustering with `MIN_COL_GAP = 0.015`
- Layout hint enforcement: can force N columns by merging clusters

### Files to create
- `src/components/viewer/GuidedParsePanel.tsx`

### Files to modify
- `src/components/viewer/KeynotePanel.tsx` — replace inline guided parse with GuidedParsePanel
- `src/components/viewer/TableParsePanel.tsx` — add "Guided Parse" option alongside Auto/Manual
- `src/stores/viewerStore.ts` — clean up guided parse state (already exists, just needs better abstraction)

---

## 4. Pipeline Phase 3 — QTO Pre-Compute

**Effort:** Medium (half day)
**Depends on:** Pipeline Phase 2 (table proposals), Auto-QTO Phase B (done)
**Unlocks:** "Upload → YOLO → draft takeoff ready for review" (the wow moment)

### The concept
When a user completes a QTO workflow (e.g., Doors: YOLO class `door_tag`, tag column `MARK`, A-series pages), the admin can promote it to a "template." On future projects, after YOLO loads, the system:
1. Checks if a matching schedule was detected (via heuristic classifier + table proposals)
2. Checks if it's been parsed (via parsedRegions)
3. If both: runs batch tag mapping → creates a pre-computed `qto_workflows` row with `step: "review"`
4. User opens Auto-QTO tab → sees "Doors: 23 tags, 147 instances — Review"

### What to build

**Admin UI (in PipelineTab):**
QTO Pre-Compute section shows templates from `pipelineConfig.pipeline.qtoPreCompute.templates[]`. Admin can:
- See all company QTO workflows across projects
- Promote a workflow's config to a template (copies materialType, yoloClassFilter, scheduleCategory, tagColumnHints, includeDisciplines)
- Toggle templates on/off
- Delete templates

**Backend hook (in `yolo/load/route.ts`):**
After table proposals (if `qtoPreCompute.enabled`):
```
For each enabled template:
  1. Find matching classifiedTable or proposedTableRegion by scheduleCategory
  2. Check if schedule page has parsedRegions
  3. If not parsed → skip (can't auto-parse yet)
  4. If parsed → extract tags from tagColumn
  5. Run mapYoloToOcrText batch for all tags
  6. Build QtoLineItem[] with quantities + flags
  7. Check no existing workflow with same templateId
  8. Insert qto_workflows row (step="review", templateId=template.id)
```

**DB migration:**
Add `template_id TEXT` nullable column to `qto_workflows` table.
```sql
-- drizzle/0016_add_qto_template_id.sql
ALTER TABLE qto_workflows ADD COLUMN template_id TEXT;
```

**Viewer (AutoQtoTab.tsx):**
At top of material picker, show pre-computed workflows:
```
Pre-computed Takeoffs
  ✓ Doors — 23 tags, 147 instances    [Review]
  ✓ Finishes — 8 tags, 34 instances   [Review]
```
"Review" opens Step 5 (review table) directly.

### Files to create
- `drizzle/0016_add_qto_template_id.sql`

### Files to modify
- `src/app/admin/tabs/PipelineTab.tsx` — template management UI
- `src/app/api/yolo/load/route.ts` — pre-compute hook
- `src/lib/db/schema.ts` — add templateId to qtoWorkflows
- `src/types/index.ts` — add templateId to QtoWorkflow
- `src/components/viewer/AutoQtoTab.tsx` — show pre-computed workflows

---

## 5. LLM Tool-Use — Chat That Can Query

**Effort:** Medium (half day)
**Depends on:** Nothing (standalone enhancement)
**Unlocks:** Chat becomes useful for estimators, not just a novelty

### The problem
The LLM chat gets a context dump of OCR text, CSI codes, classifications, parsed tables. It can answer questions about what's IN the context. But it can't:
- Count tag instances across pages (needs `mapYoloToOcrText`)
- Query specific schedule rows (needs parsed table access)
- Find items in spatial zones (needs CSI spatial map queries)
- Navigate to specific locations (needs page/bbox coordinates)

### What to build

**Tool definitions for the LLM:**

```typescript
const tools = [
  {
    name: "count_tag_instances",
    description: "Count how many times a tag/label appears across drawing pages",
    parameters: {
      tagText: "string — the tag to search for (e.g., 'D-01', 'T-14')",
      yoloClass: "string? — optional YOLO class filter",
      pages: "number[]? — optional page range filter"
    }
  },
  {
    name: "query_schedule",
    description: "Look up rows in a parsed schedule/table by tag value or column filter",
    parameters: {
      scheduleCategory: "string? — e.g., 'door-schedule'",
      tagValue: "string? — specific tag to look up",
      pageNumber: "number? — which page the schedule is on"
    }
  },
  {
    name: "get_page_info",
    description: "Get classification, CSI codes, and detected regions for a specific page",
    parameters: {
      pageNumber: "number"
    }
  },
  {
    name: "find_pages_with_csi",
    description: "Find all pages containing a specific CSI code or trade",
    parameters: {
      csiCode: "string? — specific code like '08 11 16'",
      trade: "string? — trade name like 'Openings'"
    }
  }
];
```

**Tool execution (server-side in chat route):**

When the LLM responds with a tool call:
1. Parse the tool name and parameters
2. Execute against the DB (same queries as existing API endpoints)
3. Format result as a tool response message
4. Send back to LLM for final answer

**`count_tag_instances`** → calls `mapYoloToOcrText()` server-side (same as `/api/projects/[id]/map-tags`)
**`query_schedule`** → reads `pageIntelligence.parsedRegions` from DB, filters by category/tag
**`get_page_info`** → reads page's `pageIntelligence`, `csiCodes`, `textAnnotations` from DB
**`find_pages_with_csi`** → reads `summaries.csiPageIndex` or `summaries.tradePageIndex`

### Context builder changes

The context builder already has priority-ordered sections. With tool-use, the strategy changes:
- **Reduce static context** — don't dump everything upfront
- **Let the LLM request** what it needs via tools
- **Keep structural context** (classification, summaries) but remove raw data (OCR text, full CSI lists)
- This dramatically reduces token usage for large projects

### Provider support

| Provider | Tool-Use Support | Notes |
|----------|-----------------|-------|
| Anthropic (Claude) | Full | Native tool_use parameter |
| OpenAI (GPT-4o) | Full | function_call / tools parameter |
| Groq (Llama) | Partial | Tool-use support varies by model |
| Custom/Ollama | None | Skip tools, use context-only mode |

The chat route already resolves provider via `resolveLLMConfig()`. Add tool definitions conditionally based on provider capability.

### Example interactions

**User:** "How many D-01 doors are in this project?"
**LLM:** calls `count_tag_instances({ tagText: "D-01" })`
**Tool returns:** `{ instances: 14, pages: [101, 102, 103, 201, 202, 203, 301] }`
**LLM:** "There are 14 instances of door tag D-01 across 7 pages (A-101, A-102, A-103, A-201, A-202, A-203, A-301)."

**User:** "What hardware is specified for door type B?"
**LLM:** calls `query_schedule({ scheduleCategory: "door-schedule", tagValue: "B" })`
**Tool returns:** `{ tag: "B", TYPE: "Glass", SIZE: "3070", FRAME: "AL", HARDWARE: "Set #5" }`
**LLM:** "Door type B is a glass door, 3070 size, aluminum frame, with hardware set #5."

### Files to modify
- `src/app/api/ai/chat/route.ts` — add tool definitions, handle tool-use responses, execute tools
- `src/lib/context-builder.ts` — reduce static context when tools available, add tool-aware budget

### Files to create
- `src/lib/chat-tools.ts` — tool execution functions (wrappers around existing queries)

---

## 6. Heuristic YOLO Class Picker (Admin Dashboard)

**Effort:** Small-medium (2-3 hours)
**Depends on:** Nothing (standalone improvement)
**Unlocks:** Fixes the `"table"` vs `"tables"` bug class-wide. Prevents future mismatches.

### The problem

Heuristic rules have `yoloRequired` and `yoloBoosters` fields containing class name strings. These are currently typed in by hand (or hardcoded in BUILT_IN_RULES). The Medium model's class is `"tables"` but BUILT_IN_RULES say `"table"` — heuristic YOLO matching has **never worked** for schedule detection.

### The 3 YOLO models

| Model | Classes |
|-------|---------|
| **Primitives** (16) | arch_sheet_circle, arches_archway, circle, diamond, dot_small_circle, drawings, grid, hex_pill, hexagon, horizontal_area, oval, pill, rectangle, square, triangle, vertical_area |
| **Medium** (7) | door_single, door_double, tables, drawings, text_box, title_block, symbol_legend |
| **Precise** (2) | door_single, door_double |

Class files at `/workspaces/Theta_2018/models/classes_*.txt`. On AWS, stored in S3 alongside the .pt model files. Registered in `models.config.classes[]` in the DB.

### What to build

**In HeuristicsTab.tsx:** For each heuristic rule's `yoloRequired` and `yoloBoosters` fields, replace freeform text with a **model:class dropdown picker**:

1. Fetch all models via `GET /api/admin/models` (already done in AiModelsTab)
2. Build a flat list of `{ modelName, className }` pairs from each model's `config.classes`
3. Show as multi-select dropdown: `Medium: tables`, `Medium: text_box`, `Primitives: horizontal_area`, etc.
4. Admin clicks to add/remove classes — stored in the rule's `yoloRequired[]` / `yoloBoosters[]`
5. No typing, no mismatch possible

**Same pattern as pageNaming:** The pageNaming config in HeuristicsTab (lines 226-378) already has a model picker + class chip toggles for title block detection. Reuse this exact UI pattern for heuristic rule YOLO fields.

**BUILT_IN_RULES stay as code defaults.** They seed the company's `pipelineConfig.heuristics` on first load. After that, the admin's version in the DB overrides them. The admin fixes `"table"` → `"tables"` via the dropdown — the code never needs to change.

### Design principle

**All customization power lives in the admin dashboard.** Code provides defaults only. The admin is the authority on class names, model selection, and pipeline configuration. This is critical for open-source — different companies have different models with different class names.

### Files to modify
- `src/app/admin/tabs/HeuristicsTab.tsx` — add YOLO class picker to rule editor (same UI pattern as pageNaming)

### Files unchanged
- `src/lib/heuristic-engine.ts` — BUILT_IN_RULES stay as-is (defaults only, admin overrides)

---

## 7. CSI Spatial Map Grid Upgrade (3x3 → Configurable)

**Effort:** Small (1-2 hours)
**Depends on:** Nothing (standalone improvement)
**Unlocks:** Much more precise spatial intelligence for LLM context

### The problem

The current CSI spatial map divides each page into a **3x3 grid** (9 zones). This is too coarse — a typical blueprint has the title block in the bottom-right corner, and everything else is "the rest of the page." The 3x3 grid can't distinguish between a door schedule in the top-left and a finish schedule in the top-right of the same third.

### What to build

Make the grid resolution configurable: **9x9** (81 zones, default) or **12x12** (144 zones) via `pipelineConfig.pipeline.csiSpatialGrid`:

```typescript
csiSpatialGrid?: {
  rows: number;  // default 9
  cols: number;  // default 9
}
```

**In `csi-spatial.ts`:** The grid binning logic currently uses hardcoded 3x3. Change to read grid dimensions from config (defaulting to 9x9 if not set).

Current zone naming: `"top-left"`, `"center"`, `"bottom-right"` (9 named zones)
New zone naming: `"r2-c5"` (row-column coordinates) or keep a coarser label system with fine sub-zones.

**LLM context impact:** Higher resolution means the context builder can say "Division 08 items cluster in rows 1-3, columns 6-9 of this page" instead of just "top-right zone." More precise spatial context = better LLM answers about location.

**Admin control:** Add grid resolution picker to Pipeline Control Panel (dropdown: 3x3, 9x9, 12x12). Reprocess required after changing.

### Files to modify
- `src/lib/csi-spatial.ts` — parameterize grid dimensions
- `src/lib/context-builder.ts` — update spatial section formatting for higher-res grids
- `src/app/admin/tabs/PipelineTab.tsx` — add grid resolution config

---

## 8. Auto-YOLO on Upload (Pipeline Integration)

**Effort:** Small (2-3 hours)
**Depends on:** Pipeline Phase 1 (toggles wired)
**Unlocks:** Fully automated upload → OCR → YOLO → heuristics → draft QTO pipeline

### The problem
YOLO is currently user-triggered only (admin clicks "Run" per project per model). For companies that always want YOLO on every upload, this is manual busywork.

### What to build

**Config:** `pipelineConfig.pipeline.autoYolo`:
```typescript
autoYolo?: {
  enabled: boolean;
  modelId: number;      // which model to auto-run
  modelName: string;    // for display
}
```

Admin configures in Pipeline panel: toggle ON, pick model from dropdown.

**Backend:** After `processProject()` completes successfully (status = "completed"), check config:
```
// In processing.ts, after project status update:
if (autoYoloConfig?.enabled && autoYoloConfig.modelId) {
  // Fire-and-forget — don't block processing completion
  startYoloJob(project.id, autoYoloConfig.modelId).catch(err =>
    console.error("[processing] Auto-YOLO failed to start:", err)
  );
}
```

The project immediately shows as "completed" in the dashboard. YOLO runs in the background via SageMaker. When it finishes, results are ready to load (or auto-load if configured).

**Job tracking:** Already handled — `processingJobs` table tracks SageMaker jobs. The AI Models tab already polls status. No new infrastructure needed.

**Auto-load after YOLO completes:** Optional enhancement — instead of requiring admin to click "Load Results," add a webhook or polling mechanism that auto-calls `/api/yolo/load` when the job completes. This completes the full loop: upload → process → YOLO → load → heuristics → summaries → done.

### Files to modify
- `src/lib/processing.ts` — add auto-YOLO trigger after processing completes
- `src/app/admin/tabs/PipelineTab.tsx` — add autoYolo config (model picker + toggle)
- `src/lib/yolo.ts` — ensure `startYoloJob()` can be called from processing context (may need to import S3 client)

---

## 9. YOLO Real-Time Progress Terminal (AI Models Page)

**Effort:** Medium (half day)
**Depends on:** Nothing (standalone)
**Unlocks:** Admin can monitor YOLO jobs in real-time instead of blind polling

### The problem
When YOLO runs, the admin sees "InProgress" with no detail — no page count, no progress percentage, no ETA. SageMaker's `DescribeProcessingJob` only returns status enum, not progress data. For a 460-page project that takes 15 minutes, the admin has no idea how far along the job is.

### Solution: S3 progress file + terminal UI

**Step 1: Modify Python inference script**

In `scripts/yolo_inference.py`, write a `_progress.json` to the S3 output folder every 5 pages:

```python
import json, time, boto3

s3 = boto3.client('s3')
start_time = time.time()

for idx, image_path in enumerate(image_files):
    # ... existing inference code ...

    # Write progress every 5 pages
    if (idx + 1) % 5 == 0 or idx == len(image_files) - 1:
        progress = {
            "pages_completed": idx + 1,
            "pages_total": len(image_files),
            "last_page": image_path.stem,
            "elapsed_seconds": round(time.time() - start_time, 1),
            "detections_so_far": total_detections
        }
        s3.put_object(
            Bucket=output_bucket,
            Key=f"{output_prefix}/_progress.json",
            Body=json.dumps(progress),
            ContentType="application/json"
        )
```

**Step 2: Enhance status API**

In `/api/yolo/status/route.ts`, when status is "InProgress", try to read `_progress.json` from S3:

```typescript
if (status === "InProgress") {
  try {
    const progressObj = await s3Client.send(new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: `${projectDataUrl}/yolo-output/${modelName}/_progress.json`
    }));
    const progress = JSON.parse(await progressObj.Body.transformToString());
    return { status, progress };
  } catch {
    return { status, progress: null }; // no progress file yet
  }
}
```

**Step 3: Terminal-style job monitor panel**

New component on the AI Models page, right side of the model/project matrix:

```
┌─ YOLO Job Monitor ──────────────────────────────┐
│                                                   │
│ ● Office Tower — Medium                          │
│   ████████████░░░░░░░░ 15/50 pages (30%)         │
│   Elapsed: 45s | Est: ~1m 45s | 23 detections    │
│                                                   │
│ ● Residential — Primitives                       │
│   ████████████████████ 56/56 — Complete           │
│   Runtime: 3m 12s | 847 detections                │
│   [Load Results]                                  │
│                                                   │
│ ● Commercial — Medium                     Failed  │
│   Error: SageMaker timeout after 3600s            │
│                                                   │
│ ─── History ───                                   │
│ ✓ Office Tower / Primitives  (2h ago)  loaded     │
│ ✓ Residential / Medium       (1d ago)  loaded     │
└───────────────────────────────────────────────────┘
```

Features:
- Auto-polls every 5 seconds for active jobs
- Progress bar with page count + percentage
- ETA calculation from elapsed time + pages remaining
- Detection count (from progress file)
- "Load Results" button when complete
- Job history (recent completed/failed jobs)
- Error display for failed jobs

**Styling:** Dark terminal aesthetic — monospace font, dark background, green/amber/red status colors. Matches the construction-tool vibe.

### Files to modify
- `scripts/yolo_inference.py` — add S3 progress file writes (~10 lines)
- `src/app/api/yolo/status/route.ts` — read progress file from S3 when InProgress
- `src/app/admin/tabs/AiModelsTab.tsx` — add job monitor panel (or extract to `YoloJobMonitor.tsx`)

### Files to create
- `src/app/admin/tabs/YoloJobMonitor.tsx` — terminal-style job monitor component (optional extraction)

---

## Implementation Sequence

```
YOLO Class Picker (#6) ──→ Pipeline Phase 1 (#1) ──→ Pipeline Phase 2 (#2) ──→ Pipeline Phase 3 (#4)
(fix class mismatch)       (wire toggles)             (table proposals)         (QTO pre-compute)
                                  │
                                  ├──→ Auto-YOLO on Upload (#8)
                                  │
                                  ├──→ CSI Grid Upgrade (#7) (standalone)
                                  │
                                  ├──→ Guided Parse Module (#3) (standalone)
                                  │
                                  └──→ LLM Tool-Use (#5) (standalone)

YOLO Progress Terminal (#9) — standalone, can do anytime
```

## 10. LLM/Context Admin Tab — Full Context Control

**Effort:** Medium-large (1 session)
**Depends on:** Nothing (standalone)
**Unlocks:** Admin shapes exactly what the LLM sees. Debug context issues. Optimize token usage.

### How context works today

The chat route (`/api/ai/chat/route.ts`) builds context as 12 priority-ordered sections assembled within a model-aware character budget. The system prompt, section priorities, budgets, and which sections to include are all **hardcoded**. The only admin control is a custom system prompt string buried in `pipelineConfig.llm.systemPrompt`.

**Current priority stack (hardcoded):**
```
0.5  Project Intelligence Report
1.0  YOLO Detections / CSI Network Graph
1.5  Page Classification
2.0  User Annotations
3.0  Takeoff Notes
3.5  Cross-References
4.0  CSI Codes
5.0  Text Annotations (phone, equipment, dims)
5.5  Note Blocks (general notes)
5.8  Parsed Tables/Keynotes (headers + sample rows)
6.0  Detected Regions (classified tables)
6.2  CSI from Parsed Data
7.0  CSI Spatial Distribution (3x3 heatmap)
8.0  Spatial Context (OCR mapped to YOLO regions)
10.0 Raw OCR Text (lowest, often truncated)
```

**Current budgets (hardcoded):**
- Opus: 200K chars, Sonnet: 80K, GPT-4o: 60K, Groq: 24K

### What to build: LLM/Context admin tab

New tab in admin dashboard with 4 panels:

**Panel 1: System Prompt Editor**
- Full textarea for custom system prompt
- Template variables: `{{project_name}}`, `{{page_count}}`, `{{company_name}}`
- "Reset to default" button (shows the built-in anti-hallucination prompt)
- Preview of final assembled prompt with variables resolved
- Saved to `pipelineConfig.llm.systemPrompt`

**Panel 2: Context Section Control**
- List of all 12+ sections with:
  - Toggle ON/OFF (disable sections you don't want)
  - Priority number (editable, drag-reorder or manual input)
  - Brief description of what each section contains
- Example: Admin disables "Raw OCR Text" entirely (saves tokens), bumps "Parsed Tables" to priority 2.0 (schedules are most important for estimators)
- Saved to `pipelineConfig.llm.sectionConfig`:
  ```typescript
  sectionConfig?: {
    disabledSections?: string[];  // section header keys to skip
    priorityOverrides?: Record<string, number>;  // header key → custom priority
  }
  ```

**Panel 3: Budget Configuration**
- Per-provider budget overrides (chars)
- Default values shown (Opus 200K, Sonnet 80K, etc.)
- Admin can adjust: "I want Groq to use 40K instead of 24K since I have a paid plan"
- Saved to `pipelineConfig.llm.budgetOverrides`:
  ```typescript
  budgetOverrides?: Record<string, number>;  // "anthropic:opus" → 150000
  ```

**Panel 4: Context Preview Tool**
- Dropdown: pick a project + page number
- "Preview Context" button
- Shows the EXACT assembled context the LLM would receive:
  - System prompt (full text)
  - Each section with its header, priority, character count
  - Total characters used vs budget
  - What sections were truncated or excluded
- This is the killer debugging tool — admin can see "why did the LLM miss this schedule?" and realize the section was truncated by budget

### Implementation

**Config storage:** `pipelineConfig.llm`:
```typescript
llm?: {
  systemPrompt?: string;
  sectionConfig?: {
    disabledSections?: string[];
    priorityOverrides?: Record<string, number>;
  };
  budgetOverrides?: Record<string, number>;
}
```

**Context builder changes:**
- `context-builder.ts` reads section config from a parameter (passed from chat route)
- `getContextBudget()` checks budget overrides before falling back to defaults
- `assembleContext()` skips disabled sections and uses custom priorities
- Chat route loads company's LLM config and passes to builder functions

**Preview API:**
```
POST /api/admin/llm/preview
Body: { projectId, pageNumber, scope }
Returns: { systemPrompt, sections: [{ header, priority, chars, truncated }], totalChars, budget }
```
This is a read-only endpoint that builds context but doesn't call the LLM.

### Files to create
- `src/app/admin/tabs/LlmContextTab.tsx` — the 4-panel admin UI
- `src/app/api/admin/llm/preview/route.ts` — context preview endpoint

### Files to modify
- `src/app/admin/AdminTabs.tsx` — add "llm-context" tab
- `src/app/admin/page.tsx` — render LlmContextTab
- `src/lib/context-builder.ts` — accept section config + budget overrides params
- `src/app/api/ai/chat/route.ts` — load company LLM config and pass to context builder

---

**YOLO Class Picker → Pipeline 1 → 2 → 3** is the main dependency chain.
**Auto-YOLO** depends on Pipeline 1 (needs toggles wired).
**CSI Grid, Guided Parse, LLM Tool-Use, YOLO Terminal** are all independent.

## Strategic Priority

1. **YOLO Class Picker (#6)** — fixes critical bug (heuristic YOLO matching broken), quick win
2. **Pipeline Phase 1 (#1)** — wire toggles, selective reprocess. Admin control unlocked.
3. **YOLO Progress Terminal (#9)** — high UX impact, admin can finally see what's happening
4. **LLM Tool-Use (#5)** — highest user-facing impact, makes chat useful for estimators
5. **Pipeline Phase 2 (#2)** — closes YOLO → table detection loop
6. **Auto-YOLO on Upload (#8)** — automates the manual "Run YOLO" step
7. **CSI Grid Upgrade (#7)** — improves spatial intelligence precision, small effort
8. **Guided Parse Module (#3)** — improves table parsing quality significantly
9. **Pipeline Phase 3 (#4)** — the "wow" moment (upload → YOLO → draft QTO → review)
10. **LLM/Context Admin Tab (#10)** — full control over what the LLM sees (see `plans/llm-context-admin.md`)
