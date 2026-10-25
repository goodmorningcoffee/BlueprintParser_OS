// @vitest-environment node
// [2026-10-25] Root TOTP 2FA claim model (pure) — MANDATORY 2FA — and its consumers that need no database:
//   • rootTwoFactorGate: a root with no active enrollment is "enroll", enrolled-but-unverified is
//     "verify", verified is null; non-root is never gated;
//   • projectRootAuthority: gated → isRootAdmin=false + the gate; verified root stays root;
//   • ROOT_2FA_ENFORCE=0 (the logged emergency off-switch) collapses every gate to null;
//   • verifiedRootUserId (middleware root confirmation): a gated root is nobody;
//   • defineRoute requireSession: a gated root's USER-LESS session → 401 at every level (root,
//     admin, session); a verified root passes root-only; a member is still "Admin only";
//   • requireVerifiedRoot / isVerifiedRoot (server/api/root-authority.ts): the single verified-root check.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { defineRoute } from "@/server/api/defineRoute";
import { isVerifiedRoot, requireVerifiedRoot } from "@/server/api/root-authority";
import { verifiedRootUserId } from "@/lib/middleware-rate-limit";
import {
  ROOT_TWO_FACTOR_ENFORCE_ENV,
  ROOT_TWO_FACTOR_KEY_PREFIX,
  isRootTwoFactorSettingKey,
  projectRootAuthority,
  rootTwoFactorEnforced,
  rootTwoFactorGate,
  rootTwoFactorPending,
  rootTwoFactorSettingKey,
} from "@/lib/root-two-factor-claims";
import { makeReq, readJson, sessionState } from "@/test/harness";
import type { AuthSession } from "@/lib/api-utils";

const ROOT_VERIFY = { dbId: 7, isRootAdmin: true, twoFactorRequired: true, twoFactorVerified: false, twoFactorNonce: "n" };
const ROOT_VERIFIED = { ...ROOT_VERIFY, twoFactorVerified: true };
const ROOT_ENROLL = { dbId: 7, isRootAdmin: true, twoFactorRequired: false, twoFactorVerified: false };
const MEMBER_WITH_STALE_ROW = { dbId: 8, isRootAdmin: false, twoFactorRequired: true, twoFactorVerified: false };

afterEach(() => {
  delete process.env[ROOT_TWO_FACTOR_ENFORCE_ENV];
  vi.restoreAllMocks();
});

describe("root two-factor claim model", () => {
  it("setting keys carry the prefix and only prefixed keys are recognised", () => {
    expect(ROOT_TWO_FACTOR_KEY_PREFIX).toBe("root-2fa:");
    expect(rootTwoFactorSettingKey(42)).toBe("root-2fa:42");
    expect(isRootTwoFactorSettingKey("root-2fa:42")).toBe(true);
    expect(isRootTwoFactorSettingKey("root-2fa")).toBe(false);
    expect(isRootTwoFactorSettingKey("header_links")).toBe(false);
  });

  it("gate: root without enrollment → enroll; enrolled unverified → verify; verified → null; non-root → null", () => {
    expect(rootTwoFactorGate(ROOT_ENROLL)).toBe("enroll");
    expect(rootTwoFactorGate({ dbId: 7, isRootAdmin: true })).toBe("enroll");
    expect(rootTwoFactorGate(ROOT_VERIFY)).toBe("verify");
    expect(rootTwoFactorGate(ROOT_VERIFIED)).toBeNull();
    expect(rootTwoFactorGate(MEMBER_WITH_STALE_ROW)).toBeNull();
    expect(rootTwoFactorGate({ ...ROOT_VERIFY, twoFactorVerified: "true" })).toBe("verify");
    expect(rootTwoFactorGate({ ...ROOT_VERIFY, twoFactorRequired: "true" })).toBe("enroll");
    expect(rootTwoFactorGate(null)).toBeNull();
    expect(rootTwoFactorGate(undefined)).toBeNull();
    expect(rootTwoFactorPending(ROOT_ENROLL)).toBe(true);
    expect(rootTwoFactorPending(ROOT_VERIFY)).toBe(true);
    expect(rootTwoFactorPending(ROOT_VERIFIED)).toBe(false);
    expect(rootTwoFactorPending(MEMBER_WITH_STALE_ROW)).toBe(false);
  });

  it("projects a gated root as non-root with the gate; a verified root stays root; non-root unchanged", () => {
    expect(projectRootAuthority(ROOT_ENROLL)).toEqual({ isRootAdmin: false, rootTwoFactorPending: true, rootTwoFactorGate: "enroll" });
    expect(projectRootAuthority(ROOT_VERIFY)).toEqual({ isRootAdmin: false, rootTwoFactorPending: true, rootTwoFactorGate: "verify" });
    expect(projectRootAuthority(ROOT_VERIFIED)).toEqual({ isRootAdmin: true, rootTwoFactorPending: false, rootTwoFactorGate: null });
    expect(projectRootAuthority(MEMBER_WITH_STALE_ROW)).toEqual({ isRootAdmin: false, rootTwoFactorPending: false, rootTwoFactorGate: null });
    expect(projectRootAuthority({ dbId: 1 })).toEqual({ isRootAdmin: false, rootTwoFactorPending: false, rootTwoFactorGate: null });
  });

  it("ROOT_2FA_ENFORCE: on by default and for any non-off value; 0/false/off/no switch it off", () => {
    expect(rootTwoFactorEnforced({})).toBe(true);
    expect(rootTwoFactorEnforced({ ROOT_2FA_ENFORCE: "1" })).toBe(true);
    expect(rootTwoFactorEnforced({ ROOT_2FA_ENFORCE: "yes" })).toBe(true);
    expect(rootTwoFactorEnforced({ ROOT_2FA_ENFORCE: "" })).toBe(true);
    for (const off of ["0", "false", "off", "no", " OFF ", "False"]) {
      expect(rootTwoFactorEnforced({ ROOT_2FA_ENFORCE: off })).toBe(false);
    }
  });

  it("the off-switch collapses every gate to null and logs a [SECURITY] line each time it does", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env[ROOT_TWO_FACTOR_ENFORCE_ENV] = "0";
    expect(rootTwoFactorGate(ROOT_ENROLL)).toBeNull();
    expect(rootTwoFactorGate(ROOT_VERIFY)).toBeNull();
    expect(projectRootAuthority(ROOT_ENROLL)).toEqual({ isRootAdmin: true, rootTwoFactorPending: false, rootTwoFactorGate: null });
    expect(err).toHaveBeenCalledTimes(3);
    for (const call of err.mock.calls) {
      expect(String(call[0])).toContain("[SECURITY] ROOT_2FA_ENFORCE=0");
      expect(String(call[0])).toContain("root user 7");
    }
    // Nothing is logged where the switch changes nothing (verified root, non-root).
    err.mockClear();
    expect(rootTwoFactorGate(ROOT_VERIFIED)).toBeNull();
    expect(rootTwoFactorGate(MEMBER_WITH_STALE_ROW)).toBeNull();
    expect(err).not.toHaveBeenCalled();
    // The switch is read on every evaluation — unsetting it re-arms the gate at once.
    delete process.env[ROOT_TWO_FACTOR_ENFORCE_ENV];
    expect(rootTwoFactorGate(ROOT_ENROLL)).toBe("enroll");
  });
});

describe("middleware root confirmation (verifiedRootUserId)", () => {
  it("a gated root (enroll or verify) is not root; only a verified root is", () => {
    expect(verifiedRootUserId(ROOT_VERIFY)).toBeNull();
    expect(verifiedRootUserId(ROOT_ENROLL)).toBeNull();
    expect(verifiedRootUserId({ dbId: 7, isRootAdmin: true })).toBeNull();
    expect(verifiedRootUserId(ROOT_VERIFIED)).toBe(7);
    expect(verifiedRootUserId(MEMBER_WITH_STALE_ROW)).toBeNull();
  });
});

describe("defineRoute + root-authority with gated / verified root sessions", () => {
  const rootRoute = defineRoute({ auth: "root", handler: () => ({ ok: true }) });
  const adminRoute = defineRoute({ auth: "admin", handler: () => ({ ok: true }) });
  const sessionRoute = defineRoute({ auth: "session", handler: () => ({ ok: true }) });
  const req = () => makeReq("/api/x", { method: "GET" });
  const UNAUTHORIZED = { error: { code: "UNAUTHORIZED", message: "Unauthorized" } };

  /** What lib/auth.ts projects for a gated root: NO user, just the gate. */
  function asGatedRoot(gate: "enroll" | "verify") {
    sessionState.current = { twoFactorGate: gate } as unknown as AuthSession;
  }

  it("a gated root (even role admin in the database) is UNAUTHORIZED at every level", async () => {
    for (const gate of ["enroll", "verify"] as const) {
      asGatedRoot(gate);
      for (const route of [rootRoute, adminRoute, sessionRoute]) {
        const r = await readJson(await route(req()));
        expect(r.status).toBe(401);
        expect(r.body).toEqual(UNAUTHORIZED);
      }
      expect(isVerifiedRoot(sessionState.current)).toBe(false);
      expect(() => requireVerifiedRoot(sessionState.current)).toThrow("Unauthorized");
    }
  });

  it("once verified the same user passes root-only, and the helper agrees", async () => {
    const authority = projectRootAuthority(ROOT_VERIFIED);
    sessionState.current = {
      user: { companyId: 1, dbId: 7, username: "owner", role: "member", canRunModels: true, isRootAdmin: authority.isRootAdmin },
      twoFactorGate: null,
    };
    expect((await readJson(await rootRoute(req()))).status).toBe(200);
    expect(isVerifiedRoot(sessionState.current)).toBe(true);
    expect(requireVerifiedRoot(sessionState.current)).toBe(sessionState.current);
  });

  it("a plain member / company admin is 'Root admin only' on root routes; a member is still 'Admin only'", async () => {
    sessionState.current = {
      user: { companyId: 1, dbId: 9, username: "m", role: "member", canRunModels: false, isRootAdmin: false },
    };
    expect((await readJson(await adminRoute(req()))).status).toBe(403);
    expect(() => requireVerifiedRoot(sessionState.current)).toThrow("Root admin only");
    sessionState.current = {
      user: { companyId: 1, dbId: 10, username: "a", role: "admin", canRunModels: true, isRootAdmin: false },
    };
    expect((await readJson(await adminRoute(req()))).status).toBe(200);
    const denied = await readJson(await rootRoute(req()));
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ error: { code: "FORBIDDEN", message: "Root admin only" } });
    expect(isVerifiedRoot(sessionState.current)).toBe(false);
    sessionState.current = null;
  });
});
