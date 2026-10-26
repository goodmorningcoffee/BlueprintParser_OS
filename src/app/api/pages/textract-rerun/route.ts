// [refactor jun17 P1.3] Thin shell — behavior in services/pages.ts (rerunPageTextract).
// POST = force-refresh a page's cached Textract result (debug/diagnostic).
// [2026-10-25 root hardening] ROOT ONLY (verified 2FA): every call is a paid AnalyzeDocument on a
// full page, so the shell is auth:"root", the service re-checks through requireVerifiedRoot, writes a
// compute_usage 'textract' row and an audit row. dbId from the body `projectId` PLUS an optional
// `publicId`; demo projects refused.
import { defineRoute } from "@/server/api/defineRoute";
import { zLooseBody } from "@/server/api/schemas";
import { rerunPageTextract } from "@/server/services/pages";

export const POST = defineRoute({
  auth: "root",
  body: zLooseBody,
  handler: ({ body, session }) => rerunPageTextract(body, session!),
});
