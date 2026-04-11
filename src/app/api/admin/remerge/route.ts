/**
 * /api/admin/remerge
 *
 * Admin-only: accept a stored MethodResult[] (from the parse-history ring
 * buffer or a recent response) and re-run mergeGrids against it with the
 * current merger code. Lets us iterate on merger heuristics and inspect the
 * result against historical data without a 90-second re-parse.
 *
 * POST body:
 *   { results: MethodResult[], options?: { editDistanceThreshold?: number } }
 */
import { NextResponse } from "next/server";
import { requireAdmin, apiError } from "@/lib/api-utils";
import { mergeGrids, type MethodResult, type MergeOptions } from "@/lib/grid-merger";

export async function POST(req: Request) {
  const { error } = await requireAdmin();
  if (error) return error;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return apiError("body must be JSON", 400);
  }

  const { results, options } = body as {
    results?: MethodResult[];
    options?: MergeOptions;
  };

  if (!Array.isArray(results)) {
    return apiError("results must be an array of MethodResult", 400);
  }

  const merged = mergeGrids(results, options);
  return NextResponse.json(merged);
}
