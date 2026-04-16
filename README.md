# BlueprintParser

Open-source AI-powered construction blueprint analysis platform. Upload PDF blueprints → auto-extract text (OCR) → detect objects (YOLO) → classify pages/tables/keynotes → detect CSI codes → spatial mapping → multi-provider LLM chat → Quantity Takeoff. Self-hostable, multi-tenant, designed for construction estimators.

**Live demo**: [blueprintparser.com/demo](https://app.blueprintparser.com/demo)

---

## Quick Start (Local Development)

```bash
git clone https://github.com/goodmorningcoffee/BlueprintParser.git
cd BlueprintParser/blueprintparser_2
cp .env.example .env.local       # Edit DATABASE_URL, NEXTAUTH_SECRET at minimum
docker compose up -d              # PostgreSQL on port 5433
npm install
npx drizzle-kit migrate           # Create database tables
bash scripts/setup.sh             # Create root admin account (interactive)
npm run dev                       # http://localhost:3000
```

Works without AWS credentials — PDF viewing, annotations, table parsing, QTO, and search are all functional locally. For the full pipeline, add: `GROQ_API_KEY` (free-tier LLM chat), AWS credentials (Textract OCR, S3 storage, SageMaker YOLO inference).

## Setup Scripts

| Script | Purpose | When to Use |
|--------|---------|-------------|
| `scripts/setup.sh` | First-time setup — runs migrations and creates root admin account | After cloning, once PostgreSQL is running |
| `install_setup.sh` | Full interactive wizard — configures `.env.local`, AWS credentials, LLM providers, S3, SageMaker, Label Studio | First deploy to AWS, or when adding new services |
| `deploy.sh` | Build Docker image, push to ECR, update ECS service | AWS production deployments |
| `deploy-yolo.sh` | Build and push YOLO inference container to ECR | When updating YOLO models or inference code |
| `hardening.sh` | AWS WAF rules, security headers, CloudWatch alarms | After initial AWS infrastructure setup |
| `root_admin.sh` | Create/reset root admin account on a running instance | Emergency admin access recovery |
| `scripts/cost-control.sh` | Check and stop idle SageMaker endpoints | Cost management for GPU resources |
| `scripts/sagemaker-killswitch.sh` | Emergency stop all SageMaker resources | If costs spike unexpectedly |

### Full Setup (with AWS)

For AWS deployment with Textract, S3, SageMaker, and ECS:

```bash
bash install_setup.sh             # Interactive wizard — walks through all config
bash deploy.sh                    # Build + push to ECR + update ECS
```

The setup wizard prompts for: database URL, auth secrets, LLM API keys (Groq/Anthropic/OpenAI), AWS credentials, S3 bucket, CloudFront, Step Functions, SageMaker, and Label Studio. Re-run anytime to update configuration.

## Configuration

| File | Purpose |
|------|---------|
| `.env.example` | All environment variables with descriptions. Copy to `.env.local` and fill in your values. |
| `.deploy.env.example` | AWS deployment variables (ECS, ECR, S3 bucket names). Copy to `.deploy.env` for production deploy. |
| `infrastructure/terraform/` | Full AWS infrastructure as code. Update `main.tf` backend config and `terraform.tfvars` before running. |

### Deployment Tiers

| Tier | What You Get | Estimated Cost |
|------|-------------|----------------|
| **Local only** (Docker Compose) | PDF viewer, annotations, table parsing, QTO, search, LLM chat (Groq free tier) | $0 |
| **Minimal AWS** (S3 only) | + Cloud storage for PDFs and thumbnails | ~$5/month |
| **Full AWS** (ECS + RDS + SageMaker) | + Textract OCR, YOLO inference, Step Functions orchestration, multi-tenant | ~$150-300/month |
| **SageMaker GPU** (on-demand) | YOLO model inference jobs (ml.g4dn.xlarge) | ~$0.75/hour per run |

## Model Weights

Three pre-trained YOLOv8 models are included via Git LFS in the `models/` directory:

| Model | Size | Classes | Use |
|-------|------|---------|-----|
| `yolo_medium.pt` | 136 MB | 7 (doors, tables, drawings, text boxes, title blocks, symbol legends) | General layout analysis |
| `yolo_precise.pt` | 137 MB | 2 (door_single, door_double) | Precise door detection |
| `yolo_primitive.pt` | 137 MB | 16 shapes (circles, rectangles, triangles, hexagons, etc.) | Keynote symbol detection |

After cloning, run `git lfs pull` if model files show as LFS pointers instead of actual weights.

---

## System Architecture

```
                                 +------------------+
                                 |   CloudFront     |
                                 |  (assets CDN)    |
                                 +--------+---------+
                                          |
+-------------+    HTTPS    +-------------+-----------+    S3     +------------------+
|   Browser   +------------>+   ALB (TLS termination) +---------->+  beaver-data-*   |
|  (pdf.js +  |             +-------------+-----------+           |  (PDFs, thumbs,  |
|   Zustand)  |                           |                       |   YOLO results,  |
+-------------+                           v                       |   model weights) |
                            +-------------+-----------+           +------------------+
                            |   ECS Fargate (2vCPU)   |
                            |   Next.js 16 + API      |
                            |   52+ endpoints          |
                            +--+--------+----------+--+
                               |        |          |
                  +------------+   +----+----+   +-+-----------+
                  |                |         |   |             |
                  v                v         v   v             v
           +------+------+  +-----+---+ +---+---+--+  +-------+--------+
           |  RDS PG 16  |  | Textract| | Secrets  |  | Step Functions  |
           |  (14 tables)|  | (OCR)   | | Manager  |  | (orchestrator)  |
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

---

## Processing Pipeline (6-System Cascade)

The processing pipeline transforms raw PDF pixels into structured, LLM-consumable intelligence through six interconnected systems. Each system adds signal while reducing noise, outputting confidence scores rather than binary decisions.

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
Step Functions → ECS Task
  │
  ├── 1. Ghostscript: PDF → PNG per page (300 DPI, -dMaxBitmap=500M)
  ├── 2. Textract OCR with fallback chain:
  │     ├── Textract full-res (with retry+backoff for throttling)
  │     ├── Textract half-res (50% downscale if UnsupportedDocument)
  │     └── Tesseract local (if Textract unavailable)
  │     Returns: words[], lines[], tables[] (never throws — empty on total failure)
  │
  ├── 3. Drawing number extraction (title block regex + position scoring)
  ├── 4. CSI code detection (3-tier matching against 8,951-row MasterFormat DB)
  ├── 5. Text annotation detection (30+ regex detectors: phone, email, equipment, dims...)
  ├── 6. Page intelligence:
  │     ├── System 1: Text region classification (OCR word clustering → table-like, notes, key-value)
  │     ├── System 2: Heuristic engine (rule-based: text keywords + YOLO spatial + CSI affinity)
  │     └── System 3: Table meta-classifier (combines Systems 1+2 → door-schedule, finish-schedule, etc.)
  ├── 7. CSI spatial heatmap (NxN configurable grid + title-block + right-margin zones)
  ├── 8. tsvector generation (full-text search index)
  └── 9. Project-level analysis (discipline breakdown, reference graph, CSI topology, summaries)

Page concurrency: 8 (configurable via admin dashboard, Textract limit: 10 TPS)
Each step wrapped in independent try-catch — one step failing doesn't block the pipeline.
```

### Post-YOLO Processing (user-triggered)

```
POST /api/yolo/run → SageMaker Processing Job (ml.g4dn.xlarge GPU)
  │
  v
POST /api/yolo/load → Load results from S3
  ├── Create annotations (source='yolo') with class-level CSI codes from model config
  ├── Re-run heuristic engine with YOLO spatial signals (System 2, phase 2)
  ├── Reclassify tables with YOLO-enriched heuristic data
  └── Merge YOLO CSI codes into page-level csiCodes
```

---

## CSI Code Detection (3-Tier Matching)

CSI MasterFormat codes are the universal embedding layer that connects every system — OCR text, YOLO detections, parsed tables, spatial zones, and LLM context all tagged with CSI codes.

### Detection Algorithm (`csi-detect.ts`)

Matches raw OCR text against the 8,951-row MasterFormat 2004 database (`csi-masterformat.tsv`). Three independent tiers, each with configurable thresholds:

| Tier | Method | Confidence | Description |
|------|--------|------------|-------------|
| **1** | Exact subphrase | 0.95 | Consecutive words from CSI description appear together in text |
| **2** | Bag-of-words | up to 0.75 | Score = `(matched/total)²` — squared penalty rewards near-complete overlap |
| **3** | Keyword anchors | up to 0.50 | Rare words weighted by inverse document frequency (IDF-like) |

- Multi-tier boost: +0.05 when both Tier 2 and Tier 3 agree (independent signals confirming each other)
- Stop-word filtering, minimum word count thresholds per tier
- All thresholds admin-configurable via pipeline control panel

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

Each page is divided into a configurable NxN grid (3x3 default, up to 12x12). Special zones: title-block (y > 0.85), right-margin (x > 0.75). All CSI-tagged elements (text annotations, YOLO detections, classified tables, parsed regions, YOLO tags) are binned into zones by bbox center.

Output: per-zone division breakdown + natural language summary (e.g., "Door-related content (Div 08) clusters in center drawing area; Plumbing (Div 22) clusters in bottom-right").

Fed to LLM at priority 7.0 in the context builder. Recomputed client-side after user parsing or YOLO load via `refreshPageCsiSpatialMap()`.

---

## Table & Schedule Parsing

Three parsing methods run in parallel on user-drawn bounding boxes, results merged by a grid merger that selects the highest-confidence alignment:

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

| Slider | Controls | Default | Effect |
|--------|----------|---------|--------|
| Row Sensitivity | `rowTolerance` in `clusterRows()` | 0.006 | Lower = tighter row clustering |
| Column Sensitivity | `minColGap` in `detectColumns()` | 0.015 | Lower = more columns detected |
| Column Confidence | `minHitsRatio` in `detectColumns()` | 0.3 | Lower = keeps weaker columns |
| Expected Columns | `layoutHint.columns` | Auto | Force exact column count |

Slider changes trigger debounced re-proposal (300ms). Grid lines rendered as draggable overlays on canvas (GuidedParseOverlay). Repeat Down / Repeat Right buttons tile uniform rows/columns. Available in both table and keynote parsing flows.

### Post-Parse Pipeline
1. Cell extraction via `extractCellsFromGrid()` — reads OCR words within grid boundaries
2. Generic column headers ("Column 1", "Column 2") — user renames via edit UI
3. CSI auto-detection on parsed content
4. Persistence to `pageIntelligence.parsedRegions` + DB
5. CSI spatial map recomputation
6. Optional tag mapping (see YOLO-Tag Engine below)

---

## YOLO-Tag Engine (`yolo-tag-engine.ts`)

Maps YOLO shape detections to nearby OCR text, creating tag instances that link visual symbols to their alphanumeric identifiers.

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
Step 1: Pick Material → Step 2: Find Schedule Page → Step 3: Parse Schedule
                                                           ↓
Step 6: CSV Editor ← Step 5: Review Counts ← Step 4: Map Tags to Drawings
```

### Key Concepts

- **Tag Column**: User marks which parsed column contains the tag identifiers (e.g., "MARK", "NO."). Auto-suggested via regex + header keyword matching.
- **Multi-Signal Tag Engine**: OCR text matching (always) + YOLO shape proximity (optional boost). YOLO not required — works on day one without models.
- **Confidence Scoring**: Each tag instance includes signal breakdown (OCR match, OCR confidence, YOLO proximity, YOLO class).
- **Flags**: Auto-detected discrepancies (tag in schedule but not found on drawings, tag on drawings but not in schedule, low confidence, qty mismatch).

### Data Model
- `qto_workflows` table: persists workflow state across sessions
- Phases A-B implemented: foundation + schedule finding/parsing
- Phases C-E planned: enhanced tag engine (`findTagInstances()` with multi-signal return), review table, CSV editor

---

## LLM Context System

The core compression engine. Transforms 250K tokens of raw OCR into ~6K tokens of structured, priority-ordered context — a 40:1 compression ratio that makes small models (Haiku, Llama) viable for blueprint Q&A.

### Context Assembly (`context-builder.ts`)

12+ sections, each with stable ID, priority, and configurable budget allocation:

| Priority | Section | Source |
|----------|---------|--------|
| 0.5 | Project Intelligence Report | projectIntelligence (auto-generated) |
| 1.0 | YOLO Detection Counts | annotations (source='yolo') |
| 1.0 | CSI Network Graph | projectIntelligence.csiGraph |
| 1.5 | Page Classification | pageIntelligence.classification |
| 2.0 | User Annotations | annotations (source='user') |
| 3.0 | Takeoff Notes | takeoffItems |
| 3.5 | Cross-References | pageIntelligence.crossRefs |
| 4.0 | CSI Codes | pages.csiCodes |
| 5.0 | Text Annotations | pages.textAnnotations (37 types) |
| 5.5 | Note Blocks | pageIntelligence.noteBlocks |
| 5.8 | Parsed Tables/Keynotes | pageIntelligence.parsedRegions |
| 6.0 | Detected Regions | pageIntelligence.classifiedTables |
| 7.0 | CSI Spatial Distribution | pageIntelligence.csiSpatialMap |
| 8.0 | Spatial OCR→YOLO Context | OCR words mapped to YOLO regions |
| 10.0 | Raw OCR Text | pages.rawText (fallback, often truncated) |

### Percentage-Based Budgeting with Overflow

Each section gets a % of the model-aware budget (Opus: 200K chars, Sonnet: 80K, GPT-4o: 60K, Groq: 24K). Unused allocation flows to a shared overflow pool that redistributes to sections needing more space. Three presets:

- **Balanced**: equal distribution
- **Structured**: parsed tables 25%, CSI spatial 8%, spatial context 12%, raw OCR 5%
- **Verbose**: raw OCR 40%, spatial 15%, parsed tables 10%

All configurable via admin LLM/Context tab (4 panels: section control, system prompt, budget, context preview tool).

### Multi-Provider Support

Resolution chain: User API key → Company config → Environment variable. Streaming SSE for all providers.

| Provider | Models | Tool-Use |
|----------|--------|----------|
| Anthropic | Claude Opus/Sonnet/Haiku | Planned |
| OpenAI | GPT-4o, o1/o3 | Planned |
| Groq | Llama 3.3 70B | Partial |
| Custom/Ollama | Any | Context-only |

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
│   ├── KeynotePanel (3 tabs: All Keynotes, Auto Parse, Guided)
│   └── TableCompareModal (fullscreen side-by-side + overlay mode)
└── MarkupDialog (modal)
```

### Performance Architecture

**Drawing state decoupling**: `_drawing`, `_drawStart`, `_drawEnd`, `_mousePos` live in Zustand store. AnnotationOverlay writes but does NOT subscribe (uses `getState()` for reads in event handlers). Only DrawingPreviewLayer subscribes → only lightweight canvas redraws during BB drawing. The main 1500-line overlay stays frozen during mouse movement.

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

Single store (~250 fields, 1,100 lines) with 15 slice selectors (`useNavigation()`, `useProject()`, `useTableParse()`, `useYoloTags()`, etc.) using `useShallow()` for memoized subscriptions. Components should use slices rather than direct field access.

---

## Admin Dashboard (9 Tabs)

| Tab | Purpose |
|-----|---------|
| Overview | Project list, reprocess controls, system status |
| Pipeline | Processing step toggles, page concurrency, CSI spatial grid resolution, table proposals config |
| AI Models | YOLO model registry, S3 upload, run/load/status per project |
| Heuristics | Rule editor with YOLO class picker (dropdown from registered models), text keywords, spatial conditions |
| LLM / Context | 4 panels: section control (toggle/priority/%), system prompt editor, budget config, context preview tool |
| CSI Codes | CSI database browser, class-level CSI tagging for YOLO models |
| Text Annotations | Detector toggle (30+ types), preview per page |
| Page Intelligence | Classification results, heuristic inferences, reprocess by scope |
| Users | User management, role assignment, API key management |

All customization lives in admin — code provides defaults only. Different companies have different YOLO models with different class names; the admin dashboard is the authority.

---

## Database Schema (14 tables)

| Table | Purpose | Key Fields |
|-------|---------|------------|
| **companies** | Multi-tenant orgs | pipelineConfig (JSONB), features (JSONB), dataKey (S3 prefix) |
| **users** | Auth + permissions | role (admin/member), canRunModels, companyId |
| **userApiKeys** | BYOK LLM keys | provider, encryptedKey (AES-256-GCM) |
| **projects** | PDF documents | dataUrl (S3), status, projectIntelligence (JSONB), isDemo |
| **pages** | Per-page OCR data | textractData (JSONB), csiCodes, pageIntelligence, search_vector (GIN) |
| **annotations** | YOLO + user markups | bbox [minX,minY,maxX,maxY], source (yolo/user/takeoff), data (JSONB) |
| **takeoffItems** | QTO categories | name, shape, color, size, notes |
| **qtoWorkflows** | Auto-QTO state | step, parsedSchedule, lineItems, userEdits (JSONB) |
| **chatMessages** | Chat history | role, content, model, pageNumber (nullable = project-wide) |
| **processingJobs** | SageMaker tracking | status, stepFunctionArn |
| **models** | YOLO model registry | s3Path, config (JSONB: classCsiCodes, classKeywords) |
| **llmConfigs** | LLM provider config | provider, model, encryptedApiKey, baseUrl |
| **auditLog** | Security audit | action, userId, details (JSONB), ip |
| **inviteRequests** | Signup queue | email, name, company |

---

## Security Model

| Layer | Implementation |
|-------|---------------|
| Auth | NextAuth 5 credentials, bcrypt (cost 12), JWT (24hr) |
| Brute force | 5 failures = 15min lockout, 10 = 1hr, per email |
| Rate limiting | In-memory middleware, per-endpoint (auth: 3-5/15min, chat: 30/hr, YOLO: 5/hr, general: 120/min) |
| Multi-tenancy | All queries scoped by `companyId`. Registration requires company access key |
| API key encryption | AES-256-GCM with random IV + auth tag |
| Quotas | Per-company daily: uploads (3 member/10 admin), YOLO (5), chat (200) |
| Secrets | AWS Secrets Manager via ECS task definition |
| Webhooks | HMAC-SHA256 + timestamp validation (reject > 5min) |
| Audit | Login, registration, create/delete, YOLO runs, password changes |
| Headers | nosniff, DENY frame, XSS protection, strict referrer |
| WAF | AWS WAF on ALB: rate limit (1000/IP), SQLi rules, known bad inputs, IP reputation (via `hardening.sh`) |
| Monitoring | CloudWatch alarms (5xx, unhealthy hosts, CPU), ALB access logs, GuardDuty, CloudTrail |

---

## Infrastructure (Terraform)

| Resource | Config |
|----------|--------|
| VPC | 10.0.0.0/16, 2 public + 2 private subnets, NAT gateway |
| ECS Fargate | 2 vCPU / 4 GB app, 8 vCPU / 16 GB processing tasks, auto-scaling 1-4 |
| ALB | HTTPS with ACM cert, TLS 1.3, 300s idle, circuit breaker rollback |
| RDS | PostgreSQL 16, db.t4g.medium, 50GB gp3, encrypted, 7-day backups, Multi-AZ |
| S3 + CloudFront | Versioned bucket, OAC, CORS policy, CachingOptimized, TLS 1.2 |
| ECR | 3 repos (app, cpu-pipeline, yolo-pipeline), scan-on-push |
| Step Functions | Blueprint processing orchestrator with retry/catch |
| SageMaker | Processing jobs for YOLO (ml.g4dn.xlarge GPU, on-demand) |
| Secrets Manager | 8 secrets with 7-day recovery window |

Estimated: ~$155/month baseline. SageMaker GPU ~$0.75/hr on-demand.

---

## Python Scripts

| Script | Purpose | Called By |
|--------|---------|-----------|
| `yolo_inference.py` | YOLOv8 inference on pages | SageMaker job |
| `template_match.py` | Two-tier template matching (cv2.matchTemplate + SIFT/FLANN) | /api/symbol-search |
| `extract_keynotes.py` | Keynote shape extraction + OCR | /api/keynotes/extract |
| `detect_table_lines.py` | Table grid line detection (Hough transform) | /api/table-parse |

All communicate via JSON stdin/stdout. Called with `execFile` (not `exec`) — no shell injection surface.

---

## Local Development

Prerequisites: Node.js 20+, Docker

```bash
docker compose up -d          # PostgreSQL on port 5433
npm install
cp .env.example .env.local    # Edit: DATABASE_URL, NEXTAUTH_SECRET
npx drizzle-kit migrate
npm run dev                   # http://localhost:3000
```

Works without AWS credentials — PDF viewing, annotations, QTO, search all functional. For full pipeline: add `GROQ_API_KEY` (chat), AWS credentials (Textract, S3, SageMaker).

---

## Tech Stack

| | |
|-|-|
| **Runtime** | Next.js 16 (App Router), React 19, TypeScript 5 |
| **State** | Zustand 5 (single store, 15 slice selectors, `useShallow()` memoization) |
| **Rendering** | pdfjs-dist 4 (PDF), HTML5 Canvas (7 overlay layers), CSS transform zoom |
| **Styling** | Tailwind 4, 3 dark themes (Midnight/Slate/Graphite) |
| **Database** | PostgreSQL 16, Drizzle ORM, 15 migrations |
| **Auth** | NextAuth 5 (credentials), bcrypt, JWT |
| **AI/LLM** | Multi-provider (Groq/Anthropic/OpenAI/Custom), streaming SSE, priority-ordered context |
| **CV** | OpenCV (table lines, keynotes), Tesseract (fallback OCR), YOLOv8/ultralytics |
| **Search** | PostgreSQL tsvector + GIN index, ts_rank + ts_headline, global cross-project |
| **Infra** | Terraform, ECS Fargate, S3/CloudFront, RDS, SageMaker, Step Functions |
| **Monitoring** | CloudWatch alarms, ALB access logs, GuardDuty, WAF, CloudTrail |

---

## Key Design Decisions

**CSI codes as universal embedding layer.** Every pixel, annotation, tag, table cell, keynote, and spatial zone gets CSI-tagged. The CSI graph is a condensed project representation giving the LLM efficient navigation without reading raw OCR. This is the core architectural insight — structured tags compress information 40:1.

**Confidence scores, never binary decisions.** Every system outputs 0.0–1.0 confidence. A text region at 0.6 flows downstream; the table classifier might boost it to 0.85 if keywords match, or decay it to 0.3. Multiple independent signals that agree compound confidence.

**Normalized coordinates everywhere.** All annotations stored as 0-1 ratios. Rendering multiplies by current canvas dimensions. Zoom-independent, DPI-independent, resolution-independent.

**No migrations for new annotation types.** The `data` jsonb column on annotations absorbs new types without schema changes. Count markers, area polygons, scale calibrations, and YOLO detections all share one table.

**Admin dashboard is the authority.** All customization (heuristic rules, YOLO class names, CSI mappings, LLM config, pipeline toggles) lives in admin UI. Code provides defaults only. Different companies have different models with different class names — the admin adapts without code changes.

**Two-phase heuristic execution.** Rules work in text-only mode during OCR processing, then get re-scored with YOLO spatial signals after model load. Same rules, richer evidence.

**Graceful degradation everywhere.** Each processing step has independent try-catch. Textract failure falls through to Tesseract then to empty. Missing YOLO data → text-only heuristics. Missing CSI database → empty codes. The pipeline always completes.

---

## License

MIT
