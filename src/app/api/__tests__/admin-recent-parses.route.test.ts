// @vitest-environment node
// [refactor jul6 S044] CHARACTERIZATION for the admin/recent-parses SOLO (GET ring-buffer +
// DELETE clear), written as THE FREEZE before the fold onto services/recent-parses.ts. Solo.
// requireAdmin (admin OR root passes; member 403; signed-out 401). Backed by an IN-MEMORY
// ring buffer (@/lib/parse-history), NOT the db. GET → {entries: getHistory(), count:
// entries.length, maxEntries: getMaxEntries()}. DELETE → clearHistory() → {ok:true}. No
// request body on either method → ZERO E; no catch-500 literal → NO B. Uses the REAL ring
// buffer (per-worker singleton) — seed via addToHistory, isolate via clearHistory in
// beforeEach. Assertions tagged [S044 fold] flip in the fold commit (sanctioned A only).
import { describe, expect, inject, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET as rpGET, DELETE as rpDELETE } from "@/app/api/admin/recent-parses/route";
import { addToHistory, clearHistory, getHistory, getMaxEntries } from "@/lib/parse-history";
import { asUser, createCompany, createUser, makeReq, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

async function makeAdmin() {
  const company = await createCompany();
  const admin = await createUser(company.id, { role: "admin" });
  const member = await createUser(company.id);
  const root = await createUser(company.id, { isRootAdmin: true });
  return { admin, member, root };
}

const getReq = () => makeReq("/api/admin/recent-parses", { method: "GET" });
const delReq = () => makeReq("/api/admin/recent-parses", { method: "DELETE" });
const UNAUTH = { error: { code: "UNAUTHORIZED", message: "Unauthorized" } }; // [S044 fold: A applied]
const ADMIN_ONLY = { error: { code: "FORBIDDEN", message: "Admin only" } }; // [S044 fold: A applied]

const seed = (id: string) =>
  addToHistory({ id, timestamp: 0, requestType: "table", methodResults: [] } as never);

beforeEach(() => { vi.clearAllMocks(); signedOut(); clearHistory(); });

describe.skipIf(!dbUp)("admin/recent-parses (RP)", () => {
  it("RP-1 GET auth: signed-out→401, member→403, admin+root→200", async () => {
    const { admin, member, root } = await makeAdmin();
    let r = await readJson(await rpGET(getReq()));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S044 fold: A applied]
    asUser(member);
    r = await readJson(await rpGET(getReq()));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S044 fold: A applied]
    asUser(admin);
    expect((await readJson(await rpGET(getReq()))).status).toBe(200);
    asUser(root);
    expect((await readJson(await rpGET(getReq()))).status).toBe(200);
  });

  it("RP-2 GET: {entries, count, maxEntries} from the ring buffer", async () => {
    const { admin } = await makeAdmin();
    seed("p1");
    seed("p2");
    asUser(admin);
    const r = await readJson(await rpGET(getReq()));
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.entries)).toBe(true);
    expect(r.body.count).toBe(r.body.entries.length); // count = entries.length
    expect(r.body.count).toBe(2);
    expect(r.body.entries.map((e: { id: string }) => e.id).sort()).toEqual(["p1", "p2"]);
    expect(r.body.maxEntries).toBe(getMaxEntries()); // pinned to the lib's cap
  });

  it("RP-3 DELETE auth: signed-out→401, member→403", async () => {
    const { member } = await makeAdmin();
    let r = await readJson(await rpDELETE(delReq()));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S044 fold: A applied]
    asUser(member);
    r = await readJson(await rpDELETE(delReq()));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S044 fold: A applied]
  });

  it("RP-4 DELETE: clears the ring buffer → {ok:true}", async () => {
    const { admin } = await makeAdmin();
    seed("p3");
    asUser(admin);
    const r = await readJson(await rpDELETE(delReq()));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true }); // note: DELETE returns {ok:true}, GET-family uses different keys
    expect(getHistory()).toHaveLength(0); // buffer cleared
  });
});
