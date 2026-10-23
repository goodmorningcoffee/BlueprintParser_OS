// @vitest-environment node
// [2026-10-23] Root authenticator-app (TOTP) 2FA — end to end through the real route shells and the
// real app_settings table (auth() mocked by the harness; the session cookie's private claims are
// supplied through a mocked next-auth/jwt getToken, which is how the service reads the login nonce).
//
// Covered: enroll → confirm (wrong code refused, backup codes shown once, secret stored only
// encrypted, enrolling login stays root) · a fresh root login is PENDING: root route 403, admin
// route 200, status 403 · verify: wrong code 401, right code 200 → claims refresh → root route 200,
// replay 401, ±1-step drift accepted · backup code works exactly once · generic app-settings hides
// and refuses the prefix · disable needs a current code · a non-enrolled root is unaffected ·
// regenerate needs a code and invalidates the old set · verify without a token / not enrolled ·
// a company admin cannot enroll · [fix round 1] a PENDING root acts on /api/admin/users with its
// ROLE only (member → 403; admin → own company, no role/company moves, no cross-company delete) ·
// an ACTIVE enrollment cannot be replaced by enroll/confirm (disable with a code first) ·
// [fix round 2] a refresh derives the 2FA claims from the FRESH root flag (a re-promoted root is
// pending, never full root) · a pre-2FA cookie without a nonce gets one on its first refresh and
// is never silently locked out (an unrefreshed one gets "sign out and back in").
//
// Clock: `Date` is faked (only Date — timers, pg and bcrypt stay real) and pinned mid-step, so a
// 30-second TOTP boundary can never fall between two calls; enrollRoot() advances one step after
// confirm because the confirming code's step is recorded as lastStep (replay guard).
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";

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
import { defineRoute } from "@/server/api/defineRoute";
import { db } from "@/lib/db";
import { appSettings, users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { encryptApiKey } from "@/lib/crypto";
import { projectRootAuthority, rootTwoFactorSettingKey } from "@/lib/root-two-factor-claims";
import { base32Decode, base32Encode, generateTotpSecret, totpCode, totpStep } from "@/lib/totp";
import {
  ROOT_TWO_FACTOR_SIGN_IN_AGAIN,
  refreshJwtSessionClaims,
  stampRootTwoFactorAtSignIn,
} from "@/server/services/root-two-factor";
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

type Token = { dbId: number; isRootAdmin: boolean; twoFactorRequired?: boolean; twoFactorVerified?: boolean; twoFactorNonce?: string };

/** Sign the fixture user in with this token: the session is what lib/auth.ts would project from it. */
function asLogin(user: FixtureUser, token: Token) {
  const authority = projectRootAuthority(token);
  sessionState.current = {
    user: {
      companyId: user.companyId,
      dbId: user.id,
      username: user.username,
      role: user.role,
      canRunModels: user.canRunModels,
      email: user.email,
      ...authority,
    },
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
const enroll = async () => readJson(await enrollPOST(makeReq("/api/auth/2fa/enroll", { method: "POST" })));
const confirm = (code: string) => post(confirmPOST, "/api/auth/2fa/confirm", { code });
const verify = (code: string) => post(verifyPOST, "/api/auth/2fa/verify", { code });
const disable = (code: string) => post(disablePOST, "/api/auth/2fa/disable", { code });
const regenerate = (code: string) => post(backupPOST, "/api/auth/2fa/backup-codes", { code });
const rootProbe = defineRoute({ auth: "root", handler: () => ({ root: true }) });
const adminProbe = defineRoute({ auth: "admin", handler: () => ({ admin: true }) });
const probe = async (route: Handler) => readJson(await route(makeReq("/api/probe", { method: "GET" })));

const codeNow = (secretBase32: string, drift = 0) =>
  totpCode(base32Decode(secretBase32), totpStep(Date.now()) + drift);
const UNAUTH_CODE = { error: { code: "UNAUTHORIZED", message: "Invalid two-factor code" } };
const ROOT_ONLY = { error: { code: "FORBIDDEN", message: "Root admin only" } };
const SIGN_IN_AGAIN = { error: { code: "UNAUTHORIZED", message: ROOT_TWO_FACTOR_SIGN_IN_AGAIN } };
const ALREADY_ENABLED = {
  error: { code: "CONFLICT", message: "Two-factor authentication is already enabled; disable it with a current code first" },
};
const USER_NOT_FOUND = { error: { code: "NOT_FOUND", message: "User not found" } };
const ADMIN_ONLY = { error: { code: "FORBIDDEN", message: "Admin only" } };

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

async function makeWorld() {
  const company = await createCompany();
  const root = await createUser(company.id, { isRootAdmin: true });
  const admin = await createUser(company.id, { role: "admin" });
  return { company, root, admin };
}

/** Enroll + confirm as a verified root; returns the base32 secret and the backup codes. */
async function enrollRoot(root: FixtureUser) {
  const login = await freshLogin(root);
  expect(login.twoFactorRequired).toBe(false);
  const e = await enroll();
  expect(e.status).toBe(200);
  const c = await confirm(codeNow(e.body.secret));
  expect(c.status).toBe(200);
  advanceOneStep(); // the confirming step is now lastStep; the next codeNow() is a fresh step
  return { secret: e.body.secret as string, backupCodes: c.body.backupCodes as string[], login };
}

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
  h.token.current = null;
  // Pin the clock 5 s into the current step: no step boundary can fall inside a test.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(totpStep(Date.now()) * STEP_MS + 5_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe.skipIf(!dbUp)("root TOTP two-factor (2FA)", () => {
  it("2FA-1 enroll → confirm: key + otpauth shown, wrong code refused, backup codes once, secret stored encrypted, enrolling login stays root", async () => {
    const { root } = await makeWorld();
    const login = await freshLogin(root);
    expect(projectRootAuthority(login)).toEqual({ isRootAdmin: true, rootTwoFactorPending: false });
    expect((await status()).body).toEqual({ enrolled: false, enrolledAt: null, backupCodesRemaining: 0, pendingEnrollment: false });

    const e = await enroll();
    expect(e.status).toBe(200);
    expect(e.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(e.body.otpauth).toBe(
      `otpauth://totp/BlueprintParser:${encodeURIComponent(root.email)}?secret=${e.body.secret}&issuer=BlueprintParser&algorithm=SHA1&digits=6&period=30`,
    );
    expect((await status()).body.pendingEnrollment).toBe(true);
    // Nothing is required of anyone until the code is confirmed.
    expect((await refreshLogin(root, login)).twoFactorRequired).toBe(false);

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

    const s = await status();
    expect(s.body.enrolled).toBe(true);
    expect(s.body.backupCodesRemaining).toBe(10);
    // The enrolling login is marked verified: refreshing it keeps root.
    await refreshLogin(root, login);
    expect(login.twoFactorRequired).toBe(true);
    expect(login.twoFactorVerified).toBe(true);
    expect((await probe(rootProbe)).status).toBe(200);
  });

  it("2FA-2 a fresh root login is PENDING: root 403 / admin 200 / status 403; verify flips it; replay and wrong codes refused; ±1 drift accepted", async () => {
    const { root } = await makeWorld();
    const { secret } = await enrollRoot(root);

    const login = await freshLogin(root);
    expect(login.twoFactorRequired).toBe(true);
    expect(login.twoFactorVerified).toBe(false);
    expect(typeof login.twoFactorNonce).toBe("string");
    expect(projectRootAuthority(login)).toEqual({ isRootAdmin: false, rootTwoFactorPending: true });
    expect(sessionState.current!.user.isRootAdmin).toBe(false);

    let r = await probe(rootProbe);
    expect(r.status).toBe(403);
    expect(r.body).toEqual(ROOT_ONLY);
    expect((await probe(adminProbe)).status).toBe(200); // member role, pending root → admin powers
    expect((await status()).status).toBe(403);
    expect((await enroll()).status).toBe(403);

    r = await verify("000000");
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTH_CODE);
    await refreshLogin(root, login);
    expect(login.twoFactorVerified).toBe(false);
    expect((await probe(rootProbe)).status).toBe(403);

    const code = codeNow(secret);
    r = await verify(code);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ verified: true, method: "totp", backupCodesRemaining: 10 });
    // Before session.update() the cookie is unchanged: still not root.
    expect((await probe(rootProbe)).status).toBe(403);
    await refreshLogin(root, login);
    expect(login.twoFactorVerified).toBe(true);
    expect(projectRootAuthority(login)).toEqual({ isRootAdmin: true, rootTwoFactorPending: false });
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

  it("2FA-3 a backup code verifies a pending login exactly once", async () => {
    const { root } = await makeWorld();
    const { backupCodes } = await enrollRoot(root);
    const login = await freshLogin(root);
    expect(projectRootAuthority(login).rootTwoFactorPending).toBe(true);

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

  it("2FA-5 disable needs a current code; afterwards a fresh root login is unaffected (non-enrolled root)", async () => {
    const { root } = await makeWorld();
    const { secret } = await enrollRoot(root);

    let r = await disable("000000");
    expect(r.status).toBe(401);
    expect(await rowFor(root.id)).toBeTruthy();
    r = await disable("ABCDE-FGHIJ");
    expect(r.status).toBe(401);

    r = await disable(codeNow(secret));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enrolled: false });
    expect(await rowFor(root.id)).toBeUndefined();

    const login = await freshLogin(root);
    expect(login.twoFactorRequired).toBe(false);
    expect(projectRootAuthority(login)).toEqual({ isRootAdmin: true, rootTwoFactorPending: false });
    expect((await probe(rootProbe)).status).toBe(200);
    expect((await disable("123456")).status).toBe(404);
  });

  it("2FA-6 regenerating backup codes needs a code and invalidates the old set", async () => {
    const { root } = await makeWorld();
    const { secret, backupCodes } = await enrollRoot(root);

    expect((await regenerate("000000")).status).toBe(401);
    const r = await regenerate(codeNow(secret));
    expect(r.status).toBe(200);
    expect(r.body.backupCodes).toHaveLength(10);
    expect(r.body.backupCodes).not.toEqual(backupCodes);
    expect((await status()).body.backupCodesRemaining).toBe(10);

    const login = await freshLogin(root);
    expect(projectRootAuthority(login).rootTwoFactorPending).toBe(true);
    expect((await verify(backupCodes[3])).status).toBe(401);
    expect((await verify(r.body.backupCodes[3])).status).toBe(200);
  });

  it("2FA-7 verify needs a verifiable token for the signed-in user, and an enrollment", async () => {
    const { root, admin } = await makeWorld();
    const { secret } = await enrollRoot(root);

    const login = await freshLogin(root);
    h.token.current = null; // no decodable cookie
    let r = await verify(codeNow(secret));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(SIGN_IN_AGAIN);
    h.token.current = { ...login, dbId: login.dbId + 1 }; // a token for someone else
    r = await verify(codeNow(secret));
    expect(r.status).toBe(401);

    await freshLogin(admin); // signed in, not enrolled (and not root)
    r = await verify("123456");
    expect(r.status).toBe(404);
    expect(r.body.error.message).toBe("Two-factor authentication is not enabled");

    signedOut();
    expect((await verify("123456")).status).toBe(401);
  });

  it("2FA-8 only a (verified) root can enroll, confirm, disable or regenerate", async () => {
    const { admin } = await makeWorld();
    await freshLogin(admin);
    for (const r of [await enroll(), await confirm("123456"), await disable("123456"), await regenerate("123456"), await status()]) {
      expect(r.status).toBe(403);
      expect(r.body).toEqual(ROOT_ONLY);
    }
  });

  it("2FA-9 [fix 1] a PENDING root acts with its ROLE only on /api/admin/users: member → 403; admin → own company, no role/company moves, cross-company 404; verified → root again", async () => {
    const { company, root } = await makeWorld();
    expect(root.role).toBe("member"); // root by column only — the admin shell admits it as PENDING
    const other = await createCompany();
    const victim = await createUser(other.id);
    const colleague = await createUser(company.id);
    const victimId = (await userRow(victim.id)).publicId;
    const colleagueId = (await userRow(colleague.id)).publicId;
    const put = (body: unknown) => post(usersPUT, "/api/admin/users", body);
    const del = async (body: unknown) => readJson(await usersDELETE(makeReq("/api/admin/users", { method: "DELETE", body })));

    // (a) member-role root, pending: the shell admits it, the service refuses user management outright.
    await enrollRoot(root);
    let login = await freshLogin(root);
    expect(projectRootAuthority(login)).toEqual({ isRootAdmin: false, rootTwoFactorPending: true });
    expect((await probe(adminProbe)).status).toBe(200);
    for (const r of [
      await put({ id: victimId, role: "admin", companyId: company.id }),
      await put({ id: colleagueId, canRunModels: true }),
      await del({ id: victimId }),
      await del({ id: colleagueId }),
    ]) {
      expect(r.status).toBe(403);
      expect(r.body).toEqual(ADMIN_ONLY);
    }
    expect(await userRow(victim.id)).toMatchObject({ role: "member", companyId: other.id });
    expect(await userRow(colleague.id)).toMatchObject({ role: "member", companyId: company.id, canRunModels: colleague.canRunModels });

    // (b) admin-role root, pending: company-admin powers only.
    const adminRoot = await createUser(company.id, { isRootAdmin: true, role: "admin" });
    const { secret } = await enrollRoot(adminRoot);
    login = await freshLogin(adminRoot);
    expect(projectRootAuthority(login)).toEqual({ isRootAdmin: false, rootTwoFactorPending: true });

    // Cross-company target: indistinguishable from missing, nothing written.
    let r = await put({ id: victimId, role: "admin", companyId: company.id });
    expect(r.status).toBe(404);
    expect(r.body).toEqual(USER_NOT_FOUND);
    expect(await userRow(victim.id)).toMatchObject({ role: "member", companyId: other.id });

    // Own company: canRunModels (any admin) lands; role / companyId (root-only) are ignored.
    r = await put({ id: colleagueId, role: "admin", companyId: other.id, canRunModels: true });
    expect(r.status).toBe(200);
    expect(await userRow(colleague.id)).toMatchObject({ role: "member", companyId: company.id, canRunModels: true });

    // Cross-company delete (reassign, the default) stops at the tenant gate.
    r = await del({ id: victimId });
    expect(r.status).toBe(404);
    expect(r.body).toEqual(USER_NOT_FOUND);
    expect(await userRow(victim.id)).toBeTruthy();
    expect(h.stageProjectDeletionsInTransaction).not.toHaveBeenCalled();

    // (c) after the code: the same login is root again and the root-only moves work.
    expect((await verify(codeNow(secret))).status).toBe(200);
    await refreshLogin(adminRoot, login);
    expect(projectRootAuthority(login)).toEqual({ isRootAdmin: true, rootTwoFactorPending: false });
    r = await put({ id: victimId, role: "admin", companyId: company.id });
    expect(r.status).toBe(200);
    expect(await userRow(victim.id)).toMatchObject({ role: "admin", companyId: company.id });
  });

  it("2FA-10 [fix 3] an ACTIVE enrollment cannot be replaced: enroll 409, confirm of a stale pending 409, old secret still verifies", async () => {
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
    expect(projectRootAuthority(login).rootTwoFactorPending).toBe(true);
    expect((await verify(codeNow(base32Encode(planted)))).status).toBe(401);
    expect((await verify(codeNow(secret))).status).toBe(200);
    await refreshLogin(root, login);

    // The sanctioned route to a new secret: disable with a current code, then enroll.
    advanceOneStep();
    expect((await disable(codeNow(secret))).status).toBe(200);
    expect((await enroll()).status).toBe(200);
  });

  it("2FA-11 [fix2 1] a refresh derives 2FA from the FRESH root flag: a re-promoted enrolled root is PENDING, not full root", async () => {
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
    const refreshed = await refreshJwtSessionClaims(stale);
    expect(refreshed).toBe(stale);
    expect(stale).toMatchObject({ isRootAdmin: true, twoFactorRequired: true, twoFactorVerified: false });
    expect(projectRootAuthority(stale)).toEqual({ isRootAdmin: false, rootTwoFactorPending: true });
    asLogin(root, stale);
    expect((await probe(rootProbe)).status).toBe(403);

    // A token naming no live user ends the session; the 2FA claims are never computed for it.
    const ghost: Token = { dbId: 2_000_000_000, isRootAdmin: true };
    expect(await refreshJwtSessionClaims(ghost)).toBeNull();
    expect(ghost.twoFactorNonce).toBeUndefined();
  });

  it("2FA-12 [fix2 2] a pre-2FA cookie without a nonce: first refresh mints one (stable), enroll+confirm+verify work; an unrefreshed cookie gets 'sign out and back in', never a silent lockout", async () => {
    const { root } = await makeWorld();
    const legacy: Token = { dbId: root.id, isRootAdmin: true }; // minted before 2FA shipped
    asLogin(root, legacy);

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

    // Now the same enrollment confirms and the enrolling login stays root.
    r = await confirm(codeNow(e.body.secret));
    expect(r.status).toBe(200);
    advanceOneStep();
    await refreshLogin(root, legacy);
    expect(legacy).toMatchObject({ twoFactorRequired: true, twoFactorVerified: true, twoFactorNonce: nonce });
    expect((await probe(rootProbe)).status).toBe(200);

    // Another pre-2FA session (second device): pending after its refresh. Until the re-encoded cookie
    // arrives, verify says "sign out and back in"; with it, verify works.
    const second: Token = { dbId: root.id, isRootAdmin: true };
    const unrefreshedCookie = { ...second };
    await refreshLogin(root, second);
    expect(projectRootAuthority(second)).toEqual({ isRootAdmin: false, rootTwoFactorPending: true });
    h.token.current = unrefreshedCookie;
    r = await verify(codeNow(e.body.secret));
    expect(r.status).toBe(401);
    expect(r.body).toEqual(SIGN_IN_AGAIN);
    h.token.current = second;
    r = await verify(codeNow(e.body.secret));
    expect(r.status).toBe(200);
    await refreshLogin(root, second);
    expect(projectRootAuthority(second)).toEqual({ isRootAdmin: true, rootTwoFactorPending: false });
    expect((await probe(rootProbe)).status).toBe(200);
  });
});
