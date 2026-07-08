/**
 * POST/DELETE /api/admin/csi/upload  (custom CSI code database: multipart upload / revert)
 *
 * [refactor jul8 S059] Thin shells — behavior lives in services/csi-upload.ts
 * (uploadCsiDatabase / revertCsiDatabase). auth:"admin" (A). POST is the app's ONLY multipart
 * route and the FIRST user of the shell's `rawBody:true` skip-parse mode (07f0be3, DR006
 * rec #1): the shell leaves the stream intact so the service reads req.formData(); no
 * zLooseBody, no JSON-E. DELETE has no body schema — legacy DELETE() was 0-arg; under the
 * shell a malformed JSON body now 400s ("Invalid JSON body", yolo-purge precedent). NO B —
 * legacy had zero catch-500s; the "Parse error: <msg>"@400 interpolation is deliberate domain
 * feedback and stays (in-service ApiError, NOT retired). Solo fold (char:
 * admin-csi-upload.route.test.ts CU-*).
 */

import { defineRoute } from "@/server/api/defineRoute";
import { uploadCsiDatabase, revertCsiDatabase } from "@/server/services/csi-upload";

export const POST = defineRoute({
  auth: "admin",
  rawBody: true,
  handler: ({ req, session }) => uploadCsiDatabase(req, session!),
});

export const DELETE = defineRoute({
  auth: "admin",
  handler: ({ session }) => revertCsiDatabase(session!),
});
