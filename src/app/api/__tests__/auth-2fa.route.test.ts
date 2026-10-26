// @vitest-environment node
// [2026-10-25] Root authenticator-app (TOTP) 2FA — MANDATORY — end to end through the real route
// shells and the real app_settings table (auth() mocked by the harness; the session cookie's private
// claims are supplied through a mocked next-auth/jwt getToken, which is how the gated services
// identify the caller and read the login nonce).
//
// Covered: a fresh root login with no enrollment is GATED "enroll": root / admin / session routes
// all 401 (the session has no user), status works, enroll needs the account password, wrong
// confirm code refused, backup codes shown once, secret stored only encrypted, the enrolling login
// becomes root · an enrolled root's fresh login is GATED "verify": every level 401 until verify;
// replay / wrong codes refused, ±1-step drift accepted · backup code works exactly once · generic
// app-settings hides and refuses the prefix · disable needs code + password and returns the account
// to the enrollment gate — the SAME login is gated on its next refresh (verified is never sticky) ·
// regenerate needs code + password and invalidates the old set · verify / enroll refuse a missing
// or foreign token and a non-root caller · a company admin can reach none of it · a gated root
// cannot touch /api/admin/users at all; verified → root moves work · an ACTIVE enrollment cannot be
// replaced · a refresh derives the claims from the FRESH root flag and never carries a cookie's
// verified flag forward · a pre-2FA cookie without a nonce gets one on its first refresh · the
// persistent lockout ladder (5 failures → 429, survives a "restart", resets on success) · the
// verified marker has an ABSOLUTE 12 h lifetime · a password change revokes other verified logins ·
// ROOT_2FA_ENFORCE=0 admits an unenrolled root with a [SECURITY] log line · break-glass (the row
// deleted as root_admin.sh does) gates every login as "enroll" and enrollment works again.
//
// Clock: `Date` is faked (only Date — timers, pg and bcrypt stay real) and pinned mid-step, so a
// 30-second TOTP boundary can never fall between two calls; enrollRoot() advances one step after
// confirm because the confirming code's step is recorded as lastStep (replay guard).
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import bcrypt from "bcrypt";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});
const h = vi.hoisted(() => ({
  token: { current: null as Record<string, unknown> | null },
  deleteProjectFully: vi.fn(),
  stageProjectDeletionsInTransaction: vi.fn(),
  reconcileCommittedProjectDeletions: vi.fn(),
}));
vi.mock("next-auth/jwt", () => ({ getToken: async () => h.token.current }));
// Safety: the admin/users DELETE probe below must stop at its 404; never let it reach S3/CDN.
vi.mock("@/lib/project-delete", () => ({
  deleteProjectFully: h.deleteProjectFully,
  stageProjectDeletionsInTransaction: h.stageProjectDeletionsInTransaction,
  reconcileCommittedProjectDeletions: h.reconcileCommittedProjectDeletions,
}));

import { GET as statusGET } from "@/app/api/auth/2fa/status/route";
import { POST as enrollPOST } from "@/app/api/auth/2fa/enroll/route";
import { POST as confirmPOST } from "@/app/api/auth/2fa/confirm/route";
import { POST as verifyPOST } from "@/app/api/auth/2fa/verify/route";
import { POST as disablePOST } from "@/app/api/auth/2fa/disable/route";
import { POST as backupPOST } from "@/app/api/auth/2fa/backup-codes/route";
import { GET as settingsGET, PUT as settingsPUT } from "@/app/api/admin/app-settings/route";
import { DELETE as usersDELETE, PUT as usersPUT } from "@/app/api/admin/users/route";
import { POST as passwordPOST } from "@/app/api/admin/password/route";
import { defineRoute } from "@/server/api/defineRoute";
import { db } from "@/lib/db";
import { appSettings, auditLog, users } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";
import { encryptApiKey } from "@/lib/crypto";
import {
  ROOT_TWO_FACTOR_ENFORCE_ENV,
  projectRootAuthority,
  rootTwoFactorSettingKey,
} from "@/lib/root-two-factor-claims";
import { base32Decode, base32Encode, generateTotpSecret, totpCode, totpStep } from "@/lib/totp";
import {
  ROOT_TWO_FACTOR_LOCKED,
  ROOT_TWO_FACTOR_PASSWORD_INCORRECT,
  ROOT_TWO_FACTOR_SIGN_IN_AGAIN,
  ROOT_TWO_FACTOR_VERIFIED_MARKER_TTL_MS,
  refreshJwtSessionClaims,
  stampRootTwoFactorAtSignIn,
} from "@/server/services/root-two-factor";
import { ROOT_TWO_FACTOR_LOCKOUT_THRESHOLD } from "@/server/services/root-two-factor-lockout";
import type { AuthSession } from "@/lib/api-utils";
import {
  createCompany,
  createUser,
  makeReq,
  readJson,
  sessionState,
  signedOut,
  type FixtureUser,
} from "@/test/harness";

const dbUp = inject("dbUp") as boolean;

const PASSWORD = "correct-horse-battery";
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

type Token = { dbId: number; isRootAdmin: boolean; twoFactorRequired?: boolean; twoFactorVerified?: boolean; twoFactorNonce?: string };

/** Sign the fixture user in with this token: the session is what lib/auth.ts would project from it. */
function asLogin(user: FixtureUser, token: Token) {
  const authority = projectRootAuthority(token);
  sessionState.current = authority.rootTwoFactorGate
    ? ({ twoFactorGate: authority.rootTwoFactorGate } as unknown as AuthSession)
    : {
        user: {
          companyId: user.companyId,
          dbId: user.id,
          username: user.username,
          role: user.role,
          canRunModels: user.canRunModels,
          email: user.email,
          isRootAdmin: authority.isRootAdmin,
        },
        twoFactorGate: null,
      };
  h.token.current = token;
}

/** A fresh login for the user, exactly as callbacks.jwt stamps it at sign-in. */
async function freshLogin(user: FixtureUser): Promise<Token> {
  const token: Token = { dbId: user.id, isRootAdmin: user.isRootAdmin };
  await stampRootTwoFactorAtSignIn(token);
  asLogin(user, token);
  return token;
}

/** What session.update() does server-side (the real callbacks.jwt refresh): authority, then marker. */
async function refreshLogin(user: FixtureUser, token: Token): Promise<Token> {
  expect(await refreshJwtSessionClaims(token)).toBe(token);
  asLogin(user, token);
  return token;
}

type Handler = (req: Request) => Promise<Response>;
const post = async (handler: Handler, path: string, body?: unknown) =>
  readJson(await handler(makeReq(path, { method: "POST", body })));
const status = async () => readJson(await statusGET(makeReq("/api/auth/2fa/status", { method: "GET" })));
const enroll = (password = PASSWORD) => post(enrollPOST, "/api/auth/2fa/enroll", { password });
const confirm = (code: string) => post(confirmPOST, "/api/auth/2fa/confirm", { code });
const verify = (code: string) => post(verifyPOST, "/api/auth/2fa/verify", { code });
const disable = (code: string, password = PASSWORD) => post(disablePOST, "/api/auth/2fa/disable", { code, password });
const regenerate = (code: string, password = PASSWORD) => post(backupPOST, "/api/auth/2fa/backup-codes", { code, password });
const rootProbe = defineRoute({ auth: "root", handler: () => ({ root: true }) });
const adminProbe = defineRoute({ auth: "admin", handler: () => ({ admin: true }) });
const sessionProbe = defineRoute({ auth: "session", handler: () => ({ session: true }) });
const probe = async (route: Handler) => readJson(await route(makeReq("/api/probe", { method: "GET" })));

const codeNow = (secretBase32: string, drift = 0) =>
  totpCode(base32Decode(secretBase32), totpStep(Date.now()) + drift);
const UNAUTH_CODE = { error: { code: "UNAUTHORIZED", message: "Invalid two-factor code" } };
const UNAUTHORIZED = { error: { code: "UNAUTHORIZED", message: "Unauthorized" } };
const ROOT_ONLY = { error: { code: "FORBIDDEN", message: "Root admin only" } };
const BAD_PASSWORD = { error: { code: "UNAUTHORIZED", message: ROOT_TWO_FACTOR_PASSWORD_INCORRECT } };
const SIGN_IN_AGAIN = { error: { code: "UNAUTHORIZED", message: ROOT_TWO_FACTOR_SIGN_IN_AGAIN } };
const LOCKED = { error: { code: "RATE_LIMITED", message: ROOT_TWO_FACTOR_LOCKED } };
const ALREADY_ENABLED = {
  error: { code: "CONFLICT", message: "Two-factor authentication is already enabled; disable it with a current code first" },
};

const STEP_MS = 30_000;
/** Move the faked clock forward one TOTP step (the previous step's code becomes a replay). */
const advanceOneStep = () => vi.setSystemTime(Date.now() + STEP_MS);

async function rowFor(userId: number) {
  const [r] = await db.select().from(appSettings).where(eq(appSettings.key, rootTwoFactorSettingKey(userId))).limit(1);
  return r;
}

async function userRow(userId: number) {
  const [r] = await db
    .select({ publicId: users.publicId, role: users.role, companyId: users.companyId, canRunModels: users.canRunModels })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return r;
}

/** audit() is fire-and-forget (timers are real here): let its insert land, then read the actions. */
async function auditActions(userId: number): Promise<string[]> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  const rows = await db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.userId, userId)).orderBy(desc(auditLog.id));
  return rows.map((r) => r.action);
}

async function makeWorld() {
  const company = await createCompany();
  const root = await createUser(company.id, { isRootAdmin: true, passwordHash: PASSWORD_HASH });
  const admin = await createUser(company.id, { role: "admin", passwordHash: PASSWORD_HASH });
  return { company, root, admin };
}

/** Enroll + confirm from the enrollment gate; returns the base32 secret, the backup codes and the (now root) login. */
async function enrollRoot(root: FixtureUser) {
  const login = await freshLogin(root);
  expect(projectRootAuthority(login).rootTwoFactorGate).toBe("enroll");
  const e = await enroll();
  expect(e.status).toBe(200);
  const c = await confirm(codeNow(e.body.secret));
  expect(c.status).toBe(200);
  await refreshLogin(root, login);
  expect(projectRootAuthority(login).rootTwoFactorGate).toBeNull();
  advanceOneStep(); // the confirming step is now lastStep; the next codeNow() is a fresh step
  return { secret: e.body.secret as string, backupCodes: c.body.backupCodes as string[], login };
}

async function expectGated(gate: "enroll" | "verify") {
  expect((sessionState.current as unknown as { twoFactorGate?: string })?.twoFactorGate).toBe(gate);
  for (const route of [rootProbe, adminProbe, sessionProbe]) {
    const r = await probe(route);
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTHORIZED);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
  h.token.current = null;
  delete process.env[ROOT_TWO_FACTOR_ENFORCE_ENV];
  // Pin the clock 5 s into the current step: no step boundary can fall inside a test.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(totpStep(Date.now()) * STEP_MS + 5_000);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env[ROOT_TWO_FACTOR_ENFORCE_ENV];
});

describe.skipIf(!dbUp)("root TOTP two-factor (2FA) — mandatory", () => {
  it("2FA-1 fresh root login is GATED enroll (401 everywhere); enroll needs the password; confirm activates and the enrolling login becomes root", async () => {
    const { root } = await makeWorld();
    const login = await freshLogin(root);
    expect(login.twoFactorRequired).toBe(false);
    expect(projectRootAuthority(login)).toEqual({ isRootAdmin: false, rootTwoFactorPending: true, rootTwoFactorGate: "enroll" });
    await expectGated("enroll");
    expect((await status()).body).toEqual({ enrolled: false, enrolledAt: null, backupCodesRemaining: 0, pendingEnrollment: false });

    let e = await enroll("not the password");
    expect(e.status).toBe(401);
    expect(e.body).toEqual(BAD_PASSWORD);
    expect((await status()).body.pendingEnrollment).toBe(false);

    e = await enroll();
    expect(e.status).toBe(200);
    expect(e.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(e.body.otpauth).toBe(
      `otpauth://totp/BlueprintParser:${encodeURIComponent(root.email)}?secret=${e.body.secret}&issuer=BlueprintParser&algorithm=SHA1&digits=6&period=30`,
    );
    expect((await status()).body.pendingEnrollment).toBe(true);
    // Nothing is required of anyone until the code is confirmed — and the login is still gated.
    await refreshLogin(root, login);
    expect(login.twoFactorRequired).toBe(false);
    await expectGated("enroll");

    const wrong = await confirm("000000");
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual(UNAUTH_CODE);

    const c = await confirm(codeNow(e.body.secret));
    expect(c.status).toBe(200);
    expect(c.body.enrolled).toBe(true);
    expect(c.body.backupCodes).toHaveLength(10);
    for (const code of c.body.backupCodes) expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);

    const row = await rowFor(root.id);
    const value = row.value as Record<string, unknown>;
    expect(typeof value.secretEnc).toBe("string");
    expect(JSON.stringify(value)).not.toContain(e.body.secret);
    for (const code of c.body.backupCodes) expect(JSON.stringify(value)).not.toContain(code.replace("-", ""));
    expect(value.pending).toBeUndefined();
    expect((value.backupCodeHashes as string[]).every((hh) => hh.startsWith("$2"))).toBe(true);
    expect(typeof (value.verified as Record<string, number>)[login.twoFactorNonce!]).toBe("number");
    expect(value.failedCount).toBe(0);

    // The enrolling login is marked verified: refreshing it makes it root.
    await refreshLogin(root, login);
    expect(login.twoFactorRequired).toBe(true);
    expect(login.twoFactorVerified).toBe(true);
    expect((await probe(rootProbe)).status).toBe(200);
    expect((await probe(adminProbe)).status).toBe(200);
    const s = await status();
    expect(s.body.enrolled).toBe(true);
    expect(s.body.backupCodesRemaining).toBe(10);
  });

  it("2FA-2 an enrolled root's fresh login is GATED verify (401 everywhere); verify flips it; replay and wrong codes refused; ±1 drift accepted", async () => {
    const { root } = await makeWorld();
    const { secret } = await enrollRoot(root);

    const login = await freshLogin(root);
    expect(login.twoFactorRequired).toBe(true);
    expect(login.twoFactorVerified).toBe(false);
    expect(typeof login.twoFactorNonce).toBe("string");
    expect(projectRootAuthority(login)).toEqual({ isRootAdmin: false, rootTwoFactorPending: true, rootTwoFactorGate: "verify" });
    await expectGated("verify");
    expect((await status()).status).toBe(200);
    expect((await enroll()).status).toBe(409); // active enrollment: never replaced from the gate
    expect((await disable("123456")).status).toBe(401); // root-only shell, user-less session

    let r = await verify("000000");
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH_CODE);
    await refreshLogin(root, login);
    expect(login.twoFactorVerified).toBe(false);
    await expectGated("verify");

    const code = codeNow(secret);
    r = await verify(code);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ verified: true, method: "totp", backupCodesRemaining: 10 });
    // Before session.update() the cookie is unchanged: still gated.
    await expectGated("verify");
    await refreshLogin(root, login);
    expect(login.twoFactorVerified).toBe(true);
    expect(projectRootAuthority(login)).toEqual({ isRootAdmin: true, rootTwoFactorPending: false, rootTwoFactorGate: null });
    expect((await probe(rootProbe)).status).toBe(200);
    expect((await status()).status).toBe(200);

    // Replay of the accepted code, and of the previous step, is refused; one step ahead is fine.
    r = await verify(code);
    expect(r.status).toBe(401);
    expect(r.body.error.message).toBe("Code already used");
    expect((await verify(codeNow(secret, -1))).status).toBe(401);
    expect((await verify(codeNow(secret, +1))).status).toBe(200);
    expect((await verify(codeNow(secret, +2))).status).toBe(401);
  });

  it("2FA-3 a backup code verifies a gated login exactly once", async () => {
    const { root } = await makeWorld();
    const { backupCodes } = await enrollRoot(root);
    const login = await freshLogin(root);
    expect(projectRootAuthority(login).rootTwoFactorGate).toBe("verify");

    let r = await verify(backupCodes[0].toLowerCase());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ verified: true, method: "backup", backupCodesRemaining: 9 });
    await refreshLogin(root, login);
    expect((await probe(rootProbe)).status).toBe(200);

    r = await verify(backupCodes[0]);
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH_CODE);
    r = await verify(backupCodes[1]);
    expect(r.status).toBe(200);
    expect(r.body.backupCodesRemaining).toBe(8);
    expect((await status()).body.backupCodesRemaining).toBe(8);
  });

  it("2FA-4 the generic app-settings route hides the prefix from everyone and refuses to write it", async () => {
    const { root } = await makeWorld();
    await enrollRoot(root);
    const key = rootTwoFactorSettingKey(root.id);
    expect(await rowFor(root.id)).toBeTruthy();

    const g = await readJson(await settingsGET(makeReq("/api/admin/app-settings", { method: "GET" })));
    expect(g.status).toBe(200);
    expect(Object.keys(g.body).some((k) => k.startsWith("root-2fa:"))).toBe(false);

    for (const k of [key, "root-2fa:999999", "root-2fa:"]) {
      const p = await readJson(await settingsPUT(makeReq("/api/admin/app-settings", { method: "PUT", body: { key: k, value: { secretEnc: "x" } } })));
      expect(p.status).toBe(400);
      expect(p.body).toEqual({ error: { code: "VALIDATION", message: "Root two-factor settings are managed only by /api/auth/2fa" } });
    }
    expect(((await rowFor(root.id)).value as Record<string, unknown>).secretEnc).not.toBe("x");
  });

  it("2FA-5 disable needs code + password; afterwards the SAME login is gated enroll on its next refresh (verified is never sticky)", async () => {
    const { root } = await makeWorld();
    const { secret, login } = await enrollRoot(root);

    let r = await disable("000000");
    expect(r.status).toBe(401);
    expect(await rowFor(root.id)).toBeTruthy();
    r = await disable("ABCDE-FGHIJ");
    expect(r.status).toBe(401);
    r = await disable(codeNow(secret), "wrong password");
    expect(r.status).toBe(401);
    expect(r.body).toEqual(BAD_PASSWORD);
    expect(await rowFor(root.id)).toBeTruthy();

    r = await disable(codeNow(secret));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enrolled: false });
    expect(await rowFor(root.id)).toBeUndefined();

    // The cookie still says verified; the refresh re-derives from the (now absent) marker.
    expect(login.twoFactorVerified).toBe(true);
    await refreshLogin(root, login);
    expect(login).toMatchObject({ twoFactorRequired: false, twoFactorVerified: false });
    await expectGated("enroll");

    const fresh = await freshLogin(root);
    expect(projectRootAuthority(fresh)).toEqual({ isRootAdmin: false, rootTwoFactorPending: true, rootTwoFactorGate: "enroll" });
    await expectGated("enroll");
    expect((await disable("123456")).status).toBe(401);
    expect((await enroll()).status).toBe(200);
  });

  it("2FA-6 regenerating backup codes needs code + password and invalidates the old set", async () => {
    const { root } = await makeWorld();
    const { secret, backupCodes } = await enrollRoot(root);

    expect((await regenerate("000000")).status).toBe(401);
    expect((await regenerate(codeNow(secret), "nope")).status).toBe(401);
    const r = await regenerate(codeNow(secret));
    expect(r.status).toBe(200);
    expect(r.body.backupCodes).toHaveLength(10);
    expect(r.body.backupCodes).not.toEqual(backupCodes);
    expect((await status()).body.backupCodesRemaining).toBe(10);

    const login = await freshLogin(root);
    expect(projectRootAuthority(login).rootTwoFactorGate).toBe("verify");
    expect((await verify(backupCodes[3])).status).toBe(401);
    expect((await verify(r.body.backupCodes[3])).status).toBe(200);
  });

  it("2FA-7 the gated routes need a verifiable token for a DATABASE root: missing → 401, foreign/non-root → refused, signed out → 401", async () => {
    const { root, admin } = await makeWorld();
    const { secret } = await enrollRoot(root);

    const login = await freshLogin(root);
    h.token.current = null; // no decodable cookie
    let r = await verify(codeNow(secret));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTHORIZED);
    expect((await status()).status).toBe(401);
    expect((await enroll()).status).toBe(401);
    h.token.current = { ...login, dbId: 2_000_000_000 }; // a token for nobody
    r = await verify(codeNow(secret));
    expect(r.status).toBe(401);
    h.token.current = { ...login, dbId: admin.id }; // a token for a non-root user
    r = await verify(codeNow(secret));
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ROOT_ONLY);
    // A token that lost its nonce (pre-2FA cookie): clear message, nothing consumed.
    h.token.current = { dbId: root.id, isRootAdmin: true };
    r = await verify(codeNow(secret));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(SIGN_IN_AGAIN);

    signedOut();
    h.token.current = null;
    expect((await verify("123456")).status).toBe(401);
  });

  it("2FA-8 a company admin can reach none of it: gated routes 403 via the database re-read, root routes 403 via the shell", async () => {
    const { admin } = await makeWorld();
    await freshLogin(admin);
    for (const r of [await enroll(), await confirm("123456"), await verify("123456"), await status(), await disable("123456"), await regenerate("123456")]) {
      expect(r.status).toBe(403);
      expect(r.body).toEqual(ROOT_ONLY);
    }
  });

  it("2FA-9 a gated root cannot touch /api/admin/users at all (401); verified, the root-only moves work", async () => {
    const { company, root } = await makeWorld();
    expect(root.role).toBe("member"); // root by column only
    const other = await createCompany();
    const victim = await createUser(other.id);
    const victimId = (await userRow(victim.id)).publicId;
    const put = (body: unknown) => post(usersPUT, "/api/admin/users", body);
    const del = async (body: unknown) => readJson(await usersDELETE(makeReq("/api/admin/users", { method: "DELETE", body })));

    const { secret } = await enrollRoot(root);
    const login = await freshLogin(root);
    await expectGated("verify");
    for (const r of [await put({ id: victimId, role: "admin", companyId: company.id }), await del({ id: victimId })]) {
      expect(r.status).toBe(401);
      expect(r.body).toEqual(UNAUTHORIZED);
    }
    expect(await userRow(victim.id)).toMatchObject({ role: "member", companyId: other.id });
    expect(h.stageProjectDeletionsInTransaction).not.toHaveBeenCalled();

    expect((await verify(codeNow(secret))).status).toBe(200);
    await refreshLogin(root, login);
    expect(projectRootAuthority(login).rootTwoFactorGate).toBeNull();
    const r = await put({ id: victimId, role: "admin", companyId: company.id });
    expect(r.status).toBe(200);
    expect(await userRow(victim.id)).toMatchObject({ role: "admin", companyId: company.id });
  });

  it("2FA-10 an ACTIVE enrollment cannot be replaced: enroll 409, confirm of a stale pending 409, old secret still verifies", async () => {
    const { root } = await makeWorld();
    const { secret } = await enrollRoot(root);
    const before = (await rowFor(root.id)).value as Record<string, unknown>;

    let r = await enroll();
    expect(r.status).toBe(409);
    expect(r.body).toEqual(ALREADY_ENABLED);
    expect((await status()).body).toMatchObject({ enrolled: true, pendingEnrollment: false });

    // A `pending` planted beside the active secret (only the break-glass path could do this now)
    // still cannot be confirmed into the active slot.
    const planted = generateTotpSecret();
    await db
      .update(appSettings)
      .set({ value: { ...before, pending: { secretEnc: encryptApiKey(planted.toString("base64")), createdAt: new Date().toISOString() } } })
      .where(eq(appSettings.key, rootTwoFactorSettingKey(root.id)));
    r = await confirm(codeNow(base32Encode(planted)));
    expect(r.status).toBe(409);
    expect(r.body).toEqual(ALREADY_ENABLED);
    const after = (await rowFor(root.id)).value as Record<string, unknown>;
    expect(after.secretEnc).toBe(before.secretEnc);
    expect(after.backupCodeHashes).toEqual(before.backupCodeHashes);

    // A fresh login verifies with the ORIGINAL authenticator, not the planted one.
    const login = await freshLogin(root);
    expect(projectRootAuthority(login).rootTwoFactorGate).toBe("verify");
    expect((await verify(codeNow(base32Encode(planted)))).status).toBe(401);
    expect((await verify(codeNow(secret))).status).toBe(200);
    await refreshLogin(root, login);

    // The sanctioned route to a new secret: disable with code + password, then enroll (password).
    advanceOneStep();
    expect((await disable(codeNow(secret))).status).toBe(200);
    await refreshLogin(root, login);
    await expectGated("enroll");
    expect((await enroll()).status).toBe(200);
  });

  it("2FA-11 a refresh derives 2FA from the FRESH root flag and NEVER from the cookie's verified flag", async () => {
    const { root } = await makeWorld();
    await enrollRoot(root);
    // A cookie from while this user was demoted: the last refresh saw isRootAdmin=false.
    const stale: Token = {
      dbId: root.id,
      isRootAdmin: false,
      twoFactorRequired: false,
      twoFactorVerified: false,
      twoFactorNonce: "login-while-demoted",
    };
    expect(await refreshJwtSessionClaims(stale)).toBe(stale);
    expect(stale).toMatchObject({ isRootAdmin: true, twoFactorRequired: true, twoFactorVerified: false });
    expect(projectRootAuthority(stale).rootTwoFactorGate).toBe("verify");
    asLogin(root, stale);
    await expectGated("verify");

    // A forged / stale cookie claiming verified with no live marker: the refresh clears it.
    const forged: Token = { dbId: root.id, isRootAdmin: true, twoFactorRequired: true, twoFactorVerified: true, twoFactorNonce: "no-such-marker" };
    expect(await refreshJwtSessionClaims(forged)).toBe(forged);
    expect(forged.twoFactorVerified).toBe(false);
    asLogin(root, forged);
    await expectGated("verify");

    // A token naming no live user ends the session; the 2FA claims are never computed for it.
    const ghost: Token = { dbId: 2_000_000_000, isRootAdmin: true };
    expect(await refreshJwtSessionClaims(ghost)).toBeNull();
    expect(ghost.twoFactorNonce).toBeUndefined();
  });

  it("2FA-12 a pre-2FA cookie without a nonce: enroll works, confirm says 'sign out and back in' until a refresh mints the nonce (stable)", async () => {
    const { root } = await makeWorld();
    const legacy: Token = { dbId: root.id, isRootAdmin: true }; // minted before 2FA shipped
    asLogin(root, legacy);
    await expectGated("enroll");

    // The request's cookie has not been re-encoded yet: confirm refuses clearly and activates nothing.
    const e = await enroll();
    expect(e.status).toBe(200);
    let r = await confirm(codeNow(e.body.secret));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(SIGN_IN_AGAIN);
    expect((await status()).body).toMatchObject({ enrolled: false, pendingEnrollment: true });

    // First refresh mints the nonce; later refreshes keep it.
    await refreshLogin(root, legacy);
    const nonce = legacy.twoFactorNonce;
    expect(typeof nonce).toBe("string");
    await refreshLogin(root, legacy);
    expect(legacy.twoFactorNonce).toBe(nonce);

    // Now the same enrollment confirms and the enrolling login becomes root.
    r = await confirm(codeNow(e.body.secret));
    expect(r.status).toBe(200);
    advanceOneStep();
    await refreshLogin(root, legacy);
    expect(legacy).toMatchObject({ twoFactorRequired: true, twoFactorVerified: true, twoFactorNonce: nonce });
    expect((await probe(rootProbe)).status).toBe(200);
  });

  it("2FA-13 persistent lockout: the 6th wrong code within the window is 429, a 'restart' does not reset it, time does, success clears the count", async () => {
    const { root } = await makeWorld();
    const { secret } = await enrollRoot(root);
    const login = await freshLogin(root);
    await expectGated("verify");

    for (let i = 0; i < ROOT_TWO_FACTOR_LOCKOUT_THRESHOLD; i += 1) {
      expect((await verify("000000")).status).toBe(401);
    }
    expect(((await rowFor(root.id)).value as Record<string, unknown>).failedCount).toBe(ROOT_TWO_FACTOR_LOCKOUT_THRESHOLD);
    // Locked: even the RIGHT code is refused until the lock expires (nothing is consumed).
    let r = await verify(codeNow(secret));
    expect(r.status).toBe(429);
    expect(r.body).toEqual(LOCKED);
    expect(await auditActions(root.id)).toContain("root_2fa_lockout");
    // The ladder lives in the row, not in process memory: it is still there after a "restart".
    vi.resetModules();
    expect((await verify(codeNow(secret))).status).toBe(429);

    vi.setSystemTime(Date.now() + 61_000);
    r = await verify(codeNow(secret));
    expect(r.status).toBe(200);
    expect(((await rowFor(root.id)).value as Record<string, unknown>).failedCount).toBe(0);
    await refreshLogin(root, login);
    expect((await probe(rootProbe)).status).toBe(200);

    // The wrong-password path on disable rides the same ladder.
    for (let i = 0; i < ROOT_TWO_FACTOR_LOCKOUT_THRESHOLD; i += 1) {
      expect((await disable(codeNow(secret), "wrong")).status).toBe(401);
    }
    expect((await disable(codeNow(secret))).status).toBe(429);
  });

  it("2FA-14 the verified marker has an ABSOLUTE 12 h lifetime: activity does not extend it, then the login is gated verify", async () => {
    const { root } = await makeWorld();
    const { login } = await enrollRoot(root);
    expect((await probe(rootProbe)).status).toBe(200);

    vi.setSystemTime(Date.now() + ROOT_TWO_FACTOR_VERIFIED_MARKER_TTL_MS - 60_000);
    await refreshLogin(root, login);
    expect((await probe(rootProbe)).status).toBe(200);

    vi.setSystemTime(Date.now() + 120_000);
    await refreshLogin(root, login);
    expect(login.twoFactorVerified).toBe(false);
    await expectGated("verify");
  });

  it("2FA-15 a password change revokes every other verified login of that root", async () => {
    const { root } = await makeWorld();
    const { secret, login: first } = await enrollRoot(root);
    const second = await freshLogin(root);
    expect((await verify(codeNow(secret))).status).toBe(200);
    await refreshLogin(root, second);
    expect((await probe(rootProbe)).status).toBe(200);

    const r = await post(passwordPOST, "/api/admin/password", { currentPassword: PASSWORD, newPassword: "a-new-password-123" });
    expect(r.status).toBe(200);
    expect(await auditActions(root.id)).toEqual(expect.arrayContaining(["root_2fa_sessions_revoked", "password_changed"]));
    expect((await rowFor(root.id)).value as Record<string, unknown>).toMatchObject({ verified: {} });

    await refreshLogin(root, second);
    await expectGated("verify");
    await refreshLogin(root, first);
    await expectGated("verify");
    // The enrollment itself survives: the new password + a code brings the login back.
    advanceOneStep();
    expect((await verify(codeNow(secret))).status).toBe(200);
    await refreshLogin(root, first);
    expect((await probe(rootProbe)).status).toBe(200);
  });

  it("2FA-16 ROOT_2FA_ENFORCE=0 (emergency off-switch) admits an unenrolled and an unverified root as root, logging a [SECURITY] line each time", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { root } = await makeWorld();
    process.env[ROOT_TWO_FACTOR_ENFORCE_ENV] = "0";
    const login = await freshLogin(root);
    expect(projectRootAuthority(login)).toEqual({ isRootAdmin: true, rootTwoFactorPending: false, rootTwoFactorGate: null });
    expect((await probe(rootProbe)).status).toBe(200);
    expect(err.mock.calls.some((c) => String(c[0]).includes("[SECURITY] ROOT_2FA_ENFORCE=0"))).toBe(true);

    delete process.env[ROOT_TWO_FACTOR_ENFORCE_ENV];
    await refreshLogin(root, login);
    await expectGated("enroll");
  });

  it("2FA-17 break-glass: deleting the enrollment row (what root_admin.sh 2fa-reset does) gates every login as enroll; enrolling again works", async () => {
    const { root } = await makeWorld();
    const { login } = await enrollRoot(root);
    expect((await probe(rootProbe)).status).toBe(200);

    await db.delete(appSettings).where(eq(appSettings.key, rootTwoFactorSettingKey(root.id)));
    await refreshLogin(root, login);
    await expectGated("enroll");
    const fresh = await freshLogin(root);
    expect(projectRootAuthority(fresh).rootTwoFactorGate).toBe("enroll");

    const e = await enroll();
    expect(e.status).toBe(200);
    expect((await confirm(codeNow(e.body.secret))).status).toBe(200);
    await refreshLogin(root, fresh);
    expect((await probe(rootProbe)).status).toBe(200);
  });
});
