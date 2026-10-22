/**
 * GET  /api/admin/annotation-cleanup — projects in scope (non-demo) + distinct annotation sources.
 * POST /api/admin/annotation-cleanup — dry-run counts, or (typed phrase) delete / dedupe annotations.
 *
 * Admin › Data tools › Annotation cleanup. ROOT only (a company admin gets 403). Root: every
 * company, or one via ?companyId. Thin shell — services/annotation-cleanup.ts.
 */

import { defineRoute } from "@/server/api/defineRoute";
import {
  getCleanupScope,
  runAnnotationCleanup,
  zCleanupBody,
  zCleanupQuery,
} from "@/server/services/annotation-cleanup";

export const GET = defineRoute({
  auth: "root",
  query: zCleanupQuery,
  handler: ({ query, session }) => getCleanupScope(session!, query),
});

export const POST = defineRoute({
  auth: "root",
  body: zCleanupBody,
  query: zCleanupQuery,
  handler: ({ body, query, session }) => runAnnotationCleanup(session!, body, query),
});
