/**
 * Root-admin authenticator-app (TOTP) two-factor + backup codes.
 *
 * Owner ruling 2026-10-23: no Cognito, no new dependency, no migration. One app_settings row per
 * root user — key `root-2fa:<userId>` (lib/root-two-factor-claims.ts) — holds:
 *   secretEnc          AES-256-GCM (lib/crypto.ts encryptApiKey) of the 20-byte TOTP secret
 *   backupCodeHashes   bcrypt hashes of the 10 single-use backup codes (a used hash is removed)
 *   enrolledAt         ISO timestamp; the row is ACTIVE only when all three above are present
 *   lastStep           last accepted TOTP time-step (replay refusal, lib/totp.ts verifyTotp)
 *   pending            { secretEnc, createdAt } — an enrollment shown to the user but not yet
 *                      confirmed with a valid code; never grants or requires anything
 *   verified           { <twoFactorNonce>: expiresAtMs } — server-side markers, ABSOLUTE lifetime
 *                      (ROOT_TWO_FACTOR_VERIFIED_MARKER_TTL_MS from the moment of verification,
 *                      never extended by activity); the JWT callback re-derives twoFactorVerified
 *                      from the marker on EVERY refresh (a client-supplied flag is never trusted,
 *                      and a once-verified cookie is never trusted either)
 *   failedCount /      persistent code-guess lockout shared by verify, confirm, disable and
 *   lockedUntil        regenerate (login-lockout ladder: 5 failures → 1 min, doubling, cap 1 h);
 *                      survives deploys and task restarts, unlike the middleware's memory buckets
 *
 * Every code check runs inside one transaction holding the row FOR UPDATE, so two concurrent
 * submissions of the same code cannot both be accepted and a backup code is consumed exactly once.
 *
 * [2026-10-25 root hardening] 2FA is MANDATORY (lib/root-two-factor-claims.ts): a root login that
 * has not enrolled, or has not verified in this session, holds a session WITHOUT a user. The
 * status / enroll / confirm / verify routes are therefore auth:"none" shells that identify the
 * caller through requireRootTwoFactorCaller — the encrypted cookie's dbId, re-read against users
 * (must be root in the database RIGHT NOW). Enroll, disable and regenerate require the account
 * PASSWORD as well (a stolen cookie cannot move 2FA to another device); disable and regenerate
 * additionally require a current code and run only for a verified root (auth:"root").
 *
 * [2026-10-23 fix round 1] An ACTIVE enrollment cannot be replaced: enroll and confirm refuse with
 * CONFLICT while the row is active, so the only way to a new secret is disable (which needs a
 * current code) and then enroll again.
 */

import { randomUUID } from "crypto";
import bcrypt from "bcrypt";
import { eq } from "drizzle-orm";
import { getToken } from "next-auth/jwt";
import { z } from "zod";
import { db } from "@/lib/db";
import { appSettings, users } from "@/lib/db/schema";
import { audit } from "@/lib/audit";
import type { AuthSession } from "@/lib/api-utils";
import { decryptApiKey, encryptApiKey } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import {
  rootTwoFactorSettingKey,
  type RootTwoFactorClaims,
} from "@/lib/root-two-factor-claims";
import {
  BACKUP_CODE_COUNT,
  base32Encode,
  generateBackupCodes,
  generateTotpSecret,
  looksLikeBackupCode,
  normalizeBackupCode,
  otpauthUri,
  verifyTotp,
} from "@/lib/totp";
import { ApiError } from "@/server/api/envelope";
import { refreshJwtUserAuthority } from "@/server/services/auth-jwt-authority";
import {
  lockoutRemainingMs,
  nextLockout,
  type RootTwoFactorLockout,
} from "@/server/services/root-two-factor-lockout";

/** A verified root session lives this long from the moment of verification, then re-proves. */
export const ROOT_TWO_FACTOR_VERIFIED_MARKER_TTL_MS = 12 * 60 * 60 * 1000;
const VERIFIED_MARKER_MAX = 20;
const BACKUP_CODE_BCRYPT_ROUNDS = 10;
const MAX_PASSWORD_CHARS = 1024;

export const zTwoFactorCodeBody = z.object({ code: z.string().min(1).max(64) }).strict();
export type TwoFactorCodeBody = z.infer<typeof zTwoFactorCodeBody>;
/** Enroll: the account password proves the caller is more than a cookie. */
export const zTwoFactorPasswordBody = z.object({ password: z.string().min(1).max(MAX_PASSWORD_CHARS) }).strict();
export type TwoFactorPasswordBody = z.infer<typeof zTwoFactorPasswordBody>;
/** Disable / regenerate: a current code AND the account password. */
export const zTwoFactorCodeAndPasswordBody = zTwoFactorCodeBody.extend({
  password: z.string().min(1).max(MAX_PASSWORD_CHARS),
}).strict();
export type TwoFactorCodeAndPasswordBody = z.infer<typeof zTwoFactorCodeAndPasswordBody>;

/**
 * /confirm and /verify when the request's own session cookie carries no readable nonce (a cookie
 * minted before 2FA shipped that has not been refreshed yet, or no decodable token at all).
 */
export const ROOT_TWO_FACTOR_SIGN_IN_AGAIN =
  "This session cannot be verified: sign out and sign back in, then try again";
export const ROOT_TWO_FACTOR_PASSWORD_INCORRECT = "Password incorrect";
export const ROOT_TWO_FACTOR_LOCKED = "Too many failed two-factor attempts; try again later";

interface RootTwoFactorRow extends RootTwoFactorLockout {
  secretEnc?: string;
  backupCodeHashes?: string[];
  enrolledAt?: string;
  lastStep?: number;
  pending?: { secretEnc: string; createdAt: string };
  verified?: Record<string, number>;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = Pick<typeof db, "select">;

function asRow(value: unknown): RootTwoFactorRow {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RootTwoFactorRow) : {};
}

function isActive(row: RootTwoFactorRow): boolean {
  return (
    typeof row.secretEnc === "string" &&
    Array.isArray(row.backupCodeHashes) &&
    typeof row.enrolledAt === "string"
  );
}

async function readRow(reader: Reader, userId: number, lock = false): Promise<RootTwoFactorRow | null> {
  const query = reader
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, rootTwoFactorSettingKey(userId)))
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  return row ? asRow(row.value) : null;
}

async function writeRow(tx: Tx, userId: number, row: RootTwoFactorRow): Promise<void> {
  const key = rootTwoFactorSettingKey(userId);
  const value = row as unknown as Record<string, unknown>;
  const [existing] = await tx.select({ key: appSettings.key }).from(appSettings).where(eq(appSettings.key, key)).limit(1);
  if (existing) {
    await tx.update(appSettings).set({ value, updatedBy: userId, updatedAt: new Date() }).where(eq(appSettings.key, key));
  } else {
    await tx.insert(appSettings).values({ key, value, updatedBy: userId });
  }
}

function pruneMarkers(markers: Record<string, number> | undefined, now: number): Record<string, number> {
  const live = Object.entries(markers ?? {}).filter(([, exp]) => typeof exp === "number" && exp > now);
  live.sort((a, b) => a[1] - b[1]);
  return Object.fromEntries(live.slice(-VERIFIED_MARKER_MAX));
}

function withMarker(row: RootTwoFactorRow, nonce: string | null, now: number): RootTwoFactorRow {
  const verified = pruneMarkers(row.verified, now);
  if (nonce) verified[nonce] = now + ROOT_TWO_FACTOR_VERIFIED_MARKER_TTL_MS;
  // A success also closes the failure ladder.
  return { ...row, verified, failedCount: 0, lockedUntil: undefined, lastFailedAt: undefined };
}

// ── JWT claim maintenance (called from lib/auth.ts callbacks.jwt) ───────────────────────────

type ClaimToken = RootTwoFactorClaims & { dbId?: unknown };

/** Sign-in: a fresh nonce, required = root with an active enrollment, verified = false. */
export async function stampRootTwoFactorAtSignIn(token: ClaimToken): Promise<void> {
  token.twoFactorNonce = randomUUID();
  token.twoFactorVerified = false;
  token.twoFactorRequired = false;
  if (token.isRootAdmin !== true || !Number.isSafeInteger(token.dbId)) return;
  const row = await readRow(db, Number(token.dbId));
  token.twoFactorRequired = row !== null && isActive(row);
}

/**
 * Every refresh (including the client's session.update() → trigger "update"): re-read whether an
 * enrollment is active and whether THIS login's nonce holds a live server-side marker. The marker
 * is the ONLY source of twoFactorVerified — the cookie's previous value is never carried forward,
 * so revoking the marker (disable, re-enroll, password change, break-glass) revokes the session on
 * its next request. Database errors propagate so Auth.js fails the request closed.
 */
export async function refreshRootTwoFactorClaims(token: ClaimToken, now = Date.now()): Promise<void> {
  // A session minted before 2FA shipped has no nonce: mint one once (kept stable afterwards), so
  // the next re-encoded cookie can carry a verified marker instead of locking the owner out.
  if (typeof token.twoFactorNonce !== "string" || token.twoFactorNonce.length === 0) {
    token.twoFactorNonce = randomUUID();
  }
  if (token.isRootAdmin !== true || !Number.isSafeInteger(token.dbId)) {
    token.twoFactorRequired = false;
    token.twoFactorVerified = false;
    return;
  }
  const row = await readRow(db, Number(token.dbId));
  token.twoFactorRequired = row !== null && isActive(row);
  const nonce = typeof token.twoFactorNonce === "string" ? token.twoFactorNonce : null;
  const expiresAt = nonce && row ? row.verified?.[nonce] : undefined;
  token.twoFactorVerified = token.twoFactorRequired && typeof expiresAt === "number" && expiresAt > now;
}

/**
 * Every non-sign-in JWT refresh (lib/auth.ts callbacks.jwt): re-read the user's authority FIRST,
 * then derive the 2FA claims from that fresh isRootAdmin — never from the cookie's stale copy, or a
 * re-promoted root with an active enrollment would come back as full root with no code. A null
 * (deleted / invalid user) ends the session; database errors propagate (fail closed).
 */
export async function refreshJwtSessionClaims<T extends Parameters<typeof refreshJwtUserAuthority>[0] & ClaimToken>(
  token: T,
): Promise<T | null> {
  const refreshed = await refreshJwtUserAuthority(token);
  if (refreshed) await refreshRootTwoFactorClaims(refreshed);
  return refreshed;
}

async function decodeRequestToken(req: Request): Promise<ClaimToken | null> {
  return (await getToken({
    req,
    secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET,
    secureCookie: process.env.NODE_ENV === "production",
  }).catch(() => null)) as ClaimToken | null;
}

/**
 * The login's nonce, read from the encrypted session cookie on the request itself (never from a
 * body or the client-visible session) and bound to the signed-in user's id. Null when the request
 * carries no verifiable token for that user.
 */
export async function readSessionTwoFactorNonce(req: Request, expectedDbId: number): Promise<string | null> {
  const token = await decodeRequestToken(req);
  if (!token || token.dbId !== expectedDbId) return null;
  return typeof token.twoFactorNonce === "string" && token.twoFactorNonce.length > 0 ? token.twoFactorNonce : null;
}

// ── caller identity for the gated routes (status / enroll / confirm / verify) ───────────────

export interface RootTwoFactorCaller {
  id: number;
  companyId: number;
  email: string;
  username: string;
  /** This login's nonce from the cookie; null for a cookie minted before 2FA shipped and not refreshed. */
  nonce: string | null;
}

/**
 * Who is calling a gated two-factor route. A gated root has NO session user (lib/auth.ts), so
 * these routes are auth:"none" and the caller is the encrypted cookie's dbId, re-read against
 * `users` — the row must be root in the database right now (a demoted user, a deleted user or a
 * non-root cookie all get 401/403 before anything is read or written).
 */
export async function requireRootTwoFactorCaller(req: Request): Promise<RootTwoFactorCaller> {
  const token = await decodeRequestToken(req);
  const dbId = token?.dbId;
  if (!token || typeof dbId !== "number" || !Number.isSafeInteger(dbId) || dbId <= 0) {
    throw new ApiError("UNAUTHORIZED", "Unauthorized");
  }
  const [user] = await db
    .select({ id: users.id, companyId: users.companyId, email: users.email, username: users.username, isRootAdmin: users.isRootAdmin })
    .from(users)
    .where(eq(users.id, dbId))
    .limit(1);
  if (!user) throw new ApiError("UNAUTHORIZED", "Unauthorized");
  if (!user.isRootAdmin) throw new ApiError("FORBIDDEN", "Root admin only");
  const nonce = typeof token.twoFactorNonce === "string" && token.twoFactorNonce.length > 0 ? token.twoFactorNonce : null;
  return { id: user.id, companyId: user.companyId, email: user.email, username: user.username, nonce };
}

function callerOf(session: AuthSession): RootTwoFactorCaller {
  return {
    id: session.user.dbId,
    companyId: session.user.companyId,
    email: session.user.email ?? "",
    username: session.user.username,
    nonce: null,
  };
}

// ── password re-entry + persistent lockout ──────────────────────────────────────────────────

/** bcrypt-compares the account password; a wrong one is an UNAUTHORIZED failure on the ladder (via guarded). */
async function assertAccountPassword(userId: number, password: string): Promise<void> {
  const [user] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId)).limit(1);
  const ok = !!user?.passwordHash && (await bcrypt.compare(password, user.passwordHash));
  if (!ok) throw new ApiError("UNAUTHORIZED", ROOT_TWO_FACTOR_PASSWORD_INCORRECT);
}

/** Refuses (429) while the persistent ladder holds a live lock. Read without a lock — advisory only. */
async function assertNotLocked(userId: number, now: number): Promise<void> {
  const row = await readRow(db, userId);
  if (row && lockoutRemainingMs(row, now) > 0) throw new ApiError("RATE_LIMITED", ROOT_TWO_FACTOR_LOCKED);
}

/**
 * Bumps the failure ladder in its OWN transaction (the failing attempt's transaction has rolled
 * back by the time this runs). Audits a lockout the moment one starts.
 */
async function recordFailure(userId: number, now: number): Promise<void> {
  const lockedNow = await db.transaction(async (tx) => {
    const row = (await readRow(tx, userId, true)) ?? {};
    const next = nextLockout(row, now);
    await writeRow(tx, userId, { ...row, ...next });
    return next.lockedUntil !== undefined && lockoutRemainingMs(row, now) <= 0;
  });
  if (lockedNow) audit("root_2fa_lockout", { userId, details: { at: new Date(now).toISOString() } });
}

/** Runs `attempt`; an UNAUTHORIZED outcome is recorded on the ladder (separately) and audited. */
async function guarded<T>(
  caller: RootTwoFactorCaller,
  action: string,
  now: number,
  attempt: () => Promise<T>,
): Promise<T> {
  await assertNotLocked(caller.id, now);
  try {
    return await attempt();
  } catch (err) {
    if (err instanceof ApiError && err.code === "UNAUTHORIZED") {
      await recordFailure(caller.id, now);
      audit(`${action}_failed`, { userId: caller.id, companyId: caller.companyId });
    }
    throw err;
  }
}

// ── code authentication (shared by verify / disable / regenerate) ───────────────────────────

type CodeMethod = "totp" | "backup";

/** Under the row lock: accept a TOTP code (replay-safe) or burn one backup code; throws on failure. */
async function authenticateCodeLocked(
  tx: Tx,
  userId: number,
  code: string,
  now: number,
): Promise<{ row: RootTwoFactorRow; method: CodeMethod }> {
  const row = await readRow(tx, userId, true);
  if (!row || !isActive(row)) throw new ApiError("NOT_FOUND", "Two-factor authentication is not enabled");
  const submitted = code.trim();
  if (!looksLikeBackupCode(submitted)) {
    const secret = Buffer.from(decryptApiKey(row.secretEnc!), "base64");
    const result = verifyTotp(secret, submitted, { nowMs: now, lastStep: row.lastStep ?? null });
    if (result.ok) return { row: { ...row, lastStep: result.step }, method: "totp" };
    throw new ApiError("UNAUTHORIZED", result.reason === "replay" ? "Code already used" : "Invalid two-factor code");
  }
  const normalized = normalizeBackupCode(submitted);
  const hashes = row.backupCodeHashes!;
  for (let i = 0; i < hashes.length; i += 1) {
    if (await bcrypt.compare(normalized, hashes[i])) {
      return { row: { ...row, backupCodeHashes: [...hashes.slice(0, i), ...hashes.slice(i + 1)] }, method: "backup" };
    }
  }
  throw new ApiError("UNAUTHORIZED", "Invalid two-factor code");
}

// ── public service surface ──────────────────────────────────────────────────────────────────

export interface RootTwoFactorStatus {
  enrolled: boolean;
  enrolledAt: string | null;
  backupCodesRemaining: number;
  pendingEnrollment: boolean;
}

/** GET /api/auth/2fa/status — reachable by a gated root (auth:"none" + cookie caller). */
export async function getRootTwoFactorStatus(req: Request): Promise<RootTwoFactorStatus> {
  const caller = await requireRootTwoFactorCaller(req);
  const row = (await readRow(db, caller.id)) ?? {};
  const active = isActive(row);
  return {
    enrolled: active,
    enrolledAt: active ? row.enrolledAt! : null,
    backupCodesRemaining: active ? row.backupCodeHashes!.length : 0,
    pendingEnrollment: typeof row.pending?.secretEnc === "string",
  };
}

const ALREADY_ENABLED = () =>
  new ApiError("CONFLICT", "Two-factor authentication is already enabled; disable it with a current code first");

/**
 * POST /api/auth/2fa/enroll { password } — generate a secret and park it as `pending`; nothing is
 * required of this or any session yet. Needs the ACCOUNT PASSWORD (a stolen cookie alone cannot
 * enroll its own device). Refused (CONFLICT) while an enrollment is ACTIVE — replacing the secret
 * needs disable first.
 */
export async function beginRootTwoFactorEnrollment(
  req: Request,
  body: TwoFactorPasswordBody,
  now = Date.now(),
): Promise<{ secret: string; otpauth: string; account: string; issuer: string }> {
  const caller = await requireRootTwoFactorCaller(req);
  await guarded(caller, "root_2fa_enroll", now, () => assertAccountPassword(caller.id, body.password));
  const secret = generateTotpSecret();
  const secretBase32 = base32Encode(secret);
  const pending = { secretEnc: encryptApiKey(secret.toString("base64")), createdAt: new Date(now).toISOString() };
  await db.transaction(async (tx) => {
    const row = (await readRow(tx, caller.id, true)) ?? {};
    if (isActive(row)) throw ALREADY_ENABLED();
    await writeRow(tx, caller.id, { ...row, pending });
  });
  audit("root_2fa_enrollment_started", { userId: caller.id, companyId: caller.companyId });
  const account = caller.email || caller.username;
  return { secret: secretBase32, otpauth: otpauthUri(account, secretBase32), account, issuer: "BlueprintParser" };
}

/**
 * POST /api/auth/2fa/confirm { code } — a valid code against the pending secret activates it,
 * marks THIS login verified and mints the backup codes (returned once).
 */
export async function confirmRootTwoFactorEnrollment(
  req: Request,
  body: TwoFactorCodeBody,
  now = Date.now(),
): Promise<{ enrolled: true; backupCodes: string[] }> {
  const caller = await requireRootTwoFactorCaller(req);
  // Without this login's nonce the activation could not mark the enrolling login verified, and it
  // would be gated on its next refresh: refuse before anything is written.
  if (!caller.nonce) throw new ApiError("UNAUTHORIZED", ROOT_TWO_FACTOR_SIGN_IN_AGAIN);
  const nonce = caller.nonce;
  const codes = generateBackupCodes(BACKUP_CODE_COUNT);
  const hashes = await Promise.all(codes.map((c) => bcrypt.hash(normalizeBackupCode(c), BACKUP_CODE_BCRYPT_ROUNDS)));
  await guarded(caller, "root_2fa_confirm", now, () =>
    db.transaction(async (tx) => {
      const row = await readRow(tx, caller.id, true);
      // An active secret is never overwritten by a confirm, even if a stale `pending` is present.
      if (row && isActive(row)) throw ALREADY_ENABLED();
      if (!row?.pending?.secretEnc) throw new ApiError("CONFLICT", "No enrollment in progress");
      const secret = Buffer.from(decryptApiKey(row.pending.secretEnc), "base64");
      const result = verifyTotp(secret, body.code, { nowMs: now, lastStep: null });
      if (!result.ok) throw new ApiError("UNAUTHORIZED", "Invalid two-factor code");
      // Markers from a previous enrollment never carry over: only the enrolling login is verified.
      const next = withMarker(
        { secretEnc: row.pending.secretEnc, backupCodeHashes: hashes, enrolledAt: new Date(now).toISOString(), lastStep: result.step },
        nonce,
        now,
      );
      await writeRow(tx, caller.id, next);
    }),
  );
  audit("root_2fa_enrolled", { userId: caller.id, companyId: caller.companyId });
  return { enrolled: true, backupCodes: codes };
}

/** POST /api/auth/2fa/verify { code } — proves this login; the JWT picks the marker up on its next refresh. */
export async function verifyRootTwoFactor(
  req: Request,
  body: TwoFactorCodeBody,
  now = Date.now(),
): Promise<{ verified: true; method: CodeMethod; backupCodesRemaining: number }> {
  const caller = await requireRootTwoFactorCaller(req);
  if (!caller.nonce) throw new ApiError("UNAUTHORIZED", ROOT_TWO_FACTOR_SIGN_IN_AGAIN);
  const nonce = caller.nonce;
  const outcome = await guarded(caller, "root_2fa_verify", now, () =>
    db.transaction(async (tx) => {
      const { row, method } = await authenticateCodeLocked(tx, caller.id, body.code, now);
      const next = withMarker(row, nonce, now);
      await writeRow(tx, caller.id, next);
      return { method, backupCodesRemaining: next.backupCodeHashes!.length };
    }),
  );
  audit("root_2fa_verified", { userId: caller.id, companyId: caller.companyId, details: { method: outcome.method } });
  return { verified: true, ...outcome };
}

/**
 * POST /api/auth/2fa/disable { code, password } (verified root) — a current code AND the account
 * password; the whole row — markers included — is deleted, so every other session of this root is
 * gated on its next request and the account is back in the mandatory-enroll state.
 */
export async function disableRootTwoFactor(
  session: AuthSession,
  body: TwoFactorCodeAndPasswordBody,
  now = Date.now(),
): Promise<{ enrolled: false }> {
  const caller = callerOf(session);
  await guarded(caller, "root_2fa_disable", now, async () => {
    await assertAccountPassword(caller.id, body.password);
    await db.transaction(async (tx) => {
      await authenticateCodeLocked(tx, caller.id, body.code, now);
      await tx.delete(appSettings).where(eq(appSettings.key, rootTwoFactorSettingKey(caller.id)));
    });
  });
  audit("root_2fa_disabled", { userId: caller.id, companyId: caller.companyId });
  return { enrolled: false };
}

/** POST /api/auth/2fa/backup-codes { code, password } (verified root) — replace all backup codes; the new set is returned once. */
export async function regenerateRootTwoFactorBackupCodes(
  session: AuthSession,
  body: TwoFactorCodeAndPasswordBody,
  now = Date.now(),
): Promise<{ backupCodes: string[] }> {
  const caller = callerOf(session);
  const codes = generateBackupCodes(BACKUP_CODE_COUNT);
  const hashes = await Promise.all(codes.map((c) => bcrypt.hash(normalizeBackupCode(c), BACKUP_CODE_BCRYPT_ROUNDS)));
  await guarded(caller, "root_2fa_backup_codes", now, async () => {
    await assertAccountPassword(caller.id, body.password);
    await db.transaction(async (tx) => {
      const { row } = await authenticateCodeLocked(tx, caller.id, body.code, now);
      await writeRow(tx, caller.id, { ...row, backupCodeHashes: hashes });
    });
  });
  audit("root_2fa_backup_codes_regenerated", { userId: caller.id, companyId: caller.companyId });
  return { backupCodes: codes };
}

/**
 * Drop every verified marker for a user (the enrollment itself stays): every session of that root
 * must prove a code again. Called after a password change or reset — a password that just changed
 * is exactly the moment an attacker's verified cookie must stop being root. Never throws: a ledger
 * hiccup must not fail the password write it follows.
 */
export async function revokeRootTwoFactorSessions(userId: number, reason: string): Promise<void> {
  try {
    const revoked = await db.transaction(async (tx) => {
      const row = await readRow(tx, userId, true);
      if (!row || !row.verified || Object.keys(row.verified).length === 0) return 0;
      const count = Object.keys(row.verified).length;
      await writeRow(tx, userId, { ...row, verified: {} });
      return count;
    });
    if (revoked > 0) audit("root_2fa_sessions_revoked", { userId, details: { reason, sessions: revoked } });
  } catch (err) {
    logger.error("[root-2fa] revoking verified sessions failed", { userId, reason, err });
  }
}
