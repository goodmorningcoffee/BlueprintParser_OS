// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  buildBootstrapPageWindow,
  deriveBootstrapLoadedRange,
  EMPTY_ACTIVE_PAGE_WINDOW,
  mergeNavigationPageWindow,
  normalizePageWindowPages,
  PAGE_WINDOW_RETENTION_BUFFER,
  type ActivePageWindow,
  type PageWindowResponse,
  type PageWindowResponsePage,
} from "@/queries/pageWindowCore";
import type { CsiCode, KeynoteShapeData, PageIntelligence, TextAnnotation } from "@/types";

function keynote(text: string): KeynoteShapeData {
  return { shape: "circle", text, bbox: [0, 0, 0.1, 0.1] };
}

function csi(code: string): CsiCode {
  return { code, description: `CSI ${code}`, trade: "Trade", division: "01" };
}

function textAnnotation(text: string): TextAnnotation {
  return {
    type: "general-note",
    category: "notes",
    text,
    bbox: [0, 0, 0.1, 0.1],
    confidence: 1,
    wordIndices: [],
  };
}

function page(
  pageNumber: number,
  overrides: Partial<PageWindowResponsePage> = {},
): PageWindowResponsePage {
  return {
    pageNumber,
    name: `Page ${pageNumber}`,
    drawingNumber: null,
    ...overrides,
  };
}

function response(
  pages: PageWindowResponsePage[],
  from = 700,
  to = 900,
): PageWindowResponse {
  return { from, to, pages, annotations: [] };
}

function active(overrides: Partial<ActivePageWindow> = {}): ActivePageWindow {
  return {
    loadedRange: { from: 1, to: 15 },
    keynotes: {},
    csiCodes: {},
    textAnnotations: {},
    pageIntelligence: {},
    ...overrides,
  };
}

describe("pageWindowCore — sparse wire normalization", () => {
  it("omits null/missing fields but keeps truthy empty arrays and wrappers", () => {
    const emptyIntel: PageIntelligence = {};
    const maps = normalizePageWindowPages([
      page(1, {
        keynotes: null,
        csiCodes: null,
        textAnnotations: null,
        pageIntelligence: null,
      }),
      page(2),
      page(3, {
        keynotes: [],
        csiCodes: [],
        textAnnotations: {},
        pageIntelligence: emptyIntel,
      }),
    ]);

    expect(maps).toEqual({
      keynotes: { 3: [] },
      csiCodes: { 3: [] },
      textAnnotations: { 3: [] },
      pageIntelligence: { 3: emptyIntel },
    });
    expect(Object.hasOwn(maps.keynotes, 1)).toBe(false);
    expect(Object.hasOwn(maps.keynotes, 2)).toBe(false);
  });

  it("preserves canonical array/object references without inspecting response from/to", () => {
    const keynotes = [keynote("K")];
    const codes = [csi("01 10 00")];
    const annotations = [textAnnotation("NOTE")];
    const intelligence: PageIntelligence = { rejectedTextRegionIds: ["r1"] };
    const maps = normalizePageWindowPages([
      page(41, {
        keynotes,
        csiCodes: codes,
        textAnnotations: { annotations },
        pageIntelligence: intelligence,
      }),
    ]);

    expect(maps.keynotes[41]).toBe(keynotes);
    expect(maps.csiCodes[41]).toBe(codes);
    expect(maps.textAnnotations[41]).toBe(annotations);
    expect(maps.pageIntelligence[41]).toBe(intelligence);
  });

  it("uses later-row-wins assignment independently for every provided duplicate field", () => {
    const firstKeynotes = [keynote("first")];
    const secondKeynotes = [keynote("second")];
    const firstCodes = [csi("01")];
    const secondIntel: PageIntelligence = { rejectedTextRegionIds: ["later"] };

    const maps = normalizePageWindowPages([
      page(8, { keynotes: firstKeynotes, csiCodes: firstCodes }),
      page(8, { keynotes: secondKeynotes, pageIntelligence: secondIntel }),
    ]);

    expect(maps.keynotes[8]).toBe(secondKeynotes);
    expect(maps.csiCodes[8]).toBe(firstCodes);
    expect(maps.pageIntelligence[8]).toBe(secondIntel);
  });

  it("does not impose a nominal 25-page cache cap while mapping incoming rows", () => {
    const pages = Array.from({ length: 30 }, (_, index) =>
      page(index + 1, { keynotes: [keynote(`K${index + 1}`)] }),
    );

    expect(Object.keys(normalizePageWindowPages(pages).keynotes)).toHaveLength(30);
  });
});

describe("pageWindowCore — eager bootstrap range", () => {
  it("uses one through the maximum returned page number, not row count or response extent", () => {
    expect(deriveBootstrapLoadedRange([page(9), page(2), page(14), page(9)], 100)).toEqual({
      from: 1,
      to: 14,
    });
  });

  it.each([
    { numPages: 100, expectedTo: 15 },
    { numPages: 7, expectedTo: 7 },
    { numPages: 0, expectedTo: 1 },
    { numPages: null, expectedTo: 1 },
    { numPages: undefined, expectedTo: 1 },
  ])("uses the exact empty-row fallback for numPages=$numPages", ({ numPages, expectedTo }) => {
    expect(deriveBootstrapLoadedRange([], numPages)).toEqual({ from: 1, to: expectedTo });
  });

  it("builds normalized maps without retaining any prior active value", () => {
    const initial = buildBootstrapPageWindow(
      response([
        page(3, { keynotes: [keynote("fresh")] }),
        page(10, { csiCodes: [csi("10")] }),
      ]),
      80,
    );

    expect(initial.loadedRange).toEqual({ from: 1, to: 10 });
    expect(initial.keynotes).toEqual({ 3: [keynote("fresh")] });
    expect(initial.csiCodes).toEqual({ 10: [csi("10")] });
    expect(initial.textAnnotations).toEqual({});
    expect(initial.pageIntelligence).toEqual({});
  });

  it("exports one stable deeply frozen empty active value for failure seeding", () => {
    expect(EMPTY_ACTIVE_PAGE_WINDOW.loadedRange).toBeNull();
    expect(Object.isFrozen(EMPTY_ACTIVE_PAGE_WINDOW)).toBe(true);
    expect(Object.isFrozen(EMPTY_ACTIVE_PAGE_WINDOW.keynotes)).toBe(true);
    expect(Object.isFrozen(EMPTY_ACTIVE_PAGE_WINDOW.csiCodes)).toBe(true);
    expect(Object.isFrozen(EMPTY_ACTIVE_PAGE_WINDOW.textAnnotations)).toBe(true);
    expect(Object.isFrozen(EMPTY_ACTIVE_PAGE_WINDOW.pageIntelligence)).toBe(true);
    expect(EMPTY_ACTIVE_PAGE_WINDOW).toBe(EMPTY_ACTIVE_PAGE_WINDOW);
  });
});

describe("pageWindowCore — response-time navigation merge", () => {
  it("retains the inclusive middle ±5 boundary and evicts one page beyond it", () => {
    expect(PAGE_WINDOW_RETENTION_BUFFER).toBe(5);
    const keepLow = [keynote("keep-low")];
    const keepHigh = [keynote("keep-high")];
    const old = active({
      keynotes: {
        7: [keynote("evict-low")],
        8: keepLow,
        32: keepHigh,
        33: [keynote("evict-high")],
      },
    });

    const next = mergeNavigationPageWindow(old, response([]), 13, 27);

    expect(next.loadedRange).toEqual({ from: 13, to: 27 });
    expect(next.keynotes).toEqual({ 8: keepLow, 32: keepHigh });
    expect(next.keynotes[8]).toBe(keepLow);
    expect(next.keynotes[32]).toBe(keepHigh);
  });

  it.each([
    { label: "start", actualFrom: 1, actualTo: 8, keep: 13, evict: 14 },
    { label: "end", actualFrom: 93, actualTo: 100, keep: 88, evict: 87 },
  ])("applies the same unclipped retention formula at the $label edge", ({ actualFrom, actualTo, keep, evict }) => {
    const old = active({
      csiCodes: { [keep]: [csi("keep")], [evict]: [csi("evict")] },
    });

    const next = mergeNavigationPageWindow(old, response([]), actualFrom, actualTo);

    expect(Object.keys(next.csiCodes).map(Number)).toEqual([keep]);
  });

  it("lets provided response fields win while null/omitted fields retain live values", () => {
    const localKeynotes = [keynote("local")];
    const serverKeynotes = [keynote("server")];
    const localCodes = [csi("local")];
    const localText = [textAnnotation("local")];
    const localIntel: PageIntelligence = { rejectedTextRegionIds: ["local"] };
    const old = active({
      keynotes: { 20: localKeynotes },
      csiCodes: { 20: localCodes },
      textAnnotations: { 20: localText },
      pageIntelligence: { 20: localIntel },
    });

    const next = mergeNavigationPageWindow(
      old,
      response([
        page(20, {
          keynotes: serverKeynotes,
          csiCodes: null,
          textAnnotations: null,
          pageIntelligence: undefined,
        }),
      ]),
      13,
      27,
    );

    expect(next.keynotes[20]).toBe(serverKeynotes);
    expect(next.csiCodes[20]).toBe(localCodes);
    expect(next.textAnnotations[20]).toBe(localText);
    expect(next.pageIntelligence[20]).toBe(localIntel);
  });

  it("treats provided empty arrays/wrappers as server clears", () => {
    const old = active({
      keynotes: { 20: [keynote("old")] },
      csiCodes: { 20: [csi("old")] },
      textAnnotations: { 20: [textAnnotation("old")] },
    });

    const next = mergeNavigationPageWindow(
      old,
      response([page(20, { keynotes: [], csiCodes: [], textAnnotations: {} })]),
      13,
      27,
    );

    expect(next.keynotes[20]).toEqual([]);
    expect(next.csiCodes[20]).toEqual([]);
    expect(next.textAnnotations[20]).toEqual([]);
  });

  it("adopts the computed range for sparse and empty responses, ignoring echoed from/to", () => {
    const sparse = mergeNavigationPageWindow(
      EMPTY_ACTIVE_PAGE_WINDOW,
      response([page(20, { keynotes: [keynote("only-row")] })], 1, 2),
      13,
      27,
    );
    const empty = mergeNavigationPageWindow(
      sparse,
      response([], 400, 500),
      43,
      57,
    );

    expect(sparse.loadedRange).toEqual({ from: 13, to: 27 });
    expect(sparse.keynotes).toEqual({ 20: [keynote("only-row")] });
    expect(empty.loadedRange).toEqual({ from: 43, to: 57 });
    expect(empty.keynotes).toEqual({});
  });

  it("preserves unrelated map references and retained page-value references", () => {
    const retainedCode = [csi("retained")];
    const retainedText = [textAnnotation("retained")];
    const retainedIntel: PageIntelligence = { rejectedTextRegionIds: ["retained"] };
    const old = active({
      keynotes: { 20: [keynote("old")] },
      csiCodes: { 20: retainedCode },
      textAnnotations: { 20: retainedText },
      pageIntelligence: { 20: retainedIntel },
    });

    const next = mergeNavigationPageWindow(
      old,
      response([page(20, { keynotes: [keynote("new")] })]),
      13,
      27,
    );

    expect(next.keynotes).not.toBe(old.keynotes);
    expect(next.csiCodes).toBe(old.csiCodes);
    expect(next.textAnnotations).toBe(old.textAnnotations);
    expect(next.pageIntelligence).toBe(old.pageIntelligence);
    expect(next.csiCodes[20]).toBe(retainedCode);
    expect(next.textAnnotations[20]).toBe(retainedText);
    expect(next.pageIntelligence[20]).toBe(retainedIntel);
  });

  it("is pure and cannot cross-contaminate independently keyed project inputs", () => {
    const projectA = active({ keynotes: { 20: [keynote("A-old")] } });
    const projectB = active({ keynotes: { 20: [keynote("B-sentinel")] } });
    const projectABefore = projectA.keynotes;
    const projectBBefore = projectB.keynotes;

    const nextA = mergeNavigationPageWindow(
      projectA,
      response([page(20, { keynotes: [keynote("A-new")] })]),
      13,
      27,
    );

    expect(projectA.keynotes).toBe(projectABefore);
    expect(projectA.keynotes[20]?.[0].text).toBe("A-old");
    expect(nextA.keynotes[20]?.[0].text).toBe("A-new");
    expect(projectB.keynotes).toBe(projectBBefore);
    expect(projectB.keynotes[20]?.[0].text).toBe("B-sentinel");
  });
});
