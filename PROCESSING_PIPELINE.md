# BlueprintParser Processing Pipeline

A complete map of every step that runs from PDF upload through final analysis,
in the order they execute. Includes both the automatic upload-time pipeline
(triggered by every new project) and the user-initiated actions that run later
on demand.

> **How to read this:** stages execute top-to-bottom. Boxes are executable
> code. `→` means "data flows from here to here." `║` and `╠══` mean a step
> branches into multiple parallel sub-steps. File paths in `monospace` point
> at the actual implementation in this repo.

---

## TL;DR — the whole pipeline in one picture

```
                      ┌───────────────┐
                      │  USER UPLOAD  │
                      │  PDF → S3     │
                      └───────┬───────┘
                              │
                              ▼
                  ┌───────────────────────┐
                  │  POST /api/projects   │   (creates DB row)
                  └───────────┬───────────┘
                              │
              ┌───────────────┴────────────────┐
              │                                │
         (production)                       (dev)
              │                                │
              ▼                                ▼
   ┌─────────────────────┐         ┌────────────────────┐
   │  AWS Step Function  │         │  In-process        │
   │  → Fargate ECS task │         │  fire-and-forget   │
   │  → process-worker   │         │  processProject()  │
   └──────────┬──────────┘         └──────────┬─────────┘
              │                                │
              └────────────┬───────────────────┘
                           ▼
            ┌─────────────────────────────────┐
            │  processProject(projectId)      │
            │  src/lib/processing.ts          │
            └─────────────────┬───────────────┘
                              │
   ┌──────────────────────────┼──────────────────────────┐
   │                          │                          │
   ▼                          ▼                          ▼
┌────────┐         ┌─────────────────┐        ┌──────────────────┐
│ STAGE  │         │ STAGE 2 — Per-  │        │ STAGE 3 — Project│
│ 1 —    │  ────►  │ page parallel   │ ────►  │ rollup (after    │
│ Setup  │         │ (16 sub-steps,  │        │ all pages done)  │
│        │         │  concurrency 8) │        │                  │
└────────┘         └─────────────────┘        └────────┬─────────┘
                                                       │
                                                       ▼
                                              ┌────────────────┐
                                              │ project.status │
                                              │ = completed    │
                                              └────────┬───────┘
                                                       │
                                                       ▼
              ╔════════════════════════════════════════════════╗
              ║   USER-INITIATED ACTIONS (later, on demand)    ║
              ╠════════════════════════════════════════════════╣
              ║   • YOLO inference (SageMaker)                 ║
              ║   • Auto-parse schedule region (5 methods)     ║
              ║   • Detect Cell Structure (TATR)               ║
              ║   • Bucket Fill (vector or raster)             ║
              ║   • Shape Parse (keynote OCR)                  ║
              ║   • Manual / guided table parse                ║
              ║   • Map Tags (annotations × YOLO)              ║
              ║   • LLM chat (RAG over project intelligence)   ║
              ║   • QTO workflows (auto-quantification)        ║
              ╚════════════════════════════════════════════════╝
```

---

## Stage 0 — Upload (browser → S3)

```
┌──────────────────┐                          ┌────────────────┐
│  Browser         │   1. presigned POST      │  AWS S3        │
│  (Next.js page)  │ ───────────────────────► │  bucket        │
└────────┬─────────┘                          └────────────────┘
         │                                              ▲
         │ 2. createUploadPresignedPost()               │
         │    src/app/api/s3/...                        │
         │                                              │
         │ 3. browser uploads PDF directly              │
         └──────────────────────────────────────────────┘
                          │
                          ▼
              S3 layout per project:
              s3://bucket/{companyDataKey}/{projectId}/
                ├── original.pdf       (the source PDF)
                └── (later) thumbnails/, pages/, ...
```

**Key files:**
- `src/lib/s3.ts` — `createUploadPresignedPost()`, `getS3Url()`, `downloadFromS3()`
- `src/app/api/s3/` — presigned URL handlers

---

## Stage 1 — Project creation + pipeline trigger

```
┌──────────────────────────────────────────────────────────────────┐
│  POST /api/projects     (src/app/api/projects/route.ts)          │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│   1. requireAuth() ──► session                                   │
│   2. checkUploadQuota() ──► allowed?                             │
│   3. INSERT INTO projects (status: "uploading")                  │
│   4. branch:                                                     │
│        ┌─ if STEP_FUNCTION_ARN env set ──► production path       │
│        │      ▼                                                  │
│        │   sfnClient.send(StartExecutionCommand)                 │
│        │   INSERT INTO processing_jobs (status: "running")       │
│        │   UPDATE projects SET status="processing"               │
│        │                                                         │
│        └─ else (dev / Codespace) ──► in-process path             │
│               ▼                                                  │
│            processProject(projectId)  // fire-and-forget         │
│                                                                  │
│   5. return { id, name, status }                                 │
└──────────────────────────────────────────────────────────────────┘
```

---

## Stage 2 — AWS Step Function (production only)

The Step Function is intentionally minimal — it's just a Fargate task wrapper
with retry/error catching. All the real work happens inside the container.

```
                ┌────────────────────────────────────┐
                │  blueprintparser-process-blueprint │
                │  (infrastructure/terraform/        │
                │   stepfunctions.tf)                │
                └────────────────┬───────────────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │  ValidateInput  │
                        │   (Pass state)  │
                        └────────┬────────┘
                                 │
                                 ▼
                        ┌─────────────────────────┐
                        │  CPUProcessing          │
                        │  ECS RunTask (Fargate)  │
                        │  Task: blueprintparser- │
                        │        cpu-pipeline     │
                        │  Retry: 2 attempts      │
                        └────────┬────────────────┘
                                 │
                                 ▼
                        ┌─────────────────┐    ┌──────────────────┐
                        │ Container env:  │    │  scripts/        │
                        │ • PROJECT_ID    │───►│  process-worker  │
                        │ • DATA_URL      │    │  .ts             │
                        │ • S3_BUCKET     │    └────────┬─────────┘
                        │ • WEBHOOK_URL   │             │
                        │ • WEBHOOK_SECRET│             ▼
                        └─────────────────┘    ┌──────────────────┐
                                               │ processProject() │
                                               │ src/lib/         │
                                               │   processing.ts  │
                                               └────────┬─────────┘
                                                        │ on exit:
                                                        ▼
                        ┌─────────────────┐    ┌──────────────────┐
                        │ ProcessingFailed│◄───│ ProcessingComplete│
                        │ (on error)      │    │ (Succeed state)  │
                        └─────────────────┘    └──────────────────┘
                                                        │
                                                        ▼
                                            POST /api/processing/webhook
                                            (notifies app of completion)
```

**Key files:**
- `infrastructure/terraform/stepfunctions.tf` — state machine definition
- `infrastructure/terraform/ecs.tf` — task definition
- `scripts/process-worker.ts` — container entrypoint
- `src/lib/processing.ts` — the actual pipeline (called from worker)
- `src/app/api/processing/webhook/route.ts` — completion handler

---

## Stage 3 — `processProject()` setup (lines 49-122 of processing.ts)

These steps run ONCE per project before any per-page work begins.

```
┌─────────────────────────────────────────────────────────────────────┐
│  processProject(projectId)                                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ 3.1  SELECT * FROM projects WHERE id = projectId             │   │
│  └────────────────────────┬─────────────────────────────────────┘   │
│                           ▼                                         │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ 3.2  UPDATE projects SET status = "processing"               │   │
│  └────────────────────────┬─────────────────────────────────────┘   │
│                           ▼                                         │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ 3.3  Download PDF from S3                                    │   │
│  │      fetch(getS3Url(dataUrl, "original.pdf"))                │   │
│  │      → pdfBuffer (Buffer)                                    │   │
│  └────────────────────────┬─────────────────────────────────────┘   │
│                           ▼                                         │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ 3.4  getPdfPageCount(pdfBuffer)                              │   │
│  │      → Ghostscript: gs -dNODISPLAY -dBATCH -dQUIET -c "..."  │   │
│  │      UPDATE projects SET numPages = N                        │   │
│  └────────────────────────┬─────────────────────────────────────┘   │
│                           ▼                                         │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ 3.5  Generate page-1 thumbnail (72 DPI)                      │   │
│  │      rasterizePage(pdfBuffer, 1, 72) → thumbBuffer           │   │
│  │      uploadToS3("thumbnail.png", thumbBuffer)                │   │
│  │      [best-effort, logged on failure]                        │   │
│  └────────────────────────┬─────────────────────────────────────┘   │
│                           ▼                                         │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ 3.6  Fetch company config (heuristics, page concurrency,     │   │
│  │      csiSpatialGrid) from companies.pipelineConfig           │   │
│  │      [defaults if unset: concurrency = 8]                    │   │
│  └────────────────────────┬─────────────────────────────────────┘   │
│                           ▼                                         │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ 3.7  Build pageNums = [1, 2, ..., N]                         │   │
│  │      mapConcurrent(pageNums, 8, processOnePage)              │   │
│  │      → Stage 4 fans out per page                             │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Stage 4 — Per-page processing (16 sub-steps, 8 in parallel)

This is the meat of the pipeline. For each page, in parallel (8 at a time):

```
┌────────────────────────────────────────────────────────────────────┐
│  Per-page worker — runs for pages 1..N with concurrency limit 8    │
│  src/lib/processing.ts:124-352                                     │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ 4.1  Skip-if-already-processed                          │       │
│  │      SELECT textractData FROM pages WHERE pageNumber=N  │       │
│  │      if found → return (idempotent)                     │       │
│  └────────────────────┬────────────────────────────────────┘       │
│                       ▼                                            │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ 4.2  Rasterize at 300 DPI for display quality           │       │
│  │      rasterizePage(pdfBuffer, N, 300)                   │       │
│  │      → pngBuffer  (subprocess: Ghostscript gs)          │       │
│  │      src/lib/pdf-rasterize.ts                           │       │
│  └────────────────────┬────────────────────────────────────┘       │
│                       ▼                                            │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ 4.3  Upload page PNG to S3                              │       │
│  │      uploadToS3("pages/page_NNNN.png", pngBuffer,       │       │
│  │                 cache: 1 year immutable)                │       │
│  └────────────────────┬────────────────────────────────────┘       │
│                       ▼                                            │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ 4.4  Generate 72 DPI page thumbnail                     │       │
│  │      rasterizePage(pdfBuffer, N, 72) → thumbBuffer      │       │
│  │      uploadToS3("thumbnails/page_NNNN.png", thumbBuffer)│       │
│  └────────────────────┬────────────────────────────────────┘       │
│                       ▼                                            │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ 4.5  Re-rasterize for OCR if image > 9500px             │       │
│  │      (Textract's max dimension limit)                   │       │
│  │      24×36" or 30×42" sheets at 300 DPI exceed this →   │       │
│  │      compute safe DPI, re-rasterize                     │       │
│  │      → ocrBuffer (may be same as pngBuffer)             │       │
│  └────────────────────┬────────────────────────────────────┘       │
│                       ▼                                            │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ 4.6  AWS Textract OCR                                   │       │
│  │      analyzePageImageWithFallback(ocrBuffer)            │       │
│  │      → words[], lines[], tables[]                       │       │
│  │      AWS API call (synchronous detect_document_text     │       │
│  │      + analyze_document with FORMS+TABLES features)     │       │
│  │      src/lib/textract.ts                                │       │
│  └────────────────────┬────────────────────────────────────┘       │
│                       ▼                                            │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ 4.7  Extract drawing number from title block            │       │
│  │      extractDrawingNumber(textractData)                 │       │
│  │      → "A-101", "M-201", etc.  (or null)                │       │
│  │      src/lib/title-block.ts                             │       │
│  └────────────────────┬────────────────────────────────────┘       │
│                       ▼                                            │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ 4.8  Detect CSI codes from raw text                     │       │
│  │      detectCsiCodes(rawText)                            │       │
│  │      → CsiCode[]  (3-tier matching: exact phrase →      │       │
│  │      bag-of-words → keyword anchors)                    │       │
│  │      src/lib/csi-detect.ts                              │       │
│  └────────────────────┬────────────────────────────────────┘       │
│                       ▼                                            │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ 4.9  Detect text annotations                            │       │
│  │      detectTextAnnotations(textractData, csiCodes)      │       │
│  │      → phones, addresses, equipment tags, abbreviations,│       │
│  │        proper nouns, manufacturer names, etc.           │       │
│  │      src/lib/text-annotations.ts                        │       │
│  └────────────────────┬────────────────────────────────────┘       │
│                       ▼                                            │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ 4.10  Page intelligence (drawing classification,        │       │
│  │       cross-reference detection, note block parsing)    │       │
│  │       analyzePageIntelligence(drawingNumber,            │       │
│  │                               textractData, csiCodes)   │       │
│  │       → { classification, crossRefs, noteBlocks, ... }  │       │
│  │       src/lib/page-analysis.ts                          │       │
│  └────────────────────┬────────────────────────────────────┘       │
│                       ▼                                            │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ 4.11  Classify text regions                             │       │
│  │       classifyTextRegions(textractData, csiCodes)       │       │
│  │       → tables / notes / specs / titles / generic       │       │
│  │       OCR-based bounding box clustering                 │       │
│  │       src/lib/text-region-classifier.ts                 │       │
│  └────────────────────┬────────────────────────────────────┘       │
│                       ▼                                            │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ 4.12  Run heuristic engine (text-only mode)             │       │
│  │       getEffectiveRules(companyHeuristics)              │       │
│  │       runHeuristicEngine(rules, { rawText, textRegions, │       │
│  │                                  csiCodes, pageNumber })│       │
│  │       → user-defined heuristic inferences               │       │
│  │       (YOLO data NOT yet available — runs again later   │       │
│  │       when user triggers YOLO inference)                │       │
│  │       src/lib/heuristic-engine.ts                       │       │
│  └────────────────────┬────────────────────────────────────┘       │
│                       ▼                                            │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ 4.13  Classify tables/schedules/keynotes (System 1-3)   │       │
│  │       classifyTables({ textRegions, heuristicInferences,│       │
│  │                       csiCodes, pageNumber })           │       │
│  │       → identifies WHERE tables are (not parsing yet —  │       │
│  │       parsing is Stage 6 user-initiated)                │       │
│  │       src/lib/table-classifier.ts                       │       │
│  └────────────────────┬────────────────────────────────────┘       │
│                       ▼                                            │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ 4.14  Compute CSI spatial heatmap (OCR-only)            │       │
│  │       computeCsiSpatialMap(N, textAnnotations, ...)     │       │
│  │       → grid of CSI density per region                  │       │
│  │       (YOLO/parsedRegions/yoloTags/dbAnnotations are    │       │
│  │       undefined here — only OCR data available)         │       │
│  │       src/lib/csi-spatial.ts                            │       │
│  └────────────────────┬────────────────────────────────────┘       │
│                       ▼                                            │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ 4.15  Build pageData object + UPSERT pages row          │       │
│  │       Fields written:                                   │       │
│  │       • textractData (jsonb, ~50-200KB per page)        │       │
│  │       • rawText                                         │       │
│  │       • drawingNumber                                   │       │
│  │       • csiCodes (jsonb)                                │       │
│  │       • textAnnotations (jsonb)                         │       │
│  │       • keynotes (null — user-initiated later)          │       │
│  │       • pageIntelligence (jsonb — the LLM context blob) │       │
│  └────────────────────┬────────────────────────────────────┘       │
│                       ▼                                            │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │ 4.16  Update tsvector for full-text search              │       │
│  │       UPDATE pages SET search_vector = to_tsvector(     │       │
│  │         'english', rawText) WHERE id = pageId           │       │
│  └─────────────────────────────────────────────────────────┘       │
│                                                                    │
│  pagesProcessed++                                                  │
└────────────────────────────────────────────────────────────────────┘
```

**Note:** any individual sub-step that throws is caught with `logger.error`,
the page error counter increments, and a `pages` row is inserted with the
error message — but processing of OTHER pages continues. Failure of one
sub-step within a page does NOT abort the page (e.g. CSI detection failing
just means `csiCodes = []`, not the whole page).

---

## Stage 5 — Project rollup (after all pages done)

Once `mapConcurrent()` resolves, project-level analysis runs sequentially:

```
┌────────────────────────────────────────────────────────────────┐
│  Project rollup    (src/lib/processing.ts:354-420)             │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌──────────────────────────────────────────────────────┐      │
│  │ 5.1  SELECT all processed pages                      │      │
│  │      → [{pageNumber, drawingNumber,                  │      │
│  │          pageIntelligence, csiCodes}, ...]           │      │
│  └──────────────────────┬───────────────────────────────┘      │
│                         ▼                                      │
│  ┌──────────────────────────────────────────────────────┐      │
│  │ 5.2  analyzeProject(allPages)                        │      │
│  │      → { intelligence, summary }                     │      │
│  │      Cross-page analysis: drawing set inventory,     │      │
│  │      CSI rollup, project type inference, etc.        │      │
│  │      src/lib/project-analysis.ts                     │      │
│  └──────────────────────┬───────────────────────────────┘      │
│                         ▼                                      │
│  ┌──────────────────────────────────────────────────────┐      │
│  │ 5.3  Preserve user-set classCsiOverrides             │      │
│  │      Merge existing project.projectIntelligence      │      │
│  │      .classCsiOverrides into the new intelligence    │      │
│  └──────────────────────┬───────────────────────────────┘      │
│                         ▼                                      │
│  ┌──────────────────────────────────────────────────────┐      │
│  │ 5.4  UPDATE projects SET                             │      │
│  │      projectIntelligence = mergedIntelligence,       │      │
│  │      projectSummary = summary                        │      │
│  └──────────────────────┬───────────────────────────────┘      │
│                         ▼                                      │
│  ┌──────────────────────────────────────────────────────┐      │
│  │ 5.5  computeProjectSummaries(projectId)              │      │
│  │      Builds chunking indexes for sidebar/panels      │      │
│  │      (per-discipline groupings, cross-refs)          │      │
│  │      src/lib/project-analysis.ts                     │      │
│  └──────────────────────┬───────────────────────────────┘      │
│                         ▼                                      │
│  ┌──────────────────────────────────────────────────────┐      │
│  │ 5.6  UPDATE projects SET                             │      │
│  │      status = "completed" (or "error"),              │      │
│  │      processingTime = elapsedSeconds                 │      │
│  └──────────────────────┬───────────────────────────────┘      │
│                         ▼                                      │
│  ┌──────────────────────────────────────────────────────┐      │
│  │ 5.7  warmCloudFrontCache(dataUrl, numPages)          │      │
│  │      Best-effort HEAD requests to populate CDN edge  │      │
│  │      cache so first user visit is fast               │      │
│  │      src/lib/s3.ts                                   │      │
│  └──────────────────────┬───────────────────────────────┘      │
│                         ▼                                      │
│              return { pagesProcessed, pageErrors,              │
│                       processingTime }                         │
└────────────────────────────────────────────────────────────────┘
                         │
                         ▼
              ┌──────────────────────────┐
              │ process-worker.ts:       │
              │ POST /api/processing/    │
              │      webhook             │
              │ (Step Functions sees     │
              │  exit code 0/1)          │
              └──────────────────────────┘
```

**At this point the automatic pipeline is done.** The project is
"completed" in the DB. Everything else from here is user-initiated.

---

## Stage 6 — User-initiated post-processing (on demand)

These run when the user clicks something in the viewer. They are NOT part
of the automatic pipeline. Each one is independent and can be re-run.

### 6.A — YOLO inference (symbol detection)

```
┌──────────────────────────────────────────────────────────────────┐
│  POST /api/yolo/run    (src/app/api/yolo/run/route.ts)           │
├──────────────────────────────────────────────────────────────────┤
│   1. requireAuth() + canRunModels permission                     │
│   2. checkYoloQuota()                                            │
│   3. Verify model access (company-owned OR model_access row)     │
│   4. startYoloJob() → SageMaker async inference                  │
│      src/lib/yolo.ts                                             │
│        ├─ scripts/yolo_inference.py (Python wrapper)             │
│        └─ writes to S3 + annotations table on completion         │
│   5. processingJobs row tracks job status                        │
│                                                                  │
│   POLLING: GET /api/yolo/status                                  │
│            (frontend polls until SageMaker job done)             │
└──────────────────────────────────────────────────────────────────┘
                                │
                                ▼
                  Annotations written to DB:
                  table `annotations` with source="yolo"
                  per-page bounding boxes with class + confidence

                  Triggers re-render in Detection Panel and
                  re-runs heuristic engine WITH yolo data
```

### 6.B — Schedule auto-parse (the table-parsing pipeline this session was about)

```
┌──────────────────────────────────────────────────────────────────┐
│  POST /api/table-parse                                           │
│  src/app/api/table-parse/route.ts                                │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Input:  { projectId, pageNumber, regionBbox, options,          │
│             debugMode? }                                         │
│                                                                  │
│   1. Check effectiveDebugMode = body.debugMode OR                │
│        appSettings.tableParse.debugMode (Phase I.2.e)            │
│                                                                  │
│   2. SELECT textractData FROM pages WHERE projectId,pageNumber   │
│                                                                  │
│   3. Infrastructure stages (timed → infraStages):                │
│      ┌──────────────────────────────────────────────────┐        │
│      │ pdf-download:                                    │        │
│      │   downloadFromS3(`${dataUrl}/original.pdf`)      │        │
│      │   → pdfBuffer                                    │        │
│      └──────────────────┬───────────────────────────────┘        │
│                         ▼                                        │
│      ┌──────────────────────────────────────────────────┐        │
│      │ rasterize:                                       │        │
│      │   rasterizePage(pdfBuffer, pageNumber, 200)      │        │
│      │   → pagePngBuffer                                │        │
│      └──────────────────┬───────────────────────────────┘        │
│                         ▼                                        │
│   4. Run methods in PARALLEL via Promise.all (each timed):       │
│                                                                  │
│      ║ ┌──────────────────────────────────────────────┐          │
│      ╠─┤ methodOcrPositions (in-process TS)           │          │
│      ║ │   src/lib/services/table-parse.ts            │          │
│      ║ │   Cluster Textract words by Y/X, build grid  │          │
│      ║ └──────────────────────────────────────────────┘          │
│      ║ ┌──────────────────────────────────────────────┐          │
│      ╠─┤ methodTextractTables (in-process TS)         │          │
│      ║ │   Pull pre-existing Textract TABLE blocks    │          │
│      ║ │   and filter by region overlap               │          │
│      ║ └──────────────────────────────────────────────┘          │
│      ║ ┌──────────────────────────────────────────────┐          │
│      ╠─┤ methodOpenCvLines (subprocess: Python)       │          │
│      ║ │   detectTableLines() spawns                  │          │
│      ║ │     scripts/detect_table_lines.py            │          │
│      ║ │   OpenCV Hough lines → grid coords           │          │
│      ║ │   Then map words into cells                  │          │
│      ║ └──────────────────────────────────────────────┘          │
│      ║ ┌──────────────────────────────────────────────┐          │
│      ╠─┤ extractWithImg2Table (subprocess: Python)    │          │
│      ║ │   src/lib/img2table-extract.ts spawns        │          │
│      ║ │     scripts/img2table_extract.py             │          │
│      ║ │   mode="auto":                               │          │
│      ║ │     1. Crop PDF with PyMuPDF show_pdf_page() │          │
│      ║ │     2. Try Img2TablePDF (native text via     │          │
│      ║ │        PdfOCR class — perfect text)          │          │
│      ║ │     3. Fall back to Img2TableImage (Tesseract│          │
│      ║ │        OCR) if PDF mode returned empty       │          │
│      ║ └──────────────────────────────────────────────┘          │
│      ║ ┌──────────────────────────────────────────────┐          │
│      ╚─┤ extractWithCamelotPdfplumber (subprocess Py) │          │
│        │   src/lib/camelot-extract.ts spawns          │          │
│        │     scripts/camelot_pdfplumber_extract.py    │          │
│        │   Returns ARRAY of 3 sub-method results:     │          │
│        │     • camelot-lattice  (Hough on whole page) │          │
│        │     • camelot-stream   (text whitespace)     │          │
│        │     • pdfplumber       (vector lines, region)│          │
│        └──────────────────────────────────────────────┘          │
│                         │                                        │
│                         ▼ Promise.all().flat()                   │
│   5. mergeGrids(results)  (src/lib/grid-merger.ts)               │
│      • filter empty results, penalize single-column              │
│      • sort by confidence, pick highest as base                  │
│      • shape compatibility filter                                │
│      • row alignment filter                                      │
│      • cell-level fill from compatible methods                   │
│      • disagreement detection with edit distance                 │
│      • findTagColumnInMergedGrid()                               │
│      → MergedGrid + mergerNotes (Phase I.1.e)                    │
│                                                                  │
│   6. detectCsiFromGrid(headers, rows)                            │
│      Runs CSI matching against the merged cell content           │
│                                                                  │
│   7. Build response, addToHistory() ring buffer                  │
│      (src/lib/parse-history.ts — Phase I.1.f)                    │
│                                                                  │
│   8. Return { ...merged, infraErrors, methodResults?,            │
│               infraStages?, totalDurationMs? }                   │
│      (debug fields gated on effectiveDebugMode)                  │
└──────────────────────────────────────────────────────────────────┘
```

### 6.C — Cell structure detection (TATR)

```
┌──────────────────────────────────────────────────────────────────┐
│  POST /api/table-structure                                       │
│  src/app/api/table-structure/route.ts                            │
├──────────────────────────────────────────────────────────────────┤
│   1. downloadFromS3("original.pdf") → pdfBuffer                  │
│   2. rasterizePage(pdfBuffer, pageNumber, 200)                   │
│   3. Crop to regionBbox via inline Python OpenCV script          │
│   4. detectTableStructure(croppedBuffer, confidenceThreshold)    │
│      src/lib/tatr-structure.ts spawns                            │
│        scripts/tatr_structure.py                                 │
│      • Loads HuggingFace TableTransformerForObjectDetection      │
│        from /app/models/tatr (Phase B.2 packaged)                │
│      • Detects rows, columns, headers, spanning cells            │
│      • Builds cells via row × column intersection                │
│   5. Map cell bboxes from crop-relative back to page-relative    │
│   6. Fill cell text from Textract OCR words                      │
│   7. Return { cells, rows, columns, confidence }                 │
└──────────────────────────────────────────────────────────────────┘
```

### 6.D — Bucket Fill (room detection)

```
┌──────────────────────────────────────────────────────────────────┐
│  POST /api/bucket-fill/...                                       │
├──────────────────────────────────────────────────────────────────┤
│  Frontend draws barrier lines (Area Tab on canvas)               │
│   1. Vector mode (preferred):                                    │
│      scripts/bucket_fill.py                                      │
│        pdfplumber → networkx planar face traversal               │
│        → polygon for the click point's enclosed region           │
│   2. Raster mode (fallback for scanned PDFs):                    │
│      OpenCV cv2.floodFill on rasterized page                     │
│   Auto-detects mode from vector edge count                       │
└──────────────────────────────────────────────────────────────────┘
```

### 6.E — Shape Parse (keynote detector)

```
┌──────────────────────────────────────────────────────────────────┐
│  POST /api/shape-parse                                           │
│  src/app/api/shape-parse/route.ts                                │
├──────────────────────────────────────────────────────────────────┤
│   scripts/extract_keynotes.py                                    │
│     OpenCV contour detection + Tesseract OCR per shape           │
│     → list of keynote shapes with text + bbox                    │
│   Wired into the YOLO panel as a "Shape" sub-tab                 │
└──────────────────────────────────────────────────────────────────┘
```

### 6.F — Map Tags (annotations × YOLO matching)

```
┌──────────────────────────────────────────────────────────────────┐
│  POST /api/projects/[id]/map-tags                                │
│  POST /api/projects/[id]/map-tags-batch                          │
├──────────────────────────────────────────────────────────────────┤
│  Match parsed schedule tag column entries against YOLO-detected  │
│  symbol bboxes on the page. Writes mapped annotations to the     │
│  annotations table.                                              │
└──────────────────────────────────────────────────────────────────┘
```

### 6.G — Other user-initiated actions

| Endpoint | Purpose | Subprocess? |
|---|---|---|
| `POST /api/ai/chat/...` | LLM RAG chat over project + page intelligence | LLM API call |
| `POST /api/qto-workflows/[id]` | Auto-quantification (parse schedule + count YOLO) | DB only |
| `POST /api/csi/...` | Manual CSI code edits | DB only |
| `POST /api/annotations/...` | Manual annotation edits | DB only |
| `POST /api/takeoff-groups/...` | Linear/area/count takeoff items | DB only |
| `POST /api/symbol-search/...` | Template matching for similar symbols | `scripts/template_match.py` |
| `POST /api/labeling/...` | Label Studio integration | External API |
| `POST /api/admin/parser-health` | Run diagnostic command in container | spawn() |
| `GET /api/admin/recent-parses` | Read parse-history ring buffer | DB-less |

---

## Persistence layers — what gets written where

```
┌─────────────────────────────────────────────────────────────────┐
│                         AWS S3                                  │
├─────────────────────────────────────────────────────────────────┤
│  s3://{bucket}/{companyDataKey}/{projectId}/                    │
│    ├── original.pdf                       (upload)              │
│    ├── thumbnail.png                      (Stage 3.5)           │
│    ├── pages/page_0001.png                (Stage 4.3)           │
│    ├── pages/page_0002.png                                      │
│    ├── ...                                                      │
│    ├── thumbnails/page_0001.png           (Stage 4.4)           │
│    ├── thumbnails/page_0002.png                                 │
│    └── ...                                                      │
│                                                                 │
│  s3://{bucket}/models/{modelSlug}/model.pt    (admin upload)    │
│  s3://{bucket}/parsed-tables/...              (user save)       │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    PostgreSQL (RDS)                             │
├─────────────────────────────────────────────────────────────────┤
│  projects                                                       │
│    • status, processingTime, jobId                              │
│    • projectIntelligence (jsonb — Stage 5.4)                    │
│    • projectSummary (text — Stage 5.4)                          │
│                                                                 │
│  pages                                                          │
│    • textractData (jsonb)         ┐                             │
│    • rawText                      │                             │
│    • drawingNumber                │                             │
│    • csiCodes (jsonb)             │ Stage 4.15                  │
│    • textAnnotations (jsonb)      │                             │
│    • keynotes (jsonb, null at first; user-initiated later)      │
│    • pageIntelligence (jsonb)     ┘                             │
│      ↳ classification, crossRefs, noteBlocks, textRegions,      │
│        heuristicInferences, classifiedTables, csiSpatialMap     │
│    • search_vector (tsvector) — Stage 4.16                      │
│                                                                 │
│  annotations          (user + YOLO writes)                      │
│  takeoffGroups, takeoffItems  (user)                            │
│  qtoWorkflows         (auto-quantification user flow)           │
│  processingJobs       (Stage 1.4 production path)               │
│  appSettings          (Phase I.2.e tableParse.debugMode lives   │
│                        here, plus other admin toggles)          │
│  models, modelAccess  (YOLO model registry)                     │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│              In-memory (per Node task, lost on restart)         │
├─────────────────────────────────────────────────────────────────┤
│  parseHistory ring buffer  (src/lib/parse-history.ts)           │
│    • Last 50 table-parse requests with FULL methodResults       │
│    • Always populated regardless of debugMode flag              │
│    • Visible in /admin → Table Parsing → Recent Parses          │
│    • Multi-replica ECS gotcha: per-task                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## What the LLM sees (the `pageIntelligence` blob)

When the LLM chat feature runs RAG, it pulls from
`pages.pageIntelligence` per page. That blob is the **canonical context for
the LLM** — it should contain ONLY information the LLM needs to reason
about the page. Per `project_pageintelligence_purpose.md`:

```
pageIntelligence = {
  classification: { discipline, sheetType, ... },
  crossRefs:      [{ from, to, type, ... }],
  noteBlocks:     [{ bbox, text, type }],
  textRegions:    [{ bbox, type, ... }],     // Stage 4.11
  heuristicInferences: [{ rule, label, ... }],  // Stage 4.12
  classifiedTables: [{ bbox, kind, conf }],     // Stage 4.13
  csiSpatialMap:    { rows, cols, grid }        // Stage 4.14
}
```

Things that are intentionally NOT in `pageIntelligence`:
- Per-method debug grids from auto-parse (those live in the
  in-memory ring buffer, not pageIntelligence — Phase D constraint)
- Raw Textract data (lives in `pages.textractData`, separate column)
- The full S3 image bytes
- YOLO bboxes (live in `annotations` table)

---

## Concurrency + retry behavior

| Scope | Concurrency | Retry |
|---|---|---|
| Page processing within a project | 8 in parallel (configurable via `companies.pipelineConfig.pipeline.pageConcurrency`) | None within page; failed pages keep going |
| Step Function task retries | 2 attempts with 30s + backoff | Catches `States.TaskFailed` → ProcessingFailed |
| Per-method timeouts in table-parse | 30s for img2table, 30s for camelot, 60s for table-lines, 60s for TATR | None — wrapper SIGKILLs on timeout |
| YOLO inference | Async via SageMaker | SageMaker retries on its own |
| LLM chat | Streaming | Per-API-call timeouts |

---

## How to verify each stage actually ran

| Stage | Verification |
|---|---|
| 0 — Upload | S3 has `{dataUrl}/original.pdf` |
| 1 — Project create | DB row in `projects` with status ≠ "uploading" |
| 2 — Step Function | `processingJobs.executionId` populated; CloudWatch logs `/aws/states/blueprintparser-process-blueprint` |
| 3 — Setup | `projects.numPages` populated; `thumbnail.png` in S3 |
| 4 — Per-page | Per-page row in `pages` with non-null `textractData` |
| 4.3 — Page PNG | S3 has `pages/page_NNNN.png` |
| 4.4 — Thumbnail | S3 has `thumbnails/page_NNNN.png` |
| 4.6 — Textract | `pages.textractData` jsonb non-null |
| 4.8 — CSI | `pages.csiCodes` jsonb non-null |
| 4.10-4.14 — Intelligence | `pages.pageIntelligence` jsonb non-null |
| 5 — Project rollup | `projects.projectIntelligence` jsonb non-null; `projects.status = completed` |
| 6.A — YOLO | `annotations` rows with `source = "yolo"` |
| 6.B — Auto-parse | `/admin → Table Parsing → Recent Parses` shows the request |
| 6.C — TATR | TATR drill-down in viewer shows cells |

---

## Quick reference — file paths

**Pipeline orchestration:**
- `scripts/process-worker.ts` — container entrypoint
- `src/lib/processing.ts` — `processProject()` the whole pipeline
- `src/app/api/projects/route.ts` — kicks off Step Function
- `src/app/api/processing/webhook/route.ts` — completion handler
- `infrastructure/terraform/stepfunctions.tf` — state machine
- `infrastructure/terraform/ecs.tf` — task definition

**Per-page sub-steps:**
- `src/lib/pdf-rasterize.ts` — Ghostscript wrapper
- `src/lib/textract.ts` — AWS Textract client
- `src/lib/title-block.ts` — drawing number extraction
- `src/lib/csi-detect.ts` — CSI code matching
- `src/lib/text-annotations.ts` — text annotation detection
- `src/lib/page-analysis.ts` — page intelligence (classification, cross-refs, note blocks)
- `src/lib/text-region-classifier.ts` — text region clustering
- `src/lib/heuristic-engine.ts` — rules engine
- `src/lib/table-classifier.ts` — Systems 1-3 table classification
- `src/lib/csi-spatial.ts` — CSI density heatmap
- `src/lib/project-analysis.ts` — project rollup

**Auto-parse (table-parse pipeline):**
- `src/app/api/table-parse/route.ts` — route
- `src/lib/services/table-parse.ts` — methodOcrPositions, methodTextractTables, methodOpenCvLines
- `src/lib/img2table-extract.ts` + `scripts/img2table_extract.py`
- `src/lib/camelot-extract.ts` + `scripts/camelot_pdfplumber_extract.py`
- `src/lib/table-lines.ts` + `scripts/detect_table_lines.py`
- `src/lib/grid-merger.ts` — merge logic
- `src/lib/parse-history.ts` — ring buffer for debug UI

**TATR cell structure:**
- `src/app/api/table-structure/route.ts`
- `src/lib/tatr-structure.ts` + `scripts/tatr_structure.py`
- `models/tatr/` — HuggingFace model files

**Other Python subprocess scripts:**
- `scripts/yolo_inference.py` — SageMaker wrapper
- `scripts/bucket_fill.py` — vector + raster room detection
- `scripts/extract_keynotes.py` — Shape Parse
- `scripts/template_match.py` — symbol search
- `scripts/check_deps.py` — admin diagnostic (Phase I.2.b)
- `scripts/patch_img2table.py` — Docker build-time patch

**Admin debug UI (Phase I):**
- `src/app/admin/tabs/TableParseTab.tsx` — the page
- `src/app/api/admin/parser-health/route.ts` — health check endpoint
- `src/app/api/admin/recent-parses/route.ts` — ring buffer endpoint
- `src/app/api/admin/app-settings/route.ts` — persistent debug toggle

---

*Last updated: 2026-04-10 (during the table-parse fix sprint that introduced
Phase A through Phase I + the camelot debug instrumentation).*

---

## Appendix A — Stage 4 in horizontal column layout

The Stage 4 diagram earlier in this doc is the canonical "show me everything"
view but it's tall. This version groups the 16 sub-steps into 4 horizontal
rows where each row is a logical phase, and the steps inside each row are
arranged left-to-right as columns. Same style as the TL;DR overview at the
top of the file. Use whichever fits your screen.

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│  STAGE 4  ─ Per-page processing                                                          │
│             runs for pages 1..N with concurrency 8                                       │
│             src/lib/processing.ts:124-352                                                │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌─ ROW A: IMAGE PREP + OCR  (sequential left-to-right; S3 writes mid-row) ────────────────┐
│                                                                                          │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐            │
│  │ 4.1 idem │    │ 4.2 ras- │    │ 4.3 up-  │    │ 4.4 ras- │    │ 4.5 if > │            │
│  │ skip if  │───►│ terize   │───►│ load     │───►│ terize   │───►│ 9500 px  │            │
│  │ already  │    │ 300 DPI  │    │ pages/   │    │ thumb at │    │ re-ras-  │            │
│  │ has tex- │    │ for      │    │ p_NNNN   │    │ 72 DPI   │    │ ter at   │            │
│  │ tractData│    │ display  │    │ .png→ S3 │    │ → S3     │    │ safe DPI │            │
│  └──────────┘    └──────────┘    └──────────┘    └──────────┘    └─────┬────┘            │
│                                                                        │                 │
│                                                                        ▼                 │
│                                                              ┌────────────────────┐      │
│                                                              │ 4.6 AWS Textract   │      │
│                                                              │ analyzePageImage-  │      │
│                                                              │ WithFallback()     │      │
│                                                              │ → words, lines,    │      │
│                                                              │   tables, blocks   │      │
│                                                              └─────────┬──────────┘      │
└────────────────────────────────────────────────────────────────────────┼─────────────────┘
                                                                         │
                                                                         ▼
┌─ ROW B: TEXT EXTRACTION  (3 branches fan out from Textract; mostly independent) ────────┐
│                                                                                          │
│       ┌──────────────┐         ┌──────────────┐         ┌──────────────┐                 │
│       │ 4.7 extract  │         │ 4.8 detect   │         │ 4.9 detect   │                 │
│       │ drawing      │         │ CSI codes    │         │ text annota- │                 │
│       │ number from  │         │ from rawText │         │ tions: phone,│                 │
│       │ title block  │         │ via 3-tier   │         │ address, eq. │                 │
│       │ → "A-101"    │         │ matching     │         │ tags, abbr,  │                 │
│       │              │         │              │         │ proper nouns │                 │
│       └──────────────┘         └──────┬───────┘         └──────────────┘                 │
│                                       │                                                  │
│                                       │  csi flows into ALL 4 cascade steps              │
└───────────────────────────────────────┼──────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─ ROW C: INTELLIGENCE CASCADE  (5 steps; each one builds on the previous) ───────────────┐
│                                                                                          │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐            │
│  │ 4.10     │───►│ 4.11     │───►│ 4.12     │───►│ 4.13     │───►│ 4.14 CSI │            │
│  │ page     │    │ classify │    │ heuristic│    │ classify │    │ spatial  │            │
│  │ intelli- │    │ text     │    │ engine   │    │ tables   │    │ heatmap  │            │
│  │ gence:   │    │ regions: │    │ runs in  │    │ Systems  │    │ uses     │            │
│  │ classif. │    │ tables / │    │ text-    │    │ 1-3      │    │ text     │            │
│  │ + cross- │    │ notes /  │    │ only mode│    │ identify │    │ annot. + │            │
│  │ refs +   │    │ specs /  │    │ (no YOLO │    │ WHERE    │    │ classif- │            │
│  │ note     │    │ titles   │    │ data yet)│    │ tables   │    │ ied tabs │            │
│  │ blocks   │    │          │    │          │    │ live     │    │          │            │
│  └──────────┘    └──────────┘    └──────────┘    └──────────┘    └─────┬────┘            │
│                                                                        │                 │
└────────────────────────────────────────────────────────────────────────┼─────────────────┘
                                                                         │
                                                                         ▼
┌─ ROW D: PERSIST + INDEX ────────────────────────────────────────────────────────────────┐
│                                                                                          │
│       ┌────────────────────────────────────┐         ┌────────────────────────┐          │
│       │ 4.15  UPSERT pages row             │         │ 4.16  UPDATE pages     │          │
│       │       writes:                      │────────►│       SET search_vec = │          │
│       │       • textractData (jsonb)       │         │       to_tsvector(     │          │
│       │       • rawText                    │         │         'english',     │          │
│       │       • drawingNumber              │         │         rawText)       │          │
│       │       • csiCodes (jsonb)           │         │                        │          │
│       │       • textAnnotations (jsonb)    │         │ enables full-text      │          │
│       │       • pageIntelligence (jsonb)   │         │ search via tsvector    │          │
│       │         ↳ the LLM context blob     │         │ + GIN index            │          │
│       └────────────────────────────────────┘         └─────────┬──────────────┘          │
│                                                                │                         │
└────────────────────────────────────────────────────────────────┼─────────────────────────┘
                                                                 │
                                                                 ▼
                                                  pagesProcessed++
                                                  (next page in mapConcurrent
                                                   pool, then Stage 5 rollup)
```

**How to read this layout:**

- **Row A** is sequential image work — each step depends on the previous. The
  S3 writes happen as side effects in 4.3 and 4.4 without breaking the chain.
- **Row B** is the fan-out: once Textract has run (end of Row A), three text
  extraction methods can run independently. In the actual code they run
  sequentially in JS but there are no data dependencies between them — only
  CSI's output flows into Row C.
- **Row C** is the strict cascade — each intelligence step uses the previous
  ones. This is why the original vertical layout is so tall: there's nothing
  to parallelize here.
- **Row D** is the database write phase. Two steps: the page row upsert plus
  the tsvector update for full-text search.

**Per-row failure semantics** (matches the original vertical version): each
sub-step is wrapped in try/catch that logs `[processing] <step> FAILED for
page N` and falls through with empty/null defaults. Failure of one sub-step
within a page does NOT abort the whole page — Textract failing means CSI gets
empty rawText and so on, but the page row is still upserted at 4.15 with
whatever made it that far. Only an unhandled exception in the outer try/catch
counts as a `pageError` and falls into the catch at line 327.
