// @vitest-environment node
// [refactor jul7 S051] CHARACTERIZATION for admin/users/reset-password SOLO (POST — root
// force-resets a user's password after confirming their OWN password), written as THE FREEZE
// before the fold onto services/users-reset-password.ts. Solo, SECURITY-CORE. requireAdmin +
// a SECONDARY in-body isRootAdmin gate (403 "Root admin required" — stays in-service, fold
// auth:"admin" NOT root). Real bcrypt. Frozen quirk inventory:
//   • auth: requireAdmin → 401/403 "Admin only"; then !isRootAdmin → 403 "Root admin required".
//   • {userId,newPassword,adminPassword}; !userId||!newPassword||newPassword.length<8||
//     !adminPassword → 400 "userId, newPassword (min 8 chars), and adminPassword required".
//   • self passwordHash lookup (session.user.dbId); !passwordHash → 400 "Admin account has no
//     password set"; bcrypt.compare(adminPassword, hash) false → 403 "Admin password
//     incorrect"; target user by Number(userId) missing → 404 "User not found".
//   • bcrypt.hash(newPassword, 12) → update target passwordHash + updatedAt → {success:true}.
// Body IS read → E at fold. No catch-500 → NO B. Assertions tagged [S051 fold: … applied]
// were flipped in the fold commit onto services/users-reset-password.ts.
import { describe, expect, inject, it, beforeEach, vi } from "vitest";
import bcrypt from "bcrypt";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { POST as rpPOST } from "@/app/api/admin/users/reset-password/route";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { asUser, createCompany, createUser, makeReq, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const ADMIN_PW = "rootpass123";
async function makeWorld(rootHasPw = true) {
  const company = await createCompany();
  const hash = rootHasPw ? await bcrypt.hash(ADMIN_PW, 12) : null;
  const root = await createUser(company.id, { isRootAdmin: true, passwordHash: hash });
  const admin = await createUser(company.id, { role: "admin" });
  const member = await createUser(company.id);
  const target = await createUser(company.id);
  return { company, root, admin, member, target };
}

const post = (body: unknown) => makeReq("/api/admin/users/reset-password", { method: "POST", body });
const UNAUTH = { error: { code: "UNAUTHORIZED", message: "Unauthorized" } }; // [S051 fold: A applied]
const ADMIN_ONLY = { error: { code: "FORBIDDEN", message: "Admin only" } }; // [S051 fold: A applied]
const ROOT_REQUIRED = { error: { code: "FORBIDDEN", message: "Root admin required" } }; // [S051 fold: A applied]
const GOOD = (over: Record<string, unknown> = {}) => ({ userId: 0, newPassword: "newpass12", adminPassword: ADMIN_PW, ...over });

async function userHash(id: number) {
  const [u] = await db.select({ h: users.passwordHash }).from(users).where(eq(users.id, id)).limit(1);
  return u.h;
}

beforeEach(() => { vi.clearAllMocks(); signedOut(); });

describe.skipIf(!dbUp)("admin/users/reset-password (RP)", () => {
  it("RP-1 auth: signed-out→401, member→403 Admin only, company-admin→403 Root admin required", async () => {
    const { admin, member, target } = await makeWorld();
    let r = await readJson(await rpPOST(post(GOOD({ userId: target.id }))));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S051 fold: A applied]
    asUser(member);
    r = await readJson(await rpPOST(post(GOOD({ userId: target.id }))));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ADMIN_ONLY); // [S051 fold: A applied]
    // a company-ADMIN passes requireAdmin but the secondary gate blocks → "Root admin required"
    asUser(admin);
    r = await readJson(await rpPOST(post(GOOD({ userId: target.id }))));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ROOT_REQUIRED); // [S051 fold: A applied] — the secondary root gate
  });

  it("RP-2 validation: missing fields / short password → 400 literal", async () => {
    const { root, target } = await makeWorld();
    asUser(root);
    for (const body of [
      {},
      GOOD({ userId: 0, adminPassword: ADMIN_PW, newPassword: "short7" }), // <8 chars (userId falsy too)
      { userId: target.id, newPassword: "shorty7", adminPassword: ADMIN_PW }, // 7 chars
      { userId: target.id, newPassword: "longenough", adminPassword: "" }, // no adminPassword
      { newPassword: "longenough", adminPassword: ADMIN_PW }, // no userId
    ]) {
      const r = await readJson(await rpPOST(post(body)));
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: { code: "VALIDATION", message: "userId, newPassword (min 8 chars), and adminPassword required" } }); // [S051 fold: A applied]
    }
  });

  it("RP-3 root has no password set → 400 'Admin account has no password set'", async () => {
    const { root, target } = await makeWorld(false); // root passwordHash = null
    asUser(root);
    const r = await readJson(await rpPOST(post(GOOD({ userId: target.id }))));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "VALIDATION", message: "Admin account has no password set" } }); // [S051 fold: A applied]
  });

  it("RP-4 wrong adminPassword → 403 'Admin password incorrect' (bcrypt.compare false)", async () => {
    const { root, target } = await makeWorld();
    asUser(root);
    const r = await readJson(await rpPOST(post(GOOD({ userId: target.id, adminPassword: "wrongpass" }))));
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: { code: "FORBIDDEN", message: "Admin password incorrect" } }); // [S051 fold: A applied]
    // target NOT changed
    expect(await userHash(target.id)).toBeNull();
  });

  it("RP-5 target user not found → 404 'User not found'", async () => {
    const { root } = await makeWorld();
    asUser(root);
    const r = await readJson(await rpPOST(post(GOOD({ userId: 999999 }))));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: "NOT_FOUND", message: "User not found" } }); // [S051 fold: A applied]
  });

  it("RP-6 happy: verifies admin pw + bcrypt-hashes(12) the new password onto the target → {success:true}", async () => {
    const { root, target } = await makeWorld();
    asUser(root);
    const r = await readJson(await rpPOST(post(GOOD({ userId: target.id, newPassword: "brandnew99" }))));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    const h = await userHash(target.id);
    expect(h).toBeTruthy();
    expect(await bcrypt.compare("brandnew99", h!)).toBe(true); // the new password now verifies
  });
});
