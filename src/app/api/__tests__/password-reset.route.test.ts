// @vitest-environment node
// [refactor jul6 S036] CHARACTERIZATION for the password pair (forgot + reset), written as
// THE FREEZE before the P1.5 fold onto services/password-reset.ts. REAL crypto/bcrypt;
// email + audit mocked; REAL DB. The [...nextauth] handler is OUT OF SCOPE (3-line
// re-export). Frozen:
//   • WQ-1 forgot (public): "Email required" 400 (typeof guard) · NO-LEAK: unknown email →
//     {success:true} AND no token written (pinned) · known email → raw token in the reset
//     URL (captured via the email mock), SHA-256 HASH stored (never the raw), expiry ~1h ·
//     email-send failure SWALLOWED (still success — token saved for admin retrieval) ·
//     catch-all FIXED "Failed" 500 (malformed lands there → E at fold; S015 class → B).
//   • WQ-2 reset (public): "Token and password required" 400 · SPLIT password rules
//     (≥10 · "at least one uppercase letter" · "at least one digit" — DIFFERENT from
//     register's combined message, do not harmonize) · hashed-token + UNEXPIRED (gt now)
//     lookup → "Invalid or expired reset link" 400 for bad AND expired (same msg) ·
//     happy ROUND-TRIP (forgot's captured token → reset): bcrypt(12) verify, token+expiry
//     CLEARED, audit("password_reset") · FIXED "Failed" catch (→ E/B at fold).
// Assertions tagged [S036 fold] flip in the fold commit (sanctioned A/B/E only).
import { describe, expect, inject, it, vi, beforeEach } from "vitest";
import bcrypt from "bcrypt";
import crypto from "crypto";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});
const h = vi.hoisted(() => ({ sendPasswordResetEmail: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendPasswordResetEmail: h.sendPasswordResetEmail, sendAlertEmail: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));

import { POST as forgotPOST } from "@/app/api/auth/forgot-password/route";
import { POST as resetPOST } from "@/app/api/auth/reset-password/route";
import { createCompany, createUser, makeReq, readJson } from "@/test/harness";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

const dbUp = inject("dbUp") as boolean;
const forgot = (b: unknown) => forgotPOST(makeReq("/api/auth/forgot-password", { body: b }));
const reset = (b: unknown) => resetPOST(makeReq("/api/auth/reset-password", { body: b }));

beforeEach(() => {
  vi.clearAllMocks();
  h.sendPasswordResetEmail.mockResolvedValue(undefined);
});

describe.skipIf(!dbUp)("POST /api/auth/forgot-password (WQ-1)", () => {
  it("email guard 400; NO-LEAK success for unknown email (and no token written)", async () => {
    for (const email of [undefined, 42, ""]) {
      const { status, body } = await readJson(await forgot({ email }));
      expect(status).toBe(400);
      expect(body).toEqual({ error: "Email required" }); // [S036 fold: A]
    }
    const r = await readJson(await forgot({ email: "nobody@nowhere.test" }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true }); // no-leak — same success as a real account
    expect(h.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it("known email: raw token emailed, SHA-256 stored, ~1h expiry; email failure SWALLOWED", async () => {
    const company = await createCompany();
    const u = await createUser(company.id);
    let r = await readJson(await forgot({ email: ` ${u.email.toUpperCase()} ` })); // normalization pin
    expect(r.status).toBe(200);
    const url = h.sendPasswordResetEmail.mock.calls[0][1] as string;
    const rawToken = url.split("token=")[1];
    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row.passwordResetToken).toBe(crypto.createHash("sha256").update(rawToken).digest("hex")); // hash stored, not raw
    const msLeft = row.passwordResetExpires!.getTime() - Date.now();
    expect(msLeft).toBeGreaterThan(55 * 60 * 1000);
    expect(msLeft).toBeLessThanOrEqual(60 * 60 * 1000);
    h.sendPasswordResetEmail.mockRejectedValue(new Error("ses down"));
    r = await readJson(await forgot({ email: u.email }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true }); // swallow — token saved regardless
  });

  it("malformed body → the FIXED 'Failed' 500", async () => {
    // [S036 fold: E — → 400 BAD_REQUEST; genuine failures → B generic]
    const raw = new Request("http://test.local/api/auth/forgot-password", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{oops",
    });
    const { status, body } = await readJson(await forgotPOST(raw));
    expect(status).toBe(500);
    expect(body).toEqual({ error: "Failed" });
  });
});

describe.skipIf(!dbUp)("POST /api/auth/reset-password (WQ-2)", () => {
  it("field + SPLIT password-rule messages (distinct from register's combined)", async () => {
    let r = await readJson(await reset({ token: "t" }));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "Token and password required" }); // [S036 fold: A]
    r = await readJson(await reset({ token: "t", password: "Short1A" }));
    expect(r.body).toEqual({ error: "Password must be at least 10 characters" }); // [S036 fold: A]
    r = await readJson(await reset({ token: "t", password: "alllowercase1" }));
    expect(r.body).toEqual({ error: "Password must contain at least one uppercase letter" }); // SPLIT [S036 fold: A]
    r = await readJson(await reset({ token: "t", password: "NoDigitsHere" }));
    expect(r.body).toEqual({ error: "Password must contain at least one digit" }); // SPLIT [S036 fold: A]
  });

  it("bad token AND expired token → the SAME 'Invalid or expired reset link'", async () => {
    let r = await readJson(await reset({ token: "bogus", password: "Password123" }));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "Invalid or expired reset link" }); // [S036 fold: A]
    const company = await createCompany();
    const u = await createUser(company.id);
    const rawToken = "expired-token-raw";
    await db.update(users).set({
      passwordResetToken: crypto.createHash("sha256").update(rawToken).digest("hex"),
      passwordResetExpires: new Date(Date.now() - 1000),
    }).where(eq(users.id, u.id));
    r = await readJson(await reset({ token: rawToken, password: "Password123" }));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "Invalid or expired reset link" }); // expired ≡ bad [S036 fold: A]
  });

  it("ROUND-TRIP: forgot's token resets the password; hash verifies; token cleared; audit", async () => {
    const company = await createCompany();
    const u = await createUser(company.id);
    await forgot({ email: u.email });
    const rawToken = (h.sendPasswordResetEmail.mock.calls[0][1] as string).split("token=")[1];
    const { status, body } = await readJson(await reset({ token: rawToken, password: "BrandNewPass9" }));
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(await bcrypt.compare("BrandNewPass9", row.passwordHash!)).toBe(true);
    expect(row.passwordResetToken).toBeNull(); // cleared
    expect(row.passwordResetExpires).toBeNull();
    expect(h.audit).toHaveBeenCalledWith("password_reset", expect.objectContaining({ userId: u.id }));
    // token single-use: second attempt fails
    const r2 = await readJson(await reset({ token: rawToken, password: "AnotherPass9" }));
    expect(r2.status).toBe(400);
    expect(r2.body).toEqual({ error: "Invalid or expired reset link" }); // [S036 fold: A]
  });

  it("malformed body → the FIXED 'Failed' 500", async () => {
    // [S036 fold: E — → 400 BAD_REQUEST]
    const raw = new Request("http://test.local/api/auth/reset-password", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{oops",
    });
    const { status, body } = await readJson(await resetPOST(raw));
    expect(status).toBe(500);
    expect(body).toEqual({ error: "Failed" });
  });
});
