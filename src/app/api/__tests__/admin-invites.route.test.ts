// @vitest-environment node
// [refactor jul6 S042] CHARACTERIZATION for the admin/invites SOLO (GET list + PUT
// mark-all-seen), written as THE FREEZE before the fold onto services/invites.ts. Solo (own
// DETECTOR). requireAdmin (admin OR root passes; member 403; signed-out 401). GET →
// {requests: inviteRequests DESC createdAt, unseenCount: count(!seen)}. PUT (NO body) →
// update seen:true WHERE seen:false → {success:true}. No request body on either method →
// ZERO E; no catch-500 literal → NO B. Assertions tagged [S042 fold] flip in the fold commit
// (sanctioned A only — flipped onto services/invites.ts).
import { describe, expect, inject, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET as invGET, PUT as invPUT } from "@/app/api/admin/invites/route";
import { db } from "@/lib/db";
import { inviteRequests } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { asUser, createCompany, createUser, makeReq, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

async function makeAdmin() {
  const company = await createCompany();
  const admin = await createUser(company.id, { role: "admin" });
  const member = await createUser(company.id);
  const root = await createUser(company.id, { isRootAdmin: true });
  return { company, admin, member, root };
}

// invites are GLOBAL (not company-scoped) and the test DB is shared across parallel files, so
// assert on OUR uniquely-tagged rows + the self-consistent unseenCount contract, never a
// global absolute count.
const tag = () => Math.random().toString(36).slice(2, 10);
const getReq = () => makeReq("/api/admin/invites", { method: "GET" });
const putReq = () => makeReq("/api/admin/invites", { method: "PUT" });
const UNAUTH = { error: { code: "UNAUTHORIZED", message: "Unauthorized" } }; // [S042 fold: A applied]
const ADMIN_ONLY = { error: { code: "FORBIDDEN", message: "Admin only" } }; // [S042 fold: A applied]

beforeEach(() => { vi.clearAllMocks(); signedOut(); });

describe.skipIf(!dbUp)("admin/invites (INV)", () => {
  it("INV-1 GET auth: signed-out→401, member→403, admin+root→200", async () => {
    const { admin, member, root } = await makeAdmin();
    let r = await readJson(await invGET(getReq()));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S042 fold: A applied]
    asUser(member);
    r = await readJson(await invGET(getReq()));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S042 fold: A applied]
    asUser(admin);
    expect((await readJson(await invGET(getReq()))).status).toBe(200);
    asUser(root); // root bypasses the role check too
    expect((await readJson(await invGET(getReq()))).status).toBe(200);
  });

  it("INV-2 GET: requests DESC createdAt + self-consistent unseenCount", async () => {
    const { admin } = await makeAdmin();
    const t = tag();
    const [eA, eB, eC] = [`a-${t}@x.test`, `b-${t}@x.test`, `c-${t}@x.test`];
    await db.insert(inviteRequests).values({ email: eA, seen: false });
    await db.insert(inviteRequests).values({ email: eB, seen: true });
    await db.insert(inviteRequests).values({ email: eC, seen: false });
    asUser(admin);
    const r = await readJson(await invGET(getReq()));
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.requests)).toBe(true);
    // the route computes unseenCount = requests.filter(!seen).length — pin that invariant
    // (robust to other files' global invites in the shared DB)
    expect(r.body.unseenCount).toBe(r.body.requests.filter((x: { seen: boolean }) => !x.seen).length);
    // OUR 3 rows: a,c unseen; b seen
    const mine = r.body.requests.filter((x: { email: string }) => [eA, eB, eC].includes(x.email));
    expect(mine).toHaveLength(3);
    expect(mine.filter((x: { seen: boolean }) => !x.seen).map((x: { email: string }) => x.email).sort()).toEqual([eA, eC].sort());
    // DESC createdAt: c inserted after a → c before a in the response
    const emails = r.body.requests.map((x: { email: string }) => x.email);
    expect(emails.indexOf(eC)).toBeLessThan(emails.indexOf(eA));
  });

  it("INV-3 PUT auth: signed-out→401, member→403", async () => {
    const { member } = await makeAdmin();
    let r = await readJson(await invPUT(putReq()));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S042 fold: A applied]
    asUser(member);
    r = await readJson(await invPUT(putReq()));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S042 fold: A applied]
  });

  it("INV-4 PUT: marks ALL unseen requests seen → {success:true}; OUR rows then seen", async () => {
    const { admin } = await makeAdmin();
    const t = tag();
    const [eD, eE] = [`d-${t}@x.test`, `e-${t}@x.test`];
    await db.insert(inviteRequests).values({ email: eD, seen: false });
    await db.insert(inviteRequests).values({ email: eE, seen: false });
    asUser(admin);
    const r = await readJson(await invPUT(putReq()));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    // our two rows are now seen (the update is global WHERE seen=false — assert on ours,
    // robust to concurrent inserts from other files)
    const ours = await db.select().from(inviteRequests).where(eq(inviteRequests.email, eD));
    expect(ours[0].seen).toBe(true);
    const ours2 = await db.select().from(inviteRequests).where(eq(inviteRequests.email, eE));
    expect(ours2[0].seen).toBe(true);
  });
});
