import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { logger } from "@/lib/logger";
import { lookupCountry } from "@/lib/geo";
import { recordAbuseEvent } from "@/lib/admin-logs/record-abuse";
import { isManuallyBanned } from "@/lib/admin-logs/manual-ban-cache";

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
const SESSION_TTL_SEC = 24 * 60 * 60;

// Known deprecated/removed routes — any hit is a signal (often a scanner
// that cached an old route). Add to this list when you remove a route for
// security reasons. Bootstrap: /api/demo/labeling/credentials deleted in
// Phase 4.1 of the Reddit-launch hardening pass.
const DEPRECATED_ROUTES = [
  "/api/demo/labeling/credentials",
];

// 404-scan detection: >5 404-inducing requests from the same IP within
// this window trips a SCAN_404_BURST abuse event. Tuned lenient so legitimate
// "user mistyped a URL" doesn't flag.
const SCAN_404_WINDOW_MS = 60_000;
const SCAN_404_THRESHOLD = 5;
const scan404Store = new Map<string, { count: number; windowStart: number; alerted: boolean }>();

// ─── In-memory rate limit store ──────────────────────────────
interface RateBucket {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateBucket>();

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
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of store) {
    if (bucket.resetAt < now) store.delete(key);
  }
  for (const [ip, entry] of cooldownStore) {
    const violationsExpired = now - entry.firstViolationAt > VIOLATION_MEMORY_MS;
    const cooldownExpired = entry.cooldownUntil < now;
    if (violationsExpired && cooldownExpired) cooldownStore.delete(ip);
  }
  for (const [ip, entry] of banStore) {
    if (entry.bannedUntil < now) banStore.delete(ip);
  }
  for (const [ip, entry] of scan404Store) {
    if (now - entry.windowStart > SCAN_404_WINDOW_MS * 2) scan404Store.delete(ip);
  }
}, 5 * 60 * 1000);

function isRateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = store.get(key);

  if (!bucket || bucket.resetAt < now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }

  bucket.count++;
  return bucket.count > limit;
}

// ─── Route-specific limits ───────────────────────────────────
interface RateRule {
  pattern: string;
  method: string;
  limit: number;
  windowMs: number;
  keyType: "ip" | "user" | "ip+path";
}

const RATE_RULES: RateRule[] = [
  // Auth - tight limits per IP
  { pattern: "/api/register", method: "POST", limit: 3, windowMs: 15 * 60 * 1000, keyType: "ip" },
  { pattern: "/api/auth/forgot-password", method: "POST", limit: 3, windowMs: 15 * 60 * 1000, keyType: "ip" },
  { pattern: "/api/auth/reset-password", method: "POST", limit: 5, windowMs: 15 * 60 * 1000, keyType: "ip" },
  { pattern: "/api/auth", method: "POST", limit: 5, windowMs: 15 * 60 * 1000, keyType: "ip" },

  // Expensive operations - per user
  { pattern: "/api/ai/chat", method: "POST", limit: 30, windowMs: 60 * 60 * 1000, keyType: "user" },
  { pattern: "/api/yolo/run", method: "POST", limit: 9999, windowMs: 60 * 60 * 1000, keyType: "user" },
  { pattern: "/api/projects", method: "POST", limit: 10, windowMs: 60 * 60 * 1000, keyType: "user" },
  { pattern: "/api/s3/credentials", method: "POST", limit: 10, windowMs: 60 * 60 * 1000, keyType: "user" },

  // Moderate limits
  { pattern: "/api/takeoff-items", method: "POST", limit: 50, windowMs: 60 * 60 * 1000, keyType: "user" },
  { pattern: "/api/annotations", method: "POST", limit: 200, windowMs: 60 * 60 * 1000, keyType: "user" },

  // Invite requests - tight limit per IP
  { pattern: "/api/invite", method: "POST", limit: 5, windowMs: 15 * 60 * 1000, keyType: "ip" },

  // Labeling endpoints - tight limits
  { pattern: "/api/labeling/login", method: "GET", limit: 10, windowMs: 15 * 60 * 1000, keyType: "ip" },
  { pattern: "/api/labeling/create", method: "POST", limit: 5, windowMs: 60 * 60 * 1000, keyType: "user" },

  // LLM config test - admin only, tight limit
  { pattern: "/api/admin/llm-config/test", method: "POST", limit: 5, windowMs: 60 * 1000, keyType: "user" },

  // Demo endpoints - per IP
  { pattern: "/api/demo", method: "GET", limit: 60, windowMs: 60 * 1000, keyType: "ip" },
  { pattern: "/api/demo/chat", method: "POST", limit: 10, windowMs: 60 * 1000, keyType: "ip" },
];

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
  const { pathname } = request.nextUrl;
  const method = request.method;
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const userAgent = request.headers.get("user-agent") || "";
  const startTs = Date.now();

  // Stable 24h session ID for grouping requests by visitor in CloudWatch
  // Logs Insights queries. See /home/vscode/.claude/plans/admin-logs-tab-root-only.md
  // for the rationale (dedicated cookie beats NextAuth-cookie-hash for anon users).
  let sessionId = request.cookies.get(SESSION_COOKIE)?.value;
  const sessionIsNew = !sessionId;
  if (!sessionId) sessionId = crypto.randomUUID();

  // The NextAuth session cookie presence is a cheap "authed?" proxy. We can't
  // decode the JWT in middleware cheaply so we just note presence.
  const hasNextAuthSession = !!(
    request.cookies.get("next-auth.session-token")?.value ||
    request.cookies.get("__Secure-next-auth.session-token")?.value ||
    request.cookies.get("authjs.session-token")?.value ||
    request.cookies.get("__Secure-authjs.session-token")?.value
  );

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
    // Fire-and-forget visit log — don't block the response on GeoIP lookup.
    void (async () => {
      const country = await lookupCountry(ip);
      logger.info("visit", {
        tag: "visit",
        ip,
        country,
        sessionId,
        method,
        path: pathname,
        status: response.status,
        latencyMs: Date.now() - startTs,
        userAgent,
        authed: hasNextAuthSession,
      });
    })();
    return response;
  };

  // Manual IP ban — Root_Admin explicitly banned this IP via the Logs tab.
  // Cache is process-local with background setInterval refresh, so this
  // call is a synchronous O(1) Set.has(). No DB touch, no await.
  if (isManuallyBanned(ip)) {
    return finalize(new NextResponse(
      JSON.stringify({ error: "Access blocked." }),
      {
        status: 403,
        headers: { "Content-Type": "application/json" },
      },
    ));
  }

  // Deprecated-route hit — a scanner/old-link hit a route we've removed for
  // security. Fire the abuse event early and let Next return its own 404.
  if (DEPRECATED_ROUTES.includes(pathname)) {
    recordAbuseEvent({
      eventType: "DEPRECATED_ROUTE",
      ip,
      path: pathname,
      userAgent,
    });
  }

  // Only rate limit API routes
  if (pathname.startsWith("/api")) {
    const now = Date.now();

    // ─── Tiered IP abuse detection on Lambda-fanout routes ────
    // Ban check runs first and blocks the request regardless of other
    // rate rules; cooldown check runs next and returns 429 early.
    if (isAbusiveRoute(pathname)) {
      const banEntry = banStore.get(ip);
      if (banEntry && banEntry.bannedUntil > now) {
        return finalize(new NextResponse(
          JSON.stringify({
            error: "Access temporarily blocked due to repeated abuse.",
            bannedUntil: new Date(banEntry.bannedUntil).toISOString(),
          }),
          {
            status: 403,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": String(Math.ceil((banEntry.bannedUntil - now) / 1000)),
            },
          },
        ));
      }
      const coolEntry = cooldownStore.get(ip);
      if (coolEntry && coolEntry.cooldownUntil > now) {
        return finalize(new NextResponse(
          JSON.stringify({
            error: "Too many parser requests. Cooldown active.",
            retryAfter: Math.ceil((coolEntry.cooldownUntil - now) / 1000),
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": String(Math.ceil((coolEntry.cooldownUntil - now) / 1000)),
            },
          },
        ));
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
            details: { bannedUntil: new Date(now + BAN_MS).toISOString(), violations },
          });
          return finalize(new NextResponse(
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
          ));
        }
        return finalize(new NextResponse(
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
        ));
      }
    }

    // Find matching rule
    const rule = RATE_RULES.find(
      (r) => pathname.startsWith(r.pattern) && method === r.method
    );

    if (rule) {
      // Build rate limit key
      let key: string;
      if (rule.keyType === "ip") {
        key = `rl:${rule.pattern}:${ip}`;
      } else if (rule.keyType === "ip+path") {
        key = `rl:${pathname}:${ip}`;
      } else {
        // "user" - use session cookie as proxy (can't decode JWT in edge middleware cheaply)
        const sessionToken =
          request.cookies.get("next-auth.session-token")?.value ||
          request.cookies.get("__Secure-next-auth.session-token")?.value ||
          ip;
        key = `rl:${rule.pattern}:${sessionToken}`;
      }

      if (isRateLimited(key, rule.limit, rule.windowMs)) {
        return finalize(new NextResponse(
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
          }
        ));
      }
    }

    // General API rate limit: 120 req/min per IP
    if (!RATE_RULES.some((r) => pathname.startsWith(r.pattern) && method === r.method)) {
      if (isRateLimited(`rl:api:${ip}`, 120, 60 * 1000)) {
        return finalize(new NextResponse(
          JSON.stringify({ error: "Too many requests." }),
          {
            status: 429,
            headers: { "Content-Type": "application/json" },
          }
        ));
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
