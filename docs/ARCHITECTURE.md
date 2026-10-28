# BlueprintParser architecture

How the pieces fit, for contributors. Start with the [README](../README.md); deployment is in
[DEPLOY.md](DEPLOY.md).

## System Architecture

```
                                 +---------------------------+
                                 | CloudFront viewer gate    |
                                 | deny-all; no S3 read grant|
                                 | (off application path)    |
                                 +---------------------------+

+-------------+    HTTPS    +-------------+-----------+
|   Browser   +------------>+   ALB (TLS termination) |
|  (pdf.js +  |             +-------------+-----------+
|   Zustand)  |                           |
+-------------+                           v
                            +-------------+-----------+  task-role read  +------------------+
                            |   ECS Fargate (2vCPU)   +----------------->+  private S3     |
                            |   Next.js 16 + API      |                  |  (PDFs, thumbs,  |
                            |   asset access gateway |                  |   YOLO results,  |
                            +--+--------+----------+--+                  |   model weights) |
                               |        |          |                     +------------------+
                  +------------+   +----+----+   +-+-----------+
                  |                |         |   |             |
                  v                v         v   v             v
           +------+------+  +-----+---+ +---+---+--+  +-------+--------+
           |  RDS PG 16  |  | Textract| | Secrets  |  | Step Functions  |
           | (schema.ts) |  | (OCR)   | | Manager  |  | (orchestrator)  |
           +-------------+  +---------+ +----------+  +-------+--------+
                                                               |
                                                               v
                                                    +----------+---------+
                                                    | ECS Task (8vCPU)   |
                                                    | CPU Processing     |
                                                    | (GS + Textract +   |
                                                    |  OpenCV + Python)  |
                                                    +--------------------+

                                                    +--------------------+
                                                    | SageMaker GPU      |
                                                    | ml.g4dn.xlarge     |
                                                    | (YOLOv8 inference) |
                                                    +--------------------+
```

Browser PDF, page-image, and thumbnail reads go through the same-origin
`/api/project-assets/` gateway. Canonical project prefixes remain private;
`_bp-public/` is reserved and unused. Immutable generation-qualified public
delivery is deferred until its producer, edge activation/revocation authority,
and cleanup worker can land as one protocol.

---

## Processing Pipeline (6-System Cascade)

The processing pipeline transforms PDFs into 'structured data' through six interconnected systems. Upstream system's outputs feed as inputs into downstream systems. The final processed outputs are machine readable, and context optimised for LLMs.

### System Overview

```
Raw pixels → OCR words → spatial clusters → semantic regions →
classified tables → YOLO-text bindings → tag patterns →
page intelligence → project graph → LLM context
```

### Upload Processing (per page, concurrency configurable via admin)

```
Upload PDF → S3
  │
  v
Step Functions → ECS Task   (locally: in-process when STEP_FUNCTION_ARN is empty and NODE_ENV != production)
  │
  ├── 0. Multi-file uploads are merged into one PDF; PDF channel census (vector/text/raster content per page)
  ├── 1. Ghostscript: PDF → PNG per page (300 DPI, -dMaxBitmap=500M); optional tile pyramid (root setting)
  ├── 2. Textract OCR with fallback chain:
  │     ├── Textract full-res (with retry+backoff for throttling)
  │     ├── Textract half-res (50% downscale if UnsupportedDocument)
  │     └── Tesseract local (if Textract unavailable)
  │     Returns: words[], lines[], tables[] (never throws — empty on total failure)
  │
  ├── 3. Drawing number extraction (title block regex + position scoring)
  ├── 4. CSI code detection (deterministic span tagger over a MasterFormat 2018 lookup table)
  ├── 5. Text annotation detection (regex detectors: phone, email, equipment, dims...) + keynote/shape extraction
  ├── 6. Page intelligence:
  │     ├── System 1: Text region classification (OCR word clustering → table-like, notes, key-value)
  │     ├── System 2: Heuristic engine (rule-based: text keywords + YOLO spatial + CSI affinity)
  │     └── System 3: Table meta-classifier (combines Systems 1+2 → door-schedule, finish-schedule, etc.)
  ├── 7. CSI spatial heatmap (NxN configurable grid + title-block + right-margin zones)
  ├── 8. tsvector generation (full-text search index)
  ├── 9. Project-level analysis (discipline breakdown, reference graph, CSI topology, summaries)
  └── 10. Project knowledge graph + cross-set links (sheets that reference each other within and across projects)

Page concurrency: 8 (configurable via admin dashboard, Textract limit: 10 TPS)
Each step wrapped in independent try-catch — one step failing doesn't block the pipeline.
```

### Post-YOLO Processing (user-triggered)

```
POST /api/yolo/run → SageMaker Processing Job (ml.g4dn.xlarge GPU; no local inference)
  │
  v
POST /api/yolo/load → Load results from S3
  ├── Create annotations (source='yolo') with class-level CSI codes from model config
  ├── Re-run heuristic engine with YOLO spatial signals (System 2, phase 2)
  ├── Reclassify tables with YOLO-enriched heuristic data
  └── Merge YOLO CSI codes into page-level csiCodes
```

---

## CSI Code Detection (Span Tagger)

CSI MasterFormat codes are the universal embedding layer that connects every system — OCR text, YOLO detections, parsed tables, spatial zones, and LLM context all tagged with CSI codes.

### Detection Algorithm (`csi-detect.ts` → `csi-page.ts`)

A deterministic tagger — no AI model at detection time, so the same page always gets the same codes, and each code points at the words on the sheet that produced it.

- **Lookup table.** Built once, offline, from the MasterFormat 2018 PDF: 8,935 codes and ~20,300 phrases (section titles, index phrases, alternate titles, "see" cross-references, and a short curated list of drawing abbreviations such as GWB, ACT, HM). The table (`src/data/csi-kb.json`) is not in git — you build it from your own copy of the PDF (README, "Build prerequisites") and the image build verifies it (`scripts/verify-csi-kb.mjs`). Without it the tagger returns no codes.
- **Spans.** Each OCR line, table cell or sentence is matched on its own. A phrase matches when the words that distinguish it from its parent are all present, ≥ 80% of its weight is present, and the words sit close together without crossing punctuation. Score: 1.00 exact, 0.85 spread out or reordered. A lone generic word ("concrete") is never a tag; one-word matches count only for curated abbreviations.
- **Ownership.** The most specific matching code wins ("HOLLOW METAL FRAME" → 08 12 13, not 08 10 00). Siblings that tie hand the words to their shared parent; codes from different divisions are settled by the sheet's discipline (A-, S-, M-, P-, E-, FP-, C-) or not at all.
- **Page rules.** Text ending in BY OTHERS / N.I.C. never tags the page; Division 00/01 only hints on drawings; site and process divisions (33–35, 40–48) need two different matching phrases or a civil sheet.
- **Confidence.** Best span score × repetition (0.88 once, +0.03 per extra occurrence, 1.00 at five). A code is listed when confidence ≥ `tau` (default 0.75), capped at `maxCodesPerPage` (default 40). Those are the only two settings (Admin → CSI); a company's custom CSI list adds codes on top of the built-in table.

Measured on the maintainer's private 471-page evaluation corpus: 41.5 → 6.4 codes per page versus the previous engine; on 19 hand-labelled (not yet certified) pilot pages, precision 4% → 35% and recall 21% → 37%. Re-measure with `eval/csi/run-eval.sh v2` (see `eval/csi/README.md`). The previous engine is kept unchanged in `src/lib/csi-detect-legacy.ts` as the evaluation baseline only.

### CSI Embedding Strategy

Every element in the system gets CSI-tagged:

```
Textract words → CSI codes (via csi-detect)
YOLO detections → CSI codes (via model config classCsiCodes)
Parsed table rows → CSI codes (via content matching)
Text annotations → CSI tags (via csi-detect on annotation text)
Spatial zones → CSI divisions (via csi-spatial heatmap)
User markups → CSI codes (via manual tagging in annotation editor)
```

All sources merge into `pages.csiCodes` (page-level). The CSI co-occurrence graph (`csi-graph.ts`) tracks which divisions appear together across pages, building a project-wide network with clusters (MEP, Architectural, Structural, Site) and cross-reference edges.

### CSI Spatial Heatmap (`csi-spatial.ts`)

Each page is divided into a configurable NxN grid (3x3 default, up to 27x27). Special zones: title-block (y > 0.85), right-margin (x > 0.75). All CSI-tagged elements (text annotations, YOLO detections, classified tables, parsed regions, YOLO tags) are binned into zones by bbox center.

Output: per-zone division breakdown + natural language summary (e.g., "Door-related content (Div 08) clusters in center drawing area; Plumbing (Div 22) clusters in bottom-right").

Fed to LLM at priority 7.0 in the context builder. Recomputed client-side after user parsing or YOLO load via `refreshPageCsiSpatialMap()`.

---

## Table & Schedule Parsing

Several parsing methods run on a user-drawn bounding box and a grid merger selects the highest-confidence alignment. The three below are the core; `img2table` (`scripts/img2table_extract.py`), Microsoft Table Transformer (TATR, `scripts/tatr_structure.py`, needs `models/tatr/`) and the newer parse engine (next section) add further candidates.

### Method 1: OCR Word Positions (`ocr-grid-detect.ts`)

- Cluster OCR words by Y-center (row tolerance: configurable, default 0.006)
- Detect columns by X left-edge gap analysis (min gap: configurable, default 0.015)
- Column stability filter: column must appear in ≥30% of rows (configurable)
- Layout hint support: force N columns (e.g., 2 for keynotes)
- Output: row/column boundaries + confidence score

### Method 2: Textract TABLES Feature

- AWS Textract returns structured TABLE blocks with CELL children
- Extract row/column indices, cell text, bounding boxes
- Higher confidence on structured tables with clear borders

### Method 3: OpenCV Line Detection (`detect_table_lines.py`)

- Rasterize page region → Hough transform → detect horizontal/vertical lines
- Build grid from line intersections
- Best for tables with visible rule lines

### Guided Parse (Tunable)

New "Guided" tab in the Schedules/Tables panel. User draws BB, system auto-proposes grid via `/api/table-parse/propose`, then user can tune with live sliders:

| Slider             | Controls                            | Default | Effect                         |
| ------------------ | ----------------------------------- | ------- | ------------------------------ |
| Row Sensitivity    | `rowTolerance` in `clusterRows()`   | 0.006   | Lower = tighter row clustering |
| Column Sensitivity | `minColGap` in `detectColumns()`    | 0.015   | Lower = more columns detected  |
| Column Confidence  | `minHitsRatio` in `detectColumns()` | 0.3     | Lower = keeps weaker columns   |
| Expected Columns   | `layoutHint.columns`                | Auto    | Force exact column count       |

Slider changes trigger debounced re-proposal (300ms). Grid lines rendered as draggable overlays on canvas (GuidedParseOverlay). Repeat Down / Repeat Right buttons tile uniform rows/columns. Available in both table and keynote parsing flows.

### Post-Parse Pipeline

1. Cell extraction via `extractCellsFromGrid()` — reads OCR words within grid boundaries
2. Generic column headers ("Column 1", "Column 2") — user renames via edit UI
3. CSI auto-detection on parsed content
4. Persistence to `pageIntelligence.parsedRegions` + DB
5. CSI spatial map recomputation
6. Optional tag mapping (see YOLO-Tag Engine below)

---

### Tables & Notes workspace and the parse engine

The **Tables & Notes** workspace (`src/components/viewer/workspace/`) is the newer home for tables,
keynotes, general notes and spec text: proposals found during processing are listed per sheet, a user
focuses one, parses it, edits the result and commits it as tag maps. It runs on the **parse engine**
(`src/lib/parse-engine/`, routes `api/projects/[id]/parse-engine/{parse,items,commit,flags}`), a single
engine meant to replace the per-tool legacy parsers one at a time.

Which path runs is decided by global flags (`src/server/services/parse-engine/flags.ts`, edited on the
root-only Parse Engine card in Admin → Pipeline): a kill switch, a per-tool `legacy` / `engine` switch
for `tablesRoute`, `keynoteRoute`, `notesClassifier`, `specClassifier`, `notesAuto`, `specAuto` and
`workspace`, and a crop cache. Code defaults: every tool `legacy` except `workspace` (`engine`), crop
cache on. The kill switch forces everything back to legacy. Engine test data is synthetic only
(`*.synthetic.json`, generated by `scripts/parse-engine-fixtures/`).

### Classifier builder

Admin → Classifiers builds rule-based page/region classifiers from recipes (CSI-tagged table words,
sheet number, title-block and header text) with fitted weights (`src/lib/classifier-engine/`,
`scripts/classifier-fit*.ts`). It sits beside the older Heuristics tab, which stays.

---

## YOLO-Tag Engine (`src/lib/tag-mapping/`)

Maps YOLO shape detections to nearby OCR text, creating tag instances that link visual symbols to their alphanumeric identifiers. The implementation is `src/lib/tag-mapping/` (`find-occurrences.ts`, `matchers/`); `src/lib/yolo-tag-engine.ts` is a back-compat re-export.

### Core Algorithm: `mapYoloToOcrText()`

```
For each YOLO annotation matching the target class:
  1. Find all OCR words whose center falls inside the YOLO bbox
  2. Sort left-to-right, concatenate → candidateText
  3. Match against target tag:
     - Exact match → confidence 1.0
     - Edit distance ≤ 1 (for text ≥ 3 chars) → confidence 0.9
     - Short tags (1-2 chars) require exact match (prevents "3" matching "8")
```

### Free-Floating Mode

For tags without YOLO shapes (OCR-only detection):

- Single-word tags: scan all words on page
- Multi-word tags: sliding window over adjacent words with bbox merging

### Tag Pattern Detection (`tag-patterns.ts`)

Discovers repeating YOLO+text patterns:

```
Input: 5 circles containing "T-01", "T-02", "T-03", "T-04", "T-05"
  1. For each YOLO detection, extract overlapping OCR text
  2. Extract prefix pattern: "T-01" → prefix "T-"
  3. Group by (yoloClass, prefix): "circle__T-" → 5 instances
  4. Build TagGroup: { pattern: "T-\\d+", instances: 5, confidence: "confirmed" }
```

Used by: keynote parsing (auto-create tags after parse), schedule parsing (Map Tags section), Auto-QTO workflow.

---

## Auto-QTO Workflow

Guided, material-specific Quantity Takeoff workflow. Walks estimators through: find schedule → parse it → define tag column → scan all pages for tags → review counts → CSV export.

### Workflow State Machine

```
select-schedule → confirm-tags → map-tags → review → done      (STEP_SEQUENCE in AutoQtoTab.tsx)
```

The review step shows counts with flags and exports CSV.

### Key Concepts

- **Tag Column**: User marks which parsed column contains the tag identifiers (e.g., "MARK", "NO."). Auto-suggested via regex + header keyword matching.
- **Multi-Signal Tag Engine**: OCR text matching (always) + YOLO shape proximity (optional boost). YOLO not required — works on day one without models.
- **Confidence Scoring**: Each tag instance includes signal breakdown (OCR match, OCR confidence, YOLO proximity, YOLO class).
- **Flags**: Auto-detected discrepancies (tag in schedule but not found on drawings, tag on drawings but not in schedule, low confidence, qty mismatch).

### Data Model

- `qto_workflows` table: persists workflow state across sessions

---

## Bucket fill

Bucket fill fills the pixels inside a clicked boundary; it outputs a polygon in normalized
coordinates. It does **not** compute square footage — area comes from the separate, user-defined
scale calibration. Two engines: the default **raster** worker (`src/workers/`), and a **vector** engine
that traces the PDF's own linework, adapted from OpenTakeoff (Apache-2.0; see `NOTICE` and
`src/lib/oneclick/`). The engine is chosen by `src/lib/bucket-fill-mode.ts`: localStorage, then
`NEXT_PUBLIC_BUCKET_FILL_MODE` (`raster` | `vector` | `auto`), then `raster`.

---

## LLM Context System

The core compression engine. Transforms 250K tokens of raw OCR into ~6K tokens of structured, priority-ordered context — a 40:1 compression ratio that makes small models (Haiku, Llama) viable for blueprint Q&A.

### Context Assembly (`context-builder.ts`)

20 page-level sections plus 6 project-wide (global) sections, each with a stable ID, priority, and configurable budget allocation (`SECTION_REGISTRY` / `GLOBAL_SECTION_REGISTRY` in `context-builder.ts`). The main page sections:

| Priority | Section                     | Source                                    |
| -------- | --------------------------- | ----------------------------------------- |
| 0.5      | Project Intelligence Report | projectIntelligence (auto-generated)      |
| 1.0      | YOLO Detection Counts       | annotations (source='yolo')               |
| 1.0      | CSI Network Graph           | projectIntelligence.csiGraph              |
| 1.5      | Page Classification         | pageIntelligence.classification           |
| 2.0      | User Annotations            | annotations (source='user')               |
| 3.0      | Takeoff Notes               | takeoffItems                              |
| 3.5      | Cross-References            | pageIntelligence.crossRefs                |
| 4.0      | CSI Codes                   | pages.csiCodes                            |
| 5.0      | Text Annotations            | pages.textAnnotations                     |
| 5.5      | Note Blocks                 | pageIntelligence.noteBlocks               |
| 5.8      | Parsed Tables/Keynotes      | pageIntelligence.parsedRegions            |
| 6.0      | Detected Regions            | pageIntelligence.classifiedTables         |
| 7.0      | CSI Spatial Distribution    | pageIntelligence.csiSpatialMap            |
| 8.0      | Spatial OCR→YOLO Context    | OCR words mapped to YOLO regions          |
| 10.0     | Raw OCR Text                | pages.rawText (fallback, often truncated) |

### Percentage-Based Budgeting with Overflow

Each section gets a % of the model-aware budget (Opus: 200K chars, Sonnet: 80K, GPT-4o: 60K, Groq: 24K). Unused allocation flows to a shared overflow pool that redistributes to sections needing more space. Three presets:

- **Balanced**: equal distribution
- **Structured**: parsed tables 25%, CSI spatial 8%, spatial context 12%, raw OCR 5%
- **Verbose**: raw OCR 40%, spatial 15%, parsed tables 10%

All configurable via admin LLM/Context tab (4 panels: section control, system prompt, budget, context preview tool).

### Multi-Provider Support

Resolution chain: User API key → Company config → Environment variable. Streaming SSE for all providers.

| Provider      | Models                   | Tool-Use     |
| ------------- | ------------------------ | ------------ |
| Anthropic     | Claude Opus/Sonnet/Haiku | Yes — 20 tools (`src/lib/llm/tools-defs.ts`), up to 10 rounds |
| OpenAI        | GPT-4o, o1/o3            | No (context only) |
| Groq          | Llama 3.3 70B            | No (context only) |
| Custom/Ollama | Any                      | Context-only |

---

## Frontend Architecture

### Viewer Component Hierarchy

```
PDFViewer (root — scroll, zoom, keyboard shortcuts)
├── ViewerToolbar (mode, zoom, search, panel toggles)
├── PageSidebar (thumbnails, page filtering, lazy-loaded)
├── SymbolSearchPanel (floating popup, 4 states)
├── PDFPage (canvas + overlays)
│   ├── SearchHighlightOverlay (memo) — search + CSI word highlights
│   ├── TextAnnotationOverlay — auto-detected text patterns
│   ├── KeynoteOverlay — keynote markers
│   ├── GuidedParseOverlay — draggable grid lines for guided parse
│   ├── ParseRegionLayer (memo) — table/keynote parse BBs
│   └── AnnotationOverlay (orchestrator — ALL mouse events)
│       └── DrawingPreviewLayer (memo) — in-progress BB/polygon/calibration
├── Right panels (toggled):
│   ├── TextPanel, ChatPanel, TakeoffPanel, DetectionPanel
│   ├── CsiPanel, PageIntelligencePanel
│   ├── TableParsePanel (5 tabs: All Tables, Auto Parse, Guided, Manual, Compare/Edit)
│   ├── KeynotePanel (5 tabs: All Keynotes, Auto Parse, Guided, Manual, Compare/Edit)
│   └── TableCompareModal (fullscreen side-by-side + overlay mode)
└── MarkupDialog (modal)
```

### Performance Architecture

**Drawing state decoupling**: `_drawing`, `_drawStart`, `_drawEnd`, and `_mousePos` live in the Tool Zustand store. `AnnotationOverlay` publishes them and reads them imperatively in event handlers, but does not subscribe to those four hot fields. `DrawingPreviewLayer` owns their reactive preview, so pointer-coordinate updates do not repaint the orchestration overlay.

**Event handler precedence (AnnotationOverlay)**: Strict sequential dispatch with early returns. Order matters:

1. Calibration mode → place points
2. Takeoff placement → polygon/marker
3. YOLO/tag picking → select shape
4. Symbol search / parse drawing → draw BB
5. Pointer mode → select/click/double-click OCR
6. Markup mode → draw annotation

**Zoom**: CSS transform for instant feedback, debounced pdf.js re-render (300ms). Cursor-centric (keeps point under cursor stable during zoom).

**Chunking**: 15-page sliding window with catalog/detail split. Catalog data (~100KB — trade lists, schedule names, CSI directory) loads once. Detail data (~80KB/page — textract words, page intelligence) loads on demand with eviction. State snapshot before async fetch prevents race conditions during rapid navigation.

### Zustand Store

Viewer state is split into explicit owners: `sessionStore` owns project identity/demo/page-label/labeling-session metadata; `uiStore` owns presentation state; `viewerCoreStore` owns page navigation, zoom, and page dimensions; `toolStore` owns interaction mode, the drawing cursor, calibration, takeoff placement, bucket/split/tag/symbol sessions, and tool history; `parseFlowStore` owns parse workflows; server collections use publicId-keyed Query facades. Smaller stores own single workflows (`proposalFocusStore`, `tablesWorkspaceStore`, `workspaceCanvasStore`, `hiddenDuplicatesStore`, `tableParseHintStore`; commands in `workspaceCommands`). The 92-line residual `viewerStore` is an inert compatibility sentinel, not a live data owner. Prefer the domain hook or leaf store over direct cross-domain field access; cross-owner behavior belongs in `viewerCommands` and the project-lifecycle coordinator.

---

## Admin Dashboard

All customization lives in admin — code provides defaults only. Different companies have different YOLO models with different class names; the admin dashboard is the authority. The authoritative tab list is the `TABS` array in `src/app/admin/AdminTabs.tsx` (19 tabs; several are root-only):

| Tab | Purpose |
| --- | --- |
| Overview | Project list, system status |
| Demo Projects | Project list and demo-project selection |
| AI Models | YOLO model registry (upload is root-only and off unless `ALLOW_MODEL_UPLOAD=true`), run/load/status per project |
| AI RBAC (root) | Per-company model access, which users may run models, LLM choices |
| Pipeline | Processing step toggles, page concurrency, CSI spatial grid, table proposals, parse-engine flags (root card) |
| Reprocess | The one home of every re-run (pages, CSI, classifiers, …) |
| LLM / Context | Section control (toggle/priority/%), system prompt, budget, context preview |
| Text Annotations | Detector toggles, preview per page |
| CSI Codes | CSI tagger settings (`tau`, `maxCodesPerPage` — the only two), custom CSI list, class-level CSI codes for YOLO models |
| Heuristics | Rule editor with YOLO class picker, text keywords, spatial conditions |
| Classifiers | Classifier builder (recipes, weight fitting) |
| Page Intelligence | Classification results, heuristic inferences |
| Table Parsing | Table-parse settings and debug |
| Companies / Users (root) | Companies, access keys, users across companies |
| Usage (root) | Quota defaults and per-user / per-company overrides |
| Users | User management, roles, API keys (company admins) |
| Data tools | Stuck jobs, duplicate pages and projects, annotation cleanup, permanent delete, `bp-export/1` project export |
| Settings | Company settings |
| Logs (root) | Accounts, security, engagement, visitors and a live monitor |

---

## Database Schema — core tables

These are the tables a contributor meets first. They are **a subset, not the whole schema** — the
full set is declared in `src/lib/db/schema.ts`, and the newest layer (the runtime-state family:
`runtimeCounters`, `loginLockouts`, `manualIpBans`, `abuseEvents`, `opLog`) is introduced by
`drizzle/0039_runtime_state.sql`.

| Table              | Purpose             | Key Fields                                                            |
| ------------------ | ------------------- | --------------------------------------------------------------------- |
| **companies**      | Multi-tenant orgs   | pipelineConfig (JSONB), features (JSONB), dataKey (S3 prefix)         |
| **users**          | Auth + permissions  | role (admin/member), canRunModels, companyId                          |
| **userApiKeys**    | BYOK LLM keys       | provider, encryptedKey (AES-256-GCM)                                  |
| **projects**       | PDF documents       | dataUrl (S3), status, projectIntelligence (JSONB), isDemo             |
| **pages**          | Per-page OCR data   | textractData (JSONB), csiCodes, pageIntelligence, search_vector (GIN) |
| **annotations**    | YOLO + user markups | bbox [minX,minY,maxX,maxY], source (yolo/user/takeoff), data (JSONB)  |
| **takeoffItems**   | QTO categories      | name, shape, color, size, notes                                       |
| **qtoWorkflows**   | Auto-QTO state      | step, parsedSchedule, lineItems, userEdits (JSONB)                    |
| **chatMessages**   | Chat history        | role, content, model, pageNumber (nullable = project-wide)            |
| **processingJobs** | SageMaker tracking  | status, stepFunctionArn                                               |
| **models**         | YOLO model registry | s3Path, config (JSONB: classCsiCodes, classKeywords)                  |
| **llmConfigs**     | LLM provider config | provider, model, encryptedApiKey, baseUrl                             |
| **auditLog**       | Security audit      | action, userId, details (JSONB), ip                                   |
| **inviteRequests** | Signup queue        | email, name, company                                                  |

---

## Python Scripts

| Script                  | Purpose                                                     | Called By             |
| ----------------------- | ----------------------------------------------------------- | --------------------- |
| `yolo_inference.py`     | YOLOv8 inference on pages                                   | SageMaker job         |
| `template_match.py`     | Two-tier template matching (cv2.matchTemplate + SIFT/FLANN) | /api/symbol-search    |
| `extract_keynotes.py`   | Keynote shape extraction + OCR                              | processing pipeline, shape parse, CV Lambda |
| `detect_table_lines.py` | Table grid line detection (Hough transform)                 | /api/table-parse      |
| `img2table_extract.py`  | img2table table extraction (`patch_img2table.py` patches it at image build) | table parsing |
| `tatr_structure.py`     | Table Transformer cell structure (needs `models/tatr/`)     | table parsing         |
| `bucket_fill.py`        | Server-side paint-bucket region detection                   | bucket fill           |
| `tile_page.py`          | Page tile pyramid                                           | processing (optional) |
| `pdf_channels.py`       | Per-page PDF content-channel census                         | processing            |
| `build_project_pdf.py`  | Merge a multi-file upload into one PDF                      | processing            |
| `lambda_handler.py`     | CV Lambda entry point                                       | AWS Lambda            |

All live in `scripts/` and communicate via JSON stdin/stdout. Called with `execFile` (not `exec`) — no shell injection surface.

---

## Key Design Decisions

**CSI codes as universal embedding layer.** Every pixel, annotation, tag, table cell, keynote, and spatial zone gets CSI-tagged. The CSI graph is a condensed project representation giving the LLM efficient navigation without reading raw OCR. This is the core architectural insight — structured tags compress information 40:1.

**Confidence scores, never binary decisions.** Every system outputs 0.0–1.0 confidence. A text region at 0.6 flows downstream; the table classifier might boost it to 0.85 if keywords match, or decay it to 0.3. Multiple independent signals that agree compound confidence.

**Normalized coordinates everywhere.** All annotations stored as 0-1 ratios. Rendering multiplies by current canvas dimensions. Zoom-independent, DPI-independent, resolution-independent.

**No migrations for new annotation types.** The `data` jsonb column on annotations absorbs new types without schema changes. Count markers, area polygons, scale calibrations, and YOLO detections all share one table.

**Admin dashboard is the authority.** All customization (heuristic rules, YOLO class names, CSI mappings, LLM config, pipeline toggles) lives in admin UI. Code provides defaults only. Different companies have different models with different class names — the admin adapts without code changes.

**Two-phase heuristic execution.** Rules work in text-only mode during OCR processing, then get re-scored with YOLO spatial signals after model load. Same rules, richer evidence.

**Graceful degradation everywhere.** Each processing step has independent try-catch. Textract failure falls through to Tesseract then to empty. Missing YOLO data → text-only heuristics. Missing CSI database → empty codes. The pipeline always completes.
