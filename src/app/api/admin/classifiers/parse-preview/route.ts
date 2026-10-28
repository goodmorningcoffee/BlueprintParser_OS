/**
 * POST /api/admin/classifiers/parse-preview — ROOT ONLY. Parse each previewed proposal's box with the parse
 * engine at `instant` (compute only: no cache, no paid call, no write). Body `{ projectId, items[≤40]:
 * { page, bbox, kind, proposalId? } }`; any company's non-demo project (the preview spans companies, so this
 * is not the per-company project route). Thin shell — services/parse-engine/admin-preview.ts. [TP-3 WP-3.P]
 */
import { defineRoute } from "@/server/api/defineRoute";
import { adminParsePreview, zAdminParsePreviewBody } from "@/server/services/parse-engine/admin-preview";

export const POST = defineRoute({
  auth: "root",
  body: zAdminParsePreviewBody,
  handler: ({ body }) => adminParsePreview(body),
});
