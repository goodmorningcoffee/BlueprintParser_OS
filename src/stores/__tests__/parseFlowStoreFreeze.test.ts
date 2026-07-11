// @vitest-environment node
// [refactor jul11 P2.4 S1] Exact isolated contract for the production-dead parse owner.
//
// F0 committed this entire behavior matrix against viewerStore. S1 now instantiates that same
// matrix against both the live legacy owner and the production-dead candidate, with only the two
// coordinator witnesses injected. S2 wires the neutral commands/helper atomically.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useParseFlowStore, type ParseFlowState } from "@/stores/parseFlowStore";
import { resetAllTools, resetProjectData } from "@/stores/viewerCommands";
import { useViewerStore as useLegacyViewerStore } from "@/stores/viewerStore";
import {
  PARSE_TEST_ACTION_KEYS,
  PARSE_TEST_STATE_KEYS,
} from "@/test/viewer-store-state";

type ParseState = ParseFlowState;

// One test body, two real Zustand owners. The Proxy forwards each access at execution time, after
// the enclosing owner-case beforeEach selects the live legacy store or isolated candidate. Keeping
// one matrix prevents the two parity suites from drifting apart.
let activeStore = useParseFlowStore;
const useViewerStore = new Proxy({} as typeof useParseFlowStore, {
  get: (_target, property) => activeStore[property as keyof typeof activeStore],
});
let activeResetAll = (): void => undefined;
let activeProjectReset = (): void => undefined;
let activeOwnerIsExactLeaf = false;

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
type LegacyParseContract = Pick<
  ReturnType<typeof useLegacyViewerStore.getState>,
  ParseDataKey | ParseActionKey
>;
type CandidateParseContract = Pick<ParseFlowState, ParseDataKey | ParseActionKey>;
type ExactTypeEqual<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
        (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;
const PARSE_CONTRACT_TYPES_MATCH: ExactTypeEqual<
  LegacyParseContract,
  CandidateParseContract
> = true;

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
  useViewerStore.setState(useViewerStore.getInitialState(), true);
}

function resetAllParseForIsolatedOwner(): void {
  activeResetAll();
}

function resetProjectParseForIsolatedOwner(): void {
  activeProjectReset();
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

const PARSE_MUTABLE_DATA_KEY_SET = new Set<string>(PARSE_DATA_KEYS);

function expectResidualViewerStable(before: ParseState, after: ParseState): void {
  const previous = before as unknown as Record<string, unknown>;
  const current = after as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  for (const key of keys) {
    if (PARSE_MUTABLE_DATA_KEY_SET.has(key)) continue;
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

type ParseOwnerCase = {
  readonly label: string;
  readonly store: typeof useParseFlowStore;
  readonly exactLeaf: boolean;
  readonly resetAll: () => void;
  readonly resetProject: () => void;
};

function defineParseOwnerContract(ownerCase: ParseOwnerCase): void {
  describe(ownerCase.label, () => {
    beforeEach(() => {
      activeStore = ownerCase.store;
      activeResetAll = ownerCase.resetAll;
      activeProjectReset = ownerCase.resetProject;
      activeOwnerIsExactLeaf = ownerCase.exactLeaf;
      restoreOwner();
    });

describe("P2.4 shared parse boundary and defaults", () => {
  it("owns an independent unique 35-data / 41-leaf-action contract", () => {
    expect(PARSE_DATA_KEYS).toHaveLength(35);
    expect(new Set(PARSE_DATA_KEYS).size).toBe(35);
    expect(PARSE_ACTION_KEYS).toHaveLength(41);
    expect(new Set(PARSE_ACTION_KEYS).size).toBe(41);
    expect(PARSE_TEST_STATE_KEYS).toEqual(PARSE_DATA_KEYS);
    expect(PARSE_TEST_ACTION_KEYS).toEqual(PARSE_ACTION_KEYS);
    expect(PROJECT_PARSE_RETAINED_KEYS).toHaveLength(3);
    expect(RESET_ALL_PARSE_RETAINED_KEYS).toHaveLength(8);
    expect(PARSE_CONTRACT_TYPES_MATCH).toBe(true);
    const state = useViewerStore.getState();
    for (const action of PARSE_ACTION_KEYS) expect(state[action]).toBeTypeOf("function");
    if (activeOwnerIsExactLeaf) {
      expect(Object.entries(state)
        .filter(([, value]) => typeof value !== "function")
        .map(([key]) => key)
        .sort()).toEqual([...PARSE_DATA_KEYS].sort());
      expect(Object.entries(state)
        .filter(([, value]) => typeof value === "function")
        .map(([key]) => key)
        .sort()).toEqual([...PARSE_ACTION_KEYS, "resetProjectParseState"].sort());
      expect(state.resetProjectParseState).toBeTypeOf("function");
    } else {
      for (const key of PARSE_DATA_KEYS) {
        expect(Object.prototype.hasOwnProperty.call(state, key), `${key} remains live`).toBe(true);
      }
      expect(Object.prototype.hasOwnProperty.call(state, "resetProjectParseState")).toBe(false);
    }
  });

  it("freezes every construction default", () => {
    expect(pickParseData(useViewerStore.getInitialState())).toEqual({
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

    const initial = useViewerStore.getInitialState();
    expect(new Set(RESET_ARRAY_KEYS.map((key) => initial[key])).size).toBe(11);
  });
});

const PUBLICATION_CASES: readonly { name: ParseActionKey; invoke: () => void }[] = [
  { name: "setTableParseRegion", invoke: () => useViewerStore.getState().setTableParseRegion(null) },
  { name: "setTableParsedGrid", invoke: () => useViewerStore.getState().setTableParsedGrid(null) },
  { name: "setTableParseMeta", invoke: () => useViewerStore.getState().setTableParseMeta(null) },
  { name: "setTableCellStructure", invoke: () => useViewerStore.getState().setTableCellStructure(null) },
  { name: "toggleCellHighlight", invoke: () => useViewerStore.getState().toggleCellHighlight(0, 0) },
  { name: "setShowTableCellStructure", invoke: () => useViewerStore.getState().setShowTableCellStructure(false) },
  { name: "addTableParseColumnBB", invoke: () => useViewerStore.getState().addTableParseColumnBB([...BBOX_A]) },
  { name: "setTableParseColumnNames", invoke: () => { const state = useViewerStore.getState(); state.setTableParseColumnNames(state.tableParseColumnNames); } },
  { name: "addTableParseRowBB", invoke: () => useViewerStore.getState().addTableParseRowBB([...BBOX_A]) },
  { name: "setTableParseRowBBs", invoke: () => { const state = useViewerStore.getState(); state.setTableParseRowBBs(state.tableParseRowBBs); } },
  { name: "resetTableParse", invoke: () => useViewerStore.getState().resetTableParse() },
  { name: "setTableParseTab", invoke: () => useViewerStore.getState().setTableParseTab("all") },
  { name: "setTableParseOptions", invoke: () => useViewerStore.getState().setTableParseOptions({}) },
  { name: "setKeynoteParseTab", invoke: () => useViewerStore.getState().setKeynoteParseTab("all") },
  { name: "setKeynoteParseRegion", invoke: () => useViewerStore.getState().setKeynoteParseRegion(null) },
  { name: "addKeynoteColumnBB", invoke: () => useViewerStore.getState().addKeynoteColumnBB([...BBOX_A]) },
  { name: "addKeynoteRowBB", invoke: () => useViewerStore.getState().addKeynoteRowBB([...BBOX_A]) },
  { name: "setKeynoteYoloClass", invoke: () => useViewerStore.getState().setKeynoteYoloClass(null) },
  { name: "setParsedKeynoteData", invoke: () => useViewerStore.getState().setParsedKeynoteData(null) },
  { name: "addParsedKeynote", invoke: () => useViewerStore.getState().addParsedKeynote(KEYNOTE_ENTRY) },
  { name: "resetKeynoteParse", invoke: () => useViewerStore.getState().resetKeynoteParse() },
  { name: "setNotesParseRegion", invoke: () => useViewerStore.getState().setNotesParseRegion(null) },
  { name: "addGuidedNotesRow", invoke: () => useViewerStore.getState().addGuidedNotesRow([...BBOX_A]) },
  { name: "addGuidedNotesCol", invoke: () => useViewerStore.getState().addGuidedNotesCol([...BBOX_A]) },
  { name: "resetNotesParse", invoke: () => useViewerStore.getState().resetNotesParse() },
  { name: "setNotesFastManualActive", invoke: () => useViewerStore.getState().setNotesFastManualActive(false) },
  { name: "setNotesFastManualGrid", invoke: () => useViewerStore.getState().setNotesFastManualGrid(null) },
  { name: "setParseDraftRegion", invoke: () => useViewerStore.getState().setParseDraftRegion(null) },
  { name: "setSpecParseRegion", invoke: () => useViewerStore.getState().setSpecParseRegion(null) },
  { name: "addGuidedSpecSectionBB", invoke: () => useViewerStore.getState().addGuidedSpecSectionBB([...BBOX_A]) },
  { name: "resetSpecParse", invoke: () => useViewerStore.getState().resetSpecParse() },
  { name: "setParagraphOverlayActive", invoke: () => useViewerStore.getState().setParagraphOverlayActive(false) },
  { name: "setParagraphBatch", invoke: () => { const state = useViewerStore.getState(); state.setParagraphBatch(state.paragraphBatch); } },
  { name: "upsertPendingParagraph", invoke: () => useViewerStore.getState().upsertPendingParagraph(PARAGRAPH) },
  { name: "removePendingParagraph", invoke: () => useViewerStore.getState().removePendingParagraph("absent") },
  { name: "setParagraphClipboard", invoke: () => useViewerStore.getState().setParagraphClipboard(null) },
  { name: "setGuidedParseActive", invoke: () => useViewerStore.getState().setGuidedParseActive(false) },
  { name: "setGuidedParseRegion", invoke: () => useViewerStore.getState().setGuidedParseRegion(null) },
  { name: "setGuidedParseRows", invoke: () => { const state = useViewerStore.getState(); state.setGuidedParseRows(state.guidedParseRows); } },
  { name: "setGuidedParseCols", invoke: () => { const state = useViewerStore.getState(); state.setGuidedParseCols(state.guidedParseCols); } },
  { name: "resetGuidedParse", invoke: () => useViewerStore.getState().resetGuidedParse() },
];

const SIMPLE_DESTINATION_CASES: readonly {
  name: ParseActionKey;
  key: ParseDataKey;
  invoke: () => void;
  expected: unknown;
  identity?: unknown;
}[] = [
  { name: "setTableParseRegion", key: "tableParseRegion", invoke: () => useViewerStore.getState().setTableParseRegion([...BBOX_A]), expected: BBOX_A },
  { name: "setTableParsedGrid", key: "tableParsedGrid", invoke: () => useViewerStore.getState().setTableParsedGrid(GRID), expected: GRID, identity: GRID },
  { name: "setTableParseMeta", key: "tableParseMeta", invoke: () => useViewerStore.getState().setTableParseMeta(META), expected: META, identity: META },
  { name: "setShowTableCellStructure", key: "showTableCellStructure", invoke: () => useViewerStore.getState().setShowTableCellStructure(true), expected: true },
  { name: "setTableParseColumnNames", key: "tableParseColumnNames", invoke: () => { const value = ["TAG"]; useViewerStore.getState().setTableParseColumnNames(value); }, expected: ["TAG"] },
  { name: "setTableParseRowBBs", key: "tableParseRowBBs", invoke: () => { const value: [number, number, number, number][] = [[...BBOX_A]]; useViewerStore.getState().setTableParseRowBBs(value); }, expected: [BBOX_A] },
  { name: "setTableParseTab", key: "tableParseTab", invoke: () => useViewerStore.getState().setTableParseTab("compare"), expected: "compare" },
  { name: "setTableParseOptions", key: "tableParseOptions", invoke: () => useViewerStore.getState().setTableParseOptions({ rowTolerance: 0.02 }), expected: { ...useViewerStore.getInitialState().tableParseOptions, rowTolerance: 0.02 } },
  { name: "setKeynoteParseTab", key: "keynoteParseTab", invoke: () => useViewerStore.getState().setKeynoteParseTab("compare"), expected: "compare" },
  { name: "setKeynoteParseRegion", key: "keynoteParseRegion", invoke: () => useViewerStore.getState().setKeynoteParseRegion([...BBOX_B]), expected: BBOX_B },
  { name: "setKeynoteYoloClass", key: "keynoteYoloClass", invoke: () => { const value = { model: "fixture", className: "door_single" }; useViewerStore.getState().setKeynoteYoloClass(value); }, expected: { model: "fixture", className: "door_single" } },
  { name: "setParsedKeynoteData", key: "parsedKeynoteData", invoke: () => { const value = [KEYNOTE_ENTRY]; useViewerStore.getState().setParsedKeynoteData(value); }, expected: [KEYNOTE_ENTRY] },
  { name: "setNotesParseRegion", key: "notesParseRegion", invoke: () => useViewerStore.getState().setNotesParseRegion([...BBOX_A]), expected: BBOX_A },
  { name: "setNotesFastManualActive", key: "notesFastManualActive", invoke: () => useViewerStore.getState().setNotesFastManualActive(true), expected: true },
  { name: "setNotesFastManualGrid", key: "notesFastManualGrid", invoke: () => { const value = nonDefaultParsePatch().notesFastManualGrid; useViewerStore.getState().setNotesFastManualGrid(value); }, expected: nonDefaultParsePatch().notesFastManualGrid },
  { name: "setParseDraftRegion", key: "parseDraftRegion", invoke: () => useViewerStore.getState().setParseDraftRegion(DRAFT), expected: DRAFT, identity: DRAFT },
  { name: "setSpecParseRegion", key: "specParseRegion", invoke: () => useViewerStore.getState().setSpecParseRegion([...BBOX_B]), expected: BBOX_B },
  { name: "setParagraphOverlayActive", key: "paragraphOverlayActive", invoke: () => useViewerStore.getState().setParagraphOverlayActive(true), expected: true },
  { name: "setParagraphBatch", key: "paragraphBatch", invoke: () => { const value = [PARAGRAPH]; useViewerStore.getState().setParagraphBatch(value); }, expected: [PARAGRAPH] },
  { name: "setParagraphClipboard", key: "paragraphClipboard", invoke: () => useViewerStore.getState().setParagraphClipboard(CLIPBOARD), expected: CLIPBOARD, identity: CLIPBOARD },
  { name: "setGuidedParseActive", key: "guidedParseActive", invoke: () => useViewerStore.getState().setGuidedParseActive(true), expected: true },
  { name: "setGuidedParseRegion", key: "guidedParseRegion", invoke: () => useViewerStore.getState().setGuidedParseRegion([...BBOX_A]), expected: BBOX_A },
  { name: "setGuidedParseRows", key: "guidedParseRows", invoke: () => { const value = [0.25, 0.75]; useViewerStore.getState().setGuidedParseRows(value); }, expected: [0.25, 0.75] },
  { name: "setGuidedParseCols", key: "guidedParseCols", invoke: () => { const value = [0.2, 0.8]; useViewerStore.getState().setGuidedParseCols(value); }, expected: [0.2, 0.8] },
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

describe("P2.4 shared legacy leaf publications", () => {
  it("covers every action once and in the independent ledger order", () => {
    expect(PUBLICATION_CASES.map(({ name }) => name)).toEqual(PARSE_ACTION_KEYS);
    expect([
      ...SIMPLE_DESTINATION_CASES.map(({ name }) => name),
      ...SPECIAL_ACTION_KEYS,
    ].sort()).toEqual([...PARSE_ACTION_KEYS].sort());
  });

  it.each(PUBLICATION_CASES)("$name publishes exactly once, including semantic no-ops", ({ invoke }) => {
    const before = useViewerStore.getState();
    const actionsBefore = pickParseActions(before);
    const listener = vi.fn();
    const unsubscribe = useViewerStore.subscribe(listener);
    invoke();
    const after = useViewerStore.getState();
    expect(listener).toHaveBeenCalledTimes(1);
    expectParseActionsStable(actionsBefore, after);
    expectResidualViewerStable(before, after);
    unsubscribe();
  });
});

describe("P2.4 shared simple action destinations", () => {
  it.each(SIMPLE_DESTINATION_CASES)("$name changes exactly $key to its requested destination", ({ key, invoke, expected }) => {
    const before = useViewerStore.getState();
    invoke();
    const after = useViewerStore.getState();
    expect(changedParseKeys(before, after)).toEqual([key]);
    expect(after[key]).toEqual(expected);
    expectResidualViewerStable(before, after);
  });
});

describe("P2.4 shared compound actions and identity", () => {
  it("setTableCellStructure retains the caller object and derives visibility in one publication", () => {
    const listener = vi.fn();
    const unsubscribe = useViewerStore.subscribe(listener);
    const beforeSet = useViewerStore.getState();
    useViewerStore.getState().setTableCellStructure(CELL_STRUCTURE);
    const afterSet = useViewerStore.getState();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(changedParseKeys(beforeSet, afterSet)).toEqual([
      "showTableCellStructure",
      "tableCellStructure",
    ]);
    expect(afterSet.tableCellStructure).toBe(CELL_STRUCTURE);
    expect(afterSet.showTableCellStructure).toBe(true);
    expectResidualViewerStable(beforeSet, afterSet);

    const beforeClear = useViewerStore.getState();
    useViewerStore.getState().setTableCellStructure(null);
    const afterClear = useViewerStore.getState();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(changedParseKeys(beforeClear, afterClear)).toEqual([
      "showTableCellStructure",
      "tableCellStructure",
    ]);
    expect(afterClear.tableCellStructure).toBeNull();
    expect(afterClear.showTableCellStructure).toBe(false);
    expectResidualViewerStable(beforeClear, afterClear);
    unsubscribe();
  });

  it("toggleCellHighlight publishes an empty patch without structure, then clones only the hit path", () => {
    const listener = vi.fn();
    const unsubscribe = useViewerStore.subscribe(listener);
    const beforeEmpty = useViewerStore.getState();
    beforeEmpty.toggleCellHighlight(0, 0);
    const afterEmpty = useViewerStore.getState();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(changedParseKeys(beforeEmpty, afterEmpty)).toEqual([]);
    expectResidualViewerStable(beforeEmpty, afterEmpty);

    useViewerStore.setState({ tableCellStructure: CELL_STRUCTURE });
    const beforeState = useViewerStore.getState();
    const before = beforeState.tableCellStructure!;
    useViewerStore.getState().toggleCellHighlight(0, 0);
    const afterState = useViewerStore.getState();
    const after = afterState.tableCellStructure!;
    expect(listener).toHaveBeenCalledTimes(3);
    expect(changedParseKeys(beforeState, afterState)).toEqual(["tableCellStructure"]);
    expect(after).not.toBe(before);
    expect(after.cells).not.toBe(before.cells);
    expect(after.cells[0]).not.toBe(before.cells[0]);
    expect(after.cells[0].highlighted).toBe(true);
    expect(after.cells[1]).toBe(before.cells[1]);
    expectResidualViewerStable(beforeState, afterState);
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

    const state = useViewerStore.getState();
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

    const after = useViewerStore.getState();
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
      useViewerStore.setState({ [dataKey]: [first] } as Partial<ParseState>);
      const beforeState = useViewerStore.getState();
      const before = beforeState[dataKey];
      const listener = vi.fn();
      const unsubscribe = useViewerStore.subscribe(listener);
      (useViewerStore.getState()[actionKey] as (bbox: [number, number, number, number]) => void)(second);
      const afterState = useViewerStore.getState();
      const after = afterState[dataKey];
      expect(listener, actionKey).toHaveBeenCalledTimes(1);
      expect(changedParseKeys(beforeState, afterState)).toEqual([dataKey]);
      expect(after).not.toBe(before);
      expect(after[0]).toBe(first);
      expect(after[1]).toBe(second);
      expectResidualViewerStable(beforeState, afterState);
      unsubscribe();
    }

    restoreOwner();
    useViewerStore.setState({ parsedKeynoteData: [KEYNOTE_ENTRY] });
    const beforeState = useViewerStore.getState();
    const before = beforeState.parsedKeynoteData!;
    const existingListener = vi.fn();
    const unsubscribeExisting = useViewerStore.subscribe(existingListener);
    const secondEntry = { ...KEYNOTE_ENTRY, pageNumber: 5 };
    useViewerStore.getState().addParsedKeynote(secondEntry);
    const afterState = useViewerStore.getState();
    const after = afterState.parsedKeynoteData!;
    expect(existingListener).toHaveBeenCalledTimes(1);
    expect(changedParseKeys(beforeState, afterState)).toEqual(["parsedKeynoteData"]);
    expect(after).not.toBe(before);
    expect(after[0]).toBe(KEYNOTE_ENTRY);
    expect(after[1]).toBe(secondEntry);
    expectResidualViewerStable(beforeState, afterState);
    unsubscribeExisting();

    restoreOwner();
    const emptyBefore = useViewerStore.getState();
    const emptyListener = vi.fn();
    const unsubscribeEmpty = useViewerStore.subscribe(emptyListener);
    useViewerStore.getState().addParsedKeynote(KEYNOTE_ENTRY);
    expect(emptyListener).toHaveBeenCalledTimes(1);
    expect(changedParseKeys(emptyBefore, useViewerStore.getState())).toEqual([
      "parsedKeynoteData",
    ]);
    expect(useViewerStore.getState().parsedKeynoteData).toEqual([KEYNOTE_ENTRY]);
    expectResidualViewerStable(emptyBefore, useViewerStore.getState());
    unsubscribeEmpty();
  });

  it("options always shallow-clone while preserving untouched nested-free values", () => {
    const listener = vi.fn();
    const unsubscribe = useViewerStore.subscribe(listener);
    const beforeState = useViewerStore.getState();
    const before = beforeState.tableParseOptions;
    useViewerStore.getState().setTableParseOptions({});
    const afterEmptyState = useViewerStore.getState();
    const afterEmpty = afterEmptyState.tableParseOptions;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(changedParseKeys(beforeState, afterEmptyState)).toEqual(["tableParseOptions"]);
    expect(afterEmpty).not.toBe(before);
    expect(afterEmpty).toEqual(before);
    expectResidualViewerStable(beforeState, afterEmptyState);
    useViewerStore.getState().setTableParseOptions({ rowTolerance: 0.04 });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(changedParseKeys(afterEmptyState, useViewerStore.getState())).toEqual([
      "tableParseOptions",
    ]);
    expect(useViewerStore.getState().tableParseOptions).toEqual({
      ...afterEmpty,
      rowTolerance: 0.04,
    });
    expectResidualViewerStable(afterEmptyState, useViewerStore.getState());
    unsubscribe();
  });

  it("paragraph upsert/replace/remove always allocate and preserve index semantics", () => {
    const second = { ...PARAGRAPH, id: "paragraph-2" };
    useViewerStore.setState({ paragraphBatch: [PARAGRAPH] });
    const listener = vi.fn();
    const unsubscribe = useViewerStore.subscribe(listener);
    const beforeAppendState = useViewerStore.getState();
    const beforeAppend = beforeAppendState.paragraphBatch;
    useViewerStore.getState().upsertPendingParagraph(second);
    const afterAppendState = useViewerStore.getState();
    const afterAppend = afterAppendState.paragraphBatch;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(changedParseKeys(beforeAppendState, afterAppendState)).toEqual(["paragraphBatch"]);
    expect(afterAppend).not.toBe(beforeAppend);
    expect(afterAppend[0]).toBe(PARAGRAPH);
    expect(afterAppend[1]).toBe(second);
    expectResidualViewerStable(beforeAppendState, afterAppendState);

    const replacement = { ...PARAGRAPH, rowText: { Note: "replacement" } };
    useViewerStore.getState().upsertPendingParagraph(replacement);
    const afterReplaceState = useViewerStore.getState();
    const afterReplace = afterReplaceState.paragraphBatch;
    expect(listener).toHaveBeenCalledTimes(2);
    expect(changedParseKeys(afterAppendState, afterReplaceState)).toEqual(["paragraphBatch"]);
    expect(afterReplace).not.toBe(afterAppend);
    expect(afterReplace[0]).toBe(replacement);
    expect(afterReplace[1]).toBe(second);
    expectResidualViewerStable(afterAppendState, afterReplaceState);

    useViewerStore.getState().removePendingParagraph("absent");
    const afterAbsentState = useViewerStore.getState();
    const afterAbsentRemove = afterAbsentState.paragraphBatch;
    expect(listener).toHaveBeenCalledTimes(3);
    expect(changedParseKeys(afterReplaceState, afterAbsentState)).toEqual(["paragraphBatch"]);
    expect(afterAbsentRemove).not.toBe(afterReplace);
    expect(afterAbsentRemove).toEqual(afterReplace);
    expect(afterAbsentRemove[0]).toBe(replacement);
    expect(afterAbsentRemove[1]).toBe(second);
    expectResidualViewerStable(afterReplaceState, afterAbsentState);

    useViewerStore.getState().removePendingParagraph("paragraph-2");
    const afterPresentState = useViewerStore.getState();
    const afterPresentRemove = afterPresentState.paragraphBatch;
    expect(listener).toHaveBeenCalledTimes(4);
    expect(changedParseKeys(afterAbsentState, afterPresentState)).toEqual(["paragraphBatch"]);
    expect(afterPresentRemove).not.toBe(afterAbsentRemove);
    expect(afterPresentRemove).toEqual([replacement]);
    expect(afterPresentRemove[0]).toBe(replacement);
    expectResidualViewerStable(afterAbsentState, afterPresentState);
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
    useViewerStore.setState(nonDefaultParsePatch());
    const before = useViewerStore.getState();
    const actionsBefore = pickParseActions(before);
    const initial = useViewerStore.getInitialState();
    const listener = vi.fn();
    const unsubscribe = useViewerStore.subscribe(listener);

    (before[action] as () => void)();
    const after = useViewerStore.getState();

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
    expectResidualViewerStable(before, after);
    unsubscribe();

    // Resetting an already-default flow still publishes and allocates each reset container. This
    // catches implementations that reuse construction arrays or suppress semantic no-ops.
    restoreOwner();
    const defaultBefore = useViewerStore.getState();
    const defaultActions = pickParseActions(defaultBefore);
    const defaultListener = vi.fn();
    const unsubscribeDefault = useViewerStore.subscribe(defaultListener);
    (defaultBefore[action] as () => void)();
    const defaultAfter = useViewerStore.getState();
    const arrayKeys = touched.filter((key) => Array.isArray(defaultBefore[key]));
    expect(defaultListener).toHaveBeenCalledTimes(1);
    expect(changedParseKeys(defaultBefore, defaultAfter)).toEqual(sorted(arrayKeys));
    expect(new Set(arrayKeys.map((key) => defaultAfter[key])).size).toBe(arrayKeys.length);
    for (const key of arrayKeys) expect(defaultAfter[key]).not.toBe(defaultBefore[key]);
    expectParseActionsStable(defaultActions, defaultAfter);
    expectResidualViewerStable(defaultBefore, defaultAfter);
    unsubscribeDefault();
  });

  it("resetAllTools changes exactly 27 parse fields, retains eight references, and publishes five parse resets", () => {
    useViewerStore.setState(nonDefaultParsePatch());
    const before = useViewerStore.getState();
    const actionsBefore = pickParseActions(before);
    const initial = useViewerStore.getInitialState();
    const publications: Array<Pick<ParseState, ParseDataKey>> = [];
    const unsubscribe = useViewerStore.subscribe((state) => publications.push(pickParseData(state)));

    resetAllParseForIsolatedOwner();
    const after = useViewerStore.getState();

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
    expectParseActionsStable(actionsBefore, after);
    expectResidualViewerStable(before, after);
    unsubscribe();
  });

  it("project reset changes exactly 32 parse fields and retains the three current-policy references", () => {
    useViewerStore.setState(nonDefaultParsePatch());
    const before = useViewerStore.getState();
    const actionsBefore = pickParseActions(before);
    const initial = useViewerStore.getInitialState();
    const listener = vi.fn();
    const unsubscribe = useViewerStore.subscribe(listener);

    resetProjectParseForIsolatedOwner();
    const after = useViewerStore.getState();

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
    expectParseActionsStable(actionsBefore, after);
    unsubscribe();
  });
});

  });
}

defineParseOwnerContract({
  label: "live viewer parse owner",
  store: useLegacyViewerStore as unknown as typeof useParseFlowStore,
  exactLeaf: false,
  resetAll: resetAllTools,
  resetProject: resetProjectData,
});

defineParseOwnerContract({
  label: "production-dead parseFlowStore candidate",
  store: useParseFlowStore,
  exactLeaf: true,
  resetAll: () => {
    const owner = useParseFlowStore.getState();
    owner.resetTableParse();
    owner.resetKeynoteParse();
    owner.resetNotesParse();
    owner.resetSpecParse();
    owner.resetGuidedParse();
  },
  resetProject: () => useParseFlowStore.getState().resetProjectParseState(),
});
