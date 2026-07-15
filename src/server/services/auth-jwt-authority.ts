import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

type AuthorityToken = {
  dbId?: number;
  companyId?: number;
  role?: string;
  canRunModels?: boolean;
  isRootAdmin?: boolean;
};

/**
 * Revalidate database-backed JWT authority on every non-sign-in request.
 *
 * A deleted user is not an authority snapshot: returning the old token would
 * preserve its admin/root claims until JWT expiry. Database errors propagate so
 * Auth.js fails the request closed instead of trusting stale privileges.
 */
export async function refreshJwtUserAuthority<T extends AuthorityToken>(
  token: T,
): Promise<T | null> {
  if (!Number.isSafeInteger(token.dbId) || Number(token.dbId) <= 0) return null;

  const [fresh] = await db
    .select({
      companyId: users.companyId,
      role: users.role,
      canRunModels: users.canRunModels,
      isRootAdmin: users.isRootAdmin,
    })
    .from(users)
    .where(eq(users.id, token.dbId!))
    .limit(1);
  if (!fresh) return null;

  token.companyId = fresh.companyId;
  token.role = fresh.role;
  token.canRunModels = fresh.canRunModels;
  token.isRootAdmin = fresh.isRootAdmin;
  return token;
}
