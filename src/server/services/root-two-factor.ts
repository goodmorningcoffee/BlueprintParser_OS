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
 *   verified           { <twoFactorNonce>: expiresAtMs } — short-lived server-side markers; the
 *                      JWT callback flips twoFactorVerified ONLY when the token's own nonce has a
 *                      live marker here (a client-supplied flag is never trusted)
 *
 * Every code check runs inside one transaction holding the row FOR UPDATE, so two concurrent
 * submissions of the same code cannot both be accepted and a backup code is consumed exactly once.
 * Enroll / disable / regenerate are reached only through auth:"root" routes, which a PENDING root
 * cannot pass (the session projects isRootAdmin=false until verified).
 */

import { randomUUID } from "crypto";
import bcrypt from "bcrypt";
import { eq } from "drizzle-orm";
import { getToken } from "next-auth/jwt";
import { z } from "zod";
import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import { audit } from "@/lib/audit";
import type { AuthSession } from "@/lib/api-utils";
import { decryptApiKey, encryptApiKey } from "@/lib/crypto";
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

export const ROOT_TWO_FACTOR_VERIFIED_MARKER_TTL_MS = 10 * 60 * 1000;
const VERIFIED_MARKER_MAX = 20;
const BACKUP_CODE_BCRYPT_ROUNDS = 10;

export const zTwoFactorCodeBody = z.object({ code: z.string().min(1).max(64) }).strict();
export type TwoFactorCodeBody = z.infer<typeof zTwoFactorCodeBody>;

interface RootTwoFactorRow {
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
  return { ...row, verified };
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
 * enrollment is active and, while unverified, whether THIS login's nonce holds a live server-side
 * marker. Database errors propagate so Auth.js fails the request closed.
 */
export async function refreshRootTwoFactorClaims(token: ClaimToken, now = Date.now()): Promise<void> {
  if (token.isRootAdmin !== true || !Number.isSafeInteger(token.dbId)) {
    token.twoFactorRequired = false;
    return;
  }
  const row = await readRow(db, Number(token.dbId));
  token.twoFactorRequired = row !== null && isActive(row);
  if (!token.twoFactorRequired || token.twoFactorVerified === true) return;
  const nonce = typeof token.twoFactorNonce === "string" ? token.twoFactorNonce : null;
  const expiresAt = nonce && row ? row.verified?.[nonce] : undefined;
  if (typeof expiresAt === "number" && expiresAt > now) token.twoFactorVerified = true;
}

/**
 * The login's nonce, read from the encrypted session cookie on the request itself (never from a
 * body or the client-visible session) and bound to the signed-in user's id. Null when the request
 * carries no verifiable token for that user.
 */
export async function readSessionTwoFactorNonce(req: Request, expectedDbId: number): Promise<string | null> {
  const token = (await getToken({
    req,
    secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET,
    secureCookie: process.env.NODE_ENV === "production",
  }).catch(() => null)) as ClaimToken | null;
  if (!token || token.dbId !== expectedDbId) return null;
  return typeof token.twoFactorNonce === "string" && token.twoFactorNonce.length > 0 ? token.twoFactorNonce : null;
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

function userOf(session: AuthSession): { id: number; companyId: number; email: string } {
  return { id: session.user.dbId, companyId: session.user.companyId, email: session.user.email ?? "" };
}

// ── public service surface ──────────────────────────────────────────────────────────────────

export interface RootTwoFactorStatus {
  enrolled: boolean;
  enrolledAt: string | null;
  backupCodesRemaining: number;
  pendingEnrollment: boolean;
}

export async function getRootTwoFactorStatus(session: AuthSession): Promise<RootTwoFactorStatus> {
  const row = (await readRow(db, userOf(session).id)) ?? {};
  const active = isActive(row);
  return {
    enrolled: active,
    enrolledAt: active ? row.enrolledAt! : null,
    backupCodesRemaining: active ? row.backupCodeHashes!.length : 0,
    pendingEnrollment: typeof row.pending?.secretEnc === "string",
  };
}

/** Generate a secret and park it as `pending`; nothing is required of this or any session yet. */
export async function beginRootTwoFactorEnrollment(
  session: AuthSession,
): Promise<{ secret: string; otpauth: string; account: string; issuer: string }> {
  const user = userOf(session);
  const secret = generateTotpSecret();
  const secretBase32 = base32Encode(secret);
  const pending = { secretEnc: encryptApiKey(secret.toString("base64")), createdAt: new Date().toISOString() };
  await db.transaction(async (tx) => {
    const row = (await readRow(tx, user.id, true)) ?? {};
    await writeRow(tx, user.id, { ...row, pending });
  });
  audit("root_2fa_enrollment_started", { userId: user.id, companyId: user.companyId });
  const account = user.email || session.user.username;
  return { secret: secretBase32, otpauth: otpauthUri(account, secretBase32), account, issuer: "BlueprintParser" };
}

/** A valid code against the pending secret activates it and mints the backup codes (returned once). */
export async function confirmRootTwoFactorEnrollment(
  session: AuthSession,
  body: TwoFactorCodeBody,
  req: Request,
  now = Date.now(),
): Promise<{ enrolled: true; backupCodes: string[] }> {
  const user = userOf(session);
  const nonce = await readSessionTwoFactorNonce(req, user.id);
  const codes = generateBackupCodes(BACKUP_CODE_COUNT);
  const hashes = await Promise.all(codes.map((c) => bcrypt.hash(normalizeBackupCode(c), BACKUP_CODE_BCRYPT_ROUNDS)));
  await db.transaction(async (tx) => {
    const row = await readRow(tx, user.id, true);
    if (!row?.pending?.secretEnc) throw new ApiError("CONFLICT", "No enrollment in progress");
    const secret = Buffer.from(decryptApiKey(row.pending.secretEnc), "base64");
    const result = verifyTotp(secret, body.code, { nowMs: now, lastStep: null });
    if (!result.ok) throw new ApiError("UNAUTHORIZED", "Invalid two-factor code");
    const next = withMarker(
      {
        secretEnc: row.pending.secretEnc,
        backupCodeHashes: hashes,
        enrolledAt: new Date(now).toISOString(),
        lastStep: result.step,
        verified: row.verified,
      },
      nonce,
      now,
    );
    await writeRow(tx, user.id, next);
  });
  audit("root_2fa_enrolled", { userId: user.id, companyId: user.companyId });
  return { enrolled: true, backupCodes: codes };
}

/** POST /api/auth/2fa/verify — proves this login; the JWT picks the marker up on its next refresh. */
export async function verifyRootTwoFactor(
  session: AuthSession,
  body: TwoFactorCodeBody,
  req: Request,
  now = Date.now(),
): Promise<{ verified: true; method: CodeMethod; backupCodesRemaining: number }> {
  const user = userOf(session);
  const nonce = await readSessionTwoFactorNonce(req, user.id);
  if (!nonce) throw new ApiError("UNAUTHORIZED", "No verifiable session token");
  try {
    const outcome = await db.transaction(async (tx) => {
      const { row, method } = await authenticateCodeLocked(tx, user.id, body.code, now);
      const next = withMarker(row, nonce, now);
      await writeRow(tx, user.id, next);
      return { method, backupCodesRemaining: next.backupCodeHashes!.length };
    });
    audit("root_2fa_verified", { userId: user.id, companyId: user.companyId, details: { method: outcome.method } });
    return { verified: true, ...outcome };
  } catch (err) {
    if (err instanceof ApiError && err.code === "UNAUTHORIZED") {
      audit("root_2fa_verify_failed", { userId: user.id, companyId: user.companyId });
    }
    throw err;
  }
}

/** Disable needs a current code (TOTP or backup); the whole row — markers included — is deleted. */
export async function disableRootTwoFactor(
  session: AuthSession,
  body: TwoFactorCodeBody,
  now = Date.now(),
): Promise<{ enrolled: false }> {
  const user = userOf(session);
  await db.transaction(async (tx) => {
    await authenticateCodeLocked(tx, user.id, body.code, now);
    await tx.delete(appSettings).where(eq(appSettings.key, rootTwoFactorSettingKey(user.id)));
  });
  audit("root_2fa_disabled", { userId: user.id, companyId: user.companyId });
  return { enrolled: false };
}

/** Replace all backup codes (a current code is required); the new set is returned once. */
export async function regenerateRootTwoFactorBackupCodes(
  session: AuthSession,
  body: TwoFactorCodeBody,
  now = Date.now(),
): Promise<{ backupCodes: string[] }> {
  const user = userOf(session);
  const codes = generateBackupCodes(BACKUP_CODE_COUNT);
  const hashes = await Promise.all(codes.map((c) => bcrypt.hash(normalizeBackupCode(c), BACKUP_CODE_BCRYPT_ROUNDS)));
  await db.transaction(async (tx) => {
    const { row } = await authenticateCodeLocked(tx, user.id, body.code, now);
    await writeRow(tx, user.id, { ...row, backupCodeHashes: hashes });
  });
  audit("root_2fa_backup_codes_regenerated", { userId: user.id, companyId: user.companyId });
  return { backupCodes: codes };
}
