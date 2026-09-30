import { db } from "@/lib/db";
import { consumeDailyCounter } from "@/lib/compute-usage";
import { sql } from "drizzle-orm";

interface QuotaCheck {
  allowed: boolean;
  message?: string;
  current?: number;
  limit?: number;
}

/**
 * Check if a company has exceeded its daily upload quota.
 */
export async function checkUploadQuota(companyId: number, role: string = "member", isRootAdmin: boolean = false): Promise<QuotaCheck> {
  if (isRootAdmin) return { allowed: true };
  const DAILY_LIMIT = role === "admin" ? 10 : 3;
  const result = await db.execute(sql`
    SELECT COUNT(*)::int AS cnt FROM projects
    WHERE company_id = ${companyId}
      AND created_at > NOW() - INTERVAL '1 day'
  `);
  const current = (result.rows[0] as any)?.cnt || 0;
  if (current >= DAILY_LIMIT) {
    return { allowed: false, message: `Daily upload limit reached (${DAILY_LIMIT}/day)`, current, limit: DAILY_LIMIT };
  }
  return { allowed: true, current, limit: DAILY_LIMIT };
}

/**
 * Check if a company has exceeded its daily YOLO job quota.
 */
export async function checkYoloQuota(companyId: number): Promise<QuotaCheck> {
  const DAILY_LIMIT = 10;
  const result = await db.execute(sql`
    SELECT COUNT(*)::int AS cnt FROM processing_jobs pj
    JOIN projects p ON pj.project_id = p.id
    WHERE p.company_id = ${companyId}
      AND pj.model_config IS NOT NULL
      AND pj.started_at > NOW() - INTERVAL '1 day'
  `);
  const current = (result.rows[0] as any)?.cnt || 0;
  if (current >= DAILY_LIMIT) {
    return { allowed: false, message: `Daily YOLO job limit reached (${DAILY_LIMIT}/day)`, current, limit: DAILY_LIMIT };
  }
  return { allowed: true, current, limit: DAILY_LIMIT };
}

/**
 * Check if a company has exceeded its daily chat message quota.
 * Per-company (not per-user) to prevent cost multiplication via multiple accounts.
 */
export async function checkChatQuota(companyId: number): Promise<QuotaCheck> {
  const DAILY_LIMIT = 200;
  const result = await db.execute(sql`
    SELECT COUNT(*)::int AS cnt FROM chat_messages cm
    JOIN projects p ON cm.project_id = p.id
    WHERE p.company_id = ${companyId}
      AND cm.role = 'user'
      AND cm.created_at > NOW() - INTERVAL '1 day'
  `);
  const current = (result.rows[0] as any)?.cnt || 0;
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
 */
export async function checkDemoChatQuota(): Promise<QuotaCheck> {
  const current = await consumeDailyCounter("demo_chat");
  if (current > DEMO_CHAT_DAILY_LIMIT) {
    return { allowed: false, message: "Demo chat limit reached for today. Sign up for full access!", current, limit: DEMO_CHAT_DAILY_LIMIT };
  }
  return { allowed: true, current, limit: DEMO_CHAT_DAILY_LIMIT };
}
