import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import bcrypt from "bcrypt";
import { db } from "@/lib/db";
import { users, companies } from "@/lib/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { audit } from "@/lib/audit";
import { refreshJwtUserAuthority } from "@/server/services/auth-jwt-authority";
// [refactor jul23 P5.4-A] Brute-force lockout helpers extracted to a pure module
// so the exponential schedule can be frozen by a unit test (auth.ts itself is
// unimportable in tests — NextAuth/db/Google load-time deps). Behavior identical.
import {
  checkBruteForce,
  recordFailedLogin,
  clearFailedLogins,
} from "@/lib/login-lockout";

const ROOT_ADMIN_MUTATION_ADVISORY_LOCK = 737375864;

declare module "next-auth" {
  interface User {
    companyId: number;
    username: string;
    role: string;
    canRunModels: boolean;
    isRootAdmin: boolean;
  }
  interface Session {
    user: DefaultSession["user"] & {
      companyId: number;
      dbId: number;
      username: string;
      role: string;
      canRunModels: boolean;
      isRootAdmin: boolean;
    };
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    companyId: number;
    dbId: number;
    username: string;
    role: string;
    canRunModels: boolean;
    isRootAdmin: boolean;
  }
}

// [refactor jul23 P5.4-A] Brute-force lockout state + helpers moved to
// @/lib/login-lockout (imported above). [P5.4-C] The three helpers are now async
// (login_lockouts PG table); the call sites below are awaited — no other change.

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  providers: [
    ...(process.env.GOOGLE_CLIENT_ID
      ? [
          Google({
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          }),
        ]
      : []),
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const email = (credentials.email as string).toLowerCase().trim();
        const password = credentials.password as string;

        // Check brute force lockout
        // [refactor jul23 P5.4-C] login-lockout helpers are now async (login_lockouts PG table).
        const lockMsg = await checkBruteForce(email);
        if (lockMsg) {
          console.error(`[AUTH FAIL] lockout: ${email}`);
          return null;
        }

        // P2 makes the full authority schema mandatory. Selecting every authorization claim in
        // the credential lookup makes a missing column or database failure reject sign-in instead
        // of manufacturing a privileged fallback token.
        let user;
        try {
          const [found] = await db
            .select({
              id: users.id,
              email: users.email,
              username: users.username,
              passwordHash: users.passwordHash,
              companyId: users.companyId,
              role: users.role,
              canRunModels: users.canRunModels,
              isRootAdmin: users.isRootAdmin,
            })
            .from(users)
            .where(eq(users.email, email))
            .limit(1);
          user = found;
        } catch (dbErr) {
          console.error(`[AUTH FAIL] DB query error for ${email}:`, dbErr);
          return null;
        }

        if (!user) {
          console.error(`[AUTH FAIL] user not found: ${email}`);
          await recordFailedLogin(email);
          audit("login_failed", {
            details: { email, reason: "user_not_found" },
          });
          return null;
        }

        if (!user.passwordHash) {
          console.error(
            `[AUTH FAIL] null passwordHash: ${email} (id=${user.id})`,
          );
          await recordFailedLogin(email);
          audit("login_failed", {
            userId: user.id,
            companyId: user.companyId,
            details: { email, reason: "no_password" },
          });
          return null;
        }

        const passwordMatch = await bcrypt.compare(password, user.passwordHash);
        if (!passwordMatch) {
          console.error(`[AUTH FAIL] wrong password: ${email} (id=${user.id})`);
          await recordFailedLogin(email);
          audit("login_failed", {
            userId: user.id,
            companyId: user.companyId,
            details: { email },
          });
          return null;
        }
        console.log(`[AUTH OK] ${email} (id=${user.id})`);

        const canRunModels = user.canRunModels;
        let isRootAdmin = user.isRootAdmin;

        // Bootstrap: auto-promote to root admin if email matches env var. This
        // participates in the same lock as break-glass changes and user deletion. Application
        // callers fail fast on contention so lock waiters cannot exhaust the bounded DB pool.
        if (
          process.env.ROOT_ADMIN_EMAIL &&
          email.toLowerCase() === process.env.ROOT_ADMIN_EMAIL.toLowerCase() &&
          !isRootAdmin
        ) {
          try {
            const promotion = await db.transaction(async (tx) => {
              const lockResult = await tx.execute(
                sql`SELECT pg_catalog.pg_try_advisory_xact_lock(${ROOT_ADMIN_MUTATION_ADVISORY_LOCK}) AS acquired`,
              );
              const acquired =
                (lockResult.rows[0] as { acquired?: boolean } | undefined)
                  ?.acquired === true;
              if (!acquired) return "busy" as const;

              const [promoted] = await tx
                .update(users)
                .set({ isRootAdmin: true })
                .where(and(eq(users.id, user.id), eq(users.isRootAdmin, false)))
                .returning({ id: users.id });
              if (promoted) return "promoted" as const;

              // A concurrent supported bootstrap may have committed after the credential read
              // but before this transaction acquired the lock. Admit only the exact live row.
              const [current] = await tx
                .select({ isRootAdmin: users.isRootAdmin })
                .from(users)
                .where(eq(users.id, user.id))
                .limit(1);
              return current?.isRootAdmin
                ? ("already-root" as const)
                : ("missing" as const);
            });
            if (promotion === "busy" || promotion === "missing") return null;
            isRootAdmin = true;
            audit("root_admin_bootstrap", {
              userId: user.id,
              companyId: user.companyId,
              details: { email },
            });
          } catch {
            return null;
          }
        }

        await clearFailedLogins(email);
        audit("login_success", { userId: user.id, companyId: user.companyId });

        return {
          id: String(user.id),
          email: user.email,
          name: user.username,
          companyId: user.companyId,
          username: user.username,
          role: user.role,
          canRunModels,
          isRootAdmin,
        };
      },
    }),
  ],
  session: {
    strategy: "jwt",
    maxAge: 24 * 60 * 60, // 1 day instead of 30
  },
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async signIn({ user, account }) {
      // OAuth: create or link user on sign-in
      if (account?.provider === "google" && user.email) {
        const oauthEmail = user.email.toLowerCase().trim();
        try {
          const [existing] = await db
            .select()
            .from(users)
            .where(eq(users.email, oauthEmail))
            .limit(1);
          if (existing) {
            // Link OAuth to existing account if not already linked
            if (!existing.oauthProvider) {
              await db
                .update(users)
                .set({
                  oauthProvider: "google",
                  oauthProviderId: account.providerAccountId,
                })
                .where(eq(users.id, existing.id));
            }
            return true;
          }
          // New user — auto-assign company by email domain
          const domain = oauthEmail.split("@")[1];
          const [company] = await db
            .select()
            .from(companies)
            .where(eq(companies.emailDomain, domain))
            .limit(1);
          if (!company) {
            return "/login?error=no-company";
          }
          await db.insert(users).values({
            email: oauthEmail,
            username: user.name || oauthEmail.split("@")[0],
            passwordHash: null,
            role: "member",
            companyId: company.id,
            oauthProvider: "google",
            oauthProviderId: account.providerAccountId,
          });
          audit("user_registered", {
            details: {
              email: oauthEmail,
              provider: "google",
              companyId: company.id,
            },
          });
          return true;
        } catch {
          return "/login?error=oauth-error";
        }
      }
      return true; // credentials handled by authorize()
    },
    async jwt({ token, user, account, trigger }) {
      // OAuth sign-in: look up full user data from DB
      if (
        trigger === "signIn" &&
        account?.provider === "google" &&
        token.email
      ) {
        try {
          const lookupEmail = (token.email as string).toLowerCase().trim();
          const [dbUser] = await db
            .select()
            .from(users)
            .where(eq(users.email, lookupEmail))
            .limit(1);
          if (dbUser) {
            token.companyId = dbUser.companyId;
            token.dbId = dbUser.id;
            token.username = dbUser.username;
            token.role = dbUser.role;
            token.canRunModels = dbUser.canRunModels;
            token.isRootAdmin = dbUser.isRootAdmin;
          }
        } catch {
          /* migration pending */
        }
      }
      // Credentials sign-in: user object has all fields from authorize()
      if (trigger === "signIn" && user && account?.provider === "credentials") {
        token.companyId = user.companyId;
        token.dbId = Number(user.id);
        token.username = user.username;
        token.role = user.role;
        token.canRunModels = user.canRunModels;
        token.isRootAdmin = user.isRootAdmin;
      }
      // Every non-sign-in token must still name a live database user. Refresh
      // tenant, role, model, and root authority together; the helper rejects
      // missing/invalid ids instead of preserving stale claims.
      if (trigger !== "signIn") {
        return refreshJwtUserAuthority(token);
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.companyId = token.companyId;
        session.user.dbId = token.dbId;
        session.user.username = token.username;
        session.user.role = token.role;
        session.user.canRunModels = token.canRunModels;
        session.user.isRootAdmin = token.isRootAdmin;
      }
      return session;
    },
  },
});
