// @vitest-environment node
/**
 * [2026-10-25 root hardening, fix round — verifier H1 / L5]
 *
 * Drives lib/root-session-projection.ts through the REAL Auth.js session path: @auth/core `Auth`
 * with the jwt strategy, a cookie encoded with @auth/core/jwt, and the next-auth server wrapper
 * (node_modules/next-auth/lib/index.js getSession) copied verbatim — the piece every route-level
 * test mocks away. That wrapper does `const user = args[0].user ?? args[0].token; return { user,
 * ...session }`, which handed a gated root the raw token as `session.user` (isRootAdmin:true) when
 * the projection merely omitted `user`. The test pins the wrapper's source so a next-auth upgrade
 * that changes the fallback is noticed here, not in production.
 */

import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Auth, type AuthConfig } from "@auth/core";
import Credentials from "@auth/core/providers/credentials";
import { encode } from "@auth/core/jwt";
import { projectSessionFromToken } from "@/lib/root-session-projection";
import { ROOT_TWO_FACTOR_ENFORCE_ENV, sessionIsGated } from "@/lib/root-two-factor-claims";
import { isVerifiedRoot, requireVerifiedRoot } from "@/server/api/root-authority";
import type { AuthSession } from "@/lib/api-utils";
import type { Session } from "next-auth";
import type { JWT } from "@auth/core/jwt";

const SECRET = "root-session-projection-test-secret-0123456789";
const SALT = "authjs.session-token";
const SESSION_URL = "http://localhost:3000/api/auth/session";

const config: AuthConfig = {
  secret: SECRET,
  trustHost: true,
  basePath: "/api/auth",
  providers: [Credentials({ credentials: {}, authorize: async () => null })],
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token }) {
      return token;
    },
    async session({ session, token }) {
      return projectSessionFromToken(session as Session, token as JWT);
    },
  },
};

/** VERBATIM shape of next-auth@5 lib/index.js getSession's callback override (pinned below). */
async function serverSideAuth(cookie: string): Promise<Record<string, unknown>> {
  const request = new Request(SESSION_URL, { headers: { cookie } });
  const response = await Auth(request, {
    ...config,
    callbacks: {
      ...config.callbacks,
      async session(...args: Parameters<NonNullable<NonNullable<AuthConfig["callbacks"]>["session"]>>) {
        const session = (await config.callbacks?.session?.(...args)) ?? { ...args[0].session };
        const user = args[0].user ?? (args[0] as { token?: unknown }).token;
        return { user, ...session } as unknown as Session;
      },
    },
  });
  return (await response.json()) as Record<string, unknown>;
}

/** The client's GET /api/auth/session: no wrapper. */
async function clientSession(cookie: string): Promise<Record<string, unknown>> {
  const response = await Auth(new Request(SESSION_URL, { headers: { cookie } }), config);
  return (await response.json()) as Record<string, unknown>;
}

async function cookieFor(claims: Record<string, unknown>): Promise<string> {
  const jwt = await encode({ secret: SECRET, salt: SALT, token: { sub: "7", ...claims } });
  return `${SALT}=${jwt}`;
}

const BASE = { dbId: 7, companyId: 1, username: "owner", role: "member", canRunModels: true, twoFactorNonce: "n-1" };
const ROOT_ENROLL = { ...BASE, isRootAdmin: true, twoFactorRequired: false, twoFactorVerified: false };
const ROOT_VERIFY = { ...BASE, isRootAdmin: true, twoFactorRequired: true, twoFactorVerified: false };
const ROOT_VERIFIED = { ...BASE, isRootAdmin: true, twoFactorRequired: true, twoFactorVerified: true };
const MEMBER = { ...BASE, isRootAdmin: false, twoFactorRequired: false, twoFactorVerified: false };

let savedEnforce: string | undefined;
beforeEach(() => {
  savedEnforce = process.env[ROOT_TWO_FACTOR_ENFORCE_ENV];
  delete process.env[ROOT_TWO_FACTOR_ENFORCE_ENV];
});
afterEach(() => {
  if (savedEnforce === undefined) delete process.env[ROOT_TWO_FACTOR_ENFORCE_ENV];
  else process.env[ROOT_TWO_FACTOR_ENFORCE_ENV] = savedEnforce;
});

describe("root session projection through the real Auth.js session path", () => {
  it("pins the next-auth server wrapper this test replicates (token fallback + spread)", () => {
    const source = readFileSync(path.join(process.cwd(), "node_modules/next-auth/lib/index.js"), "utf8");
    expect(source).toContain("const user = args[0].user ?? args[0].token;");
    expect(source).toContain("return { user, ...session };");
  });

  it.each([
    ["enroll", ROOT_ENROLL],
    ["verify", ROOT_VERIFY],
  ])("server-side auth(): a %s-gated root has NO user — the wrapper's token fallback never fires", async (gate, claims) => {
    const session = await serverSideAuth(await cookieFor(claims));
    expect(session.twoFactorGate).toBe(gate);
    expect(session.user).toBeNull();
    expect(JSON.stringify(session)).not.toContain("isRootAdmin");
    expect(sessionIsGated(session)).toBe(true);
    expect(isVerifiedRoot(session as unknown as AuthSession)).toBe(false);
    expect(() => requireVerifiedRoot(session as unknown as AuthSession)).toThrow(/Unauthorized/u);
  });

  it("client /api/auth/session: the same gated shape, no user", async () => {
    const session = await clientSession(await cookieFor(ROOT_ENROLL));
    expect(session.twoFactorGate).toBe("enroll");
    expect(session.user ?? null).toBeNull();
  });

  it("server-side auth(): a verified root carries the effective root flag and no gate", async () => {
    const session = await serverSideAuth(await cookieFor(ROOT_VERIFIED));
    expect(session.twoFactorGate).toBeNull();
    expect((session.user as { isRootAdmin?: unknown; dbId?: unknown }).isRootAdmin).toBe(true);
    expect((session.user as { dbId?: unknown }).dbId).toBe(7);
    expect(isVerifiedRoot(session as unknown as AuthSession)).toBe(true);
  });

  it("server-side auth(): a member is projected with isRootAdmin=false and no gate", async () => {
    const session = await serverSideAuth(await cookieFor(MEMBER));
    expect(session.twoFactorGate).toBeNull();
    expect((session.user as { isRootAdmin?: unknown }).isRootAdmin).toBe(false);
  });

  it("defence in depth: a gated session that somehow carries a root user is still refused", () => {
    const forged = {
      expires: "2099-01-01T00:00:00.000Z",
      twoFactorGate: "verify",
      user: { dbId: 7, companyId: 1, username: "owner", role: "member", canRunModels: true, isRootAdmin: true },
    } as unknown as AuthSession;
    expect(sessionIsGated(forged)).toBe(true);
    expect(isVerifiedRoot(forged)).toBe(false);
    expect(() => requireVerifiedRoot(forged)).toThrow(/Unauthorized/u);
    // The verified / non-root shape (`twoFactorGate: null`) is not gated.
    expect(sessionIsGated({ twoFactorGate: null })).toBe(false);
    expect(sessionIsGated(null)).toBe(false);
  });
});
