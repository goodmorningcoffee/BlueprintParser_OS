// [refactor jul7 S050] admin/remerge SOLO — re-run mergeGrids against a stored
// MethodResult[], folded from the legacy route (git show 9599fff:src/app/api/admin/remerge/
// route.ts). Char: __tests__/admin-remerge.route.test.ts (RM-*). requireAdmin (the shell
// provides auth:"admin"). Sanctioned diffs:
//   • A — flat auth errors → envelope; "results must be an array of MethodResult" stays
//     byte-verbatim as ApiError("VALIDATION", ...).
//   • E — legacy `req.json().catch(()=>null)` + the non-object "body must be JSON" guard are
//     subsumed by the shell raw-parse (malformed → "Invalid JSON body") + zLooseBody
//     (non-object → generic VALIDATION 400).
//   • NO B — no catch-500 literal; unexpected errors → shell generic INTERNAL 500.
// PRESERVED: the mergeGrids(results, options) call + the BARE (un-enveloped) merged result.

import { mergeGrids, type MethodResult, type MergeOptions } from "@/lib/grid-merger";
import { ApiError } from "@/server/api/envelope";

export async function remergeGrids(rawBody: Record<string, unknown>): Promise<unknown> {
  const { results, options } = rawBody as {
    results?: MethodResult[];
    options?: MergeOptions;
  };

  if (!Array.isArray(results)) {
    throw new ApiError("VALIDATION", "results must be an array of MethodResult");
  }

  return mergeGrids(results, options);
}
