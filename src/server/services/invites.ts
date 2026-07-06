// [refactor jul6 S042] admin/invites SOLO — GET list + PUT mark-all-seen, folded from the
// legacy route (git show 3cb8cb6:src/app/api/admin/invites/route.ts). Char:
// __tests__/admin-invites.route.test.ts (INV-*). requireAdmin (the shell provides
// auth:"admin"). Neither handler uses session beyond the auth gate, and neither reads a
// body. Sanctioned diff: A only (flat auth errors → envelope); no body → no E; no catch-500
// literal → no B (unexpected db errors propagate to the shell generic INTERNAL 500).

import { db } from "@/lib/db";
import { inviteRequests } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";

export async function getInvites(): Promise<unknown> {
  const requests = await db
    .select()
    .from(inviteRequests)
    .orderBy(desc(inviteRequests.createdAt));

  const unseenCount = requests.filter((r) => !r.seen).length;

  return { requests, unseenCount };
}

export async function markInvitesSeen(): Promise<unknown> {
  await db
    .update(inviteRequests)
    .set({ seen: true })
    .where(eq(inviteRequests.seen, false));

  return { success: true };
}
