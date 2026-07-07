// @vitest-environment node
// [refactor jul7 S055] CHARACTERIZATION for admin/toggles SOLO (GET status + PUT set-password/
// toggle), written as THE FREEZE before the fold onto services/toggles.ts. Solo. requireAdmin.
// Uses @/lib/toggles (S3 app-global + an INDEPENDENT bcrypt toggle-password subsystem) — mocked
// here to control returns. Frozen quirk inventory:
//   • GET → {sagemakerEnabled, quotaEnabled, hasPassword} (bare).
//   • PUT body.action==="set-password": {newPassword,currentPassword}; !newPassword||length<6
//     → 400 "Password must be at least 6 characters"; setTogglePassword → !success → 401
//     {error: result.error} (dynamic domain msg from the lib); success → {success:true}.
//   • PUT toggle: {toggle,enabled,password}; !toggle||typeof enabled!=="boolean"||!password →
//     400 "toggle, enabled, and password required"; toggle∉{sagemaker,quota} → 400 "Invalid
//     toggle"; !hasTogglePassword → 400 "Toggle password not set. Set it first."; !verify →
//     401 "Invalid toggle password"; setToggle(key,enabled) → {success:true,sagemakerEnabled,
//     quotaEnabled}.
// GET no body; PUT body read → E on PUT. No catch-500 → NO B. Sanctioned A + E.
// Assertions tagged [S055 fold] flip in the fold commit.
import { describe, expect, inject, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const h = vi.hoisted(() => ({
  getToggles: vi.fn(), setToggle: vi.fn(), hasTogglePassword: vi.fn(),
  setTogglePassword: vi.fn(), verifyTogglePassword: vi.fn(),
}));
vi.mock("@/lib/toggles", () => h);

import { GET as tgGET, PUT as tgPUT } from "@/app/api/admin/toggles/route";
import { asUser, createCompany, createUser, makeReq, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

async function makeAdmin() {
  const company = await createCompany();
  const admin = await createUser(company.id, { role: "admin" });
  const member = await createUser(company.id);
  return { admin, member };
}

const getReq = () => makeReq("/api/admin/toggles", { method: "GET" });
const put = (body: unknown) => makeReq("/api/admin/toggles", { method: "PUT", body });
const UNAUTH = { error: "Unauthorized" }; // [S055 fold: A → {error:{code:"UNAUTHORIZED",message:"Unauthorized"}}]
const ADMIN_ONLY = { error: "Admin only" }; // [S055 fold: A → {error:{code:"FORBIDDEN",message:"Admin only"}}]

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
  h.getToggles.mockResolvedValue({ sagemakerEnabled: true, quotaEnabled: false });
  h.hasTogglePassword.mockResolvedValue(true);
  h.verifyTogglePassword.mockResolvedValue(true);
  h.setToggle.mockResolvedValue({ sagemakerEnabled: true, quotaEnabled: true });
  h.setTogglePassword.mockResolvedValue({ success: true });
});

describe.skipIf(!dbUp)("admin/toggles (TG)", () => {
  it("TG-1 auth: GET+PUT signed-out→401, member→403", async () => {
    const { member } = await makeAdmin();
    let r = await readJson(await tgGET(getReq()));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S055 fold: A]
    r = await readJson(await tgPUT(put({ toggle: "sagemaker", enabled: true, password: "x" })));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S055 fold: A]
    asUser(member);
    r = await readJson(await tgGET(getReq()));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S055 fold: A]
  });

  it("TG-2 GET → {sagemakerEnabled, quotaEnabled, hasPassword}", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    const r = await readJson(await tgGET(getReq()));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ sagemakerEnabled: true, quotaEnabled: false, hasPassword: true });
  });

  it("TG-3 PUT set-password: short→400, lib-fail→401 dynamic, success→{success:true}", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    let r = await readJson(await tgPUT(put({ action: "set-password", newPassword: "short" }))); // <6
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "Password must be at least 6 characters" }); // [S055 fold: A]
    // lib rejects (e.g. wrong current password) → 401 with the lib's dynamic message
    h.setTogglePassword.mockResolvedValueOnce({ success: false, error: "Current password incorrect" });
    r = await readJson(await tgPUT(put({ action: "set-password", newPassword: "longenough", currentPassword: "wrong" })));
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: "Current password incorrect" }); // [S055 fold: A — dynamic domain msg]
    // success
    r = await readJson(await tgPUT(put({ action: "set-password", newPassword: "longenough" })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    expect(h.setTogglePassword).toHaveBeenLastCalledWith("longenough", undefined);
  });

  it("TG-4 PUT toggle validation: missing / invalid / no-pw-set / wrong-pw", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    // missing fields
    let r = await readJson(await tgPUT(put({ toggle: "sagemaker", enabled: "yes", password: "x" }))); // enabled not boolean
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "toggle, enabled, and password required" }); // [S055 fold: A]
    // invalid toggle name
    r = await readJson(await tgPUT(put({ toggle: "bogus", enabled: true, password: "x" })));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "Invalid toggle" }); // [S055 fold: A]
    // no toggle password set yet
    h.hasTogglePassword.mockResolvedValueOnce(false);
    r = await readJson(await tgPUT(put({ toggle: "sagemaker", enabled: true, password: "x" })));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "Toggle password not set. Set it first." }); // [S055 fold: A]
    // wrong toggle password
    h.verifyTogglePassword.mockResolvedValueOnce(false);
    r = await readJson(await tgPUT(put({ toggle: "sagemaker", enabled: true, password: "wrong" })));
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: "Invalid toggle password" }); // [S055 fold: A]
    expect(h.setToggle).not.toHaveBeenCalled();
  });

  it("TG-5 PUT toggle happy: verify→setToggle(key,enabled)→{success:true,...state}", async () => {
    const { admin } = await makeAdmin();
    asUser(admin);
    const r = await readJson(await tgPUT(put({ toggle: "quota", enabled: true, password: "good" })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, sagemakerEnabled: true, quotaEnabled: true });
    expect(h.setToggle).toHaveBeenCalledWith("quotaEnabled", true); // quota → quotaEnabled key
  });
});
