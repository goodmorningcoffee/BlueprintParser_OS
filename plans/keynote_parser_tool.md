# Plan: Keynote Parser Tool (Panel + YOLO Tag Mapping)

## Date: March 29, 2026

---

## Overview

A dedicated "Keynotes" toolbar button and panel for parsing keynote tables from blueprints. Keynotes are key:value tables where the key is a shape+alphanumeric code scattered across drawings, and the value is a description. Page-specific by default.

---

## Panel Structure

**Toolbar button**: "Keynotes" — separate from Schedules/Tables, own panel

**3 sub-tabs:**
1. **All Keynotes** — project-wide list of parsed keynotes, expandable items, click to highlight instances
2. **Auto Parse** — shows classified keynote regions (from Systems 1-3), click to auto-parse
3. **Manual Parse** — step-by-step: draw keynote region → draw tag column → draw description column → draw rows → assign YOLO class

---

## Manual Parse Workflow

### Step 1: Draw BB around entire keynote table
### Step 2: Draw Column A (keynote tags — first column drawn = Column A)
- This is almost always the leftmost column containing shapes with codes
- System checks: are there YOLO annotations falling inside this column?
- If yes, show them grouped by YOLO class with count
- User picks one: "This YOLO class represents the keynote shape for this table"
### Step 3: Draw Column B (keynote descriptions)
- Optional: draw additional columns if >2 exist
### Step 4: Draw rows (top to bottom, draw order = row order)
- Row 1 first, Row 2 next, etc.
- "Repeat Down" to tile uniform rows
### Step 5: Parse
- Intersection of columns × rows = cells
- OCR auto-fills each cell
- Column A values become keynote keys
- Column B values become keynote descriptions
- YOLO class from Step 2 becomes the keynote_shape

### Column/Row Draw Order (applies to schedules too)
- First column drawn = Column A (index 0)
- Second column drawn = Column B (index 1)
- First row drawn = Row 1 (index 0)
- This enforced sequence defines the grid coordinates

---

## YOLO Tag Mapping (Post-Parse)

After keynotes are parsed with a YOLO class assigned:

1. Find all YOLO detections of that class on the current page
2. For each detection, extract OCR text inside its bbox
3. If text matches a parsed keynote key → link detection to keynote description
4. Store: `{ annotationId, keynoteKey, keynoteDescription, pageNumber, yoloClass }`

Result: clicking a keynote callout shape on the drawing shows its full description.

---

## All Keynotes Tab

- List of all parsed keynotes in project, sorted with current-page keynotes at top
- Each keynote item is collapsible:
  - Collapsed: shows page name + number of keynote entries
  - Expanded: shows list of alpha-numeric codes (keys)
  - Click a key → highlights all instances of that keynote on ONLY its page
- Toggle visibility: individual keynotes on/off + "show all" / "hide all"
- When visible: BB around keynote table + BB around each tag in the tag column
- Pointer/select tool: click a keynote tag BB on the canvas → highlights all instances of that keynote on the page
- Color customization per keynote table (follows same pattern as schedule tables)

---

## Auto Parse

- Shows pages where keynote tables were classified by Systems 1-3
- Current-page matches highlighted at top
- Click to auto-parse using the multi-method API endpoint
- For keynotes, the parser should use the same 3 methods (OCR positions, Textract TABLES, OpenCV lines) but with keynote-specific heuristics:
  - Usually 2 columns (tag + description)
  - Tag column is narrow, description column is wide
  - Tags are short alphanumeric codes, descriptions are sentences

---

## Existing Code to Refactor

- `src/lib/keynotes.ts` — current OpenCV+Tesseract keynote shape extractor
  - Currently runs at upload in processing.ts → make user-initiated
  - Finds individual keynote shapes (ovals/circles with text)
  - This is complementary to the table parser — it finds shapes on drawings, table parser reads the legend
- `processing.ts` — remove `extractKeynotes()` call from upload pipeline
- `src/lib/page-analysis.ts` — has note block detection that could inform keynote table location

---

## New Files

- `src/components/viewer/KeynotePanel.tsx` — new panel with 3 sub-tabs
- `src/stores/viewerStore.ts` — add keynote panel state (showKeynotePanel toggle, keynote parse state)
- `src/components/viewer/ViewerToolbar.tsx` — add "Keynotes" button

---

## Dependencies

- Systems 1-3 classification (keynote-table category) — ALREADY BUILT
- YOLO detection data available in viewer store — ALREADY EXISTS
- tag-patterns.ts bbox intersection — ALREADY EXISTS
- Multi-method table parse API — JUST BUILT (reusable for keynotes)
- Canvas overlay rendering for keynote highlights — pattern EXISTS in AnnotationOverlay

---

## Build Order

1. Remove `extractKeynotes()` from processing.ts
2. Add "Keynotes" toolbar button + panel scaffold
3. Build Manual Parse tab with enforced draw order
4. Build YOLO class picker for tag column
5. Build intersection-based parsing
6. Build YOLO tag mapping (link parsed keys to drawing callouts)
7. Build All Keynotes tab with expand/collapse + instance highlighting
8. Build Auto Parse tab with classified region listing
9. Wire canvas highlighting for keynote visibility toggles
