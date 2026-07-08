// @vitest-environment node
// [refactor jul8 S060] CHARACTERIZATION for the admin/password SOLO (POST self-service
// password change), written as THE FREEZE before the fold onto services/change-password.ts.
// ⚠️ THE TRAP (flagged since batch-2 recon): despite living under /api/admin/, this route is
// requireAuth — ANY signed-in user changes THEIR OWN password (session.user.dbId scope). The
// shell must be auth:"session", NOT auth:"admin" — an admin-gated fold would lock members out
// of self-service (PW-1 pins a member reaching the handler). bcrypt REAL (compare-verified).
// Frozen quirk inventory:
//   • !currentPassword || !newPassword || newPassword.length<8 → ONE combined 400 literal
//     "Current and new password required (min 8 chars)".
//   • self-lookup by session dbId → miss → 404 "User not found" (deleted-user-live-session).
//   • !passwordHash → 400 "No password set for this account" (harness users have NULL hash
//     by default — the natural fixture state).
//   • bcrypt.compare fail → 400 "Current password is incorrect"; success → hash(newPw, 12) +
//     updatedAt, {success:true}.
//   • NO try/catch → NO B. POST reads req.json() → E at fold.
// Assertions tagged [S060 fold: … applied] were flipped in the fold commit.
import { describe, expect, inject, it, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { POST as pwPOST } from "@/app/api/admin/password/route";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcrypt";
import { asUser, createCompany, createUser, makeReq, readJson, signedOut } from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

// [S060 fold: A applied] — at freeze this was the legacy flat body {error:"Unauthorized"}.
const UNAUTH = { error: "Unauthorized" };

const postReq = (body: unknown) => makeReq("/api/admin/password", { method: "POST", body });
const malformed = () =>
  new Request("http://test.local/api/admin/password", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{ nope",
  });

async function seedPassworded(companyId: number, plain: string) {
  const u = await createUser(companyId);
  const hash = await bcrypt.hash(plain, 12);
  await db.update(users).set({ passwordHash: hash }).where(eq(users.id, u.id));
  return u;
}
async function hashOf(dbId: number) {
  const [row] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, dbId)).limit(1);
  return row?.passwordHash ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
});

describe.skipIf(!dbUp)("admin/password (PW)", () => {
  it("PW-1 auth: signed-out→401; a plain MEMBER is ALLOWED through (requireAuth NOT requireAdmin — the trap pin)", async () => {
    const company = await createCompany();
    const member = await createUser(company.id); // role member, NOT admin
    let r = await readJson(await pwPOST(postReq({ currentPassword: "a", newPassword: "longenough" })));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH); // [S060 fold: A applied]
    // member reaches the HANDLER (not a 403): null-hash fixture → the no-password 400
    asUser(member);
    r = await readJson(await pwPOST(postReq({ currentPassword: "a", newPassword: "longenough" })));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "No password set for this account" }); // [S060 fold: A applied]
  });

  it("PW-2 validation: missing/short → ONE combined 400 literal", async () => {
    const company = await createCompany();
    const member = await createUser(company.id);
    asUser(member);
    for (const body of [{}, { currentPassword: "x" }, { currentPassword: "x", newPassword: "short7c" }]) {
      const r = await readJson(await pwPOST(postReq(body)));
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "Current and new password required (min 8 chars)" }); // [S060 fold: A applied]
    }
  });

  it("PW-3 deleted-user-live-session → 404 'User not found'", async () => {
    const company = await createCompany();
    const ghost = await createUser(company.id);
    asUser(ghost);
    await db.delete(users).where(eq(users.id, ghost.id)); // session survives, row gone
    const r = await readJson(await pwPOST(postReq({ currentPassword: "x", newPassword: "longenough" })));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "User not found" }); // [S060 fold: A applied]
  });

  it("PW-4 wrong current password → 400 'Current password is incorrect'; hash untouched", async () => {
    const company = await createCompany();
    const u = await seedPassworded(company.id, "old-password");
    const before = await hashOf(u.id);
    asUser(u);
    const r = await readJson(await pwPOST(postReq({ currentPassword: "WRONG", newPassword: "longenough" })));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "Current password is incorrect" }); // [S060 fold: A applied]
    expect(await hashOf(u.id)).toBe(before);
  });

  it("PW-5 happy: correct current → {success:true}, new hash verifies, old rejected", async () => {
    const company = await createCompany();
    const u = await seedPassworded(company.id, "old-password");
    asUser(u);
    const r = await readJson(await pwPOST(postReq({ currentPassword: "old-password", newPassword: "brand-new-pass" })));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    const after = await hashOf(u.id);
    expect(await bcrypt.compare("brand-new-pass", after!)).toBe(true);
    expect(await bcrypt.compare("old-password", after!)).toBe(false);
  });

  it("PW-6 malformed JSON → legacy REJECTS (fold: 400 'Invalid JSON body')", async () => {
    const company = await createCompany();
    const member = await createUser(company.id);
    asUser(member);
    // [S060 fold: E applied]
    await expect(pwPOST(malformed())).rejects.toThrow();
  });
});
