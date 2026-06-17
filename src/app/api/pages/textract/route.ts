// [refactor jun17 P1.3] Thin shell — behavior in services/pages.ts (getPageTextract).
// GET = lazy-load one page's textractData (PERF-SACRED). auth:"none" + the service reads the query
// imperatively (no zod query schema — legacy treats a non-numeric projectId as NaN→falsy→its own
// 400, and validates before resolving access). The service returns a raw NextResponse so its
// Cache-Control header survives the shell's `result instanceof Response` passthrough.
import { defineRoute } from "@/server/api/defineRoute";
import { getPageTextract } from "@/server/services/pages";

export const GET = defineRoute({
  auth: "none",
  handler: ({ req }) => getPageTextract(req),
});
