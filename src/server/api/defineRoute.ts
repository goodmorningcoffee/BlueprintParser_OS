// [refactor jun16 P1.1] The route shell.
//
// ONE place for: safe JSON parse, zod validation, auth resolution, the unified error
// envelope, error-leak prevention, and a per-request id for server-side logging. A route
// file declares WHAT (auth scope, schemas, handler); the shell does HOW. See plan 03 §P1.1
// and 02 §4.1. The auth section DELEGATES to api-utils — resolveProjectAccess IS the engine
// (it does auth + project lookup + tenancy 404 + lightweight column selection); the shell
// just makes it non-optional and maps its result into the new envelope.
//
// Order of operations (per request):
//   1. safe-parse the raw JSON body (400 BAD_REQUEST on malformed) — auth-by-body needs the
//      raw object before schema validation.
//   2. resolve auth (none | session | admin | root | webhookSecret | project{...}).
//   3. validate body + query against their zod schemas (400 VALIDATION on failure).
//   4. run the handler; envelope its return (kind=json) or pass its Response through
//      (kind=stream|raw, e.g. SSE/ndjson, or any handler that returns a Response).
// Any ApiError → its {code,message,status}. Any unexpected throw → 500 with a GENERIC
// message; the real cause is logged server-side with route + requestId, never returned.

import { NextResponse } from "next/server";
import { randomUUID, timingSafeEqual } from "crypto";
import type { z } from "zod";
import { auth } from "@/lib/auth";
import {
  type AuthSession,
  type ProjectAccessRow,
  type ProjectAccessScope,
} from "@/lib/api-utils";
import { logger } from "@/lib/logger";
import { ApiError, errorResponse } from "./envelope";
import { resolveProjectOrThrow } from "./access";
import { zPublicId } from "./schemas";

// ── auth spec ────────────────────────────────────────────────────────────────

type Rank = "member" | "admin" | "root";
const SCOPE_RANK: Record<ProjectAccessScope, number> = { demo: 0, member: 1, admin: 2, root: 3 };
const MIN_RANK: Record<Rank, number> = { member: 1, admin: 2, root: 3 };

export interface ProjectAuthSpec {
  /** URL param name holding a publicId (uuid). e.g. `param:"id"` → reads ctx.params.id. */
  param?: string;
  /** body field holding the id (read from the raw parsed body, before schema validation). */
  bodyKey?: string;
  /** how to interpret the extracted id. Default: "publicId". */
  as?: "publicId" | "dbId";
  /** demo projects accessible without auth (read paths). Default false. */
  allowDemo?: boolean;
  /**
   * Minimum AUTHED scope. Default "member". Demo scope BYPASSES this (it is gated solely by
   * allowDemo + the service's demo visibility rules) — `min` is the floor for authenticated
   * callers, e.g. min:"admin" lets only company-admins/root through.
   */
  min?: Rank;
}

export type AuthSpec =
  | "none"
  | "session"
  | "admin"
  | "root"
  | "webhookSecret"
  | { project: ProjectAuthSpec };

// ── route spec + handler context ─────────────────────────────────────────────

export interface RouteContext<B, Q> {
  req: Request;
  params: Record<string, string>;
  body: B;
  query: Q;
  /** Authenticated session, or null for public/demo/webhook routes. */
  session: AuthSession | null;
  /** The resolved project (project-auth routes only), else null. */
  project: ProjectAccessRow | null;
  /** The resolved access scope (project-auth routes only), else null. */
  scope: ProjectAccessScope | null;
  /** Per-request id, also used in the server-side 500 log line. */
  requestId: string;
}

export interface RouteSpec<B, Q> {
  auth: AuthSpec;
  /** json (default) = envelope the return value. stream|raw = handler returns a Response, passed through. */
  kind?: "json" | "stream" | "raw";
  body?: z.ZodType<B>;
  query?: z.ZodType<Q>;
  /**
   * [refactor jul7 DR006] Skip the step-1 JSON body parse so the handler can consume the raw
   * request stream itself (e.g. `ctx.req.formData()` for multipart uploads). The shell would
   * otherwise `req.text()` the stream away and 400 on non-JSON. When true, `ctx.body` stays
   * undefined — do NOT also set `body` (there is nothing to validate), and do NOT use a
   * project `bodyKey` auth (the raw object it reads from is unavailable). Only route that needs
   * this today: admin/csi/upload (multipart). Auth still runs normally (before the handler).
   */
  rawBody?: boolean;
  handler: (ctx: RouteContext<B, Q>) => unknown | Promise<unknown>;
}

// [P2-entry jul9] LOOSE ON PURPOSE (type-only; runtime identical): Next's dev-generated
// .next/dev/types/validator.ts checks every exported handler against
// `context: { params: Promise<ParamMap[Route]> }` — and ParamMap[Route] can degrade to
// `unknown` under stale/partial dev codegen (first surfaced when the e2e harness started
// running dev servers: two dynamic GET routes failed tsc ONLY while .next/dev existed,
// breaking the `tsc --noEmit` gate for every session after any dev run). Accept anything
// promise-shaped here and coerce after await — route params are always string-valued at
// runtime for our routes.
type NextSegment = { params?: Promise<unknown> };

// ── helpers ──────────────────────────────────────────────────────────────────

const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function safeParseJsonBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("BAD_REQUEST", "Invalid JSON body");
  }
}

/**
 * Webhook-secret auth — replicates processing/webhook/route.ts EXACTLY: constant-time
 * `Bearer <secret>` compare + a fresh x-webhook-timestamp (≤5min old, ≤1min in the future).
 */
function checkWebhookSecret(req: Request): void {
  const authHeader = req.headers.get("authorization");
  const secret = process.env.PROCESSING_WEBHOOK_SECRET;
  const expected = `Bearer ${secret}`;
  if (
    !secret ||
    !authHeader ||
    authHeader.length !== expected.length ||
    !timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
  ) {
    throw new ApiError("UNAUTHORIZED", "Unauthorized");
  }
  const timestamp = req.headers.get("x-webhook-timestamp");
  if (!timestamp) throw new ApiError("UNAUTHORIZED", "Missing timestamp");
  const age = Date.now() - parseInt(timestamp);
  if (age > 5 * 60 * 1000 || age < -60 * 1000) {
    throw new ApiError("UNAUTHORIZED", "Webhook expired");
  }
}

async function requireSession(minRole?: "admin" | "root"): Promise<AuthSession> {
  const session = (await auth()) as unknown as AuthSession | null;
  if (!session?.user) throw new ApiError("UNAUTHORIZED", "Unauthorized");
  if (minRole === "admin" && session.user.role !== "admin" && !session.user.isRootAdmin) {
    throw new ApiError("FORBIDDEN", "Admin only");
  }
  if (minRole === "root" && !session.user.isRootAdmin) {
    throw new ApiError("FORBIDDEN", "Root admin only");
  }
  return session;
}

async function resolveProject(
  spec: ProjectAuthSpec,
  params: Record<string, string>,
  raw: unknown,
): Promise<{ project: ProjectAccessRow; session: AuthSession | null; scope: ProjectAccessScope }> {
  const as = spec.as ?? "publicId";

  // extract the raw id (URL param OR body field)
  let rawId: unknown;
  if (spec.param) rawId = params[spec.param];
  else if (spec.bodyKey)
    rawId = raw && typeof raw === "object" ? (raw as Record<string, unknown>)[spec.bodyKey] : undefined;

  let lookup: { publicId: string } | { dbId: number };
  if (as === "publicId") {
    const parsed = zPublicId.safeParse(rawId);
    if (!parsed.success) throw new ApiError("VALIDATION", "Invalid project id");
    lookup = { publicId: parsed.data };
  } else {
    const n = typeof rawId === "number" ? rawId : Number(rawId);
    if (!Number.isInteger(n) || n <= 0) throw new ApiError("VALIDATION", "Invalid project id");
    lookup = { dbId: n };
  }

  // resolveProjectOrThrow maps the engine's old {error:string}/NextResponse failures into
  // the new envelope (401→UNAUTHORIZED, else→NOT_FOUND; cross-tenant stays indistinguishable
  // from missing — no existence leak). Shared with services that resolve access imperatively.
  const { project, session, scope } = await resolveProjectOrThrow(lookup, { allowDemo: spec.allowDemo });

  // enforce the minimum AUTHED scope (demo bypasses — gated by allowDemo only)
  if (scope !== "demo" && SCOPE_RANK[scope] < MIN_RANK[spec.min ?? "member"]) {
    throw new ApiError("FORBIDDEN", "Forbidden");
  }
  return { project, session, scope };
}

function zodToApiError(error: z.ZodError): ApiError {
  const first = error.issues[0];
  const path = first?.path?.join(".");
  const message = first ? `${path ? path + ": " : ""}${first.message}` : "Validation failed";
  return new ApiError("VALIDATION", message);
}

function safePath(req: Request): string {
  try {
    return new URL(req.url).pathname;
  } catch {
    return "?";
  }
}

// ── the shell ────────────────────────────────────────────────────────────────

export function defineRoute<B = undefined, Q = undefined>(
  spec: RouteSpec<B, Q>,
): (req: Request, segment?: NextSegment) => Promise<Response> {
  const kind = spec.kind ?? "json";

  return async function routeHandler(req: Request, segment?: NextSegment): Promise<Response> {
    const requestId = randomUUID();
    try {
      const params = (segment?.params ? await segment.params : {}) as Record<string, string>;

      // 1. raw body — skipped when spec.rawBody, so the handler owns the stream (e.g. formData)
      const raw = !spec.rawBody && METHODS_WITH_BODY.has(req.method) ? await safeParseJsonBody(req) : undefined;

      // 2. auth
      let session: AuthSession | null = null;
      let project: ProjectAccessRow | null = null;
      let scope: ProjectAccessScope | null = null;
      const a = spec.auth;
      if (a === "none") {
        /* public */
      } else if (a === "session") {
        session = await requireSession();
      } else if (a === "admin") {
        session = await requireSession("admin");
      } else if (a === "root") {
        session = await requireSession("root");
      } else if (a === "webhookSecret") {
        checkWebhookSecret(req);
      } else {
        const r = await resolveProject(a.project, params, raw);
        project = r.project;
        session = r.session;
        scope = r.scope;
      }

      // 3. schema validation (after auth)
      let body = undefined as unknown as B;
      if (spec.body) {
        const parsed = spec.body.safeParse(raw);
        if (!parsed.success) throw zodToApiError(parsed.error);
        body = parsed.data;
      }
      let query = undefined as unknown as Q;
      if (spec.query) {
        const qobj = Object.fromEntries(new URL(req.url).searchParams);
        const parsed = spec.query.safeParse(qobj);
        if (!parsed.success) throw zodToApiError(parsed.error);
        query = parsed.data;
      }

      // 4. handler + envelope
      const result = await spec.handler({ req, params, body, query, session, project, scope, requestId });
      if (result instanceof Response) return result; // stream/raw or explicit Response passthrough
      if (kind === "stream" || kind === "raw") {
        throw new ApiError("INTERNAL", "stream/raw route did not return a Response");
      }
      return NextResponse.json(result ?? null, { status: 200 });
    } catch (err) {
      if (err instanceof ApiError) {
        return errorResponse(err.code, err.message, err.status);
      }
      // unexpected — NEVER leak the underlying message
      logger.error(
        `[route] ${req.method} ${safePath(req)} reqId=${requestId} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return errorResponse("INTERNAL", "Internal server error");
    }
  };
}
