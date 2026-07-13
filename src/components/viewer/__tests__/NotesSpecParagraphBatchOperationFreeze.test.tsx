// @vitest-environment jsdom
// [refactor jul12 P2.4 A2d] Real Notes/Spec paragraph-batch root authority witnesses.

import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import NotesParser from "@/components/viewer/NotesParser";
import SpecParser from "@/components/viewer/SpecParser";
import { EMPTY_ACTIVE_PAGE_WINDOW } from "@/queries/pageWindowCore";
import { queryKeys } from "@/queries/queryKeys";
import { readPageIntelligence } from "@/queries/usePageWindow";
import {
  clearYoloTagsProject,
  seedYoloTagsFromBootstrap,
} from "@/queries/useYoloTags";
import {
  useParseFlowStore,
  type PendingParagraph,
} from "@/stores/parseFlowStore";
import { resetProjectData } from "@/stores/viewerCommands";
import { setViewerStoreStateForTest } from "@/test/viewer-store-state";

const PUBLIC_ID = "notes-spec-paragraph-operation-project";
const PAGE = 4;
const BBOX_A = [0.1, 0.2, 0.7, 0.8] as const;
const BBOX_B = [0.2, 0.25, 0.8, 0.85] as const;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

type PendingPromotion = Deferred<Response> & {
  init: RequestInit | undefined;
};

type ParserCase = {
  kind: "notes" | "spec";
  Component: ComponentType;
  saveLabel: "Save Notes" | "Save Spec";
  savingLabel: "Saving…";
  makeBatch: (marker: string) => PendingParagraph[];
  assertCapturedRequest: (body: Record<string, unknown>) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function promotionSuccessResponse(kind: ParserCase["kind"], marker: string): Response {
  const parsedRegion = {
    id: `${kind}-${marker}`,
    type: kind,
    category: `${marker} ${kind}`,
    bbox: BBOX_A,
    confidence: 0.95,
    csiTags: [],
    data: kind === "notes"
      ? {
          headers: ["Key", "Note"],
          rows: [{ Key: marker, Note: `${marker} note` }],
          tableName: `${marker} notes`,
        }
      : {
          sections: [{ sectionHeader: `${marker} PART 1`, body: `${marker} scope` }],
          tableName: `${marker} spec`,
        },
    source: "user",
  };
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      ok: true,
      parsedRegion,
      updatedIntelligence: {
        rejectedTextRegionIds: [marker],
        parsedRegions: [parsedRegion],
      },
      summaries: null,
    }),
  } as unknown as Response;
}

function promotionFailureResponse(message: string): Response {
  return {
    ok: false,
    status: 500,
    json: vi.fn().mockResolvedValue({ error: { code: "FAIL", message } }),
  } as unknown as Response;
}

function paragraph(
  id: string,
  bbox: readonly [number, number, number, number],
  rowText: Record<string, string>,
): PendingParagraph {
  return {
    id,
    bbox: [...bbox],
    lines: [],
    rowText,
    colBoundaries: [bbox[0], (bbox[0] + bbox[2]) / 2, bbox[2]],
  };
}

function notesBatch(marker: string): PendingParagraph[] {
  return [
    paragraph(`${marker}-1`, [0.1, 0.2, 0.6, 0.3], {
      Key: `${marker}-K1`,
      Note: `${marker}-N1`,
    }),
    paragraph(`${marker}-2`, [0.1, 0.35, 0.6, 0.5], {
      Key: `${marker}-K2`,
      Value: `${marker}-N2`,
    }),
  ];
}

function specBatch(marker: string): PendingParagraph[] {
  return [
    paragraph(`${marker}-1`, [0.1, 0.2, 0.6, 0.3], {
      sectionHeader: `${marker} PART 1`,
      body: `${marker} scope 1`,
    }),
    paragraph(`${marker}-2`, [0.1, 0.35, 0.6, 0.5], {
      sectionHeader: `${marker} PART 2`,
      body: `${marker} scope 2`,
    }),
  ];
}

function overrides(body: Record<string, unknown>): Record<string, unknown> {
  const value = body.overrides;
  if (!value || typeof value !== "object") throw new Error("missing parser overrides");
  return value as Record<string, unknown>;
}

const CASES: ParserCase[] = [
  {
    kind: "notes",
    Component: NotesParser,
    saveLabel: "Save Notes",
    savingLabel: "Saving…",
    makeBatch: notesBatch,
    assertCapturedRequest: (body) => {
      expect(body.type).toBe("notes");
      expect(overrides(body).bbox).toEqual([0.1, 0.2, 0.6, 0.5]);
      expect(overrides(body).data).toEqual({
        headers: ["Key", "Note"],
        rows: [
          { Key: "CAPTURED-K1", Note: "CAPTURED-N1" },
          { Key: "CAPTURED-K2", Note: "CAPTURED-N2" },
        ],
        tagColumn: "Key",
        tableName: "Notes p.4 — 2 paragraphs",
        rowCount: 2,
        columnCount: 2,
        rowBoundaries: [0.2, 0.35, 0.5],
      });
    },
  },
  {
    kind: "spec",
    Component: SpecParser,
    saveLabel: "Save Spec",
    savingLabel: "Saving…",
    makeBatch: specBatch,
    assertCapturedRequest: (body) => {
      expect(body.type).toBe("spec");
      expect(overrides(body).bbox).toEqual([0.1, 0.2, 0.6, 0.5]);
      expect(overrides(body).data).toEqual({
        sections: [
          { sectionHeader: "CAPTURED PART 1", body: "CAPTURED scope 1" },
          { sectionHeader: "CAPTURED PART 2", body: "CAPTURED scope 2" },
        ],
        tableName: "Spec p.4 — 2 sections",
      });
    },
  },
];

async function flushCompletion(): Promise<void> {
  for (let index = 0; index < 24; index += 1) await Promise.resolve();
}

let queryClient: QueryClient;
let promotions: PendingPromotion[];
const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function seedWorkspace(
  testCase: ParserCase,
  bbox: readonly [number, number, number, number],
  batch: PendingParagraph[],
): void {
  useParseFlowStore.setState({
    notesParseStep: "idle",
    notesParseRegion: testCase.kind === "notes" ? [...bbox] : null,
    specParseStep: "idle",
    specParseRegion: testCase.kind === "spec" ? [...bbox] : null,
    paragraphBatch: batch,
    parseDraftRegion: null,
  });
}

function currentRegion(testCase: ParserCase) {
  const state = useParseFlowStore.getState();
  return testCase.kind === "notes" ? state.notesParseRegion : state.specParseRegion;
}

async function renderParagraphRoot(
  testCase: ParserCase,
  batch = testCase.makeBatch("A"),
): Promise<HTMLButtonElement> {
  seedWorkspace(testCase, BBOX_A, batch);
  const Parser = testCase.Component;
  render(<Parser />, { wrapper });
  act(() => {
    (screen.getByRole("button", { name: "Paragraph" }) as HTMLButtonElement).click();
  });
  const save = screen.getByRole("button", { name: testCase.saveLabel }) as HTMLButtonElement;
  await waitFor(() => expect(save).toBeEnabled());
  return save;
}

function requestBody(index: number): Record<string, unknown> {
  const raw = promotions[index]?.init?.body;
  if (typeof raw !== "string") throw new Error(`missing promotion body ${index}`);
  return JSON.parse(raw) as Record<string, unknown>;
}

function startSyntheticB(testCase: ParserCase): { revision: number } {
  useParseFlowStore.getState().invalidateParseOperation(testCase.kind);
  seedWorkspace(testCase, BBOX_B, testCase.makeBatch("B"));
  const started = useParseFlowStore.getState().beginParseOperation(testCase.kind);
  if (started.status !== "started") throw new Error(`could not start ${testCase.kind} B`);
  return started.token;
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  promotions = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: unknown, init?: RequestInit) => {
    if (url !== "/api/regions/promote") {
      throw new Error(`unexpected paragraph-batch request: ${String(url)}`);
    }
    const request = deferred<Response>();
    promotions.push({ ...request, init });
    return request.promise;
  });
  vi.stubGlobal("fetch", fetchMock);

  resetProjectData();
  setViewerStoreStateForTest({
    projectId: 41,
    publicId: PUBLIC_ID,
    isDemo: false,
    pageNumber: PAGE,
    numPages: PAGE,
    pageDrawingNumbers: {},
  });
  queryClient.setQueryData(queryKeys.pagesWindow.active(PUBLIC_ID), {
    ...EMPTY_ACTIVE_PAGE_WINDOW,
  });
  queryClient.setQueryData(queryKeys.annotations.all(PUBLIC_ID), []);
  queryClient.setQueryData(queryKeys.textract.page(PUBLIC_ID, PAGE), {
    lines: [],
    words: [],
  });
  seedYoloTagsFromBootstrap(queryClient, PUBLIC_ID, { yoloTags: [] });
});

afterEach(() => {
  cleanup();
  clearYoloTagsProject(queryClient, PUBLIC_ID);
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(CASES)("A2d $kind paragraph-batch root authority", (testCase) => {
  it("rejects a same-turn duplicate before a second persistence request or revision", async () => {
    const save = await renderParagraphRoot(testCase);
    const beforeRevision = useParseFlowStore.getState()
      .parseOperations[testCase.kind].revision;

    act(() => {
      save.click();
      save.click();
    });

    expect(promotions).toHaveLength(1);
    expect(useParseFlowStore.getState().parseOperations[testCase.kind]).toEqual({
      revision: beforeRevision + 1,
      busy: true,
    });
    expect(screen.getByRole("button", { name: testCase.savingLabel })).toBeDisabled();
  });

  it("persists the captured batch when begin subscribers synchronously replace the workspace", async () => {
    const captured = testCase.makeBatch("CAPTURED");
    const save = await renderParagraphRoot(testCase, captured);
    let armed = true;
    const unsubscribe = useParseFlowStore.subscribe((state, previous) => {
      if (
        !armed ||
        !state.parseOperations[testCase.kind].busy ||
        previous.parseOperations[testCase.kind].busy
      ) return;
      armed = false;
      useParseFlowStore.setState({ paragraphBatch: testCase.makeBatch("MUTATED") });
    });

    act(() => { save.click(); });
    unsubscribe();

    expect(promotions).toHaveLength(1);
    const body = requestBody(0);
    testCase.assertCapturedRequest(body);
    expect(JSON.stringify(body)).not.toContain("MUTATED");

    await act(async () => {
      promotions[0].resolve(promotionSuccessResponse(
        testCase.kind,
        `${testCase.kind}-captured`,
      ));
      await flushCompletion();
    });
    await waitFor(() => {
      expect(useParseFlowStore.getState().parseOperations[testCase.kind].busy).toBe(false);
    });
  });

  it("allows stale A durable success but cannot complete or erase current B", async () => {
    const save = await renderParagraphRoot(testCase);
    act(() => { save.click(); });
    expect(promotions).toHaveLength(1);

    let tokenB!: { revision: number };
    act(() => { tokenB = startSyntheticB(testCase); });

    await act(async () => {
      promotions[0].resolve(promotionSuccessResponse(
        testCase.kind,
        `${testCase.kind}-stale-success`,
      ));
      await flushCompletion();
    });

    expect(readPageIntelligence(queryClient, PUBLIC_ID, PAGE)?.rejectedTextRegionIds)
      .toEqual([`${testCase.kind}-stale-success`]);
    expect(useParseFlowStore.getState().parseOperations[testCase.kind]).toEqual({
      revision: tokenB.revision,
      busy: true,
    });
    expect(currentRegion(testCase)).toEqual(BBOX_B);
    expect(useParseFlowStore.getState().paragraphBatch).toEqual(testCase.makeBatch("B"));
  });

  it("suppresses stale A failure while current B and its workspace survive", async () => {
    const save = await renderParagraphRoot(testCase);
    act(() => { save.click(); });
    expect(promotions).toHaveLength(1);

    let tokenB!: { revision: number };
    act(() => { tokenB = startSyntheticB(testCase); });
    const message = `${testCase.kind} stale batch failed`;

    await act(async () => {
      promotions[0].resolve(promotionFailureResponse(message));
      await flushCompletion();
    });

    expect(screen.queryByText(message)).not.toBeInTheDocument();
    expect(useParseFlowStore.getState().parseOperations[testCase.kind]).toEqual({
      revision: tokenB.revision,
      busy: true,
    });
    expect(currentRegion(testCase)).toEqual(BBOX_B);
    expect(useParseFlowStore.getState().paragraphBatch).toEqual(testCase.makeBatch("B"));
  });

  it("releases current failure, admits retry, and performs terminal shared cleanup", async () => {
    const save = await renderParagraphRoot(testCase);
    act(() => { save.click(); });
    const message = `${testCase.kind} current batch failed`;

    await act(async () => {
      promotions[0].resolve(promotionFailureResponse(message));
      await flushCompletion();
    });
    await waitFor(() => expect(screen.getByText(message)).toBeInTheDocument());
    const failedRevision = useParseFlowStore.getState()
      .parseOperations[testCase.kind].revision;
    expect(useParseFlowStore.getState().parseOperations[testCase.kind].busy).toBe(false);
    expect(currentRegion(testCase)).toEqual(BBOX_A);
    expect(useParseFlowStore.getState().paragraphBatch).toEqual(testCase.makeBatch("A"));

    const retry = screen.getByRole("button", { name: testCase.saveLabel }) as HTMLButtonElement;
    expect(retry).toBeEnabled();
    act(() => { retry.click(); });
    expect(promotions).toHaveLength(2);
    expect(useParseFlowStore.getState().parseOperations[testCase.kind]).toEqual({
      revision: failedRevision + 1,
      busy: true,
    });
    expect(screen.queryByText(message)).not.toBeInTheDocument();

    await act(async () => {
      promotions[1].resolve(promotionSuccessResponse(
        testCase.kind,
        `${testCase.kind}-retry-success`,
      ));
      await flushCompletion();
    });
    await waitFor(() => expect(currentRegion(testCase)).toBeNull());
    expect(useParseFlowStore.getState().paragraphBatch).toEqual([]);
    expect(useParseFlowStore.getState().parseOperations[testCase.kind].busy).toBe(false);
    expect(screen.queryByText(message)).not.toBeInTheDocument();
  });
});
