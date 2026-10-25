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
 * [fix round — verifier M1] Opening a v2 ciphertext TRIES EVERY candidate keying material in
 * precedence order (ROOT_2FA_KEY, LLM_KEY_SECRET, NEXTAUTH_SECRET): a seed sealed before
 * ROOT_2FA_KEY was set still opens after it is set, and one sealed under ROOT_2FA_KEY still opens
 * if a task definition is ever registered without it. Sealing always uses the first present key.
 * ROOT_2FA_KEY is wired through terraform (infrastructure/terraform/secrets.tf → ecs.tf) as the
 * `root_2fa_key` variable, so a release cannot drop it. Rotating ROOT_2FA_KEY itself still needs
 * a 2fa-reset planned (the old value is not kept anywhere).
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

/** Candidate input keying materials, precedence order, duplicates and blanks dropped. */
function candidateIkms(): string[] {
  const seen = new Set<string>();
  for (const name of ["ROOT_2FA_KEY", "LLM_KEY_SECRET", "NEXTAUTH_SECRET"]) {
    const value = process.env[name];
    if (value) seen.add(value);
  }
  if (seen.size === 0) throw new Error("No encryption key: set ROOT_2FA_KEY, LLM_KEY_SECRET or NEXTAUTH_SECRET");
  return [...seen];
}

function keyFrom(ikm: string, purpose: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", ikm, "blueprintparser", `bp/secret-box/v2/${purpose}`, 32));
}

/** The sealing key: the first present candidate. */
function keyFor(purpose: string): Buffer {
  return keyFrom(candidateIkms()[0], purpose);
}

function openV2(buf: Buffer, key: Buffer, purpose: string): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, buf.subarray(0, IV_LENGTH));
  decipher.setAAD(Buffer.from(purpose, "utf8"));
  decipher.setAuthTag(buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH));
  return decipher.update(buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH)) + decipher.final("utf8");
}

/** Seal `plaintext` for `purpose`; the result opens only with openSecret(…, purpose). */
export function sealSecret(plaintext: string, purpose: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, keyFor(purpose), iv);
  cipher.setAAD(Buffer.from(purpose, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return VERSION_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

/**
 * Open a v2 ciphertext for `purpose` (trying every candidate key, precedence order), or a legacy
 * lib/crypto.ts ciphertext. Throws SecretUnreadableError when no key opens it.
 */
export function openSecret(ciphertext: string, purpose: string): string {
  let ikms: string[];
  try {
    if (!ciphertext.startsWith(VERSION_PREFIX)) return decryptApiKey(ciphertext);
    ikms = candidateIkms();
  } catch (err) {
    if (err instanceof Error && /encryption key/u.test(err.message)) throw err;
    throw new SecretUnreadableError(purpose);
  }
  const buf = Buffer.from(ciphertext.slice(VERSION_PREFIX.length), "base64");
  for (const ikm of ikms) {
    try {
      return openV2(buf, keyFrom(ikm, purpose), purpose);
    } catch {
      /* next candidate */
    }
  }
  throw new SecretUnreadableError(purpose);
}
