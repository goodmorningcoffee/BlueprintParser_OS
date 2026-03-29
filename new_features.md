# PDF Viewer — Feature & Button Reference

Used as source material for help mode tooltips. 151 interactive elements across 7 panels.

---

## Toolbar

| Button | What It Does |
|--------|-------------|
| Pointer/Select | Switch to pointer mode — click annotations to select, click keynotes to filter |
| Pan/Zoom | Switch to pan mode — click-drag to scroll the blueprint |
| Add Markup | Draw named bounding boxes on the blueprint as annotations |
| Symbol Search | Draw a BB around any symbol to find all matching instances across all pages using template matching (two-tier: matchTemplate + SIFT fallback) |
| Search text... | Full-text search across all OCR text — highlights matches on canvas, filters pages in sidebar |
| Trade filter | Dropdown to filter annotations by trade (Structural, Mechanical, Electrical, etc.) |
| CSI Codes | Searchable dropdown to filter by CSI MasterFormat code |
| Keynote toggle (eye) | Show/hide keynote shape overlays on canvas |
| YOLO | Toggle YOLO detection panel — per-model enable/disable and confidence sliders |
| Text | Toggle Text Panel (OCR text, text annotations, graph view, markups list) |
| CSI | Toggle CSI Panel (page/project scope, division breakdown, network graph) |
| LLM Chat | Toggle AI chat panel — chat with your blueprints using context from OCR, annotations, CSI codes |
| Intel | Toggle Page Intelligence Panel (classification, cross-refs, note blocks, detected regions, heuristics) |
| QTO | Toggle Quantity Takeoff Panel (count markers + area polygons with calibrated measurements) |
| Schedules/Tables | Toggle Table/Schedule parsing panel |
| Keynotes | Toggle Keynote parsing panel |
| Menu | Dropdown: Data Labeling wizard, Export PDF (coming soon), Settings, Help |

---

## Symbol Search Panel (floating)

| Element | What It Does |
|---------|-------------|
| Confidence slider | Filter matches by minimum confidence (drag to show more/fewer results) |
| Per-page groups | Click a page to navigate — shows match count per page |
| Dismiss match (x) | Remove a false positive from results |
| Close (x) | Clear search results and return to normal view |

When active: all other annotations dim to 20% opacity, matched symbols highlighted in cyan.

---

## YOLO Detection Panel

### Models Tab
| Button | What It Does |
|--------|-------------|
| Min Confidence slider | Global threshold — detections below this are hidden |
| Per-model checkbox | Enable/disable a specific YOLO model's detections |
| Per-model confidence slider | Adjust confidence per model independently |
| CSI Tags (expand) | View/edit CSI codes assigned to each YOLO class |
| Save to Project | Save CSI tag overrides for this project |
| Revert to Global | Discard project overrides, use global defaults |
| Class name click | Filter page sidebar + highlight all detections of that class |

### Tags Tab
| Button | What It Does |
|--------|-------------|
| Create Tag | Enter tag-picking mode — click any YOLO annotation on canvas to create a named tag from its OCR text. Scans all pages for matching instances. |
| Tag expand/collapse | Show instances per page for this tag |
| Tag visibility toggle | Show/hide tag highlighting on canvas |
| Rename tag (pencil) | Edit tag display name inline |
| Delete tag (x) | Remove tag and all instances |
| Page number click | Navigate to that page |

Tags are organized: Model > Class > Tag. Three sources: keynote (page-scoped), schedule (project-wide), manual.

---

## Keynote Panel

### All Keynotes Tab
| Element | What It Does |
|---------|-------------|
| Keynote table expand/collapse | Show/hide individual keynote keys within a parsed table |
| Click table name | Inline rename the keynote table |
| Delete table (x) | Remove entire parsed keynote table |
| Double-click table | Navigate to the page containing this keynote table |
| Click keynote key | Highlight all instances of this keynote on the current page + activate YoloTag filter |
| Pencil icon per key | Edit CSI codes and notes for this specific keynote key |
| Instance count badge | Shows how many times this keynote was found on the page (after tag mapping) |

### Auto Parse Tab
| Button | What It Does |
|--------|-------------|
| Draw Keynote Region | Enter drawing mode — draw BB around the keynote table grid only (exclude title) |
| Cancel Drawing | Exit drawing mode without saving |
| Process Region | Send the drawn region to the server for ML-based auto-parsing |
| Clear Region | Discard the drawn region and start over |
| Parse Another | Reset after successful parse to parse a different keynote table |
| Detected Keynote Tables (info) | Shows auto-classified keynote regions found during processing (informational only) |

### Manual Parse Tab
| Button | What It Does |
|--------|-------------|
| Step 1: Draw Keynote Region | Draw BB around the table grid (exclude floating titles) |
| Clear (Step 1) | Discard region and start over |
| Step 2: Draw Columns | Draw BB around each column — first column = tag/key column, second = description |
| Repeat Right | Auto-duplicate the last drawn column rightward to fill the region |
| YOLO class picker | If YOLO shapes exist in the tag column, select which class to assign |
| Step 3: Draw Rows | Draw BB around each row |
| Repeat Down | Auto-duplicate the last drawn row downward to fill the region |
| Step 4: Parse Keynotes | Extract key-description pairs from the column/row intersections |
| Reset All | Clear all drawings and start from Step 1 |

### BB Drawing Rules
- Draw around the TABLE GRID ONLY — exclude any title text floating above the table
- Small overlap between column/row BBs is fine — OCR word centers determine cell assignment
- BB resolution is based on the full PDF, not the zoom level

---

## Schedules / Tables Panel

### All Tables Tab
| Element | What It Does |
|---------|-------------|
| Table expand/collapse | Show/hide individual rows as tag sub-items |
| Click table name | Inline rename the table |
| Delete table (x) | Remove entire parsed table |
| Double-click table | Navigate to the page containing this table |
| CSI badges | Auto-detected CSI codes from table content (detected server-side) |
| View / Edit button | Open the parsed grid in the Compare/Edit modal for cell-by-cell editing |
| Map Tags button | Open tag mapping UI to create YoloTags from the tag column |
| Click row/tag sub-item | Highlight all instances of this tag across all pages + filter page sidebar |
| Pencil icon per row | Edit CSI codes and notes for this specific row |
| Instance count badge | Shows how many times this tag was found across all pages (after mapping) |

Tables on the current page are sorted to the top of the list.

### Map Tags UI (inside expanded table)
| Element | What It Does |
|---------|-------------|
| Tag Column dropdown | Select which column contains the tag values (auto-detects tag patterns) |
| Free-floating button | Tags are plain text codes on the blueprint (no YOLO shape) |
| YOLO Shape button | Tags are inside YOLO-detected shapes |
| YOLO class picker | Select which YOLO model + class contains the tag shapes |
| Run Mapping | Search all pages for each tag value, create YoloTag entries with instance counts |
| Cancel | Close the Map Tags UI |

### Auto Parse Tab
| Button | What It Does |
|--------|-------------|
| Draw Table Region | Enter drawing mode — draw BB around the table grid only (exclude title) |
| Cancel Drawing | Exit drawing mode |
| Detected tables (info) | Shows auto-classified table regions found during processing |
| Previously Parsed (buttons) | Click to reload a previously-parsed table |
| Export CSV | Download parsed table as CSV file |
| View All Tables | Switch to All Tables tab |
| Parse Another | Reset and parse another table |
| Map Tags section | Same as All Tables Map Tags (tag column + YOLO class picker) |

### Manual Tab
| Button | What It Does |
|--------|-------------|
| Step 1: Draw Table Region | Draw BB around table grid (exclude titles) |
| Clear (Step 1) | Discard region only (preserves columns/rows if already drawn) |
| Step 2: Draw Columns | Draw column boundaries left-to-right. First column = tag/key column. |
| Column name inputs | Name each column (auto-fills with Column A, B, C...) |
| Repeat Right | Auto-duplicate last column rightward |
| Step 3: Draw Rows | Draw row boundaries |
| Repeat Down | Auto-duplicate last row downward |
| Step 4: Parse Cells | Extract cell values from column/row intersections using OCR word positions |
| Reset | Clear everything and start over |

### Compare / Edit Cells Tab
| Element | What It Does |
|---------|-------------|
| Table selector | Pick a parsed table to compare/edit |
| Side-by-side view | Shows original PDF crop next to parsed grid |
| Click cell | Select cell for editing |
| Edit cell inline | Modify parsed cell text |
| Edit header | Rename column headers |
| Done button | Save edits back to pageIntelligence and close modal |

---

## Canvas Visibility Toggle

Both Keynote and Table panels have a filled/empty circle toggle (●/○) in the header:
- **Filled (●)** = Region outlines visible on canvas
- **Empty (○)** = Region outlines hidden

Controls visibility of: parse region BB, column BBs, row BBs.

---

## Quantity Takeoff Panel

### Count Tab
| Element | What It Does |
|---------|-------------|
| + Add Count Item | Create a new count-based takeoff item |
| Click item | Select item for placing markers — click on blueprint to place count markers |
| Edit (gear icon) | Open color picker, shape picker (circle/square/diamond/triangle/cross), size slider, notes |
| Rename (pencil) | Edit item name inline |
| Delete (x) | Remove item and all its markers |
| Stop Takeoff | Deselect current item, stop placing markers |
| CSV export | Download all count items as CSV |

### Area Tab
| Element | What It Does |
|---------|-------------|
| + Add Area Item | Create a new area-based takeoff item |
| Click item | Select item for drawing polygons — click vertices on blueprint, double-click to close |
| Calibration: Set Scale | Draw a line between two known points, enter real-world distance |
| Calibration: Clear | Remove scale calibration for current page |
| Edit (gear icon) | Open color picker, size slider, notes |
| Undo Last Vertex | Remove the last polygon vertex while drawing |
| CSV export | Download all area items with calculated measurements |

---

## Page Sidebar

| Element | What It Does |
|---------|-------------|
| Page thumbnails | Click to navigate, rendered at 72 DPI |
| Group by Sheet toggle | Group pages by discipline prefix (A-, E-, M-, etc.) |
| Filter badges | Show match counts per page when filters are active |
| Active filter indicators | Show which filters are active (search, trade, CSI, annotation, tag, symbol search) with clear (x) buttons |

Filters stack — multiple filters can be active simultaneously. Pages matching ALL active filters are shown.

---

## CSI Panel

| Element | What It Does |
|---------|-------------|
| Page / Project scope toggle | Switch between page-level and project-level CSI view |
| Search input | Filter CSI codes by number or description |
| Division expand/collapse | Show/hide codes within a CSI division |
| Click CSI code | Filter annotations + highlight matching text on canvas |
| Network Graph (project scope) | Shows CSI division co-occurrence relationships and trade clusters |

---

## Admin CSI Config (admin panel)

| Element | What It Does |
|---------|-------------|
| Detection Matching help (expandable) | Explains three-tier CSI detection: Tier 1 exact phrase (95%), Tier 2 scattered words (configurable), Tier 3 anchor keywords (configurable) |
| Confidence Threshold slider | Minimum score to report a CSI match (0.1-0.9) |
| Tier 2 Weight slider | Max confidence for non-consecutive word matching (0.3-0.95) |
| Tier 3 Weight slider | Max confidence for anchor-word matching (0.2-0.7) |
| Tier 2/3 Min Words | Minimum significant words needed to activate each tier |
| Annotation Tagging help (expandable) | Explains keyword overlap, min matches, max tags per annotation |
| Keyword Overlap slider | % of CSI words that must appear in annotation text (0.3-0.9) |
| Min Word Matches | Absolute minimum word matches required |
| Max Tags per Annotation | Cap on CSI codes per annotation for LLM context |
| YOLO Class CSI Tags | Assign CSI codes + keywords to each YOLO detection class |
| Save CSI Tags | Persist class-level CSI assignments |
| Reprocess YOLO Tags | Re-apply CSI codes to all existing YOLO detections |
| Upload Custom CSI Database | Upload TSV/CSV/JSON with custom CSI codes |
| Revert to Built-in | Reset to MasterFormat 2018+2016 database |
