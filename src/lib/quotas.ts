import { db } from "@/lib/db";
import { consumeDailyCounter } from "@/lib/compute-usage";
import { sql } from "drizzle-orm";
import {
  QUOTA_DEFAULTS,
  QUOTA_OVERRIDES_KEY,
  emptyQuotaOverrides,
  parseQuotaOverrides,
  resolveQuotaLimit,
  type QuotaOverrides,
} from "@/lib/quota-overrides";

interface QuotaCheck {
  allowed: boolean;
  message?: string;
  current?: number;
  limit?: number;
}

// Owner ruling 2026-10-21: a verified root admin is exempt from every quota here, and root can set
// per-user / per-company limits (src/lib/quota-overrides.ts holds the precedence). Every check
// below short-circuits for root BEFORE any read, so root traffic neither queries nor consumes.
// Non-root callers with no override get exactly the limits, messages and shapes that shipped.

/** Request-path read of the overrides document. A missing row, a malformed value or a failed read
 *  all mean "no overrides" — this never throws, so overrides can only fall back to the defaults. */
async function loadQuotaOverrides(): Promise<QuotaOverrides> {
  try {
    const result = await db.execute(sql`
      SELECT value FROM app_settings WHERE key = ${QUOTA_OVERRIDES_KEY} LIMIT 1
    `);
    return parseQuotaOverrides((result.rows[0] as { value?: unknown } | undefined)?.value);
  } catch {
    return emptyQuotaOverrides();
  }
}

function countOf(result: { rows: unknown[] }): number {
  return (result.rows[0] as { cnt?: number } | undefined)?.cnt || 0;
}

/**
 * Check if a company has exceeded its daily upload quota.
 *
 * Counting basis: the company's projects in the last 24 h (as shipped). When the limit comes from a
 * PER-USER override, the count is that user's own projects instead — projects.author_id is NOT NULL,
 * so the attribution exists without a schema change.
 */
export async function checkUploadQuota(
  companyId: number,
  role: string = "member",
  isRootAdmin: boolean = false,
  userId?: number | null,
): Promise<QuotaCheck> {
  if (isRootAdmin) return { allowed: true };
  const resolved = resolveQuotaLimit(
    "uploadsPerDay",
    role === "admin" ? QUOTA_DEFAULTS.uploadsPerDay.admin : QUOTA_DEFAULTS.uploadsPerDay.member,
    { companyId, userId },
    await loadQuotaOverrides(),
  );
  if (resolved.source === "root" || resolved.limit === null) return { allowed: true };
  const DAILY_LIMIT = resolved.limit;
  const result = resolved.source === "user"
    ? await db.execute(sql`
    SELECT COUNT(*)::int AS cnt FROM projects
    WHERE author_id = ${userId}
      AND created_at > NOW() - INTERVAL '1 day'
  `)
    : await db.execute(sql`
    SELECT COUNT(*)::int AS cnt FROM projects
    WHERE company_id = ${companyId}
      AND created_at > NOW() - INTERVAL '1 day'
  `);
  const current = countOf(result);
  if (current >= DAILY_LIMIT) {
    return { allowed: false, message: `Daily upload limit reached (${DAILY_LIMIT}/day)`, current, limit: DAILY_LIMIT };
  }
  return { allowed: true, current, limit: DAILY_LIMIT };
}

/**
 * Check if a company has exceeded its daily YOLO job quota.
 *
 * Counting basis: ALWAYS the company's jobs. processing_jobs has no user column, so a per-user
 * override changes only the LIMIT that user is held to against the company-wide count.
 */
export async function checkYoloQuota(
  companyId: number,
  isRootAdmin: boolean = false,
  userId?: number | null,
): Promise<QuotaCheck> {
  if (isRootAdmin) return { allowed: true };
  const resolved = resolveQuotaLimit(
    "yoloJobsPerDay",
    QUOTA_DEFAULTS.yoloJobsPerDay,
    { companyId, userId },
    await loadQuotaOverrides(),
  );
  if (resolved.source === "root" || resolved.limit === null) return { allowed: true };
  const DAILY_LIMIT = resolved.limit;
  const result = await db.execute(sql`
    SELECT COUNT(*)::int AS cnt FROM processing_jobs pj
    JOIN projects p ON pj.project_id = p.id
    WHERE p.company_id = ${companyId}
      AND pj.model_config IS NOT NULL
      AND pj.started_at > NOW() - INTERVAL '1 day'
  `);
  const current = countOf(result);
  if (current >= DAILY_LIMIT) {
    return { allowed: false, message: `Daily YOLO job limit reached (${DAILY_LIMIT}/day)`, current, limit: DAILY_LIMIT };
  }
  return { allowed: true, current, limit: DAILY_LIMIT };
}

/**
 * Check if a company has exceeded its daily chat message quota.
 * Per-company (not per-user) to prevent cost multiplication via multiple accounts.
 *
 * Counting basis: the company's user messages (as shipped). When the limit comes from a PER-USER
 * override, the count is that user's own messages (chat_messages.user_id, written by scoped chat;
 * global chat persists nothing, exactly as before).
 */
export async function checkChatQuota(
  companyId: number,
  isRootAdmin: boolean = false,
  userId?: number | null,
): Promise<QuotaCheck> {
  if (isRootAdmin) return { allowed: true };
  const resolved = resolveQuotaLimit(
    "chatMessagesPerDay",
    QUOTA_DEFAULTS.chatMessagesPerDay,
    { companyId, userId },
    await loadQuotaOverrides(),
  );
  if (resolved.source === "root" || resolved.limit === null) return { allowed: true };
  const DAILY_LIMIT = resolved.limit;
  const result = resolved.source === "user"
    ? await db.execute(sql`
    SELECT COUNT(*)::int AS cnt FROM chat_messages cm
    WHERE cm.user_id = ${userId}
      AND cm.role = 'user'
      AND cm.created_at > NOW() - INTERVAL '1 day'
  `)
    : await db.execute(sql`
    SELECT COUNT(*)::int AS cnt FROM chat_messages cm
    JOIN projects p ON cm.project_id = p.id
    WHERE p.company_id = ${companyId}
      AND cm.role = 'user'
      AND cm.created_at > NOW() - INTERVAL '1 day'
  `);
  const current = countOf(result);
  if (current >= DAILY_LIMIT) {
    return { allowed: false, message: `Daily chat limit reached (${DAILY_LIMIT}/day for your organization)`, current, limit: DAILY_LIMIT };
  }
  return { allowed: true, current, limit: DAILY_LIMIT };
}

/** Shared across every anonymous demo caller; the only thing between them and the LLM bill. */
export const DEMO_CHAT_DAILY_LIMIT = 500;

/**
 * Consume one unit of the global demo chat quota (shared across all unauthenticated demo users).
 *
 * Counts REQUESTS in `runtime_counters` (scope 'demo_chat', key = UTC date) via one atomic upsert.
 * It used to count `chat_messages` rows on demo projects — rows that are never written (demo chat
 * is no-persist, and a DB trigger forbids the insert), so the cap could not fire. Call this
 * immediately before the provider call, after every cheaper refusal: each call consumes a unit.
 *
 * A root admin neither checks nor consumes (owner ruling 2026-10-21), so the owner's own testing
 * cannot drain the visitors' pool. Overrides do not apply: this pool belongs to nobody.
 */
export async function checkDemoChatQuota(isRootAdmin: boolean = false): Promise<QuotaCheck> {
  if (isRootAdmin) return { allowed: true };
  const current = await consumeDailyCounter("demo_chat");
  if (current > DEMO_CHAT_DAILY_LIMIT) {
    return { allowed: false, message: "Demo chat limit reached for today. Sign up for full access!", current, limit: DEMO_CHAT_DAILY_LIMIT };
  }
  return { allowed: true, current, limit: DEMO_CHAT_DAILY_LIMIT };
}
