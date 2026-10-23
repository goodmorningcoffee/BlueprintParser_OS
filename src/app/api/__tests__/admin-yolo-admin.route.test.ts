// @vitest-environment node
// [refactor jul7 S049] CHARACTERIZATION for the 2 orphan YOLO-admin routes (yolo-status GET +
// yolo-purge DELETE) — DR005 GAP-1: these were UNACCOUNTED in the plan/memories and never
// queued. Freeze before the fold onto services/yolo-admin.ts. Both requireAdmin (admin OR
// root passes; member 403; signed-out 401), both raw-SQL, both company-SCOPED, no body.
//   • yolo-status GET → SELECT project public_id + (data->>'modelId')::int + COUNT, WHERE
//     source='yolo' AND company_id=session, GROUP BY → nested BARE object
//     {projectPublicId: {modelId: detectionCount}}.
//   • yolo-purge DELETE → DELETE annotations WHERE source='yolo' AND project_id IN (company's
//     projects) → {deleted: rowCount}. A destructive write, company-scoped (tenancy-safe).
// No body on either → ZERO E; no catch-500 literal → NO B; sanctioned diff A only.
// Assertions tagged [S049 fold: … applied] were flipped in the fold commit onto
// services/yolo-admin.ts.
// [2026-10-23] Both routes are auth:"root" now (owner: YOLO controls are root-only) — a company admin
// gets 403 "Root admin only". yolo-status for a root session spans ALL companies (the root project
// list does); purge stays company-scoped.
import { describe, expect, inject, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET as ysGET } from "@/app/api/admin/yolo-status/route";
import { DELETE as ypDELETE } from "@/app/api/admin/yolo-purge/route";
import { db } from "@/lib/db";
import { annotations } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { asUser, createCompany, createUser, createProject, makeReq, readJson, sessionState, signedOut } from "@/test/harness";
import { getYoloStatus } from "@/server/services/yolo-admin";

const dbUp = inject("dbUp") as boolean;

async function makeWorld() {
  const company = await createCompany();
  const admin = await createUser(company.id, { role: "admin" });
  const member = await createUser(company.id);
  const root = await createUser(company.id, { isRootAdmin: true });
  const author = await createUser(company.id);
  return { company, admin, member, root, author };
}

const statusReq = () => makeReq("/api/admin/yolo-status", { method: "GET" });
const purgeReq = () => makeReq("/api/admin/yolo-purge", { method: "DELETE" });
const UNAUTH = { error: { code: "UNAUTHORIZED", message: "Unauthorized" } }; // [S049 fold: A applied]
const ROOT_ONLY = { error: { code: "FORBIDDEN", message: "Root admin only" } }; // [2026-10-23] auth:"root"

async function seedYolo(projectId: number, modelId: number, over: Partial<typeof annotations.$inferInsert> = {}) {
  await db.insert(annotations).values({
    name: `det-${modelId}`, minX: 0, maxX: 1, minY: 0, maxY: 1, pageNumber: 1, projectId,
    source: "yolo", data: { modelId } as never, ...over,
  });
}
async function annCount(projectId: number) {
  const rows = await db.select().from(annotations).where(eq(annotations.projectId, projectId));
  return rows.length;
}

beforeEach(() => { vi.clearAllMocks(); signedOut(); });

describe.skipIf(!dbUp)("admin/yolo-status (YS)", () => {
  it("YS-1 auth: signed-out→401, member+admin→403, root→200", async () => {
    const { admin, member, root } = await makeWorld();
    let r = await readJson(await ysGET(statusReq()));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S049 fold: A applied]
    for (const actor of [member, admin]) {
      asUser(actor);
      r = await readJson(await ysGET(statusReq()));
      expect(r.status).toBe(403);
      expect(r.body).toEqual(ROOT_ONLY);
    }
    asUser(root);
    expect((await readJson(await ysGET(statusReq()))).status).toBe(200);
  });

  it("YS-2 GET: nested {projectPublicId:{modelId:count}} bare object; root sees every company", async () => {
    const { company, root, author } = await makeWorld();
    const proj = await createProject(company.id, author.id);
    await seedYolo(proj.id, 7);
    await seedYolo(proj.id, 7); // 2 detections for model 7
    await seedYolo(proj.id, 9); // 1 for model 9
    // another company's yolo — included for root (its project list spans companies)
    const otherCo = await createCompany();
    const otherProj = await createProject(otherCo.id, (await createUser(otherCo.id)).id);
    await seedYolo(otherProj.id, 7);
    asUser(root);
    const r = await readJson(await ysGET(statusReq()));
    expect(r.status).toBe(200);
    expect(r.body[proj.publicId]).toEqual({ "7": 2, "9": 1 }); // nested count map
    expect(r.body[otherProj.publicId]).toEqual({ "7": 1 }); // [2026-10-23] root: all companies
    // A non-root session (in-service callers only now) keeps the own-company scope.
    const { admin } = await makeWorld();
    asUser(admin);
    const scoped = (await getYoloStatus(sessionState.current!)) as Record<string, unknown>;
    expect(scoped[proj.publicId]).toBeUndefined();
    expect(scoped[otherProj.publicId]).toBeUndefined();
  });
});

describe.skipIf(!dbUp)("admin/yolo-purge (YP)", () => {
  it("YP-1 auth: signed-out→401, member+company admin→403 (root only), nothing deleted", async () => {
    const { company, member, admin, author } = await makeWorld();
    const proj = await createProject(company.id, author.id);
    await seedYolo(proj.id, 7);
    let r = await readJson(await ypDELETE(purgeReq()));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S049 fold: A applied]
    for (const actor of [member, admin]) {
      asUser(actor);
      r = await readJson(await ypDELETE(purgeReq()));
      expect(r.status).toBe(403);
      expect(r.body).toEqual(ROOT_ONLY);
    }
    expect(await annCount(proj.id)).toBe(1);
  });

  it("YP-2 DELETE: purges own-company yolo annotations only; non-yolo + other-company UNTOUCHED", async () => {
    const { company, root, author } = await makeWorld();
    const proj = await createProject(company.id, author.id);
    await seedYolo(proj.id, 7);
    await seedYolo(proj.id, 9);
    // a NON-yolo (user) annotation in the same project — must survive
    await db.insert(annotations).values({ name: "u1", minX: 0, maxX: 1, minY: 0, maxY: 1, pageNumber: 1, projectId: proj.id, source: "user", data: {} as never });
    // another company's yolo — must survive (company-scoped purge)
    const otherCo = await createCompany();
    const otherProj = await createProject(otherCo.id, (await createUser(otherCo.id)).id);
    await seedYolo(otherProj.id, 7);
    asUser(root);
    const r = await readJson(await ypDELETE(purgeReq()));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ deleted: 2 }); // only the 2 own-company yolo rows
    // own project: the user annotation survives (1 left)
    const remaining = await db.select().from(annotations).where(and(eq(annotations.projectId, proj.id), eq(annotations.source, "yolo")));
    expect(remaining).toHaveLength(0); // yolo gone
    expect(await annCount(proj.id)).toBe(1); // the user annotation remains
    // other company's yolo survives
    expect(await annCount(otherProj.id)).toBe(1);
  });
});
