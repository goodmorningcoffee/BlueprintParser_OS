import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Get the encryption key (32 bytes for AES-256).
 * Uses LLM_KEY_SECRET if set, falls back to NEXTAUTH_SECRET.
 * Hashes to ensure exactly 32 bytes regardless of input length.
 */
function getKey(): Buffer {
  const secret = process.env.LLM_KEY_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("No encryption key: set LLM_KEY_SECRET or NEXTAUTH_SECRET");
  return crypto.createHash("sha256").update(secret).digest();
}

/**
 * Encrypt an API key for storage in the database.
 * Returns a base64 string containing iv + authTag + ciphertext.
 */
export function encryptApiKey(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Pack: iv (12) + authTag (16) + ciphertext
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

/**
 * Decrypt an API key from the database.
 * Accepts the base64 string produced by encryptApiKey().
 */
export function decryptApiKey(encrypted: string): string {
  const key = getKey();
  const buf = Buffer.from(encrypted, "base64");
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}

/**
 * Mask an API key for display (show last 4 chars only).
 */
export function maskApiKey(key: string): string {
  if (key.length <= 4) return "••••";
  return "••••" + key.slice(-4);
}
