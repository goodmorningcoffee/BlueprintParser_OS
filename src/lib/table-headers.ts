/**
 * Column-header dedupe (K06). Moved to `parse-engine/headers.ts` (table pipeline WP-3.B) so the
 * client-safe engine modules (E-8: `headers`, `legacy-view`) can dedupe labels without leaving the
 * subset; this module re-exports it unchanged for its existing callers.
 */
export { renamedHeader, uniqueHeaders } from "@/lib/parse-engine/headers";
