// @vitest-environment node
// [refactor jul11 P2.4 S2] Source-exact topology freeze for sole parse ownership.
//
// This suite is intentionally narrower than the fail-closed owner oracle. It pins the known
// grouped surfaces, canvas-adjacent subscriptions, cross-kind borrowers, neutral-command home,
// and mixed test-helper seam. S2 changes the active owner constants/import expectations; it must
// not broaden any projection or leave a viewerStore compatibility bridge behind.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useSessionStore } from "@/stores/sessionStore";
import { useParseFlowStore } from "@/stores/parseFlowStore";
import { useToolStore } from "@/stores/toolStore";
import { useUiStore } from "@/stores/uiStore";
import { useViewerCoreStore } from "@/stores/viewerCoreStore";
import { useViewerStore } from "@/stores/viewerStore";
import {
  acceptNotesParseRegion,
  completeSpecParseOperation,
  openNotesParseTarget,
  openSpecParseTarget,
  resetSpecParseWorkspace,
  setSpecsNotesParseTab,
} from "@/stores/viewerCommands";
import {
  PARSE_TEST_ACTION_KEYS,
  PARSE_TEST_STATE_KEYS,
  partitionViewerStoreTestState,
  setViewerStoreStateForTest,
} from "@/test/viewer-store-state";
import {
  formatStoreOwnerFinding,
  scanStoreOwnerSource,
  type StoreOwnerDescriptor,
  type StoreOwnerScanResult,
} from "@/test/store-owner-oracle";

const VIEWER_STORE_FILE = "src/stores/viewerStore.ts";
const PARSE_STORE_FILE = "src/stores/parseFlowStore.ts";
const VIEWER_COMMANDS_FILE = "src/stores/viewerCommands.ts";
const VIEWER_COMMANDS_MODULE = "@/stores/viewerCommands";
const ANNOTATION_OVERLAY = "src/components/viewer/AnnotationOverlay.tsx";
const DRAWING_PREVIEW = "src/components/viewer/DrawingPreviewLayer.tsx";
const PDF_PAGE = "src/components/viewer/PDFPage.tsx";
const PARSE_REGION_LAYER = "src/components/viewer/ParseRegionLayer.tsx";
const SHAPE_INTERACTION = "src/hooks/useShapeParseInteraction.ts";
const GUIDED_PARSE_TAB = "src/components/viewer/GuidedParseTab.tsx";
const KEYNOTE_PANEL = "src/components/viewer/KeynotePanel.tsx";
const NOTES_PARSER = "src/components/viewer/NotesParser.tsx";
const SPEC_PARSER = "src/components/viewer/SpecParser.tsx";
const PARAGRAPH_OVERLAY = "src/components/viewer/ParagraphOverlay.tsx";
const PARSED_TABLE_ITEM = "src/components/viewer/ParsedTableItem.tsx";
const TABLE_COMPARE_MODAL = "src/components/viewer/TableCompareModal.tsx";
const PARSE_FACADE_FILE = "src/hooks/useParseFlow.ts";
const PARSE_FACADE_MODULE = "@/hooks/useParseFlow";

const VIEWER_OWNER = {
  file: VIEWER_STORE_FILE,
  module: "@/stores/viewerStore",
  exportName: "useViewerStore",
  interfaceName: "ViewerState",
  storeName: "useViewerStore",
} as const;
const PARSE_OWNER = {
  file: PARSE_STORE_FILE,
  module: "@/stores/parseFlowStore",
  exportName: "useParseFlowStore",
  interfaceName: "ParseFlowState",
  storeName: "useParseFlowStore",
} as const;

type ParseOwnershipPhase = "F0" | "S1" | "S2";
type OwnerDefinitionExpectation = "module-absent" | "exact-ledger" | "ledger-absent";
type OwnershipPhaseConfig = {
  readonly active: typeof VIEWER_OWNER | typeof PARSE_OWNER;
  readonly inactive: typeof VIEWER_OWNER | typeof PARSE_OWNER;
  readonly inactiveDefinition: OwnerDefinitionExpectation;
  readonly inactiveAccessAllowlist: readonly string[];
};

// This is the only phase switch. S1 keeps viewer active and permits only the dual-owner parity
// suite plus this topology/runtime witness to touch the production-dead candidate. S2 flips the
// owners, removes the parity exception, and retains only this file's explicit residual-runtime
// absence witness; the gate fails until manifest, reader, and imports move together.
const PARSE_OWNERSHIP_PHASE: ParseOwnershipPhase = "S2";
const OWNERSHIP_PHASES = {
  F0: {
    active: VIEWER_OWNER,
    inactive: PARSE_OWNER,
    inactiveDefinition: "module-absent",
    inactiveAccessAllowlist: [],
  },
  S1: {
    active: VIEWER_OWNER,
    inactive: PARSE_OWNER,
    inactiveDefinition: "exact-ledger",
    inactiveAccessAllowlist: [
      "src/stores/__tests__/parseFlowStoreFreeze.test.ts",
      "src/stores/__tests__/parseFlowTopologyFreeze.test.ts",
    ],
  },
  S2: {
    active: PARSE_OWNER,
    inactive: VIEWER_OWNER,
    inactiveDefinition: "ledger-absent",
    // This suite intentionally retains the residual Viewer runtime/drawing witness needed to prove
    // old-owner absence. No production file, other real test, or shared helper is exempt.
    inactiveAccessAllowlist: ["src/stores/__tests__/parseFlowTopologyFreeze.test.ts"],
  },
} as const satisfies Record<ParseOwnershipPhase, OwnershipPhaseConfig>;

function ownershipForPhase(phase: ParseOwnershipPhase): OwnershipPhaseConfig {
  return OWNERSHIP_PHASES[phase];
}

const OWNERSHIP = ownershipForPhase(PARSE_OWNERSHIP_PHASE);
const ACTIVE_PARSE_OWNER = OWNERSHIP.active;
const INACTIVE_PARSE_OWNER = OWNERSHIP.inactive;
// Drawing never joins parseFlowStore during P2.4. This independent owner is intentionally the same
// physical store as ACTIVE_PARSE_OWNER in F0/S1 and becomes distinct at the S2 phase flip.
const RESIDUAL_DRAWING_OWNER = VIEWER_OWNER;

const PARSE_DATA_KEYS = [
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
  "paragraphOverlayActive",
  "paragraphBatch",
  "paragraphClipboard",
  "guidedParseActive",
  "guidedParseRegion",
  "guidedParseRows",
  "guidedParseCols",
] as const;

const PARSE_LEAF_ACTION_KEYS = [
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
] as const;

/** A2 additive authority stays outside the exact post-D2 live 34/40 ownership ledger. */
const PARSE_OPERATION_STATE_KEYS = ["parseOperations"] as const;
const GUIDED_PARSE_OWNER_STATE_KEYS = ["guidedParseOwner"] as const;
const PARSE_OPERATION_ACTION_KEYS = [
  "beginParseOperation",
  "isParseOperationCurrent",
  "finishParseOperation",
  "invalidateParseOperation",
] as const;

const NEUTRAL_STEP_COMMANDS = [
  "setTableParseStep",
  "setKeynoteParseStep",
  "setNotesParseStep",
  "setSpecParseStep",
] as const;

const TABLE_HOOK_SHAPE = [
  "tableParseStep",
  "tableParseRegion",
  "setTableParseRegion",
  "tableParsedGrid",
  "setTableParsedGrid",
  "tableParseColumnBBs",
  "addTableParseColumnBB",
  "tableParseRowBBs",
  "addTableParseRowBB",
  "setTableParseRowBBs",
  "tableParseColumnNames",
  "setTableParseColumnNames",
  "tableParseTab",
  "setTableParseTab",
  "tableParseOptions",
  "setTableParseOptions",
  "resetTableParse",
] as const;

const TABLE_EXTENSION_HOOK_SHAPE = [
  "tableParsedGrid",
  "setTableParsedGrid",
  "tableParseColumnBBs",
  "addTableParseColumnBB",
  "tableParseRowBBs",
  "addTableParseRowBB",
  "setTableParseRowBBs",
  "tableParseColumnNames",
  "setTableParseColumnNames",
  "tableParseTab",
  "setTableParseTab",
  "tableParseOptions",
  "setTableParseOptions",
] as const;

const KEYNOTE_HOOK_SHAPE = [
  "keynoteParseStep",
  "keynoteParseRegion",
  "setKeynoteParseRegion",
  "keynoteColumnBBs",
  "addKeynoteColumnBB",
  "keynoteRowBBs",
  "addKeynoteRowBB",
  "keynoteParseTab",
  "setKeynoteParseTab",
  "keynoteYoloClass",
  "setKeynoteYoloClass",
  "resetKeynoteParse",
  "guidedParseActive",
  "setGuidedParseActive",
  "guidedParseRegion",
  "setGuidedParseRegion",
  "guidedParseRows",
  "setGuidedParseRows",
  "guidedParseCols",
  "setGuidedParseCols",
  "resetGuidedParse",
] as const;

const KEYNOTE_EXTENSION_HOOK_SHAPE = [
  "keynoteParseTab",
  "setKeynoteParseTab",
  "keynoteColumnBBs",
  "addKeynoteColumnBB",
  "keynoteRowBBs",
  "addKeynoteRowBB",
  "keynoteYoloClass",
  "setKeynoteYoloClass",
  "parsedKeynoteData",
  "addParsedKeynote",
] as const;

const GUIDED_PARSE_EXTENSION_HOOK_SHAPE = [
  "guidedParseOwner",
  "guidedParseActive",
  "setGuidedParseActive",
  "guidedParseRegion",
  "setGuidedParseRegion",
  "guidedParseRows",
  "setGuidedParseRows",
  "guidedParseCols",
  "setGuidedParseCols",
  "resetGuidedParse",
] as const;

const NOTES_EXTENSION_HOOK_SHAPE = [
  "guidedNotesRows",
  "guidedNotesCols",
  "notesFastManualGrid",
] as const;
const PARSE_DRAFT_EXTENSION_HOOK_SHAPE = ["setParseDraftRegion"] as const;
const PARAGRAPH_WORKSPACE_EXTENSION_HOOK_SHAPE = [
  "paragraphBatch",
  "setParagraphBatch",
  "removePendingParagraph",
  "upsertPendingParagraph",
  "setParagraphOverlayActive",
] as const;

const TABLE_HOOK_CALLERS = {
  "src/components/viewer/AnnotationOverlay.tsx": 1,
  "src/components/viewer/AutoParseTab.tsx": 2,
  "src/components/viewer/GuidedParseTab.tsx": 1,
  "src/components/viewer/ManualParseTab.tsx": 1,
} as const;
const POST_TABLE_FACADE_HOOK_CALLERS = {
  "src/components/viewer/AnnotationOverlay.tsx": 1,
} as const;
const TABLE_EXTENSION_HOOK_CALLERS = {
  "src/components/viewer/AutoParseTab.tsx": 1,
  "src/components/viewer/GuidedParseTab.tsx": 1,
  "src/components/viewer/ManualParseTab.tsx": 1,
  "src/components/viewer/TableParsePanel.tsx": 1,
} as const;
const TABLE_EXTENSION_HOOK_BINDINGS = {
  "src/components/viewer/AutoParseTab.tsx": [{
    tableParsedGrid: "tableParsedGrid",
    tableParseTab: "tableParseTab",
    tableParseOptions: "tableParseOptions",
    setTableParseOptions: "setTableParseOptions",
  }],
  "src/components/viewer/GuidedParseTab.tsx": [{
    tableParsedGrid: "tableParsedGrid",
    setTableParsedGrid: "setTableParsedGrid",
  }],
  "src/components/viewer/ManualParseTab.tsx": [{
    tableParsedGrid: "tableParsedGrid",
    tableParseColumnBBs: "tableParseColumnBBs",
    tableParseRowBBs: "tableParseRowBBs",
    tableParseColumnNames: "tableParseColumnNames",
  }],
  "src/components/viewer/TableParsePanel.tsx": [{
    tableParsedGrid: "tableParsedGrid",
    tableParseTab: "tableParseTab",
  }],
} as const satisfies Readonly<Record<string, readonly Readonly<Record<string, string>>[]>>;

const KEYNOTE_HOOK_CALLERS = {
  "src/components/viewer/AnnotationOverlay.tsx": 1,
  "src/components/viewer/PDFPage.tsx": 1,
} as const;
const KEYNOTE_EXTENSION_HOOK_CALLERS = {
  "src/components/viewer/KeynotePanel.tsx": 1,
} as const;
const KEYNOTE_EXTENSION_HOOK_BINDINGS = {
  "src/components/viewer/KeynotePanel.tsx": [{
    keynoteParseTab: "keynoteParseTab",
    keynoteColumnBBs: "keynoteColumnBBs",
    keynoteRowBBs: "keynoteRowBBs",
    keynoteYoloClass: "keynoteYoloClass",
    parsedKeynoteData: "parsedKeynoteData",
    addParsedKeynote: "addParsedKeynote",
  }],
} as const satisfies Readonly<Record<string, readonly Readonly<Record<string, string>>[]>>;
const GUIDED_PARSE_EXTENSION_HOOK_CALLERS = {
  "src/components/viewer/GuidedParseTab.tsx": 1,
  "src/components/viewer/KeynotePanel.tsx": 1,
} as const;
const GUIDED_PARSE_EXTENSION_HOOK_BINDINGS = {
  "src/components/viewer/GuidedParseTab.tsx": [{
    guidedParseOwner: "guidedParseOwner",
    guidedParseActive: "sharedGuidedParseActive",
    guidedParseRegion: "sharedGuidedParseRegion",
    guidedParseRows: "sharedGuidedParseRows",
    guidedParseCols: "sharedGuidedParseCols",
  }],
  "src/components/viewer/KeynotePanel.tsx": [{
    guidedParseOwner: "guidedParseOwner",
    guidedParseActive: "sharedGuidedParseActive",
    guidedParseRegion: "sharedGuidedParseRegion",
    guidedParseRows: "sharedGuidedParseRows",
    guidedParseCols: "sharedGuidedParseCols",
  }],
} as const satisfies Readonly<Record<string, readonly Readonly<Record<string, string>>[]>>;
const NOTES_EXTENSION_HOOK_CALLERS = {
  "src/components/viewer/NotesParser.tsx": 1,
} as const;
const NOTES_EXTENSION_HOOK_BINDINGS = {
  "src/components/viewer/NotesParser.tsx": [{
    guidedNotesRows: "guidedNotesRows",
    guidedNotesCols: "guidedNotesCols",
    notesFastManualGrid: "notesFastManualGrid",
  }],
} as const satisfies Readonly<Record<string, readonly Readonly<Record<string, string>>[]>>;
const PARSE_DRAFT_EXTENSION_HOOK_CALLERS = {} as const;
const PARSE_DRAFT_EXTENSION_HOOK_BINDINGS = {} as const satisfies Readonly<
  Record<string, readonly Readonly<Record<string, string>>[]>
>;
const PARAGRAPH_WORKSPACE_EXTENSION_HOOK_CALLERS = {
  "src/components/viewer/NotesParser.tsx": 1,
  "src/components/viewer/SpecParser.tsx": 1,
} as const;
const PARAGRAPH_WORKSPACE_EXTENSION_HOOK_BINDINGS = {
  "src/components/viewer/NotesParser.tsx": [{
    paragraphBatch: "paragraphBatch",
  }],
  "src/components/viewer/SpecParser.tsx": [{
    paragraphBatch: "paragraphBatch",
  }],
} as const satisfies Readonly<Record<string, readonly Readonly<Record<string, string>>[]>>;

type ParseFacadePhase = "FACADE" | "TABLE" | "KEYNOTE" | "NOTES" | "SPEC";
// A1 advances one complete kind family at a time. Never accept a union of old and new callers:
// each intermediate commit must update this single phase switch with its atomic source migration.
const PARSE_FACADE_PHASE = "SPEC" as ParseFacadePhase;

type ParseFacadeCall = {
  readonly kind: "table" | "keynote" | "notes" | "spec";
  readonly bindings: Readonly<Record<string, string>>;
};
type ParseFacadeCallers = Readonly<Record<string, readonly ParseFacadeCall[]>>;

const TABLE_FACADE_CALLERS = {
  "src/components/viewer/TableParsePanel.tsx": [{
    kind: "table",
    bindings: {
      step: "tableParseStep",
      region: "tableParseRegion",
    },
  }],
  "src/components/viewer/AutoParseTab.tsx": [
    {
      kind: "table",
      bindings: {
        step: "tableParseStep",
        region: "tableParseRegion",
      },
    },
    { kind: "table", bindings: { region: "tableParseRegion" } },
  ],
  "src/components/viewer/GuidedParseTab.tsx": [{
    kind: "table",
    bindings: {
      region: "tableParseRegion",
    },
  }],
  "src/components/viewer/ManualParseTab.tsx": [{
    kind: "table",
    bindings: {
      step: "tableParseStep",
      region: "tableParseRegion",
    },
  }],
} as const satisfies ParseFacadeCallers;

const KEYNOTE_FACADE_CALLERS = {
  "src/components/viewer/KeynotePanel.tsx": [{
    kind: "keynote",
    bindings: {
      step: "keynoteParseStep",
      region: "keynoteParseRegion",
      reset: "resetKeynoteParse",
    },
  }],
} as const satisfies ParseFacadeCallers;

const NOTES_FACADE_CALLERS = {
  "src/components/viewer/NotesPanel.tsx": [{
    kind: "notes",
    bindings: { region: "notesParseRegion" },
  }],
  "src/components/viewer/NotesParser.tsx": [{
    kind: "notes",
    bindings: { region: "notesParseRegion" },
  }],
} as const satisfies ParseFacadeCallers;

const SPEC_FACADE_CALLERS = {
  "src/components/viewer/SpecPanel.tsx": [{
    kind: "spec",
    bindings: { region: "specParseRegion" },
  }],
  "src/components/viewer/SpecParser.tsx": [{
    kind: "spec",
    bindings: { region: "specParseRegion" },
  }],
} as const satisfies ParseFacadeCallers;

const EXPECTED_PARSE_FACADE_CALLERS = {
  FACADE: {},
  TABLE: TABLE_FACADE_CALLERS,
  KEYNOTE: { ...TABLE_FACADE_CALLERS, ...KEYNOTE_FACADE_CALLERS },
  NOTES: { ...TABLE_FACADE_CALLERS, ...KEYNOTE_FACADE_CALLERS, ...NOTES_FACADE_CALLERS },
  SPEC: {
    ...TABLE_FACADE_CALLERS,
    ...KEYNOTE_FACADE_CALLERS,
    ...NOTES_FACADE_CALLERS,
    ...SPEC_FACADE_CALLERS,
  },
} as const satisfies Record<ParseFacadePhase, ParseFacadeCallers>;

const PARSE_LIFECYCLE_MEMBERS = {
  table: [
    "tableParseStep", "tableParseRegion", "setTableParseRegion", "resetTableParse",
  ],
  keynote: [
    "keynoteParseStep", "keynoteParseRegion", "setKeynoteParseRegion", "resetKeynoteParse",
  ],
  notes: [
    "notesParseStep", "notesParseRegion", "setNotesParseRegion", "resetNotesParse",
  ],
  spec: [
    "specParseStep", "specParseRegion", "setSpecParseRegion", "resetSpecParse",
  ],
} as const satisfies Record<ParseFacadeCall["kind"], readonly string[]>;
const ALL_PARSE_LIFECYCLE_MEMBERS = new Set<string>(
  Object.values(PARSE_LIFECYCLE_MEMBERS).flat(),
);

const EXPECTED_MIGRATED_LIFECYCLE_RESIDUALS = {
  "src/components/viewer/TableParsePanel.tsx": ["getState:read:tableParseRegion"],
  "src/components/viewer/AutoParseTab.tsx": [],
  "src/components/viewer/GuidedParseTab.tsx": ["getState:read:tableParseRegion"],
  "src/components/viewer/ManualParseTab.tsx": [],
  "src/components/viewer/KeynotePanel.tsx": [
    "getState:read:keynoteParseRegion",
    "getState:read:keynoteParseRegion",
  ],
  "src/components/viewer/NotesPanel.tsx": [],
  "src/components/viewer/NotesParser.tsx": [],
  "src/components/viewer/NotesClassifier.tsx": [],
  "src/components/viewer/NotesIndex.tsx": [],
  "src/components/viewer/SpecPanel.tsx": [],
  "src/components/viewer/SpecParser.tsx": [],
  "src/components/viewer/SpecClassifier.tsx": [],
  "src/components/viewer/SpecIndex.tsx": [],
} as const satisfies Record<string, readonly string[]>;

const EXPECTED_MIGRATED_DIRECT_SELECTORS = {
  "src/components/viewer/TableParsePanel.tsx": [],
  "src/components/viewer/AutoParseTab.tsx": [
    "tableCellStructure",
    "showTableCellStructure",
    "setShowTableCellStructure",
  ],
  // Shared guided state has its own explicit extension facade after the Keynote slice.
  "src/components/viewer/GuidedParseTab.tsx": [],
  "src/components/viewer/ManualParseTab.tsx": [],
  "src/components/viewer/KeynotePanel.tsx": [],
  "src/components/viewer/NotesPanel.tsx": [],
  "src/components/viewer/NotesParser.tsx": [],
  "src/components/viewer/NotesClassifier.tsx": [],
  "src/components/viewer/NotesIndex.tsx": [],
  "src/components/viewer/SpecPanel.tsx": [],
  "src/components/viewer/SpecParser.tsx": [],
  "src/components/viewer/SpecClassifier.tsx": [],
  "src/components/viewer/SpecIndex.tsx": [],
} as const satisfies Record<string, readonly string[]>;

const EXPECTED_MIGRATED_NEUTRAL_COMMANDS = {
  "src/components/viewer/TableParsePanel.tsx": {},
  "src/components/viewer/AutoParseTab.tsx": {},
  "src/components/viewer/GuidedParseTab.tsx": {},
  "src/components/viewer/ManualParseTab.tsx": {},
  "src/components/viewer/KeynotePanel.tsx": {},
  "src/components/viewer/NotesPanel.tsx": {},
  "src/components/viewer/NotesParser.tsx": {},
  "src/components/viewer/NotesClassifier.tsx": {},
  "src/components/viewer/NotesIndex.tsx": {},
  "src/components/viewer/SpecPanel.tsx": {},
  "src/components/viewer/SpecParser.tsx": {},
  "src/components/viewer/SpecClassifier.tsx": {},
  "src/components/viewer/SpecIndex.tsx": {},
} as const satisfies Record<string, Readonly<Partial<Record<
  (typeof NEUTRAL_STEP_COMMANDS)[number],
  number
>>>>;

const PARSE_MEMBERS = new Set<string>([
  ...PARSE_DATA_KEYS,
  ...PARSE_LEAF_ACTION_KEYS,
]);
const ALL_PARSE_KEYS = [...PARSE_DATA_KEYS, ...PARSE_LEAF_ACTION_KEYS] as const;
const PARSE_TYPE_NAMES = ["PendingParagraph", "ParagraphTemplate"] as const;
const DRAWING_KEYS = ["_drawing", "_drawStart", "_drawEnd", "_mousePos"] as const;

function ownerDescriptor(
  owner: typeof VIEWER_OWNER | typeof PARSE_OWNER,
  members: readonly string[],
): StoreOwnerDescriptor {
  return {
    moduleName: owner.module,
    exportName: owner.exportName,
    members,
  };
}

const ACTIVE_PARSE_DESCRIPTOR = ownerDescriptor(ACTIVE_PARSE_OWNER, ALL_PARSE_KEYS);
const ACTIVE_PARSE_AUTHORITY_DESCRIPTOR = ownerDescriptor(ACTIVE_PARSE_OWNER, [
  ...ALL_PARSE_KEYS,
  ...PARSE_OPERATION_STATE_KEYS,
  ...GUIDED_PARSE_OWNER_STATE_KEYS,
]);
const INACTIVE_PARSE_DESCRIPTOR = ownerDescriptor(INACTIVE_PARSE_OWNER, ALL_PARSE_KEYS);
const RESIDUAL_DRAWING_DESCRIPTOR = ownerDescriptor(RESIDUAL_DRAWING_OWNER, DRAWING_KEYS);

type RuntimeStateReader = () => Readonly<Record<string, unknown>>;
const RUNTIME_OWNER_STATE_READERS: Partial<Record<string, RuntimeStateReader>> = {
  [VIEWER_OWNER.module]: () =>
    useViewerStore.getState() as unknown as Readonly<Record<string, unknown>>,
  [PARSE_OWNER.module]: () =>
    useParseFlowStore.getState() as unknown as Readonly<Record<string, unknown>>,
};

const textCache = new Map<string, string>();
const sourceCache = new Map<string, ts.SourceFile>();

function existsRelative(path: string): boolean {
  return existsSync(join(process.cwd(), path));
}

function textOf(path: string): string {
  const cached = textCache.get(path);
  if (cached !== undefined) return cached;
  const text = readFileSync(join(process.cwd(), path), "utf8");
  textCache.set(path, text);
  return text;
}

function parse(path: string): ts.SourceFile {
  const cached = sourceCache.get(path);
  if (cached) return cached;
  const source = ts.createSourceFile(
    path,
    textOf(path),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx")
      ? ts.ScriptKind.TSX
      : path.endsWith(".jsx")
        ? ts.ScriptKind.JSX
        : /\.(?:[cm]?js)$/.test(path)
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS,
  );
  sourceCache.set(path, source);
  return source;
}

function descendants<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T[] {
  const output: T[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) output.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return output;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function compact(node: ts.Node, source: ts.SourceFile): string {
  return node.getText(source).replace(/\s+/g, "");
}

function staticName(name: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (!name) return null;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? name.text
    : null;
}

function directObjectKeys(object: ts.ObjectLiteralExpression): string[] {
  return object.properties
    .map((property) => ("name" in property ? staticName(property.name) : null))
    .filter((name): name is string => name !== null);
}

function findVariable(source: ts.SourceFile, name: string): ts.VariableDeclaration {
  const matches = descendants(
    source,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name,
  );
  expect(matches, `${name} declaration`).toHaveLength(1);
  return matches[0];
}

function findVariableWithin(root: ts.Node, name: string): ts.VariableDeclaration {
  const matches = descendants(
    root,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name,
  );
  expect(matches, `${name} nested declaration`).toHaveLength(1);
  return matches[0];
}

function findInterface(source: ts.SourceFile, name: string): ts.InterfaceDeclaration {
  const matches = descendants(
    source,
    (node): node is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(node) && node.name.text === name,
  );
  expect(matches, `${name} interface`).toHaveLength(1);
  return matches[0];
}

function interfaceKeys(declaration: ts.InterfaceDeclaration): string[] {
  return declaration.members
    .map((member) => ("name" in member ? staticName(member.name) : null))
    .filter((name): name is string => name !== null);
}

function findStoreObject(source: ts.SourceFile, storeName: string): ts.ObjectLiteralExpression {
  const declaration = findVariable(source, storeName);
  const initializer = declaration.initializer;
  expect(initializer && ts.isCallExpression(initializer), `${storeName} create call`).toBe(true);
  const factory = (initializer as ts.CallExpression).arguments[0];
  expect(
    factory && (ts.isArrowFunction(factory) || ts.isFunctionExpression(factory)),
    `${storeName} factory`,
  ).toBe(true);
  const body = (factory as ts.ArrowFunction | ts.FunctionExpression).body;
  const expression = ts.isExpression(body) ? unwrap(body) : body;
  expect(ts.isObjectLiteralExpression(expression), `${storeName} object`).toBe(true);
  return expression as ts.ObjectLiteralExpression;
}

function directProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralElementLike {
  const matches = object.properties.filter(
    (property) => "name" in property && staticName(property.name) === name,
  );
  expect(matches, `${name} property`).toHaveLength(1);
  return matches[0];
}

function ownerDefinitionKeys(owner: typeof VIEWER_OWNER | typeof PARSE_OWNER): {
  interfaceKeys: string[];
  objectKeys: string[];
} {
  const source = parse(owner.file);
  return {
    interfaceKeys: interfaceKeys(findInterface(source, owner.interfaceName)),
    objectKeys: directObjectKeys(findStoreObject(source, owner.storeName)),
  };
}

function expectOwnerLedgerDefinition(
  owner: typeof VIEWER_OWNER | typeof PARSE_OWNER,
  expectation: Exclude<OwnerDefinitionExpectation, "module-absent">,
): void {
  const definitions = ownerDefinitionKeys(owner);
  const runtimeReader = RUNTIME_OWNER_STATE_READERS[owner.module];
  expect(runtimeReader, `${owner.exportName} runtime reader for ${PARSE_OWNERSHIP_PHASE}`).toBeDefined();
  const runtimeState = runtimeReader!();
  for (const member of ALL_PARSE_KEYS) {
    const present = expectation === "exact-ledger";
    expect(definitions.interfaceKeys.includes(member), `${member} interface ownership`).toBe(present);
    expect(definitions.objectKeys.includes(member), `${member} implementation ownership`).toBe(present);
    expect(
      Object.prototype.hasOwnProperty.call(runtimeState, member),
      `${member} runtime ownership`,
    ).toBe(present);
  }
  for (const typeName of PARSE_TYPE_NAMES) {
    const present = expectation === "exact-ledger";
    const declarations = descendants(
      parse(owner.file),
      (node): node is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(node) && node.name.text === typeName,
    );
    expect(declarations, `${typeName} definition ownership`).toHaveLength(present ? 1 : 0);
  }
  if (owner.module === PARSE_OWNER.module && expectation === "exact-ledger") {
    const expected = [
      ...ALL_PARSE_KEYS,
      ...GUIDED_PARSE_OWNER_STATE_KEYS,
      ...PARSE_OPERATION_STATE_KEYS,
      ...PARSE_OPERATION_ACTION_KEYS,
      "resetProjectParseState",
    ].sort();
    const candidateSource = parse(owner.file);
    const candidateInterface = findInterface(candidateSource, owner.interfaceName);
    const candidateObject = findStoreObject(candidateSource, owner.storeName);
    expect(candidateInterface.heritageClauses ?? [], "candidate interface has no inherited surface")
      .toEqual([]);
    expect(candidateInterface.members, "candidate raw interface member count")
      .toHaveLength(expected.length);
    expect(candidateInterface.members.every((member) =>
      ts.isPropertySignature(member) && staticName(member.name) !== null
    ), "candidate interface uses only named property signatures").toBe(true);
    expect(candidateObject.properties, "candidate raw implementation member count")
      .toHaveLength(expected.length);
    expect(candidateObject.properties.every((property) =>
      ts.isPropertyAssignment(property) && staticName(property.name) !== null
    ), "candidate store uses only named property assignments").toBe(true);
    expect(new Set(definitions.interfaceKeys).size, "candidate interface keys unique")
      .toBe(definitions.interfaceKeys.length);
    expect(new Set(definitions.objectKeys).size, "candidate store keys unique")
      .toBe(definitions.objectKeys.length);
    expect([...definitions.interfaceKeys].sort(), "candidate exact interface ledger")
      .toEqual(expected);
    expect([...definitions.objectKeys].sort(), "candidate exact implementation ledger")
      .toEqual(expected);
    expect(Object.keys(runtimeState).sort(), "candidate exact runtime ledger").toEqual(expected);
  }
}

function typeScriptSourceFiles(directory = "src"): string[] {
  const output: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(join(process.cwd(), current), { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(child);
      } else if (
        /\.(?:ts|tsx)$/.test(entry.name) &&
        !entry.name.endsWith(".d.ts")
      ) {
        output.push(child);
      }
    }
  };
  visit(directory);
  return output.sort();
}

const PROJECT_SOURCE_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "node_modules",
  "perf",
  "playwright-report",
  "test-results",
]);

function supportedProjectSourceFiles(): string[] {
  const output: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(join(process.cwd(), current), { withFileTypes: true })) {
      if (entry.isDirectory() && PROJECT_SOURCE_IGNORED_DIRECTORIES.has(entry.name)) continue;
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(child);
      } else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) {
        output.push(child);
      }
    }
  };
  visit(".");
  return output.sort();
}

function staticStringValue(
  expression: ts.Expression,
  bindings: ReadonlyMap<string, string>,
): string | null {
  const value = unwrap(expression);
  if (ts.isStringLiteralLike(value)) return value.text;
  if (ts.isIdentifier(value)) return bindings.get(value.text) ?? null;
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringValue(value.left, bindings);
    const right = staticStringValue(value.right, bindings);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(value)) {
    let output = value.head.text;
    for (const span of value.templateSpans) {
      const part = staticStringValue(span.expression, bindings);
      if (part === null) return null;
      output += part + span.literal.text;
    }
    return output;
  }
  return null;
}

function staticStringBindings(source: ts.SourceFile): ReadonlyMap<string, string> {
  const bindings = new Map<string, string>();
  const declarations = descendants(
    source,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && !!node.initializer,
  );
  for (let pass = 0; pass < declarations.length; pass += 1) {
    let changed = false;
    for (const declaration of declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      if (bindings.has(declaration.name.text)) continue;
      const value = staticStringValue(declaration.initializer!, bindings);
      if (value === null) continue;
      bindings.set(declaration.name.text, value);
      changed = true;
    }
    if (!changed) break;
  }
  return bindings;
}

function retiredStaticNameFindings(
  source: ts.SourceFile,
  retiredNames: ReadonlySet<string>,
): string[] {
  const bindings = staticStringBindings(source);
  const findings = new Set<string>();
  for (const node of descendants(source, (candidate): candidate is ts.Node => candidate !== source)) {
    let value: string | null = null;
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
      value = ts.isIdentifier(node) ? (bindings.get(node.text) ?? node.text) : node.text;
    } else if (ts.isComputedPropertyName(node)) {
      value = staticStringValue(node.expression, bindings);
    } else if (ts.isElementAccessExpression(node) && node.argumentExpression) {
      value = staticStringValue(node.argumentExpression, bindings);
    } else if (ts.isBinaryExpression(node) || ts.isTemplateExpression(node)) {
      value = staticStringValue(node, bindings);
    }
    if (value !== null && retiredNames.has(value)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      findings.add(`${source.fileName}:${line}:${value}`);
    }
  }
  return [...findings].sort();
}

function isRealTestSource(path: string): boolean {
  return path.includes("/__tests__/") || /\.(?:test|spec)\.(?:ts|tsx)$/.test(path);
}

const everyTypeScriptSourceFile = typeScriptSourceFiles();
const srcTestSourceFiles = everyTypeScriptSourceFile.filter((path) => path.startsWith("src/test/"));
const realTestSourceFiles = everyTypeScriptSourceFile.filter(
  (path) => !path.startsWith("src/test/") && isRealTestSource(path),
);
const productionSourceFiles = everyTypeScriptSourceFile.filter(
  (path) => !path.startsWith("src/test/") && !isRealTestSource(path),
);
// Keep the composition explicit: future phase gates must not silently scan only production while
// stale test helpers retain the old owner. The Set both documents and enforces de-duplication.
const allSourceCorpus = [...new Set([
  ...productionSourceFiles,
  ...realTestSourceFiles,
  ...srcTestSourceFiles,
])].sort();

function importedLocalNames(
  source: ts.SourceFile,
  moduleNames: readonly string[],
  importedName: string,
): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !moduleNames.includes(statement.moduleSpecifier.text)
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === importedName) {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

function identifierAliases(root: ts.Node, seeds: Iterable<string>): Set<string> {
  const aliases = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of descendants(root, ts.isVariableDeclaration)) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const initializer = unwrap(declaration.initializer);
      if (
        ts.isIdentifier(initializer) &&
        aliases.has(initializer.text) &&
        !aliases.has(declaration.name.text)
      ) {
        aliases.add(declaration.name.text);
        changed = true;
      }
    }
  }
  return aliases;
}

function importedNamespaceNames(
  source: ts.SourceFile,
  moduleNames: readonly string[],
): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !moduleNames.includes(statement.moduleSpecifier.text)
    ) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
  }
  return identifierAliases(source, names);
}

function namespaceTerminalCalls(
  source: ts.SourceFile,
  moduleNames: readonly string[],
): Array<{ call: ts.CallExpression; name: string | null }> {
  const namespaces = importedNamespaceNames(source, moduleNames);
  return descendants(source, ts.isCallExpression).flatMap((call) => {
    const callee = unwrap(call.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      const receiver = unwrap(callee.expression);
      return ts.isIdentifier(receiver) && namespaces.has(receiver.text)
        ? [{ call, name: callee.name.text }]
        : [];
    }
    if (ts.isElementAccessExpression(callee)) {
      const receiver = unwrap(callee.expression);
      if (!ts.isIdentifier(receiver) || !namespaces.has(receiver.text)) return [];
      const argument = callee.argumentExpression && unwrap(callee.argumentExpression);
      return [{
        call,
        name: argument && ts.isStringLiteralLike(argument) ? argument.text : null,
      }];
    }
    return [];
  });
}

function importedCalls(
  source: ts.SourceFile,
  moduleNames: readonly string[],
  importedName: string,
): ts.CallExpression[] {
  const aliases = identifierAliases(
    source,
    importedLocalNames(source, moduleNames, importedName),
  );
  return descendants(source, ts.isCallExpression).filter((call) => {
    const expression = unwrap(call.expression);
    return ts.isIdentifier(expression) && aliases.has(expression.text);
  });
}

function expressionEnvelope(node: ts.Node): ts.Node {
  let current = node;
  while (
    current.parent &&
    ((ts.isParenthesizedExpression(current.parent) && current.parent.expression === current) ||
      (ts.isAsExpression(current.parent) && current.parent.expression === current) ||
      (ts.isTypeAssertionExpression(current.parent) && current.parent.expression === current) ||
      (ts.isNonNullExpression(current.parent) && current.parent.expression === current) ||
      (ts.isSatisfiesExpression(current.parent) && current.parent.expression === current))
  ) current = current.parent;
  return current;
}

function isNonReferencePropertyName(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    (ts.isQualifiedName(parent) && parent.right === identifier) ||
    (ts.isPropertyAssignment(parent) && parent.name === identifier) ||
    (ts.isMethodDeclaration(parent) && parent.name === identifier) ||
    (ts.isMethodSignature(parent) && parent.name === identifier) ||
    (ts.isPropertyDeclaration(parent) && parent.name === identifier) ||
    (ts.isPropertySignature(parent) && parent.name === identifier) ||
    (ts.isGetAccessorDeclaration(parent) && parent.name === identifier) ||
    (ts.isSetAccessorDeclaration(parent) && parent.name === identifier) ||
    (ts.isBindingElement(parent) && parent.propertyName === identifier) ||
    (ts.isJsxAttribute(parent) && parent.name === identifier) ||
    (ts.isLabeledStatement(parent) && parent.label === identifier) ||
    ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) &&
      parent.label === identifier)
  );
}

/**
 * Returns every imported callable reference outside the deliberately small supported grammar:
 * named import -> optional simple identifier alias chain -> direct call. This makes invocation
 * provenance fail closed for `.call`/`.apply`/`.bind`, optional calls, argument passing, object
 * storage, comma expressions, and future indirect forms that a direct-callee counter cannot see.
 */
function importedCallableReferences(
  source: ts.SourceFile,
  moduleNames: readonly string[],
  importedName: string,
): ts.Identifier[] {
  const aliases = identifierAliases(
    source,
    importedLocalNames(source, moduleNames, importedName),
  );
  return descendants(source, ts.isIdentifier).filter((identifier) => {
    if (!aliases.has(identifier.text)) return false;
    const parent = identifier.parent;
    return !ts.isImportSpecifier(parent) && !isNonReferencePropertyName(identifier);
  });
}

function unsupportedImportedCallableReferences(
  source: ts.SourceFile,
  moduleNames: readonly string[],
  importedName: string,
): string[] {
  const aliases = identifierAliases(
    source,
    importedLocalNames(source, moduleNames, importedName),
  );
  return importedCallableReferences(source, moduleNames, importedName).flatMap((identifier) => {
    const parent = identifier.parent;

    const envelope = expressionEnvelope(identifier);
    if (
      ts.isVariableDeclaration(envelope.parent) &&
      envelope.parent.name === envelope &&
      envelope.parent.initializer &&
      ts.isIdentifier(unwrap(envelope.parent.initializer)) &&
      aliases.has((unwrap(envelope.parent.initializer) as ts.Identifier).text)
    ) return [];
    if (
      ts.isVariableDeclaration(envelope.parent) &&
      envelope.parent.initializer === envelope &&
      ts.isIdentifier(envelope.parent.name) &&
      aliases.has(envelope.parent.name.text)
    ) return [];
    if (
      ts.isCallExpression(envelope.parent) &&
      envelope.parent.expression === envelope &&
      !envelope.parent.questionDotToken
    ) return [];

    return [`${identifier.text}:${ts.SyntaxKind[parent.kind]}`];
  });
}

function importedCallTopology(
  importedName: string,
  owner: typeof VIEWER_OWNER | typeof PARSE_OWNER,
): Record<string, number> {
  return Object.fromEntries(
    productionSourceFiles
      .map((path) => [
        path,
        importedCalls(parse(path), [owner.module], importedName).length,
      ] as const)
      .filter(([, count]) => count > 0),
  );
}

function exportedVariableCount(source: ts.SourceFile, name: string): number {
  return source.statements.filter((statement) =>
    ts.isVariableStatement(statement) &&
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
    statement.declarationList.declarations.some(
      (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
    )
  ).length + source.statements.filter((statement) =>
    ts.isExportDeclaration(statement) &&
    statement.exportClause &&
    ts.isNamedExports(statement.exportClause) &&
    statement.exportClause.elements.some(
      (element) => (element.propertyName ?? element.name).text === name,
    )
  ).length;
}

function hookShape(
  name: string,
  expectedShape: readonly string[],
  owner: typeof VIEWER_OWNER | typeof PARSE_OWNER = ACTIVE_PARSE_OWNER,
): string[] {
  const source = parse(owner.file);
  const declaration = findVariable(source, name);
  const initializer = declaration.initializer && unwrap(declaration.initializer);
  expect(initializer && ts.isArrowFunction(initializer), `${name} hook arrow`).toBe(true);
  const body = unwrap((initializer as ts.ArrowFunction).body as ts.Expression);
  expect(ts.isCallExpression(body), `${name} active-owner call`).toBe(true);
  const ownerCall = body as ts.CallExpression;
  expect(compact(ownerCall.expression, source), `${name} active owner`).toBe(
    owner.exportName,
  );
  expect(ownerCall.arguments, `${name} active-owner arguments`).toHaveLength(1);

  const shallowCall = unwrap(ownerCall.arguments[0]);
  expect(ts.isCallExpression(shallowCall), `${name} useShallow call`).toBe(true);
  const shallowNames = importedLocalNames(
    source,
    ["zustand/react/shallow"],
    "useShallow",
  );
  expect(shallowNames.size, `${name} useShallow import provenance`).toBe(1);
  expect(
    ts.isIdentifier((shallowCall as ts.CallExpression).expression) &&
      shallowNames.has(((shallowCall as ts.CallExpression).expression as ts.Identifier).text),
    `${name} must wrap its selector with imported useShallow`,
  ).toBe(true);
  expect((shallowCall as ts.CallExpression).arguments, `${name} useShallow arguments`)
    .toHaveLength(1);

  const selector = unwrap((shallowCall as ts.CallExpression).arguments[0]);
  expect(selector && ts.isArrowFunction(selector), `${name} selector arrow`).toBe(true);
  expect((selector as ts.ArrowFunction).parameters, `${name} selector parameters`).toHaveLength(1);
  const parameter = (selector as ts.ArrowFunction).parameters[0]?.name;
  expect(parameter && ts.isIdentifier(parameter), `${name} selector state parameter`).toBe(true);
  const object = unwrap((selector as ts.ArrowFunction).body as ts.Expression);
  expect(ts.isObjectLiteralExpression(object), `${name} selector object`).toBe(true);
  const properties = (object as ts.ObjectLiteralExpression).properties;
  expect(properties, `${name} selector property count`).toHaveLength(expectedShape.length);

  const mappings = properties.map((property) => {
    expect(ts.isPropertyAssignment(property), `${name} plain key mapping`).toBe(true);
    const assignment = property as ts.PropertyAssignment;
    const key = staticName(assignment.name);
    const value = unwrap(assignment.initializer);
    expect(key, `${name} static selector key`).not.toBeNull();
    expect(ts.isPropertyAccessExpression(value), `${name}.${key} direct state read`).toBe(true);
    const access = value as ts.PropertyAccessExpression;
    expect(
      ts.isIdentifier(access.expression) &&
        (access.expression as ts.Identifier).text === (parameter as ts.Identifier).text,
      `${name}.${key} receiver`,
    ).toBe(true);
    expect(access.name.text, `${name}.${key} exact mapping`)
      .toBe(key);
    return key!;
  });
  return mappings;
}

function selectorFunction(
  expression: ts.Expression | undefined,
): ts.ArrowFunction | ts.FunctionExpression | null {
  if (!expression) return null;
  const current = unwrap(expression);
  if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) return current;
  if (ts.isCallExpression(current)) {
    for (const argument of current.arguments) {
      const nested = selectorFunction(argument);
      if (nested) return nested;
    }
  }
  return null;
}

function primitiveSelectorMembers(
  source: ts.SourceFile,
  owner: { readonly module: string; readonly exportName: string },
): string[] {
  const hooks = identifierAliases(
    source,
    importedLocalNames(source, [owner.module], owner.exportName),
  );
  const output: string[] = [];
  for (const call of descendants(source, ts.isCallExpression)) {
    const callee = unwrap(call.expression);
    if (!ts.isIdentifier(callee) || !hooks.has(callee.text)) continue;
    const selector = selectorFunction(call.arguments[0]);
    if (
      !selector ||
      selector.parameters.length !== 1 ||
      !ts.isIdentifier(selector.parameters[0].name)
    ) {
      continue;
    }
    const parameter = selector.parameters[0].name.text;
    const selected = descendants(
      selector.body,
      (node): node is ts.PropertyAccessExpression =>
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(unwrap(node.expression)) &&
        (unwrap(node.expression) as ts.Identifier).text === parameter,
    ).map((access) => access.name.text);
    expect(selected, `primitive selector at ${call.getStart(source)}`).toHaveLength(1);
    output.push(selected[0]);
  }
  return output;
}

function bindingNames(name: ts.BindingName): string[] {
  if (!ts.isObjectBindingPattern(name)) return [];
  return name.elements
    .map((element) => staticName(element.propertyName ?? element.name))
    .filter((member): member is string => member !== null);
}

function groupedDestructure(source: ts.SourceFile, hookName: string): string[] {
  const calls = importedCalls(
    source,
    [ACTIVE_PARSE_OWNER.module],
    hookName,
  );
  expect(calls, `${hookName} call`).toHaveLength(1);
  let current: ts.Node = calls[0];
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isNonNullExpression(current.parent))
  ) {
    current = current.parent;
  }
  expect(ts.isVariableDeclaration(current.parent), `${hookName} binding`).toBe(true);
  return bindingNames((current.parent as ts.VariableDeclaration).name);
}

function parseFacadeBindings(
  call: ts.CallExpression,
  source: ts.SourceFile,
): Record<string, string> {
  let current: ts.Node = call;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isNonNullExpression(current.parent))
  ) current = current.parent;
  expect(ts.isVariableDeclaration(current.parent), "useParseFlow destructure").toBe(true);
  const name = (current.parent as ts.VariableDeclaration).name;
  expect(ts.isObjectBindingPattern(name), "useParseFlow object binding").toBe(true);
  return Object.fromEntries((name as ts.ObjectBindingPattern).elements.map((element) => {
    expect(element.dotDotDotToken, "useParseFlow has no rest binding").toBeUndefined();
    expect(ts.isIdentifier(element.name), "useParseFlow local binding").toBe(true);
    const property = staticName(element.propertyName ?? element.name);
    expect(property, "useParseFlow static property binding").not.toBeNull();
    return [property!, (element.name as ts.Identifier).text];
  }));
}

function productionParseFacadeCallers(): ParseFacadeCallers {
  return Object.fromEntries(productionSourceFiles.flatMap((path) => {
    const source = parse(path);
    const calls = importedCalls(source, [PARSE_FACADE_MODULE], "useParseFlow");
    if (calls.length === 0) return [];
    return [[path, calls.map((call): ParseFacadeCall => {
      expect(call.arguments, `${path} useParseFlow arguments`).toHaveLength(1);
      const kind = call.arguments[0] && unwrap(call.arguments[0]);
      expect(kind && ts.isStringLiteral(kind), `${path} literal parse kind`).toBe(true);
      return {
        kind: (kind as ts.StringLiteral).text as ParseFacadeCall["kind"],
        bindings: parseFacadeBindings(call, source),
      };
    })]];
  }));
}

function productionHookBindingCallers(
  moduleName: string,
  hookName: string,
): Readonly<Record<string, readonly Readonly<Record<string, string>>[]>> {
  return Object.fromEntries(productionSourceFiles.flatMap((path) => {
    const source = parse(path);
    const calls = importedCalls(source, [moduleName], hookName);
    return calls.length > 0
      ? [[path, calls.map((call) => parseFacadeBindings(call, source))]]
      : [];
  }));
}

function ownerScan(
  source: ts.SourceFile,
  descriptor: StoreOwnerDescriptor = ACTIVE_PARSE_DESCRIPTOR,
): StoreOwnerScanResult {
  return scanStoreOwnerSource(source, descriptor);
}

function findingLabels(result: StoreOwnerScanResult): string[] {
  return result.uncertain.map((finding) =>
    `${finding.fileName}:${finding.line}:${finding.column} ${formatStoreOwnerFinding(finding)}`
  );
}

function expectFailClosedOwnerScan(
  source: ts.SourceFile,
  descriptor: StoreOwnerDescriptor = ACTIVE_PARSE_DESCRIPTOR,
): StoreOwnerScanResult {
  const result = ownerScan(source, descriptor);
  expect(findingLabels(result), `${source.fileName} broad/opaque owner access`).toEqual([]);
  return result;
}

function knownMembers(
  result: StoreOwnerScanResult,
  operation?: StoreOwnerScanResult["known"][number]["operation"],
): string[] {
  return result.known
    .filter((finding) => !operation || finding.operation === operation)
    .map((finding) => finding.member)
    .filter((member): member is string => member !== null);
}

function groupedBorrowedMembers(source: ts.SourceFile): string[] {
  return [
    "useTableParse",
    "useKeynoteParse",
    "useTableParseExtensions",
    "useKeynoteParseExtensions",
    "useGuidedParseExtensions",
    "useNotesParseExtensions",
    "useParseDraftExtensions",
    "useParagraphWorkspaceExtensions",
  ].flatMap((hookName) =>
    importedCalls(source, [ACTIVE_PARSE_OWNER.module], hookName).flatMap((call) => {
      let current: ts.Node = call;
      while (
        current.parent &&
        (ts.isParenthesizedExpression(current.parent) ||
          ts.isAsExpression(current.parent) ||
          ts.isNonNullExpression(current.parent))
      ) current = current.parent;
      return ts.isVariableDeclaration(current.parent)
        ? bindingNames(current.parent.name).filter((member) => PARSE_MEMBERS.has(member))
        : [];
    })
  );
}

const provenBorrowerCache = new Map<string, Set<string>>();

function provenBorrowerMembers(path: string): Set<string> {
  const cached = provenBorrowerCache.get(path);
  if (cached) return cached;
  const source = parse(path);
  const result = expectFailClosedOwnerScan(source);
  const members = new Set([...knownMembers(result), ...groupedBorrowedMembers(source)]);
  for (const typeName of PARSE_TYPE_NAMES) {
    if (importedLocalNames(source, [ACTIVE_PARSE_OWNER.module], typeName).size > 0) {
      members.add(typeName);
    }
  }
  provenBorrowerCache.set(path, members);
  return members;
}

function importsModule(source: ts.SourceFile, moduleName: string): boolean {
  return source.statements.some((statement) =>
    ts.isImportDeclaration(statement) &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text === moduleName
  );
}

function resolvesToParseOwner(importerPath: string, specifier: string): boolean {
  const unresolved = specifier === PARSE_OWNER.module
    ? PARSE_OWNER.file.slice(0, -3)
    : specifier.startsWith("@/")
      ? join("src", specifier.slice(2))
      : specifier.startsWith(".")
        ? join(dirname(importerPath), specifier)
        : "";
  const withoutExtension = unresolved.replace(/\.(?:ts|tsx)$/, "");
  return withoutExtension === PARSE_OWNER.file.replace(/\.ts$/, "");
}

function parseOwnerLoadKinds(path: string, source = parse(path)): string[] {
  const loads: string[] = [];
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      resolvesToParseOwner(path, statement.moduleSpecifier.text)
    ) loads.push("import");
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      resolvesToParseOwner(path, statement.moduleSpecifier.text)
    ) loads.push("re-export");
  }
  for (const call of descendants(source, ts.isCallExpression)) {
    const specifier = call.arguments[0];
    if (!specifier || !ts.isStringLiteralLike(specifier)) continue;
    const callee = unwrap(call.expression);
    if (!resolvesToParseOwner(path, specifier.text)) continue;
    if (callee.kind === ts.SyntaxKind.ImportKeyword) loads.push("dynamic-import");
    if (ts.isIdentifier(callee) && callee.text === "require") loads.push("require");
  }
  for (const importType of descendants(source, ts.isImportTypeNode)) {
    const argument = importType.argument;
    if (
      ts.isLiteralTypeNode(argument) &&
      ts.isStringLiteral(argument.literal) &&
      resolvesToParseOwner(path, argument.literal.text)
    ) loads.push("import-type");
  }
  return loads;
}

function nonCanonicalParseOwnerImports(
  path: string,
  source = parse(path),
): string[] {
  return nonCanonicalCandidateImports(
    path,
    PARSE_OWNER.module,
    PARSE_OWNER.file,
    source,
  );
}

function resolvesToCandidate(
  importerPath: string,
  specifier: string,
  moduleName: string,
  file: string,
): boolean {
  const unresolved = specifier === moduleName
    ? file
    : specifier.startsWith("@/")
      ? join("src", specifier.slice(2))
      : specifier.startsWith(".")
        ? join(dirname(importerPath), specifier)
        : "";
  const withoutExtension = (value: string) => value.replace(/\.(?:ts|tsx)$/, "");
  return withoutExtension(unresolved) === withoutExtension(file);
}

function nonCanonicalCandidateImports(
  path: string,
  moduleName: string,
  file: string,
  source = parse(path),
): string[] {
  return source.statements.flatMap((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !resolvesToCandidate(path, statement.moduleSpecifier.text, moduleName, file) ||
      statement.moduleSpecifier.text === moduleName
    ) return [];
    return [statement.moduleSpecifier.text];
  });
}

function candidateLoadKinds(
  path: string,
  moduleName: string,
  file: string,
  source = parse(path),
): string[] {
  const loads: string[] = [];
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      resolvesToCandidate(path, statement.moduleSpecifier.text, moduleName, file)
    ) loads.push("import");
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      resolvesToCandidate(path, statement.moduleSpecifier.text, moduleName, file)
    ) loads.push("re-export");
  }
  for (const call of descendants(source, ts.isCallExpression)) {
    const specifier = call.arguments[0];
    if (
      !specifier ||
      !ts.isStringLiteralLike(specifier) ||
      !resolvesToCandidate(path, specifier.text, moduleName, file)
    ) continue;
    const callee = unwrap(call.expression);
    if (callee.kind === ts.SyntaxKind.ImportKeyword) loads.push("dynamic-import");
    if (ts.isIdentifier(callee) && callee.text === "require") loads.push("require");
  }
  for (const importType of descendants(source, ts.isImportTypeNode)) {
    const argument = importType.argument;
    if (
      ts.isLiteralTypeNode(argument) &&
      ts.isStringLiteral(argument.literal) &&
      resolvesToCandidate(path, argument.literal.text, moduleName, file)
    ) loads.push("import-type");
  }
  return loads;
}

function unsafeHookAncestorLabels(call: ts.CallExpression, boundary: ts.Node): string[] {
  const labels: string[] = [];
  let current: ts.Node | undefined = call.parent;
  while (current && current !== boundary) {
    if (ts.isFunctionLike(current)) labels.push("nested-function");
    else if (ts.isConditionalExpression(current)) labels.push("conditional");
    else if (ts.isIfStatement(current)) labels.push("if");
    else if (ts.isSwitchStatement(current)) labels.push("switch");
    else if (
      ts.isForStatement(current) || ts.isForInStatement(current) ||
      ts.isForOfStatement(current) || ts.isWhileStatement(current) ||
      ts.isDoStatement(current)
    ) labels.push("loop");
    else if (
      ts.isBinaryExpression(current) && [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(current.operatorToken.kind)
    ) labels.push("logical");
    current = current.parent;
  }
  if (current !== boundary) labels.push("outside-hook");
  return labels;
}

function activeOwnerBorrowerFiles(members: readonly string[]): string[] {
  return productionSourceFiles
    .filter((path) => path !== ACTIVE_PARSE_OWNER.file && path !== VIEWER_COMMANDS_FILE)
    // The oracle is deliberately deep; do not run it over unrelated route/service files. Every
    // supported provenance begins at an exact owner import, while the corpus-wide inactive gate
    // below still audits every production/test/helper source for stale imports and escapes.
    .filter((path) => importsModule(parse(path), ACTIVE_PARSE_OWNER.module))
    .filter((path) => members.some((member) => provenBorrowerMembers(path).has(member)));
}

function functionDefinitions(name: string): Array<{ path: string; node: ts.FunctionDeclaration }> {
  return productionSourceFiles.flatMap((path) =>
    descendants(
      parse(path),
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === name,
    ).map((node) => ({ path, node })),
  );
}

function callLabels(root: ts.Node, source: ts.SourceFile): string[] {
  return descendants(root, ts.isCallExpression).map((call) => compact(call.expression, source));
}

function restoreStores(): void {
  useSessionStore.setState(useSessionStore.getInitialState(), true);
  useUiStore.setState(useUiStore.getInitialState(), true);
  useViewerCoreStore.setState(useViewerCoreStore.getInitialState(), true);
  useToolStore.setState(useToolStore.getInitialState(), true);
  useParseFlowStore.setState(useParseFlowStore.getInitialState(), true);
  useViewerStore.setState(useViewerStore.getInitialState(), true);
}

beforeEach(restoreStores);

describe("P2.4 phase-aware parse owner and compatibility surfaces", () => {
  const activeSource = parse(ACTIVE_PARSE_OWNER.file);
  const activeInterfaceKeys = interfaceKeys(findInterface(activeSource, ACTIVE_PARSE_OWNER.interfaceName));
  const activeObjectKeys = directObjectKeys(findStoreObject(activeSource, ACTIVE_PARSE_OWNER.storeName));

  it("pins the phase-owned legacy 34/40 subset plus the additive A2 owner surface", () => {
    expect(PARSE_DATA_KEYS).toHaveLength(34);
    expect(PARSE_LEAF_ACTION_KEYS).toHaveLength(40);
    expect(PARSE_TEST_STATE_KEYS).toEqual([
      ...PARSE_DATA_KEYS.slice(0, 30),
      "guidedParseOwner",
      ...PARSE_DATA_KEYS.slice(30),
    ]);
    expect(PARSE_TEST_ACTION_KEYS).toEqual(PARSE_LEAF_ACTION_KEYS);
    expectOwnerLedgerDefinition(ACTIVE_PARSE_OWNER, "exact-ledger");

    if (OWNERSHIP.inactiveDefinition === "module-absent") {
      expect(existsRelative(INACTIVE_PARSE_OWNER.file)).toBe(false);
      expect(RUNTIME_OWNER_STATE_READERS[INACTIVE_PARSE_OWNER.module]).toBeUndefined();
    } else {
      expect(existsRelative(INACTIVE_PARSE_OWNER.file)).toBe(true);
      expectOwnerLedgerDefinition(INACTIVE_PARSE_OWNER, OWNERSHIP.inactiveDefinition);
    }

    if (existsRelative(PARSE_OWNER.file)) {
      const candidateDefinitions = ownerDefinitionKeys(PARSE_OWNER);
      const candidateRuntime = RUNTIME_OWNER_STATE_READERS[PARSE_OWNER.module]!();
      expect(candidateDefinitions.interfaceKeys.includes("resetProjectParseState")).toBe(true);
      expect(candidateDefinitions.objectKeys.includes("resetProjectParseState")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(candidateRuntime, "resetProjectParseState"))
        .toBe(true);
      for (const member of [
        ...GUIDED_PARSE_OWNER_STATE_KEYS,
        ...PARSE_OPERATION_STATE_KEYS,
        ...PARSE_OPERATION_ACTION_KEYS,
      ]) {
        expect(candidateDefinitions.interfaceKeys.includes(member), `${member} interface ownership`)
          .toBe(true);
        expect(candidateDefinitions.objectKeys.includes(member), `${member} implementation ownership`)
          .toBe(true);
        expect(Object.prototype.hasOwnProperty.call(candidateRuntime, member), `${member} runtime ownership`)
          .toBe(true);
      }
    }
    const viewerDefinitions = ownerDefinitionKeys(VIEWER_OWNER);
    expect(viewerDefinitions.interfaceKeys.includes("resetProjectParseState")).toBe(false);
    expect(viewerDefinitions.objectKeys.includes("resetProjectParseState")).toBe(false);
  });

  it("keeps the sole parse owner dependency-free and self-calibrates load detection", () => {
    const source = parse(PARSE_OWNER.file);
    const imports = source.statements
      .filter(ts.isImportDeclaration)
      .map((statement) => ({
        module: (statement.moduleSpecifier as ts.StringLiteral).text,
        typeOnly: !!statement.importClause?.isTypeOnly,
      }))
      .sort((left, right) => left.module.localeCompare(right.module));
    expect(imports).toEqual([
      { module: "@/lib/parse-operation-state", typeOnly: false },
      { module: "@/lib/parse-tool-authority", typeOnly: false },
      { module: "@/types", typeOnly: true },
      { module: "zustand", typeOnly: false },
      { module: "zustand/react/shallow", typeOnly: false },
    ]);
    const dynamicLoads = descendants(source, ts.isCallExpression).filter((call) => {
      const callee = unwrap(call.expression);
      return callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require");
    });
    expect(dynamicLoads).toEqual([]);
    const loadFixturePath = "src/components/parse-owner-load-fixture.ts";
    const loadFixture = ts.createSourceFile(
      loadFixturePath,
      `
        import { useParseFlowStore } from "@/stores/parseFlowStore";
        import { useParseFlowStore as relativeStore } from "../stores/parseFlowStore";
        export { ParseFlowState } from "@/stores/parseFlowStore";
        const lazy = import("@/stores/parseFlowStore");
        const commonJs = require("../stores/parseFlowStore");
        type InlineState = import("@/stores/parseFlowStore").ParseFlowState;
      `,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(parseOwnerLoadKinds(loadFixturePath, loadFixture)).toEqual([
      "import",
      "import",
      "re-export",
      "dynamic-import",
      "require",
      "import-type",
    ]);
    expect(productionSourceFiles.some((path) => parseOwnerLoadKinds(path).length > 0)).toBe(true);
  }, 30_000);

  // This proof resolves four definitions across the full production tree. Keep its timeout local
  // so concurrent source-exact gates do not turn a correct ownership result into a timing failure.
  it("keeps the four step writers out of the leaf and defined only by the neutral command module", () => {
    for (const command of NEUTRAL_STEP_COMMANDS) {
      expect(PARSE_LEAF_ACTION_KEYS).not.toContain(command);
      expect(activeInterfaceKeys, `${command} absent from active interface`).not.toContain(command);
      expect(activeObjectKeys, `${command} absent from active defaults`).not.toContain(command);

      const definitions = functionDefinitions(command);
      expect(definitions.map(({ path }) => path), `${command} provenance`).toEqual([
        VIEWER_COMMANDS_FILE,
      ]);
      const source = parse(VIEWER_COMMANDS_FILE);
      expect(callLabels(definitions[0].node, source)).toEqual([
        "useParseFlowStore.getState",
        "prepareParseEntry",
        "useParseFlowStore.setState",
        "operationBoundaryPatch",
      ]);
    }
  }, 60_000);
});

describe("P2.4 phase-aware grouped parse hook contract", () => {
  it("pins useTableParse's exact 17-member shape and phase-exact caller roster", () => {
    expect(hookShape("useTableParse", TABLE_HOOK_SHAPE)).toEqual(TABLE_HOOK_SHAPE);
    expect(exportedVariableCount(parse(ACTIVE_PARSE_OWNER.file), "useTableParse")).toBe(1);
    if (OWNERSHIP.inactiveDefinition === "exact-ledger") {
      expect(hookShape("useTableParse", TABLE_HOOK_SHAPE, INACTIVE_PARSE_OWNER))
        .toEqual(TABLE_HOOK_SHAPE);
      expect(exportedVariableCount(parse(INACTIVE_PARSE_OWNER.file), "useTableParse")).toBe(1);
    } else if (existsRelative(INACTIVE_PARSE_OWNER.file)) {
      expect(exportedVariableCount(parse(INACTIVE_PARSE_OWNER.file), "useTableParse")).toBe(0);
    }
    expect(importedCallTopology("useTableParse", ACTIVE_PARSE_OWNER)).toEqual(
      PARSE_FACADE_PHASE === "FACADE"
        ? TABLE_HOOK_CALLERS
        : POST_TABLE_FACADE_HOOK_CALLERS,
    );
    expect(importedCallTopology("useTableParse", INACTIVE_PARSE_OWNER)).toEqual({});
  }, 30_000);

  it("pins useKeynoteParse's exact 21-member shape and two calls", () => {
    expect(hookShape("useKeynoteParse", KEYNOTE_HOOK_SHAPE)).toEqual(KEYNOTE_HOOK_SHAPE);
    expect(exportedVariableCount(parse(ACTIVE_PARSE_OWNER.file), "useKeynoteParse")).toBe(1);
    if (OWNERSHIP.inactiveDefinition === "exact-ledger") {
      expect(hookShape("useKeynoteParse", KEYNOTE_HOOK_SHAPE, INACTIVE_PARSE_OWNER))
        .toEqual(KEYNOTE_HOOK_SHAPE);
      expect(exportedVariableCount(parse(INACTIVE_PARSE_OWNER.file), "useKeynoteParse")).toBe(1);
    } else if (existsRelative(INACTIVE_PARSE_OWNER.file)) {
      expect(exportedVariableCount(parse(INACTIVE_PARSE_OWNER.file), "useKeynoteParse")).toBe(0);
    }
    expect(importedCallTopology("useKeynoteParse", ACTIVE_PARSE_OWNER)).toEqual(KEYNOTE_HOOK_CALLERS);
    expect(importedCallTopology("useKeynoteParse", INACTIVE_PARSE_OWNER)).toEqual({});
  }, 30_000);

  it("pins the 13-member Table extension hook and exact cold caller roster", () => {
    expect(hookShape("useTableParseExtensions", TABLE_EXTENSION_HOOK_SHAPE))
      .toEqual(TABLE_EXTENSION_HOOK_SHAPE);
    expect(exportedVariableCount(parse(ACTIVE_PARSE_OWNER.file), "useTableParseExtensions"))
      .toBe(1);
    expect(importedCallTopology("useTableParseExtensions", ACTIVE_PARSE_OWNER))
      .toEqual(TABLE_EXTENSION_HOOK_CALLERS);
    expect(importedCallTopology("useTableParseExtensions", INACTIVE_PARSE_OWNER)).toEqual({});
    expect(productionHookBindingCallers(
      ACTIVE_PARSE_OWNER.module,
      "useTableParseExtensions",
    )).toEqual(TABLE_EXTENSION_HOOK_BINDINGS);

    const namespaceLoads = productionSourceFiles.filter((path) =>
      parse(path).statements.some((statement) =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        resolvesToParseOwner(path, statement.moduleSpecifier.text) &&
        !!statement.importClause?.namedBindings &&
        ts.isNamespaceImport(statement.importClause.namedBindings)
      )
    );
    expect(namespaceLoads, "parse hooks cannot hide behind namespace imports").toEqual([]);
    const nonStaticLoads = productionSourceFiles
      .filter((path) => path !== ACTIVE_PARSE_OWNER.file)
      .flatMap((path) => parseOwnerLoadKinds(path)
        .filter((kind) => kind !== "import")
        .map((kind) => ({ path, kind })));
    expect(nonStaticLoads, "parse hooks cannot hide behind non-static loads").toEqual([]);

    // The binding/caller ledgers above intentionally key off the canonical alias. Reject every
    // other specifier that resolves to the same store so a relative or extension-qualified import
    // cannot stay runtime-valid while disappearing from those exact ledgers.
    const nonCanonicalImports = productionSourceFiles.flatMap((path) =>
      nonCanonicalParseOwnerImports(path).map((specifier) => ({ path, specifier }))
    );
    expect(nonCanonicalImports, "parse hooks must use the canonical store import").toEqual([]);

    const fixturePath = "src/components/viewer/parse-owner-import-fixture.ts";
    const fixture = ts.createSourceFile(
      fixturePath,
      `
        import { useParseFlowStore } from "@/stores/parseFlowStore";
        import { useTableParseExtensions } from "../../stores/parseFlowStore";
        import { useTableParse } from "@/stores/./parseFlowStore";
        import { useKeynoteParse } from "@/stores/../stores/parseFlowStore";
      `,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(nonCanonicalParseOwnerImports(fixturePath, fixture)).toEqual([
      "../../stores/parseFlowStore",
      "@/stores/./parseFlowStore",
      "@/stores/../stores/parseFlowStore",
    ]);

    const guardedHooks = [
      { module: PARSE_OWNER.module, name: "useTableParse" },
      { module: PARSE_OWNER.module, name: "useKeynoteParse" },
      { module: PARSE_OWNER.module, name: "useTableParseExtensions" },
      { module: PARSE_OWNER.module, name: "useKeynoteParseExtensions" },
      { module: PARSE_OWNER.module, name: "useGuidedParseExtensions" },
      { module: PARSE_OWNER.module, name: "useNotesParseExtensions" },
      { module: PARSE_OWNER.module, name: "useParseDraftExtensions" },
      { module: PARSE_OWNER.module, name: "useParagraphWorkspaceExtensions" },
      { module: PARSE_FACADE_MODULE, name: "useParseFlow" },
    ] as const;
    const unsupportedReferences = productionSourceFiles.flatMap((path) => {
      const source = parse(path);
      return guardedHooks.flatMap(({ module, name }) =>
        unsupportedImportedCallableReferences(source, [module], name)
          .map((reference) => ({ path, hook: name, reference }))
      );
    });
    expect(unsupportedReferences, "parse hooks use only direct, proven invocations").toEqual([]);

    const invocationFixture = ts.createSourceFile(
      "src/components/viewer/parse-hook-invocation-fixture.tsx",
      `
        import { useParseFlow } from "@/hooks/useParseFlow";
        import {
          useKeynoteParse,
          useTableParse,
          useTableParseExtensions,
        } from "@/stores/parseFlowStore";
        declare function consume(value: unknown): void;
        const directAlias = useParseFlow;
        directAlias("table");
        useTableParse.call(null);
        useTableParseExtensions["apply"](null, []);
        const bound = useParseFlow.bind(null, "table");
        consume(useParseFlow);
        const bag = { useTableParse };
        useKeynoteParse?.();
      `,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    expect(guardedHooks.flatMap(({ module, name }) =>
      unsupportedImportedCallableReferences(invocationFixture, [module], name)
    )).toEqual([
      "useTableParse:PropertyAccessExpression",
      "useTableParse:ShorthandPropertyAssignment",
      "useKeynoteParse:CallExpression",
      "useTableParseExtensions:ElementAccessExpression",
      "useParseFlow:PropertyAccessExpression",
      "useParseFlow:CallExpression",
    ]);
  }, 60_000);

  it("pins Keynote-only and shared-guided extensions without changing sacred callers", () => {
    expect(hookShape("useKeynoteParseExtensions", KEYNOTE_EXTENSION_HOOK_SHAPE))
      .toEqual(KEYNOTE_EXTENSION_HOOK_SHAPE);
    expect(hookShape("useGuidedParseExtensions", GUIDED_PARSE_EXTENSION_HOOK_SHAPE))
      .toEqual(GUIDED_PARSE_EXTENSION_HOOK_SHAPE);
    expect(exportedVariableCount(parse(ACTIVE_PARSE_OWNER.file), "useKeynoteParseExtensions"))
      .toBe(1);
    expect(exportedVariableCount(parse(ACTIVE_PARSE_OWNER.file), "useGuidedParseExtensions"))
      .toBe(1);
    expect(importedCallTopology("useKeynoteParseExtensions", ACTIVE_PARSE_OWNER))
      .toEqual(KEYNOTE_EXTENSION_HOOK_CALLERS);
    expect(importedCallTopology("useGuidedParseExtensions", ACTIVE_PARSE_OWNER))
      .toEqual(GUIDED_PARSE_EXTENSION_HOOK_CALLERS);
    expect(importedCallTopology("useKeynoteParseExtensions", INACTIVE_PARSE_OWNER)).toEqual({});
    expect(importedCallTopology("useGuidedParseExtensions", INACTIVE_PARSE_OWNER)).toEqual({});
    expect(productionHookBindingCallers(
      ACTIVE_PARSE_OWNER.module,
      "useKeynoteParseExtensions",
    )).toEqual(KEYNOTE_EXTENSION_HOOK_BINDINGS);
    expect(productionHookBindingCallers(
      ACTIVE_PARSE_OWNER.module,
      "useGuidedParseExtensions",
    )).toEqual(GUIDED_PARSE_EXTENSION_HOOK_BINDINGS);

    const keynoteSource = parse(KEYNOTE_PANEL);
    const capturedTargetBindings = (source: ts.SourceFile) => {
      const declaration = findVariable(source, "captureKeynoteTarget");
      expect(declaration.initializer && ts.isCallExpression(declaration.initializer),
        "captureKeynoteTarget useCallback").toBe(true);
      const callback = (declaration.initializer as ts.CallExpression).arguments[0];
      expect(callback && ts.isArrowFunction(callback), "capture target callback").toBe(true);
      const body = (callback as ts.ArrowFunction).body;
      expect(ts.isExpression(body), "capture target expression body").toBe(true);
      const object = unwrap(body as ts.Expression);
      expect(ts.isObjectLiteralExpression(object), "capture target object").toBe(true);
      return Object.fromEntries((object as ts.ObjectLiteralExpression).properties.flatMap((property) => {
        if (ts.isShorthandPropertyAssignment(property)) {
          return [[property.name.text, property.name.text]];
        }
        if (!ts.isPropertyAssignment(property)) return [];
        const name = staticName(property.name);
        return name ? [[name, compact(property.initializer, source)]] : [];
      }));
    };
    const expectedBoundaryBindings = {
      publicId: "publicId",
      isDemo: "isDemo",
      pageNumber: "pageNumber",
      bbox: "bbox?[...bbox]asKeynoteBbox:[0,0,1,1]",
      columnBBs: "keynoteColumnBBs.map((entry)=>[...entry]asKeynoteBbox)",
      rowBBs: "keynoteRowBBs.map((entry)=>[...entry]asKeynoteBbox)",
    };
    expect(capturedTargetBindings(keynoteSource)).toEqual(expectedBoundaryBindings);

    const swappedAliasFixture = ts.createSourceFile(
      "keynote-live-boundary-swap-fixture.ts",
      `
        const captureKeynoteTarget = useCallback(() => ({
          publicId,
          isDemo,
          pageNumber,
          bbox: [0, 0, 1, 1],
          columnBBs: keynoteRowBBs.map((entry) => [...entry]),
          rowBBs: keynoteColumnBBs.map((entry) => [...entry]),
        }), []);
      `,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(capturedTargetBindings(swappedAliasFixture)).toMatchObject({
      columnBBs: "keynoteRowBBs.map((entry)=>[...entry])",
      rowBBs: "keynoteColumnBBs.map((entry)=>[...entry])",
    });
    expect(capturedTargetBindings(swappedAliasFixture)).not.toEqual(expectedBoundaryBindings);

    // Proposal region and retained-row data remain invocation-live. Save boundaries are now copied
    // synchronously by captureKeynoteTarget before A crosses its first await.
    expect(knownMembers(expectFailClosedOwnerScan(keynoteSource), "getState")).toEqual([
      "keynoteParseRegion",
      "keynoteParseRegion",
      "parsedKeynoteData",
      "setParsedKeynoteData",
    ]);
  }, 60_000);

  it("pins minimal Notes, draft, and paragraph extension surfaces", () => {
    const contracts = [
      {
        hook: "useNotesParseExtensions",
        shape: NOTES_EXTENSION_HOOK_SHAPE,
        callers: NOTES_EXTENSION_HOOK_CALLERS,
        bindings: NOTES_EXTENSION_HOOK_BINDINGS,
      },
      {
        hook: "useParseDraftExtensions",
        shape: PARSE_DRAFT_EXTENSION_HOOK_SHAPE,
        callers: PARSE_DRAFT_EXTENSION_HOOK_CALLERS,
        bindings: PARSE_DRAFT_EXTENSION_HOOK_BINDINGS,
      },
      {
        hook: "useParagraphWorkspaceExtensions",
        shape: PARAGRAPH_WORKSPACE_EXTENSION_HOOK_SHAPE,
        callers: PARAGRAPH_WORKSPACE_EXTENSION_HOOK_CALLERS,
        bindings: PARAGRAPH_WORKSPACE_EXTENSION_HOOK_BINDINGS,
      },
    ] as const;
    for (const { hook, shape, callers, bindings } of contracts) {
      expect(hookShape(hook, shape), `${hook} exact projection`).toEqual(shape);
      expect(exportedVariableCount(parse(ACTIVE_PARSE_OWNER.file), hook), `${hook} export`)
        .toBe(1);
      expect(importedCallTopology(hook, ACTIVE_PARSE_OWNER), `${hook} callers`)
        .toEqual(callers);
      expect(importedCallTopology(hook, INACTIVE_PARSE_OWNER), `${hook} inactive calls`)
        .toEqual({});
      expect(productionHookBindingCallers(ACTIVE_PARSE_OWNER.module, hook), `${hook} bindings`)
        .toEqual(bindings);
    }

    const notesSource = parse(NOTES_PARSER);
    expect(knownMembers(expectFailClosedOwnerScan(notesSource), "getState")).toEqual([
      "setParseDraftRegion",
      "setParseDraftRegion",
      "guidedParseRows",
      "guidedParseCols",
      "setParseDraftRegion",
    ]);

    const objectProperty = (
      object: ts.ObjectLiteralExpression,
      name: string,
    ): ts.PropertyAssignment => {
      const properties = object.properties.filter((property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) && staticName(property.name) === name
      );
      expect(properties, `${name} object mapping`).toHaveLength(1);
      return properties[0];
    };
    const objectMember = (object: ts.ObjectLiteralExpression, name: string): string =>
      compact(objectProperty(object, name).initializer, notesSource);
    const returnedObject = (root: ts.Node): ts.ObjectLiteralExpression => {
      const objects = descendants(root, ts.isReturnStatement).flatMap((statement) => {
        const expression = statement.expression && unwrap(statement.expression);
        return expression && ts.isObjectLiteralExpression(expression) ? [expression] : [];
      });
      expect(objects, "one returned grid object").toHaveLength(1);
      return objects[0];
    };
    const terminalActionCalls = (root: ts.Node, names: readonly string[]): string[] =>
      descendants(root, ts.isCallExpression).filter((call) => {
        const expression = unwrap(call.expression);
        return ts.isPropertyAccessExpression(expression) && names.includes(expression.name.text);
      }).map((call) => compact(call, notesSource));

    const guidedBuilder = findVariable(notesSource, "buildGridFromGuided").initializer!;
    expect(compact(findVariableWithin(guidedBuilder, "store").initializer!, notesSource))
      .toBe("useParseFlowStore.getState()");
    expect(compact(findVariableWithin(guidedBuilder, "rows").initializer!, notesSource))
      .toBe("store.guidedParseRows");
    expect(compact(findVariableWithin(guidedBuilder, "cols").initializer!, notesSource))
      .toBe("store.guidedParseCols");
    const guidedExtraction = descendants(guidedBuilder, ts.isCallExpression).filter((call) =>
      compact(call.expression, notesSource) === "extractCellsFromGrid"
    );
    expect(guidedExtraction.map((call) => compact(call, notesSource))).toEqual([
      "extractCellsFromGrid(textractData.words,rows,cols)",
    ]);
    const guidedReturn = returnedObject(guidedBuilder);
    expect({
      rowBoundaries: objectMember(guidedReturn, "rowBoundaries"),
      colBoundaries: objectMember(guidedReturn, "colBoundaries"),
    }).toEqual({ rowBoundaries: "rows", colBoundaries: "cols" });

    const manualBuilder = findVariable(notesSource, "buildGridFromManualBBs").initializer!;
    expect(compact(findVariableWithin(manualBuilder, "columns").initializer!, notesSource))
      .toBe("guidedNotesCols");
    expect(compact(findVariableWithin(manualBuilder, "rowBbs").initializer!, notesSource))
      .toBe("guidedNotesRows");
    expect(compact(findVariableWithin(manualBuilder, "xs").initializer!, notesSource)).toBe(
      "[...columns.map((c)=>c[0]),columns[columns.length-1][2]]",
    );
    expect(compact(findVariableWithin(manualBuilder, "ys").initializer!, notesSource)).toBe(
      "[...rowBbs.map((r)=>r[1]),rowBbs[rowBbs.length-1][3]]",
    );
    const manualReturn = returnedObject(manualBuilder);
    expect({
      colBoundaries: objectMember(manualReturn, "colBoundaries"),
      rowBoundaries: objectMember(manualReturn, "rowBoundaries"),
    }).toEqual({ colBoundaries: "xs", rowBoundaries: "ys" });

    const notesText = compact(notesSource, notesSource);
    const commandCalls = (name: string): string[] => importedCalls(
      notesSource,
      ["@/stores/viewerCommands"],
      name,
    ).map((call) => compact(call, notesSource));
    expect(notesText).toContain("rowBoundaries:grid.rowBoundaries");
    expect(notesText).toContain("colBoundaries:grid.colBoundaries");
    expect(notesText).toContain("rowBoundaries:input.rowBoundaries");
    expect(notesText).toContain("colBoundaries:input.colBoundaries");
    expect(compact(findVariable(notesSource, "cleanupLeaseRef").initializer!, notesSource))
      .toBe("useRef<ParseWorkspaceLease|null>(null)");
    expect(commandCalls("invalidateParseOperationForWorkspace"))
      .toEqual([]);
    expect(commandCalls("leaveNotesParserWorkspace"))
      .toEqual(["leaveNotesParserWorkspace(cleanupLeaseRef.current,false)"]);
    expect(commandCalls("transitionNotesParserMode"))
      .toEqual(["transitionNotesParserMode(nextMode,notesParseRegion)"]);
    expect(commandCalls("captureParseWorkspaceLease")).toEqual([]);
    expect(commandCalls("syncNotesParserModeForLease")).toEqual([]);
    expect(commandCalls("activateNotesGuidedWorkspace")).toEqual([]);
    expect(commandCalls("syncNotesFastManualWorkspace")).toEqual([]);
    expect(commandCalls("syncParagraphWorkspaceActive")).toEqual([]);
    expect(notesText).not.toContain("workspaceRevisions");
    expect(notesText).not.toContain("modeSyncLease");
    expect(notesText).not.toContain("operations.notes.busy||operations.spec.busy");
    expect(notesText).toContain("if(cleanupLeaseRef.current){leaveNotesParserWorkspace(");
    expect(notesText).toContain(
      "claimGuidedParseWorkspaceForOperation(token,target.region)",
    );
    expect(notesText).toContain(
      "publishGuidedProposalForOperation(token,[...payload.proposedRows],[...payload.proposedCols],)",
    );
    expect(notesText).not.toContain("setGuidedParseRows(");
    expect(notesText).not.toContain("setGuidedParseCols(");
    expect(notesText).toContain("resetNotesParseWorkspace(\"idle\"");
    expect(notesText).toContain("resetNotesParseWorkspace(\"select-region\"");

    const classifierSource = parse("src/components/viewer/NotesClassifier.tsx");
    const classifierEdit = compact(findVariable(classifierSource, "handleEdit").initializer!, classifierSource);
    expect(classifierEdit).toContain("acceptNotesParseRegion([l,t,l+w,t+h])");
    expect(classifierEdit.indexOf("acceptNotesParseRegion"))
      .toBeLessThan(classifierEdit.indexOf("onEditInParser"));

    const indexSource = parse("src/components/viewer/NotesIndex.tsx");
    const rowClick = compact(findVariable(indexSource, "handleRowClick").initializer!, indexSource);
    expect(rowClick).toContain("openNotesParseTarget(r.pageNum,[l,t,l+w,t+h])");
    expect(rowClick).toContain("openNotesParseTarget(r.pageNum,null)");
    expect(rowClick).not.toContain("setPage(");
    expect(rowClick).not.toContain("acceptNotesParseRegion(");
    expect(rowClick).not.toContain("resetNotesParseWorkspace(");
    expect(rowClick.indexOf("openNotesParseTarget"))
      .toBeLessThan(rowClick.indexOf("onOpenParser"));
  }, 60_000);

  it("pins the final Spec callers, handoffs, and reset/tool ordering", () => {
    const specSource = parse(SPEC_PARSER);
    expect(knownMembers(expectFailClosedOwnerScan(specSource), "getState")).toEqual([
      "setParseDraftRegion",
      "setParseDraftRegion",
    ]);

    const specText = compact(specSource, specSource);
    const commandCalls = (name: string): string[] => importedCalls(
      specSource,
      ["@/stores/viewerCommands"],
      name,
    ).map((call) => compact(call, specSource));
    expect(compact(findVariable(specSource, "cleanupLeaseRef").initializer!, specSource))
      .toBe("useRef<ParseWorkspaceLease|null>(null)");
    expect(commandCalls("invalidateParseOperationForWorkspace"))
      .toEqual([]);
    expect(commandCalls("leaveSpecParserWorkspace"))
      .toEqual(["leaveSpecParserWorkspace(cleanupLeaseRef.current)"]);
    expect(commandCalls("transitionSpecParserMode"))
      .toEqual(["transitionSpecParserMode(nextMode,specParseRegion)"]);
    expect(commandCalls("captureParseWorkspaceLease")).toEqual([]);
    expect(commandCalls("syncSpecParserModeForLease")).toEqual([]);
    expect(specText).not.toContain("workspaceRevisions");
    expect(specText).not.toContain("modeSyncLease");
    expect(specText).not.toContain("operations.notes.busy||operations.spec.busy");
    expect(specText).toContain("if(cleanupLeaseRef.current){leaveSpecParserWorkspace(");
    expect(specText).toContain("awaitpersistPreview(payload,target.region,token,target)");
    expect(specText).toContain("invalidateParagraphParseOperationsForOperation(token)");
    expect(specText).toContain("completeSpecParseOperation(token)");
    expect(specText).toContain('resetSpecParseWorkspace("select-region")');
    expect(specText).not.toContain("isSavingRef");

    const sectionFieldMappings = (root: ts.Node, source = specSource) => {
      const fields = descendants(root, ts.isPropertyAssignment).filter((property) =>
        ["sectionHeader", "body"].includes(staticName(property.name) ?? "")
      );
      return Object.fromEntries(fields.map((property) => [
        staticName(property.name)!,
        compact(property.initializer, source),
      ]));
    };
    expect(sectionFieldMappings(findVariable(specSource, "saveFromBatch").initializer!))
      .toEqual({
        sectionHeader: 'p.rowText.sectionHeader??""',
        body: 'p.rowText.body??""',
      });
    expect(specText).toContain("sections:input.sections");

    const classifierSource = parse("src/components/viewer/SpecClassifier.tsx");
    const classifierEdit = compact(findVariable(classifierSource, "handleEdit").initializer!, classifierSource);
    expect(classifierEdit).toContain("acceptSpecParseRegion([l,t,l+w,t+h])");
    expect(classifierEdit.indexOf("acceptSpecParseRegion"))
      .toBeLessThan(classifierEdit.indexOf("onEditInParser"));

    const indexSource = parse("src/components/viewer/SpecIndex.tsx");
    const rowClick = compact(findVariable(indexSource, "handleRowClick").initializer!, indexSource);
    expect(rowClick).toContain("openSpecParseTarget(r.pageNum,[l,t,l+w,t+h])");
    expect(rowClick).toContain("openSpecParseTarget(r.pageNum,null)");
    expect(rowClick).not.toContain("setPage(");
    expect(rowClick).not.toContain("acceptSpecParseRegion(");
    expect(rowClick).not.toContain("resetSpecParseWorkspace(");
    expect(rowClick.indexOf("openSpecParseTarget"))
      .toBeLessThan(rowClick.indexOf("onOpenParser"));
  }, 60_000);
});

describe("P2.4 A1 semantic parse facade topology", () => {
  it("pins four exhaustive direct lifecycle adapters and a fail-closed owner scan", () => {
    const source = parse(PARSE_FACADE_FILE);
    const declaration = findVariable(source, "PARSE_FLOW_ADAPTERS");
    expect(compact(declaration.type!, source)).toBe("ParseFlowAdapterMap");
    const initializer = declaration.initializer && unwrap(declaration.initializer);
    expect(initializer && ts.isObjectLiteralExpression(initializer), "adapter registry object")
      .toBe(true);

    const adapters = Object.fromEntries(
      (initializer as ts.ObjectLiteralExpression).properties.map((property) => {
        expect(ts.isPropertyAssignment(property), "plain adapter property").toBe(true);
        const assignment = property as ts.PropertyAssignment;
        const kind = staticName(assignment.name);
        const selector = unwrap(assignment.initializer);
        expect(kind, "static adapter kind").not.toBeNull();
        expect(ts.isArrowFunction(selector), `${kind} adapter arrow`).toBe(true);
        const body = unwrap((selector as ts.ArrowFunction).body as ts.Expression);
        expect(ts.isObjectLiteralExpression(body), `${kind} lifecycle object`).toBe(true);
        return [kind!, Object.fromEntries((body as ts.ObjectLiteralExpression).properties.map(
          (entry) => {
            expect(ts.isPropertyAssignment(entry), `${kind} direct lifecycle property`).toBe(true);
            const lifecycleEntry = entry as ts.PropertyAssignment;
            return [staticName(lifecycleEntry.name), compact(lifecycleEntry.initializer, source)];
          },
        ))];
      }),
    );
    expect(adapters).toEqual({
      table: {
        kind: '"table"',
        step: "state.tableParseStep",
        region: "state.tableParseRegion",
        setStep: "setTableParseStep",
        setRegion: "state.setTableParseRegion",
        reset: "state.resetTableParse",
      },
      keynote: {
        kind: '"keynote"',
        step: "state.keynoteParseStep",
        region: "state.keynoteParseRegion",
        setStep: "setKeynoteParseStep",
        setRegion: "state.setKeynoteParseRegion",
        reset: "state.resetKeynoteParse",
      },
      notes: {
        kind: '"notes"',
        step: "state.notesParseStep",
        region: "state.notesParseRegion",
        setStep: "setNotesParseStep",
        setRegion: "state.setNotesParseRegion",
        reset: "state.resetNotesParse",
      },
      spec: {
        kind: '"spec"',
        step: "state.specParseStep",
        region: "state.specParseRegion",
        setStep: "setSpecParseStep",
        setRegion: "state.setSpecParseRegion",
        reset: "state.resetSpecParse",
      },
    });

    expect(knownMembers(expectFailClosedOwnerScan(source), "selector")).toEqual([
      "tableParseStep", "tableParseRegion", "setTableParseRegion", "resetTableParse",
      "keynoteParseStep", "keynoteParseRegion", "setKeynoteParseRegion", "resetKeynoteParse",
      "notesParseStep", "notesParseRegion", "setNotesParseRegion", "resetNotesParse",
      "specParseStep", "specParseRegion", "setSpecParseRegion", "resetSpecParse",
    ]);
  });

  it("uses one unconditional shallow store hook and preserves the acyclic dependency direction", () => {
    const source = parse(PARSE_FACADE_FILE);
    const storeCalls = importedCalls(
      source,
      [ACTIVE_PARSE_OWNER.module],
      ACTIVE_PARSE_OWNER.exportName,
    );
    expect(storeCalls, "one facade Zustand hook").toHaveLength(1);
    const shallow = storeCalls[0].arguments[0] && unwrap(storeCalls[0].arguments[0]);
    expect(shallow && ts.isCallExpression(shallow), "facade useShallow call").toBe(true);
    expect(compact((shallow as ts.CallExpression).expression, source)).toBe("useShallow");
    expect((shallow as ts.CallExpression).arguments).toHaveLength(1);
    expect(compact((shallow as ts.CallExpression).arguments[0], source)).toBe("selector");

    const hook = descendants(source, ts.isFunctionDeclaration).filter(
      (candidate) => candidate.name?.text === "useParseFlow",
    );
    expect(hook).toHaveLength(1);
    expect(hook[0].typeParameters).toHaveLength(1);
    expect(hook[0].typeParameters?.[0].name.text).toBe("K");
    expect(compact(hook[0].typeParameters?.[0].constraint!, source)).toBe("ParseKind");
    expect(hook[0].parameters).toHaveLength(1);
    expect((hook[0].parameters[0].name as ts.Identifier).text).toBe("kind");
    expect(compact(hook[0].parameters[0].type!, source)).toBe("K");
    expect(compact(hook[0].type!, source)).toBe("ParseFlowLifecycle<K>");
    expect(hook[0].body?.statements, "facade hook has selector then unconditional return")
      .toHaveLength(2);
    expect(ts.isVariableStatement(hook[0].body!.statements[0])).toBe(true);
    expect(ts.isReturnStatement(hook[0].body!.statements[1])).toBe(true);
    const hookReturn = hook[0].body!.statements[1] as ts.ReturnStatement;
    expect(hookReturn.expression && unwrap(hookReturn.expression)).toBe(storeCalls[0]);
    expect(descendants(hook[0], ts.isCallExpression).filter((call) =>
      call === storeCalls[0]
    )).toHaveLength(1);
    expect(unsafeHookAncestorLabels(storeCalls[0], hook[0])).toEqual([]);

    const selector = descendants(hook[0], ts.isVariableDeclaration).filter(
      (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "selector",
    );
    expect(selector).toHaveLength(1);
    expect(compact(selector[0].initializer!, source)).toBe(
      'kind==="table"?PARSE_FLOW_ADAPTERS.table:kind==="keynote"?PARSE_FLOW_ADAPTERS.keynote:' +
      'kind==="notes"?PARSE_FLOW_ADAPTERS.notes:PARSE_FLOW_ADAPTERS.spec',
    );

    const fixture = ts.createSourceFile(
      "parse-facade-hook-placement-fixture.ts",
      `
        function useFixture(flag: boolean) {
          if (flag) storeHook();
          flag && storeHook();
          for (let i = 0; i < 1; i += 1) storeHook();
          const nested = () => storeHook();
          return flag ? storeHook() : null;
        }
      `,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const fixtureBoundary = descendants(fixture, ts.isFunctionDeclaration)[0];
    const fixtureCalls = descendants(fixtureBoundary, ts.isCallExpression).filter((call) =>
      ts.isIdentifier(call.expression) && call.expression.text === "storeHook"
    );
    expect(fixtureCalls.map((call) => unsafeHookAncestorLabels(call, fixtureBoundary))).toEqual([
      ["if"],
      ["logical"],
      ["loop"],
      ["nested-function"],
      ["conditional"],
    ]);

    const dependencies = source.statements.filter(ts.isImportDeclaration)
      .map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text)
      .sort();
    expect(dependencies).toEqual([
      "@/lib/parse-operation-state",
      "@/stores/parseFlowStore",
      "@/stores/viewerCommands",
      "@/types",
      "zustand/react/shallow",
    ]);
    expect(importsModule(parse(PARSE_STORE_FILE), PARSE_FACADE_MODULE)).toBe(false);
    expect(importsModule(parse(VIEWER_COMMANDS_FILE), PARSE_FACADE_MODULE)).toBe(false);
  });

  it("pins the phase-exact cold caller roster with literal kinds and lifecycle destructures", () => {
    expect(productionParseFacadeCallers()).toEqual(
      EXPECTED_PARSE_FACADE_CALLERS[PARSE_FACADE_PHASE],
    );
  });

  it("pins migrated lifecycle residuals, live reads, and neutral-command removal", () => {
    const expectedCallers: ParseFacadeCallers =
      EXPECTED_PARSE_FACADE_CALLERS[PARSE_FACADE_PHASE];
    const residualLedger: Readonly<Record<string, readonly string[]>> =
      EXPECTED_MIGRATED_LIFECYCLE_RESIDUALS;
    const commandLedger: Readonly<Record<string, Readonly<Partial<Record<
      (typeof NEUTRAL_STEP_COMMANDS)[number],
      number
    >>>>> = EXPECTED_MIGRATED_NEUTRAL_COMMANDS;
    const selectorLedger: Readonly<Record<string, readonly string[]>> =
      EXPECTED_MIGRATED_DIRECT_SELECTORS;
    for (const [path, calls] of Object.entries(expectedCallers)) {
      const kinds = [...new Set(calls.map((call) => call.kind))];
      expect(kinds, `${path} one semantic kind`).toHaveLength(1);
      const source = parse(path);
      const directOwnerScan = expectFailClosedOwnerScan(source, ACTIVE_PARSE_DESCRIPTOR);
      const residuals = directOwnerScan.known
        .filter((finding) => finding.member && ALL_PARSE_LIFECYCLE_MEMBERS.has(finding.member))
        .map((finding) => `${finding.operation}:${finding.access}:${finding.member}`);
      expect(residuals, `${path} direct lifecycle residuals`).toEqual(
        residualLedger[path],
      );
      expect(knownMembers(directOwnerScan, "selector"), `${path} direct selector residuals`)
        .toEqual(selectorLedger[path]);

      const commandCounts = Object.fromEntries(NEUTRAL_STEP_COMMANDS.flatMap((command) => {
        const count = importedCalls(source, ["@/stores/viewerCommands"], command).length;
        return count > 0 ? [[command, count]] : [];
      }));
      const namespaceCalls = namespaceTerminalCalls(source, ["@/stores/viewerCommands"]);
      expect(namespaceCalls.filter(({ name }) =>
        name === null || NEUTRAL_STEP_COMMANDS.includes(
          name as (typeof NEUTRAL_STEP_COMMANDS)[number],
        )
      ), `${path} has no namespace-hidden neutral command`).toEqual([]);
      expect(commandCounts, `${path} residual neutral commands`).toEqual(
        commandLedger[path],
      );
    }

    const fixture = ts.createSourceFile(
      "parse-facade-command-provenance-fixture.ts",
      `
        import * as Commands from "@/stores/viewerCommands";
        const alias = Commands;
        declare const dynamicCommand: string;
        Commands.setTableParseStep("review");
        alias["setNotesParseStep"]("review");
        alias[dynamicCommand]("review");
      `,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(namespaceTerminalCalls(fixture, ["@/stores/viewerCommands"])
      .map(({ name }) => name)).toEqual([
      "setTableParseStep",
      "setNotesParseStep",
      null,
    ]);
  });

  it("makes neutral-command module and invocation provenance fail closed", () => {
    const candidateNamespaceImports = (path: string, source = parse(path)) =>
      source.statements.flatMap((statement) => {
        if (
          !ts.isImportDeclaration(statement) ||
          !ts.isStringLiteral(statement.moduleSpecifier) ||
          !resolvesToCandidate(
            path,
            statement.moduleSpecifier.text,
            VIEWER_COMMANDS_MODULE,
            VIEWER_COMMANDS_FILE,
          ) ||
          !statement.importClause?.namedBindings ||
          !ts.isNamespaceImport(statement.importClause.namedBindings)
        ) return [];
        return [statement.moduleSpecifier.text];
      });

    const commandConsumers = productionSourceFiles.filter(
      (path) => path !== VIEWER_COMMANDS_FILE,
    );
    expect(commandConsumers.flatMap((path) =>
      nonCanonicalCandidateImports(
        path,
        VIEWER_COMMANDS_MODULE,
        VIEWER_COMMANDS_FILE,
      ).map((specifier) => ({ path, specifier }))
    ), "viewer commands must use the canonical static import").toEqual([]);
    expect(commandConsumers.flatMap((path) =>
      candidateLoadKinds(path, VIEWER_COMMANDS_MODULE, VIEWER_COMMANDS_FILE)
        .filter((kind) => kind !== "import")
        .map((kind) => ({ path, kind }))
    ), "viewer commands cannot hide behind non-static loads").toEqual([]);
    expect(commandConsumers.flatMap((path) =>
      candidateNamespaceImports(path).map((specifier) => ({ path, specifier }))
    ), "viewer commands cannot hide behind namespace imports").toEqual([]);

    const unsupportedReferences = commandConsumers
      // The semantic facade is audited separately below because its four references are deliberate
      // value pass-throughs rather than direct calls.
      .filter((path) => path !== PARSE_FACADE_FILE)
      .flatMap((path) => {
        const source = parse(path);
        return NEUTRAL_STEP_COMMANDS.flatMap((command) =>
          unsupportedImportedCallableReferences(
            source,
            [VIEWER_COMMANDS_MODULE],
            command,
          ).map((reference) => ({ path, command, reference }))
        );
      });
    expect(unsupportedReferences, "neutral commands use only direct proven calls").toEqual([]);

    const isAdapterSetStepReference = (
      identifier: ts.Identifier,
      adapterRegistry: ts.Expression,
    ): boolean => {
      const assignment = identifier.parent;
      if (
        !ts.isPropertyAssignment(assignment) ||
        assignment.initializer !== identifier ||
        staticName(assignment.name) !== "setStep"
      ) return false;
      let current: ts.Node | undefined = assignment;
      while (current && current !== adapterRegistry) current = current.parent;
      return current === adapterRegistry;
    };

    const facadeSource = parse(PARSE_FACADE_FILE);
    const adapterRegistry = findVariable(facadeSource, "PARSE_FLOW_ADAPTERS").initializer;
    expect(adapterRegistry, "facade adapter registry initializer").toBeDefined();
    const facadeReferenceTopology = Object.fromEntries(NEUTRAL_STEP_COMMANDS.map((command) => {
      const references = importedCallableReferences(
        facadeSource,
        [VIEWER_COMMANDS_MODULE],
        command,
      );
      expect(references, `${command} has one facade reference`).toHaveLength(1);
      expect(
        isAdapterSetStepReference(references[0], adapterRegistry!),
        `${command} is only the exact adapter setStep value`,
      ).toBe(true);
      return [command, references.map((identifier) => ts.SyntaxKind[identifier.parent.kind])];
    }));
    expect(facadeReferenceTopology).toEqual({
      setTableParseStep: ["PropertyAssignment"],
      setKeynoteParseStep: ["PropertyAssignment"],
      setNotesParseStep: ["PropertyAssignment"],
      setSpecParseStep: ["PropertyAssignment"],
    });

    const fixturePath = "src/components/viewer/neutral-command-provenance-fixture.ts";
    const fixture = ts.createSourceFile(
      fixturePath,
      `
        import { setKeynoteParseStep as legacyStep } from "@/stores/viewerCommands";
        import { setNotesParseStep as relativeStep } from "../../stores/viewerCommands";
        import * as Commands from "@/stores/viewerCommands";
        declare function consume(value: unknown): void;
        legacyStep("idle");
        legacyStep.call(null, "idle");
        legacyStep["bind"](null);
        consume(legacyStep);
        Commands.setSpecParseStep("idle");
        const lazy = import("@/stores/viewerCommands");
      `,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(candidateLoadKinds(
      fixturePath,
      VIEWER_COMMANDS_MODULE,
      VIEWER_COMMANDS_FILE,
      fixture,
    )).toEqual(["import", "import", "import", "dynamic-import"]);
    expect(nonCanonicalCandidateImports(
      fixturePath,
      VIEWER_COMMANDS_MODULE,
      VIEWER_COMMANDS_FILE,
      fixture,
    )).toEqual(["../../stores/viewerCommands"]);
    expect(candidateNamespaceImports(fixturePath, fixture)).toEqual([
      VIEWER_COMMANDS_MODULE,
    ]);
    expect(unsupportedImportedCallableReferences(
      fixture,
      [VIEWER_COMMANDS_MODULE],
      "setKeynoteParseStep",
    )).toEqual([
      "legacyStep:PropertyAccessExpression",
      "legacyStep:ElementAccessExpression",
      "legacyStep:CallExpression",
    ]);

    const facadeEscapeFixture = ts.createSourceFile(
      "src/hooks/neutral-command-facade-escape-fixture.ts",
      `
        import { setKeynoteParseStep } from "@/stores/viewerCommands";
        const PARSE_FLOW_ADAPTERS = {
          keynote: { setStep: setKeynoteParseStep },
        };
        setKeynoteParseStep("idle");
        setKeynoteParseStep.call(null, "idle");
      `,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const fixtureRegistry = findVariable(
      facadeEscapeFixture,
      "PARSE_FLOW_ADAPTERS",
    ).initializer!;
    const fixtureReferences = importedCallableReferences(
      facadeEscapeFixture,
      [VIEWER_COMMANDS_MODULE],
      "setKeynoteParseStep",
    );
    expect(fixtureReferences.map((identifier) => ts.SyntaxKind[identifier.parent.kind])).toEqual([
      "PropertyAssignment",
      "CallExpression",
      "PropertyAccessExpression",
    ]);
    expect(fixtureReferences.filter((identifier) =>
      !isAdapterSetStepReference(identifier, fixtureRegistry)
    ).map((identifier) => ts.SyntaxKind[identifier.parent.kind])).toEqual([
      "CallExpression",
      "PropertyAccessExpression",
    ]);
  }, 60_000);

  it("pins zero hidden facade loads and exact value imports at every A1 phase", () => {
    const expectedFiles = Object.keys(
      EXPECTED_PARSE_FACADE_CALLERS[PARSE_FACADE_PHASE],
    ).sort();
    const loads = productionSourceFiles
      .filter((path) => path !== PARSE_FACADE_FILE)
      .flatMap((path) => candidateLoadKinds(
        path,
        PARSE_FACADE_MODULE,
        PARSE_FACADE_FILE,
      ).map((kind) => ({ path, kind })));
    expect(loads).toEqual(expectedFiles.map((path) => ({ path, kind: "import" })));

    for (const path of expectedFiles) {
      const declarations = parse(path).statements.filter(
        (statement): statement is ts.ImportDeclaration =>
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          resolvesToCandidate(
            path,
            statement.moduleSpecifier.text,
            PARSE_FACADE_MODULE,
            PARSE_FACADE_FILE,
          ),
      );
      expect(declarations, `${path} one facade import`).toHaveLength(1);
      const clause = declarations[0].importClause;
      expect(clause?.isTypeOnly, `${path} facade value import`).toBe(false);
      expect(clause?.namedBindings && ts.isNamedImports(clause.namedBindings),
        `${path} named facade import`).toBe(true);
      const binding = (clause?.namedBindings as ts.NamedImports).elements.filter((element) =>
        (element.propertyName ?? element.name).text === "useParseFlow"
      );
      expect(binding, `${path} imports useParseFlow`).toHaveLength(1);
      expect(binding[0].isTypeOnly, `${path} useParseFlow is a value`).toBe(false);
    }

    const fixturePath = "src/components/parse-facade-load-fixture.ts";
    const fixture = ts.createSourceFile(
      fixturePath,
      `
        import { useParseFlow } from "@/hooks/useParseFlow";
        import { useParseFlow as relativeFlow } from "../hooks/useParseFlow";
        import { useParseFlow as dotFlow } from "@/hooks/./useParseFlow";
        import { useParseFlow as parentFlow } from "@/hooks/../hooks/useParseFlow";
        export { ParseKind } from "@/hooks/useParseFlow";
        const lazy = import("@/hooks/useParseFlow");
        const commonJs = require("../hooks/useParseFlow");
        type Inline = import("@/hooks/useParseFlow").ParseFlowLifecycle<"table">;
      `,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(candidateLoadKinds(
      fixturePath,
      PARSE_FACADE_MODULE,
      PARSE_FACADE_FILE,
      fixture,
    )).toEqual([
      "import",
      "import",
      "import",
      "import",
      "re-export",
      "dynamic-import",
      "require",
      "import-type",
    ]);
  });
});

describe("P2.4 phase-aware sacred parse subscription topology", () => {
  it("keeps AnnotationOverlay on both grouped hooks plus exactly three direct parse primitives and zero drawing subscriptions", () => {
    const source = parse(ANNOTATION_OVERLAY);
    expect(importedCalls(source, [ACTIVE_PARSE_OWNER.module], "useTableParse"))
      .toHaveLength(1);
    expect(importedCalls(source, [ACTIVE_PARSE_OWNER.module], "useKeynoteParse"))
      .toHaveLength(1);
    expect(importedCalls(source, [INACTIVE_PARSE_OWNER.module], "useTableParse")).toHaveLength(0);
    expect(importedCalls(source, [INACTIVE_PARSE_OWNER.module], "useKeynoteParse")).toHaveLength(0);
    expect(groupedDestructure(source, "useTableParse")).toEqual([
      "tableParseStep",
      "tableParseRegion",
      "tableParseColumnBBs",
      "tableParseRowBBs",
    ]);
    expect(groupedDestructure(source, "useKeynoteParse")).toEqual([
      "keynoteParseStep",
      "keynoteParseRegion",
      "keynoteColumnBBs",
      "keynoteRowBBs",
    ]);

    const parseScan = expectFailClosedOwnerScan(source);
    expect(knownMembers(parseScan, "selector")).toEqual([
      "tableCellStructure",
      "showTableCellStructure",
      "toggleCellHighlight",
    ]);
    const drawingScan = expectFailClosedOwnerScan(source, RESIDUAL_DRAWING_DESCRIPTOR);
    expect(knownMembers(drawingScan, "selector")).toEqual([]);
  });

  it("keeps DrawingPreviewLayer's residual drawing and table-then-keynote parse projections separate", () => {
    const source = parse(DRAWING_PREVIEW);
    const parseScan = expectFailClosedOwnerScan(source);
    expect(knownMembers(parseScan, "selector")).toEqual([
      "tableParseStep",
      "keynoteParseStep",
    ]);
    const drawingScan = expectFailClosedOwnerScan(source, RESIDUAL_DRAWING_DESCRIPTOR);
    expect(knownMembers(drawingScan, "selector")).toEqual([
      "_drawing",
      "_drawStart",
      "_drawEnd",
      "_mousePos",
    ]);
    expect(importedCalls(source, [ACTIVE_PARSE_OWNER.module], "useTableParse"))
      .toHaveLength(0);
    expect(importedCalls(source, [ACTIVE_PARSE_OWNER.module], "useKeynoteParse"))
      .toHaveLength(0);
  });

  it("pins PDFPage's guided grouped projection and both memo-slot direct projections", () => {
    const source = parse(PDF_PAGE);
    expect(groupedDestructure(source, "useKeynoteParse")).toEqual([
      "guidedParseActive",
      "guidedParseRegion",
      "guidedParseRows",
      "guidedParseCols",
    ]);
    const sourceText = compact(source, source);
    expect(sourceText).toContain(
      "()=>guidedParseOwner===null?null:beginGuidedGridEdit(guidedParseOwner,guidedParseRegion)",
    );
    expect(sourceText).toContain("setRows={setGuidedParseRowsForLease}");
    expect(sourceText).toContain("setCols={setGuidedParseColsForLease}");
    expect(sourceText).toContain("onGridEditStart={beginGridEdit}");
    expect(sourceText).toContain(
      "functionbeginNotesFastManualOperation():ParseWorkspaceLease{returnbeginNotesFastManualEdit();}",
    );
    expect(sourceText).toContain("onGridChange={setNotesFastManualGridFromOverlay}");
    expect(sourceText).toContain("onGridEditStart={beginNotesFastManualOperation}");
    expect(sourceText).toContain(
      "functionbeginParagraphWorkspaceOperations():ParseWorkspaceLease{returnbeginParagraphWorkspaceEdit();}",
    );
    expect(sourceText).toContain("onParagraphUpsert={upsertParagraphForLease}");
    expect(sourceText).toContain("onParagraphRemove={removeParagraphForLease}");
    expect(sourceText).toContain("onWorkspaceEditStart={beginParagraphWorkspaceOperations}");
    expect(importedCalls(source, [ACTIVE_PARSE_OWNER.module], "useTableParse"))
      .toHaveLength(0);
    expect(knownMembers(expectFailClosedOwnerScan(source), "selector")).toEqual([
      "notesFastManualActive",
      "notesParseRegion",
      "paragraphOverlayActive",
      "specParseRegion",
      "notesParseRegion",
      "paragraphBatch",
      "paragraphClipboard",
      "setParagraphClipboard",
    ]);
    const authorityMembers = knownMembers(
      expectFailClosedOwnerScan(source, ACTIVE_PARSE_AUTHORITY_DESCRIPTOR),
      "selector",
    ).filter((member) =>
      member === "guidedParseOwner" || member === "parseOperations"
    );
    expect(authorityMembers).toEqual(["guidedParseOwner"]);
  });

  it("pins ParseRegionLayer's seven primitive parse projections", () => {
    const source = parse(PARSE_REGION_LAYER);
    expect(knownMembers(expectFailClosedOwnerScan(source), "selector")).toEqual([
      "tableParseRegion",
      "tableParseColumnBBs",
      "tableParseRowBBs",
      "keynoteParseRegion",
      "keynoteColumnBBs",
      "keynoteRowBBs",
      "parseDraftRegion",
    ]);
    expect(importedCalls(source, [ACTIVE_PARSE_OWNER.module], "useTableParse"))
      .toHaveLength(0);
    expect(importedCalls(source, [ACTIVE_PARSE_OWNER.module], "useKeynoteParse"))
      .toHaveLength(0);
  });
});

describe("P2.4 phase-aware mixed test-helper parse ledger", () => {
  it("partitions one logical patch into the exact six domains", () => {
    const resetTableParse = vi.fn();
    expect(partitionViewerStoreTestState({
      publicId: "P",
      searchQuery: "needle",
      pageNumber: 7,
      mode: "markup",
      tableParseStep: "review",
      resetTableParse,
      allTrades: ["Electrical"],
    })).toEqual({
      session: { publicId: "P" },
      ui: { searchQuery: "needle" },
      core: { pageNumber: 7 },
      tool: { mode: "markup" },
      parse: { tableParseStep: "review", resetTableParse },
      viewer: { allTrades: ["Electrical"] },
    });
  });

  it("publishes session -> UI -> core -> tool -> parse -> residual viewer", () => {
    const trace: string[] = [];
    const parseSnapshots: string[] = [];
    const viewerSnapshots: string[][] = [];
    const unsubscribers = [
      useSessionStore.subscribe(() => trace.push("session")),
      useUiStore.subscribe(() => trace.push("ui")),
      useViewerCoreStore.subscribe(() => trace.push("core")),
      useToolStore.subscribe(() => trace.push("tool")),
      useParseFlowStore.subscribe((state) => {
        trace.push("parse");
        parseSnapshots.push(state.tableParseStep);
      }),
      useViewerStore.subscribe((state) => {
        trace.push("viewer");
        viewerSnapshots.push(state.allTrades);
      }),
    ];

    setViewerStoreStateForTest({
      publicId: "P",
      searchQuery: "needle",
      pageNumber: 7,
      mode: "markup",
      tableParseStep: "review",
      allTrades: ["Electrical"],
    });

    expect(trace).toEqual(["session", "ui", "core", "tool", "parse", "viewer"]);
    expect(parseSnapshots).toEqual(["review"]);
    expect(viewerSnapshots).toEqual([["Electrical"]]);
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  });

  it("skips every empty sibling partition for a parse-only setup", () => {
    const listeners = {
      session: vi.fn(),
      ui: vi.fn(),
      core: vi.fn(),
      tool: vi.fn(),
      parse: vi.fn(),
      viewer: vi.fn(),
    };
    const unsubscribers = [
      useSessionStore.subscribe(listeners.session),
      useUiStore.subscribe(listeners.ui),
      useViewerCoreStore.subscribe(listeners.core),
      useToolStore.subscribe(listeners.tool),
      useParseFlowStore.subscribe(listeners.parse),
      useViewerStore.subscribe(listeners.viewer),
    ];

    setViewerStoreStateForTest({ tableParseStep: "review" });

    expect(listeners.parse).toHaveBeenCalledTimes(1);
    expect(listeners.viewer).not.toHaveBeenCalled();
    expect(listeners.session).not.toHaveBeenCalled();
    expect(listeners.ui).not.toHaveBeenCalled();
    expect(listeners.core).not.toHaveBeenCalled();
    expect(listeners.tool).not.toHaveBeenCalled();
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  });
});

describe("P2.4 phase-aware shared borrower manifests", () => {
  it("pins the direct shared-guided borrower set", () => {
    expect(activeOwnerBorrowerFiles([
      "guidedParseActive",
      "setGuidedParseActive",
      "guidedParseRegion",
      "setGuidedParseRegion",
      "guidedParseRows",
      "setGuidedParseRows",
      "guidedParseCols",
      "setGuidedParseCols",
      "resetGuidedParse",
    ])).toEqual([
      GUIDED_PARSE_TAB,
      KEYNOTE_PANEL,
      NOTES_PARSER,
      PDF_PAGE,
    ]);
  }, 60_000);

  it("pins the shared draft and paragraph workspace borrower sets, including moved owner types", () => {
    expect(activeOwnerBorrowerFiles(["parseDraftRegion", "setParseDraftRegion"]))
      .toEqual([NOTES_PARSER, PARSE_REGION_LAYER, SPEC_PARSER]);
    expect(activeOwnerBorrowerFiles([
      "paragraphOverlayActive",
      "setParagraphOverlayActive",
      "paragraphBatch",
      "setParagraphBatch",
      "upsertPendingParagraph",
      "removePendingParagraph",
      "paragraphClipboard",
      "setParagraphClipboard",
      "PendingParagraph",
      "ParagraphTemplate",
    ])).toEqual([
      NOTES_PARSER,
      PDF_PAGE,
      PARAGRAPH_OVERLAY,
      SPEC_PARSER,
    ]);
  }, 60_000);

  it("pins Shape's Table-region borrowing and revision-bound consume sequence", () => {
    const source = parse(SHAPE_INTERACTION);
    expect(knownMembers(expectFailClosedOwnerScan(source), "selector")).toEqual([
      "tableParseRegion",
    ]);
    expect(importedCalls(source, ["@/stores/viewerCommands"], "setTableParseStep"))
      .toHaveLength(0);
    expect(importedCalls(
      source,
      ["@/stores/viewerCommands"],
      "setTableParseStepWithTool",
    ).map((call) => compact(call, source))).toEqual([
      'setTableParseStepWithTool("idle","move")',
      'setTableParseStepWithTool("idle","move")',
      'setTableParseStepWithTool("select-region","pointer")',
    ]);
    expect(importedCalls(
      source,
      ["@/stores/viewerCommands"],
      "consumeTableParseRegionForShape",
    )).toHaveLength(1);
    const consumeEffects = descendants(source, ts.isCallExpression).filter((call) => {
      const callee = unwrap(call.expression);
      if (!ts.isIdentifier(callee) || callee.text !== "useEffect" || !call.arguments[0]) {
        return false;
      }
      const labels = callLabels(call.arguments[0], source);
      return labels.includes("setRegion") && labels.includes("consumeTableParseRegionForShape");
    });
    expect(consumeEffects, "Shape shared-region consume effect").toHaveLength(1);
    expect(callLabels(consumeEffects[0].arguments[0], source)).toEqual([
      "consumeTableParseRegionForShape",
      "setRegion",
    ]);
    const consumeCalls = descendants(consumeEffects[0].arguments[0], ts.isCallExpression);
    expect(consumeCalls.slice(0, 2).map((call) => compact(call, source))).toEqual([
      "consumeTableParseRegionForShape(tableParseRegion,tableRevision)",
      "setRegion(tableParseRegionas[number,number,number,number])",
    ]);
  });

  it("pins keynote/schedule compare borrowing of the Table grid and region workspace", () => {
    const keynoteSource = parse(KEYNOTE_PANEL);
    const loadExisting = findVariable(keynoteSource, "loadExistingKeynote");
    const keynoteText = compact(loadExisting, keynoteSource);
    expect(keynoteText).not.toContain("setTableParseRegion(");
    expect(keynoteText).not.toContain("setTableParsedGrid(");
    expect(keynoteText).not.toContain("setTableParseStep(");
    expect(keynoteText).not.toContain("useToolStore.getState().setMode(");
    expect(keynoteText).toContain('openTableReviewTarget(targetPage,publication,"keynote")');
    expect(keynoteText).toContain('openTableReviewWorkspace(publication,"keynote")');

    const parsedItemSource = parse(PARSED_TABLE_ITEM);
    const editCallbacks = descendants(parsedItemSource, ts.isArrowFunction).filter((callback) => {
      const text = compact(callback, parsedItemSource);
      return text.includes("openTableReviewTarget(") &&
        text.includes("toggleTableCompareModal()");
    });
    expect(editCallbacks, "ParsedTableItem View/Edit callback").toHaveLength(1);
    const parsedItemText = compact(editCallbacks[0], parsedItemSource);
    expect(parsedItemText).not.toContain("setTableParsedGrid(");
    expect(parsedItemText).not.toContain("setTableParseRegion(");
    expect(parsedItemText.indexOf("toggleTableCompareModal()")).toBeLessThan(
      parsedItemText.indexOf("openTableReviewTarget("),
    );

    const compareSource = parse(TABLE_COMPARE_MODAL);
    const handleDone = findVariable(compareSource, "handleDone");
    const compareText = compact(handleDone, compareSource);
    expect(compareText).toContain("useParseFlowStore.getState().tableParsedGrid");
    expect(compareText).toContain("store.parsedKeynoteData");
    expect(compareText).toContain("store.setParsedKeynoteData(updatedKeynoteData)");
  });

  it("pins PDF paragraph precedence and kind-specific exit", () => {
    const source = parse(PDF_PAGE);
    const outerBbox = findVariable(source, "outerBbox");
    const isSpec = findVariable(source, "isSpec");
    const onExit = findVariable(source, "onExit");
    expect(compact(outerBbox.initializer!, source)).toBe("specParseRegion??notesParseRegion");
    expect(compact(isSpec.initializer!, source)).toBe("!!specParseRegion");
    expect(compact(onExit, source))
      .toBe("onExit=isSpec?exitSpecParagraphWorkspace:exitNotesParagraphWorkspace");
  });
});

describe("P2.4 post-D2 guided-Spec scaffold absence", () => {
  const retiredNames = [
    ["guided", "Spec", "Section", "BBs"].join(""),
    ["add", "Guided", "Spec", "Section", "BB"].join(""),
  ];

  it("rejects decoded or computed retired names across every supported project source", () => {
    const retiredSet = new Set(retiredNames);
    const findings = supportedProjectSourceFiles().flatMap((path) =>
      retiredStaticNameFindings(parse(path), retiredSet),
    );
    expect(findings).toEqual([]);

    const escapedName = "guided\\" + "u0053pecSectionBBs";
    const calibration = ts.createSourceFile(
      "d2-absence-calibration.ts",
      `const decoded = { ${escapedName}: [] }; const computed = { ["add" + "GuidedSpecSectionBB"]: 1 };`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(retiredStaticNameFindings(calibration, retiredSet).map((finding) =>
      finding.slice(finding.lastIndexOf(":") + 1)
    )).toEqual([...retiredNames].sort());
  }, 60_000);

  it("keeps owner definitions and runtime state free of both retired names", () => {
    const definitions = ownerDefinitionKeys(ACTIVE_PARSE_OWNER);
    const runtimeState = RUNTIME_OWNER_STATE_READERS[ACTIVE_PARSE_OWNER.module]!();
    for (const name of retiredNames) {
      expect(definitions.interfaceKeys, `${name} interface absence`).not.toContain(name);
      expect(definitions.objectKeys, `${name} implementation absence`).not.toContain(name);
      expect(Object.prototype.hasOwnProperty.call(runtimeState, name), `${name} runtime absence`)
        .toBe(false);
    }
  });

  it("cannot acquire a retired own-property through any affected reset or command path", () => {
    const region: [number, number, number, number] = [0.1, 0.2, 0.8, 0.9];
    const exercises: Array<readonly [string, () => void]> = [
      ["resetSpecParse", () => useParseFlowStore.getState().resetSpecParse()],
      ["resetProjectParseState", () => useParseFlowStore.getState().resetProjectParseState()],
      ["acceptNotesParseRegion", () => acceptNotesParseRegion(region)],
      ["openNotesParseTarget", () => openNotesParseTarget(2, region)],
      ["openSpecParseTarget", () => openSpecParseTarget(2, region)],
      ["completeSpecParseOperation", () => {
        const started = useParseFlowStore.getState().beginParseOperation("spec");
        expect(started.status).toBe("started");
        if (started.status === "started") completeSpecParseOperation(started.token);
      }],
      ["resetSpecParseWorkspace", () => resetSpecParseWorkspace()],
      ["leaveSpecsNotesParseTab", () => {
        useUiStore.setState({ specsNotesTab: "spec-parse" });
        setSpecsNotesParseTab("notes-parse");
      }],
    ];

    for (const [label, exercise] of exercises) {
      restoreStores();
      exercise();
      const state = useParseFlowStore.getState() as unknown as Record<string, unknown>;
      for (const name of retiredNames) {
        expect(Object.prototype.hasOwnProperty.call(state, name), `${label}:${name}`).toBe(false);
      }
    }
  });
});

describe("P2.4 phase-aware shared owner-oracle integration", () => {
  it("uses one deduped production + real-test + src/test corpus for the inactive owner", () => {
    expect(allSourceCorpus).toEqual(everyTypeScriptSourceFile);
    expect(new Set(allSourceCorpus).size).toBe(allSourceCorpus.length);
    expect(allSourceCorpus).toEqual([
      ...new Set([...productionSourceFiles, ...realTestSourceFiles, ...srcTestSourceFiles]),
    ].sort());
  });

  it("sees live active consumers and rejects every non-allowlisted inactive-owner access", () => {
    const activeKnown = productionSourceFiles.flatMap((path) =>
      ownerScan(parse(path), ACTIVE_PARSE_DESCRIPTOR).known,
    );
    const inactiveByFile = allSourceCorpus.map((path) => ({
      path,
      result: ownerScan(parse(path), INACTIVE_PARSE_DESCRIPTOR),
    })).filter(({ result }) => result.findings.length > 0);
    const allowlist = new Set<string>(OWNERSHIP.inactiveAccessAllowlist);
    const unexpected = inactiveByFile.filter(({ path }) => !allowlist.has(path));
    const allowed = inactiveByFile.filter(({ path }) => allowlist.has(path));
    const observedAllowlist = allowed.map(({ path }) => path);

    const accessed = new Set(activeKnown.map((finding) => finding.member));
    for (const representative of [
      "tableParseRegion",
      "keynoteParseRegion",
      "notesParseRegion",
      "specParseRegion",
      "guidedParseRows",
      "paragraphBatch",
    ]) {
      expect(accessed, `${representative} live parse consumer`).toContain(representative);
    }
    expect(unexpected.flatMap(({ result }) => [
      ...result.known.map((finding) =>
        `${finding.fileName}:${finding.line}:${finding.column} ${formatStoreOwnerFinding(finding)}`),
      ...findingLabels(result),
    ])).toEqual([]);
    // The sole S2 exception exists only because this topology file deliberately snapshots the
    // residual owner to prove runtime absence. It may never hide a statically known parse access.
    expect(allowed.flatMap(({ result }) => result.known.map((finding) =>
      `${finding.fileName}:${finding.line}:${finding.column} ${formatStoreOwnerFinding(finding)}`,
    ))).toEqual([]);
    expect(observedAllowlist).toEqual([...allowlist].sort());
  }, 120_000);
});
