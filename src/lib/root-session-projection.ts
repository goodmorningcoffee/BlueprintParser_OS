/**
 * [2026-10-25 root hardening, fix round] The session projection lib/auth.ts callbacks.session runs —
 * pure, so it can be driven through the REAL Auth.js session path in a test
 * (lib/__tests__/root-session-projection.test.ts) instead of a hand-built model of it.
 *
 * Why `user: null` is spelled out: next-auth@5 wraps the app's session callback for every
 * server-side auth() call (node_modules/next-auth/lib/index.js getSession) as
 *     const user = args[0].user ?? args[0].token;   // jwt strategy → the DECODED TOKEN
 *     return { user, ...session };
 * so a gated projection that merely OMITS `user` is handed the raw token — with the database's
 * isRootAdmin:true — as `session.user` on the server, and every root gate passes while only the
 * client's /api/auth/session is user-less. An explicit `user: null` in the projection survives
 * the spread and the wrapper's fallback never fires. The defence in depth for a future wrapper
 * change is `sessionIsGated` (lib/root-two-factor-claims.ts): every shell / helper refuses a
 * session that carries a gate, whatever `user` says.
 */

import type { Session } from "next-auth";
import type { JWT } from "@auth/core/jwt";
import { projectRootAuthority } from "@/lib/root-two-factor-claims";

/** What the gated projection is: no user, the gate, and nothing else. */
export interface GatedSessionProjection {
  user: null;
  expires: string;
  twoFactorGate: "enroll" | "verify";
}

export function projectSessionFromToken(session: Session, token: JWT): Session {
  // A root login that still owes enrollment or its code has NO authority anywhere a session is
  // consulted: the session goes out with `user: null`, carrying only the gate, so the route
  // shell, the project-access engine and every service that calls auth() itself all fail closed
  // as signed-out. The /admin page renders the gate from it.
  const rootAuthority = projectRootAuthority(token);
  if (rootAuthority.rootTwoFactorGate !== null) {
    const gated: GatedSessionProjection = {
      user: null,
      expires: session.expires,
      twoFactorGate: rootAuthority.rootTwoFactorGate,
    };
    return gated as unknown as Session;
  }
  if (session.user) {
    session.user.companyId = token.companyId;
    session.user.dbId = token.dbId;
    session.user.username = token.username;
    session.user.role = token.role;
    session.user.canRunModels = token.canRunModels;
    session.user.isRootAdmin = rootAuthority.isRootAdmin;
  }
  session.twoFactorGate = null;
  return session;
}
