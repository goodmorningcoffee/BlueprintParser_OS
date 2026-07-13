// @vitest-environment node
// [refactor jul12 P2.4 A2e] Page authority without widening legacy Parse reset semantics.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  PARSE_KINDS,
  type ParseKind,
  type ParseOperationToken,
} from "@/lib/parse-operation-state";
import { useParseFlowStore, type ParseFlowState } from "@/stores/parseFlowStore";
import { useToolStore } from "@/stores/toolStore";
import { useUiStore } from "@/stores/uiStore";
import {
  navigateViewerPage,
  navigateViewerPageUnclamped,
  openNotesParseTarget,
  openSpecParseTarget,
  openTableReviewTarget,
  openTableReviewWorkspace,
  type TableReviewPublication,
} from "@/stores/viewerCommands";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";

type ParseRegion = [number, number, number, number];
type SeededWorkspace = Readonly<{
  before: ParseFlowState;
  tokens: Readonly<Record<ParseKind, ParseOperationToken>>;
}>;

const PAGE_A = 2;
const PAGE_B = 7;
const REGION_A: ParseRegion = [0.1, 0.2, 0.7, 0.8];
const REGION_B: ParseRegion = [0.2, 0.3, 0.8, 0.9];

function restoreStores(): void {
  useParseFlowStore.setState(useParseFlowStore.getInitialState(), true);
  useToolStore.setState(useToolStore.getInitialState(), true);
  useUiStore.setState(useUiStore.getInitialState(), true);
  useViewerCoreStore.setState(useViewerCoreStore.getInitialState(), true);
  useViewerCoreStore.setState({ pageNumber: PAGE_A, numPages: 12 });
}

function startOperation<K extends ParseKind>(kind: K): ParseOperationToken<K> {
  const started = useParseFlowStore.getState().beginParseOperation(kind);
  expect(started.status).toBe("started");
  if (started.status !== "started") throw new Error(`Could not start ${kind}`);
  return started.token;
}

function seedWorkspace(): SeededWorkspace {
  const initial = useParseFlowStore.getState();
  useToolStore.setState({ mode: "markup" });
  useUiStore.setState({ showTableCompareModal: true });
  useParseFlowStore.setState({
    tableParseStep: "review",
    tableParseRegion: REGION_A,
    tableParsedGrid: { headers: ["Tag"], rows: [{ Tag: "A" }], tableName: "A" },
    tableParseMeta: {
      methodResults: [],
      baseMethod: "fixture",
      mergedSnapshot: { headers: ["Tag"], rows: [{ Tag: "A" }] },
    },
    tableCellStructure: { cells: [], pageNumber: PAGE_A, regionBbox: REGION_A },
    tableParseColumnBBs: [REGION_A],
    tableParseColumnNames: ["Tag"],
    tableParseRowBBs: [REGION_B],
    keynoteParseStep: "review",
    keynoteParseRegion: REGION_A,
    keynoteColumnBBs: [REGION_A],
    keynoteRowBBs: [REGION_B],
    keynoteYoloClass: { model: "fixture", className: "keynote" },
    notesParseStep: "review",
    notesParseRegion: REGION_A,
    guidedNotesRows: [REGION_A],
    guidedNotesCols: [REGION_B],
    notesFastManualActive: true,
    notesFastManualGrid: { headers: ["Key"], rows: [{ Key: "N1" }] },
    specParseStep: "review",
    specParseRegion: REGION_B,
    guidedSpecSectionBBs: [REGION_B],
    parseDraftRegion: {
      id: "draft-A",
      type: "notes",
      category: "notes",
      bbox: REGION_A,
      confidence: 0.8,
      source: "user",
      data: { headers: ["Key"], rows: [{ Key: "N1" }] },
    },
    paragraphOverlayActive: true,
    paragraphBatch: [{ id: "p-A", bbox: REGION_A, lines: [], rowText: { Key: "N1" } }],
    guidedParseOwner: "notes",
    guidedParseActive: true,
    guidedParseRegion: REGION_A,
    guidedParseRows: [0.2, 0.5, 0.8],
    guidedParseCols: [0.1, 0.4, 0.7],
  });
  const tokens = Object.fromEntries(PARSE_KINDS.map((kind) => [kind, startOperation(kind)])) as
    Record<ParseKind, ParseOperationToken>;
  return { before: useParseFlowStore.getState(), tokens };
}

function expectGenericLegacyExit(after: ParseFlowState, seeded: SeededWorkspace): void {
  expect(after).toMatchObject({
    tableParseStep: "idle",
    tableParseRegion: null,
    tableParsedGrid: null,
    tableParseMeta: null,
    tableCellStructure: null,
    tableParseColumnBBs: [],
    tableParseColumnNames: [],
    tableParseRowBBs: [],
    keynoteParseStep: "idle",
    keynoteParseRegion: null,
    keynoteColumnBBs: [],
    keynoteRowBBs: [],
    keynoteYoloClass: null,
  });
  for (const field of [
    "notesParseStep",
    "notesParseRegion",
    "guidedNotesRows",
    "guidedNotesCols",
    "notesFastManualActive",
    "notesFastManualGrid",
    "specParseStep",
    "specParseRegion",
    "guidedSpecSectionBBs",
    "parseDraftRegion",
    "paragraphOverlayActive",
    "paragraphBatch",
    "guidedParseOwner",
    "guidedParseActive",
    "guidedParseRegion",
    "guidedParseRows",
    "guidedParseCols",
  ] as const) expect(after[field], field).toBe(seeded.before[field]);
  expect(after.parseOperations.table).toEqual({
    revision: seeded.tokens.table.revision + 2,
    busy: false,
  });
  expect(after.parseOperations.keynote).toEqual({
    revision: seeded.tokens.keynote.revision + 2,
    busy: false,
  });
  for (const kind of ["notes", "spec"] as const) {
    expect(after.parseOperations[kind]).toEqual({
      revision: seeded.tokens[kind].revision + 1,
      busy: false,
    });
  }
}

function review(label: string): TableReviewPublication {
  return {
    grid: { headers: ["Tag"], rows: [{ Tag: label }], tableName: label },
    meta: null,
    region: REGION_B,
  };
}

beforeEach(restoreStores);

describe("A2e generic page authority", () => {
  it("preserves legacy data policy and publishes tool -> conditional Parse -> core -> authority", () => {
    const seeded = seedWorkspace();
    const trace: string[] = [];
    const pagesSeenByParse: number[] = [];
    const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
    const unsubscribeParse = useParseFlowStore.subscribe(() => {
      trace.push("parse");
      pagesSeenByParse.push(useViewerCoreStore.getState().pageNumber);
    });
    const unsubscribeCore = useViewerCoreStore.subscribe(() => trace.push("core"));

    navigateViewerPage(PAGE_B);

    unsubscribeCore();
    unsubscribeParse();
    unsubscribeTool();
    expect(trace).toEqual(["tool", "parse", "core", "parse"]);
    expect(pagesSeenByParse).toEqual([PAGE_A, PAGE_B]);
    expect(useViewerCoreStore.getState().pageNumber).toBe(PAGE_B);
    expect(useToolStore.getState().mode).toBe("move");
    expect(useUiStore.getState().showTableCompareModal).toBe(true);
    expectGenericLegacyExit(useParseFlowStore.getState(), seeded);
  });

  it("keeps YOLO browse unclamped behind the same terminal authority publication", () => {
    const seeded = seedWorkspace();
    navigateViewerPageUnclamped(99);
    expect(useViewerCoreStore.getState().pageNumber).toBe(99);
    expectGenericLegacyExit(useParseFlowStore.getState(), seeded);
  });

  it.each([navigateViewerPage, navigateViewerPageUnclamped])(
    "is a no-op for an unchanged destination",
    (command) => {
      const parseBefore = useParseFlowStore.getState();
      const coreBefore = useViewerCoreStore.getState();
      command(PAGE_A);
      expect(useParseFlowStore.getState()).toBe(parseBefore);
      expect(useViewerCoreStore.getState()).toBe(coreBefore);
    },
  );

  it.each(["table", "keynote"] as const)(
    "kills an old-page %s B admitted by the conditional pre-core reset",
    (kind) => {
      seedWorkspace();
      let armed = true;
      let tokenB: ParseOperationToken<typeof kind> | null = null;
      let pageCapturedByB: number | null = null;
      const unsubscribe = useParseFlowStore.subscribe(() => {
        if (!armed || useViewerCoreStore.getState().pageNumber !== PAGE_A) return;
        armed = false;
        tokenB = startOperation(kind);
        pageCapturedByB = useViewerCoreStore.getState().pageNumber;
      });
      navigateViewerPage(PAGE_B);
      unsubscribe();
      expect(pageCapturedByB).toBe(PAGE_A);
      expect(tokenB).not.toBeNull();
      expect(useParseFlowStore.getState().isParseOperationCurrent(tokenB!)).toBe(false);
      expect(useParseFlowStore.getState().parseOperations[kind].revision)
        .toBe(tokenB!.revision + 1);
    },
  );

  it.each(PARSE_KINDS.flatMap((kind) => ([
    [kind, "busy"],
    [kind, "settled"],
  ] as const)))(
    "lets terminal-authority subscriber %s C capture the new page and remain %s",
    (kind, status) => {
      seedWorkspace();
      let parsePublications = 0;
      let tokenC: ParseOperationToken<typeof kind> | null = null;
      let pageCapturedByC: number | null = null;
      const unsubscribe = useParseFlowStore.subscribe(() => {
        parsePublications += 1;
        if (parsePublications !== 2) return;
        tokenC = startOperation(kind);
        pageCapturedByC = useViewerCoreStore.getState().pageNumber;
        if (status === "settled") {
          expect(useParseFlowStore.getState().finishParseOperation(tokenC)).toBe(true);
        }
      });
      navigateViewerPage(PAGE_B);
      unsubscribe();
      expect(pageCapturedByC).toBe(PAGE_B);
      expect(tokenC).not.toBeNull();
      expect(useParseFlowStore.getState().parseOperations[kind]).toEqual({
        revision: tokenC!.revision,
        busy: status === "busy",
      });
    },
  );
});

describe("A2e retained Table review targets", () => {
  it("publishes destination core -> tool -> one Table review seed", () => {
    seedWorkspace();
    const publication = review("page-B");
    const trace: string[] = [];
    const pagesSeenByParse: number[] = [];
    const unsubscribeCore = useViewerCoreStore.subscribe(() => trace.push("core"));
    const unsubscribeTool = useToolStore.subscribe(() => trace.push("tool"));
    const unsubscribeParse = useParseFlowStore.subscribe(() => {
      trace.push("parse");
      pagesSeenByParse.push(useViewerCoreStore.getState().pageNumber);
    });
    openTableReviewTarget(PAGE_B, publication);
    unsubscribeParse();
    unsubscribeTool();
    unsubscribeCore();
    expect(trace).toEqual(["tool", "parse", "core", "parse"]);
    expect(pagesSeenByParse).toEqual([PAGE_A, PAGE_B]);
    expect(useParseFlowStore.getState()).toMatchObject({
      tableParseStep: "review",
      tableParsedGrid: publication.grid,
      tableParseMeta: publication.meta,
      tableParseRegion: publication.region,
    });
  });

  it("kills a core-subscriber Table B before the review seed and admits page-B C afterward", () => {
    seedWorkspace();
    const publication = review("B");
    let coreAdmissionStatus: "started" | "busy" | null = null;
    let coreToken: ParseOperationToken<"table"> | null = null;
    let tokenC: ParseOperationToken<"table"> | null = null;
    let armed = true;
    const unsubscribeCore = useViewerCoreStore.subscribe(() => {
      const admission = useParseFlowStore.getState().beginParseOperation("table");
      coreAdmissionStatus = admission.status;
      if (admission.status === "started") coreToken = admission.token;
    });
    const unsubscribeParse = useParseFlowStore.subscribe(() => {
      if (
        !armed || useViewerCoreStore.getState().pageNumber !== PAGE_B ||
        useParseFlowStore.getState().tableParsedGrid !== publication.grid
      ) return;
      armed = false;
      tokenC = startOperation("table");
    });
    openTableReviewTarget(PAGE_B, publication);
    unsubscribeParse();
    unsubscribeCore();
    expect(coreAdmissionStatus).toBe("started");
    expect(coreToken).not.toBeNull();
    expect(useParseFlowStore.getState().isParseOperationCurrent(coreToken!)).toBe(false);
    expect(tokenC).not.toBeNull();
    expect(useParseFlowStore.getState().isParseOperationCurrent(tokenC!)).toBe(true);
    expect(useViewerCoreStore.getState().pageNumber).toBe(PAGE_B);
  });

  it("uses the current-page workspace command without a core publication", () => {
    const publication = review("same-page");
    let corePublications = 0;
    const unsubscribe = useViewerCoreStore.subscribe(() => { corePublications += 1; });
    openTableReviewTarget(PAGE_A, publication, "keynote");
    unsubscribe();
    expect(corePublications).toBe(0);
    expect(useParseFlowStore.getState().tableParsedGrid).toBe(publication.grid);
  });

  it("keeps direct current-page review seeding available", () => {
    const publication = review("direct");
    openTableReviewWorkspace(publication);
    expect(useParseFlowStore.getState().tableParsedGrid).toBe(publication.grid);
  });
});

describe("A2e indexed Notes/Spec targets", () => {
  const cases = [
    { kind: "notes", command: openNotesParseTarget },
    { kind: "spec", command: openSpecParseTarget },
  ] as const;

  it.each(cases)("$kind publishes core before its one target seed", ({ kind, command }) => {
    seedWorkspace();
    const trace: string[] = [];
    const pagesSeenByParse: number[] = [];
    const unsubscribeCore = useViewerCoreStore.subscribe(() => trace.push("core"));
    const unsubscribeParse = useParseFlowStore.subscribe(() => {
      trace.push("parse");
      pagesSeenByParse.push(useViewerCoreStore.getState().pageNumber);
    });
    command(PAGE_B, REGION_B);
    unsubscribeParse();
    unsubscribeCore();
    expect(trace).toEqual(["parse", "core", "parse"]);
    expect(pagesSeenByParse).toEqual([PAGE_A, PAGE_B]);
    expect(useParseFlowStore.getState()[kind === "notes" ? "notesParseRegion" : "specParseRegion"])
      .toBe(REGION_B);
  });

  it.each(cases)("$kind kills the old core-subscriber owner and admits target subscriber C", ({
    kind,
    command,
  }) => {
    seedWorkspace();
    let coreAdmission: ReturnType<ParseFlowState["beginParseOperation"]> | null = null;
    let tokenC: ParseOperationToken<typeof kind> | null = null;
    let armed = true;
    const unsubscribeCore = useViewerCoreStore.subscribe(() => {
      coreAdmission = useParseFlowStore.getState().beginParseOperation(kind);
    });
    const unsubscribeParse = useParseFlowStore.subscribe(() => {
      if (
        !armed || useViewerCoreStore.getState().pageNumber !== PAGE_B ||
        useParseFlowStore.getState()[kind === "notes" ? "notesParseRegion" : "specParseRegion"] !== REGION_B
      ) return;
      armed = false;
      tokenC = startOperation(kind);
    });
    command(PAGE_B, REGION_B);
    unsubscribeParse();
    unsubscribeCore();
    expect(coreAdmission).toEqual({ status: "busy" });
    expect(tokenC).not.toBeNull();
    expect(useParseFlowStore.getState().isParseOperationCurrent(tokenC!)).toBe(true);
    expect(useViewerCoreStore.getState().pageNumber).toBe(PAGE_B);
  });

  it.each(cases)("$kind same-page handoff seeds without a core publication", ({ kind, command }) => {
    let corePublications = 0;
    const unsubscribe = useViewerCoreStore.subscribe(() => { corePublications += 1; });
    command(PAGE_A, REGION_B);
    unsubscribe();
    expect(corePublications).toBe(0);
    expect(useParseFlowStore.getState()[kind === "notes" ? "notesParseRegion" : "specParseRegion"])
      .toBe(REGION_B);
  });
});

describe("A2e cross-page target commands revoke every page-bound owner", () => {
  const targetReview = review("target");
  const targets = [
    {
      label: "Table review",
      invoke: () => openTableReviewTarget(PAGE_B, targetReview),
      isTerminal: (state: ParseFlowState) => state.tableParsedGrid === targetReview.grid,
    },
    {
      label: "Notes",
      invoke: () => openNotesParseTarget(PAGE_B, REGION_B),
      isTerminal: (state: ParseFlowState) => state.notesParseRegion === REGION_B,
    },
    {
      label: "Spec",
      invoke: () => openSpecParseTarget(PAGE_B, REGION_B),
      isTerminal: (state: ParseFlowState) =>
        state.specParseRegion === REGION_B && state.specParseStep === "idle",
    },
  ] as const;

  it.each(targets.flatMap((target) => PARSE_KINDS.flatMap((kind) => ([
    { ...target, kind, status: "busy" as const },
    { ...target, kind, status: "settled" as const },
  ]))))("$label target revokes old/core $kind and preserves new-page C ($status)", ({
    invoke,
    isTerminal,
    kind,
    status,
  }) => {
    seedWorkspace();
    let coreAdmissionStatus: "started" | "busy" | null = null;
    let coreToken: ParseOperationToken | null = null;
    let tokenC: ParseOperationToken<typeof kind> | null = null;
    let pageCapturedByC: number | null = null;
    let armed = true;
    const unsubscribeCore = useViewerCoreStore.subscribe(() => {
      const admission = useParseFlowStore.getState().beginParseOperation(kind);
      coreAdmissionStatus = admission.status;
      if (admission.status === "started") coreToken = admission.token;
    });
    const unsubscribeParse = useParseFlowStore.subscribe((state) => {
      if (!armed || useViewerCoreStore.getState().pageNumber !== PAGE_B || !isTerminal(state)) return;
      armed = false;
      tokenC = startOperation(kind);
      pageCapturedByC = useViewerCoreStore.getState().pageNumber;
      if (status === "settled") {
        expect(useParseFlowStore.getState().finishParseOperation(tokenC)).toBe(true);
      }
    });

    try {
      invoke();
    } finally {
      unsubscribeParse();
      unsubscribeCore();
    }
    expect(coreAdmissionStatus).toBe(kind === "table" || kind === "keynote" ? "started" : "busy");
    if (coreToken) {
      expect(useParseFlowStore.getState().isParseOperationCurrent(coreToken)).toBe(false);
    }
    expect(pageCapturedByC).toBe(PAGE_B);
    expect(tokenC).not.toBeNull();
    expect(useParseFlowStore.getState().parseOperations[kind]).toEqual({
      revision: tokenC!.revision,
      busy: status === "busy",
    });
  });
});

describe("A2e parser page effects remain authority-only", () => {
  it.each([
    ["src/components/viewer/AutoParseTab.tsx", "setAutoParsingRevision(null)"],
    ["src/components/viewer/GuidedParseTab.tsx", "setProposalRevision(null)"],
    ["src/components/viewer/KeynotePanel.tsx", "setAutoParsingRevision(null)"],
    ["src/components/viewer/ManualParseTab.tsx", "setSaveError(null)"],
    ["src/components/viewer/NotesParser.tsx", 'setMode("auto")'],
    ["src/components/viewer/SpecParser.tsx", 'setMode("auto")'],
    ["src/components/viewer/TableParsePanel.tsx", "setTagMappingDone(false)"],
  ] as const)("%s has no passive page-local reset tail", (path, setter) => {
    const source = readFileSync(join(process.cwd(), path), "utf8");
    const passivePattern = new RegExp(
      `useEffect\\(\\(\\) => \\{[\\s\\S]{0,500}${setter.replace(/[()]/g, "\\$&")}` +
      `[\\s\\S]{0,500}\\}, \\[pageNumber\\]\\)`,
    );
    expect(source).not.toMatch(passivePattern);
  });
});
