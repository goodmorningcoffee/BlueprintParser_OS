/**
 * layouts.ts — the hand-written layouts behind src/lib/parse-engine/__fixtures__/*.synthetic.json
 * (table-pipeline WP-2.0a). Every text here is invented placeholder text, and synthesize.ts
 * pseudonymizes it again on top, so no fixture can carry drawing text even by mistake.
 *
 * They cover the probe shapes of INVENTORY C02 / C04 / C10: multi-line cells (K07), y-jitter, two-tier
 * and duplicate headers (K06), section rows, shape-tag columns incl. centred multi-line rows and a tall last
 * row (K13), dotted keys lost by the crop read (C2-m4), minority tag formats (K10), Textract tables with
 * spans, two-block schedules, wrapped / tight / multi-column / sub-block notes (K31-K35), key-value legends
 * on separate LINEs (K09) and spec sections (K34).
 *
 * Regenerate after an edit: `npx tsx scripts/parse-engine-fixtures/synthesize.ts --layouts`.
 */
import type { GridLayout, ItemsLayout, Layout } from "./synthesize";

const FILL = [
  "lorem", "ipsum", "dolor", "amet", "sed", "magna", "tempor", "labore", "vitae", "porta", "nulla", "felis",
  "ornare", "lacus", "metus", "augue", "risus", "massa", "justo", "velit", "nibh", "quam", "urna", "elit",
];

/** Deterministic filler: `n` words starting at `seed`, upper-case when `upper`. */
function words(seed: number, n: number, upper = true): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(FILL[(seed * 7 + i * 5) % FILL.length]);
  const s = out.join(" ");
  return upper ? s.toUpperCase() : s;
}

const tags = (prefix: string, n: number, start = 1): string[] => Array.from({ length: n }, (_, i) => `${prefix}${start + i}`);

const DIST = (y: number): { text: string; at: [number, number] }[] => [
  { text: "LOREM IPSUM SCHEDULE", at: [0.1, y - 0.03] },
  { text: "VELIT 3/X-999", at: [0.8, 0.9] },
];

function schedule(id: string, title: string, probes: string[], over: Partial<GridLayout> & { body: string[][] }): GridLayout {
  return {
    type: "grid", id, title, kind: "schedule", probes, origin: [0.1, 0.12],
    colWidths: [0.04, 0.12, 0.06, 0.06, 0.1],
    header: [["MARK", "DESCRIPTION", "SIZE", "TYPE", "REMARKS"]],
    distractors: DIST(0.12),
    ...over,
  };
}

const basicRows = (n: number, tagPrefix = "D-10"): string[][] =>
  tags(tagPrefix, n).map((t, i) => [t, words(i, 2), `${3 + (i % 2)}'-0"`, String.fromCharCode(65 + (i % 3)), i % 3 === 0 ? words(i + 3, 1) : ""]);

const multiRows = (n: number): string[][] =>
  tags("W", n).map((t, i) => [t, `${words(i, 2)}\n${words(i + 9, 2)}${i % 2 ? `\n${words(i + 4, 1)}` : ""}`, `${2 + i}`, `${words(i + 2, 1)}\n${words(i + 6, 1)}`, ""]);

const GRIDS: GridLayout[] = [
  schedule("syn-sched-basic", "single-line schedule, tag column, one header tier", ["C02-4.1", "K06"], { body: basicRows(8) }),
  schedule("syn-sched-multiline-top", "two- and three-line cells, top aligned", ["C02-multiline", "K07"], { body: multiRows(6) }),
  schedule("syn-sched-multiline-middle", "multi-line cells vertically centred in their rows", ["C02-multiline", "K07", "K13"], { body: multiRows(6), valign: "middle" }),
  schedule("syn-sched-yjitter", "single-line rows with word y-jitter and descender heights", ["C02-yjitter", "K07"], { body: basicRows(8), jitter: 0.0016 }),
  schedule("syn-sched-yjitter-multiline", "y-jitter on two-line cells", ["C02-yjitter", "C02-multiline", "K07"], { body: multiRows(5), jitter: 0.0014 }),
  schedule("syn-sched-two-tier", "two-tier header with a spanning group over repeated sub-headers", ["K06", "C02-two-tier"], {
    colWidths: [0.04, 0.06, 0.07, 0.06, 0.07, 0.1],
    header: [["", { text: "DOOR", span: 2 }, { text: "FRAME", span: 2 }, ""], ["MARK", "TYPE", "MATERIAL", "TYPE", "MATERIAL", "REMARKS"]],
    body: tags("1", 6).map((t, i) => [t, "A", words(i, 1), String.fromCharCode(66 + (i % 2)), words(i + 5, 1), ""]),
  }),
  schedule("syn-sched-dup-headers", "duplicate header names in one tier", ["K06"], {
    header: [["MARK", "SIZE", "SIZE", "TYPE", "TYPE"]],
    body: basicRows(6).map((r) => [r[0], r[2], `${7 + (r[0].length % 3)}'-0"`, r[3], "X"]),
    columnNames: ["MARK", "SIZE", "SIZE", "TYPE", "TYPE"],
  }),
  schedule("syn-sched-section-rows", "full-width section rows between body rows", ["C02-section-row", "K13"], {
    body: [["FIRST LOREM"], ...basicRows(3), ["SECOND LOREM"], ...basicRows(3, "D-20")],
  }),
  schedule("syn-sched-shapes-hex", "hexagon tag shapes in column A, key inside each shape", ["C02-4.5", "K13"], {
    body: basicRows(6, "1"), shapes: { label: "hexagon", col: 0, size: 0.018, source: "yolo", at: "first-line" },
  }),
  schedule("syn-sched-shapes-centred-3line", "circle tags centred on three-line descriptions", ["C02-probe2", "K13"], {
    colWidths: [0.04, 0.16],
    header: [["KEY", "DESCRIPTION"]],
    body: tags("K", 5).map((t, i) => [t, `${words(i, 2)}\n${words(i + 3, 2)}\n${words(i + 7, 2)}`]),
    valign: "middle",
    shapes: { label: "circle", col: 0, size: 0.016, source: "yolo", at: "center" },
  }),
  schedule("syn-sched-shapes-tall-last", "shape rows whose last row is twice as tall", ["K13"], {
    colWidths: [0.04, 0.16],
    header: [["KEY", "DESCRIPTION"]],
    body: [...tags("", 4, 1).map((t, i) => [t, words(i, 3)]), ["5", `${words(1, 3)}\n${words(2, 3)}\n${words(3, 3)}\n${words(4, 3)}`]],
    shapes: { label: "circle", col: 0, size: 0.016, source: "yolo", at: "first-line" },
  }),
  schedule("syn-sched-shapes-classical-dotted", "classical shapes, dotted keys, two shapes blind to Textract", ["C2-m4", "K27"], {
    colWidths: [0.04, 0.16],
    header: [["KEY", "DESCRIPTION"]],
    body: ["3.1", "3.2", "3.3", "3.4", "3.5"].map((k, i) => [k, words(i, 3)]),
    shapes: { label: "square", col: 0, size: 0.018, source: "classical", at: "first-line", blind: [1, 3], cropText: true },
  }),
  schedule("syn-sched-ef-tags", "EF-1 … EF-12 tag column mixing one- and two-digit tags", ["K10", "C05"], {
    body: tags("EF-", 12).map((t, i) => [t, words(i, 2), `${100 + i * 50}`, "A", ""]),
    header: [["MARK", "DESCRIPTION", "CFM", "TYPE", "REMARKS"]],
  }),
  schedule("syn-sched-textract-merged", "Textract TABLE with a spanning header and spanning body cell", ["K17", "C02-4.2"], {
    header: [["MARK", { text: "DESCRIPTION", span: 2 }, "TYPE", "REMARKS"]],
    body: basicRows(5).map((r, i) => (i === 2 ? [r[0], r[1], "", r[3], r[4]] : r)),
    textractTable: true,
  }),
  schedule("syn-sched-textract-header-row", "Textract TABLE whose first row is the printed header", ["C02-4.2"], { body: basicRows(7), textractTable: true }),
  schedule("syn-sched-textract-multiline", "Textract TABLE over multi-line cells", ["C02-4.2", "K07"], { body: multiRows(5), textractTable: true }),
  schedule("syn-sched-sparse", "many empty cells", ["C02-4.1"], {
    body: basicRows(8).map((r, i) => r.map((c, ci) => (ci > 0 && (i + ci) % 3 === 0 ? "" : c))),
  }),
  schedule("syn-sched-wide", "ten narrow columns", ["C02-4.1"], {
    colWidths: Array.from({ length: 10 }, () => 0.035),
    header: [["MARK", "TYPE", "SIZE", "QTY", "HEAD", "JAMB", "SILL", "SET", "GROUP", "NOTES"]],
    body: tags("P", 6).map((t, i) => [t, "A", `${i + 2}`, `${i + 1}`, "X", "Y", "Z", `${i % 4}`, "B", i % 2 ? "1" : ""]),
  }),
  schedule("syn-sched-long", "thirty single-line rows", ["C02-4.1"], { body: basicRows(30, "R-") }),
  schedule("syn-sched-row-lines", "one Textract LINE per printed row (cells merged by Textract)", ["C02-4.1", "K07"], { body: multiRows(5), lineMode: "row" }),
  schedule("syn-sched-no-header", "no header tier", ["C02-4.1"], { header: undefined, body: basicRows(6) }),
  schedule("syn-sched-center-align", "centre-aligned columns", ["C02-4.1"], { body: basicRows(6), align: ["center", "left", "center", "center", "left"] }),
  schedule("syn-sched-two-blocks", "one schedule printed as two side-by-side blocks", ["Q1", "C02-two-block"], {
    colWidths: [0.04, 0.1, 0.05],
    header: [["MARK", "DESCRIPTION", "SIZE"]],
    body: basicRows(5).map((r) => [r[0], r[1], r[2]]),
    secondBlock: { gap: 0.04, body: basicRows(5, "D-20").map((r) => [r[0], r[1], r[2]]) },
  }),
];

function keynotes(id: string, title: string, probes: string[], over: Partial<GridLayout> & { body: string[][] }): GridLayout {
  return {
    type: "grid", id, title, kind: "keynote", probes, origin: [0.62, 0.2],
    colWidths: [0.03, 0.2],
    header: [["KEY", "KEYNOTES"]],
    distractors: DIST(0.2),
    ...over,
  };
}

const KEYNOTE_GRIDS: GridLayout[] = [
  keynotes("syn-keynote-basic", "two-column keynote legend, one line each", ["C03", "K07"], { body: tags("", 10).map((k, i) => [k, words(i, 4)]) }),
  keynotes("syn-keynote-multiline", "keynote descriptions wrapped to two or three lines", ["C03", "K07"], {
    body: tags("", 6).map((k, i) => [k, `${words(i, 4)}\n${words(i + 2, 4)}${i % 2 ? `\n${words(i + 5, 2)}` : ""}`]),
  }),
  keynotes("syn-keynote-shapes", "keys inside circles, descriptions centred on the circle", ["C03", "K13", "K27"], {
    body: tags("", 6).map((k, i) => [k, `${words(i, 4)}\n${words(i + 1, 4)}`]),
    valign: "middle",
    shapes: { label: "circle", col: 0, size: 0.016, source: "yolo", at: "center" },
  }),
  keynotes("syn-keynote-sheet-keys", "letter-number keys", ["C03", "K05"], { body: ["A1", "A2", "B1", "B2", "C1"].map((k, i) => [k, words(i + 4, 3)]) }),
];

function items(id: string, title: string, kind: ItemsLayout["kind"], probes: string[], over: Partial<ItemsLayout> & { entries: ItemsLayout["entries"] }): ItemsLayout {
  return {
    type: "items", id, title, kind, probes, origin: [0.55, 0.15], wrapChars: 44, indent: 0.016,
    distractors: DIST(0.15),
    ...over,
  };
}

const numbered = (n: number, wordsPer: number, start = 1): ItemsLayout["entries"] =>
  Array.from({ length: n }, (_, i) => ({ key: `${start + i}.`, text: words(i + start, wordsPer + (i % 3) * 4) }));

const NOTES: ItemsLayout[] = [
  items("syn-notes-single-line", "numbered notes, one line each, under a heading", "notes", ["C04-4.2"], {
    entries: [{ heading: true, text: "GENERAL NOTES" }, ...numbered(6, 5)], wrapChars: 80,
  }),
  items("syn-notes-wrapped-hanging", "numbered notes wrapping to two or three lines with a hanging indent", "notes", ["C04-06", "K31"], {
    entries: [{ heading: true, text: "GENERAL NOTES" }, ...numbered(6, 12)], itemGap: 0.004,
  }),
  items("syn-notes-wrapped-tight-gap", "wrapped notes at line pitch .008 and note gap .004", "notes", ["C04-07", "K32"], {
    entries: numbered(6, 12), linePitch: 0.008, lineH: 0.006, itemGap: 0.004,
  }),
  items("syn-notes-two-column", "notes 1-6 and 7-12 in two side-by-side columns", "notes", ["K33"], {
    entries: numbered(12, 8), columns: 2, columnGap: 0.03, wrapChars: 34,
  }),
  items("syn-notes-subblocks", "two note blocks with their own headings (1-5, then 1-3)", "notes", ["K35", "C04-10"], {
    entries: [{ heading: true, text: "GENERAL NOTES" }, ...numbered(5, 7), { heading: true, text: "ELECTRICAL NOTES" }, ...numbered(3, 7)],
  }),
  items("syn-notes-dimension-start", "wrapped lines that start with a dimension or a scale", "notes", ["K35"], {
    entries: [
      { key: "1.", text: `${words(1, 7)} 2.5 MM ${words(3, 6)}` },
      { key: "2.", text: words(2, 9) },
      { key: "3.", text: `${words(5, 6)} 1:50 ${words(6, 8)}` },
      { key: "4.", text: words(8, 10) },
    ],
    wrapChars: 30,
  }),
  items("syn-notes-lettered", "lettered notes a. b. c.", "notes", ["C04-4.2"], {
    entries: ["a.", "b.", "c.", "d.", "e."].map((k, i) => ({ key: k, text: words(i, 9) })),
  }),
  items("syn-notes-paren-keys", "parenthesised keys (1) (2)", "notes", ["C04-4.2"], {
    entries: Array.from({ length: 5 }, (_, i) => ({ key: `(${i + 1})`, text: words(i + 2, 8) })),
  }),
  items("syn-notes-preamble", "two unnumbered lines before note 1", "notes", ["K35"], {
    entries: [{ heading: true, text: words(3, 6) }, { heading: true, text: words(4, 5) }, ...numbered(4, 8)],
  }),
  items("syn-notes-keynote-bubbles", "keynote legend with keys inside circles, wrapped text", "keynote", ["C03", "K27"], {
    entries: numbered(5, 10).map((e, i) => ({ ...e, key: `${i + 1}` })),
    keyShapes: { label: "circle", size: 0.014, source: "yolo" },
    indent: 0.024,
  }),
];

const KV: ItemsLayout[] = [
  items("syn-kv-abbrev", "abbreviation legend, key and value on separate Textract LINEs", "kv-legend", ["C04-04", "K09"], {
    entries: [{ heading: true, text: "ABBREVIATIONS" }, ...["AFF", "BLDG", "CLG", "DIA", "EXT", "GYP"].map((k, i) => ({ key: k, text: words(i, 2) }))],
    indent: 0.04, keySeparateLine: true, wrapChars: 30,
  }),
  items("syn-kv-abbrev-same-line", "abbreviation legend, key and value in one LINE", "kv-legend", ["C04-04"], {
    entries: ["AFF", "BLDG", "CLG", "DIA", "EXT", "GYP"].map((k, i) => ({ key: k, text: words(i + 1, 2) })),
    indent: 0.03, wrapChars: 30,
  }),
  items("syn-kv-symbol-legend", "symbol-keyed legend: shapes in the key column, no key text", "kv-legend", ["C03", "U18"], {
    entries: [{ heading: true, text: "LEGEND" }, ...Array.from({ length: 5 }, (_, i) => ({ key: "", text: words(i + 3, 3) }))],
    keyShapes: { label: "diamond", size: 0.012, source: "yolo", noKeyText: true },
    indent: 0.03, wrapChars: 30,
  }),
];

const SPECS: ItemsLayout[] = [
  items("syn-spec-section", "spec section: SECTION, PART, articles, lettered paragraphs, wrapped", "spec", ["C04-4.3"], {
    entries: [
      { heading: true, text: "SECTION 09 21 16 - LOREM IPSUM" },
      { key: "PART 1", text: "GENERAL", level: 0 },
      { key: "1.01", text: words(1, 4), level: 1 },
      { key: "A.", text: words(2, 14), level: 2 },
      { key: "B.", text: words(3, 9), level: 2 },
      { key: "1.02", text: words(4, 3), level: 1 },
      { key: "A.", text: words(5, 12), level: 2 },
      { key: "PART 2", text: "PRODUCTS", level: 0 },
      { key: "2.01", text: words(6, 3), level: 1 },
      { key: "A.", text: words(7, 16), level: 2 },
    ],
    levelIndent: 0.01, indent: 0.022, wrapChars: 40,
  }),
  items("syn-spec-two-sections", "two spec sections one after the other", "spec", ["C04-4.3"], {
    entries: [
      { heading: true, text: "SECTION 08 71 00 - LOREM NULLA" },
      { key: "PART 1", text: "GENERAL" },
      { key: "1.01", text: words(2, 10), level: 1 },
      { heading: true, text: "END OF SECTION" },
      { heading: true, text: "SECTION 09 91 23 - LOREM" },
      { key: "PART 1", text: "GENERAL" },
      { key: "1.01", text: words(4, 12), level: 1 },
    ],
    levelIndent: 0.01, indent: 0.022, wrapChars: 40,
  }),
  items("syn-spec-sentence-header-trap", "body sentences that begin with 'see note 4' and 'Notes:'", "spec", ["K34", "C04-09"], {
    entries: [
      { heading: true, text: "SECTION 06 10 00 - LOREM" },
      { key: "1.01", text: words(1, 8), level: 1 },
      { key: "A.", text: `see note 4 ${words(2, 8, false)}`, level: 2 },
      { key: "B.", text: `Notes: provide ${words(3, 7, false)}`, level: 2 },
      { key: "1.02", text: words(5, 9), level: 1 },
    ],
    levelIndent: 0.01, indent: 0.022, wrapChars: 40,
  }),
  items("syn-spec-multicolumn-dense", "dense spec text in two columns", "spec", ["C04-4.3", "K33"], {
    entries: [
      { heading: true, text: "SECTION 07 92 00 - LOREM" },
      { key: "PART 1", text: "GENERAL" },
      ...Array.from({ length: 4 }, (_, i) => ({ key: `1.0${i + 1}`, text: words(i, 14), level: 1 })),
      { key: "PART 2", text: "PRODUCTS" },
      ...Array.from({ length: 4 }, (_, i) => ({ key: `2.0${i + 1}`, text: words(i + 4, 14), level: 1 })),
    ],
    columns: 2, columnGap: 0.025, levelIndent: 0.008, indent: 0.022, wrapChars: 30, linePitch: 0.009, lineH: 0.0065,
  }),
];

export const LAYOUTS: readonly Layout[] = [...GRIDS, ...KEYNOTE_GRIDS, ...NOTES, ...KV, ...SPECS];
