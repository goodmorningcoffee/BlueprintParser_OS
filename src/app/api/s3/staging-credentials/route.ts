/**
 * POST /api/s3/staging-credentials
 *
 * [refactor jul6 S033] Thin shell — behavior lives in services/s3.ts (stagingCredentials).
 * auth:"session" (legacy requireAuth-first). body:zLooseBody — the shell's malformed-body
 * 400 carries the SAME "Invalid JSON body" text legacy emitted (shape-only flip). The
 * multi-file presign flow: see the service header + UploadWidget.tsx.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { stagingCredentials } from "@/server/services/s3";

export const POST = defineRoute({
  auth: "session",
  body: zLooseBody,
  handler: ({ body, session }) => stagingCredentials(body, session!),
});
