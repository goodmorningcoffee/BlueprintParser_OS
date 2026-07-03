// [refactor jul3 P1.5] Thin shell — behavior lives in services/pages.ts (getPageThumbnail).
// auth:"none" is MANDATORY: the legacy page-number 400 fires BEFORE access (validate-before-auth);
// the service resolves access itself (resolveProjectOrThrow allowDemo:true — demo thumbnails are
// PUBLIC). Returns a raw NextResponse (PNG + the aggressive Cache-Control) through the shell's
// Response passthrough — do NOT convert to a plain return (it would json-envelope the image).
import { defineRoute } from "@/server/api/defineRoute";
import { getPageThumbnail } from "@/server/services/pages";

export const GET = defineRoute({
  auth: "none",
  handler: ({ params }) => getPageThumbnail(params.id, params.page),
});
