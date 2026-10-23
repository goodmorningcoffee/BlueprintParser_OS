/**
 * TOTP (RFC 6238) over HOTP (RFC 4226) on node:crypto — no third-party dependency.
 *
 * Fixed profile, matching every mainstream authenticator app's default: HMAC-SHA1, 6 digits,
 * 30-second steps, secrets of 20 random bytes shown as RFC 4648 base32. `verifyTotp` accepts
 * ±1 step of clock drift, compares in constant time, and refuses any step at or before the last
 * accepted one (a code can be used once, and an older still-in-window code cannot follow a newer
 * one). Pure: no I/O, no clock reads unless the caller omits `nowMs`.
 *
 * Tested against the RFC 4226 appendix D and RFC 6238 appendix B vectors (lib/__tests__/totp.test.ts).
 */

import { createHmac, randomBytes, timingSafeEqual } from "crypto";

export const TOTP_DIGITS = 6;
export const TOTP_STEP_SECONDS = 30;
export const TOTP_WINDOW_STEPS = 1;
export const TOTP_SECRET_BYTES = 20;
export const TOTP_ISSUER = "BlueprintParser";
export const BACKUP_CODE_COUNT = 10;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** Backup-code alphabet: no 0/O/1/I so a printed code survives a bad photocopy. */
const BACKUP_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Accepts upper/lower case, spaces, dashes and trailing `=` padding; throws on anything else. */
export function base32Decode(text: string): Buffer {
  const cleaned = text.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (cleaned.length === 0) throw new Error("empty base32 input");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP: HMAC-SHA1 over the 8-byte big-endian counter, dynamic truncation, `digits` digits. */
export function hotp(secret: Buffer, counter: number | bigint, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The RFC 6238 time step (T) for a wall-clock instant. */
export function totpStep(nowMs: number, stepSeconds = TOTP_STEP_SECONDS): number {
  return Math.floor(nowMs / 1000 / stepSeconds);
}

export function totpCode(secret: Buffer, step: number, digits = TOTP_DIGITS): string {
  return hotp(secret, step, digits);
}

export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

/** The `otpauth://totp/...` URI authenticator apps import (also what a QR code would encode). */
export function otpauthUri(account: string, secretBase32: string, issuer = TOTP_ISSUER): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Constant-time string equality; unequal lengths compare false without short-circuiting on content. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Still burn a compare of equal length so the length mismatch is the only timing signal.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export type TotpVerification =
  | { ok: true; step: number }
  | { ok: false; reason: "format" | "mismatch" | "replay" };

/**
 * Verify a submitted code against the secret at `nowMs`, accepting ±`window` steps. Every candidate
 * step is compared (no early exit), and a match at a step ≤ `lastStep` is a replay.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  opts: { nowMs?: number; lastStep?: number | null; window?: number } = {},
): TotpVerification {
  const submitted = code.replace(/\s+/g, "");
  if (!new RegExp(`^[0-9]{${TOTP_DIGITS}}$`).test(submitted)) return { ok: false, reason: "format" };
  const now = opts.nowMs ?? Date.now();
  const window = opts.window ?? TOTP_WINDOW_STEPS;
  const center = totpStep(now);
  let matchedStep: number | null = null;
  for (let delta = -window; delta <= window; delta += 1) {
    const step = center + delta;
    if (step < 0) continue;
    if (constantTimeEqual(totpCode(secret, step), submitted)) matchedStep = step;
  }
  if (matchedStep === null) return { ok: false, reason: "mismatch" };
  const lastStep = opts.lastStep;
  if (typeof lastStep === "number" && matchedStep <= lastStep) return { ok: false, reason: "replay" };
  return { ok: true, step: matchedStep };
}

/** Ten `XXXXX-XXXXX` codes from a 32-symbol alphabet (50 bits each), shown to the user once. */
export function generateBackupCodes(count = BACKUP_CODE_COUNT): string[] {
  const codes: string[] = [];
  while (codes.length < count) {
    const bytes = randomBytes(10);
    let code = "";
    for (let i = 0; i < 10; i += 1) {
      if (i === 5) code += "-";
      code += BACKUP_CODE_ALPHABET[bytes[i] % BACKUP_CODE_ALPHABET.length];
    }
    codes.push(code);
  }
  return codes;
}

/** Canonical form for hashing and comparing a backup code: uppercase, separators removed. */
export function normalizeBackupCode(input: string): string {
  return input.replace(/[\s-]/g, "").toUpperCase();
}

/** True when the submitted string has the shape of a backup code rather than a TOTP code. */
export function looksLikeBackupCode(input: string): boolean {
  return /^[A-Z2-9]{10}$/.test(normalizeBackupCode(input));
}
