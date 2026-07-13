// @vitest-environment node
// [refactor jul11 P2.4 S2] Exact contract for the sole parse owner.
//
// F0 characterized the legacy owner and S1 ran this complete matrix against both owners. S2 makes
// parseFlowStore sole owner; old-owner absence is enforced by the phase topology/oracle suite.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useParseFlowStore,
  type GuidedParseOwner,
  type ParseFlowState,
} from "@/stores/parseFlowStore";
import {
  PARSE_TEST_ACTION_KEYS,
  PARSE_TEST_STATE_KEYS,
} from "@/test/viewer-store-state";

type ParseState = ParseFlowState;

export const PARSE_DATA_KEYS = [
  "tableParseStep",
  "tableParseRegion",
  "tableParsedGrid",
  "tableParseMeta",
  "tableCellStructure",
  "showTableCellStructure",
  "tableParseColumnBBs",
  "tableParseColumnNames",
  "tableParseRowBBs",
  "tableParseTab",
  "tableParseOptions",
  "keynoteParseTab",
  "keynoteParseStep",
  "keynoteParseRegion",
  "keynoteColumnBBs",
  "keynoteRowBBs",
  "keynoteYoloClass",
  "parsedKeynoteData",
  "notesParseStep",
  "notesParseRegion",
  "guidedNotesRows",
  "guidedNotesCols",
  "notesFastManualActive",
  "notesFastManualGrid",
  "parseDraftRegion",
  "specParseStep",
  "specParseRegion",
  "guidedSpecSectionBBs",
  "paragraphOverlayActive",
  "paragraphBatch",
  "paragraphClipboard",
  "guidedParseActive",
  "guidedParseRegion",
  "guidedParseRows",
  "guidedParseCols",
] as const satisfies readonly (keyof ParseState)[];

export const PARSE_ACTION_KEYS = [
  "setTableParseRegion",
  "setTableParsedGrid",
  "setTableParseMeta",
  "setTableCellStructure",
  "toggleCellHighlight",
  "setShowTableCellStructure",
  "addTableParseColumnBB",
  "setTableParseColumnNames",
  "addTableParseRowBB",
  "setTableParseRowBBs",
  "resetTableParse",
  "setTableParseTab",
  "setTableParseOptions",
  "setKeynoteParseTab",
  "setKeynoteParseRegion",
  "addKeynoteColumnBB",
  "addKeynoteRowBB",
  "setKeynoteYoloClass",
  "setParsedKeynoteData",
  "addParsedKeynote",
  "resetKeynoteParse",
  "setNotesParseRegion",
  "addGuidedNotesRow",
  "addGuidedNotesCol",
  "resetNotesParse",
  "setNotesFastManualActive",
  "setNotesFastManualGrid",
  "setParseDraftRegion",
  "setSpecParseRegion",
  "addGuidedSpecSectionBB",
  "resetSpecParse",
  "setParagraphOverlayActive",
  "setParagraphBatch",
  "upsertPendingParagraph",
  "removePendingParagraph",
  "setParagraphClipboard",
  "setGuidedParseActive",
  "setGuidedParseRegion",
  "setGuidedParseRows",
  "setGuidedParseCols",
  "resetGuidedParse",
] as const satisfies readonly (keyof ParseState)[];

/** A2 is additive: keep the characterized 35/41 contract exact as a named legacy subset. */
const PARSE_ADDITIVE_DATA_KEYS = [
  "guidedParseOwner",
  "parseOperations",
] as const satisfies readonly (keyof ParseState)[];

const PARSE_OPERATION_ACTION_KEYS = [
  "beginParseOperation",
  "isParseOperationCurrent",
  "finishParseOperation",
  "invalidateParseOperation",
] as const satisfies readonly (keyof ParseState)[];

export const PROJECT_PARSE_RETAINED_KEYS = [
  "tableCellStructure",
  "showTableCellStructure",
  "tableParseOptions",
] as const satisfies readonly (typeof PARSE_DATA_KEYS)[number][];

export const RESET_ALL_PARSE_RETAINED_KEYS = [
  "tableParseTab",
  "tableParseOptions",
  "showTableCellStructure",
  "keynoteParseTab",
  "parsedKeynoteData",
  "notesFastManualActive",
  "notesFastManualGrid",
  "paragraphClipboard",
] as const satisfies readonly (typeof PARSE_DATA_KEYS)[number][];

const RESET_ARRAY_KEYS = [
  "tableParseColumnBBs",
  "tableParseColumnNames",
  "tableParseRowBBs",
  "keynoteColumnBBs",
  "keynoteRowBBs",
  "guidedNotesRows",
  "guidedNotesCols",
  "guidedSpecSectionBBs",
  "paragraphBatch",
  "guidedParseRows",
  "guidedParseCols",
] as const satisfies readonly ParseDataKey[];

type ParseDataKey = (typeof PARSE_DATA_KEYS)[number];
type ParseActionKey = (typeof PARSE_ACTION_KEYS)[number];

const BBOX_A = [0.1, 0.2, 0.7, 0.8] as const;
const BBOX_B = [0.2, 0.3, 0.8, 0.9] as const;

const GRID: NonNullable<ParseState["tableParsedGrid"]> = {
  headers: ["TAG", "SIZE"],
  rows: [{ TAG: "D-101", SIZE: "3070" }],
  tagColumn: "TAG",
  tableName: "DOOR SCHEDULE",
  colBoundaries: [0.2, 0.7],
  rowBoundaries: [0.3, 0.6],
};

const META: NonNullable<ParseState["tableParseMeta"]> = {
  methodResults: [{
    method: "fixture",
    headers: ["TAG"],
    rows: [{ TAG: "D-101" }],
    confidence: 0.9,
  }],
  baseMethod: "fixture",
  mergedSnapshot: { headers: ["TAG"], rows: [{ TAG: "D-101" }] },
};

const CELL_A = {
  bbox: [...BBOX_A] as [number, number, number, number],
  row: 0,
  col: 0,
  rowSpan: 1,
  colSpan: 1,
  type: "body",
  confidence: 0.9,
  text: "D-101",
  highlighted: false,
};
const CELL_B = { ...CELL_A, bbox: [...BBOX_B] as [number, number, number, number], col: 1, text: "3070" };
const CELL_STRUCTURE: NonNullable<ParseState["tableCellStructure"]> = {
  cells: [CELL_A, CELL_B],
  pageNumber: 4,
  regionBbox: [...BBOX_A],
};

const KEYNOTE_ENTRY: NonNullable<ParseState["parsedKeynoteData"]>[number] = {
  pageNumber: 4,
  keys: [{ key: "1", description: "Door" }],
  yoloClass: "door_single",
  tableName: "KEYNOTES",
};

const DRAFT: NonNullable<ParseState["parseDraftRegion"]> = {
  id: "draft-1",
  type: "notes",
  category: "general-notes",
  bbox: [...BBOX_A],
  confidence: 1,
  data: { headers: ["NOTE"], rows: [{ NOTE: "fixture" }] },
};

const PARAGRAPH: NonNullable<ParseState["paragraphBatch"]>[number] = {
  id: "paragraph-1",
  bbox: [...BBOX_A],
  lines: [],
  rowText: { Note: "fixture" },
  colBoundaries: [0.3, 0.7],
};

const CLIPBOARD: NonNullable<ParseState["paragraphClipboard"]> = {
  colBoundaries: [0.3, 0.7],
  headers: ["Note", "Description"],
};

function restoreOwner(): void {
  useParseFlowStore.setState(useParseFlowStore.getInitialState(), true);
}

function resetAllParseForIsolatedOwner(): void {
  const owner = useParseFlowStore.getState();
  owner.resetTableParse();
  owner.resetKeynoteParse();
  owner.resetNotesParse();
  owner.resetSpecParse();
  owner.resetGuidedParse();
}

function resetProjectParseForIsolatedOwner(): void {
  useParseFlowStore.getState().resetProjectParseState();
}

function pickParseData(state: ParseState): Pick<ParseState, ParseDataKey> {
  return Object.fromEntries(PARSE_DATA_KEYS.map((key) => [key, state[key]])) as Pick<
    ParseState,
    ParseDataKey
  >;
}

function pickParseActions(state: ParseState): Pick<ParseState, ParseActionKey> {
  return Object.fromEntries(PARSE_ACTION_KEYS.map((key) => [key, state[key]])) as Pick<
    ParseState,
    ParseActionKey
  >;
}

function expectParseActionsStable(
  before: Pick<ParseState, ParseActionKey>,
  after: ParseState,
): void {
  for (const key of PARSE_ACTION_KEYS) {
    expect(after[key], `retains action ${key}`).toBe(before[key]);
  }
}

const PARSE_MUTABLE_DATA_KEY_SET = new Set<string>([
  ...PARSE_DATA_KEYS,
  ...PARSE_ADDITIVE_DATA_KEYS,
]);

function expectNonDataSurfaceStable(
  before: ParseState,
  after: ParseState,
  options: { allowOperationChange?: boolean } = {},
): void {
  const previous = before as unknown as Record<string, unknown>;
  const current = after as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  for (const key of keys) {
    if (PARSE_MUTABLE_DATA_KEY_SET.has(key)) {
      if (key !== "parseOperations" || options.allowOperationChange) continue;
      expect(current[key], "retains additive operation registry").toBe(previous[key]);
      continue;
    }
    expect(
      Object.prototype.hasOwnProperty.call(current, key),
      `retains every non-parse-data key ${key}`,
    ).toBe(Object.prototype.hasOwnProperty.call(previous, key));
    expect(current[key], `retains every non-parse-data value ${key}`).toBe(previous[key]);
  }
}

function changedParseKeys(before: ParseState, after: ParseState): ParseDataKey[] {
  return PARSE_DATA_KEYS.filter((key) => !Object.is(before[key], after[key])).sort();
}

function sorted(keys: readonly ParseDataKey[]): ParseDataKey[] {
  return [...keys].sort();
}

function nonDefaultParsePatch(): Pick<ParseState, ParseDataKey> {
  return {
    tableParseStep: "review",
    tableParseRegion: [...BBOX_A],
    tableParsedGrid: GRID,
    tableParseMeta: META,
    tableCellStructure: CELL_STRUCTURE,
    showTableCellStructure: true,
    tableParseColumnBBs: [[...BBOX_A]],
    tableParseColumnNames: ["TAG"],
    tableParseRowBBs: [[...BBOX_B]],
    tableParseTab: "compare",
    tableParseOptions: {
      rowTolerance: 0.02,
      minColGap: 0.03,
      colHitRatio: 0.8,
      headerMode: "none",
      minHLineLengthRatio: 0.4,
      minVLineLengthRatio: 0.5,
      clusteringTolerance: 27,
      mergerEditDistance: 5,
    },
    keynoteParseTab: "compare",
    keynoteParseStep: "review",
    keynoteParseRegion: [...BBOX_B],
    keynoteColumnBBs: [[...BBOX_A]],
    keynoteRowBBs: [[...BBOX_B]],
    keynoteYoloClass: { model: "fixture", className: "door_single" },
    parsedKeynoteData: [KEYNOTE_ENTRY],
    notesParseStep: "review",
    notesParseRegion: [...BBOX_A],
    guidedNotesRows: [[...BBOX_A]],
    guidedNotesCols: [[...BBOX_B]],
    notesFastManualActive: true,
    notesFastManualGrid: {
      headers: ["Note"],
      rows: [{ Note: "fixture" }],
      colBoundaries: [0.4],
      rowBoundaries: [0.6],
    },
    parseDraftRegion: DRAFT,
    specParseStep: "review",
    specParseRegion: [...BBOX_B],
    guidedSpecSectionBBs: [[...BBOX_A]],
    paragraphOverlayActive: true,
    paragraphBatch: [PARAGRAPH],
    paragraphClipboard: CLIPBOARD,
    guidedParseActive: true,
    guidedParseRegion: [...BBOX_A],
    guidedParseRows: [0.25, 0.75],
    guidedParseCols: [0.2, 0.8],
  };
}

beforeEach(restoreOwner);

describe("P2.4 shared parse boundary and defaults", () => {
  it("owns an independent unique 35-data / 41-leaf-action contract", () => {
    expect(PARSE_DATA_KEYS).toHaveLength(35);
    expect(new Set(PARSE_DATA_KEYS).size).toBe(35);
    expect(PARSE_ACTION_KEYS).toHaveLength(41);
    expect(new Set(PARSE_ACTION_KEYS).size).toBe(41);
    // The mixed test seam may seed the new shared-workspace owner, but operation registry bytes
    // remain owner-controlled and are never accepted as setup patches.
    expect(PARSE_TEST_STATE_KEYS).toEqual([
      ...PARSE_DATA_KEYS.slice(0, 31),
      "guidedParseOwner",
      ...PARSE_DATA_KEYS.slice(31),
    ]);
    expect(PARSE_TEST_ACTION_KEYS).toEqual(PARSE_ACTION_KEYS);
    expect(PROJECT_PARSE_RETAINED_KEYS).toHaveLength(3);
    expect(RESET_ALL_PARSE_RETAINED_KEYS).toHaveLength(8);
    const state = useParseFlowStore.getState();
    for (const action of PARSE_ACTION_KEYS) expect(state[action]).toBeTypeOf("function");
    expect(Object.entries(state)
      .filter(([, value]) => typeof value !== "function")
      .map(([key]) => key)
      .sort()).toEqual([...PARSE_DATA_KEYS, ...PARSE_ADDITIVE_DATA_KEYS].sort());
    expect(Object.entries(state)
      .filter(([, value]) => typeof value === "function")
      .map(([key]) => key)
      .sort()).toEqual([
        ...PARSE_ACTION_KEYS,
        ...PARSE_OPERATION_ACTION_KEYS,
        "resetProjectParseState",
      ].sort());
    expect(state.resetProjectParseState).toBeTypeOf("function");
  });

  it("freezes every construction default", () => {
    const guidedOwner: GuidedParseOwner = useParseFlowStore.getInitialState().guidedParseOwner;
    expect(guidedOwner).toBeNull();
    expect(pickParseData(useParseFlowStore.getInitialState())).toEqual({
      tableParseStep: "idle",
      tableParseRegion: null,
      tableParsedGrid: null,
      tableParseMeta: null,
      tableCellStructure: null,
      showTableCellStructure: false,
      tableParseColumnBBs: [],
      tableParseColumnNames: [],
      tableParseRowBBs: [],
      tableParseTab: "all",
      tableParseOptions: {
        rowTolerance: 0.006,
        minColGap: 0.015,
        colHitRatio: 0.3,
        headerMode: "auto",
        minHLineLengthRatio: 0.15,
        minVLineLengthRatio: 0.10,
        clusteringTolerance: 15,
        mergerEditDistance: 2,
      },
      keynoteParseTab: "all",
      keynoteParseStep: "idle",
      keynoteParseRegion: null,
      keynoteColumnBBs: [],
      keynoteRowBBs: [],
      keynoteYoloClass: null,
      parsedKeynoteData: null,
      notesParseStep: "idle",
      notesParseRegion: null,
      guidedNotesRows: [],
      guidedNotesCols: [],
      notesFastManualActive: false,
      notesFastManualGrid: null,
      parseDraftRegion: null,
      specParseStep: "idle",
      specParseRegion: null,
      guidedSpecSectionBBs: [],
      paragraphOverlayActive: false,
      paragraphBatch: [],
      paragraphClipboard: null,
      guidedParseActive: false,
      guidedParseRegion: null,
      guidedParseRows: [],
      guidedParseCols: [],
    });

    const initial = useParseFlowStore.getInitialState();
    expect(new Set(RESET_ARRAY_KEYS.map((key) => initial[key])).size).toBe(11);
  });
});

const PUBLICATION_CASES: readonly { name: ParseActionKey; invoke: () => void }[] = [
  { name: "setTableParseRegion", invoke: () => useParseFlowStore.getState().setTableParseRegion(null) },
  { name: "setTableParsedGrid", invoke: () => useParseFlowStore.getState().setTableParsedGrid(null) },
  { name: "setTableParseMeta", invoke: () => useParseFlowStore.getState().setTableParseMeta(null) },
  { name: "setTableCellStructure", invoke: () => useParseFlowStore.getState().setTableCellStructure(null) },
  { name: "toggleCellHighlight", invoke: () => useParseFlowStore.getState().toggleCellHighlight(0, 0) },
  { name: "setShowTableCellStructure", invoke: () => useParseFlowStore.getState().setShowTableCellStructure(false) },
  { name: "addTableParseColumnBB", invoke: () => useParseFlowStore.getState().addTableParseColumnBB([...BBOX_A]) },
  { name: "setTableParseColumnNames", invoke: () => { const state = useParseFlowStore.getState(); state.setTableParseColumnNames(state.tableParseColumnNames); } },
  { name: "addTableParseRowBB", invoke: () => useParseFlowStore.getState().addTableParseRowBB([...BBOX_A]) },
  { name: "setTableParseRowBBs", invoke: () => { const state = useParseFlowStore.getState(); state.setTableParseRowBBs(state.tableParseRowBBs); } },
  { name: "resetTableParse", invoke: () => useParseFlowStore.getState().resetTableParse() },
  { name: "setTableParseTab", invoke: () => useParseFlowStore.getState().setTableParseTab("all") },
  { name: "setTableParseOptions", invoke: () => useParseFlowStore.getState().setTableParseOptions({}) },
  { name: "setKeynoteParseTab", invoke: () => useParseFlowStore.getState().setKeynoteParseTab("all") },
  { name: "setKeynoteParseRegion", invoke: () => useParseFlowStore.getState().setKeynoteParseRegion(null) },
  { name: "addKeynoteColumnBB", invoke: () => useParseFlowStore.getState().addKeynoteColumnBB([...BBOX_A]) },
  { name: "addKeynoteRowBB", invoke: () => useParseFlowStore.getState().addKeynoteRowBB([...BBOX_A]) },
  { name: "setKeynoteYoloClass", invoke: () => useParseFlowStore.getState().setKeynoteYoloClass(null) },
  { name: "setParsedKeynoteData", invoke: () => useParseFlowStore.getState().setParsedKeynoteData(null) },
  { name: "addParsedKeynote", invoke: () => useParseFlowStore.getState().addParsedKeynote(KEYNOTE_ENTRY) },
  { name: "resetKeynoteParse", invoke: () => useParseFlowStore.getState().resetKeynoteParse() },
  { name: "setNotesParseRegion", invoke: () => useParseFlowStore.getState().setNotesParseRegion(null) },
  { name: "addGuidedNotesRow", invoke: () => useParseFlowStore.getState().addGuidedNotesRow([...BBOX_A]) },
  { name: "addGuidedNotesCol", invoke: () => useParseFlowStore.getState().addGuidedNotesCol([...BBOX_A]) },
  { name: "resetNotesParse", invoke: () => useParseFlowStore.getState().resetNotesParse() },
  { name: "setNotesFastManualActive", invoke: () => useParseFlowStore.getState().setNotesFastManualActive(false) },
  { name: "setNotesFastManualGrid", invoke: () => useParseFlowStore.getState().setNotesFastManualGrid(null) },
  { name: "setParseDraftRegion", invoke: () => useParseFlowStore.getState().setParseDraftRegion(null) },
  { name: "setSpecParseRegion", invoke: () => useParseFlowStore.getState().setSpecParseRegion(null) },
  { name: "addGuidedSpecSectionBB", invoke: () => useParseFlowStore.getState().addGuidedSpecSectionBB([...BBOX_A]) },
  { name: "resetSpecParse", invoke: () => useParseFlowStore.getState().resetSpecParse() },
  { name: "setParagraphOverlayActive", invoke: () => useParseFlowStore.getState().setParagraphOverlayActive(false) },
  { name: "setParagraphBatch", invoke: () => { const state = useParseFlowStore.getState(); state.setParagraphBatch(state.paragraphBatch); } },
  { name: "upsertPendingParagraph", invoke: () => useParseFlowStore.getState().upsertPendingParagraph(PARAGRAPH) },
  { name: "removePendingParagraph", invoke: () => useParseFlowStore.getState().removePendingParagraph("absent") },
  { name: "setParagraphClipboard", invoke: () => useParseFlowStore.getState().setParagraphClipboard(null) },
  { name: "setGuidedParseActive", invoke: () => useParseFlowStore.getState().setGuidedParseActive(false) },
  { name: "setGuidedParseRegion", invoke: () => useParseFlowStore.getState().setGuidedParseRegion(null) },
  { name: "setGuidedParseRows", invoke: () => { const state = useParseFlowStore.getState(); state.setGuidedParseRows(state.guidedParseRows); } },
  { name: "setGuidedParseCols", invoke: () => { const state = useParseFlowStore.getState(); state.setGuidedParseCols(state.guidedParseCols); } },
  { name: "resetGuidedParse", invoke: () => useParseFlowStore.getState().resetGuidedParse() },
];

const SIMPLE_DESTINATION_CASES: readonly {
  name: ParseActionKey;
  key: ParseDataKey;
  invoke: () => void;
  expected: unknown;
  identity?: unknown;
}[] = [
  { name: "setTableParseRegion", key: "tableParseRegion", invoke: () => useParseFlowStore.getState().setTableParseRegion([...BBOX_A]), expected: BBOX_A },
  { name: "setTableParsedGrid", key: "tableParsedGrid", invoke: () => useParseFlowStore.getState().setTableParsedGrid(GRID), expected: GRID, identity: GRID },
  { name: "setTableParseMeta", key: "tableParseMeta", invoke: () => useParseFlowStore.getState().setTableParseMeta(META), expected: META, identity: META },
  { name: "setShowTableCellStructure", key: "showTableCellStructure", invoke: () => useParseFlowStore.getState().setShowTableCellStructure(true), expected: true },
  { name: "setTableParseColumnNames", key: "tableParseColumnNames", invoke: () => { const value = ["TAG"]; useParseFlowStore.getState().setTableParseColumnNames(value); }, expected: ["TAG"] },
  { name: "setTableParseRowBBs", key: "tableParseRowBBs", invoke: () => { const value: [number, number, number, number][] = [[...BBOX_A]]; useParseFlowStore.getState().setTableParseRowBBs(value); }, expected: [BBOX_A] },
  { name: "setTableParseTab", key: "tableParseTab", invoke: () => useParseFlowStore.getState().setTableParseTab("compare"), expected: "compare" },
  { name: "setTableParseOptions", key: "tableParseOptions", invoke: () => useParseFlowStore.getState().setTableParseOptions({ rowTolerance: 0.02 }), expected: { ...useParseFlowStore.getInitialState().tableParseOptions, rowTolerance: 0.02 } },
  { name: "setKeynoteParseTab", key: "keynoteParseTab", invoke: () => useParseFlowStore.getState().setKeynoteParseTab("compare"), expected: "compare" },
  { name: "setKeynoteParseRegion", key: "keynoteParseRegion", invoke: () => useParseFlowStore.getState().setKeynoteParseRegion([...BBOX_B]), expected: BBOX_B },
  { name: "setKeynoteYoloClass", key: "keynoteYoloClass", invoke: () => { const value = { model: "fixture", className: "door_single" }; useParseFlowStore.getState().setKeynoteYoloClass(value); }, expected: { model: "fixture", className: "door_single" } },
  { name: "setParsedKeynoteData", key: "parsedKeynoteData", invoke: () => { const value = [KEYNOTE_ENTRY]; useParseFlowStore.getState().setParsedKeynoteData(value); }, expected: [KEYNOTE_ENTRY] },
  { name: "setNotesParseRegion", key: "notesParseRegion", invoke: () => useParseFlowStore.getState().setNotesParseRegion([...BBOX_A]), expected: BBOX_A },
  { name: "setNotesFastManualActive", key: "notesFastManualActive", invoke: () => useParseFlowStore.getState().setNotesFastManualActive(true), expected: true },
  { name: "setNotesFastManualGrid", key: "notesFastManualGrid", invoke: () => { const value = nonDefaultParsePatch().notesFastManualGrid; useParseFlowStore.getState().setNotesFastManualGrid(value); }, expected: nonDefaultParsePatch().notesFastManualGrid },
  { name: "setParseDraftRegion", key: "parseDraftRegion", invoke: () => useParseFlowStore.getState().setParseDraftRegion(DRAFT), expected: DRAFT, identity: DRAFT },
  { name: "setSpecParseRegion", key: "specParseRegion", invoke: () => useParseFlowStore.getState().setSpecParseRegion([...BBOX_B]), expected: BBOX_B },
  { name: "setParagraphOverlayActive", key: "paragraphOverlayActive", invoke: () => useParseFlowStore.getState().setParagraphOverlayActive(true), expected: true },
  { name: "setParagraphBatch", key: "paragraphBatch", invoke: () => { const value = [PARAGRAPH]; useParseFlowStore.getState().setParagraphBatch(value); }, expected: [PARAGRAPH] },
  { name: "setParagraphClipboard", key: "paragraphClipboard", invoke: () => useParseFlowStore.getState().setParagraphClipboard(CLIPBOARD), expected: CLIPBOARD, identity: CLIPBOARD },
  { name: "setGuidedParseActive", key: "guidedParseActive", invoke: () => useParseFlowStore.getState().setGuidedParseActive(true), expected: true },
  { name: "setGuidedParseRegion", key: "guidedParseRegion", invoke: () => useParseFlowStore.getState().setGuidedParseRegion([...BBOX_A]), expected: BBOX_A },
  { name: "setGuidedParseRows", key: "guidedParseRows", invoke: () => { const value = [0.25, 0.75]; useParseFlowStore.getState().setGuidedParseRows(value); }, expected: [0.25, 0.75] },
  { name: "setGuidedParseCols", key: "guidedParseCols", invoke: () => { const value = [0.2, 0.8]; useParseFlowStore.getState().setGuidedParseCols(value); }, expected: [0.2, 0.8] },
];

const SPECIAL_ACTION_KEYS = [
  "setTableCellStructure",
  "toggleCellHighlight",
  "addTableParseColumnBB",
  "addTableParseRowBB",
  "resetTableParse",
  "addKeynoteColumnBB",
  "addKeynoteRowBB",
  "addParsedKeynote",
  "resetKeynoteParse",
  "addGuidedNotesRow",
  "addGuidedNotesCol",
  "resetNotesParse",
  "addGuidedSpecSectionBB",
  "resetSpecParse",
  "upsertPendingParagraph",
  "removePendingParagraph",
  "resetGuidedParse",
] as const satisfies readonly ParseActionKey[];

describe("P2.4 sole parse leaf publications", () => {
  it("covers every action once and in the independent ledger order", () => {
    expect(PUBLICATION_CASES.map(({ name }) => name)).toEqual(PARSE_ACTION_KEYS);
    expect([
      ...SIMPLE_DESTINATION_CASES.map(({ name }) => name),
      ...SPECIAL_ACTION_KEYS,
    ].sort()).toEqual([...PARSE_ACTION_KEYS].sort());
  });

  it.each(PUBLICATION_CASES)("$name publishes exactly once, including semantic no-ops", ({ name, invoke }) => {
    const before = useParseFlowStore.getState();
    const actionsBefore = pickParseActions(before);
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);
    invoke();
    const after = useParseFlowStore.getState();
    expect(listener).toHaveBeenCalledTimes(1);
    expectParseActionsStable(actionsBefore, after);
    expectNonDataSurfaceStable(before, after, {
      allowOperationChange: [
        "resetTableParse",
        "resetKeynoteParse",
        "resetNotesParse",
        "resetSpecParse",
      ].includes(name),
    });
    unsubscribe();
  });
});

describe("P2.4 shared simple action destinations", () => {
  it.each(SIMPLE_DESTINATION_CASES)("$name changes exactly $key to its requested destination", ({ key, invoke, expected }) => {
    const before = useParseFlowStore.getState();
    invoke();
    const after = useParseFlowStore.getState();
    expect(changedParseKeys(before, after)).toEqual([key]);
    expect(after[key]).toEqual(expected);
    expectNonDataSurfaceStable(before, after);
  });
});

describe("P2.4 shared compound actions and identity", () => {
  it("setTableCellStructure retains the caller object and derives visibility in one publication", () => {
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);
    const beforeSet = useParseFlowStore.getState();
    useParseFlowStore.getState().setTableCellStructure(CELL_STRUCTURE);
    const afterSet = useParseFlowStore.getState();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(changedParseKeys(beforeSet, afterSet)).toEqual([
      "showTableCellStructure",
      "tableCellStructure",
    ]);
    expect(afterSet.tableCellStructure).toBe(CELL_STRUCTURE);
    expect(afterSet.showTableCellStructure).toBe(true);
    expectNonDataSurfaceStable(beforeSet, afterSet);

    const beforeClear = useParseFlowStore.getState();
    useParseFlowStore.getState().setTableCellStructure(null);
    const afterClear = useParseFlowStore.getState();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(changedParseKeys(beforeClear, afterClear)).toEqual([
      "showTableCellStructure",
      "tableCellStructure",
    ]);
    expect(afterClear.tableCellStructure).toBeNull();
    expect(afterClear.showTableCellStructure).toBe(false);
    expectNonDataSurfaceStable(beforeClear, afterClear);
    unsubscribe();
  });

  it("toggleCellHighlight publishes an empty patch without structure, then clones only the hit path", () => {
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);
    const beforeEmpty = useParseFlowStore.getState();
    beforeEmpty.toggleCellHighlight(0, 0);
    const afterEmpty = useParseFlowStore.getState();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(changedParseKeys(beforeEmpty, afterEmpty)).toEqual([]);
    expectNonDataSurfaceStable(beforeEmpty, afterEmpty);

    useParseFlowStore.setState({ tableCellStructure: CELL_STRUCTURE });
    const beforeState = useParseFlowStore.getState();
    const before = beforeState.tableCellStructure!;
    useParseFlowStore.getState().toggleCellHighlight(0, 0);
    const afterState = useParseFlowStore.getState();
    const after = afterState.tableCellStructure!;
    expect(listener).toHaveBeenCalledTimes(3);
    expect(changedParseKeys(beforeState, afterState)).toEqual(["tableCellStructure"]);
    expect(after).not.toBe(before);
    expect(after.cells).not.toBe(before.cells);
    expect(after.cells[0]).not.toBe(before.cells[0]);
    expect(after.cells[0].highlighted).toBe(true);
    expect(after.cells[1]).toBe(before.cells[1]);
    expectNonDataSurfaceStable(beforeState, afterState);
    unsubscribe();
  });

  it("raw object/array setters preserve caller identity", () => {
    const tableRegion = [...BBOX_A] as [number, number, number, number];
    const names = ["TAG", "SIZE"];
    const rows = [[...BBOX_A] as [number, number, number, number]];
    const keynoteRegion = [...BBOX_B] as [number, number, number, number];
    const keynoteClass = { model: "fixture", className: "door_single" };
    const keynoteData = [KEYNOTE_ENTRY];
    const guidedRows = [0.25, 0.75];
    const guidedCols = [0.3, 0.7];
    const paragraphs = [PARAGRAPH];
    const notesRegion = [...BBOX_A] as [number, number, number, number];
    const notesGrid = nonDefaultParsePatch().notesFastManualGrid;
    const specRegion = [...BBOX_B] as [number, number, number, number];
    const guidedRegion = [...BBOX_A] as [number, number, number, number];

    const state = useParseFlowStore.getState();
    state.setTableParseRegion(tableRegion);
    state.setTableParsedGrid(GRID);
    state.setTableParseMeta(META);
    state.setTableParseColumnNames(names);
    state.setTableParseRowBBs(rows);
    state.setKeynoteParseRegion(keynoteRegion);
    state.setKeynoteYoloClass(keynoteClass);
    state.setParsedKeynoteData(keynoteData);
    state.setNotesParseRegion(notesRegion);
    state.setParseDraftRegion(DRAFT);
    state.setNotesFastManualGrid(notesGrid);
    state.setSpecParseRegion(specRegion);
    state.setParagraphBatch(paragraphs);
    state.setParagraphClipboard(CLIPBOARD);
    state.setGuidedParseRegion(guidedRegion);
    state.setGuidedParseRows(guidedRows);
    state.setGuidedParseCols(guidedCols);

    const after = useParseFlowStore.getState();
    expect(after.tableParseRegion).toBe(tableRegion);
    expect(after.tableParsedGrid).toBe(GRID);
    expect(after.tableParseMeta).toBe(META);
    expect(after.tableParseColumnNames).toBe(names);
    expect(after.tableParseRowBBs).toBe(rows);
    expect(after.keynoteParseRegion).toBe(keynoteRegion);
    expect(after.keynoteYoloClass).toBe(keynoteClass);
    expect(after.parsedKeynoteData).toBe(keynoteData);
    expect(after.notesParseRegion).toBe(notesRegion);
    expect(after.parseDraftRegion).toBe(DRAFT);
    expect(after.notesFastManualGrid).toBe(notesGrid);
    expect(after.specParseRegion).toBe(specRegion);
    expect(after.paragraphBatch).toBe(paragraphs);
    expect(after.paragraphClipboard).toBe(CLIPBOARD);
    expect(after.guidedParseRegion).toBe(guidedRegion);
    expect(after.guidedParseRows).toBe(guidedRows);
    expect(after.guidedParseCols).toBe(guidedCols);
  });

  it("all BB/keynote append actions allocate one array and retain existing elements", () => {
    const first = [...BBOX_A] as [number, number, number, number];
    const second = [...BBOX_B] as [number, number, number, number];
    const cases = [
      ["tableParseColumnBBs", "addTableParseColumnBB"],
      ["tableParseRowBBs", "addTableParseRowBB"],
      ["keynoteColumnBBs", "addKeynoteColumnBB"],
      ["keynoteRowBBs", "addKeynoteRowBB"],
      ["guidedNotesRows", "addGuidedNotesRow"],
      ["guidedNotesCols", "addGuidedNotesCol"],
      ["guidedSpecSectionBBs", "addGuidedSpecSectionBB"],
    ] as const;

    for (const [dataKey, actionKey] of cases) {
      restoreOwner();
      useParseFlowStore.setState({ [dataKey]: [first] } as Partial<ParseState>);
      const beforeState = useParseFlowStore.getState();
      const before = beforeState[dataKey];
      const listener = vi.fn();
      const unsubscribe = useParseFlowStore.subscribe(listener);
      (useParseFlowStore.getState()[actionKey] as (bbox: [number, number, number, number]) => void)(second);
      const afterState = useParseFlowStore.getState();
      const after = afterState[dataKey];
      expect(listener, actionKey).toHaveBeenCalledTimes(1);
      expect(changedParseKeys(beforeState, afterState)).toEqual([dataKey]);
      expect(after).not.toBe(before);
      expect(after[0]).toBe(first);
      expect(after[1]).toBe(second);
      expectNonDataSurfaceStable(beforeState, afterState);
      unsubscribe();
    }

    restoreOwner();
    useParseFlowStore.setState({ parsedKeynoteData: [KEYNOTE_ENTRY] });
    const beforeState = useParseFlowStore.getState();
    const before = beforeState.parsedKeynoteData!;
    const existingListener = vi.fn();
    const unsubscribeExisting = useParseFlowStore.subscribe(existingListener);
    const secondEntry = { ...KEYNOTE_ENTRY, pageNumber: 5 };
    useParseFlowStore.getState().addParsedKeynote(secondEntry);
    const afterState = useParseFlowStore.getState();
    const after = afterState.parsedKeynoteData!;
    expect(existingListener).toHaveBeenCalledTimes(1);
    expect(changedParseKeys(beforeState, afterState)).toEqual(["parsedKeynoteData"]);
    expect(after).not.toBe(before);
    expect(after[0]).toBe(KEYNOTE_ENTRY);
    expect(after[1]).toBe(secondEntry);
    expectNonDataSurfaceStable(beforeState, afterState);
    unsubscribeExisting();

    restoreOwner();
    const emptyBefore = useParseFlowStore.getState();
    const emptyListener = vi.fn();
    const unsubscribeEmpty = useParseFlowStore.subscribe(emptyListener);
    useParseFlowStore.getState().addParsedKeynote(KEYNOTE_ENTRY);
    expect(emptyListener).toHaveBeenCalledTimes(1);
    expect(changedParseKeys(emptyBefore, useParseFlowStore.getState())).toEqual([
      "parsedKeynoteData",
    ]);
    expect(useParseFlowStore.getState().parsedKeynoteData).toEqual([KEYNOTE_ENTRY]);
    expectNonDataSurfaceStable(emptyBefore, useParseFlowStore.getState());
    unsubscribeEmpty();
  });

  it("options always shallow-clone while preserving untouched nested-free values", () => {
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);
    const beforeState = useParseFlowStore.getState();
    const before = beforeState.tableParseOptions;
    useParseFlowStore.getState().setTableParseOptions({});
    const afterEmptyState = useParseFlowStore.getState();
    const afterEmpty = afterEmptyState.tableParseOptions;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(changedParseKeys(beforeState, afterEmptyState)).toEqual(["tableParseOptions"]);
    expect(afterEmpty).not.toBe(before);
    expect(afterEmpty).toEqual(before);
    expectNonDataSurfaceStable(beforeState, afterEmptyState);
    useParseFlowStore.getState().setTableParseOptions({ rowTolerance: 0.04 });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(changedParseKeys(afterEmptyState, useParseFlowStore.getState())).toEqual([
      "tableParseOptions",
    ]);
    expect(useParseFlowStore.getState().tableParseOptions).toEqual({
      ...afterEmpty,
      rowTolerance: 0.04,
    });
    expectNonDataSurfaceStable(afterEmptyState, useParseFlowStore.getState());
    unsubscribe();
  });

  it("paragraph upsert/replace/remove always allocate and preserve index semantics", () => {
    const second = { ...PARAGRAPH, id: "paragraph-2" };
    useParseFlowStore.setState({ paragraphBatch: [PARAGRAPH] });
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);
    const beforeAppendState = useParseFlowStore.getState();
    const beforeAppend = beforeAppendState.paragraphBatch;
    useParseFlowStore.getState().upsertPendingParagraph(second);
    const afterAppendState = useParseFlowStore.getState();
    const afterAppend = afterAppendState.paragraphBatch;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(changedParseKeys(beforeAppendState, afterAppendState)).toEqual(["paragraphBatch"]);
    expect(afterAppend).not.toBe(beforeAppend);
    expect(afterAppend[0]).toBe(PARAGRAPH);
    expect(afterAppend[1]).toBe(second);
    expectNonDataSurfaceStable(beforeAppendState, afterAppendState);

    const replacement = { ...PARAGRAPH, rowText: { Note: "replacement" } };
    useParseFlowStore.getState().upsertPendingParagraph(replacement);
    const afterReplaceState = useParseFlowStore.getState();
    const afterReplace = afterReplaceState.paragraphBatch;
    expect(listener).toHaveBeenCalledTimes(2);
    expect(changedParseKeys(afterAppendState, afterReplaceState)).toEqual(["paragraphBatch"]);
    expect(afterReplace).not.toBe(afterAppend);
    expect(afterReplace[0]).toBe(replacement);
    expect(afterReplace[1]).toBe(second);
    expectNonDataSurfaceStable(afterAppendState, afterReplaceState);

    useParseFlowStore.getState().removePendingParagraph("absent");
    const afterAbsentState = useParseFlowStore.getState();
    const afterAbsentRemove = afterAbsentState.paragraphBatch;
    expect(listener).toHaveBeenCalledTimes(3);
    expect(changedParseKeys(afterReplaceState, afterAbsentState)).toEqual(["paragraphBatch"]);
    expect(afterAbsentRemove).not.toBe(afterReplace);
    expect(afterAbsentRemove).toEqual(afterReplace);
    expect(afterAbsentRemove[0]).toBe(replacement);
    expect(afterAbsentRemove[1]).toBe(second);
    expectNonDataSurfaceStable(afterReplaceState, afterAbsentState);

    useParseFlowStore.getState().removePendingParagraph("paragraph-2");
    const afterPresentState = useParseFlowStore.getState();
    const afterPresentRemove = afterPresentState.paragraphBatch;
    expect(listener).toHaveBeenCalledTimes(4);
    expect(changedParseKeys(afterAbsentState, afterPresentState)).toEqual(["paragraphBatch"]);
    expect(afterPresentRemove).not.toBe(afterAbsentRemove);
    expect(afterPresentRemove).toEqual([replacement]);
    expect(afterPresentRemove[0]).toBe(replacement);
    expectNonDataSurfaceStable(afterAbsentState, afterPresentState);
    unsubscribe();
  });
});

const RESET_CASES = [
  {
    name: "table",
    action: "resetTableParse",
    touched: [
      "tableParseStep", "tableParseRegion", "tableParsedGrid", "tableParseMeta",
      "tableCellStructure", "tableParseColumnBBs", "tableParseColumnNames", "tableParseRowBBs",
    ],
  },
  {
    name: "keynote",
    action: "resetKeynoteParse",
    touched: [
      "keynoteParseStep", "keynoteParseRegion", "keynoteColumnBBs", "keynoteRowBBs",
      "keynoteYoloClass",
    ],
  },
  {
    name: "notes",
    action: "resetNotesParse",
    touched: [
      "notesParseStep", "notesParseRegion", "guidedNotesRows", "guidedNotesCols",
      "parseDraftRegion", "paragraphOverlayActive", "paragraphBatch",
    ],
  },
  {
    name: "spec",
    action: "resetSpecParse",
    touched: [
      "specParseStep", "specParseRegion", "guidedSpecSectionBBs", "parseDraftRegion",
      "paragraphOverlayActive", "paragraphBatch",
    ],
  },
  {
    name: "guided",
    action: "resetGuidedParse",
    touched: ["guidedParseActive", "guidedParseRegion", "guidedParseRows", "guidedParseCols"],
  },
] as const satisfies readonly {
  name: string;
  action: ParseActionKey;
  touched: readonly ParseDataKey[];
}[];

describe("P2.4 shared reset matrices", () => {
  it.each(RESET_CASES)("$name reset touches only its exact matrix and allocates reset containers", ({ action, touched }) => {
    useParseFlowStore.setState({
      ...nonDefaultParsePatch(),
      ...(action === "resetGuidedParse" ? { guidedParseOwner: "table" as const } : {}),
    });
    const before = useParseFlowStore.getState();
    const actionsBefore = pickParseActions(before);
    const initial = useParseFlowStore.getInitialState();
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);

    (before[action] as () => void)();
    const after = useParseFlowStore.getState();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(changedParseKeys(before, after)).toEqual(sorted(touched));
    const touchedSet = new Set<ParseDataKey>(touched);
    for (const key of PARSE_DATA_KEYS.filter((key) => !touchedSet.has(key))) {
      expect(after[key], `${action} retains ${key}`).toBe(before[key]);
    }
    for (const key of touched) {
      expect(after[key], `${action} resets ${key} to its construction destination`).toEqual(
        initial[key],
      );
      if (Array.isArray(after[key])) {
        expect(after[key], `${action} replaces ${key}`).not.toBe(before[key]);
        expect(after[key], `${action} does not reuse construction ${key}`).not.toBe(initial[key]);
      }
    }
    const resetArrays = touched.map((key) => after[key]).filter(Array.isArray);
    expect(new Set(resetArrays).size, `${action} reset arrays are pairwise distinct`).toBe(
      resetArrays.length,
    );
    expectParseActionsStable(actionsBefore, after);
    if (action === "resetGuidedParse") expect(after.guidedParseOwner).toBeNull();
    expectNonDataSurfaceStable(before, after, {
      allowOperationChange: action !== "resetGuidedParse",
    });
    unsubscribe();

    // Resetting an already-default flow still publishes and allocates each reset container. This
    // catches implementations that reuse construction arrays or suppress semantic no-ops.
    restoreOwner();
    const defaultBefore = useParseFlowStore.getState();
    const defaultActions = pickParseActions(defaultBefore);
    const defaultListener = vi.fn();
    const unsubscribeDefault = useParseFlowStore.subscribe(defaultListener);
    (defaultBefore[action] as () => void)();
    const defaultAfter = useParseFlowStore.getState();
    const arrayKeys = touched.filter((key) => Array.isArray(defaultBefore[key]));
    expect(defaultListener).toHaveBeenCalledTimes(1);
    expect(changedParseKeys(defaultBefore, defaultAfter)).toEqual(sorted(arrayKeys));
    expect(new Set(arrayKeys.map((key) => defaultAfter[key])).size).toBe(arrayKeys.length);
    for (const key of arrayKeys) expect(defaultAfter[key]).not.toBe(defaultBefore[key]);
    expectParseActionsStable(defaultActions, defaultAfter);
    expectNonDataSurfaceStable(defaultBefore, defaultAfter, {
      allowOperationChange: action !== "resetGuidedParse",
    });
    unsubscribeDefault();
  });

  it("resetAllTools changes exactly 27 parse fields, retains eight references, and publishes five parse resets", () => {
    useParseFlowStore.setState({ ...nonDefaultParsePatch(), guidedParseOwner: "keynote" });
    const before = useParseFlowStore.getState();
    const actionsBefore = pickParseActions(before);
    const initial = useParseFlowStore.getInitialState();
    const publications: Array<Pick<ParseState, ParseDataKey>> = [];
    const unsubscribe = useParseFlowStore.subscribe((state) => publications.push(pickParseData(state)));

    resetAllParseForIsolatedOwner();
    const after = useParseFlowStore.getState();

    expect(publications).toHaveLength(5);
    const retainedSet = new Set<ParseDataKey>(RESET_ALL_PARSE_RETAINED_KEYS);
    expect(changedParseKeys(before, after)).toEqual(sorted(
      PARSE_DATA_KEYS.filter((key) => !retainedSet.has(key)),
    ));
    for (const key of RESET_ALL_PARSE_RETAINED_KEYS) {
      expect(after[key], `resetAllTools retains ${key}`).toBe(before[key]);
    }
    for (const key of PARSE_DATA_KEYS.filter((key) => !retainedSet.has(key))) {
      expect(after[key], `resetAllTools resets ${key} to construction destination`).toEqual(
        initial[key],
      );
    }
    expect(RESET_ARRAY_KEYS.every((key) => after[key] !== before[key])).toBe(true);
    expect(RESET_ARRAY_KEYS.every((key) => after[key] !== initial[key])).toBe(true);
    expect(new Set(RESET_ARRAY_KEYS.map((key) => after[key])).size).toBe(
      RESET_ARRAY_KEYS.length,
    );
    const expectedPublicationChanges: readonly (readonly ParseDataKey[])[] = [
      RESET_CASES[0].touched,
      RESET_CASES[1].touched,
      RESET_CASES[2].touched,
      ["guidedSpecSectionBBs", "paragraphBatch", "specParseRegion", "specParseStep"],
      RESET_CASES[4].touched,
    ];
    let previous: Pick<ParseState, ParseDataKey> = pickParseData(before);
    for (const [index, publication] of publications.entries()) {
      expect(
        PARSE_DATA_KEYS.filter((key) => !Object.is(previous[key], publication[key])).sort(),
        `resetAllTools publication ${index + 1}`,
      ).toEqual(sorted(expectedPublicationChanges[index]));
      previous = publication;
    }
    // Notes creates the first empty shared paragraph workspace; Spec deliberately replaces that
    // already-empty array in its own later publication rather than collapsing the resets.
    expect(publications[0].tableParseStep).toBe("idle");
    expect(publications[0].keynoteParseStep).toBe("review");
    expect(publications[1].keynoteParseStep).toBe("idle");
    expect(publications[1].notesParseStep).toBe("review");
    expect(publications[2].notesParseStep).toBe("idle");
    expect(publications[2].paragraphBatch).toEqual([]);
    expect(publications[3].specParseStep).toBe("idle");
    expect(publications[3].paragraphBatch).toEqual([]);
    expect(publications[3].paragraphBatch).not.toBe(publications[2].paragraphBatch);
    expect(publications[4].guidedParseActive).toBe(false);
    expect(after.guidedParseOwner).toBeNull();
    expectParseActionsStable(actionsBefore, after);
    expectNonDataSurfaceStable(before, after, { allowOperationChange: true });
    unsubscribe();
  });

  it("project reset changes exactly 32 parse fields and retains the three current-policy references", () => {
    useParseFlowStore.setState({ ...nonDefaultParsePatch(), guidedParseOwner: "notes" });
    const before = useParseFlowStore.getState();
    const actionsBefore = pickParseActions(before);
    const initial = useParseFlowStore.getInitialState();
    const listener = vi.fn();
    const unsubscribe = useParseFlowStore.subscribe(listener);

    resetProjectParseForIsolatedOwner();
    const after = useParseFlowStore.getState();

    expect(listener).toHaveBeenCalledTimes(1);
    const retainedSet = new Set<ParseDataKey>(PROJECT_PARSE_RETAINED_KEYS);
    expect(changedParseKeys(before, after)).toEqual(sorted(
      PARSE_DATA_KEYS.filter((key) => !retainedSet.has(key)),
    ));
    for (const key of PROJECT_PARSE_RETAINED_KEYS) {
      expect(after[key], `project reset retains ${key}`).toBe(before[key]);
    }
    for (const key of PARSE_DATA_KEYS.filter((key) => !retainedSet.has(key))) {
      expect(after[key], `project reset resets ${key} to construction destination`).toEqual(
        initial[key],
      );
    }
    for (const key of RESET_ARRAY_KEYS) {
      expect(after[key], `project reset empties ${key}`).toEqual([]);
      expect(after[key], `project reset replaces ${key}`).not.toBe(before[key]);
      expect(after[key], `project reset does not reuse construction ${key}`).not.toBe(initial[key]);
    }
    expect(new Set(RESET_ARRAY_KEYS.map((key) => after[key])).size).toBe(
      RESET_ARRAY_KEYS.length,
    );
    expect(after.guidedParseOwner).toBeNull();
    expectParseActionsStable(actionsBefore, after);
    unsubscribe();
  });
});
