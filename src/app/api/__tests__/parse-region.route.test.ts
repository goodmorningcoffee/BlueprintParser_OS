// @vitest-environment node
// [refactor jul5 S026] CHARACTERIZATION for the 5 cheap region-parse routes, written as THE
// FREEZE before the P1.5 fold onto services/{notes-parse,spec-parse,table-parse-propose}.ts:
//   POST /api/notes-parse          POST /api/notes-parse/propose
//   POST /api/spec-parse           POST /api/spec-parse/propose
//   POST /api/table-parse/propose
// One char file: the five share ONE ~55-line scaffold (truthy field-400 → bbox-400 →
// resolveProjectAccess({dbId}) → page textractData fetch/404 → engine → catch-all) with the
// engine swapped. ENGINES ARE MOCKED at their module seams (parseNotesFromRegion /
// bindSpecSectionsInRegion / detectCsiFromGrid / detectCsiCodes / detectRowsAndColumns) —
// this file freezes the ROUTE contract only. Frozen:
//   • PQ-1 cascade: field-400 → bbox-400 BEFORE access (validate-before-auth); truthy check
//     (projectId:0 / pageNumber:0 wrongly trip "Missing…" — falsy-zero, FQ-13 analog).
//   • PQ-2 bbox message SPLIT: 4 routes use the LONG form ("Invalid regionBbox: values must
//     be finite numbers in [0,1] with min < max"); table-parse/propose alone uses the SHORT
//     "Invalid regionBbox" (copy-paste drift, frozen).
//   • PQ-3 access: resolveProjectAccess({dbId}, {allowDemo:true}) on 4 routes → demo+anon
//     READS at 200; table-parse/propose has NO allowDemo → demo+anon 401 (and NO route in
//     this file has an assertDemoFeatureEnabled gate). Miss → 404 BEFORE auth; signed-out
//     non-demo → 401; cross-tenant → 404; negative dbId → 404 (lookup miss — an integer
//     guard is DECLINED at fold: would flip 404→400, unsanctioned).
//   • PQ-4 engines + args: notes = parseNotesFromRegion(textractData, LTWH-converted bbox,
//     {autoSplitColumns: autoSplitColumns ?? true}); spec = bindSpecSectionsInRegion(
//     textractData.LINES, LTWH, {includeSubSections: !!includeSubSections}); table-propose =
//     detectRowsAndColumns(textractData.WORDS, regionBbox MINMAX-UNCONVERTED, layoutHint,
//     gridOptions). LTWH-vs-MinMax split is load-bearing.
//   • PQ-5 csiTags ASYMMETRY: notes-parse MAPS detectCsiFromGrid output to {code,description}
//     (drops trade etc.); spec-parse passes detectCsiCodes output through UNMAPPED (full
//     objects); spec's input text = sections.map(s=>`${s.sectionHeader}\n${s.body}`)
//     .join("\n\n"). Both CSI calls are wrapped in a non-fatal inner try/catch → csiTags [].
//   • PQ-6 no-result shapes: notes → {headers:[],rows:[],csiTags:[],note:"No numbered items
//     detected in region"}; notes-propose → {proposedRows:[],proposedCols:[]}; spec →
//     {sections:[],csiTags:[],note:"No spec section headers detected in region"};
//     spec-propose → {proposedRows:[]}; table-propose has NO early return — ALWAYS the 8-key
//     shape even degraded.
//   • PQ-7 undefined-key drops: notes full response emits rowBoundaries/colBoundaries only
//     when the engine provided them (JSON drops undefined); the propose routes coalesce ?? [].
//   • legacy error plumbing: req.json() is INSIDE the try → malformed/empty/null bodies and
//     non-castable dbId strings all land in the catch-all, which LEAKS err.message at a flat
//     500 (per-route fallback literals: "Notes parsing failed" / "Notes boundary proposal
//     failed" / "Spec parsing failed" / "Spec boundary proposal failed" / "Grid proposal
//     failed"). number/array bodies destructure to undefined → "Missing…" 400.
//   • All output strings ASCII (no em-dash/arrow anywhere in these 5 routes' bodies).
// Assertions tagged [S026 fold] flip in the fold commit (sanctioned diffs A/B/E only).
import { describe, expect, inject, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const h = vi.hoisted(() => ({
  parseNotesFromRegion: vi.fn(),
  bindSpecSectionsInRegion: vi.fn(),
  detectCsiFromGrid: vi.fn(),
  detectCsiCodes: vi.fn(),
  detectRowsAndColumns: vi.fn(),
}));

vi.mock("@/lib/text-region-classifier", () => ({ parseNotesFromRegion: h.parseNotesFromRegion }));
vi.mock("@/lib/specnote-parser", () => ({ bindSpecSectionsInRegion: h.bindSpecSectionsInRegion }));
vi.mock("@/lib/csi-detect", () => ({
  detectCsiFromGrid: h.detectCsiFromGrid,
  detectCsiCodes: h.detectCsiCodes,
}));
vi.mock("@/lib/ocr-grid-detect", () => ({ detectRowsAndColumns: h.detectRowsAndColumns }));

import { POST as notesPOST } from "@/app/api/notes-parse/route";
import { POST as notesProposePOST } from "@/app/api/notes-parse/propose/route";
import { POST as specPOST } from "@/app/api/spec-parse/route";
import { POST as specProposePOST } from "@/app/api/spec-parse/propose/route";
import { POST as tableProposePOST } from "@/app/api/table-parse/propose/route";
import {
  asUser,
  createCompany,
  createPage,
  createUser,
  createWorld,
  makeReq,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

type RouteFn = (req: Request) => Promise<Response>;
const ROUTES: Record<string, { fn: RouteFn; path: string }> = {
  notes: { fn: notesPOST, path: "/api/notes-parse" },
  notesPropose: { fn: notesProposePOST, path: "/api/notes-parse/propose" },
  spec: { fn: specPOST, path: "/api/spec-parse" },
  specPropose: { fn: specProposePOST, path: "/api/spec-parse/propose" },
  tablePropose: { fn: tableProposePOST, path: "/api/table-parse/propose" },
};
const LONG_BBOX_ROUTES = ["notes", "notesPropose", "spec", "specPropose"] as const;

const BBOX: [number, number, number, number] = [0.1, 0.1, 0.5, 0.5];
const LTWH_OF_BBOX = [0.1, 0.1, 0.4, 0.4]; // [x0, y0, x1-x0, y1-y0]
const TEXTRACT = { words: [{ text: "w1" }], lines: [{ text: "l1" }] };

const call = (r: { fn: RouteFn; path: string }, body: unknown) =>
  r.fn(makeReq(r.path, { body }));
const bodyFor = (projectId: unknown, over: Record<string, unknown> = {}) => ({
  projectId,
  pageNumber: 1,
  regionBbox: BBOX,
  ...over,
});

/** company + member + completed project + page 1 WITH textractData. */
async function world(projectOver: Record<string, unknown> = {}) {
  const w = await createWorld(projectOver);
  await createPage(w.project.id, 1, { textractData: TEXTRACT as never });
  return w;
}

const NOTES_GRID = {
  headers: ["#", "Note"],
  rows: [{ "#": "1", Note: "install per plan" }],
  rowBoundaries: [0.12, 0.2],
  colBoundaries: [0.18],
};
const SPEC_RESULT = {
  sections: [{ sectionHeader: "PART 1 — GENERAL", body: "1.01 scope." }],
  rowBoundaries: [0.33],
};
const GRID_PROPOSAL = {
  rowBoundaries: [0.15, 0.25],
  colBoundaries: [0.2],
  rows: [{ yCenter: 0.18 }, { yCenter: 0.28 }],
  cols: [{ center: 0.3 }],
  wordCount: 12,
  confidence: 0.8,
};

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
  h.parseNotesFromRegion.mockReturnValue(NOTES_GRID);
  h.bindSpecSectionsInRegion.mockReturnValue(SPEC_RESULT);
  h.detectCsiFromGrid.mockReturnValue([{ code: "09 00 00", description: "Finishes", trade: "finishes" }]);
  h.detectCsiCodes.mockReturnValue([{ code: "03 00 00", description: "Concrete", trade: "concrete" }]);
  h.detectRowsAndColumns.mockReturnValue(GRID_PROPOSAL);
});

describe.skipIf(!dbUp)("region-parse routes — shared validation cascade (PQ-1/PQ-2)", () => {
  it("truthy missing-field 400 on all 5 routes (incl. falsy-zero projectId/pageNumber)", async () => {
    for (const key of Object.keys(ROUTES)) {
      for (const b of [
        bodyFor(0), // falsy-zero projectId trips it
        { projectId: 1, regionBbox: BBOX }, // missing pageNumber
        { projectId: 1, pageNumber: 0, regionBbox: BBOX }, // falsy-zero pageNumber
        bodyFor(1, { regionBbox: [0.1, 0.1, 0.5] }), // length !== 4
      ]) {
        const { status, body } = await readJson(await call(ROUTES[key], b));
        expect(status, `${key}`).toBe(400);
        // [S026 fold: A applied — was flat]
        expect(body, `${key}`).toEqual({
          error: { code: "VALIDATION", message: "Missing projectId, pageNumber, or regionBbox" },
        });
      }
    }
  });

  it("bbox reject: LONG message on 4 routes, SHORT on table-parse/propose (PQ-2)", async () => {
    const bad = [
      [0.5, 0.1, 0.1, 0.5], // x0 >= x1
      [0.1, 0.1, Number.NaN, 0.5], // non-finite
      [0.1, 0.1, 1.5, 0.5], // out of [0,1]
    ];
    for (const bbox of bad) {
      for (const key of LONG_BBOX_ROUTES) {
        const { status, body } = await readJson(await call(ROUTES[key], bodyFor(1, { regionBbox: bbox })));
        expect(status, `${key}`).toBe(400);
        // [S026 fold: A applied]
        expect(body, `${key}`).toEqual({
          error: {
            code: "VALIDATION",
            message: "Invalid regionBbox: values must be finite numbers in [0,1] with min < max",
          },
        });
      }
      const { status, body } = await readJson(
        await call(ROUTES.tablePropose, bodyFor(1, { regionBbox: bbox })),
      );
      expect(status).toBe(400);
      // SHORT form — frozen drift [S026 fold: A applied]
      expect(body).toEqual({ error: { code: "VALIDATION", message: "Invalid regionBbox" } });
    }
  });

  it("validation fires BEFORE access: signed-out + missing field → 400 not 401", async () => {
    const { status } = await readJson(await call(ROUTES.notes, { projectId: 0 }));
    expect(status).toBe(400);
  });
});

describe.skipIf(!dbUp)("region-parse routes — access matrix (PQ-3)", () => {
  it("signed-out on non-demo → flat 401 'Unauthorized' (all 5)", async () => {
    const { project } = await world();
    for (const key of Object.keys(ROUTES)) {
      const { status, body } = await readJson(await call(ROUTES[key], bodyFor(project.id)));
      expect(status, key).toBe(401);
      expect(body, key).toEqual({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }); // [S026 fold: A applied]
    }
  });

  it("unknown dbId and NEGATIVE dbId → flat 404 'Not found' (miss before auth; int-guard DECLINED)", async () => {
    for (const pid of [999999999, -5]) {
      const { status, body } = await readJson(await call(ROUTES.notes, bodyFor(pid)));
      expect(status).toBe(404);
      expect(body).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } }); // [S026 fold: A applied]
    }
    const r = await readJson(await call(ROUTES.tablePropose, bodyFor(-5)));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } }); // [S026 fold: A applied]
  });

  it("cross-tenant authed → flat 404 'Not found'", async () => {
    const { project } = await world();
    const other = await createCompany();
    asUser(await createUser(other.id));
    for (const key of ["notes", "tablePropose"]) {
      const { status, body } = await readJson(await call(ROUTES[key], bodyFor(project.id)));
      expect(status, key).toBe(404);
      expect(body, key).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } }); // [S026 fold: A applied]
    }
  });

  it("PQ-3 divergence: demo+anon → 200 on the 4 allowDemo routes, 401 on table-parse/propose", async () => {
    const { project } = await world({ isDemo: true });
    for (const key of LONG_BBOX_ROUTES) {
      const { status } = await readJson(await call(ROUTES[key], bodyFor(project.id)));
      expect(status, `${key} allowDemo public read`).toBe(200);
    }
    const { status, body } = await readJson(await call(ROUTES.tablePropose, bodyFor(project.id)));
    expect(status).toBe(401); // NO allowDemo — pinned, do NOT add
    expect(body).toEqual({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }); // [S026 fold: A applied]
  });

  it("page without textractData → flat 404 'Page has no OCR data'", async () => {
    const { user, project } = await createWorld();
    await createPage(project.id, 1, {}); // no textractData
    asUser(user);
    for (const key of ["notes", "specPropose", "tablePropose"]) {
      const { status, body } = await readJson(await call(ROUTES[key], bodyFor(project.id)));
      expect(status, key).toBe(404);
      expect(body, key).toEqual({ error: { code: "NOT_FOUND", message: "Page has no OCR data" } }); // [S026 fold: A applied]
    }
  });
});

describe.skipIf(!dbUp)("shell error plumbing — sanctioned B/E (was legacy leaky catch-all)", () => {
  it("malformed → 400 BAD_REQUEST; empty/'null' → 400 VALIDATION", async () => {
    // [S026 fold: E applied — legacy req.json()/destructure threw INSIDE the try → the
    // catch-all LEAKED err.message at a flat 500. Shell body-parse now owns these.]
    const mk = (raw: string | undefined) =>
      new Request("http://test.local/api/notes-parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      });
    let r = await readJson(await notesPOST(mk("{oops")));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } });
    for (const raw of [undefined, "null"]) {
      r = await readJson(await notesPOST(mk(raw)));
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("VALIDATION");
    }
  });

  it("number/array bodies → 400 VALIDATION via zLooseBody", async () => {
    // [S026 fold: E applied — legacy destructured to undefined → flat "Missing…" 400.
    // Status preserved (400→400), message drifts to zod wording → code-only assert.]
    for (const raw of ["5", "[1]"]) {
      const req = new Request("http://test.local/api/spec-parse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      });
      const { status, body } = await readJson(await specPOST(req));
      expect(status).toBe(400);
      expect(body.error.code).toBe("VALIDATION");
    }
  });

  it("non-castable string projectId → pg cast throw → generic INTERNAL 500", async () => {
    // [S026 fold: B applied — legacy leaked the pg error message at a flat 500. An int
    // guard stays DECLINED (negative dbId must keep 404ing — pinned above).]
    const { status, body } = await readJson(await call(ROUTES.notes, bodyFor("not-a-number")));
    expect(status).toBe(500);
    expect(body).toEqual({ error: { code: "INTERNAL", message: "Internal server error" } });
  });

  it("engine throw → generic INTERNAL 500, leak dropped", async () => {
    // [S026 fold: B applied — legacy: {error:"engine exploded spectacularly"} flat 500.]
    const { user, project } = await world();
    asUser(user);
    h.parseNotesFromRegion.mockImplementation(() => {
      throw new Error("engine exploded spectacularly");
    });
    const { status, body } = await readJson(await call(ROUTES.notes, bodyFor(project.id)));
    expect(status).toBe(500);
    expect(body).toEqual({ error: { code: "INTERNAL", message: "Internal server error" } });
  });
});

describe.skipIf(!dbUp)("notes-parse — engine contract + response shapes (PQ-4/5/6/7)", () => {
  it("happy: LTWH conversion, autoSplitColumns default true, csiTags MAPPED to 2 keys", async () => {
    const { user, project } = await world();
    asUser(user);
    const { status, body } = await readJson(await call(ROUTES.notes, bodyFor(project.id)));
    expect(status).toBe(200);
    expect(h.parseNotesFromRegion).toHaveBeenCalledWith(
      TEXTRACT,
      LTWH_OF_BBOX,
      { autoSplitColumns: true }, // ?? true default
    );
    expect(h.detectCsiFromGrid).toHaveBeenCalledWith(NOTES_GRID.headers, NOTES_GRID.rows);
    expect(body).toEqual({
      headers: NOTES_GRID.headers,
      rows: NOTES_GRID.rows,
      rowBoundaries: NOTES_GRID.rowBoundaries,
      colBoundaries: NOTES_GRID.colBoundaries,
      csiTags: [{ code: "09 00 00", description: "Finishes" }], // trade DROPPED (PQ-5 mapping)
    });
  });

  it("autoSplitColumns:false passes through; boundaries-less grid drops the keys (PQ-7)", async () => {
    const { user, project } = await world();
    asUser(user);
    h.parseNotesFromRegion.mockReturnValue({ headers: ["#"], rows: [] });
    const { body } = await readJson(
      await call(ROUTES.notes, bodyFor(project.id, { autoSplitColumns: false })),
    );
    expect(h.parseNotesFromRegion).toHaveBeenCalledWith(TEXTRACT, LTWH_OF_BBOX, { autoSplitColumns: false });
    expect(Object.keys(body).sort()).toEqual(["csiTags", "headers", "rows"]); // undefined keys dropped
  });

  it("no-grid → note shape; CSI throw → non-fatal csiTags []", async () => {
    const { user, project } = await world();
    asUser(user);
    h.parseNotesFromRegion.mockReturnValue(undefined);
    let r = await readJson(await call(ROUTES.notes, bodyFor(project.id)));
    expect(r.body).toEqual({
      headers: [],
      rows: [],
      csiTags: [],
      note: "No numbered items detected in region",
    });
    h.parseNotesFromRegion.mockReturnValue(NOTES_GRID);
    h.detectCsiFromGrid.mockImplementation(() => {
      throw new Error("csi died");
    });
    r = await readJson(await call(ROUTES.notes, bodyFor(project.id)));
    expect(r.status).toBe(200);
    expect(r.body.csiTags).toEqual([]);
  });

  it("propose: boundaries → proposedRows/Cols; ??[] coalesce; no-grid → empty arrays (PQ-6)", async () => {
    const { user, project } = await world();
    asUser(user);
    let r = await readJson(await call(ROUTES.notesPropose, bodyFor(project.id)));
    expect(r.body).toEqual({ proposedRows: [0.12, 0.2], proposedCols: [0.18] });
    h.parseNotesFromRegion.mockReturnValue({ headers: [], rows: [] }); // no boundaries
    r = await readJson(await call(ROUTES.notesPropose, bodyFor(project.id)));
    expect(r.body).toEqual({ proposedRows: [], proposedCols: [] }); // ?? [] coalesce
    h.parseNotesFromRegion.mockReturnValue(null);
    r = await readJson(await call(ROUTES.notesPropose, bodyFor(project.id)));
    expect(r.body).toEqual({ proposedRows: [], proposedCols: [] });
    expect(h.detectCsiFromGrid).not.toHaveBeenCalled(); // propose has no CSI step
  });
});

describe.skipIf(!dbUp)("spec-parse — engine contract + response shapes (PQ-4/5/6)", () => {
  it("happy: engine gets LINES + LTWH + coerced flag; csiTags pass through UNMAPPED (PQ-5)", async () => {
    const { user, project } = await world();
    asUser(user);
    const { status, body } = await readJson(await call(ROUTES.spec, bodyFor(project.id)));
    expect(status).toBe(200);
    expect(h.bindSpecSectionsInRegion).toHaveBeenCalledWith(
      TEXTRACT.lines, // .lines, not the whole textractData
      LTWH_OF_BBOX,
      { includeSubSections: false }, // !!undefined
    );
    expect(h.detectCsiCodes).toHaveBeenCalledWith("PART 1 — GENERAL\n1.01 scope."); // join format
    expect(body).toEqual({
      sections: SPEC_RESULT.sections,
      rowBoundaries: SPEC_RESULT.rowBoundaries,
      csiTags: [{ code: "03 00 00", description: "Concrete", trade: "concrete" }], // UNMAPPED — trade kept
    });
  });

  it("no-result → note shape; includeSubSections truthy coercion", async () => {
    const { user, project } = await world();
    asUser(user);
    h.bindSpecSectionsInRegion.mockReturnValue(null);
    const r = await readJson(
      await call(ROUTES.spec, bodyFor(project.id, { includeSubSections: 1 })),
    );
    expect(h.bindSpecSectionsInRegion).toHaveBeenCalledWith(TEXTRACT.lines, LTWH_OF_BBOX, {
      includeSubSections: true, // !!1
    });
    expect(r.body).toEqual({
      sections: [],
      csiTags: [],
      note: "No spec section headers detected in region",
    });
  });

  it("CSI throw → non-fatal csiTags [] (DETECTOR F1 — pins spec-parse's inner catch)", async () => {
    const { user, project } = await world();
    asUser(user);
    h.detectCsiCodes.mockImplementation(() => {
      throw new Error("csi died");
    });
    const r = await readJson(await call(ROUTES.spec, bodyFor(project.id)));
    expect(r.status).toBe(200);
    expect(r.body.csiTags).toEqual([]);
    expect(r.body.sections).toEqual(SPEC_RESULT.sections); // parse itself unaffected
  });

  it("two-section bodyText: '\\n' inside a section, '\\n\\n' BETWEEN sections (DETECTOR F2, PQ-5)", async () => {
    const { user, project } = await world();
    asUser(user);
    h.bindSpecSectionsInRegion.mockReturnValue({
      sections: [
        { sectionHeader: "H1", body: "b1" },
        { sectionHeader: "H2", body: "b2" },
      ],
      rowBoundaries: [0.2, 0.4],
    });
    await call(ROUTES.spec, bodyFor(project.id));
    expect(h.detectCsiCodes).toHaveBeenCalledWith("H1\nb1\n\nH2\nb2");
  });

  it("propose: {proposedRows: rowBoundaries ?? []}; null → []; no CSI step", async () => {
    const { user, project } = await world();
    asUser(user);
    let r = await readJson(await call(ROUTES.specPropose, bodyFor(project.id)));
    expect(r.body).toEqual({ proposedRows: [0.33] });
    h.bindSpecSectionsInRegion.mockReturnValue({ sections: [{ sectionHeader: "P", body: "b" }] });
    r = await readJson(await call(ROUTES.specPropose, bodyFor(project.id)));
    expect(r.body).toEqual({ proposedRows: [] });
    h.bindSpecSectionsInRegion.mockReturnValue(null);
    r = await readJson(await call(ROUTES.specPropose, bodyFor(project.id)));
    expect(r.body).toEqual({ proposedRows: [] });
    expect(h.detectCsiCodes).not.toHaveBeenCalled();
  });
});

describe.skipIf(!dbUp)("table-parse/propose — engine contract + 8-key shape (PQ-4/PQ-6)", () => {
  it("happy: engine gets WORDS + MinMax bbox UNCONVERTED + hint/options; 8-key response", async () => {
    const { user, project } = await world();
    asUser(user);
    const layoutHint = { columns: 3, tagColumnPosition: "left" };
    const gridOptions = { rowTolerance: 0.01 };
    const { status, body } = await readJson(
      await call(ROUTES.tablePropose, bodyFor(project.id, { layoutHint, gridOptions })),
    );
    expect(status).toBe(200);
    expect(h.detectRowsAndColumns).toHaveBeenCalledWith(
      TEXTRACT.words,
      BBOX, // MinMax passed through — NO LTWH conversion (unlike notes/spec)
      layoutHint,
      gridOptions,
    );
    expect(body).toEqual({
      proposedRows: [0.15, 0.25],
      proposedCols: [0.2],
      rowCenters: [0.18, 0.28],
      colCenters: [0.3],
      rowCount: 2,
      colCount: 1,
      wordCount: 12,
      confidence: 0.8,
    });
  });

  it("degraded proposal → STILL the 8-key shape (no early return, PQ-6)", async () => {
    const { user, project } = await world();
    asUser(user);
    h.detectRowsAndColumns.mockReturnValue({
      rowBoundaries: [],
      colBoundaries: [],
      rows: [],
      cols: [],
      wordCount: 2,
      confidence: 0,
    });
    const { body } = await readJson(await call(ROUTES.tablePropose, bodyFor(project.id)));
    expect(body).toEqual({
      proposedRows: [],
      proposedCols: [],
      rowCenters: [],
      colCenters: [],
      rowCount: 0,
      colCount: 0,
      wordCount: 2,
      confidence: 0,
    });
  });
});
