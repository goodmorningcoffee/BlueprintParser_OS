/** Construction glossary tuned for an LLM reading the docs cold. Each term
 *  points at where it surfaces in BP code or UI so the model can ground the
 *  abstract word in a concrete structure. */
const TERMS = [
  {
    term: "Keynote",
    plain: "A numbered callout (often in a circle or hexagon) referring to a spec section or instruction. Example: “③” on a drawing refers to note 3 in a table.",
    bp: "Detected as shapes with inner OCR text; stored as annotations with source=\"shape-parse\" and in pages.keynotes JSONB.",
  },
  {
    term: "CSI code",
    plain: "A 6-digit number from the Construction Specifications Institute MasterFormat. Example: 08 14 00 = Wood Doors. The primary industry-standard scheme for organizing construction scope.",
    bp: "Detected by the 3-tier matcher in src/lib/csi-detect.ts. Stored in pages.csi_codes JSONB. Drives CSI heatmaps, network graph, and LLM context.",
  },
  {
    term: "Takeoff",
    plain: "The process of counting everything on a drawing set (doors, wall square footage, linear feet of pipe) for a bid. Historically done with a printed set + highlighter.",
    bp: "takeoff_items table (count / area / linear). Area tab bucket-fills rooms. Auto-QTO materializes schedule-backed takeoffs automatically.",
  },
  {
    term: "Callout",
    plain: "A graphical reference on a drawing. Usually a circle with a letter/number inside, sometimes with a leader line. Two types: schedule callouts (tag → row) and detail callouts (symbol → detail sheet).",
    bp: "Schedule callouts become YoloTags via Map Tags. Detail callouts become cross-references in page_intelligence.crossRefs.",
  },
  {
    term: "Schedule",
    plain: "A tabular block on a drawing listing every item of a type (door schedule, window schedule, finish schedule). Each row = one unique tag value.",
    bp: "Detected by table-classifier, parsed with img2table/Camelot/TATR/ocr-grid-detect, stored as pages.page_intelligence.parsedRegions[] with type=\"schedule\".",
  },
  {
    term: "Trade",
    plain: "A discipline: architectural, structural, MEP (mechanical/electrical/plumbing), civil, etc. Each trade has its own subset of sheets and its own CSI divisions.",
    bp: "Inferred from CSI codes and drawing prefixes. Surfaced in the toolbar trade filter + projectIntelligence.disciplines.",
  },
  {
    term: "Sheet number",
    plain: "The identifier on the title block — e.g. A-101, E-205. Letter = trade, digit = sheet index. Estimators refer to pages by sheet number, not by 1-based index.",
    bp: "Extracted via extractDrawingNumber() in src/lib/title-block.ts; stored in pages.name.",
  },
  {
    term: "Title block",
    plain: "The legend block (usually bottom-right corner) with the project name, sheet number, scale, revision, and stamp. Excluded from takeoff counting.",
    bp: "Detected as a YOLO class title_block. Auto-QTO strictly excludes hits inside this region.",
  },
  {
    term: "Tag / tag shape",
    plain: "A small symbol (circle, hexagon, diamond) containing a tag string like “D-01”. The schedule has one row per tag; the drawings have many instances. Counting the instances = the takeoff.",
    bp: "QTO_TAG_SHAPE_CLASSES in AutoQtoTab.tsx: circle, hexagon, diamond, triangle, pill, oval, rectangle, square, + variants.",
  },
  {
    term: "Scale calibration",
    plain: "Before a bucket-filled polygon is a real measurement, BP needs to know how many real-world feet per pixel. User clicks two points, types the known distance.",
    bp: "Stored per-page in scaleCalibrations[pageNumber]. Consumed by computeRealArea() in src/lib/areaCalc.ts.",
  },
  {
    term: "pageIntelligence / projectIntelligence",
    plain: "BP's internal structured summary of a page / project. A compact JSON that replaces raw OCR for most downstream uses (LLM context, Auto-QTO discovery, CSI heatmap).",
    bp: "pages.page_intelligence + projects.project_intelligence JSONB columns. Built by analyzePageIntelligence() and analyzeProject().",
  },
  {
    term: "Heuristic engine",
    plain: "A rules engine that fires inferences like “this page contains a door schedule” or “this page is an RCP” based on text keywords + YOLO classes + spatial conditions.",
    bp: "src/lib/heuristic-engine.ts. Two modes: text-only (during processing) and YOLO-augmented (after YOLO).",
  },
];

export function LlmGlossaryCards() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {TERMS.map((t) => (
        <div
          key={t.term}
          className="rounded border border-[var(--border)] bg-[var(--surface)]/30 p-3"
        >
          <div className="text-[var(--accent)] font-bold text-[13px] mb-1 font-mono">{t.term}</div>
          <div className="text-[12px] text-[var(--fg)]/85 leading-snug mb-2">{t.plain}</div>
          <div className="text-[10.5px] text-[var(--muted)] leading-snug font-mono border-t border-[var(--border)] pt-1.5">
            → {t.bp}
          </div>
        </div>
      ))}
    </div>
  );
}
