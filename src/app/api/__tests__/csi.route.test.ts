// @vitest-environment node
// [refactor jul6 S032] CHARACTERIZATION for the CSI pair (GET /api/csi aggregate +
// POST /api/csi/detect), written as THE FREEZE before the P1.5 fold onto services/csi.ts.
// ⚠️ FOLD-ONLY: the CSI TAGGING REBUILD is a P2 sub-project ([[csi-rebuild-placement]]) —
// this freeze pins today's behavior byte-faithfully; no redesign here. The csi-detect
// ENGINE is mocked (route contract only). Frozen:
//   • CQ-1 GET /api/csi: requireAuth-first (signed-out 401 flat) → raw SQL aggregate:
//     company-scoped, status='completed' only, jsonb_array_elements over pages.csi_codes,
//     GROUP BY code ([csi-v2 S6] key only), ORDER BY page_count DESC, LIMIT 200 → BARE-ARRAY response of
//     {code,description,trade,division,projectCount,pageCount,projectIds,projectSheetCounts}
//     (sheetCounts = per-project fanout of the non-DISTINCT aggregation).
//   • CQ-2 detect is PUBLIC (deliberate — pure local matching; docs call it the public
//     entry; the legacy file imports auth but NEVER CALLS it — dead import, dropped at
//     fold). Mode cascade: GRID (body.headers && body.rows truthy) WINS over TEXT when
//     both present; TEXT requires typeof body.text === "string" (text:123 falls through);
//     neither → flat 400 "Provide either { text: string } or { headers: string[], rows:
//     Record<string,string>[] }". Both modes map engine output to 2-key {code,description}
//     and pass body.config through (detectCsiFromGrid(h,r,config) /
//     detectCsiCodes(text, undefined, config) — the undefined middle arg pinned).
//   • CQ-3 legacy error plumbing: req.json INSIDE the try → malformed/empty bodies land in
//     the catch-all which LEAKS err.message at flat 500 ("CSI detection failed" fallback);
//     'null' body → body.headers TypeError → same leak; engine throws leak too. All flip
//     to sanctioned E/B at fold. Non-object JSON (number/array) at legacy: destructure-free
//     property reads give undefined → flat 400 "Provide either..." (→ zLooseBody VALIDATION
//     400 at fold; status preserved, msg drift = E).
// Assertions tagged [S032 fold] flip in the fold commit (sanctioned A/B/E only).
import { describe, expect, inject, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const h = vi.hoisted(() => ({
  detectCsiCodes: vi.fn(),
  detectCsiFromGrid: vi.fn(),
}));
vi.mock("@/lib/csi-detect", () => ({
  detectCsiCodes: h.detectCsiCodes,
  detectCsiFromGrid: h.detectCsiFromGrid,
}));

import { GET as csiGET } from "@/app/api/csi/route";
import { POST as detectPOST } from "@/app/api/csi/detect/route";
import {
  asUser,
  createCompany,
  createPage,
  createProject,
  createUser,
  createWorld,
  makeReq,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const TAG = { code: "09 00 00", description: "Finishes", trade: "finishes", division: "09" };
const callDetect = (b: unknown) => detectPOST(makeReq("/api/csi/detect", { body: b }));

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
  h.detectCsiCodes.mockReturnValue([TAG]);
  h.detectCsiFromGrid.mockReturnValue([TAG]);
});

describe.skipIf(!dbUp)("GET /api/csi — company aggregate (CQ-1)", () => {
  it("signed-out → flat 401", async () => {
    const { status, body } = await readJson(await csiGET(makeReq("/api/csi", { method: "GET" })));
    expect(status).toBe(401);
    expect(body).toEqual({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }); // [S032 fold: A applied]
  });

  it("aggregates company-scoped completed projects; bare array; sheetCounts fanout; DESC order", async () => {
    const { company, user, project } = await createWorld(); // completed by default
    const CSI_A = [{ code: "09 00 00", description: "Finishes", trade: "fin", division: "09" }];
    const CSI_B = [{ code: "03 00 00", description: "Concrete", trade: "con", division: "03" }];
    await createPage(project.id, 1, { csiCodes: CSI_A as never });
    await createPage(project.id, 2, { csiCodes: CSI_A as never }); // same code twice → pageCount 2, sheetCount 2
    await createPage(project.id, 3, { csiCodes: CSI_B as never });
    // same-company second completed project shares code A → projectCount 2
    const p2 = await createProject(company.id, user.id);
    await createPage(p2.id, 1, { csiCodes: CSI_A as never });
    // non-completed project must be EXCLUDED
    const pDraft = await createProject(company.id, user.id, { status: "processing" } as never);
    await createPage(pDraft.id, 1, { csiCodes: CSI_A as never });
    // other company must be EXCLUDED
    const otherW = await createWorld();
    await createPage(otherW.project.id, 1, { csiCodes: CSI_A as never });

    asUser(user);
    const { status, body } = await readJson(await csiGET(makeReq("/api/csi", { method: "GET" })));
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true); // bare array (no envelope)
    const mine = body.filter((r: { code: string }) => ["09 00 00", "03 00 00"].includes(r.code));
    const a = mine.find((r: { code: string }) => r.code === "09 00 00");
    const b = mine.find((r: { code: string }) => r.code === "03 00 00");
    expect(a).toMatchObject({ description: "Finishes", trade: "fin", division: "09", projectCount: 2, pageCount: 3 });
    expect(a.projectIds.sort()).toEqual([project.publicId, p2.publicId].sort());
    expect(a.projectSheetCounts[project.publicId]).toBe(2); // fanout of the non-DISTINCT agg
    expect(a.projectSheetCounts[p2.publicId]).toBe(1);
    expect(b).toMatchObject({ projectCount: 1, pageCount: 1 });
    // ORDER BY page_count DESC → A before B among our rows
    expect(body.indexOf(a)).toBeLessThan(body.indexOf(b));
  });

  // [csi-v2 S6] GROUP BY code only, keyed like csiDedupeKey. Measured pre-S6 (c6ad951): these four
  // pages gave THREE rows (unspaced legacy, spaced v2, and the YOLO placeholder split by division).
  it("one row per code across stored formats and differing description/trade/division", async () => {
    const { user, project } = await createWorld();
    const legacy = { code: "084113", description: "entrances and storefronts", trade: "Openings", division: "08 00 00" };
    const v2 = { code: "08 41 13", description: "Aluminum-Framed Entrances and Storefronts", trade: "Openings", division: "08 00 00", confidence: 0.9 };
    const yolo = { code: "08 41 13", description: "From YOLO class config", trade: "", division: "08" };
    await createPage(project.id, 1, { csiCodes: [legacy] as never });
    await createPage(project.id, 2, { csiCodes: [v2] as never });
    await createPage(project.id, 3, { csiCodes: [v2] as never });
    await createPage(project.id, 4, { csiCodes: [yolo] as never });

    asUser(user);
    const { status, body } = await readJson(await csiGET(makeReq("/api/csi", { method: "GET" })));
    expect(status).toBe(200);
    const rows = body.filter((r: { code: string }) => r.code.replace(/\s/g, "") === "084113");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      code: "08 41 13", // spaced form preferred (MIN under "C" collation)
      description: "Aluminum-Framed Entrances and Storefronts", // most frequent
      trade: "Openings",
      division: "08 00 00",
      projectCount: 1,
      pageCount: 4,
    });
    expect(rows[0].projectSheetCounts[project.publicId]).toBe(4);
  });
});

describe.skipIf(!dbUp)("POST /api/csi/detect — public 3-tier entry (CQ-2/CQ-3)", () => {
  // [hardening sep30] config passthrough RETIRED on purpose: no client sends it, and on a public
  // route `{"matchingConfidenceThreshold":-1}` turns a 66-byte request into a 0.6 MB response.
  it("PUBLIC: works signed-out; text mode maps to 2-key; caller config is NOT forwarded", async () => {
    const { status, body } = await readJson(await callDetect({ text: "concrete slab", config: { tier: 2 } }));
    expect(status).toBe(200);
    expect(body).toEqual({ csiTags: [{ code: "09 00 00", description: "Finishes" }] }); // trade/division DROPPED
    expect(h.detectCsiCodes).toHaveBeenCalledWith("concrete slab");
  });

  it("grid mode; grid WINS when both grid and text present (CQ-2 precedence)", async () => {
    const { body } = await readJson(
      await callDetect({ headers: ["Tag"], rows: [{ Tag: "A1" }], text: "also here", config: { x: 1 } }),
    );
    expect(body).toEqual({ csiTags: [{ code: "09 00 00", description: "Finishes" }] });
    expect(h.detectCsiFromGrid).toHaveBeenCalledWith(["Tag"], [{ Tag: "A1" }]); // config not forwarded
    expect(h.detectCsiCodes).not.toHaveBeenCalled();
  });

  it("neither mode (incl. text:123 typeof guard, headers-without-rows) → flat 400 long message", async () => {
    for (const b of [{}, { text: 123 }, { headers: ["Tag"] }, { rows: [{}] }]) {
      const { status, body } = await readJson(await callDetect(b));
      expect(status).toBe(400);
      expect(body).toEqual({
        error: { code: "VALIDATION", message: "Provide either { text: string } or { headers: string[], rows: Record<string,string>[] }" },
      }); // [S032 fold: A applied]
    }
  });

  it("CQ-3: malformed/empty/'null' bodies → catch-all LEAKS err.message at flat 500", async () => {
    // [S032 fold: E — malformed → 400 BAD_REQUEST "Invalid JSON body"; empty/'null' → 400 VALIDATION]
    const mk = (raw: string | undefined) =>
      new Request("http://test.local/api/csi/detect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      });
    let r = await readJson(await detectPOST(mk("{oops")));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } });
    for (const raw of [undefined, "null"]) {
      r = await readJson(await detectPOST(mk(raw)));
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("VALIDATION");
    } // [S032 fold: E applied — was leaky flat 500s]
  });

  it("engine throw → leaky flat 500", async () => {
    // [S032 fold: B — shell generic INTERNAL 500; leak dropped]
    h.detectCsiCodes.mockImplementation(() => {
      throw new Error("tier table corrupted");
    });
    const { status, body } = await readJson(await callDetect({ text: "x" }));
    expect(status).toBe(500);
    expect(body).toEqual({ error: { code: "INTERNAL", message: "Internal server error" } }); // [S032 fold: B applied — leak dropped]
  });
});

// [hardening sep30] The route is public and the matcher is synchronous and linear in input size.
describe("POST /api/csi/detect — input bounds", () => {
  const tooLarge = { error: { code: "VALIDATION", message: "Input too large (max 20000 characters)" } };
  const neither = {
    error: {
      code: "VALIDATION",
      message: "Provide either { text: string } or { headers: string[], rows: Record<string,string>[] }",
    },
  };

  it("signed-out text over the cap → 400 and the matcher never runs", async () => {
    signedOut();
    const { status, body } = await readJson(await callDetect({ text: "a ".repeat(12_000) }));
    expect(status).toBe(400);
    expect(body).toEqual(tooLarge);
    expect(h.detectCsiCodes).not.toHaveBeenCalled();
  });

  it("signed-out grid over the cap → 400 and the matcher never runs", async () => {
    signedOut();
    const rows = Array.from({ length: 250 }, () => ({ a: "x".repeat(100) }));
    const { status, body } = await readJson(await callDetect({ headers: ["a"], rows }));
    expect(status).toBe(400);
    expect(body).toEqual(tooLarge);
    expect(h.detectCsiFromGrid).not.toHaveBeenCalled();
  });

  it("text at the cap is accepted signed-out", async () => {
    signedOut();
    h.detectCsiCodes.mockReturnValue([]);
    const { status } = await readJson(await callDetect({ text: "x".repeat(20_000) }));
    expect(status).toBe(200);
  });

  it("a signed-in caller may send a large schedule, up to the signed-in cap", async () => {
    asUser({ id: 1, companyId: 1, username: "u", email: "u@test.local" } as never);
    h.detectCsiFromGrid.mockReturnValue([]);
    const rows = Array.from({ length: 2_000 }, () => ({ a: "x".repeat(100) })); // 200,000 chars
    expect((await readJson(await callDetect({ headers: ["a"], rows }))).status).toBe(200);
    const over = Array.from({ length: 2_600 }, () => ({ a: "x".repeat(100) })); // 260,000 chars
    expect((await readJson(await callDetect({ headers: ["a"], rows: over }))).body).toEqual(tooLarge);
  });

  // A string passes `body.headers && body.rows` and then spreads to characters in the matcher:
  // an uncounted 250 KB string blocked the event loop for ~11 s (measured).
  it("a grid that is not arrays of strings is refused, never measured as zero", async () => {
    signedOut();
    for (const bad of [
      { headers: ["x"], rows: "a".repeat(1_000) },
      { headers: "a".repeat(1_000), rows: [{}] },
      { headers: ["x"], rows: [["a", "b"]] },
      { headers: ["x"], rows: [{ a: { nested: "x" } }] },
      { headers: [1, 2], rows: [{ a: "b" }] },
    ]) {
      const { status, body } = await readJson(await callDetect(bad));
      expect(status).toBe(400);
      expect(body).toEqual(neither);
    }
    expect(h.detectCsiFromGrid).not.toHaveBeenCalled();
  });
});
