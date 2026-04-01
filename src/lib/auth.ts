import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcrypt";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
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
        if (lockMsg) return null;

        // Select only core columns — avoids failure if new columns (e.g. can_run_models)
        // haven't been migrated yet
        const [user] = await db
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

        if (!user) {
          recordFailedLogin(email);
          audit("login_failed", { details: { email, reason: "user_not_found" } });
          return null;
        }

        const passwordMatch = await bcrypt.compare(password, user.passwordHash);
        if (!passwordMatch) {
          recordFailedLogin(email);
          audit("login_failed", { userId: user.id, companyId: user.companyId, details: { email } });
          return null;
        }

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
    async jwt({ token, user, trigger }) {
      if (user) {
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
