// @vitest-environment node
// [2026-10-23] GET /api/admin/reprocess/scope — the dry count behind Admin › Pipeline › Reprocess "All".
// POST /api/admin/reprocess with no projectIds processes every NON-DEMO project of the caller's OWN
// company, ANY status; the Pipeline tab lists completed projects (root: all companies), so it showed a
// different number (owner: 216 listed vs 128 processed). This pins the dry count to the POST stream's
// own `start` count over a mixed world, and its auth to the POST route's (auth:"admin").
import { beforeEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET as scopeGET } from "@/app/api/admin/reprocess/scope/route";
import { POST as reprocessPOST } from "@/app/api/admin/reprocess/route";
import { asUser, createCompany, createProject, createUser, makeReq, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;
const scope = () => scopeGET(makeReq("/api/admin/reprocess/scope", { method: "GET" }));

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
});

describe.skipIf(!dbUp)("GET /api/admin/reprocess/scope", () => {
  it("auth matches POST /api/admin/reprocess: signed-out 401, member 403, company admin and root 200", async () => {
    const company = await createCompany();
    expect((await scope()).status).toBe(401);
    asUser(await createUser(company.id));
    expect((await scope()).status).toBe(403);
    asUser(await createUser(company.id, { role: "admin" }));
    expect((await scope()).status).toBe(200);
    asUser(await createUser(company.id, { isRootAdmin: true }));
    expect((await scope()).status).toBe(200);
  });

  it("counts own-company non-demo projects of ANY status — exactly the POST stream's start count", async () => {
    const company = await createCompany();
    const root = await createUser(company.id, { role: "admin", isRootAdmin: true });
    for (const status of ["completed", "completed", "error", "processing", "uploading"] as const) {
      await createProject(company.id, root.id, { status });
    }
    await createProject(company.id, root.id, { status: "completed", isDemo: true }); // demo: never reprocessed
    const other = await createCompany();
    await createProject(other.id, (await createUser(other.id)).id, { status: "completed" }); // other company

    asUser(root);
    const r = await readJson(await scope());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      companyId: company.id,
      companyName: company.name,
      projects: 5,
      byStatus: { completed: 2, error: 1, processing: 1, uploading: 1 },
    });

    const res = await reprocessPOST(makeReq("/api/admin/reprocess?scope=intelligence", { method: "POST" }));
    const lines = (await res.text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({ type: "start", projects: r.body.projects });
  }, 30_000);
});
