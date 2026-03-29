# Table/Schedule/Keynote Parsing + OCR Architecture Discussion

## Date: March 29, 2026

---

## Two Parallel Pipelines That Converge

### Pipeline 1: Automated Classification + Parsing

Already built (Systems 1-3):
- System 1: OCR text region classifier (`text-region-classifier.ts`) — detects table-like, notes-block, spec-text, key-value from word positions
- System 2: Heuristic engine (`heuristic-engine.ts`) — YOLO + keyword rules with spatial operators
- System 3: Table meta-classifier (`table-classifier.ts`) — combines Systems 1+2 into confident classifications (keynote-table, door-schedule, finish-schedule, etc.)

**Not yet built:**
- System 4: Table parser — extracts structured key:value data from classified regions
- YOLO-tag-mapping — correlates parsed keynote keys with YOLO shapes on drawing pages

**The chain:** classify → parse → link → export

Each step has standalone value:
- Classify alone → LLM knows "this page has a door schedule"
- Parse alone → LLM gets structured key:value data, table → CSV export works
- Link alone → keynote symbols on drawings map back to their descriptions
- All together → CSI codes propagate from keynote descriptions to specific drawing locations

### Pipeline 2: Semi-Manual User UI

A viewer tool (its own button/menu in PDF viewer) where users can:
- Draw BB around a table to define it
- Draw BBs around individual keynote keys (OCR auto-suggests tag text from bbox overlap)
- Draw BBs around keynote descriptions (OCR auto-suggests description text)
- System links key → description
- Same interface for material schedules, symbol legends — different sub-menus
- "Auto-parse" button runs automated pipeline, user edits results

**Convergence:** Both pipelines produce same output format — structured key:value mappings with CSI tags and spatial locations. Manual UI is fallback/correction for when automation fails.

---

## YOLO-Tag-Mapping (Technically Feasible)

The infrastructure already exists:
- `tag-patterns.ts` does bbox intersection of YOLO shapes with OCR text
- `spatial.ts` has the center-in-bbox algorithm
- Keynote linking is the same operation: find YOLO ovals on drawing pages → check overlapping text matches parsed keynote key ("01", "02") → link to description

**Key domain rule:** Keynotes are page-specific by default. Keynote "01" on A-100 ≠ keynote "01" on E-100. The linking system must scope per-page.

**The flow:**
1. Classify keynote table region on page (Systems 1-3 — done)
2. Parse the table: extract key:value pairs with associated shapes (System 4 — not built)
3. On the same page, find YOLO detections of matching shapes (ovals, hexagons, etc.)
4. For each YOLO detection, check if overlapping OCR text matches a parsed keynote key
5. If match → link detection to keynote description
6. Result: every keynote symbol on the drawing resolves to its full description

---

## Table Parsing Feasibility

**Small/medium tables (keynotes, 10-30 rows):** Feasible with current Textract OCR. Word-level bboxes allow inferring column boundaries (X-coordinate clustering) and row boundaries (Y-coordinate gaps). No new OCR needed.

**Large tables (full-sheet schedules, 200+ rows, 15 columns):** Hard with positional OCR alone. Textract gets the text but cell structure inference gets noisy at scale. This is where visual LLMs add value — they can "see" grid lines and structure.

**Reference:** Cofounder's `schedule_table_parse_LS/` repo has parsing strategies for large tables. Pull useful bits from there.

---

## OCR Architecture: Two Layers

### Layer 1: Base OCR (always runs)
- **Purpose:** Word-level bboxes for ALL spatial features (search, CSI tagging, spatial mapping, text annotations, tag patterns)
- **Current:** AWS Textract (production) → Tesseract fallback (local/self-hosted)
- **Output format:** `TextractPageData { words: [{text, bbox, confidence}], lines: [...] }`
- **Key constraint:** MUST produce word-level bboxes. Everything downstream depends on spatial positions.
- **Swap complexity:** Low. `textract.ts` already abstracts behind `analyzePageImageWithFallback()`. Any new provider just needs to output `TextractPageData` format.

### Layer 2: Table OCR (runs only on classified table regions)
- **Purpose:** Structured row/column extraction from table images
- **Trigger:** Only runs on regions classified as tables by Systems 1-3
- **Input:** Cropped image of the classified table region (not full page)
- **Output:** Structured JSON — rows, columns, cell values, headers
- **Providers:** Visual LLMs (Mistral, GPT-4o vision, Claude vision) — they "see" grid lines and structure that positional OCR misses
- **Cost control:** Only send table regions, not full pages. A 50-page blueprint might have 5-10 table regions.

### Why Two Layers (Not Replace)
Visual LLMs do NOT return word-level bboxes. They return text/structured data. So they can't replace Textract for spatial features — we need both:
- Textract → spatial word positions for everything
- Visual LLM → structured table data for parsing specifically

### Admin OCR Sub-Menu (Proposed)
- Configure base OCR provider: Textract (default) | Tesseract (free/local) | future providers
- Configure table OCR provider: None (default) | Mistral | GPT-4o | Claude | custom endpoint
- API key management (reuse existing LLM config pattern)
- Per-provider settings (model selection, temperature for table parsing prompts)
- "Test OCR" button similar to existing LLM config test

---

## Build Order

1. **System 4: Automated table parser** — takes classified regions, uses OCR word positions to extract key:value structure. Start with keynote tables (simplest: symbol column + description column).
2. **YOLO-tag-mapping** — link parsed keynote keys to YOLO detections on drawing pages. Reuse tag-patterns.ts infrastructure.
3. **Viewer UI for manual table/keynote definition** — BB drawing tool for defining tables, keys, descriptions. OCR auto-suggestion from bbox overlap.
4. **OCR provider abstraction** — admin sub-menu for swapping base OCR and adding table OCR providers.
5. **Large table parsing with visual LLMs** — crop classified table regions, send to visual LLM, parse structured response.
