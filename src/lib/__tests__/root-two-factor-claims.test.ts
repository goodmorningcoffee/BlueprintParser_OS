// @vitest-environment node
// [2026-10-23] Root TOTP 2FA claim model (pure) and its two consumers that need no database:
//   • projectRootAuthority: a root login with an active enrollment and no verification is NOT
//     root for the session but is flagged pending; verified / not-enrolled / non-root unchanged;
//   • verifiedRootUserId (middleware root confirmation): a pending root is nobody;
//   • defineRoute requireSession: pending root → auth:"root" 403, auth:"admin" 200 even as a
//     plain member (the ROOT_ADMIN_EMAIL bootstrap promotes a member row).
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
  const { sessionState } = await import("@/test/harness");
  return { auth: async () => sessionState.current };
});

import { defineRoute } from "@/server/api/defineRoute";
import { verifiedRootUserId } from "@/lib/middleware-rate-limit";
import {
  ROOT_TWO_FACTOR_KEY_PREFIX,
  isRootTwoFactorSettingKey,
  projectRootAuthority,
  rootTwoFactorPending,
  rootTwoFactorSettingKey,
} from "@/lib/root-two-factor-claims";
import { makeReq, readJson, sessionState } from "@/test/harness";

const ROOT_PENDING = { dbId: 7, isRootAdmin: true, twoFactorRequired: true, twoFactorVerified: false, twoFactorNonce: "n" };
const ROOT_VERIFIED = { ...ROOT_PENDING, twoFactorVerified: true };
const ROOT_NOT_ENROLLED = { dbId: 7, isRootAdmin: true, twoFactorRequired: false, twoFactorVerified: false };
const MEMBER_WITH_STALE_ROW = { dbId: 8, isRootAdmin: false, twoFactorRequired: true, twoFactorVerified: false };

describe("root two-factor claim model", () => {
  it("setting keys carry the prefix and only prefixed keys are recognised", () => {
    expect(ROOT_TWO_FACTOR_KEY_PREFIX).toBe("root-2fa:");
    expect(rootTwoFactorSettingKey(42)).toBe("root-2fa:42");
    expect(isRootTwoFactorSettingKey("root-2fa:42")).toBe(true);
    expect(isRootTwoFactorSettingKey("root-2fa")).toBe(false);
    expect(isRootTwoFactorSettingKey("header_links")).toBe(false);
  });

  it("pending = root AND required AND not verified; everything else is not pending", () => {
    expect(rootTwoFactorPending(ROOT_PENDING)).toBe(true);
    expect(rootTwoFactorPending(ROOT_VERIFIED)).toBe(false);
    expect(rootTwoFactorPending(ROOT_NOT_ENROLLED)).toBe(false);
    expect(rootTwoFactorPending(MEMBER_WITH_STALE_ROW)).toBe(false);
    expect(rootTwoFactorPending({ ...ROOT_PENDING, twoFactorRequired: "true" })).toBe(false);
    expect(rootTwoFactorPending(null)).toBe(false);
    expect(rootTwoFactorPending(undefined)).toBe(false);
  });

  it("projects a pending root as non-root + pending; verified and non-enrolled roots stay root", () => {
    expect(projectRootAuthority(ROOT_PENDING)).toEqual({ isRootAdmin: false, rootTwoFactorPending: true });
    expect(projectRootAuthority(ROOT_VERIFIED)).toEqual({ isRootAdmin: true, rootTwoFactorPending: false });
    expect(projectRootAuthority(ROOT_NOT_ENROLLED)).toEqual({ isRootAdmin: true, rootTwoFactorPending: false });
    expect(projectRootAuthority(MEMBER_WITH_STALE_ROW)).toEqual({ isRootAdmin: false, rootTwoFactorPending: false });
    expect(projectRootAuthority({ dbId: 1 })).toEqual({ isRootAdmin: false, rootTwoFactorPending: false });
  });
});

describe("middleware root confirmation (verifiedRootUserId)", () => {
  it("a pending root is not root; verified / not-enrolled roots are", () => {
    expect(verifiedRootUserId(ROOT_PENDING)).toBeNull();
    expect(verifiedRootUserId(ROOT_VERIFIED)).toBe(7);
    expect(verifiedRootUserId(ROOT_NOT_ENROLLED)).toBe(7);
    expect(verifiedRootUserId({ dbId: 7, isRootAdmin: true })).toBe(7);
    expect(verifiedRootUserId(MEMBER_WITH_STALE_ROW)).toBeNull();
  });
});

describe("defineRoute with a pending root session", () => {
  const rootRoute = defineRoute({ auth: "root", handler: () => ({ ok: true }) });
  const adminRoute = defineRoute({ auth: "admin", handler: () => ({ ok: true }) });
  const sessionRoute = defineRoute({ auth: "session", handler: () => ({ ok: true }) });
  const req = () => makeReq("/api/x", { method: "GET" });

  function asPendingRoot(role = "member") {
    const authority = projectRootAuthority(ROOT_PENDING);
    sessionState.current = {
      user: { companyId: 1, dbId: 7, username: "owner", role, canRunModels: true, ...authority },
    };
  }

  it("root-only → 403 'Root admin only'; admin-level and session-level still pass (member role)", async () => {
    asPendingRoot("member");
    const denied = await readJson(await rootRoute(req()));
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ error: { code: "FORBIDDEN", message: "Root admin only" } });
    expect((await readJson(await adminRoute(req()))).status).toBe(200);
    expect((await readJson(await sessionRoute(req()))).status).toBe(200);
  });

  it("once verified the same user passes root-only", async () => {
    const authority = projectRootAuthority(ROOT_VERIFIED);
    sessionState.current = {
      user: { companyId: 1, dbId: 7, username: "owner", role: "member", canRunModels: true, ...authority },
    };
    expect((await readJson(await rootRoute(req()))).status).toBe(200);
  });

  it("a plain member is still 'Admin only' — pending is not a free admin pass", async () => {
    sessionState.current = {
      user: { companyId: 1, dbId: 9, username: "m", role: "member", canRunModels: false, isRootAdmin: false, rootTwoFactorPending: false },
    };
    expect((await readJson(await adminRoute(req()))).status).toBe(403);
    sessionState.current = null;
  });
});
