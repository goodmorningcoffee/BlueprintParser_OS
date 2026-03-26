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
    title: "Pointer/Select Tool",
    body: "Select annotations, markups, and QTO items on the blueprint. Double-click any OCR'd word to search all pages for it. Drag selected markups to reposition them. Click the X above a selected annotation to delete it. This is also the mode needed for Help Mode tooltips.",
  },
  "pan-mode": {
    title: "Pan/Zoom Tool",
    body: "Click and drag to scroll around the blueprint. Mouse wheel zooms in this mode. Tip: Ctrl + scroll wheel zooms in ANY mode, so you rarely need to switch to Pan.",
  },
  "markup-mode": {
    title: "Add Markup",
    body: "Click and drag to draw a rectangle annotation on the blueprint. You'll be prompted to name it. Switch back to Pointer/Select to move, resize, or delete markups.",
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
};
