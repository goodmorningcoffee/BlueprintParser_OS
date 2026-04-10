import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import bcrypt from "bcrypt";
import { db } from "@/lib/db";
import { users, companies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { audit } from "@/lib/audit";

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

// ─── Brute force protection ──────────────────────────────────
const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of loginAttempts) {
    if (val.lockedUntil < now && val.count === 0) loginAttempts.delete(key);
  }
}, 10 * 60 * 1000);

function checkBruteForce(email: string): string | null {
  const key = email.toLowerCase();
  const entry = loginAttempts.get(key);
  if (!entry) return null;

  if (entry.lockedUntil > Date.now()) {
    const mins = Math.ceil((entry.lockedUntil - Date.now()) / 60000);
    return `Account locked. Try again in ${mins} minute${mins > 1 ? "s" : ""}.`;
  }
  return null;
}

function recordFailedLogin(email: string) {
  const key = email.toLowerCase();
  const entry = loginAttempts.get(key) || { count: 0, lockedUntil: 0 };
  entry.count++;

  if (entry.count >= 10) {
    entry.lockedUntil = Date.now() + 60 * 60 * 1000; // 1 hour
  } else if (entry.count >= 5) {
    entry.lockedUntil = Date.now() + 15 * 60 * 1000; // 15 min
  }

  loginAttempts.set(key, entry);
}

function clearFailedLogins(email: string) {
  loginAttempts.delete(email.toLowerCase());
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  providers: [
    ...(process.env.GOOGLE_CLIENT_ID ? [Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    })] : []),
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const email = credentials.email as string;
        const password = credentials.password as string;

        // Check brute force lockout
        const lockMsg = checkBruteForce(email);
        if (lockMsg) { console.error(`[AUTH FAIL] lockout: ${email}`); return null; }

        // Select only core columns — avoids failure if new columns (e.g. can_run_models)
        // haven't been migrated yet
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
          recordFailedLogin(email);
          audit("login_failed", { details: { email, reason: "user_not_found" } });
          return null;
        }

        if (!user.passwordHash) {
          console.error(`[AUTH FAIL] null passwordHash: ${email} (id=${user.id})`);
          recordFailedLogin(email);
          audit("login_failed", { userId: user.id, companyId: user.companyId, details: { email, reason: "no_password" } });
          return null;
        }

        const passwordMatch = await bcrypt.compare(password, user.passwordHash);
        if (!passwordMatch) {
          console.error(`[AUTH FAIL] wrong password: ${email} (id=${user.id})`);
          recordFailedLogin(email);
          audit("login_failed", { userId: user.id, companyId: user.companyId, details: { email } });
          return null;
        }
        console.log(`[AUTH OK] ${email} (id=${user.id})`);

        // Fetch canRunModels + isRootAdmin separately — columns may not exist if migration pending
        let canRunModels = user.role === "admin"; // default: admins can run
        let isRootAdmin = false;
        try {
          const [perms] = await db
            .select({ canRunModels: users.canRunModels, isRootAdmin: users.isRootAdmin })
            .from(users)
            .where(eq(users.id, user.id))
            .limit(1);
          if (perms) {
            canRunModels = perms.canRunModels;
            isRootAdmin = perms.isRootAdmin;
          }
        } catch {
          // Migration hasn't run yet — use defaults
        }

        // Bootstrap: auto-promote to root admin if email matches env var
        if (process.env.ROOT_ADMIN_EMAIL && email.toLowerCase() === process.env.ROOT_ADMIN_EMAIL.toLowerCase() && !isRootAdmin) {
          try {
            await db.update(users).set({ isRootAdmin: true }).where(eq(users.id, user.id));
            isRootAdmin = true;
            audit("root_admin_bootstrap", { userId: user.id, companyId: user.companyId, details: { email } });
          } catch { /* migration not run yet */ }
        }

        clearFailedLogins(email);
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
        try {
          const [existing] = await db.select().from(users).where(eq(users.email, user.email)).limit(1);
          if (existing) {
            // Link OAuth to existing account if not already linked
            if (!existing.oauthProvider) {
              await db.update(users).set({
                oauthProvider: "google",
                oauthProviderId: account.providerAccountId,
              }).where(eq(users.id, existing.id));
            }
            return true;
          }
          // New user — auto-assign company by email domain
          const domain = user.email.split("@")[1];
          const [company] = await db.select().from(companies).where(eq(companies.emailDomain, domain)).limit(1);
          if (!company) {
            return "/login?error=no-company";
          }
          await db.insert(users).values({
            email: user.email,
            username: user.name || user.email.split("@")[0],
            passwordHash: null,
            role: "member",
            companyId: company.id,
            oauthProvider: "google",
            oauthProviderId: account.providerAccountId,
          });
          audit("user_registered", { details: { email: user.email, provider: "google", companyId: company.id } });
          return true;
        } catch (err) {
          return "/login?error=oauth-error";
        }
      }
      return true; // credentials handled by authorize()
    },
    async jwt({ token, user, account, trigger }) {
      // OAuth sign-in: look up full user data from DB
      if (trigger === "signIn" && account?.provider === "google" && token.email) {
        try {
          const [dbUser] = await db.select().from(users).where(eq(users.email, token.email as string)).limit(1);
          if (dbUser) {
            token.companyId = dbUser.companyId;
            token.dbId = dbUser.id;
            token.username = dbUser.username;
            token.role = dbUser.role;
            token.canRunModels = dbUser.canRunModels;
            token.isRootAdmin = dbUser.isRootAdmin;
          }
        } catch { /* migration pending */ }
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
      // Refresh canRunModels + isRootAdmin from DB on each request (admin may toggle them)
      if (trigger !== "signIn" && token.dbId) {
        try {
          const [fresh] = await db.select({ canRunModels: users.canRunModels, isRootAdmin: users.isRootAdmin }).from(users).where(eq(users.id, token.dbId)).limit(1);
          if (fresh) {
            token.canRunModels = fresh.canRunModels;
            token.isRootAdmin = fresh.isRootAdmin;
          }
        } catch {
          // Columns may not exist yet
        }
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
