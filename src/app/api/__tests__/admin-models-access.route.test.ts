// @vitest-environment node
// [refactor jul6 S041] CHARACTERIZATION for the ADMIN B6 write-cluster — model-access
// (GET/POST-grant/DELETE-revoke, requireRootAdmin) + models/reprocess-csi (POST, requireAdmin
// NOT root), written as THE FREEZE before the fold onto services/model-access.ts +
// services/reprocess-csi.ts. B6 = WRITE-CLUSTER: shared freeze, ONE DETECTOR PER ROUTE.
// The MOST DIVERGENT cluster — different auth LEVELS, different db access.
//
// ⚠️ AUTH TRAP (DR002 §5): reprocess-csi is requireAdmin (company-admin), model-access is
//   requireRootAdmin. Do NOT mechanically fold both to auth:"root".
// Frozen quirk inventory:
//   • model-access AUTH: requireRootAdmin (401 "Unauthorized" / 403 "Root admin only").
//     parseTarget: modelId/companyId = Number; userId = null|''|undefined → null else Number.
//     POST validate: !isInteger(modelId||companyId) → 400 "modelId and companyId are required";
//     userId!==null && !isInteger → 400 "userId must be an integer or null". OWNERSHIP: model
//     must exist AND model.companyId===session.companyId → else 404 "Model not found" (root may
//     only grant models IT uploaded). company exists → else 404 "Company not found". if userId:
//     user exists → else 404 "User not found"; u.companyId===companyId → else 400 "That user is
//     not in the selected company". UPSERT null-aware (select by modelId+companyId+userId
//     [isNull|eq] → update enabled:true OR insert enabled:true grantedBy). DELETE: same
//     parse+validate+ownership → delete where (modelId,companyId,userId[isNull|eq]).
//   • reprocess-csi AUTH: requireAdmin (company-admin passes; member 403; signed-out 401).
//     ⚠️ SECURITY SCOPE (H6-class): !isRootAdmin && model.companyId!==session.companyId → 404
//     "Model not found" (a company-admin CANNOT re-stamp another company's YOLO annotations;
//     ROOT BYPASSES for platform-wide re-stamps). modelId required → 400 "modelId required";
//     model missing → 404 "Model not found". empty classNames → {success:true,
//     annotationsUpdated:0, projectsProcessed:0}. WRITE = RAW pg Pool per-className `UPDATE
//     annotations SET data = data || $1::jsonb WHERE source='yolo' AND data->>'modelId'=$2 AND
//     name=$3` (jsonb MERGE — || not replace, H6-safe) + DISTINCT project_id count.
//   • model-access uses req.json().catch(()=>({})) GRACEFUL; reprocess-csi uses await
//     req.json() NON-graceful (malformed throws → legacy 500). Both → shell "Invalid JSON
//     body" 400 at fold (E).
// Assertions tagged [S041 fold] flip in the fold commit (sanctioned A/E only — no catch-500
// literals, so NO B; unexpected errors → generic INTERNAL 500).
import { describe, expect, inject, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET as maGET, POST as maPOST, DELETE as maDELETE } from "@/app/api/admin/model-access/route";
import { POST as rcPOST } from "@/app/api/admin/models/reprocess-csi/route";
import { db } from "@/lib/db";
import { models, modelAccess, annotations } from "@/lib/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import {
  asUser,
  createCompany,
  createUser,
  createProject,
  createPage,
  makeReq,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

let modelSeq = 0;
async function makeModel(companyId: number, config?: unknown) {
  const [m] = await db.insert(models).values({ companyId, name: `M-${companyId}-${modelSeq++}`, type: "yolo", s3Path: `testco/${companyId}/model-${modelSeq}.pt`, config: (config ?? {}) as never }).returning();
  return m;
}

const maReq = (method: string, body?: unknown) => makeReq("/api/admin/model-access", { method, body });
const rcReq = (body: unknown) => makeReq("/api/admin/models/reprocess-csi", { method: "POST", body });
const rawReq = (path: string, method: string, raw?: string) =>
  new Request(`http://test.local${path}`, { method, headers: { "content-type": "application/json" }, body: raw });

const UNAUTH = { error: "Unauthorized" }; // [S041 fold: A → {error:{code:"UNAUTHORIZED",message:"Unauthorized"}}]
const ROOT_ONLY = { error: "Root admin only" }; // [S041 fold: A → {error:{code:"FORBIDDEN",message:"Root admin only"}}]
const ADMIN_ONLY = { error: "Admin only" }; // [S041 fold: A → {error:{code:"FORBIDDEN",message:"Admin only"}}]

beforeEach(() => { vi.clearAllMocks(); signedOut(); });

// ── model-access — root grant/revoke ──────────────────────────────────────────
describe.skipIf(!dbUp)("admin/model-access (MA, requireRootAdmin)", () => {
  it("MA-1 auth: signed-out→401, member→403, root→200", async () => {
    const company = await createCompany();
    const member = await createUser(company.id);
    const root = await createUser(company.id, { isRootAdmin: true });
    let r = await readJson(await maGET());
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S041 fold: A]
    asUser(member);
    r = await readJson(await maGET());
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ROOT_ONLY); // [S041 fold: A]
    asUser(root);
    r = await readJson(await maGET());
    expect(r.status).toBe(200);
  });

  it("MA-2 GET: root's models + grants (joined companyName/username)", async () => {
    const rootCo = await createCompany();
    const root = await createUser(rootCo.id, { isRootAdmin: true });
    const model = await makeModel(rootCo.id);
    const granteeCo = await createCompany();
    const grantee = await createUser(granteeCo.id);
    await db.insert(modelAccess).values({ modelId: model.id, companyId: granteeCo.id, userId: grantee.id, enabled: true, grantedBy: root.id });
    asUser(root);
    const r = await readJson(await maGET());
    expect(r.status).toBe(200);
    expect(r.body.models.some((m: { id: number }) => m.id === model.id)).toBe(true);
    const g = r.body.grants.find((x: { modelId: number }) => x.modelId === model.id);
    expect(g).toMatchObject({ companyId: granteeCo.id, userId: grantee.id, enabled: true, companyName: granteeCo.name, username: grantee.username });
  });

  it("MA-3 POST validation literals", async () => {
    const rootCo = await createCompany();
    asUser(await createUser(rootCo.id, { isRootAdmin: true }));
    let r = await readJson(await maPOST(maReq("POST", { companyId: 1 })));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "modelId and companyId are required" }); // [S041 fold: A]
    r = await readJson(await maPOST(maReq("POST", { modelId: 1, companyId: 2, userId: "abc" })));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "userId must be an integer or null" }); // [S041 fold: A]
  });

  it("MA-4 POST ownership/existence gates", async () => {
    const rootCo = await createCompany();
    const root = await createUser(rootCo.id, { isRootAdmin: true });
    const otherCo = await createCompany();
    const foreignModel = await makeModel(otherCo.id); // NOT root's company
    asUser(root);
    // model not owned by root's company → 404 "Model not found"
    let r = await readJson(await maPOST(maReq("POST", { modelId: foreignModel.id, companyId: rootCo.id })));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "Model not found" }); // [S041 fold: A]
    // owned model, missing company → 404 "Company not found"
    const model = await makeModel(rootCo.id);
    r = await readJson(await maPOST(maReq("POST", { modelId: model.id, companyId: 99999 })));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "Company not found" }); // [S041 fold: A]
    // userId that doesn't exist → 404 "User not found"
    r = await readJson(await maPOST(maReq("POST", { modelId: model.id, companyId: rootCo.id, userId: 88888 })));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "User not found" }); // [S041 fold: A]
    // user in a DIFFERENT company than the grant target → 400 "That user is not in the selected company"
    const c2 = await createCompany();
    const u2 = await createUser(c2.id);
    r = await readJson(await maPOST(maReq("POST", { modelId: model.id, companyId: rootCo.id, userId: u2.id })));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "That user is not in the selected company" }); // [S041 fold: A]
  });

  it("MA-5 POST grant: company-wide insert (userId null) + re-grant updates (no dup)", async () => {
    const rootCo = await createCompany();
    const root = await createUser(rootCo.id, { isRootAdmin: true });
    const model = await makeModel(rootCo.id);
    const target = await createCompany();
    asUser(root);
    let r = await readJson(await maPOST(maReq("POST", { modelId: model.id, companyId: target.id })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    let rows = await db.select().from(modelAccess).where(and(eq(modelAccess.modelId, model.id), eq(modelAccess.companyId, target.id), isNull(modelAccess.userId)));
    expect(rows).toHaveLength(1);
    expect(rows[0].enabled).toBe(true);
    expect(rows[0].grantedBy).toBe(root.id);
    // disable then re-grant → updates existing to enabled:true (no duplicate)
    await db.update(modelAccess).set({ enabled: false }).where(eq(modelAccess.id, rows[0].id));
    r = await readJson(await maPOST(maReq("POST", { modelId: model.id, companyId: target.id })));
    expect(r.status).toBe(200);
    rows = await db.select().from(modelAccess).where(and(eq(modelAccess.modelId, model.id), eq(modelAccess.companyId, target.id), isNull(modelAccess.userId)));
    expect(rows).toHaveLength(1); // no dup
    expect(rows[0].enabled).toBe(true); // re-enabled
  });

  it("MA-6 DELETE revoke: removes the grant; ownership gate 404", async () => {
    const rootCo = await createCompany();
    const root = await createUser(rootCo.id, { isRootAdmin: true });
    const model = await makeModel(rootCo.id);
    const target = await createCompany();
    await db.insert(modelAccess).values({ modelId: model.id, companyId: target.id, userId: null, enabled: true, grantedBy: root.id });
    asUser(root);
    const r = await readJson(await maDELETE(maReq("DELETE", { modelId: model.id, companyId: target.id })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    const rows = await db.select().from(modelAccess).where(and(eq(modelAccess.modelId, model.id), eq(modelAccess.companyId, target.id), isNull(modelAccess.userId)));
    expect(rows).toHaveLength(0); // revoked
    // foreign model → 404 (can only revoke grants on root's own models)
    const otherCo = await createCompany();
    const foreign = await makeModel(otherCo.id);
    const r2 = await readJson(await maDELETE(maReq("DELETE", { modelId: foreign.id, companyId: target.id })));
    expect(r2.status).toBe(404);
    expect(r2.body).toEqual({ error: "Model not found" }); // [S041 fold: A]
  });
});

// ── models/reprocess-csi — requireAdmin (NOT root) + raw pg jsonb merge ────────
describe.skipIf(!dbUp)("admin/models/reprocess-csi (RC, requireAdmin)", () => {
  it("RC-1 auth: signed-out→401, member→403, COMPANY-ADMIN passes (NOT root-gated)", async () => {
    const company = await createCompany();
    const member = await createUser(company.id);
    const admin = await createUser(company.id, { role: "admin" });
    let r = await readJson(await rcPOST(rcReq({ modelId: 1 })));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S041 fold: A]
    asUser(member);
    r = await readJson(await rcPOST(rcReq({ modelId: 1 })));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S041 fold: A]
    // a plain company-admin (role:"admin", NOT root) is ACCEPTED past auth → hits model lookup 404
    asUser(admin);
    r = await readJson(await rcPOST(rcReq({ modelId: 99999 })));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "Model not found" }); // [S041 fold: A]
  });

  it("RC-2 modelId required → 400", async () => {
    const company = await createCompany();
    asUser(await createUser(company.id, { role: "admin" }));
    const r = await readJson(await rcPOST(rcReq({})));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "modelId required" }); // [S041 fold: A]
  });

  it("RC-3 ⚠️ SECURITY SCOPE: company-admin CANNOT reprocess another company's model (404); ROOT bypasses", async () => {
    const coA = await createCompany();
    const adminA = await createUser(coA.id, { role: "admin" });
    const coB = await createCompany();
    const modelB = await makeModel(coB.id, { classCsiCodes: {}, classKeywords: {} }); // belongs to company B
    // company-admin of A tries to reprocess B's model → 404 "Model not found" (scope block)
    asUser(adminA);
    let r = await readJson(await rcPOST(rcReq({ modelId: modelB.id })));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "Model not found" }); // [S041 fold: A] — the H6-class cross-company block
    // a ROOT admin (even of a different company) BYPASSES the scope → reaches empty-classNames success
    const rootAny = await createUser(coA.id, { isRootAdmin: true });
    asUser(rootAny);
    r = await readJson(await rcPOST(rcReq({ modelId: modelB.id })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, annotationsUpdated: 0, projectsProcessed: 0 }); // empty config
  });

  it("RC-4 empty classNames → success with zero counts", async () => {
    const company = await createCompany();
    const admin = await createUser(company.id, { role: "admin" });
    const model = await makeModel(company.id, { classCsiCodes: {}, classKeywords: {} });
    asUser(admin);
    const r = await readJson(await rcPOST(rcReq({ modelId: model.id })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, annotationsUpdated: 0, projectsProcessed: 0 });
  });

  it("RC-5 WRITE: jsonb || MERGE stamps csiCodes+keywords onto matching yolo annotations (raw pg)", async () => {
    const company = await createCompany();
    const admin = await createUser(company.id, { role: "admin" });
    const author = await createUser(company.id);
    const project = await createProject(company.id, author.id);
    await createPage(project.id, 1);
    const model = await makeModel(company.id, {
      classCsiCodes: { Door: ["08 11 00"] },
      classKeywords: { Door: ["hinged"] },
    });
    // a yolo annotation named "Door" tagged with this modelId, plus a pre-existing data key to prove MERGE (not replace)
    await db.insert(annotations).values({
      name: "Door", minX: 0, maxX: 1, minY: 0, maxY: 1, pageNumber: 1, projectId: project.id,
      source: "yolo", data: { modelId: model.id, keep: "me" } as never,
    });
    // a non-matching annotation (different name) must be untouched
    await db.insert(annotations).values({
      name: "Window", minX: 0, maxX: 1, minY: 0, maxY: 1, pageNumber: 1, projectId: project.id,
      source: "yolo", data: { modelId: model.id } as never,
    });
    asUser(admin);
    const r = await readJson(await rcPOST(rcReq({ modelId: model.id })));
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.annotationsUpdated).toBe(1); // only the "Door" row
    expect(r.body.projectsProcessed).toBe(1);
    const [door] = await db.select().from(annotations).where(and(eq(annotations.projectId, project.id), eq(annotations.name, "Door")));
    const data = door.data as Record<string, unknown>;
    expect(data.csiCodes).toEqual(["08 11 00"]); // stamped
    expect(data.keywords).toEqual(["hinged"]);
    expect(data.keep).toBe("me"); // MERGE preserved the sibling key (|| not replace)
  });

  it("RC-6 malformed body: legacy await req.json() throws (500-class)", async () => {
    const company = await createCompany();
    asUser(await createUser(company.id, { role: "admin" }));
    // [S041 fold: E — shell raw-parse → 400 BAD_REQUEST "Invalid JSON body"]
    await expect(rcPOST(rawReq("/api/admin/models/reprocess-csi", "POST", "{oops"))).rejects.toThrow();
  });
});
