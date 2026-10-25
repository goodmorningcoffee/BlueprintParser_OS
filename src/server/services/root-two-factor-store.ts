/**
 * [2026-10-25 root hardening, fix round] The root 2FA enrollment row's READ side, split out of
 * server/services/root-two-factor.ts so the middleware can re-check the live verified marker
 * (verifier L2) without pulling bcrypt / TOTP / the whole service into its bundle. The row
 * layout is documented in root-two-factor.ts; writes stay there.
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import { rootTwoFactorSettingKey } from "@/lib/root-two-factor-claims";
import type { RootTwoFactorLockout } from "@/server/services/root-two-factor-lockout";

export interface RootTwoFactorRow extends RootTwoFactorLockout {
  secretEnc?: string;
  backupCodeHashes?: string[];
  enrolledAt?: string;
  lastStep?: number;
  pending?: { secretEnc: string; createdAt: string };
  verified?: Record<string, number>;
}

export type RootTwoFactorReader = Pick<typeof db, "select">;

export function asRow(value: unknown): RootTwoFactorRow {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RootTwoFactorRow) : {};
}

/** ACTIVE enrollment: seed, backup codes and the enrolledAt stamp are all present. */
export function isActive(row: RootTwoFactorRow): boolean {
  return (
    typeof row.secretEnc === "string" &&
    Array.isArray(row.backupCodeHashes) &&
    typeof row.enrolledAt === "string"
  );
}

export async function readRow(reader: RootTwoFactorReader, userId: number, lock = false): Promise<RootTwoFactorRow | null> {
  const query = reader
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, rootTwoFactorSettingKey(userId)))
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  return row ? asRow(row.value) : null;
}

/**
 * Whether THIS login (its nonce) holds a live server-side verified marker on an ACTIVE enrollment —
 * the same truth the JWT callback derives twoFactorVerified from. The middleware uses it so a
 * cookie whose marker was revoked (disable, password change, 12 h expiry) loses the root
 * rate-limit exemption before the cookie is re-encoded. Database errors propagate (fail closed).
 */
export async function rootTwoFactorMarkerLive(userId: number, nonce: string | null, now = Date.now()): Promise<boolean> {
  if (!nonce) return false;
  const row = await readRow(db, userId);
  if (!row || !isActive(row)) return false;
  const expiresAt = row.verified?.[nonce];
  return typeof expiresAt === "number" && expiresAt > now;
}
