/**
 * GET /api/s3/credentials
 *
 * [refactor jul6 S033] Thin shell — behavior lives in services/s3.ts (uploadCredentials).
 * auth:"session". ⚠️ ZERO runtime consumers (docs-only; P5 dead-route candidate) and the
 * middleware rate rule on this path keys POST — dead rule, P1 ledger. Folded byte-faithful.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { uploadCredentials } from "@/server/services/s3";

export const GET = defineRoute({
  auth: "session",
  handler: ({ session }) => uploadCredentials(session!),
});
