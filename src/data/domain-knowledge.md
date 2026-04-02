# BlueprintParser Domain Knowledge

## GENERAL — Drawing Conventions

### Drawing Number System
- **G-xxx** = General (cover sheets, legends, abbreviation lists)
- **C-xxx** = Civil (site plans, grading, utilities)
- **L-xxx** = Landscape
- **A-xxx** = Architectural (floor plans, elevations, sections, details, schedules)
- **S-xxx** = Structural (foundations, framing plans, details)
- **M-xxx** = Mechanical / HVAC
- **P-xxx** = Plumbing
- **FP-xxx** = Fire Protection
- **E-xxx** = Electrical
- **T-xxx** = Telecommunications / Low Voltage

### Number Series
- **x-0xx** = General sheets, legends, notes
- **x-1xx** = Plans (floor plans, ceiling plans, roof plans)
- **x-2xx** = Elevations
- **x-3xx** = Sections
- **x-4xx** = Enlarged plans/details
- **x-5xx** = Details, schedules
- **x-6xx+** = Varies by firm

### Spatial Layout
- **Title block**: is most often the right side, a column that has Drawing number, project name, date, revisions.  YOLO_medium model has a title_block class, and the yolo_shapes model returnes vertical_area and tables which will often show up  as title blocks.  
- **General notes**: vertical text boxes often, tho format can very.  there are general notes that look like specs in their format (text covering an entire sheet in the thing columns standard among blueprints) or as horizantal or vertical text boxes in the plans. "GENERAL NOTES" header with numbered items
- **Legend/symbols**: G-series sheets or available space on plan sheets
- **Drawing area**: Central region, outside of the titleblock, will return drawings class in YOLO_medium model
- **Scale**: Below drawing title. Format: 1/4" = 1'-0"
### Cross-Reference Patterns
- "SEE DETAIL 3/A-501" = detail 3 on sheet A-501
- "SIM" / "TYP" = similar/typical condition
- "NIC" = Not In Contract, "NTS" = Not To Scale
- Hub pages (referenced 3+ times) are key coordination drawings

---

## YOLO MODELS & CLASSES

### yolo_shapes (Primitives) — 16 classes
| Class | Meaning |
|-------|---------|
| circle | Keynote markers, tag bubbles, column gridlines |
| oval | Keynote markers (oval style) |
| square | Room tags, fire-rated markers |
| diamond | Equipment tags, elevation markers |
| rectangle | Room labels, callout boxes |
| triangle | Section arrows, directional markers |
| hexagon | Bolt patterns, special markers |
| horizontal_area | **Schedule/table regions**, spec blocks. Key detection for tables |
| vertical_area | Column schedules, vertical legends |
| grid | **Table confirmation**. Grid inside horizontal_area = strong table signal |
| dot_small_circle | Dimension points, grid intersections |
| pill | Room tags (rounded rectangle) |
| hex_pill | Specialty markers |
| drawings | Sheet borders |
| arch_sheet_circle | Sheet number reference bubbles |
| arches_archway | Doorway arcs on floor plans |

### yolo_medium — 7 classes
| Class | Meaning |
|-------|---------|
| door_single | Single door swings on floor plans |
| door_double | Double door swings |
| tables | Table/schedule regions (distinct from horizontal_area) |
| drawings | Main drawing content areas |
| text_box | Callout boxes, specification notes |
| title_block | Standard info block with project data |
| symbol_legend | Symbol/abbreviation legend areas |

### yolo_precise — 2 classes
| Class | Meaning |
|-------|---------|
| door_single | High-precision single door detection |
| door_double | High-precision double door detection |

### YOLO + OCR Compound Signals
- circle/oval + short text (1-5 chars) = Keynote or tag marker (e.g., "T-01")
- diamond + alphanumeric = Equipment tag (e.g., "EQ-01", "AHU-1")
- square + number = Room number tag
- horizontal_area + rows of text = Schedule/table
- horizontal_area + grid overlap = High-confidence table (two models agree)

---

## HEURISTIC RULES

### keynote-table
horizontal_area + "KEYNOTE"/"LEGEND" text + key-value region + ovals inside = Keynote legend table

### door-schedule
table + "DOOR" + "SCHEDULE" text = Door schedule (CSI 08 11 16). Tags D-01, D-02... map to floor plan markers

### finish-schedule
table + "FINISH" + "SCHEDULE" text = Room finish schedule (CSI 09). Maps rooms to floor/wall/ceiling finishes

### symbol-legend
horizontal_area + "LEGEND"/"SYMBOL" text + 3+ vertically aligned items = Symbol legend

### general-notes
"GENERAL NOTES" text + notes-block region = Specification notes (no YOLO needed)

### material-schedule
table + "SCHEDULE" text = Generic schedule (equipment, fixtures, panels, lighting)

### table-confidence-boost
table class (medium) overlapping horizontal_area (primitives) = Two models confirm table exists

---

## CSI DIVISIONS

### Division 03 — Concrete
S-series pages. f'c values, rebar (#4, #5), "CONC", "SLAB", "FTG". Schedules: foundation, footing.

### Division 05 — Metals
S-series pages. Steel shapes (W12x26, HSS4x4), "STL", "BM", "COL". Schedules: steel, beam, column.

### Division 07 — Thermal/Moisture
A-series pages. "INSULATION", "R-VALUE", "ROOFING", "MEMBRANE", "FLASHING". Schedules: roof.

### Division 08 — Openings
A-series pages. Door tags (D-01), window tags (W-01), "HM" (hollow metal), "WD" (wood). YOLO: door_single, door_double. Schedules: door, window, hardware.

### Division 09 — Finishes
A-series pages. Paint codes (PT-1), "GWB", "ACT", "VCT", "CPT", room numbers. Schedules: room finish, paint, color.

### Division 10 — Specialties
A-series pages. Toilet accessories, signage, lockers, fire extinguishers.

### Division 21 — Fire Suppression
FP-series pages. "SPRINKLER", "FDC", "PIV", "OS&Y", GPM values. Schedules: sprinkler riser.

### Division 22 — Plumbing
P-series pages. Pipe sizes, "CW", "HW", "SAN", "VENT", "GPM". Tags: P-1, WC-1, LAV-1. Schedules: plumbing fixture.

### Division 23 — HVAC
M-series pages. "CFM", "AHU", "VAV", "RTU", duct sizes, "BTU". Tags: AHU-1, RTU-1, VAV-101. Schedules: equipment, diffuser, fan.

### Division 26 — Electrical
E-series pages. Panel names (LP-1), "AMP", "VOLT", wire gauges, conduit sizes, "KVA". Schedules: panel, lighting fixture.

### Division 27 — Communications
E/T-series pages. "DATA", "VOICE", "CATV", "FIBER", "WAP". Schedules: telecom outlet.

### Division 28 — Electronic Safety
E/FP-series pages. "FA", "FACP", "SMOKE", "PULL STATION", "HORN/STROBE", "CCTV". Schedules: fire alarm device.

---

## TEXT ANNOTATION DETECTORS (37 types)
| Detector | Finds | Examples |
|----------|-------|---------|
| contact | Phone, email, address, URL, zip | (555) 123-4567, name@firm.com |
| codes | CSI sections, building codes, compliance | Section 09 21 16, IBC 2021, 1-HR RATED |
| dimensions | Imperial/metric dims, scales, slopes | 3'-6", 1200mm, 1/4"=1'-0", 2% SLOPE |
| equipment | Equipment tags, door/window tags, panel refs | AHU-1, D-101, PT-1, LP-1A |
| references | Sheet refs, detail refs, revisions, action markers | SEE DETAIL 3/A-501, REV A, RFI |
| trade | Structural, mech, elec, plumbing, fire callouts | #5 REBAR, 200 CFM, 20A/120V, SPRK |
| abbreviations | Construction abbreviations | TYP, NTS, SIM, EQ, NIC, VIF |
| notes | General notes, numbered notes, coordination | "1. Contractor shall...", COORDINATE WITH |
| rooms | Room numbers, names, area designations | Room 101, CONFERENCE ROOM, ZONE A |
| csi | CSI MasterFormat codes | 08 11 16, 09 29 00 |

---

## CONFIDENCE INTERPRETATION
- YOLO > 0.8 = reliable. 0.5-0.8 = likely. < 0.5 = uncertain, qualify with "appears to be"
- CSI tier 1 (0.95) = exact match. Tier 2 (0.5-0.75) = probable. Tier 3 (< 0.5) = "possibly"
- Heuristic > 0.8 = multiple signals agree. 0.5-0.8 = single signal

## WHEN DATA IS MISSING
- No YOLO annotations = models not run yet. Suggest running from Detection panel
- No parsedRegions = no tables parsed yet. Suggest Table Parse or Keynote panel
- Empty csiSpatialMap = normal for cover sheets or detail-only pages
- Very short rawText = drawing-heavy page with few labels

## QUESTION → TOOL STRATEGIES
- "How many doors?" → getAnnotations({className:"door_single"}) + getParsedSchedule
- "What's on page X?" → getPageDetails(X)
- "Where is equipment Y?" → searchPages("Y") then getPageDetails
- "List all trades" → getProjectOverview (allTrades pre-computed)
- "What references this page?" → getCrossReferences
- "What tags exist?" → detectTagPatterns (auto-discovers all YOLO+OCR groups)
- "Show me the second floor" → lookupPagesByIndex for Architectural, filter x-1xx
