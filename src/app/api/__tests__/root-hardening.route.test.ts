// @vitest-environment node
// [2026-10-25 root hardening] Table-driven admission test for the ROOT-ONLY surface — the routes
// that change quotas / limits, compute / infra / GPU settings, model or feature access, roles, or
// trigger owner-billed spend. For every row:
//   • a COMPANY ADMIN (role admin, not root) is refused with 403;
//   • a root login that has not enrolled or verified (a user-less gated session, exactly what
//     lib/auth.ts projects) is refused with 401 — "root" in the database buys nothing on its own;
//   • a VERIFIED root is admitted (whatever the handler then says, it is not 401/403).
// Plus: ROOT_2FA_ENFORCE=0 (the logged emergency off-switch) projects an unenrolled root as root,
// and break-glass (the enrollment row deleted) returns a verified login to the gate.
// Heavy side effects are mocked (S3 toggles, Textract, Lambda, the local pipeline); every root row
// is otherwise exercised against the real route shell and the real test database.
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});
const h = vi.hoisted(() => ({
  toggles: {
    getToggles: vi.fn(async () => ({ sagemakerEnabled: true, quotaEnabled: true, passwordHash: null })),
    setToggle: vi.fn(async () => ({ sagemakerEnabled: false, quotaEnabled: true, passwordHash: null })),
    hasTogglePassword: vi.fn(async () => true),
    setTogglePassword: vi.fn(async () => ({ success: true })),
    verifyTogglePassword: vi.fn(async () => true),
  },
  isLambdaCvEnabled: vi.fn(() => true),
  processProject: vi.fn(async () => ({ pagesProcessed: 0 })),
}));
vi.mock("@/lib/toggles", () => h.toggles);
vi.mock("@/lib/lambda-cv", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/lambda-cv")>();
  return { ...orig, isLambdaCvEnabled: h.isLambdaCvEnabled, fanOutShapeParse: vi.fn(), fanOutTemplateMatch: vi.fn() };
});
vi.mock("@/lib/processing", () => ({ processProject: h.processProject }));
vi.mock("@/lib/s3", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/s3")>();
  return { ...orig, downloadFromS3: vi.fn(async () => Buffer.from("png")) };
});
vi.mock("@/lib/textract", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/textract")>();
  return { ...orig, analyzePageImageWithFallback: vi.fn(async () => ({ words: [], lines: [], tables: [] })) };
});

import { GET as togglesGET, PUT as togglesPUT } from "@/app/api/admin/toggles/route";
import { PUT as quotaPUT } from "@/app/api/admin/quota-overrides/route";
import { PUT as usagePUT } from "@/app/api/admin/usage/route";
import { PUT as uploadComputePUT } from "@/app/api/admin/upload-compute/route";
import { PUT as yoloInstancePUT } from "@/app/api/admin/yolo-instance/route";
import { PUT as yoloRuntimePUT } from "@/app/api/admin/yolo-runtime/route";
import { PUT as tilesPUT } from "@/app/api/admin/tiles/route";
import { PUT as appSettingsPUT } from "@/app/api/admin/app-settings/route";
import { POST as companiesPOST } from "@/app/api/admin/companies/route";
import { POST as modelAccessPOST } from "@/app/api/admin/model-access/route";
import { POST as usersPOST } from "@/app/api/admin/users/route";
import { PATCH as modelsPATCH } from "@/app/api/admin/models/route";
import { POST as resetPasswordPOST } from "@/app/api/admin/users/reset-password/route";
import { DELETE as yoloPurgeDELETE } from "@/app/api/admin/yolo-purge/route";
import { POST as runBatchPOST } from "@/app/api/yolo/run-batch/route";
import { POST as textractRerunPOST } from "@/app/api/pages/textract-rerun/route";
import { POST as reprocessPOST } from "@/app/api/admin/reprocess/route";
import { POST as devPOST } from "@/app/api/processing/dev/route";
import { POST as disable2faPOST } from "@/app/api/auth/2fa/disable/route";
import { db } from "@/lib/db";
import { appSettings, models } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { AuthSession } from "@/lib/api-utils";
import { ROOT_TWO_FACTOR_ENFORCE_ENV, projectRootAuthority, rootTwoFactorSettingKey } from "@/lib/root-two-factor-claims";
import { refreshJwtSessionClaims, stampRootTwoFactorAtSignIn } from "@/server/services/root-two-factor";
import { ROOT_ONLY_SURFACES } from "../../../../scripts/project-security-policy-manifest.mjs";
import { asUser, createCompany, createProject, createUser, makeReq, readJson, sessionState, signedOut, type FixtureUser } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

type Handler = (req: Request) => Promise<Response>;
interface Row {
  name: string;
  route: string;
  method: string;
  handler: Handler;
  /** A function is resolved per call (fixtures made in beforeEach). */
  body?: unknown | (() => unknown);
  /** The 403 a company admin receives. */
  adminDenied: string;
  /** Skip the verified-root admission probe when the handler would do real work. */
  rootProbe?: false;
}

const ROOT_ONLY = "Root admin only";
const rows: Row[] = [
  { name: "toggles GET", route: "/api/admin/toggles", method: "GET", handler: togglesGET, adminDenied: ROOT_ONLY },
  { name: "toggles PUT", route: "/api/admin/toggles", method: "PUT", handler: togglesPUT, body: { toggle: "sagemaker", enabled: false, password: "x" }, adminDenied: ROOT_ONLY },
  { name: "quota-overrides PUT", route: "/api/admin/quota-overrides", method: "PUT", handler: quotaPUT, body: { scope: "company", id: 1, uploadsPerDay: 5 }, adminDenied: ROOT_ONLY },
  { name: "usage PUT", route: "/api/admin/usage", method: "PUT", handler: usagePUT, body: { target: "company", id: 1, action: "reset" }, adminDenied: ROOT_ONLY },
  { name: "upload-compute PUT", route: "/api/admin/upload-compute", method: "PUT", handler: uploadComputePUT, body: { preset: "nope" }, adminDenied: ROOT_ONLY },
  { name: "yolo-instance PUT", route: "/api/admin/yolo-instance", method: "PUT", handler: yoloInstancePUT, body: { instanceType: "ml.g4dn.xlarge" }, adminDenied: ROOT_ONLY },
  { name: "yolo-runtime PUT", route: "/api/admin/yolo-runtime", method: "PUT", handler: yoloRuntimePUT, body: { maxRuntimeSeconds: 600 }, adminDenied: ROOT_ONLY },
  { name: "tiles PUT", route: "/api/admin/tiles", method: "PUT", handler: tilesPUT, body: { enabled: false }, adminDenied: ROOT_ONLY },
  { name: "app-settings PUT", route: "/api/admin/app-settings", method: "PUT", handler: appSettingsPUT, body: { key: "header_links", value: {} }, adminDenied: "Root admin required" },
  { name: "companies POST", route: "/api/admin/companies", method: "POST", handler: companiesPOST, body: { name: "" }, adminDenied: ROOT_ONLY },
  { name: "model-access POST", route: "/api/admin/model-access", method: "POST", handler: modelAccessPOST, body: {}, adminDenied: ROOT_ONLY },
  { name: "users POST role admin", route: "/api/admin/users", method: "POST", handler: usersPOST, body: { username: "x", email: "x@x.test", password: "longenough", role: "admin" }, adminDenied: "Root admin only: creating a company admin" },
  // [fix round 2] The company's OWN model (made in beforeEach): a static `modelId: 1` resolved to
  // whatever row another file left in the shared DB ("Not found" when it was foreign), and never
  // reached the enabling gate. Own model → the admin is refused AT the gate; root is admitted.
  { name: "models PATCH enable", route: "/api/admin/models", method: "PATCH", handler: modelsPATCH, body: () => ({ modelId: ownModel.id, enabled: true }), adminDenied: "Root admin only: enabling model access" },
  { name: "users/reset-password POST", route: "/api/admin/users/reset-password", method: "POST", handler: resetPasswordPOST, body: { userId: 1, newPassword: "longenough", adminPassword: "x" }, adminDenied: "Root admin required" },
  { name: "yolo-purge DELETE", route: "/api/admin/yolo-purge", method: "DELETE", handler: yoloPurgeDELETE, adminDenied: ROOT_ONLY },
  { name: "yolo/run-batch POST", route: "/api/yolo/run-batch", method: "POST", handler: runBatchPOST, body: {}, adminDenied: ROOT_ONLY },
  // [fix round 2] Own non-demo project (beforeEach): a static `projectId: 1` was whatever row another
  // file in the same run had made — once that was a published demo and the root probe saw 403.
  { name: "pages/textract-rerun POST", route: "/api/pages/textract-rerun", method: "POST", handler: textractRerunPOST, body: () => ({ projectId: ownProject.id, pageNumber: 1 }), adminDenied: ROOT_ONLY },
  { name: "admin/reprocess?scope=shape-parse (Lambda on)", route: "/api/admin/reprocess?scope=shape-parse", method: "POST", handler: reprocessPOST, adminDenied: "Root admin only: this scope fans out owner-billed Lambda invocations", rootProbe: false },
  { name: "processing/dev POST", route: "/api/processing/dev", method: "POST", handler: devPOST, body: { projectId: "x" }, adminDenied: ROOT_ONLY },
  { name: "auth/2fa/disable POST", route: "/api/auth/2fa/disable", method: "POST", handler: disable2faPOST, body: { code: "123456", password: "x" }, adminDenied: ROOT_ONLY, rootProbe: false /* verified path: auth-2fa.route.test.ts */ },
];

const call = async (row: Row) =>
  readJson(await row.handler(makeReq(row.route, { method: row.method, body: typeof row.body === "function" ? row.body() : row.body })));

function asGatedRoot(gate: "enroll" | "verify") {
  sessionState.current = { twoFactorGate: gate } as unknown as AuthSession;
}

let company: Awaited<ReturnType<typeof createCompany>>;
let companyAdmin: FixtureUser;
let root: FixtureUser;
let ownModel: { id: number };
let ownProject: { id: number };

beforeEach(async () => {
  vi.clearAllMocks();
  h.isLambdaCvEnabled.mockReturnValue(true);
  signedOut();
  delete process.env[ROOT_TWO_FACTOR_ENFORCE_ENV];
  if (dbUp) {
    company = await createCompany();
    companyAdmin = await createUser(company.id, { role: "admin" });
    root = await createUser(company.id, { isRootAdmin: true });
    [ownModel] = await db
      .insert(models)
      .values({ companyId: company.id, name: `M-${company.id}`, type: "yolo", s3Path: `models/m-${company.id}`, config: {} as never })
      .returning({ id: models.id });
    ownProject = await createProject(company.id, companyAdmin.id);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env[ROOT_TWO_FACTOR_ENFORCE_ENV];
});

describe.skipIf(!dbUp)("root-only surface (2026-10-25)", () => {
  it.each(rows.map((row) => [row.name, row] as const))("%s: company admin → 403, gated root → 401, verified root admitted", async (_name, row) => {
    asUser(companyAdmin);
    let r = await call(row);
    expect(r.status, `${row.name} as company admin`).toBe(403);
    expect(r.body.error.message).toBe(row.adminDenied);

    for (const gate of ["enroll", "verify"] as const) {
      asGatedRoot(gate);
      r = await call(row);
      expect(r.status, `${row.name} as gated root (${gate})`).toBe(401);
      expect(r.body).toEqual({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
    }

    if (row.rootProbe !== false) {
      asUser(root); // the harness projects the database flag: a verified root session
      r = await call(row);
      expect([401, 403], `${row.name} as verified root → ${r.status} ${JSON.stringify(r.body)}`).not.toContain(r.status);
    }
    expect(h.toggles.setToggle.mock.calls.length + h.processProject.mock.calls.length).toBeLessThanOrEqual(row.rootProbe === false ? 0 : 1);
  });

  it("the manifest's ROOT_ONLY_SURFACES covers every row here (the list is the inventory)", () => {
    const listed = new Set(ROOT_ONLY_SURFACES.flatMap((s: { route: string; methods: string[] }) => s.methods.map((m) => `${m} ${s.route}`)));
    for (const row of rows) {
      expect(listed.has(`${row.method} ${row.route.split("?")[0]}`), `${row.method} ${row.route} missing from ROOT_ONLY_SURFACES`).toBe(true);
    }
  });

  it("a member-role root with the ENFORCE switch off is root on the password alone (logged); with it on, the same login is gated", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const token: Record<string, unknown> = { dbId: root.id, isRootAdmin: true };
    await stampRootTwoFactorAtSignIn(token);
    expect(projectRootAuthority(token).rootTwoFactorGate).toBe("enroll");

    process.env[ROOT_TWO_FACTOR_ENFORCE_ENV] = "0";
    expect(projectRootAuthority(token)).toMatchObject({ isRootAdmin: true, rootTwoFactorGate: null });
    asUser(root);
    expect((await call(rows[0])).status).toBe(200);
    expect(err.mock.calls.some((c) => String(c[0]).includes("[SECURITY] ROOT_2FA_ENFORCE=0"))).toBe(true);

    delete process.env[ROOT_TWO_FACTOR_ENFORCE_ENV];
    expect(projectRootAuthority(token).rootTwoFactorGate).toBe("enroll");
    asGatedRoot("enroll");
    expect((await call(rows[0])).status).toBe(401);
  });

  it("break-glass: deleting the enrollment row (root_admin.sh 2fa-reset) turns a verified login into an 'enroll' gate on its next refresh", async () => {
    await db.insert(appSettings).values({
      key: rootTwoFactorSettingKey(root.id),
      value: { secretEnc: "x", backupCodeHashes: [], enrolledAt: new Date().toISOString(), verified: { nonce1: Date.now() + 60_000 } },
      updatedBy: root.id,
    });
    const token: Record<string, unknown> = { dbId: root.id, isRootAdmin: true, twoFactorNonce: "nonce1" };
    expect(await refreshJwtSessionClaims(token as never)).toBe(token);
    expect(projectRootAuthority(token)).toMatchObject({ isRootAdmin: true, rootTwoFactorGate: null });

    await db.delete(appSettings).where(eq(appSettings.key, rootTwoFactorSettingKey(root.id)));
    expect(await refreshJwtSessionClaims(token as never)).toBe(token);
    expect(projectRootAuthority(token)).toMatchObject({ isRootAdmin: false, rootTwoFactorGate: "enroll" });
  });
});
