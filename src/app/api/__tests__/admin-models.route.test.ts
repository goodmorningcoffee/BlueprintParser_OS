// @vitest-environment node
// [refactor jul8 S057] CHARACTERIZATION for the admin/models SOLO (GET list/presign/access +
// POST register + PUT config-merge + DELETE + PATCH share/toggle), written as THE FREEZE before
// the fold onto services/models.ts. Solo. requireAdmin on ALL 5 methods. AWS mocked at the
// @/lib/s3 boundary (uploadToS3 + createModelUploadPresignedPost — weights-security-sensitive,
// never live). Real DB for models/modelAccess/companies. Frozen quirk inventory:
//   • GET action=presign: ROOT-only (else 403 "Not authorized"); ALLOW_MODEL_UPLOAD!=="true" →
//     403 "Model uploads are disabled on this deployment."; !name → 400 "name required"; slug =
//     name.toLowerCase().replace(/[^a-z0-9-]/g,"-"); bare presigned passthrough.
//   • GET action=access: root-only BY FALL-THROUGH — a NON-root admin with action=access gets
//     the DEFAULT company listing, not an error (quirk, pinned). !modelId → bare [] @200.
//     Rows filtered to COMPANY-level grants (userId IS NULL).
//   • GET default: root → ALL models + companyName + s3Path PRESENT. Company admin → own
//     (enabled:true, shared:false, s3Path present) + enabled shared grants (s3Path forced NULL
//     = WEIGHTS-2 masking — the leak-vector gate, do NOT "clean up"; enabled from the grant;
//     userId NULL or own-dbId), deduped by own ids.
//   • POST: the ALLOW_MODEL_UPLOAD kill-switch ran BEFORE requireAdmin in legacy. ★ OWNER
//     DECISION (S051): fold ACCEPTS the auth-first flip — signed-out on a disabled deployment
//     was 403-disabled, becomes 401. Authed+disabled stays 403, message byte-verbatim.
//     Enabled registration is root-only, matching the root-only presign half of the global
//     models/<slug> upload protocol; an enabled tenant admin gets 403 "Not authorized".
//     configYaml BYTE-EXACT (conf ?? 0.10, iou ?? 0.60, image_size 1280, max_detections 2000);
//     classes.txt uploaded ONLY when classes non-empty; insert own-company type:"yolo"
//     isDefault:false; bare {id,name,s3Path,config}.
//   • PUT: !id → 400 "id required"; all-six-absent → 400 "At least one field required"; UNSCOPED
//     fetch then JS tenancy: missing → 404 "Model not found" / cross-company non-root → 404
//     "Not found" (messages DISTINCT); root cross-company allowed. jsonb SPREAD-MERGE
//     {...existingConfig, ...updates} (H6-class — merge, never replace); classTypes/classCsiCodes/
//     classKeywords TRUTHY-gated vs confidence/iou/imageSize !==undefined-gated + Number()
//     coerced (confidence:0 applies; classTypes:"" does not). Bare {success:true, config}.
//   • DELETE: NO !id guard — {} body → 404 "Model not found" (eq(models.id, undefined) binds
//     to no-match, NOT a throw; identical in legacy and fold — MD-14 freeze correction).
//     Same unscoped-fetch-then-JS-404 pair as PUT; root cross-company allowed.
//   • PATCH: !modelId → 400 "modelId required"; share-to-OTHER-company → root-only 403
//     "Only root admin can share models to other companies"; non-root on a model not owned:
//     ANY modelAccess row for (model, own company) — even a PER-USER grant — passes the
//     hasAccess gate (quirk: a per-user grant lets a company admin create a COMPANY-wide
//     grant); upsert targets COMPANY-level rows only (userId IS NULL — a per-user row is
//     ignored, a NEW company row is inserted beside it); existing → enabled ?? !existing.enabled
//     (toggle), insert → enabled ?? true, grantedBy = actor dbId.
// GET has no body → NO E. POST/PUT/DELETE/PATCH read req.json() → E at fold. NO B anywhere
// (legacy has ZERO try/catch; the shell's generic INTERNAL 500 is NEW uniform wrapping).
// Sanctioned A + E + the S051 owner-sanctioned POST ordering flip only.
// Assertions tagged [S057 fold: … applied] were flipped in the fold commit onto
// services/models.ts.
import {
  describe,
  expect,
  inject,
  it,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const h = vi.hoisted(() => ({
  uploadToS3: vi.fn(),
  createModelUploadPresignedPost: vi.fn(),
}));
vi.mock("@/lib/s3", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/s3")>();
  return {
    ...orig,
    uploadToS3: h.uploadToS3,
    createModelUploadPresignedPost: h.createModelUploadPresignedPost,
  };
});

import {
  GET as mdGET,
  POST as mdPOST,
  PUT as mdPUT,
  DELETE as mdDELETE,
  PATCH as mdPATCH,
} from "@/app/api/admin/models/route";
import { db } from "@/lib/db";
import { models, modelAccess } from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import {
  asUser,
  createCompany,
  createUser,
  makeReq,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

// [S057 fold: A applied] — at freeze these were the legacy flat bodies
// UNAUTH={error:"Unauthorized"}, ADMIN_ONLY={error:"Admin only"}.
const UNAUTH = { error: { code: "UNAUTHORIZED", message: "Unauthorized" } };
const ADMIN_ONLY = { error: { code: "FORBIDDEN", message: "Admin only" } };
const A = {
  forbidden: (message: string) => ({ error: { code: "FORBIDDEN", message } }),
  validation: (message: string) => ({ error: { code: "VALIDATION", message } }),
  notFound: (message: string) => ({ error: { code: "NOT_FOUND", message } }),
};

let modelSeq = 0;
async function seedModel(
  companyId: number,
  over: Partial<typeof models.$inferInsert> = {},
) {
  const [m] = await db
    .insert(models)
    .values({
      companyId,
      name: `M-${companyId}-${modelSeq++}`,
      type: "yolo",
      s3Path: `models/m-${companyId}-${modelSeq}`,
      config: { classes: ["seed"] } as never,
      ...over,
    })
    .returning();
  return m;
}
async function modelById(id: number) {
  const [m] = await db.select().from(models).where(eq(models.id, id)).limit(1);
  return m;
}
async function companyGrant(modelId: number, companyId: number) {
  const [g] = await db
    .select()
    .from(modelAccess)
    .where(
      and(
        eq(modelAccess.modelId, modelId),
        eq(modelAccess.companyId, companyId),
        isNull(modelAccess.userId),
      ),
    )
    .limit(1);
  return g;
}

async function makeWorld() {
  const company = await createCompany();
  const admin = await createUser(company.id, { role: "admin" });
  const member = await createUser(company.id);
  const root = await createUser(company.id, { isRootAdmin: true });
  return { company, admin, member, root };
}

const getReq = (qs = "") =>
  makeReq(`/api/admin/models${qs}`, { method: "GET" });
const postReq = (body: unknown) =>
  makeReq("/api/admin/models", { method: "POST", body });
const putReq = (body: unknown) =>
  makeReq("/api/admin/models", { method: "PUT", body });
const delReq = (body: unknown) =>
  makeReq("/api/admin/models", { method: "DELETE", body });
const patchReq = (body: unknown) =>
  makeReq("/api/admin/models", { method: "PATCH", body });
const malformed = (method: string) =>
  new Request("http://test.local/api/admin/models", {
    method,
    headers: { "content-type": "application/json" },
    body: "{ nope",
  });

let savedFlag: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
  savedFlag = process.env.ALLOW_MODEL_UPLOAD;
  delete process.env.ALLOW_MODEL_UPLOAD; // default: uploads DISABLED (prod posture)
  h.uploadToS3.mockResolvedValue(undefined);
  h.createModelUploadPresignedPost.mockResolvedValue({
    url: "https://s3.test.invalid/presigned",
    fields: { key: "v" },
    key: "models/slug/model.pt",
    s3Path: "models/slug",
  });
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env.ALLOW_MODEL_UPLOAD;
  else process.env.ALLOW_MODEL_UPLOAD = savedFlag;
});

describe.skipIf(!dbUp)("admin/models (MD)", () => {
  // ── auth (A) ────────────────────────────────────────────────────────────────
  it("MD-1 auth: all 5 methods signed-out→401, member→403 (POST tested uploads-ENABLED)", async () => {
    const { member } = await makeWorld();
    process.env.ALLOW_MODEL_UPLOAD = "true"; // so POST reaches auth in BOTH worlds
    const calls = [
      () => mdGET(getReq()),
      () => mdPOST(postReq({ name: "x", s3Path: "models/x" })),
      () => mdPUT(putReq({ id: 1, confidence: 0.2 })),
      () => mdDELETE(delReq({ id: 1 })),
      () => mdPATCH(patchReq({ modelId: 1 })),
    ];
    for (const call of calls) {
      const r = await readJson(await call());
      expect(r.status).toBe(401);
      expect(r.body).toEqual(UNAUTH); // [S057 fold: A applied]
    }
    asUser(member);
    for (const call of calls) {
      const r = await readJson(await call());
      expect(r.status).toBe(403);
      expect(r.body).toEqual(ADMIN_ONLY); // [S057 fold: A applied]
    }
  });

  // ── GET presign ─────────────────────────────────────────────────────────────
  it("MD-2 GET presign: non-root 403; root+disabled 403; root+enabled no-name 400; happy slug+passthrough", async () => {
    const { admin, root } = await makeWorld();
    asUser(admin);
    let r = await readJson(await mdGET(getReq("?action=presign&name=x")));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(A.forbidden("Not authorized")); // [S057 fold: A applied]
    asUser(root);
    r = await readJson(await mdGET(getReq("?action=presign&name=x"))); // uploads disabled
    expect(r.status).toBe(403);
    expect(r.body).toEqual(
      A.forbidden("Model uploads are disabled on this deployment."),
    ); // [S057 fold: A applied]
    process.env.ALLOW_MODEL_UPLOAD = "true";
    r = await readJson(await mdGET(getReq("?action=presign")));
    expect(r.status).toBe(400);
    expect(r.body).toEqual(A.validation("name required")); // [S057 fold: A applied]
    r = await readJson(await mdGET(getReq("?action=presign&name=Foo%20Bar!")));
    expect(r.status).toBe(200);
    expect(h.createModelUploadPresignedPost).toHaveBeenCalledWith("Foo Bar!"); // signer owns canonical slug derivation
    expect(r.body).toEqual({
      url: "https://s3.test.invalid/presigned",
      fields: { key: "v" },
      key: "models/slug/model.pt",
      s3Path: "models/slug",
    }); // bare passthrough
  });

  // ── GET access ──────────────────────────────────────────────────────────────
  it("MD-3 GET access: root !modelId→[]; root filters to COMPANY grants; non-root FALLS THROUGH to default listing", async () => {
    const { company, admin, root } = await makeWorld();
    const grantee = await createCompany();
    const granteeUser = await createUser(grantee.id);
    const m = await seedModel(company.id);
    await db.insert(modelAccess).values({
      modelId: m.id,
      companyId: grantee.id,
      userId: null,
      enabled: true,
      grantedBy: root.id,
    });
    await db.insert(modelAccess).values({
      modelId: m.id,
      companyId: grantee.id,
      userId: granteeUser.id,
      enabled: false,
      grantedBy: root.id,
    }); // per-user — EXCLUDED
    asUser(root);
    let r = await readJson(await mdGET(getReq("?action=access")));
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]); // !modelId → bare []
    r = await readJson(await mdGET(getReq(`?action=access&modelId=${m.id}`)));
    expect(r.status).toBe(200);
    expect(r.body).toEqual([
      { companyId: grantee.id, companyName: grantee.name, enabled: true },
    ]); // userId NULL only
    // QUIRK: non-root + action=access → NOT an error; falls through to the default listing
    asUser(admin);
    r = await readJson(await mdGET(getReq(`?action=access&modelId=${m.id}`)));
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.map((x: { id: number }) => x.id)).toContain(m.id); // own-company listing shape
    expect(r.body[0]).not.toHaveProperty("companyName"); // not the access-rows shape
  });

  // ── GET default listing ─────────────────────────────────────────────────────
  it("MD-4 GET default root: ALL models, companyName + s3Path PRESENT", async () => {
    const { company, root } = await makeWorld();
    const otherCo = await createCompany();
    const mine = await seedModel(company.id);
    const foreign = await seedModel(otherCo.id);
    asUser(root);
    const r = await readJson(await mdGET(getReq()));
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(
      r.body.map((m: { id: number }) => [m.id, m]),
    );
    expect(byId[mine.id]).toMatchObject({
      companyName: company.name,
      s3Path: mine.s3Path,
    });
    expect(byId[foreign.id]).toMatchObject({
      companyName: otherCo.name,
      s3Path: foreign.s3Path,
    }); // root sees s3Path
  });

  it("MD-5 GET default company-admin: own + enabled shared (s3Path NULL = WEIGHTS-2), dedup, grant filters", async () => {
    const { company, admin, root } = await makeWorld();
    const ownerCo = await createCompany();
    const own = await seedModel(company.id);
    const sharedEnabled = await seedModel(ownerCo.id);
    const sharedDisabled = await seedModel(ownerCo.id);
    const sharedToOtherUser = await seedModel(ownerCo.id);
    const sharedToMe = await seedModel(ownerCo.id);
    const otherUser = await createUser(company.id);
    await db.insert(modelAccess).values([
      {
        modelId: sharedEnabled.id,
        companyId: company.id,
        userId: null,
        enabled: true,
        grantedBy: root.id,
      },
      {
        modelId: sharedDisabled.id,
        companyId: company.id,
        userId: null,
        enabled: false,
        grantedBy: root.id,
      }, // enabled=false → excluded
      {
        modelId: sharedToOtherUser.id,
        companyId: company.id,
        userId: otherUser.id,
        enabled: true,
        grantedBy: root.id,
      }, // other user → excluded
      {
        modelId: sharedToMe.id,
        companyId: company.id,
        userId: admin.id,
        enabled: true,
        grantedBy: root.id,
      }, // me → included
      {
        modelId: own.id,
        companyId: company.id,
        userId: null,
        enabled: true,
        grantedBy: root.id,
      }, // own + grant → DEDUP (own form wins)
    ]);
    asUser(admin);
    const r = await readJson(await mdGET(getReq()));
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(
      r.body.map((m: { id: number }) => [m.id, m]),
    );
    expect(byId[own.id]).toMatchObject({
      enabled: true,
      shared: false,
      s3Path: own.s3Path,
    }); // own keeps s3Path
    expect(byId[sharedEnabled.id]).toMatchObject({
      enabled: true,
      shared: true,
      s3Path: null,
    }); // WEIGHTS-2 mask
    expect(byId[sharedToMe.id]).toMatchObject({ shared: true, s3Path: null });
    expect(byId[sharedDisabled.id]).toBeUndefined();
    expect(byId[sharedToOtherUser.id]).toBeUndefined();
    expect(r.body.filter((m: { id: number }) => m.id === own.id)).toHaveLength(
      1,
    ); // dedup
  });

  // ── POST ────────────────────────────────────────────────────────────────────
  it("MD-6 POST kill-switch: auth-first under the fold — signed-out+disabled 401 (S051 owner decision); authed+disabled 403 literal", async () => {
    const { admin } = await makeWorld();
    // signed-out + disabled: legacy was 403 disabled-literal (kill-switch PRE-auth)
    // [S057 fold: S051 owner-sanctioned auth-first flip applied — now 401 UNAUTHORIZED]
    let r = await readJson(
      await mdPOST(postReq({ name: "x", s3Path: "models/x" })),
    );
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH);
    // authed admin + disabled: 403 with the SAME byte-verbatim literal (both worlds)
    asUser(admin);
    r = await readJson(
      await mdPOST(postReq({ name: "x", s3Path: "models/x" })),
    );
    expect(r.status).toBe(403);
    expect(r.body).toEqual(
      A.forbidden(
        "Model uploads are disabled on this deployment. Contact an administrator to enable ALLOW_MODEL_UPLOAD.",
      ),
    ); // [S057 fold: A applied]
    expect(h.uploadToS3).not.toHaveBeenCalled();

    process.env.ALLOW_MODEL_UPLOAD = "true";
    r = await readJson(
      await mdPOST(postReq({ name: "x", s3Path: "models/x" })),
    );
    expect(r.status).toBe(403);
    expect(r.body).toEqual(A.forbidden("Not authorized"));
    expect(h.uploadToS3).not.toHaveBeenCalled();
  });

  it("MD-7 POST validation: missing name or s3Path → 400 'name and s3Path required'", async () => {
    const { root } = await makeWorld();
    process.env.ALLOW_MODEL_UPLOAD = "true";
    asUser(root);
    for (const body of [{}, { name: "x" }, { s3Path: "models/x" }]) {
      const r = await readJson(await mdPOST(postReq(body)));
      expect(r.status).toBe(400);
      expect(r.body).toEqual(A.validation("name and s3Path required")); // [S057 fold: A applied]
    }
  });

  it("rejects a model registration path outside the canonical models namespace before any S3 write", async () => {
    const { root } = await makeWorld();
    process.env.ALLOW_MODEL_UPLOAD = "true";
    asUser(root);

    const r = await readJson(
      await mdPOST(
        postReq({
          name: "Project-prefix alias",
          s3Path: "demo-company/0123456789abcdefabcd",
          classes: ["door"],
        }),
      ),
    );

    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("VALIDATION");
    expect(h.uploadToS3).not.toHaveBeenCalled();
  });

  it("MD-8 POST happy: configYaml BYTE-exact, classes.txt when non-empty, own-company insert, bare response", async () => {
    const { company, root } = await makeWorld();
    process.env.ALLOW_MODEL_UPLOAD = "true";
    asUser(root);
    const r = await readJson(
      await mdPOST(
        postReq({
          name: "Door Detector",
          s3Path: "models/door-detector",
          classes: ["door", "window"],
          confidence: 0.25,
        }),
      ),
    );
    expect(r.status).toBe(200);
    // config.yaml byte-exact (conf given, iou default 0.60 → "0.6")
    const expectedYaml = `model_file: model.pt
confidence_threshold: 0.25
iou_threshold: 0.6
image_size: 1280
device: auto
half_precision: true
max_detections: 2000
save_annotated: false
classes:
  - door
  - window
`;
    expect(h.uploadToS3).toHaveBeenNthCalledWith(
      1,
      "models/door-detector/config.yaml",
      expect.any(Buffer),
      "text/yaml",
    );
    expect((h.uploadToS3.mock.calls[0][1] as Buffer).toString()).toBe(
      expectedYaml,
    );
    expect(h.uploadToS3).toHaveBeenNthCalledWith(
      2,
      "models/door-detector/classes.txt",
      expect.any(Buffer),
      "text/plain",
    );
    expect((h.uploadToS3.mock.calls[1][1] as Buffer).toString()).toBe(
      "door\nwindow",
    );
    expect(r.body).toEqual({
      id: expect.any(Number),
      name: "Door Detector",
      s3Path: "models/door-detector",
      config: {
        classes: ["door", "window"],
        confidence: 0.25,
        iou: 0.6,
        imageSize: 1280,
      },
    });
    const row = await modelById(r.body.id);
    expect(row).toMatchObject({
      companyId: company.id,
      type: "yolo",
      isDefault: false,
    });
  });

  it("MD-9 POST no classes: defaults (0.1/0.6), empty classes section, NO classes.txt", async () => {
    const { root } = await makeWorld();
    process.env.ALLOW_MODEL_UPLOAD = "true";
    asUser(root);
    const r = await readJson(
      await mdPOST(postReq({ name: "Bare", s3Path: "models/bare" })),
    );
    expect(r.status).toBe(200);
    expect((h.uploadToS3.mock.calls[0][1] as Buffer).toString())
      .toBe(`model_file: model.pt
confidence_threshold: 0.1
iou_threshold: 0.6
image_size: 1280
device: auto
half_precision: true
max_detections: 2000
save_annotated: false
classes:

`);
    expect(h.uploadToS3).toHaveBeenCalledTimes(1); // no classes.txt
    expect(r.body.config).toEqual({
      classes: [],
      confidence: 0.1,
      iou: 0.6,
      imageSize: 1280,
    });
  });

  // ── PUT ─────────────────────────────────────────────────────────────────────
  it("MD-10 PUT validation: no id → 'id required'; all six fields absent → 'At least one field required'", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    let r = await readJson(await mdPUT(putReq({ confidence: 0.5 })));
    expect(r.status).toBe(400);
    expect(r.body).toEqual(A.validation("id required")); // [S057 fold: A applied]
    r = await readJson(await mdPUT(putReq({ id: 123 })));
    expect(r.status).toBe(400);
    expect(r.body).toEqual(A.validation("At least one field required")); // [S057 fold: A applied]
  });

  it("MD-11 PUT tenancy: missing → 'Model not found'; cross-company non-root → 'Not found' (DISTINCT msgs); root bypasses", async () => {
    const { admin, root } = await makeWorld();
    const otherCo = await createCompany();
    const foreign = await seedModel(otherCo.id, {
      config: { classes: ["x"] } as never,
    });
    asUser(admin);
    let r = await readJson(
      await mdPUT(putReq({ id: 99999999, confidence: 0.5 })),
    );
    expect(r.status).toBe(404);
    expect(r.body).toEqual(A.notFound("Model not found")); // [S057 fold: A applied]
    r = await readJson(
      await mdPUT(putReq({ id: foreign.id, confidence: 0.5 })),
    );
    expect(r.status).toBe(404);
    expect(r.body).toEqual(A.notFound("Not found")); // [S057 fold: A applied] — cross-company, distinct msg
    // root cross-company → allowed
    asUser(root);
    r = await readJson(
      await mdPUT(putReq({ id: foreign.id, confidence: 0.9 })),
    );
    expect(r.status).toBe(200);
    expect(r.body.config.confidence).toBe(0.9);
  });

  it("MD-12 PUT merge semantics: SPREAD-MERGE preserves keys; Number() coercion; 0 applies (!==undefined); truthy-gate on class fields", async () => {
    const { company, admin } = await makeWorld();
    const m = await seedModel(company.id, {
      config: {
        classes: ["a"],
        confidence: 0.1,
        classTypes: { a: "count" },
      } as never,
    });
    asUser(admin);
    const r = await readJson(
      await mdPUT(
        putReq({
          id: m.id,
          classKeywords: { a: ["kw"] },
          confidence: "0.5",
          iou: 0,
          classTypes: "", // classTypes falsy → NOT applied
        }),
      ),
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      success: true,
      config: {
        classes: ["a"], // preserved by spread-merge
        classTypes: { a: "count" }, // falsy "" NOT applied — original survives
        confidence: 0.5, // Number("0.5")
        iou: 0, // 0 applied (!== undefined gate)
        classKeywords: { a: ["kw"] },
      },
    });
    expect((await modelById(m.id)).config).toEqual(r.body.config); // merged object written back whole
  });

  // ── DELETE ──────────────────────────────────────────────────────────────────
  it("MD-13 DELETE: missing → 'Model not found'; cross-company non-root → 'Not found'; happy deletes; root bypasses", async () => {
    const { company, admin, root } = await makeWorld();
    const otherCo = await createCompany();
    const foreign = await seedModel(otherCo.id);
    const mine = await seedModel(company.id);
    asUser(admin);
    let r = await readJson(await mdDELETE(delReq({ id: 99999999 })));
    expect(r.status).toBe(404);
    expect(r.body).toEqual(A.notFound("Model not found")); // [S057 fold: A applied]
    r = await readJson(await mdDELETE(delReq({ id: foreign.id })));
    expect(r.status).toBe(404);
    expect(r.body).toEqual(A.notFound("Not found")); // [S057 fold: A applied]
    expect(await modelById(foreign.id)).toBeTruthy(); // untouched
    r = await readJson(await mdDELETE(delReq({ id: mine.id })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    expect(await modelById(mine.id)).toBeUndefined();
    asUser(root);
    r = await readJson(await mdDELETE(delReq({ id: foreign.id })));
    expect(r.status).toBe(200);
    expect(await modelById(foreign.id)).toBeUndefined();
  });

  it("MD-14 DELETE no-id QUIRK: {} body → 404 'Model not found' (no !id guard; undefined binds to no-match)", async () => {
    const { admin } = await makeWorld();
    asUser(admin);
    // NO !id guard in legacy — id undefined flows into eq(models.id, undefined) which matches
    // nothing → the ordinary "Model not found" 404 (NOT a throw; verified firsthand at freeze).
    const r = await readJson(await mdDELETE(delReq({})));
    expect(r.status).toBe(404);
    expect(r.body).toEqual(A.notFound("Model not found")); // [S057 fold: A applied]
  });

  // ── PATCH ───────────────────────────────────────────────────────────────────
  it("MD-15 PATCH validation: no modelId → 400; non-root share-to-OTHER-company → 403 root-only literal", async () => {
    const { admin } = await makeWorld();
    const otherCo = await createCompany();
    asUser(admin);
    let r = await readJson(await mdPATCH(patchReq({})));
    expect(r.status).toBe(400);
    expect(r.body).toEqual(A.validation("modelId required")); // [S057 fold: A applied]
    r = await readJson(
      await mdPATCH(patchReq({ modelId: 1, companyId: otherCo.id })),
    );
    expect(r.status).toBe(403);
    expect(r.body).toEqual(
      A.forbidden("Only root admin can share models to other companies"),
    ); // [S057 fold: A applied]
  });

  it("MD-16 PATCH non-root gates: model missing → 'Model not found'; not-owned no-access → 'Not found'; a PER-USER grant passes hasAccess (quirk)", async () => {
    const { company, admin, root } = await makeWorld();
    const ownerCo = await createCompany();
    const foreign = await seedModel(ownerCo.id);
    asUser(admin);
    let r = await readJson(await mdPATCH(patchReq({ modelId: 99999999 })));
    expect(r.status).toBe(404);
    expect(r.body).toEqual(A.notFound("Model not found")); // [S057 fold: A applied]
    r = await readJson(await mdPATCH(patchReq({ modelId: foreign.id })));
    expect(r.status).toBe(404);
    expect(r.body).toEqual(A.notFound("Not found")); // [S057 fold: A applied]
    // QUIRK: a PER-USER grant row satisfies hasAccess, and the upsert then creates a NEW
    // COMPANY-level grant beside it (per-user row untouched).
    await db.insert(modelAccess).values({
      modelId: foreign.id,
      companyId: company.id,
      userId: admin.id,
      enabled: true,
      grantedBy: root.id,
    });
    r = await readJson(
      await mdPATCH(patchReq({ modelId: foreign.id, enabled: false })),
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    const companyLevel = await companyGrant(foreign.id, company.id);
    expect(companyLevel).toMatchObject({
      enabled: false,
      grantedBy: admin.id,
      userId: null,
    }); // NEW company row
    const [perUser] = await db
      .select()
      .from(modelAccess)
      .where(
        and(
          eq(modelAccess.modelId, foreign.id),
          eq(modelAccess.companyId, company.id),
          eq(modelAccess.userId, admin.id),
        ),
      );
    expect(perUser.enabled).toBe(true); // per-user row untouched
  });

  it("MD-17 PATCH upsert: enabled omitted toggles existing; insert defaults true; root shares cross-company; own-company companyId allowed", async () => {
    const { company, admin, root } = await makeWorld();
    const m = await seedModel(company.id);
    const targetCo = await createCompany();
    asUser(admin);
    // no existing company grant → INSERT enabled ?? true, grantedBy actor
    let r = await readJson(
      await mdPATCH(patchReq({ modelId: m.id, companyId: company.id })),
    ); // own companyId → allowed for non-root
    expect(r.status).toBe(200);
    expect(await companyGrant(m.id, company.id)).toMatchObject({
      enabled: true,
      grantedBy: admin.id,
    });
    // existing + enabled omitted → TOGGLE (!existing.enabled)
    r = await readJson(await mdPATCH(patchReq({ modelId: m.id })));
    expect((await companyGrant(m.id, company.id))!.enabled).toBe(false);
    r = await readJson(await mdPATCH(patchReq({ modelId: m.id })));
    expect((await companyGrant(m.id, company.id))!.enabled).toBe(true);
    // existing + enabled explicit → set
    r = await readJson(
      await mdPATCH(patchReq({ modelId: m.id, enabled: false })),
    );
    expect((await companyGrant(m.id, company.id))!.enabled).toBe(false);
    // root shares to ANOTHER company → new grant there
    asUser(root);
    r = await readJson(
      await mdPATCH(patchReq({ modelId: m.id, companyId: targetCo.id })),
    );
    expect(r.status).toBe(200);
    expect(await companyGrant(m.id, targetCo.id)).toMatchObject({
      enabled: true,
      grantedBy: root.id,
    });
  });

  // ── E (malformed body) ──────────────────────────────────────────────────────
  it("MD-18 malformed JSON on POST/PUT/DELETE/PATCH → 400 'Invalid JSON body'", async () => {
    const { admin } = await makeWorld();
    process.env.ALLOW_MODEL_UPLOAD = "true"; // POST reaches req.json in legacy
    asUser(admin);
    // [S057 fold: E applied — legacy `await req.json()` threw (handler rejected); the shell
    // parses the body in step 1 → 400 BAD_REQUEST "Invalid JSON body"]
    for (const call of [
      mdPOST(malformed("POST")),
      mdPUT(malformed("PUT")),
      mdDELETE(malformed("DELETE")),
      mdPATCH(malformed("PATCH")),
    ]) {
      const r = await readJson(await call);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({
        error: { code: "BAD_REQUEST", message: "Invalid JSON body" },
      });
    }
  });
});
