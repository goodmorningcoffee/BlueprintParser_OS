/**
 * GET /api/s3/credentials
 *
 * [refactor jul6 S033] Thin shell — behavior lives in services/s3.ts (uploadCredentials).
 * auth:"session". The zero-consumer direct-to-final upload is retained only as a 410 response;
 * issuing a reusable original.pdf credential would bypass later demo publication fencing.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { uploadCredentials } from "@/server/services/s3";

export const GET = defineRoute({
  auth: "session",
  handler: ({ session }) => uploadCredentials(session!),
});
