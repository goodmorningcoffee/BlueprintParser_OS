// [refactor jun16 P1.1] The ONE response envelope + typed errors for the route shell.
//
// Plan 02 §4.1: every error response is `{ error: { code, message } }`; 2xx returns the
// handler's data as-is. A 500 NEVER carries the underlying error message — the shell logs
// the real cause server-side (with route + requestId) and returns a generic message. This
// replaces the 6 distinct envelope shapes + 38 `err.message` leaks the diagnosis (01 §4.1)
// found across the 109 routes, in ONE mechanism instead of 109 edits.

import { NextResponse } from "next/server";

export const ErrorCode = {
  BAD_REQUEST: "BAD_REQUEST", // unparseable request (e.g. malformed JSON body)
  VALIDATION: "VALIDATION", // zod schema validation failed
  UNAUTHORIZED: "UNAUTHORIZED", // not authenticated
  FORBIDDEN: "FORBIDDEN", // authenticated but scope/role insufficient
  NOT_FOUND: "NOT_FOUND", // missing OR cross-tenant (deliberately indistinguishable — no existence leak)
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  RETRYABLE: "RETRYABLE", // a provider refused for now (throttling / capacity): the same request may succeed later
  INTERNAL: "INTERNAL", // unexpected — message is ALWAYS generic; real cause logged server-side
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Canonical HTTP status per error code. */
export const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  RETRYABLE: 429,
  INTERNAL: 500,
};

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string };
}

/**
 * The error type handlers/services throw. The shell catches it and renders the envelope.
 * `message` IS surfaced to the client for EVERY ApiError — INCLUDING an explicitly
 * thrown ApiError("INTERNAL", msg): defineRoute's catch returns err.message for any
 * ApiError instance. The generic "Internal server error" substitute applies ONLY to
 * non-ApiError (unexpected) throws. [DR003 FIX-2 — this doc previously claimed the
 * opposite and misled 3+ sessions; the surfacing behavior is LOAD-BEARING (pinned
 * strings: "Failed to fetch PDF", "No page images available", "Failed to load page
 * image"). Do NOT "fix" the mechanism to match the old doc — tests will fail loudly.]
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(code: ErrorCode, message: string, statusOverride?: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = statusOverride ?? STATUS_BY_CODE[code];
  }
}

/** Build the standard error response. */
export function errorResponse(
  code: ErrorCode,
  message: string,
  statusOverride?: number,
): NextResponse<ErrorEnvelope> {
  const status = statusOverride ?? STATUS_BY_CODE[code];
  return NextResponse.json({ error: { code, message } }, { status });
}

// Convenience throwers for handlers/services (keep call sites terse).
export const badRequest = (m = "Bad request") => new ApiError("BAD_REQUEST", m);
export const unauthorized = (m = "Unauthorized") => new ApiError("UNAUTHORIZED", m);
export const forbidden = (m = "Forbidden") => new ApiError("FORBIDDEN", m);
export const notFound = (m = "Not found") => new ApiError("NOT_FOUND", m);
export const conflict = (m = "Conflict") => new ApiError("CONFLICT", m);
