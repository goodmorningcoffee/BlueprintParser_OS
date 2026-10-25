/**
 * [2026-10-25 root hardening] Purpose-bound secret sealing for the root TOTP seed.
 *
 * lib/crypto.ts derives ONE AES key from LLM_KEY_SECRET || NEXTAUTH_SECRET for every stored secret
 * (company LLM keys and, until now, the TOTP seeds), so a NEXTAUTH_SECRET leak gave both forged
 * sessions and the second factor, and rotating it — the standard response to a leak — made every
 * TOTP seed unreadable at once. This box:
 *   • takes its input keying material from ROOT_2FA_KEY when set (a dedicated secret the session
 *     secret never touches), else LLM_KEY_SECRET, else NEXTAUTH_SECRET (so nothing breaks today);
 *   • derives a per-purpose key with HKDF-SHA256 (info = "bp/secret-box/v2/<purpose>"), so a TOTP
 *     key can never decrypt an LLM key and vice versa;
 *   • binds the ciphertext to its purpose through GCM additional data;
 *   • prefixes the ciphertext with "v2:" so legacy ciphertext (lib/crypto.ts format) still opens —
 *     an owner enrolled before this change keeps working, and re-enrolling moves him to v2.
 * Owner runbook: set ROOT_2FA_KEY (any long random string) in the task definition BEFORE enrolling
 * for the first time after this ships, and never rotate it without a 2fa-reset planned.
 */

import crypto from "crypto";
import { decryptApiKey } from "@/lib/crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const VERSION_PREFIX = "v2:";

export class SecretUnreadableError extends Error {
  constructor(purpose: string) {
    super(`Stored ${purpose} secret cannot be decrypted (the encryption key changed): use the break-glass reset`);
    this.name = "SecretUnreadableError";
  }
}

function keyFor(purpose: string): Buffer {
  const ikm = process.env.ROOT_2FA_KEY || process.env.LLM_KEY_SECRET || process.env.NEXTAUTH_SECRET;
  if (!ikm) throw new Error("No encryption key: set ROOT_2FA_KEY, LLM_KEY_SECRET or NEXTAUTH_SECRET");
  return Buffer.from(crypto.hkdfSync("sha256", ikm, "blueprintparser", `bp/secret-box/v2/${purpose}`, 32));
}

/** Seal `plaintext` for `purpose`; the result opens only with openSecret(…, purpose). */
export function sealSecret(plaintext: string, purpose: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, keyFor(purpose), iv);
  cipher.setAAD(Buffer.from(purpose, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return VERSION_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

/** Open a v2 ciphertext for `purpose`, or a legacy lib/crypto.ts ciphertext. Throws SecretUnreadableError. */
export function openSecret(ciphertext: string, purpose: string): string {
  try {
    if (!ciphertext.startsWith(VERSION_PREFIX)) return decryptApiKey(ciphertext);
    const buf = Buffer.from(ciphertext.slice(VERSION_PREFIX.length), "base64");
    const decipher = crypto.createDecipheriv(ALGORITHM, keyFor(purpose), buf.subarray(0, IV_LENGTH));
    decipher.setAAD(Buffer.from(purpose, "utf8"));
    decipher.setAuthTag(buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH));
    return decipher.update(buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH)) + decipher.final("utf8");
  } catch (err) {
    if (err instanceof Error && /encryption key/u.test(err.message)) throw err;
    throw new SecretUnreadableError(purpose);
  }
}
