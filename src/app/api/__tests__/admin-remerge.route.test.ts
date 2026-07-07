// @vitest-environment node
// [refactor jul7 S050] CHARACTERIZATION for the admin/remerge SOLO (POST — re-run mergeGrids
// against stored MethodResult[]), written as THE FREEZE before the fold onto
// services/remerge.ts. Solo. requireAdmin. Frozen quirk inventory:
//   • body = req.json().catch(()=>null) GRACEFUL; !body || typeof body!=="object" → 400
//     "body must be JSON" (apiError flat). {results, options} = body; !Array.isArray(results)
//     → 400 "results must be an array of MethodResult". mergeGrids(results, options) →
//     NextResponse.json(merged) = BARE (whatever mergeGrids returns).
//   • mergeGrids is a pure @/lib/grid-merger fn — mocked here to control output + assert args.
// Body IS read → E applies at fold (malformed + non-object → shell). No catch-500 → NO B.
// Assertions tagged [S050 fold: … applied] were flipped in the fold commit onto
// services/remerge.ts (sanctioned A/E only).
import { describe, expect, inject, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const h = vi.hoisted(() => ({ mergeGrids: vi.fn() }));
vi.mock("@/lib/grid-merger", () => ({ mergeGrids: h.mergeGrids }));

import { POST as rmPOST } from "@/app/api/admin/remerge/route";
import { createCompany, createUser, asUser, makeReq, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

async function makeAdmin() {
  const company = await createCompany();
  const admin = await createUser(company.id, { role: "admin" });
  const member = await createUser(company.id);
  const root = await createUser(company.id, { isRootAdmin: true });
  return { admin, member, root };
}

const post = (body: unknown) => makeReq("/api/admin/remerge", { method: "POST", body });
const rawPost = (raw?: string) =>
  new Request("http://test.local/api/admin/remerge", { method: "POST", headers: { "content-type": "application/json" }, body: raw });
const UNAUTH = { error: { code: "UNAUTHORIZED", message: "Unauthorized" } }; // [S050 fold: A applied]
const ADMIN_ONLY = { error: { code: "FORBIDDEN", message: "Admin only" } }; // [S050 fold: A applied]

beforeEach(() => { vi.clearAllMocks(); signedOut(); h.mergeGrids.mockReturnValue({ merged: true, rows: 3 }); });

describe.skipIf(!dbUp)("admin/remerge (RM)", () => {
  it("RM-1 auth: signed-out→401, member→403, admin+root pass", async () => {
    const { admin, member, root } = await makeAdmin();
    let r = await readJson(await rmPOST(post({ results: [] })));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S050 fold: A applied]
    asUser(member);
    r = await readJson(await rmPOST(post({ results: [] })));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S050 fold: A applied]
    asUser(admin);
    expect((await readJson(await rmPOST(post({ results: [] })))).status).toBe(200);
    asUser(root);
    expect((await readJson(await rmPOST(post({ results: [] })))).status).toBe(200);
  });

  it("RM-2 non-object body → 400 'body must be JSON'", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    // legacy: scalar/null body → typeof !== "object" → "body must be JSON"
    // [S050 fold: E — scalar/null on zLooseBody → 400 VALIDATION generic; malformed → BAD_REQUEST]
    let r = await readJson(await rmPOST(rawPost("5")));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("VALIDATION"); // [S050 fold: E applied — non-object → generic zod VALIDATION]
    // malformed JSON → shell BAD_REQUEST (pre-auth)
    r = await readJson(await rmPOST(rawPost("{oops")));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } });
  });

  it("RM-3 results not an array → 400 'results must be an array of MethodResult'", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    for (const body of [{}, { results: "x" }, { results: 5 }, { options: {} }]) {
      const r = await readJson(await rmPOST(post(body)));
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: { code: "VALIDATION", message: "results must be an array of MethodResult" } }); // [S050 fold: A applied]
    }
    expect(h.mergeGrids).not.toHaveBeenCalled(); // no merge on invalid input
  });

  it("RM-4 happy: mergeGrids(results, options) → BARE merged result", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    const results = [{ method: "camelot", grids: [] }];
    const options = { editDistanceThreshold: 2 };
    const r = await readJson(await rmPOST(post({ results, options })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ merged: true, rows: 3 }); // BARE mergeGrids output, not enveloped
    expect(h.mergeGrids).toHaveBeenCalledWith(results, options); // args passed through
  });
});
