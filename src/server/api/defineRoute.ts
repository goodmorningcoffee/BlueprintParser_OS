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
import { isDemoWriteProtectionError } from "./project-write-errors";
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
  /**
   * No auth AT THE SHELL — which is NOT a synonym for "public". This is the spec the
   * validate-before-auth folds use: the legacy route ran its field cascade before the 401 and
   * that ordering is frozen, so the SERVICE calls auth() itself (services/labeling.ts,
   * services/symbol-search.ts, services/ai-chat.ts). Genuinely public routes use it too.
   * Read the route header before assuming a "none" route is unauthenticated.
   */
  | "none"
  /** Any signed-in user — requireSession(); no session → UNAUTHORIZED 401. */
  | "session"
  /** Company-admin OR root: requireSession("admin") passes role === "admin" OR isRootAdmin. */
  | "admin"
  /** Root ONLY: requireSession("root") passes isRootAdmin; a company-admin gets FORBIDDEN 403. */
  | "root"
  /** checkWebhookSecret: constant-time Bearer compare + fresh x-webhook-timestamp. No session. */
  | "webhookSecret"
  /** Declarative project auth (ProjectAuthSpec above) — delegates to resolveProjectAccess. */
  | { project: ProjectAuthSpec };

// ── route spec + handler context ─────────────────────────────────────────────

export interface RouteContext<B, Q> {
  req: Request;
  params: Record<string, string>;
  body: B;
  query: Q;
  /**
   * Authenticated session, or null. The TYPE is nullable for every auth spec; the GUARANTEE is
   * not. Under auth "session" / "admin" / "root", requireSession has ALREADY thrown
   * UNAUTHORIZED by the time the handler runs, so `session` is non-null there — that is what
   * licenses the bare `session!` that route handlers across src/app/api rely on.
   * Assert it; do NOT add a runtime `if (!session)` branch, which is dead code that reads like
   * a live path. Under `auth:{project}` session may legitimately be null (an unauthenticated
   * demo read); under "none" and "webhookSecret" it always is.
   *
   * Narrowing this per-spec so the `!` disappears is a generic-signature change to
   * RouteContext/RouteSpec that touches every defineRoute call site in src/. It is a real
   * improvement and an OWNER CALL — not a mechanical one.
   */
  session: AuthSession | null;
  /** The resolved project — non-null under `auth:{project}` ONLY; null under every other spec. */
  project: ProjectAccessRow | null;
  /** The resolved access scope — non-null under `auth:{project}` ONLY; null under every other spec. */
  scope: ProjectAccessScope | null;
  /** Per-request id, also used in the server-side 500 log line. */
  requestId: string;
}

export interface RouteSpec<B, Q> {
  auth: AuthSpec;
  /**
   * json (default) = envelope the return value. stream|raw = the handler returns a Response and
   * the shell passes it through.
   *
   * stream and raw are RUNTIME-IDENTICAL. `kind` is consulted in exactly one place — the
   * post-handler check in the shell below — where both values arm the same "handler did not
   * return a Response" safety net. The split is a convention for readers, not behaviour:
   *   stream = a streamed body, NDJSON or SSE (symbol-search, admin/reprocess, ai/chat)
   *   raw    = an asset/binary body whose own headers must survive (label-assets,
   *            project-assets)
   * Picking the wrong one of those two is harmless. Leaving kind at json for a handler that
   * returns a Response is ALSO harmless: the `result instanceof Response` passthrough fires
   * BEFORE the kind check. kind only decides what happens when a Response was expected and
   * something else came back.
   */
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
 * Webhook-secret auth — was AUTHORED as an exact replica of the legacy inline check in
 * processing/webhook/route.ts (that route is a thin shell now and no longer has one):
 * constant-time `Bearer <secret>` compare + a fresh x-webhook-timestamp (≤5min old, ≤1min in
 * the future). Branch parity was verified behaviorally by the S035 freeze,
 * app/api/__tests__/processing.route.test.ts.
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
      // A missed application guard still fails closed at the database trigger. Preserve the
      // canonical public contract instead of turning that expected policy denial into a 500.
      if (isDemoWriteProtectionError(err)) {
        return errorResponse("FORBIDDEN", "Demo projects are read-only");
      }
      // [refactor jul23 P5.6 U4] Unexpected throw. NEVER leak the underlying message to the
      // client, but emit a QUERYABLE structured line server-side — fielded, not a formatted
      // string blob — so an admin CloudWatch Logs Insights "errors" query can filter/aggregate
      // by tag/status/code/path, mirroring the `visit` line middleware already emits and the
      // Logs tabs read. The real cause (message + stack) rides the server-only `err` field.
      logger.error("route error", {
        tag: "route-error",
        requestId,
        method: req.method,
        path: safePath(req),
        status: 500,
        code: "INTERNAL",
        err: err instanceof Error ? err : String(err),
      });
      // [P5.6 U4 GAP-C] Correlation key. The envelope shape is FROZEN ({error:{code,message}}),
      // so surface requestId as an `x-request-id` response header instead of in the body — a
      // client-reported 500 can then be pivoted to the exact server log line. Scoped to the
      // logged 500 path (the only correlation target); broadening to every response is a
      // trivial, envelope-safe follow-up if wanted.
      const res = errorResponse("INTERNAL", "Internal server error");
      res.headers.set("x-request-id", requestId);
      return res;
    }
  };
}
