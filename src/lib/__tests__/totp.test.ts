// @vitest-environment node
// [2026-10-23] RFC 4226 / RFC 6238 conformance for lib/totp.ts (pure, no DB): the appendix test
// vectors, base32 round trip, ±1-step acceptance, replay refusal, format refusal, and the
// backup-code helpers.
import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  constantTimeEqual,
  generateBackupCodes,
  generateTotpSecret,
  hotp,
  looksLikeBackupCode,
  normalizeBackupCode,
  otpauthUri,
  totpCode,
  totpStep,
  verifyTotp,
} from "@/lib/totp";

// RFC 4226 appendix D / RFC 6238 appendix B shared secret ("12345678901234567890").
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");

describe("HOTP — RFC 4226 appendix D vectors (SHA-1, 6 digits)", () => {
  const expected = [
    "755224", "287082", "359152", "969429", "338314",
    "254676", "287922", "162583", "399871", "520489",
  ];
  it.each(expected.map((code, counter) => [counter, code]))("counter %i → %s", (counter, code) => {
    expect(hotp(RFC_SECRET, counter)).toBe(code);
  });
});

describe("TOTP — RFC 6238 appendix B vectors (SHA-1, 8 digits, 30 s)", () => {
  const vectors: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  it.each(vectors)("T=%i → %s", (seconds, code) => {
    expect(totpCode(RFC_SECRET, totpStep(seconds * 1000), 8)).toBe(code);
  });

  it("6-digit codes are the last six digits of the 8-digit RFC codes", () => {
    expect(totpCode(RFC_SECRET, totpStep(59 * 1000))).toBe("287082");
    expect(totpCode(RFC_SECRET, totpStep(1111111109 * 1000))).toBe("081804");
  });
});

describe("base32 (RFC 4648)", () => {
  it("encodes the RFC secret to the well-known key and decodes it back", () => {
    const encoded = base32Encode(RFC_SECRET);
    expect(encoded).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(encoded).equals(RFC_SECRET)).toBe(true);
  });

  it("round-trips random 20-byte secrets and tolerates case, spaces, dashes and padding", () => {
    for (let i = 0; i < 20; i += 1) {
      const secret = generateTotpSecret();
      expect(secret.length).toBe(20);
      const text = base32Encode(secret);
      expect(text).toMatch(/^[A-Z2-7]{32}$/);
      expect(base32Decode(text).equals(secret)).toBe(true);
      expect(base32Decode(`${text.toLowerCase().slice(0, 8)} ${text.slice(8, 16)}-${text.slice(16)}====`).equals(secret)).toBe(true);
    }
  });

  it("rejects characters outside the alphabet and empty input", () => {
    expect(() => base32Decode("GEZD1NBV")).toThrow();
    expect(() => base32Decode("")).toThrow();
  });
});

describe("verifyTotp — window, replay, format", () => {
  const nowMs = 1_700_000_000_000;
  const step = totpStep(nowMs);

  it("accepts the current step and exactly ±1 step of drift", () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), { nowMs })).toEqual({ ok: true, step });
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), { nowMs })).toEqual({ ok: true, step: step - 1 });
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), { nowMs })).toEqual({ ok: true, step: step + 1 });
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), { nowMs })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 2), { nowMs })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("refuses a code at or before the last accepted step (replay), still accepts a newer one", () => {
    const current = totpCode(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, current, { nowMs, lastStep: step })).toEqual({ ok: false, reason: "replay" });
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), { nowMs, lastStep: step })).toEqual({ ok: false, reason: "replay" });
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), { nowMs, lastStep: step })).toEqual({ ok: true, step: step + 1 });
    expect(verifyTotp(RFC_SECRET, current, { nowMs, lastStep: step - 1 })).toEqual({ ok: true, step });
    expect(verifyTotp(RFC_SECRET, current, { nowMs, lastStep: null })).toEqual({ ok: true, step });
  });

  it("refuses anything that is not exactly six digits (after stripping whitespace)", () => {
    const current = totpCode(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, `${current.slice(0, 3)} ${current.slice(3)}`, { nowMs })).toEqual({ ok: true, step });
    for (const bad of ["", "12345", "1234567", "abcdef", "12345a", "ABCDE-FGHIJ"]) {
      expect(verifyTotp(RFC_SECRET, bad, { nowMs })).toEqual({ ok: false, reason: "format" });
    }
  });

  it("a different secret never matches", () => {
    const other = generateTotpSecret();
    expect(verifyTotp(other, totpCode(RFC_SECRET, step), { nowMs }).ok).toBe(false);
  });
});

describe("otpauth URI, constant-time compare, backup codes", () => {
  it("builds the otpauth://totp URI with issuer, account and the fixed SHA1/6/30 profile", () => {
    const uri = otpauthUri("owner@example.test", "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(uri.startsWith("otpauth://totp/BlueprintParser:owner%40example.test?")).toBe(true);
    const params = new URL(uri).searchParams;
    expect(params.get("secret")).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(params.get("issuer")).toBe("BlueprintParser");
    expect(params.get("algorithm")).toBe("SHA1");
    expect(params.get("digits")).toBe("6");
    expect(params.get("period")).toBe("30");
  });

  it("constantTimeEqual compares equal strings true and unequal (incl. length) false", () => {
    expect(constantTimeEqual("123456", "123456")).toBe(true);
    expect(constantTimeEqual("123456", "123457")).toBe(false);
    expect(constantTimeEqual("123456", "12345")).toBe(false);
  });

  it("generates ten distinct XXXXX-XXXXX codes without 0/O/1/I and normalizes them for hashing", () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
      expect(normalizeBackupCode(` ${code.toLowerCase()} `)).toBe(code.replace("-", ""));
      expect(looksLikeBackupCode(code)).toBe(true);
    }
    expect(looksLikeBackupCode("123456")).toBe(false);
  });
});
