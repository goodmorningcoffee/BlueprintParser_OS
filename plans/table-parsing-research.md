# Table Parsing Research — Blueprint-Optimized Extraction

## Current Architecture (3-Method Merge)

BlueprintParser uses three parallel table detection methods, merges them via confidence-weighted grid merger:

### Method 1: OCR Word Positions (`route.ts`)
- Clusters Textract OCR words by Y-coordinate into rows
- Detects columns from X-position gaps
- Scores by header keyword matches, tag column detection, cell consistency
- **Strengths:** Works on borderless tables, handles text-only schedules
- **Weaknesses:** Misses visual structure, can't detect merged cells, sensitive to row tolerance

### Method 2: AWS Textract Tables (`route.ts`)
- Uses Textract's built-in table detection (AWS black box)
- Handles merged cells and nested headers natively
- **Strengths:** Best for standard table formats, handles complex structures
- **Weaknesses:** Not tunable, requires AWS, sometimes misses tables entirely

### Method 3: OpenCV Line Detection (`detect_table_lines.py`)
- Adaptive threshold → morphological open with H/V kernels → contour filtering → line clustering
- **Strengths:** Detects physical grid lines, scale-independent
- **Weaknesses:** Single-pass kernel, misses thin/partial/dashed lines, no merged cell detection, no skew correction, fixed 150 DPI

### Grid Merger (`grid-merger.ts`)
- Picks highest-confidence method as base
- Fills empty cells from other methods
- Flags disagreements (edit distance > 2)
- Computes blended confidence: `base * 0.6 + agreement * 0.3 + methodBonus`

---

## Blueprint-Specific Challenges

Construction blueprint tables (door schedules, finish schedules, equipment lists) are uniquely hard:

- **Scanned documents** — noise, skew, fold lines, stamp marks, yellowed paper
- **Mixed text orientation** — horizontal and vertical text in same table
- **Nested columns** — one column contains two sub-columns; merged cells span 2-5 columns
- **Nested headers / hierarchies** — multi-row headers with merged cells representing groups
- **Thick rows from wrapped text** — parsing incorrectly splits into multiple rows
- **Borderless/partial-border tables** — some schedule formats use whitespace instead of lines
- **Massive tables** — door schedules with 50+ rows, 20+ columns spanning full pages
- **Thin hairline grid lines** — can be 1-2px at scan resolution, lost in thresholding
- **Dashed/dotted dividers** — discontinuous lines that morphological ops can't detect

---

## Open-Source Landscape (Researched April 2026)

### img2table (Most relevant to us)
- **GitHub:** https://github.com/xavctn/img2table
- **License:** MIT
- Python library for image/PDF table extraction using OpenCV
- Uses **Hough Transform** (not just morphological ops) as backbone
- Handles **merged cells** natively
- Corrects **skew and rotation** as preprocessing
- Supports multiple OCR backends: Tesseract, AWS Textract, PaddleOCR, Google Vision, Azure OCR
- Lighter than neural network approaches, runs on CPU
- **Why it matters:** Does everything our OpenCV method does, plus merged cells, Hough lines, and skew correction

### Camelot
- **GitHub:** https://github.com/atlanhq/camelot
- **License:** MIT
- Two modes: "Lattice" (line-based) and "Stream" (text-positioning)
- Our architecture already mirrors this dual approach (Method 1 ≈ Stream, Method 3 ≈ Lattice)
- Camelot's Lattice mode does multi-scale line detection and joint line analysis
- **Limitation:** Only works on native PDFs, not scanned documents

### Microsoft Table Transformer (TATR)
- **GitHub:** https://github.com/microsoft/table-transformer
- **License:** MIT
- Deep learning model (DETR-based) for table detection + structure recognition
- Outputs full bounding boxes for all cells including blank cells, rows, columns, headers
- Trained on PubTables-1M dataset
- State of the art accuracy but requires GPU
- **Why it matters:** Could be a 4th method — detect table structure as object detection, similar to how we already use YOLO. Would need SageMaker or local GPU.

### pdfplumber
- **PyPI:** https://pypi.org/project/pdfplumber/
- Reads actual line/rect vector objects from PDF structure
- Extremely precise for digitally-generated blueprints (not scanned)
- Doesn't help for scanned docs
- **Why it matters:** For CAD-exported PDFs, could provide perfect grid lines without any image processing

### Other Notable Tools
- **Tabula** — Java-based, popular, has Lattice + Stream modes. Python wrapper available. Only native PDFs.
- **Marker** — PDF to markdown, good for document structure but not table-specific
- **Docling** — Enterprise RAG document understanding
- **Unstructured** — Multi-format document parsing with table support

---

## Blueprint-Optimized Table Extractor — Ideal Pipeline

```
1. PREPROCESSING
   ├── Skew detection + correction (Hough-based angle estimation)
   ├── Noise reduction (median blur for scan artifacts)
   ├── Contrast enhancement (CLAHE for faded/yellowed prints)
   └── DPI adaptation (scale based on region size)

2. LINE DETECTION (multi-strategy, merge results)
   ├── Morphological detection (current — good for thick lines)
   ├── Hough line transform (good for thin/partial/dashed lines)
   ├── PDF vector line extraction (for native PDFs, via pdfplumber)
   ├── Multi-scale kernels (2-3 sizes to catch both borders and dividers)
   └── Merge all detected lines → cluster → deduplicate

3. GRID CONSTRUCTION
   ├── Build intersection graph from H/V lines
   ├── Detect merged cells (missing internal borders)
   ├── Infer missing boundaries from OCR word alignment
   ├── Handle partial borders (extend lines to nearest intersection)
   └── Validate grid regularity (flag irregular cells)

4. CELL CONTENT EXTRACTION
   ├── Map OCR words to cells by center-point containment
   ├── Handle vertical text (detect rotation, re-OCR if needed)
   ├── Handle wrapped text (merge multi-line within cell bounds)
   └── Handle nested content (sub-cells within merged cells)

5. STRUCTURE RECOGNITION
   ├── Detect header rows (keyword + position heuristics)
   ├── Detect nested headers (merged cells spanning columns)
   ├── Detect tag/key columns (regex + frequency analysis)
   ├── Detect hierarchical structure (indent levels, grouping)
   └── CSI code detection on parsed grid
```

### For Massive Tables
- **Adaptive DPI:** Small tables → 300 DPI. Full-page tables → 150-200 DPI
- **Row-group processing:** Detect major horizontal dividers first, process each group independently
- **Progressive refinement:** Coarse grid (major lines) → subdivide (minor lines)
- **Tiled processing:** Split very large images into overlapping tiles, detect lines per tile, stitch
- **Memory management:** Stream row-by-row instead of loading full grid

---

## Phase 2 Implementation Plan (Future Sprint)

### Step 1: Add Hough Line Transform to detect_table_lines.py
- Run `cv2.HoughLinesP()` alongside morphological detection
- Merge Hough segments with morphological lines
- Hough catches thin/partial/dashed lines that morphological misses
- Deduplicate by clustering nearby parallel lines

### Step 2: Add Skew Correction
- Detect dominant line angle via Hough
- If skew > 0.5 degrees, rotate image to correct
- Re-run detection on corrected image

### Step 3: Add Multi-Scale Kernel Detection
- Run morphological detection at 3 kernel sizes: 3%, 5%, 8% of image dimension
- Merge results — catches both thick borders and thin dividers

### Step 4: Add Merged Cell Detection
- After grid construction, check each internal boundary
- If no line detected between two adjacent cells, mark as merged
- Return merge info in grid structure (rowspan/colspan)

### Step 5: Text-Guided Boundary Repair
- When OpenCV misses a boundary, check OCR word positions
- If there's a consistent text alignment gap at that X/Y position across rows, insert virtual boundary
- This is unique to BlueprintParser — general tools don't have OCR data available during line detection

### Step 6: img2table Integration — DONE (2026-04-09)
- Added as Method 4 in 7-method merge pipeline
- `scripts/img2table_extract.py` + `src/lib/img2table-extract.ts`
- Uses Hough Transform + morphological + skew correction + merged cell detection
- Requires Debian slim Docker base (not Alpine) due to polars dependency

### Step 7: TATR (Table Transformer) Integration — DONE (2026-04-09)
- Added as post-processing step (manual "Detect Cell Structure" button)
- Model: `microsoft/table-transformer-structure-recognition-v1.1-all` (115MB) in `/models/tatr/`
- Runs on CPU (1-3s per cropped table region), no SageMaker needed
- `scripts/tatr_structure.py` + `src/lib/tatr-structure.ts` + `POST /api/table-structure`
- Cell bboxes stored in separate `tableCellStructure` store field
- Canvas: dashed cyan borders, click = search, double-click = toggle highlight

---

## Current Tunable Parameters (Phase 1 — Exposed to Users)

### OCR Parsing (Method 1) — 4 controls
| Parameter | Default | Range | Effect |
|-----------|---------|-------|--------|
| ROW_Y_TOL | 0.006 | 0.002–0.02 | Row clustering tolerance — larger merges thick/wrapped rows |
| MIN_COL_GAP | 0.015 | 0.005–0.05 | Min gap to split columns — larger = fewer columns |
| minHitsRatio | 0.3 | 0.1–0.6 | % of rows a column must span to count |
| Header mode | auto | auto/first/none | Override header row detection |

### OpenCV Lines (Method 3) — 3 controls
| Parameter | Default | Range | Effect |
|-----------|---------|-------|--------|
| min_length_ratio (horiz) | 0.15 | 0.05–0.5 | Reject H-lines shorter than X% of width |
| min_length_ratio (vert) | 0.10 | 0.05–0.5 | Reject V-lines shorter than X% of height |
| tolerance | 15px | 5–50px | Line clustering distance |

### Merger — 1 control
| Parameter | Default | Range | Effect |
|-----------|---------|-------|--------|
| editDistance | 2 | 0–5 | Cell agreement fuzziness between methods |

---

## References
- img2table: https://github.com/xavctn/img2table
- Camelot: https://github.com/atlanhq/camelot
- Microsoft TATR: https://github.com/microsoft/table-transformer
- pdfplumber: https://pypi.org/project/pdfplumber/
- Best Python PDF Table Libraries 2026: https://unstract.com/blog/extract-tables-from-pdf-python/
- OCR in Construction Blueprints: https://blog.sonarlabs.ai/resources/ocr-meaning-in-construction-blueprint-management
- Blueprint OCR Challenges: https://mobidev.biz/blog/ocr-system-development-blueprints-engineering-drawings
