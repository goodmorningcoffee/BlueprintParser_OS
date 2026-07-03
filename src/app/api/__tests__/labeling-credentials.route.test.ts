// @vitest-environment node
// [refactor jul3 P1.5] CHARACTERIZATION for GET /api/labeling/credentials, written as THE FREEZE
// before the P1.5 migration onto services/labeling.ts (no P0.3 file existed). Frozen:
//   • THE regression-prone quirk: a SIGNED-OUT caller gets 403 "Admin only" — NOT 401. The route
//     hand-rolls `!session?.user || (role!=="admin" && !isRootAdmin)` as ONE combined gate. This
//     must NOT be "simplified" to defineRoute auth:"admin" (whose requireSession throws
//     UNAUTHORIZED 401 for a null session before any role check).
//   • the gate is an OR of role==="admin" / isRootAdmin — a root admin whose role is only
//     "member" DOES pass (frozen by the C5 case).
//   • missing env (LABEL_STUDIO_ADMIN_EMAIL / LABEL_STUDIO_ADMIN_PASSWORD) → 503
//     "Label Studio not configured".
//   • 200 = {email,password} straight from env — byte-identical across the fold.
// Assertions tagged [P1.5 fold] were flipped in the fold commit (sanctioned diff A); the freeze
// form is at commit 025c9b7.
import { afterEach, describe, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { GET } from "@/app/api/labeling/credentials/route";
import {
  asUser,
  createCompany,
  createUser,
  makeReq,
  readJson,
  signedOut,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

// [P1.5 fold] the defineRoute shell needs a real Request (legacy GET() took no args — passing
// one was already a no-op against legacy, so the freeze semantics is unchanged).
const creds = () => GET(makeReq("/api/labeling/credentials", { method: "GET" }));

afterEach(() => vi.unstubAllEnvs());

describe.skipIf(!dbUp)("GET /api/labeling/credentials", () => {
  it("signed-out → 403 'Admin only' — NOT 401 (THE frozen quirk: one combined gate)", async () => {
    signedOut();
    const { status, body } = await readJson(await creds());
    expect(status).toBe(403); // frozen at 403 both sides of the fold
    expect(body.error).toEqual({ code: "FORBIDDEN", message: "Admin only" }); // [P1.5 fold] flipped (legacy: bare string)
  });

  it("plain member → 403 'Admin only'", async () => {
    asUser(await createUser((await createCompany()).id)); // default role, not root
    const { status, body } = await readJson(await creds());
    expect(status).toBe(403);
    expect(body.error).toEqual({ code: "FORBIDDEN", message: "Admin only" }); // [P1.5 fold] flipped (legacy: bare string)
  });

  it("admin but env unset → 503 'Label Studio not configured'", async () => {
    asUser(await createUser((await createCompany()).id, { role: "admin" }));
    vi.stubEnv("LABEL_STUDIO_ADMIN_EMAIL", "");
    vi.stubEnv("LABEL_STUDIO_ADMIN_PASSWORD", "");
    const { status, body } = await readJson(await creds());
    expect(status).toBe(503);
    expect(body.error).toEqual({ code: "VALIDATION", message: "Label Studio not configured" }); // [P1.5 fold] flipped (legacy: bare string; status stays 503 via ApiError statusOverride)
  });

  // [DETECTOR closer COV-4] pins the OR in `!email || !password` — a single missing var 503s
  // (an || → && mutation in the service would pass the both-empty case above but fail here).
  it("admin with email set but password unset → 503 (the single-missing arm of the OR)", async () => {
    asUser(await createUser((await createCompany()).id, { role: "admin" }));
    vi.stubEnv("LABEL_STUDIO_ADMIN_EMAIL", "ls-admin@test.invalid");
    vi.stubEnv("LABEL_STUDIO_ADMIN_PASSWORD", "");
    const { status, body } = await readJson(await creds());
    expect(status).toBe(503);
    expect(body.error).toEqual({ code: "VALIDATION", message: "Label Studio not configured" });
  });

  it("admin with env set → 200 {email,password} (success body byte-identical across the fold)", async () => {
    asUser(await createUser((await createCompany()).id, { role: "admin" }));
    vi.stubEnv("LABEL_STUDIO_ADMIN_EMAIL", "ls-admin@test.invalid");
    vi.stubEnv("LABEL_STUDIO_ADMIN_PASSWORD", "ls-secret");
    const { status, body } = await readJson(await creds());
    expect(status).toBe(200);
    expect(body).toEqual({ email: "ls-admin@test.invalid", password: "ls-secret" });
  });

  it("root admin with role 'member' → 200 — the isRootAdmin arm of the OR gate (frozen)", async () => {
    asUser(await createUser((await createCompany()).id, { role: "member", isRootAdmin: true }));
    vi.stubEnv("LABEL_STUDIO_ADMIN_EMAIL", "ls-admin@test.invalid");
    vi.stubEnv("LABEL_STUDIO_ADMIN_PASSWORD", "ls-secret");
    const { status, body } = await readJson(await creds());
    expect(status).toBe(200);
    expect(body).toEqual({ email: "ls-admin@test.invalid", password: "ls-secret" });
  });
});
