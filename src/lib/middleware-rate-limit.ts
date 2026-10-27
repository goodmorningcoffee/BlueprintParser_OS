/**
 * Process-local middleware rate policy and bounded bucket store.
 *
 * The ECS task-local store is intentionally a launch-scale control, not a
 * distributed quota. Its hard live-entry ceiling fails closed for unseen keys
 * so attacker-selected identities cannot turn the middleware into an unbounded
 * Map. The middleware supplies only a verified user id or trusted ALB IP.
 */

import { rootTwoFactorPending, type RootTwoFactorClaims } from "@/lib/root-two-factor-claims";

interface RateBucket {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateBucket>();
const RATE_LIMIT_STORE_MAX_ENTRIES = 10_000;

export function pruneExpiredRateBuckets(now: number): void {
  for (const [key, bucket] of store) {
    if (bucket.resetAt < now) store.delete(key);
  }
  for (const [key, bucket] of rootParserLaneStore) {
    if (bucket.resetAt < now) rootParserLaneStore.delete(key);
  }
}

export function isRateLimited(
  key: string,
  limit: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  const bucket = store.get(key);

  if (!bucket || bucket.resetAt < now) {
    if (bucket) store.delete(key);
    if (store.size >= RATE_LIMIT_STORE_MAX_ENTRIES) {
      pruneExpiredRateBuckets(now);
    }
    if (store.size >= RATE_LIMIT_STORE_MAX_ENTRIES) return true;
    store.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }

  bucket.count += 1;
  return bucket.count > limit;
}

/** Test-only visibility into cardinality; production code cannot mutate it. */
export function middlewareRateLimitStoreSizeForTest(): number {
  return store.size;
}

export interface RateRule {
  pattern: string;
  method: string;
  limit: number;
  windowMs: number;
  keyType: "ip" | "user" | "ip+path";
  /** Exact path instead of the default subtree-prefix match. */
  exact?: boolean;
}

const UUID_PATH_SEGMENT =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PROJECT_ASSET_TRANSPORT_RE = new RegExp(
  `^/api/project-assets/${UUID_PATH_SEGMENT}/.+$`,
  "i",
);
const PROJECT_PAGE_WINDOW_RE = new RegExp(
  `^/api/projects/${UUID_PATH_SEGMENT}/pages$`,
  "i",
);
const DEMO_PROJECT_PAGE_WINDOW_RE = new RegExp(
  `^/api/demo/projects/${UUID_PATH_SEGMENT}/pages$`,
  "i",
);
const LABEL_ASSET_TRANSPORT_RE = new RegExp(
  `^/api/label-assets/${UUID_PATH_SEGMENT}$`,
  "i",
);

export function isViewerTransportRatePath(
  pathname: string,
  method: string,
): boolean {
  if (
    method === "GET" &&
    (PROJECT_PAGE_WINDOW_RE.test(pathname) ||
      DEMO_PROJECT_PAGE_WINDOW_RE.test(pathname))
  ) {
    return true;
  }
  return (
    (method === "GET" || method === "HEAD") &&
    PROJECT_ASSET_TRANSPORT_RE.test(pathname)
  );
}

export function isLabelAssetTransportRatePath(
  pathname: string,
  method: string,
): boolean {
  return (
    (method === "GET" || method === "HEAD" || method === "OPTIONS") &&
    LABEL_ASSET_TRANSPORT_RE.test(pathname)
  );
}

// [TP-3 WP-3.E, C1-M3] POST /api/projects/<id>/parse-engine/parse runs the parse engine (and, at the
// standard / thorough budgets, crop methods: Python, a paid Textract crop). It is project-scoped, so a
// prefix rule cannot name it and the first-3-segments burst key would lump it with every /api/projects
// call. It is matched by an exact regex (like the page-window rule above), and both its route rule and
// its parser burst bucket are keyed by the rule NAME, so rotating project ids buys a caller nothing.
const PARSE_ENGINE_PARSE_RE = /^\/api\/projects\/[^/]+\/parse-engine\/parse$/i;
export const PARSE_ENGINE_PARSE_RULE_NAME = "parse-engine-parse";
/** The parse-engine parse route: a parser-lane route (middleware `isAbusiveRoute`) with its own rule. */
export function isParseEngineParsePath(pathname: string): boolean {
  return PARSE_ENGINE_PARSE_RE.test(pathname);
}
const PARSE_ENGINE_PARSE_RATE_RULE: RateRule = {
  pattern: PARSE_ENGINE_PARSE_RULE_NAME,
  method: "POST",
  limit: 120,
  windowMs: 60 * 1000,
  keyType: "user",
  exact: true,
};
/** Per-IP burst (per 10 s window) for the parse route: the workspace prefetches the next item, so 5 is too tight. */
export const PARSE_ENGINE_PARSE_BURST_LIMIT = 20;

const VIEWER_TRANSPORT_RATE_RULE: RateRule = {
  pattern: "viewer-transport",
  method: "GET|HEAD",
  limit: 600,
  windowMs: 60 * 1000,
  keyType: "ip",
  exact: true,
};

const LABEL_ASSET_TRANSPORT_RATE_RULE: RateRule = {
  pattern: "label-asset-transport",
  method: "GET|HEAD|OPTIONS",
  limit: 600,
  windowMs: 60 * 1000,
  keyType: "ip",
  exact: true,
};

const RATE_RULES: RateRule[] = [
  {
    pattern: "/api/register",
    method: "POST",
    limit: 3,
    windowMs: 15 * 60 * 1000,
    keyType: "ip",
  },
  {
    pattern: "/api/auth/forgot-password",
    method: "POST",
    limit: 3,
    windowMs: 15 * 60 * 1000,
    keyType: "ip",
  },
  {
    pattern: "/api/auth/reset-password",
    method: "POST",
    limit: 5,
    windowMs: 15 * 60 * 1000,
    keyType: "ip",
  },
  // Sign-in attempts. The failed-login lockout owns password guessing; this bounds how fast one
  // address can feed it (each attempt is a bcrypt compare and a lockout write).
  {
    pattern: "/api/auth/callback/credentials",
    method: "POST",
    limit: 10,
    windowMs: 60 * 1000,
    keyType: "ip",
    exact: true,
  },
  // [2026-10-23] Root 2FA code check: a 6-digit TOTP (±1 step → 3 live codes in a million) or a
  // 50-bit backup code. Keyed by the verified user so a holder of the password-only session cannot
  // guess his way to root; root is never exempt here (ROOT_NEVER_EXEMPT_RULE_PATTERNS).
  {
    pattern: "/api/auth/2fa/verify",
    method: "POST",
    limit: 10,
    windowMs: 15 * 60 * 1000,
    keyType: "user",
    exact: true,
  },
  // [2026-10-25] The other code/password-taking 2FA routes are bounded the same way, so a stolen
  // VERIFIED cookie cannot brute-force a code into /disable and re-enroll its own device (root is
  // never exempt from these either). The persistent per-row lockout ladder backs these buckets.
  { pattern: "/api/auth/2fa/enroll", method: "POST", limit: 5, windowMs: 15 * 60 * 1000, keyType: "user", exact: true },
  { pattern: "/api/auth/2fa/confirm", method: "POST", limit: 5, windowMs: 15 * 60 * 1000, keyType: "user", exact: true },
  { pattern: "/api/auth/2fa/disable", method: "POST", limit: 5, windowMs: 15 * 60 * 1000, keyType: "user", exact: true },
  { pattern: "/api/auth/2fa/backup-codes", method: "POST", limit: 5, windowMs: 15 * 60 * 1000, keyType: "user", exact: true },
  // Public and synchronous: one request can hold the event loop for about a second at its input
  // cap, so the 120/min backstop alone would let one address block most of every minute.
  {
    pattern: "/api/csi/detect",
    method: "POST",
    limit: 20,
    windowMs: 60 * 1000,
    keyType: "ip",
    exact: true,
  },
  {
    pattern: "/api/ai/chat",
    method: "POST",
    limit: 30,
    windowMs: 60 * 60 * 1000,
    keyType: "user",
  },
  // Effectively unlimited on purpose: the real cap on YOLO runs is the daily quota
  // `checkYoloQuota` (10/day/company by default; root-exempt, overridable per user/company in
  // src/lib/quota-overrides.ts), enforced in the yolo service before the model is invoked. This bucket exists only so the path has a named rule rather than falling to the
  // general IP backstop; it is not the abuse control. Neighbouring pattern rules run 3–200.
  {
    pattern: "/api/yolo/run",
    method: "POST",
    limit: 9999,
    windowMs: 60 * 60 * 1000,
    keyType: "user",
  },
  {
    pattern: "/api/projects",
    method: "POST",
    limit: 10,
    windowMs: 60 * 60 * 1000,
    keyType: "user",
    exact: true,
  },
  {
    pattern: "/api/s3/credentials",
    method: "POST",
    limit: 10,
    windowMs: 60 * 60 * 1000,
    keyType: "user",
  },
  {
    pattern: "/api/takeoff-items",
    method: "POST",
    limit: 50,
    windowMs: 60 * 60 * 1000,
    keyType: "user",
  },
  // Keep each annotation mutation in a separately named bucket. Exact matching
  // prevents create, split, and batch-delete from consuming one another's quota.
  {
    pattern: "/api/annotations/split",
    method: "POST",
    limit: 200,
    windowMs: 60 * 60 * 1000,
    keyType: "user",
    exact: true,
  },
  {
    pattern: "/api/annotations/batch-delete",
    method: "POST",
    limit: 100,
    windowMs: 60 * 60 * 1000,
    keyType: "user",
  },
  {
    pattern: "/api/annotations",
    method: "POST",
    limit: 200,
    windowMs: 60 * 60 * 1000,
    keyType: "user",
    exact: true,
  },
  {
    pattern: "/api/invite",
    method: "POST",
    limit: 5,
    windowMs: 15 * 60 * 1000,
    keyType: "ip",
  },
  {
    pattern: "/api/labeling/login",
    method: "GET",
    limit: 10,
    windowMs: 15 * 60 * 1000,
    keyType: "ip",
  },
  {
    pattern: "/api/labeling/create",
    method: "POST",
    limit: 5,
    windowMs: 60 * 60 * 1000,
    keyType: "user",
  },
  {
    pattern: "/api/admin/llm-config/test",
    method: "POST",
    limit: 5,
    windowMs: 60 * 1000,
    keyType: "user",
  },
  {
    pattern: "/api/demo",
    method: "GET",
    limit: 60,
    windowMs: 60 * 1000,
    keyType: "ip",
  },
  {
    pattern: "/api/demo/chat",
    method: "POST",
    limit: 10,
    windowMs: 60 * 1000,
    keyType: "ip",
  },
];

/** SessionProvider GET is the sole exact general-bucket exemption. */
export function isGeneralBucketExempt(
  pathname: string,
  method: string,
): boolean {
  return method === "GET" && pathname === "/api/auth/session";
}

export function findRateRule(
  pathname: string,
  method: string,
): RateRule | undefined {
  if (isViewerTransportRatePath(pathname, method)) {
    return VIEWER_TRANSPORT_RATE_RULE;
  }
  if (isLabelAssetTransportRatePath(pathname, method)) {
    return LABEL_ASSET_TRANSPORT_RATE_RULE;
  }
  if (method === "POST" && isParseEngineParsePath(pathname)) {
    return PARSE_ENGINE_PARSE_RATE_RULE;
  }
  return RATE_RULES.find(
    (rule) =>
      (rule.exact
        ? pathname === rule.pattern
        : pathname.startsWith(rule.pattern)) && method === rule.method,
  );
}

const GENERAL_API_BACKSTOP_LIMIT = 120;
const GENERAL_API_BACKSTOP_WINDOW_MS = 60 * 1000;

export interface IpBackstop {
  keyScope: string;
  limit: number;
  windowMs: number;
}

/** Every non-exempt API admission gets an independently namespaced IP cap. */
export function apiIpBackstopForRule(rule: RateRule | undefined): IpBackstop {
  if (
    rule === VIEWER_TRANSPORT_RATE_RULE ||
    rule === LABEL_ASSET_TRANSPORT_RATE_RULE
  ) {
    return {
      keyScope: `transport:${rule.pattern}`,
      limit: rule.limit,
      windowMs: rule.windowMs,
    };
  }
  return {
    keyScope: "api",
    limit: GENERAL_API_BACKSTOP_LIMIT,
    windowMs: GENERAL_API_BACKSTOP_WINDOW_MS,
  };
}

// ─── Root admin admission (owner ruling 2026-10-21: "root admin exempt from everything") ─────
//
// A root admin is recognised ONLY from the verified session token: getToken() decrypts the
// AUTH_SECRET-encrypted JWE, so neither the isRootAdmin claim nor dbId can be forged by a client.
// A cookie that fails verification yields null here and the caller is treated as anonymous.

/**
 * The verified root admin's user id, or null for everyone else. [2026-10-23] A root login whose
 * TOTP enrollment is active but not yet verified (lib/root-two-factor-claims.ts) is NOT root here.
 */
export function verifiedRootUserId(token: unknown): number | null {
  if (typeof token !== "object" || token === null) return null;
  const claims = token as RootTwoFactorClaims & { dbId?: unknown };
  return claims.isRootAdmin === true &&
    typeof claims.dbId === "number" &&
    Number.isSafeInteger(claims.dbId) &&
    claims.dbId > 0 &&
    !rootTwoFactorPending(claims)
    ? claims.dbId
    : null;
}

// The token's root claim is only a HINT. It was true at the token's last refresh, and a route
// handler's auth() never rewrites the cookie, so a client that never calls GET /api/auth/session
// can hold an unrefreshed root claim for the whole 24 h session after a demotion or deletion.
// So the claim is re-confirmed against users.isRootAdmin (the same read Auth.js runs on every
// session refresh), cached per user for ROOT_CLAIM_RECHECK_MS: after a demotion, a task stops
// exempting that user within this window. A failed read, a missing user or a demoted user all
// mean "not root" — fail closed to today's limits, cached for the same window so a DB outage
// costs at most one read per claimed-root user per window. Only verified root claims reach the
// lookup, so neither anonymous nor non-root callers cause a DB read here.
export const ROOT_CLAIM_RECHECK_MS = 30_000;
const ROOT_CLAIM_CACHE_MAX = 1_000;
// [fix round L2] Keyed by login (user id + the login's 2FA nonce): the lookup also re-checks the
// live verified marker, which is per login, so two logins of one root never share an answer.
const rootClaimCache = new Map<string, { confirmed: Promise<boolean>; checkedAt: number }>();

/** The verified root admin's id, re-confirmed against the database; null for everyone else. */
export async function confirmedRootUserId(
  token: unknown,
  isRootInDatabase: (userId: number, twoFactorNonce: string | null) => Promise<boolean>,
  now: number = Date.now(),
): Promise<number | null> {
  const claimedId = verifiedRootUserId(token);
  if (claimedId === null) return null;
  const rawNonce = (token as { twoFactorNonce?: unknown }).twoFactorNonce;
  const nonce = typeof rawNonce === "string" && rawNonce.length > 0 ? rawNonce : null;
  const cacheKey = `${claimedId}:${nonce ?? ""}`;
  let entry = rootClaimCache.get(cacheKey);
  if (!entry || now - entry.checkedAt >= ROOT_CLAIM_RECHECK_MS || now < entry.checkedAt) {
    if (rootClaimCache.size >= ROOT_CLAIM_CACHE_MAX) rootClaimCache.clear();
    entry = {
      confirmed: Promise.resolve()
        .then(() => isRootInDatabase(claimedId, nonce))
        .then(
          (isRoot) => isRoot === true,
          () => false,
        ),
      checkedAt: now,
    };
    rootClaimCache.set(cacheKey, entry);
  }
  return (await entry.confirmed) ? claimedId : null;
}

// Pre-auth rules stay on for root. A browser holding a root cookie still sends it to sign-in and
// registration, and those rules bound password guessing against EVERY account (each attempt is a
// bcrypt compare) — exempting the cookie holder would hand that throttle to anyone with it.
const ROOT_NEVER_EXEMPT_RULE_PATTERNS: ReadonlySet<string> = new Set([
  "/api/register",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/auth/callback/credentials",
  // A verified root re-proving a code is bounded like everyone else: the rule exists to bound
  // guessing against the root account, and the guesser may hold a root cookie.
  "/api/auth/2fa/verify",
  "/api/auth/2fa/enroll",
  "/api/auth/2fa/confirm",
  "/api/auth/2fa/disable",
  "/api/auth/2fa/backup-codes",
]);

/** Whether a root caller skips this route rule AND the IP backstop for the same request. */
export function isRootExemptRule(rule: RateRule | undefined): boolean {
  return !rule || !ROOT_NEVER_EXEMPT_RULE_PATTERNS.has(rule.pattern);
}

// [TP-1 WP-1.D, K21] Parser burst buckets are keyed by route prefix (`/api/table-parse`), so Guided's
// slider re-proposals (300 ms debounce) used to spend the SAME 5/10 s burst as real table parses, and
// the second breach banned the IP from every parser route for an hour. `/propose` reads stored words
// only (no Lambda, no Python, no Textract, signed-in only), so it gets its own bucket with a ceiling a
// debounced slider cannot reach. A breach of it still escalates exactly like any other parser burst.
export const PARSER_OWN_BURST_BUCKETS: Readonly<Record<string, number>> = {
  "/api/table-parse/propose": 40,
};

/** The burst bucket (route key + per-window limit) a parser request is counted against. */
export function parserBurstBucket(pathname: string, defaultLimit: number): { route: string; limit: number } {
  if (isParseEngineParsePath(pathname)) return { route: PARSE_ENGINE_PARSE_RULE_NAME, limit: PARSE_ENGINE_PARSE_BURST_LIMIT };
  for (const [route, limit] of Object.entries(PARSER_OWN_BURST_BUCKETS)) {
    if (pathname === route || pathname.startsWith(`${route}/`)) return { route, limit };
  }
  return { route: pathname.split("/").slice(0, 3).join("/"), limit: defaultLimit };
}

// The parser routes (symbol-search, shape-parse, table-parse, table-structure, bucket-fill) start
// local Ghostscript/python children on a 4 GB task, and signed-in callers skip the heavy-process
// gate. So root gets a PRIORITY LANE, not unlimited admission: he never touches the IP ban,
// cooldown or IP burst stores (he cannot be banned, by himself or an IP neighbour), and is held
// only to this per-user ceiling with a plain 429 and no escalation. The bound protects memory,
// not money. Keys come from verified root ids only, so this store cannot be grown by an attacker
// and never fails closed on capacity the way the shared store does.
export const ROOT_PARSER_LANE_LIMIT = 30;
export const ROOT_PARSER_LANE_WINDOW_MS = 10_000;
const rootParserLaneStore = new Map<string, RateBucket>();

/** Seconds until the root lane admits again, or 0 when this request is admitted. */
export function rootParserLaneRetryAfter(
  rootUserId: number,
  routePrefix: string,
  now: number = Date.now(),
): number {
  const key = `${rootUserId}:${routePrefix}`;
  const bucket = rootParserLaneStore.get(key);
  if (!bucket || bucket.resetAt < now) {
    rootParserLaneStore.set(key, { count: 1, resetAt: now + ROOT_PARSER_LANE_WINDOW_MS });
    return 0;
  }
  bucket.count += 1;
  if (bucket.count <= ROOT_PARSER_LANE_LIMIT) return 0;
  return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
}
