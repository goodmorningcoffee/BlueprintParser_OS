import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// ─── In-memory rate limit store ──────────────────────────────
interface RateBucket {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateBucket>();

// Clean expired entries every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of store) {
    if (bucket.resetAt < now) store.delete(key);
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
  { pattern: "/api/auth", method: "POST", limit: 5, windowMs: 15 * 60 * 1000, keyType: "ip" },

  // Expensive operations - per user
  { pattern: "/api/ai/chat", method: "POST", limit: 30, windowMs: 60 * 60 * 1000, keyType: "user" },
  { pattern: "/api/yolo/run", method: "POST", limit: 5, windowMs: 60 * 60 * 1000, keyType: "user" },
  { pattern: "/api/projects", method: "POST", limit: 10, windowMs: 60 * 60 * 1000, keyType: "user" },
  { pattern: "/api/s3/credentials", method: "POST", limit: 10, windowMs: 60 * 60 * 1000, keyType: "user" },

  // Moderate limits
  { pattern: "/api/takeoff-items", method: "POST", limit: 50, windowMs: 60 * 60 * 1000, keyType: "user" },
  { pattern: "/api/annotations", method: "POST", limit: 200, windowMs: 60 * 60 * 1000, keyType: "user" },

  // Invite requests - tight limit per IP
  { pattern: "/api/invite", method: "POST", limit: 5, windowMs: 15 * 60 * 1000, keyType: "ip" },

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
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const method = request.method;
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  // Only rate limit API routes
  if (pathname.startsWith("/api")) {
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
        return new NextResponse(
          JSON.stringify({
            error: "Too many requests. Please try again later.",
            retryAfter: Math.ceil(rule.windowMs / 1000),
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": String(Math.ceil(rule.windowMs / 1000)),
              ...SECURITY_HEADERS,
            },
          }
        );
      }
    }

    // General API rate limit: 120 req/min per IP
    if (!RATE_RULES.some((r) => pathname.startsWith(r.pattern) && method === r.method)) {
      if (isRateLimited(`rl:api:${ip}`, 120, 60 * 1000)) {
        return new NextResponse(
          JSON.stringify({ error: "Too many requests." }),
          {
            status: 429,
            headers: { "Content-Type": "application/json", ...SECURITY_HEADERS },
          }
        );
      }
    }
  }

  // Add security headers to all responses
  const response = NextResponse.next();
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(key, value);
  }

  return response;
}

export const config = {
  matcher: [
    // Match all API routes and pages, skip static files
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
