/**
 * POST /api/admin/duplicates/delete-hidden  (permanently delete HIDDEN duplicate pages)
 *
 * Thin shell — behavior lives in services/page-permanent-delete.ts (deleteHiddenPages).
 * ROOT only (a company admin gets 403); root: every company, or one via ?companyId.
 * {all:true | projectPublicIds, dryRun, confirm?} — the dry run reports what would go (pages,
 * skipped + why, annotation/chat counts, S3 keys) and changes nothing; the real run needs
 * confirm "DELETE". Not reversible; original.pdf keeps the pages; page numbers are kept.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { deleteHiddenPages, zDeleteHiddenBody, zDeleteHiddenQuery } from "@/server/services/page-permanent-delete";

export const POST = defineRoute({
  auth: "root",
  body: zDeleteHiddenBody,
  query: zDeleteHiddenQuery,
  handler: ({ body, query, session }) => deleteHiddenPages(session!, body, query),
});
