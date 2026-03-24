import { db } from "@/lib/db";
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
export async function checkUploadQuota(companyId: number, role: string = "member"): Promise<QuotaCheck> {
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
  const DAILY_LIMIT = 5;
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

/**
 * Check global demo chat quota (shared across all unauthenticated demo users).
 */
export async function checkDemoChatQuota(): Promise<QuotaCheck> {
  const DAILY_LIMIT = 500;
  const result = await db.execute(sql`
    SELECT COUNT(*)::int AS cnt FROM chat_messages cm
    JOIN projects p ON cm.project_id = p.id
    WHERE p.is_demo = true
      AND cm.role = 'user'
      AND cm.created_at > NOW() - INTERVAL '1 day'
  `);
  const current = (result.rows[0] as any)?.cnt || 0;
  if (current >= DAILY_LIMIT) {
    return { allowed: false, message: "Demo chat limit reached for today. Sign up for full access!", current, limit: DAILY_LIMIT };
  }
  return { allowed: true, current, limit: DAILY_LIMIT };
}
