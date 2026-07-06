// @vitest-environment node
// [refactor jul6 S034] CHARACTERIZATION for invite + register (both PUBLIC), written as THE
// FREEZE before the P1.5 fold onto services/invite-register.ts. REAL bcrypt (no mock — the
// hashed-vs-plaintext access-key branch is the route's security core); audit mocked; REAL DB.
//   • IQ-1 invite: public request form (⚠️ docs ApiEndpointList labels it auth:"admin" —
//     WRONG, pre-existing drift → ledger). Email regex + ≤254 → flat 400 "Valid email
//     required"; insert normalizes (trim/lowercase/slice 254; name/company trim/slice 100
//     || null); {success:true}. The catch-all returns FIXED "Failed to submit" 500 (no
//     leak — S015 class): malformed bodies land there at legacy (flip E→400 at fold);
//     db failures too (flip B→generic).
//   • IQ-2 register: public. req.json UNGUARDED (raw rejection for malformed). Cascade:
//     all-fields truthy → password ≥10 → password charset → the SECURITY-SENSITIVE
//     full-table access-key scan (bcrypt.compare for "$2" hashes, timingSafeEqual for
//     plaintext — BOTH branches pinned) → generic no-reveal 400 "Invalid access key or
//     email already in use" for bad-key AND email-exists (SAME message, pinned) →
//     bcrypt.hash(12) → insert role:"member" → audit("user_registered") → {success:true}.
//     Email normalized toLowerCase().trim() pre-checks.
// Assertions tagged [S034 fold] flip in the fold commit (sanctioned A/B/E only).
import { describe, expect, inject, it, vi, beforeEach } from "vitest";
import bcrypt from "bcrypt";

// Even though both routes are PUBLIC, the shell imports @/lib/auth (next-auth) — the
// standard harness mock keeps next-auth out of the vitest node graph.
vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

const h = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));

import { POST as invitePOST } from "@/app/api/invite/route";
import { POST as registerPOST } from "@/app/api/register/route";
import { createCompany, createUser, makeReq, readJson } from "@/test/harness";
import { db } from "@/lib/db";
import { inviteRequests, users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

const dbUp = inject("dbUp") as boolean;
const inv = (b: unknown) => invitePOST(makeReq("/api/invite", { body: b }));
const reg = (b: unknown) => registerPOST(makeReq("/api/register", { body: b }));

beforeEach(() => vi.clearAllMocks());

describe.skipIf(!dbUp)("POST /api/invite (IQ-1, public)", () => {
  it("email validation variants → flat 400; happy insert normalizes + nulls optionals", async () => {
    // NOTE the frozen quirk: the regex runs on the RAW string (^[^\s@]) — space-padded
    // emails are REJECTED, so the insert's .trim() is effectively dead and normalization
    // is lowercase-only in practice. Pinned both directions.
    for (const email of [undefined, 42, "nope", "a@b", "x".repeat(250) + "@a.com", " padded@test.com "]) {
      const { status, body } = await readJson(await inv({ email }));
      expect(status).toBe(400);
      expect(body).toEqual({ error: { code: "VALIDATION", message: "Valid email required" } }); // [S034 fold: A applied]
    }
    const uniq = `inv-${Math.random().toString(36).slice(2, 8)}`;
    const r = await readJson(await inv({ email: `${uniq.toUpperCase()}@Test.COM`, name: "  Al  ", company: undefined }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true });
    const [row] = await db.select().from(inviteRequests).where(eq(inviteRequests.email, `${uniq.toLowerCase()}@test.com`));
    expect(row).toBeTruthy();
    expect(row.name).toBe("Al"); // trimmed
    expect(row.company).toBeNull(); // || null
  });

  it("malformed body → the catch-all's FIXED 'Failed to submit' 500 (no leak)", async () => {
    // [S034 fold: E — malformed → 400 BAD_REQUEST "Invalid JSON body"; the fixed 500
    // remains ONLY for genuine runtime failures → B: generic INTERNAL]
    const raw = new Request("http://test.local/api/invite", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{oops",
    });
    const { status, body } = await readJson(await invitePOST(raw));
    expect(status).toBe(400);
    expect(body).toEqual({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } }); // [S034 fold: E applied — the fixed 500 now covers only real runtime failures via B]
  });
});

describe.skipIf(!dbUp)("POST /api/register (IQ-2, public)", () => {
  const F = { username: "newbie", email: "NEW@Test.com ", password: "Password123", accessKey: "" };

  it("cascade: fields → length → charset; each message byte-exact", async () => {
    let r = await readJson(await reg({ username: "u" }));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "VALIDATION", message: "All fields are required" } }); // [S034 fold: A applied]
    r = await readJson(await reg({ ...F, accessKey: "k", password: "Short1A" }));
    expect(r.body).toEqual({ error: { code: "VALIDATION", message: "Password must be at least 10 characters" } }); // [S034 fold: A applied]
    r = await readJson(await reg({ ...F, accessKey: "k", password: "alllowercase1" }));
    expect(r.body).toEqual({ error: { code: "VALIDATION", message: "Password must contain at least one uppercase letter and one number" } }); // [S034 fold: A applied]
    r = await readJson(await reg({ ...F, accessKey: "k", password: "NoNumbersHere" }));
    expect(r.body).toEqual({ error: { code: "VALIDATION", message: "Password must contain at least one uppercase letter and one number" } }); // [S034 fold: A applied]
  });

  it("no-reveal generic 400: bad key AND existing email produce the SAME message", async () => {
    const company = await createCompany(); // plaintext accessKey ak-<tag>
    let r = await readJson(await reg({ ...F, accessKey: "wrong-key-entirely" }));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "VALIDATION", message: "Invalid access key or email already in use" } }); // [S034 fold: A]
    const existing = await createUser(company.id);
    r = await readJson(await reg({ ...F, email: existing.email, accessKey: company.accessKey }));
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { code: "VALIDATION", message: "Invalid access key or email already in use" } }); // SAME msg — no reveal [S034 fold: A]
  });

  it("plaintext-key path (timingSafeEqual) registers; email normalized; role member; audit fires", async () => {
    const company = await createCompany();
    const email = `reg-${Math.random().toString(36).slice(2, 8)}@Test.com`;
    const { status, body } = await readJson(await reg({ username: "plainuser", email: ` ${email.toUpperCase()} `, password: "Password123", accessKey: company.accessKey }));
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    const [row] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
    expect(row).toMatchObject({ username: "plainuser", companyId: company.id, role: "member" });
    expect(row.passwordHash!.startsWith("$2")).toBe(true);
    expect(h.audit).toHaveBeenCalledWith("user_registered", expect.objectContaining({ companyId: company.id }));
  });

  it("hashed-key ($2) path via bcrypt.compare registers", async () => {
    const secret = "hashed-door-key";
    const company = await createCompany({ accessKey: await bcrypt.hash(secret, 4) } as never);
    const email = `reg-${Math.random().toString(36).slice(2, 8)}@test.com`;
    const { status } = await readJson(await reg({ username: "hashuser", email, password: "Password123", accessKey: secret }));
    expect(status).toBe(200);
    const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    expect(row).toBeTruthy();
  });

  it("malformed body → raw rejection (unguarded req.json)", async () => {
    // [S034 fold: E — → 400 BAD_REQUEST "Invalid JSON body"]
    const raw = new Request("http://test.local/api/register", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{oops",
    });
    const rr = await readJson(await registerPOST(raw));
    expect(rr.status).toBe(400);
    expect(rr.body).toEqual({ error: { code: "BAD_REQUEST", message: "Invalid JSON body" } }); // [S034 fold: E applied]
  });
});
