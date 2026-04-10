import type { DefaultSession } from "next-auth";

/**
 * Extend NextAuth session/user/JWT types with BlueprintParser custom fields.
 *
 * This file is a standalone declaration so the augmentations are visible
 * globally — both in server-side `auth()` calls and client-side `useSession()`.
 * The identical declarations in auth.ts are kept for backwards compatibility
 * but this file is the canonical source.
 */
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
