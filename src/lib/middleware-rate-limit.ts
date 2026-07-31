/**
 * Process-local middleware rate policy and bounded bucket store.
 *
 * The ECS task-local store is intentionally a launch-scale control, not a
 * distributed quota. Its hard live-entry ceiling fails closed for unseen keys
 * so attacker-selected identities cannot turn the middleware into an unbounded
 * Map. The middleware supplies only a verified user id or trusted ALB IP.
 */

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
  // No blanket auth POST limit: per-email failed-login lockout owns password
  // abuse, while the general IP backstop below covers request floods.
  {
    pattern: "/api/ai/chat",
    method: "POST",
    limit: 30,
    windowMs: 60 * 60 * 1000,
    keyType: "user",
  },
  // Effectively unlimited on purpose: the real cap on YOLO runs is the daily quota
  // `checkYoloQuota` (10/day/company), enforced in the yolo service before the model is
  // invoked. This bucket exists only so the path has a named rule rather than falling to the
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
