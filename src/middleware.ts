import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { logger } from "@/lib/logger";
import { lookupCountry } from "@/lib/geo";
import { recordAbuseEvent } from "@/lib/admin-logs/record-abuse";
import { isManuallyBanned } from "@/lib/admin-logs/manual-ban-cache";
import { trustedClientIp } from "@/lib/trusted-client-ip";
import { getToken } from "next-auth/jwt";
import {
  apiIpBackstopForRule,
  confirmedRootUserId,
  findRateRule,
  isGeneralBucketExempt,
  isRateLimited,
  isRootExemptRule,
  pruneExpiredRateBuckets,
  rootParserLaneRetryAfter,
} from "@/lib/middleware-rate-limit";
import { refreshJwtUserAuthority } from "@/server/services/auth-jwt-authority";
// TEST-FACING RE-EXPORT, deliberate — not an accident and not dead code. These symbols live in
// lib/middleware-rate-limit.ts and lib/trusted-client-ip.ts; they are surfaced here because two
// test files address them through the "@/middleware" specifier:
// lib/__tests__/middleware-rate-rules.test.ts and lib/__tests__/middleware-rate-admission.test.ts.
// (Four test files import "@/middleware"; the other two take only the `middleware` function and
// never touch this block — consumers of THIS block are 2, not 4.) Nothing in production imports
// from this module: Next loads middleware.ts by convention. Deleting the block breaks those two
// test files, so do not "clean it up".
export {
  findRateRule,
  isGeneralBucketExempt,
  isLabelAssetTransportRatePath,
  isViewerTransportRatePath,
  middlewareRateLimitStoreSizeForTest,
} from "@/lib/middleware-rate-limit";
export { trustedClientIp } from "@/lib/trusted-client-ip";

/**
 * Run in Node.js runtime (Next 15+). Required so this module can import
 * `logger`, `pg`-backed DB helpers, and the MaxMind GeoIP reader — none of
 * which work in the default Edge runtime.
 *
 * Fallback if Node middleware proves incompatible: keep this on Edge and
 * move `[visit]` logging / DB writes to `src/app/api/_track/route.ts`
 * invoked via internal fetch. Current plan: Node runtime is simpler.
 */
export const runtime = "nodejs";

const SESSION_COOKIE = "bp_visit_session";
const LOGGED_FIELD_MAX_CHARS = 256;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_TTL_SEC = 24 * 60 * 60;

// Root re-confirmation: the same users read Auth.js runs on every session refresh, on a fresh
// object so the decoded token (reused by the visit log) is never mutated.
const isRootInDatabase = async (userId: number): Promise<boolean> => {
  const fresh: { dbId: number; isRootAdmin?: boolean } = { dbId: userId };
  return (await refreshJwtUserAuthority(fresh))?.isRootAdmin === true;
};

// Known deprecated/removed routes — any hit is a signal (often a scanner
// that cached an old route). Add to this list when you remove a route for
// security reasons. Bootstrap: /api/demo/labeling/credentials deleted in
// Phase 4.1 of the Reddit-launch hardening pass.
const DEPRECATED_ROUTES = [
  "/api/demo/labeling/credentials",
  "/api/labeling/credentials",
];

// Tombstones are intentionally unauthenticated while stale clients drain.
// Give them a small bucket before any durable telemetry write, and sample one
// abuse row per client/path/window. This prevents a scanner from converting
// every 410 request into a persistent database insert.
const DEPRECATED_ROUTE_LIMIT = 5;
const DEPRECATED_ROUTE_WINDOW_MS = 60_000;

interface DeprecatedRouteBucket {
  count: number;
  resetAt: number;
  telemetryRecorded: boolean;
}

const deprecatedRouteStore = new Map<string, DeprecatedRouteBucket>();

function admitDeprecatedRoute(
  ip: string,
  pathname: string,
): {
  rateLimited: boolean;
  shouldRecordTelemetry: boolean;
} {
  const now = Date.now();
  const key = `${ip}:${pathname}`;
  let bucket = deprecatedRouteStore.get(key);
  if (!bucket || bucket.resetAt < now) {
    bucket = {
      count: 1,
      resetAt: now + DEPRECATED_ROUTE_WINDOW_MS,
      telemetryRecorded: true,
    };
    deprecatedRouteStore.set(key, bucket);
    return { rateLimited: false, shouldRecordTelemetry: true };
  }

  bucket.count += 1;
  const shouldRecordTelemetry = !bucket.telemetryRecorded;
  bucket.telemetryRecorded = true;
  return {
    rateLimited: bucket.count > DEPRECATED_ROUTE_LIMIT,
    shouldRecordTelemetry,
  };
}

// 404-scan detection: >5 404-inducing requests from the same IP within
// this window trips a SCAN_404_BURST abuse event. Tuned lenient so legitimate
// "user mistyped a URL" doesn't flag.
const SCAN_404_WINDOW_MS = 60_000;
const SCAN_404_THRESHOLD = 5;
const scan404Store = new Map<
  string,
  { count: number; windowStart: number; alerted: boolean }
>();

// ─── Tiered IP abuse detection (Phase 3 hardening) ──────────
//
// Lambda-fanout routes (one HTTP call → many Lambda invocations) get a
// tighter per-IP limit. Burst breach → 30s cooldown. Second breach within
// 5 min → 1hr ban. This caps the worst-case cost of a single IP hammering
// the expensive parser endpoints.
//
// Rate-limit the HTTP request layer rather than Lambda-side because
// Lambda invocations happen from internal ECS callers and the source IP
// is no longer visible by the time Lambda fires.
//
// Known limitation: in-memory per ECS task, so a 4-task cluster effectively
// multiplies the threshold 4x before first 429 hits. Acceptable for the
// 50–100 concurrent user launch scale; redis/dynamodb-backed store is the
// post-launch upgrade.

const ABUSIVE_ROUTE_PREFIXES = [
  "/api/symbol-search",
  "/api/shape-parse",
  "/api/table-parse",
  "/api/table-structure",
  "/api/bucket-fill",
];
const ABUSIVE_LIMIT = 5;
const ABUSIVE_WINDOW_MS = 10_000;
const COOLDOWN_MS = 30_000;
const BAN_MS = 60 * 60 * 1000;
const BAN_VIOLATIONS_THRESHOLD = 2;
const VIOLATION_MEMORY_MS = 5 * 60 * 1000;

interface CooldownEntry {
  cooldownUntil: number;
  violations: number;
  firstViolationAt: number;
}
const cooldownStore = new Map<string, CooldownEntry>();

interface BanEntry {
  bannedUntil: number;
}
const banStore = new Map<string, BanEntry>();

function isAbusiveRoute(pathname: string): boolean {
  return ABUSIVE_ROUTE_PREFIXES.some((p) => pathname.startsWith(p));
}

// Clean expired entries every 5 min — includes the cooldown/ban stores
// alongside the original rate-bucket store.
setInterval(
  () => {
    const now = Date.now();
    pruneExpiredRateBuckets(now);
    for (const [ip, entry] of cooldownStore) {
      const violationsExpired =
        now - entry.firstViolationAt > VIOLATION_MEMORY_MS;
      const cooldownExpired = entry.cooldownUntil < now;
      if (violationsExpired && cooldownExpired) cooldownStore.delete(ip);
    }
    for (const [ip, entry] of banStore) {
      if (entry.bannedUntil < now) banStore.delete(ip);
    }
    for (const [ip, entry] of scan404Store) {
      if (now - entry.windowStart > SCAN_404_WINDOW_MS * 2)
        scan404Store.delete(ip);
    }
    for (const [key, bucket] of deprecatedRouteStore) {
      if (bucket.resetAt < now) deprecatedRouteStore.delete(key);
    }
  },
  5 * 60 * 1000,
);

// ─── Security headers ────────────────────────────────────────
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

// ─── Middleware ───────────────────────────────────────────────
export async function middleware(request: NextRequest) {
  // Every rule below keys on the path, and Next's router also matches the percent-DECODED form,
  // so a raw-path comparison would let `/%61pi/...` reach a handler with no limit at all.
  let pathname: string;
  try {
    pathname = decodeURIComponent(request.nextUrl.pathname);
  } catch {
    return new NextResponse(JSON.stringify({ error: "Bad request." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  // The ALB and container health checks must never be rate-limited: the limiter store fails
  // closed when full, and a 429 here makes ECS replace a healthy task.
  if (pathname === "/api/health") return NextResponse.next();
  const method = request.method;
  const ip = trustedClientIp(request.headers.get("x-forwarded-for"));
  // Caller-controlled and logged on every response, including 429s — bound what one request can
  // push into CloudWatch.
  const userAgent = (request.headers.get("user-agent") || "").slice(0, LOGGED_FIELD_MAX_CHARS);
  const loggedPath = pathname.slice(0, LOGGED_FIELD_MAX_CHARS);
  const startTs = Date.now();

  // Stable 24h session ID for grouping requests by visitor in CloudWatch Logs Insights
  // queries. A dedicated cookie beats hashing the NextAuth cookie: anon users have none.
  const cookieSessionId = request.cookies.get(SESSION_COOKIE)?.value;
  let sessionId = cookieSessionId && UUID_RE.test(cookieSessionId) ? cookieSessionId : undefined;
  const sessionIsNew = !sessionId;
  if (!sessionId) sessionId = crypto.randomUUID();

  // Cookie presence is only a hint that verification is worth attempting; its
  // bytes are caller-controlled and must never become a rate-limit identity.
  // Reuse one signature-verifying decode for user-keyed rules and visit logs.
  const hasNextAuthSession = !!(
    request.cookies.get("next-auth.session-token")?.value ||
    request.cookies.get("__Secure-next-auth.session-token")?.value ||
    request.cookies.get("authjs.session-token")?.value ||
    request.cookies.get("__Secure-authjs.session-token")?.value
  );
  const verifiedAuthToken = hasNextAuthSession
    ? getToken({
        req: request,
        secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET,
        secureCookie: process.env.NODE_ENV === "production",
      }).catch(() => null)
    : Promise.resolve(null);

  // Attach security headers + session cookie + emit one structured [visit]
  // log line per response. All early-return paths (429, 403) go through here
  // so abuse signals are visible in the same CW stream.
  const finalize = async (response: NextResponse): Promise<NextResponse> => {
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      response.headers.set(key, value);
    }
    if (sessionIsNew) {
      response.cookies.set(SESSION_COOKIE, sessionId!, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: SESSION_TTL_SEC,
        path: "/",
      });
    }
    // 404-scan detection — threshold check per IP. Fires once per window
    // to avoid spamming the abuse_events table with duplicates.
    if (response.status === 404) {
      const nowTs = Date.now();
      const existing = scan404Store.get(ip);
      if (!existing || nowTs - existing.windowStart > SCAN_404_WINDOW_MS) {
        scan404Store.set(ip, { count: 1, windowStart: nowTs, alerted: false });
      } else {
        existing.count++;
        if (existing.count >= SCAN_404_THRESHOLD && !existing.alerted) {
          existing.alerted = true;
          recordAbuseEvent({
            eventType: "SCAN_404_BURST",
            ip,
            path: pathname,
            userAgent,
            details: { hits: existing.count, windowMs: SCAN_404_WINDOW_MS },
          });
        }
      }
    }
    // Fire-and-forget visit log — don't block the response on GeoIP lookup or
    // the JWT decode. Decoding the session token here (Node runtime) attaches
    // the account identity to engagement data with zero added response latency.
    // We log only the opaque userId/companyId — never email/PII — and the
    // Logs → Accounts view resolves those to names server-side at query time.
    // A decode failure (rotated secret, cookie mismatch) degrades gracefully to
    // an anonymous visit; it never breaks the request.
    void (async () => {
      const [country, token] = await Promise.all([
        lookupCountry(ip),
        verifiedAuthToken,
      ]);
      logger.info("visit", {
        tag: "visit",
        ip,
        country,
        sessionId,
        method,
        path: loggedPath,
        status: response.status,
        latencyMs: Date.now() - startTs,
        userAgent,
        authed: typeof token?.dbId === "number",
        userId: typeof token?.dbId === "number" ? token.dbId : undefined,
        companyId:
          typeof token?.companyId === "number" ? token.companyId : undefined,
      });
    })();
    return response;
  };

  // Manual IP ban — Root_Admin explicitly banned this IP via the Logs tab.
  // Cache is process-local with background setInterval refresh, so this
  // call is a synchronous O(1) Set.has(). No DB touch, no await.
  if (isManuallyBanned(ip)) {
    return finalize(
      new NextResponse(JSON.stringify({ error: "Access blocked." }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  // Deprecated-route hit — rate-limit before durable telemetry because these
  // tombstones are deliberately unauthenticated. The first admitted hit per
  // client/path/window records one signal; repeats are sampled and then 429'd.
  if (DEPRECATED_ROUTES.includes(pathname)) {
    const admission = admitDeprecatedRoute(ip, pathname);
    if (admission.shouldRecordTelemetry) {
      recordAbuseEvent({
        eventType: "DEPRECATED_ROUTE",
        ip,
        path: pathname,
        userAgent,
        details: { windowMs: DEPRECATED_ROUTE_WINDOW_MS },
      });
    }
    if (admission.rateLimited) {
      return finalize(
        new NextResponse(JSON.stringify({ error: "Too many requests." }), {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(Math.ceil(DEPRECATED_ROUTE_WINDOW_MS / 1000)),
          },
        }),
      );
    }
  }

  // Only rate limit API routes
  if (pathname.startsWith("/api")) {
    const now = Date.now();
    // Root admin: ONLY from the verified (AUTH_SECRET-decrypted) session token — never a header
    // or an unverified cookie — and then re-confirmed against users.isRootAdmin (cached 30 s), so
    // an unrefreshed cookie cannot carry the exemption past a demotion. Owner ruling 2026-10-21:
    // root is exempt from the app's policy limits; the manual IP ban, the deprecated-route bucket
    // and the pre-auth rules still apply.
    const rootUserId = await confirmedRootUserId(await verifiedAuthToken, isRootInDatabase, now);

    // Root's parser lane: no IP ban / cooldown / burst state is read or written for him; a
    // per-user ceiling bounds his concurrent local parses (memory), with a plain 429.
    if (rootUserId !== null && isAbusiveRoute(pathname)) {
      const retryAfter = rootParserLaneRetryAfter(
        rootUserId,
        pathname.split("/").slice(0, 3).join("/"),
        now,
      );
      if (retryAfter > 0) {
        return finalize(
          new NextResponse(
            JSON.stringify({ error: "Too many parser requests.", retryAfter }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": String(retryAfter),
              },
            },
          ),
        );
      }
    }

    // ─── Tiered IP abuse detection on Lambda-fanout routes ────
    // Ban check runs first and blocks the request regardless of other
    // rate rules; cooldown check runs next and returns 429 early.
    if (rootUserId === null && isAbusiveRoute(pathname)) {
      const banEntry = banStore.get(ip);
      if (banEntry && banEntry.bannedUntil > now) {
        return finalize(
          new NextResponse(
            JSON.stringify({
              error: "Access temporarily blocked due to repeated abuse.",
              bannedUntil: new Date(banEntry.bannedUntil).toISOString(),
            }),
            {
              status: 403,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": String(
                  Math.ceil((banEntry.bannedUntil - now) / 1000),
                ),
              },
            },
          ),
        );
      }
      const coolEntry = cooldownStore.get(ip);
      if (coolEntry && coolEntry.cooldownUntil > now) {
        return finalize(
          new NextResponse(
            JSON.stringify({
              error: "Too many parser requests. Cooldown active.",
              retryAfter: Math.ceil((coolEntry.cooldownUntil - now) / 1000),
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": String(
                  Math.ceil((coolEntry.cooldownUntil - now) / 1000),
                ),
              },
            },
          ),
        );
      }

      // Apply the abusive-route burst limit. On breach, escalate.
      const abusiveKey = `abusive:${ip}:${pathname.split("/").slice(0, 3).join("/")}`;
      if (isRateLimited(abusiveKey, ABUSIVE_LIMIT, ABUSIVE_WINDOW_MS)) {
        const existing = cooldownStore.get(ip);
        let violations: number;
        let firstViolationAt: number;
        if (existing && now - existing.firstViolationAt < VIOLATION_MEMORY_MS) {
          violations = existing.violations + 1;
          firstViolationAt = existing.firstViolationAt;
        } else {
          violations = 1;
          firstViolationAt = now;
        }
        cooldownStore.set(ip, {
          cooldownUntil: now + COOLDOWN_MS,
          violations,
          firstViolationAt,
        });
        recordAbuseEvent({
          eventType: "RATE_LIMIT_BREACH",
          ip,
          path: pathname,
          userAgent,
          details: { violations, route: pathname },
        });
        if (violations >= BAN_VIOLATIONS_THRESHOLD) {
          banStore.set(ip, { bannedUntil: now + BAN_MS });
          recordAbuseEvent({
            eventType: "IP_BANNED_AUTO",
            ip,
            path: pathname,
            userAgent,
            details: {
              bannedUntil: new Date(now + BAN_MS).toISOString(),
              violations,
            },
          });
          return finalize(
            new NextResponse(
              JSON.stringify({
                error: "Access temporarily blocked due to repeated abuse.",
                bannedUntil: new Date(now + BAN_MS).toISOString(),
              }),
              {
                status: 403,
                headers: {
                  "Content-Type": "application/json",
                  "Retry-After": String(Math.ceil(BAN_MS / 1000)),
                },
              },
            ),
          );
        }
        return finalize(
          new NextResponse(
            JSON.stringify({
              error: "Too many parser requests. Cooldown active.",
              retryAfter: Math.ceil(COOLDOWN_MS / 1000),
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": String(Math.ceil(COOLDOWN_MS / 1000)),
              },
            },
          ),
        );
      }
    }

    // Find matching rule. A verified root skips the backstop and the route rule together,
    // except on the pre-auth rules (sign-in / registration / password reset), which bind him too.
    const matchedRule = findRateRule(pathname, method);
    const rootExempt = rootUserId !== null && isRootExemptRule(matchedRule);
    const rule = rootExempt ? undefined : matchedRule;

    // Apply the independently namespaced IP backstop even when a route-specific
    // rule matches. Otherwise rotating a purported user identity could skip the
    // only IP-wide admission control. Session GET is the sole exact exemption.
    // (A root claim cannot be forged by rotating identities: it is inside the encrypted token.)
    if (!rootExempt && !isGeneralBucketExempt(pathname, method)) {
      const backstop = apiIpBackstopForRule(rule);
      if (
        isRateLimited(
          `rl:backstop:${backstop.keyScope}:${ip}`,
          backstop.limit,
          backstop.windowMs,
        )
      ) {
        return finalize(
          new NextResponse(JSON.stringify({ error: "Too many requests." }), {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": String(Math.ceil(backstop.windowMs / 1000)),
            },
          }),
        );
      }
    }

    if (rule) {
      // Route buckets are namespaced separately from the IP backstop. A user
      // identity is accepted only from a successfully verified JWT; missing or
      // invalid credentials fall back to the trusted ALB client IP.
      let key: string;
      if (rule.keyType === "ip") {
        key = `rl:route:${rule.pattern}:ip:${ip}`;
      } else if (rule.keyType === "ip+path") {
        key = `rl:route:${pathname}:ip:${ip}`;
      } else {
        const token = await verifiedAuthToken;
        const verifiedUserId =
          typeof token?.dbId === "number" &&
          Number.isSafeInteger(token.dbId) &&
          token.dbId > 0
            ? token.dbId
            : null;
        key = verifiedUserId
          ? `rl:route:${rule.pattern}:user:${verifiedUserId}`
          : `rl:route:${rule.pattern}:ip:${ip}`;
      }

      if (isRateLimited(key, rule.limit, rule.windowMs)) {
        return finalize(
          new NextResponse(
            JSON.stringify({
              error: "Too many requests. Please try again later.",
              retryAfter: Math.ceil(rule.windowMs / 1000),
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": String(Math.ceil(rule.windowMs / 1000)),
              },
            },
          ),
        );
      }
    }
  }

  return finalize(NextResponse.next());
}

export const config = {
  matcher: [
    // Match all API routes and pages, skip static files
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
