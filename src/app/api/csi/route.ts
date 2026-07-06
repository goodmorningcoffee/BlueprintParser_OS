/**
 * GET /api/csi
 *
 * [refactor jul6 S032] Thin shell — behavior lives in services/csi.ts (csiAggregate).
 * auth:"session" (legacy requireAuth-first; 401 flat → envelope, diff A). Bare-array
 * response wrapped by the shell = byte-identical.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { csiAggregate } from "@/server/services/csi";

export const GET = defineRoute({
  auth: "session",
  handler: ({ session }) => csiAggregate(session!),
});
