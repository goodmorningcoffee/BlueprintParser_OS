/**
 * Centralized tooltip content for Help Mode.
 * Edit THIS FILE to change any tooltip wording — no component changes needed.
 *
 * Format: { title: "Short Name", body: "What it does. How to use it. Future plans." }
 */
export const HELP_TOOLTIPS: Record<string, { title: string; body: string }> = {

  // ═══════════════════════════════════════════════════════════
  // TOOLBAR MODES
  // ═══════════════════════════════════════════════════════════
  "pointer-mode": {
    title: "Pointer/Select",
    body: "Double-click any OCR'd word on the blueprint to search all pages for it. Select and edit all annotations — click a markup to see the edit (pencil) and delete (x) icons. Drag selected markups to reposition them. Double-click any annotation to filter pages showing that item.",
  },
  "pan-mode": {
    title: "Pan/Zoom",
    body: "Click and drag to scroll around the blueprint. Mouse wheel zooms in this mode. Tip: Ctrl + scroll wheel zooms in ANY mode, so you rarely need to switch here.",
  },
  "markup-mode": {
    title: "Add Markup",
    body: "Click and drag to draw a rectangle on the blueprint. A dialog will ask for a name and optional notes — notes are visible in the Text panel's Markups tab and are shared with the AI chat for context.",
  },

  // ═══════════════════════════════════════════════════════════
  // ZOOM
  // ═══════════════════════════════════════════════════════════
  "zoom-in": {
    title: "Zoom In",
    body: "Increase zoom level. Shortcut: Ctrl + scroll wheel works in any mode.",
  },
  "zoom-out": {
    title: "Zoom Out",
    body: "Decrease zoom level. Shortcut: Ctrl + scroll wheel works in any mode.",
  },
  "zoom-fit": {
    title: "Fit to Window",
    body: "Reset zoom to 100% and center the blueprint in the viewport.",
  },

  // ═══════════════════════════════════════════════════════════
  // MENU
  // ═══════════════════════════════════════════════════════════
  "menu-button": {
    title: "Menu",
    body: "Access Data Labeling (Label Studio integration), export options (coming soon), settings (coming soon), and the Help banner toggle.",
  },

  // ═══════════════════════════════════════════════════════════
  // SEARCH & FILTERS
  // ═══════════════════════════════════════════════════════════
  "search-bar": {
    title: "Text Search",
    body: "Search OCR-extracted text across all pages. Matching pages are filtered in the sidebar with word-count badges. Words are highlighted in magenta on the blueprint. Tip: double-click any word on the blueprint to auto-populate this search box.",
  },
  "trade-filter": {
    title: "Trade Filter",
    body: "Filter pages by construction trade (Electrical, Mechanical, Plumbing, etc.). Based on CSI code detection. Matching text is highlighted on the blueprint. Select 'All Trades' to clear the filter.",
  },
  "csi-filter": {
    title: "CSI Code Filter",
    body: "Filter pages by a specific CSI MasterFormat code (e.g., 09 21 16 — Gypsum Board). Shows word-level highlighting on matching pages. CSI codes are auto-detected from OCR text during processing.",
  },
  "csi-network-graph": {
    title: "CSI Network Graph",
    body: "Opens an interactive force-directed graph showing relationships between CSI divisions across the project. Nodes = divisions, edges = co-occurrence on same pages. Clusters group related trades (MEP, Architectural, Structural). Click 'Refresh Graph' to update after parsing new tables.",
  },

  // ═══════════════════════════════════════════════════════════
  // TOGGLE BUTTONS (right side of toolbar)
  // ═══════════════════════════════════════════════════════════
  "keynote-toggle": {
    title: "Keynotes",
    body: "Show or hide auto-detected keynote symbols (circles, triangles, squares, etc.) on the blueprint. These are extracted using computer vision. Click a keynote on the blueprint to filter all pages containing that symbol type.",
  },
  "yolo-toggle": {
    title: "YOLO AI Detections",
    body: "Show or hide AI object detection results — bounding boxes around detected elements like doors, windows, text boxes, tables, etc. Click the dropdown arrow (▾) to toggle individual models and adjust per-model confidence thresholds.",
  },
  "text-button": {
    title: "Text Panel",
    body: "Opens a side panel with 3 tabs: OCR (raw extracted text with copy button), Annotations (auto-detected patterns like phone numbers, equipment tags, abbreviations — click any to filter pages), and Graph (cross-sheet references with clickable navigation).",
  },
  "chat-button": {
    title: "Chat with AI",
    body: "Opens the LLM chat panel. Ask questions about the blueprint in natural language. The AI has context from OCR text, CSI codes, detected annotations, YOLO results, and your notes. Toggle between page-scope and project-scope context.",
  },
  "qto-button": {
    title: "Quantity Takeoff (QTO)",
    body: "Opens the takeoff panel with two modes: Count (create items, click to place markers) and Area (calibrate scale, draw polygons to measure). Click an item's page badge to filter the sidebar. Double-click item names to rename them.",
  },

  // ═══════════════════════════════════════════════════════════
  // PAGE SIDEBAR
  // ═══════════════════════════════════════════════════════════
  "sidebar-collapse": {
    title: "Collapse Page Navigator",
    body: "Hide the page sidebar to give more room to the blueprint. Click again to expand. The sidebar shows page thumbnails, names, and filter badges.",
  },
  "page-sidebar": {
    title: "Page Navigator",
    body: "Click any page to navigate to it. When a filter is active (search, trade, CSI, text annotation, or QTO), non-matching pages are hidden and colored count badges show matches per page. Click the X on a filter badge to clear it.",
  },

  // ═══════════════════════════════════════════════════════════
  // ANNOTATION PANEL (bottom right)
  // ═══════════════════════════════════════════════════════════
  "annotation-panel-collapse": {
    title: "Annotation Panel",
    body: "Collapsible panel listing all annotations on the current page — user markups, YOLO AI detections, and QTO takeoff markers. Click 'View Annotations' to expand. Use the Pointer/Select tool to click annotations on the blueprint to select them here.",
  },
  "keynote-eyeball": {
    title: "Keynote Visibility",
    body: "Quick toggle to show or hide keynote overlays on the blueprint. Same as the keynote button in the toolbar.",
  },

  // ═══════════════════════════════════════════════════════════
  // TEXT PANEL — OCR TAB
  // ═══════════════════════════════════════════════════════════
  "text-tab-ocr": {
    title: "OCR Text",
    body: "Raw text extracted from the current page via AWS Textract OCR. Search terms are highlighted in context. Use the copy button to copy all text to your clipboard. Future: better table detection and structured text formatting.",
  },
  "text-ocr-copy": {
    title: "Copy OCR Text",
    body: "Copy the full raw extracted text for this page to your clipboard. Useful for pasting into other tools or documents.",
  },

  // ═══════════════════════════════════════════════════════════
  // TEXT PANEL — ANNOTATIONS TAB
  // ═══════════════════════════════════════════════════════════
  "text-tab-annotations": {
    title: "Text Annotations",
    body: "Auto-detected patterns from the OCR text: phone numbers, addresses, equipment tags (AHU-1), material codes, sheet numbers (A-001.00), abbreviations with meanings, CSI codes, dimensions, trade callouts, and more. Click any annotation to filter all pages containing it. Toggle visibility per type or per item. These detections are experimental — accuracy will improve over time.",
  },
  "text-annotations-show-all": {
    title: "Show All Types",
    body: "Make all text annotation types visible on the canvas overlay at once.",
  },
  "text-annotations-hide-all": {
    title: "Hide All Types",
    body: "Hide all text annotation types from the canvas overlay. The annotations still exist — just not displayed.",
  },
  "text-annotations-nuke": {
    title: "Master Toggle (ON/OFF)",
    body: "Global kill switch for all text annotation overlays on the canvas. When OFF, no text annotations are rendered regardless of individual type settings. Useful to quickly declutter the view.",
  },
  "text-annotations-category": {
    title: "Annotation Category",
    body: "Click the header to expand or collapse this category. The eye icon toggles all annotation types in this category on/off. Categories include: Contact Info, Equipment, References, Trade Callouts, Abbreviations, and more.",
  },
  "text-annotations-row": {
    title: "Text Annotation",
    body: "Click to filter all pages containing this specific annotation. The dot icon toggles its individual visibility on the canvas. Confidence percentage shows detection reliability. These are regex-based detections — false positives may occur on some pages.",
  },

  // ═══════════════════════════════════════════════════════════
  // TEXT PANEL — GRAPH TAB
  // ═══════════════════════════════════════════════════════════
  "text-tab-graph": {
    title: "Cross-References & Equipment",
    body: "Shows sheet references found on this page (e.g., 'SEE SHEET A-101') with clickable links to navigate directly to that page. Also lists equipment tags detected on this page. Future: visual graph of all cross-references across the project.",
  },

  // ═══════════════════════════════════════════════════════════
  // QTO PANEL
  // ═══════════════════════════════════════════════════════════
  "qto-count-tab": {
    title: "Count (Each)",
    body: "Create named items to count (e.g., 'doors', 'outlets'). Pick a shape and color, then click the blueprint to place markers — each click = 1 count. Double-click an item's name to rename it. Click the page badge to filter the sidebar to pages with that item.",
  },
  "qto-area-tab": {
    title: "Area (Surface)",
    body: "Measure real-world areas on the blueprint. First calibrate: click two points on a known dimension and enter the real distance. Then draw polygons by clicking vertices — click the first point or press Enter to close. Area is calculated automatically.",
  },
  "qto-add-item": {
    title: "Add New Item",
    body: "Create a new counting category. Enter a name (e.g., 'fire extinguishers'), pick a marker shape and color. The item appears in the list below — click it to start placing markers on the blueprint.",
  },
  "qto-item-row": {
    title: "Takeoff Item",
    body: "Click to activate this item for marker placement on the blueprint. Double-click the name to rename it. The count shows total markers placed. The 'Npg' badge shows how many pages have markers — click it to filter the sidebar.",
  },
  "qto-calibrate": {
    title: "Calibrate Scale",
    body: "Required before measuring areas. Click two points on the blueprint along a known dimension (e.g., a door width), then enter the real-world distance and unit. The calibration is saved per page.",
  },
  "qto-stop": {
    title: "Stop Takeoff",
    body: "Exit marker or polygon placement mode. You can still select, move, and edit existing markers using the Pointer/Select tool.",
  },

  // ═══════════════════════════════════════════════════════════
  // CHAT PANEL
  // ═══════════════════════════════════════════════════════════
  "chat-scope-page": {
    title: "Page Scope",
    body: "The AI only sees text and annotations from the current page. Best for specific questions like 'What phone numbers are on this page?' or 'Describe this floor plan.'",
  },
  "chat-scope-project": {
    title: "Project Scope",
    body: "The AI sees text and annotations from all pages (up to context limit). Best for cross-page questions like 'What equipment is in this project?' or 'Summarize all CSI codes found.'",
  },
  "chat-input": {
    title: "Ask the AI",
    body: "Type a question about the blueprint. The AI has context from OCR text, CSI codes, detected text annotations, YOLO detections, and your takeoff notes. Try: 'What equipment is on this page?' or 'List all phone numbers in this project.' Press Enter to send.",
  },

  // ═══════════════════════════════════════════════════════════
  // YOLO DROPDOWN (when expanded)
  // ═══════════════════════════════════════════════════════════
  "yolo-model-toggle": {
    title: "Model Toggle",
    body: "Enable or disable detections from this specific YOLO model. Multiple models can be active simultaneously with different confidence thresholds.",
  },
  "yolo-confidence": {
    title: "Confidence Threshold",
    body: "Adjust minimum detection confidence for this model. Lower values show more detections (but may include false positives). Higher values show only high-confidence detections. Default is 25%.",
  },

  // ═══════════════════════════════════════════════════════════
  // HELP MODE
  // ═══════════════════════════════════════════════════════════
  "help-mode-toggle": {
    title: "Help Mode",
    body: "When enabled, hover over any button, panel, or tool to see a description of what it does and how to use it. Only works when Pointer/Select mode is active. Click again to turn off.",
  },
  "help-mode-intro": {
    title: "Help Mode Active",
    body: "You're in Help Mode! Hover over any button, tab, or control to learn what it does. Make sure you're in Pointer/Select mode (the leftmost mode button). Click 'Help ON' in the banner to turn off.",
  },

  // ═══════════════════════════════════════════════════════════
  // CANVAS
  // ═══════════════════════════════════════════════════════════
  "canvas-pointer": {
    title: "Blueprint Canvas",
    body: "Double-click any OCR'd word to search all pages for it. Single-click an annotation to select it (shows in search bar). Ctrl + scroll wheel to zoom. Drag selected markups to reposition. Click X above selected markup to delete.",
  },

  // ═══════════════════════════════════════════════════════════
  // SYMBOL SEARCH
  // ═══════════════════════════════════════════════════════════
  "symbol-search": {
    title: "Symbol Search",
    body: "Draw a bounding box around any symbol to find all matching instances across all pages. Uses two-tier matching: fast template match for same-orientation symbols, plus SIFT fallback for rotated/scaled variants. Results highlight in cyan. Adjust confidence slider to filter weak matches.",
  },
  "symbol-search-confidence": {
    title: "Match Confidence",
    body: "Filter symbol matches by minimum confidence score. Lower = more results but noisier (more false positives). Higher = fewer but more precise matches. Drag to adjust in real-time without re-searching.",
  },
  "symbol-search-page": {
    title: "Page Match",
    body: "Click to navigate to this page. Match count shows how many instances of the symbol were found on this page.",
  },

  // ═══════════════════════════════════════════════════════════
  // KEYNOTE PANEL
  // ═══════════════════════════════════════════════════════════
  "keynote-panel-button": {
    title: "Keynotes Panel",
    body: "Parse keynote tables from blueprints. All Keynotes shows parsed results across the project. Auto Parse uses multi-method ML. Manual Parse is step-by-step with column/row drawing.",
  },
  "keynote-auto-draw": {
    title: "Draw Keynote Region",
    body: "Draw a bounding box around ONLY the keynote table grid. Exclude any title text (e.g. 'KEYNOTES') floating above the table — including titles breaks header detection. BB resolution is based on the full PDF, not zoom level.",
  },
  "keynote-auto-process": {
    title: "Process Region",
    body: "Send the drawn region to the server for multi-method parsing. Three methods run in parallel: OCR word positions, AWS Textract table detection, and OpenCV line detection. The best result is selected automatically.",
  },
  "keynote-manual-region": {
    title: "Draw Keynote Region (Manual)",
    body: "Step 1: Draw a bounding box around the table grid only. Exclude floating titles above the table. This defines the area for column and row drawing in the next steps.",
  },
  "keynote-manual-columns": {
    title: "Draw Columns",
    body: "Step 2: Draw the first column around the tag/key column (e.g. 01, 02...), then draw the second column around the description column. Use 'Repeat Right' to auto-fill evenly spaced columns. Small overlap between columns is OK — OCR word centers determine assignment.",
  },
  "keynote-manual-rows": {
    title: "Draw Rows",
    body: "Step 3: Draw a bounding box around one row, then click 'Repeat Down' to auto-fill evenly spaced rows down to the region boundary. Small overlap between rows is OK.",
  },
  "keynote-manual-parse": {
    title: "Parse Keynotes",
    body: "Extract key-description pairs from the column/row intersections using OCR word positions. Each row becomes a keynote entry. Results appear in the All Keynotes tab.",
  },
  "keynote-item": {
    title: "Keynote Table",
    body: "Click name to rename. Double-click to navigate to the page. Expand to see individual keynote keys. Click a key to highlight instances on the current page. Pencil icon edits CSI codes and notes per key.",
  },
  "keynote-visibility": {
    title: "Region Visibility",
    body: "Toggle parsed keynote region outlines (bounding boxes for region, columns, rows) on or off on the canvas. Does not affect keynote shape overlays.",
  },

  // ═══════════════════════════════════════════════════════════
  // TABLE / SCHEDULE PANEL
  // ═══════════════════════════════════════════════════════════
  "table-panel-button": {
    title: "Schedules / Tables Panel",
    body: "Parse table and schedule data from blueprints. All Tables shows parsed results. Auto Parse uses multi-method ML. Manual is step-by-step. Compare/Edit for cell-by-cell editing and verification.",
  },
  "table-auto-draw": {
    title: "Draw Table Region",
    body: "Draw a bounding box around ONLY the table grid. Exclude any title text (e.g. 'DOOR SCHEDULE') floating above the table — including it breaks header detection. Auto-parse runs immediately after drawing.",
  },
  "table-manual-region": {
    title: "Draw Table Region (Manual)",
    body: "Step 1: Draw a bounding box around the table grid only. Exclude floating titles. This defines the area for column and row drawing.",
  },
  "table-manual-columns": {
    title: "Draw Columns",
    body: "Step 2: Draw columns left-to-right. First column should be the tag/key column (D-01, F-03, etc.). Name each column in the input fields. Use 'Repeat Right' to auto-fill evenly spaced columns.",
  },
  "table-manual-rows": {
    title: "Draw Rows",
    body: "Step 3: Draw one row, then click 'Repeat Down' to auto-fill evenly spaced rows. Small overlap between rows is OK — word centers determine assignment.",
  },
  "table-manual-parse": {
    title: "Parse Table",
    body: "Extract cell values from column/row intersections using OCR word center-point matching. Results appear in the review section and All Tables tab.",
  },
  "table-item": {
    title: "Parsed Table",
    body: "Click name to rename. Double-click to navigate to the page. Expand to see rows as tag sub-items. Click a tag to highlight all instances across ALL pages. Current-page tables sort to the top.",
  },
  "table-view-edit": {
    title: "View / Edit",
    body: "Open the parsed grid in a side-by-side view next to the original PDF crop. Click any cell to edit its text. Click 'Done' to save edits back to the parsed data.",
  },
  "table-map-tags": {
    title: "Map Tags to Drawings",
    body: "Create tags from the table's tag column. Choose the tag column, then select tag type: 'Free-floating' for plain text codes on blueprints, or 'YOLO Shape' for codes inside detected shapes. Searches all pages for each tag value.",
  },
  "table-map-run": {
    title: "Run Mapping",
    body: "Search all pages for each tag value in the selected column. Creates YoloTag entries that appear in the YOLO panel's Tags tab. Tags can be clicked to highlight instances and filter pages.",
  },
  "table-visibility": {
    title: "Region Visibility",
    body: "Toggle parsed table region outlines (bounding boxes for region, columns, rows) on or off on the canvas.",
  },
  "table-compare": {
    title: "Compare / Edit Cells",
    body: "Select a parsed table to view side-by-side with the original PDF. Click cells to edit text. Edit headers to rename columns. Click 'Done' to save all changes.",
  },

  // ═══════════════════════════════════════════════════════════
  // YOLO TAGS TAB
  // ═══════════════════════════════════════════════════════════
  "yolo-create-tag": {
    title: "Create Tag",
    body: "Enter tag-picking mode — click any YOLO annotation on the canvas to create a named tag from its OCR text. The system scans all pages for matching instances of that text inside the same YOLO class. Tags appear in the tree below.",
  },
  "yolo-tag-item": {
    title: "YOLO Tag",
    body: "Click to highlight all instances on the canvas and filter pages in the sidebar. Expand to see per-page instance counts and navigate to specific pages. Tags come from three sources: keynote parsing (page-scoped), schedule parsing (project-wide), and manual creation.",
  },
  "yolo-tag-visibility": {
    title: "Tag Visibility",
    body: "Show or hide this specific tag's highlighting on the canvas. When visible, matching annotations get a colored border and label.",
  },
};
