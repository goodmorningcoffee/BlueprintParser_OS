import { db } from "@/lib/db";
import { computeUsage, companies, users, runtimeCounters } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";

export type ComputeResource = "sagemaker" | "textract" | "lambda_cv";

export interface PageQuotaCheck {
  allowed: boolean;
  message?: string;
  capHit?: "company" | "user";
  companyUsed: number;
  companyLimit: number;
  userUsed: number | null;
  userLimit: number | null;
}

export interface ReserveResult extends PageQuotaCheck {
  /** compute_usage row id created when allowed — pass to stamp/release. */
  reservationId?: number;
}

/**
 * Atomically check the two-level SageMaker page cap and, if allowed, reserve the
 * pages by inserting a compute_usage row — all inside one transaction guarded by
 * a per-company advisory lock. This closes the check-then-charge TOCTOU: two
 * concurrent runs for the same company serialize on the lock, so the second sees
 * the first's reservation and cannot slip past the cap.
 *
 * The reservation is created BEFORE the SageMaker job starts. Callers MUST:
 *   - releaseReservation(reservationId) if the job fails to start (so a job that
 *     never ran isn't charged), and
 *   - stampReservationJob(reservationId, jobName) on success (attach the jobId).
 *
 * Company net cap takes precedence; blocks on whichever cap is hit first. The
 * per-user sub-cap is only enforced when users.sagemakerPageLimit is non-null.
 */
export async function reserveSagemakerPages(
  companyId: number,
  userId: number,
  projectId: number | null,
  pagesToCharge: number
): Promise<ReserveResult> {
  return db.transaction(async (tx) => {
    // Serialize concurrent SageMaker runs for this company; auto-released on commit.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${companyId})`);

    const [company] = await tx
      .select({ limit: companies.sagemakerPageLimit, windowStart: companies.usageWindowStart })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);

    if (!company) {
      return { allowed: false, message: "Company not found", companyUsed: 0, companyLimit: 0, userUsed: null, userLimit: null };
    }

    const companyRes = company.windowStart
      ? await tx.execute(sql`SELECT COALESCE(SUM(pages), 0)::int AS used FROM compute_usage WHERE company_id = ${companyId} AND resource = 'sagemaker' AND created_at >= ${company.windowStart}`)
      : await tx.execute(sql`SELECT COALESCE(SUM(pages), 0)::int AS used FROM compute_usage WHERE company_id = ${companyId} AND resource = 'sagemaker'`);
    const companyUsed = (companyRes.rows[0] as { used?: number } | undefined)?.used ?? 0;

    // Per-user sub-cap — only enforced when the user has an explicit limit set.
    const [user] = await tx
      .select({ limit: users.sagemakerPageLimit, windowStart: users.usageWindowStart })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const userLimit: number | null = user?.limit ?? null;
    let userUsed: number | null = null;
    if (userLimit !== null) {
      const userRes = user?.windowStart
        ? await tx.execute(sql`SELECT COALESCE(SUM(pages), 0)::int AS used FROM compute_usage WHERE user_id = ${userId} AND resource = 'sagemaker' AND created_at >= ${user.windowStart}`)
        : await tx.execute(sql`SELECT COALESCE(SUM(pages), 0)::int AS used FROM compute_usage WHERE user_id = ${userId} AND resource = 'sagemaker'`);
      userUsed = (userRes.rows[0] as { used?: number } | undefined)?.used ?? 0;
    }

    if (companyUsed + pagesToCharge > company.limit) {
      return {
        allowed: false,
        capHit: "company",
        message: `YOLO limit reached for your company (${companyUsed}/${company.limit} pages used; this run needs ${pagesToCharge}). Request a limit increase from root_admin.`,
        companyUsed,
        companyLimit: company.limit,
        userUsed,
        userLimit,
      };
    }
    if (userLimit !== null && userUsed !== null && userUsed + pagesToCharge > userLimit) {
      return {
        allowed: false,
        capHit: "user",
        message: `YOLO limit reached for your account (${userUsed}/${userLimit} pages used; this run needs ${pagesToCharge}). Request a limit increase from root_admin.`,
        companyUsed,
        companyLimit: company.limit,
        userUsed,
        userLimit,
      };
    }

    const [row] = await tx
      .insert(computeUsage)
      .values({ companyId, userId, projectId, resource: "sagemaker", pages: pagesToCharge })
      .returning({ id: computeUsage.id });

    return {
      allowed: true,
      reservationId: row.id,
      companyUsed,
      companyLimit: company.limit,
      userUsed,
      userLimit,
    };
  });
}

/**
 * [2026-10-25 root hardening] The company Textract page cap (companies.textract_page_limit, set by
 * root in the Usage tab) was written and displayed but never read on a spend path. This is the
 * read: pages charged under resource 'textract' since the company's usage window. Callers refuse
 * (non-root) when `used + pages` would exceed the limit, and record every live Textract call —
 * the upload pipeline's per-page Textract through processingWebhook, the table-parse live crop,
 * and the root-only page rerun — so the Usage tab's "textract used" stops reading zero.
 */
export async function checkTextractCap(
  companyId: number,
  pages: number,
): Promise<{ allowed: boolean; message?: string; companyUsed: number; companyLimit: number }> {
  const [company] = await db
    .select({ limit: companies.textractPageLimit, windowStart: companies.usageWindowStart })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  if (!company) return { allowed: false, message: "Company not found", companyUsed: 0, companyLimit: 0 };
  const res = company.windowStart
    ? await db.execute(sql`SELECT COALESCE(SUM(pages), 0)::int AS used FROM compute_usage WHERE company_id = ${companyId} AND resource = 'textract' AND created_at >= ${company.windowStart}`)
    : await db.execute(sql`SELECT COALESCE(SUM(pages), 0)::int AS used FROM compute_usage WHERE company_id = ${companyId} AND resource = 'textract'`);
  const companyUsed = (res.rows[0] as { used?: number } | undefined)?.used ?? 0;
  if (companyUsed + pages > company.limit) {
    return {
      allowed: false,
      message: `Textract page limit reached for your company (${companyUsed}/${company.limit} pages used). Request a limit increase from root_admin.`,
      companyUsed,
      companyLimit: company.limit,
    };
  }
  return { allowed: true, companyUsed, companyLimit: company.limit };
}

/** Roll back a reservation when the job failed to start (so it isn't charged). */
export async function releaseReservation(reservationId: number): Promise<void> {
  await db.delete(computeUsage).where(eq(computeUsage.id, reservationId));
}

/** Attach the SageMaker job name to a reservation row after the job starts. */
export async function stampReservationJob(reservationId: number, jobId: string): Promise<void> {
  await db.update(computeUsage).set({ jobId }).where(eq(computeUsage.id, reservationId));
}

/**
 * Append a row to the compute_usage ledger directly (no cap check). Used for the
 * root-admin bypass path and for future Textract / Lambda CV metering. Awaited;
 * callers should wrap in try/catch so a ledger hiccup never fails a started job.
 */
export async function recordComputeUsage(opts: {
  companyId: number;
  userId?: number | null;
  projectId?: number | null;
  resource: ComputeResource;
  pages: number;
  jobId?: string | null;
}): Promise<void> {
  await db.insert(computeUsage).values({
    companyId: opts.companyId,
    userId: opts.userId ?? null,
    projectId: opts.projectId ?? null,
    resource: opts.resource,
    pages: opts.pages,
    jobId: opts.jobId ?? null,
  });
}

/**
 * Per-company cooldown for cap-hit alert emails so repeated blocked runs can't
 * spam ROOT_ADMIN_EMAIL (an email-cost / DoS vector). The abuse-event + audit-log
 * entries still fire on every hit (cheap, drive the root badge); only the email
 * is throttled.
 *
 * [refactor jul23 P5.4-C] Moved from a per-ECS-task in-memory Map to the shared
 * `runtime_counters` table (scope 'cap_alert', key = companyId), so the whole
 * cluster — not each task — sends at most one email per company per 15m window.
 * One single upsert (one round-trip): a fresh/expired window resets count to 1
 * and this call "claims" the send; a live window increments (count > 1) and
 * returns false. Now-instant threaded from JS so the fixed window is testable.
 */
const CAP_ALERT_COOLDOWN_MS = 15 * 60 * 1000;
export async function shouldSendCapAlert(companyId: number): Promise<boolean> {
  const now = Date.now();
  const nowTs = sql`to_timestamp(${now}::double precision / 1000)`;
  const windowTs = sql`to_timestamp(${now}::double precision / 1000) + (${CAP_ALERT_COOLDOWN_MS} * interval '1 millisecond')`;
  // [P5.4-C security-policy] drizzle builder (statically-resolvable runtimeCounters)
  // rather than db.execute(sql`INSERT…`) — the checker forbids unprovable dynamic
  // raw-SQL mutations. Window value-SQL verbatim from the prior raw statement.
  const res = await db
    .insert(runtimeCounters)
    .values({ scope: "cap_alert", key: String(companyId), count: 1, resetAt: windowTs })
    .onConflictDoUpdate({
      target: [runtimeCounters.scope, runtimeCounters.key],
      set: {
        count: sql`CASE WHEN ${runtimeCounters.resetAt} < ${nowTs} THEN 1 ELSE ${runtimeCounters.count} + 1 END`,
        resetAt: sql`CASE WHEN ${runtimeCounters.resetAt} < ${nowTs} THEN ${windowTs} ELSE ${runtimeCounters.resetAt} END`,
      },
    })
    .returning({ count: runtimeCounters.count });
  const count = res[0]?.count ?? 0;
  // count === 1 means this call opened a fresh window → send exactly one email.
  return count === 1;
}

/**
 * Atomically add one to a cluster-wide daily counter and return the new count.
 * Row: scope = `scope`, key = the UTC date, so each day starts from zero; `resetAt` (24 h out)
 * exists for the janitor's TTL sweep. Same single-upsert shape as shouldSendCapAlert above.
 */
const DAILY_COUNTER_WINDOW_MS = 24 * 60 * 60 * 1000;
export async function consumeDailyCounter(scope: string): Promise<number> {
  const now = Date.now();
  const nowTs = sql`to_timestamp(${now}::double precision / 1000)`;
  const windowTs = sql`to_timestamp(${now}::double precision / 1000) + (${DAILY_COUNTER_WINDOW_MS} * interval '1 millisecond')`;
  const res = await db
    .insert(runtimeCounters)
    .values({ scope, key: new Date(now).toISOString().slice(0, 10), count: 1, resetAt: windowTs })
    .onConflictDoUpdate({
      target: [runtimeCounters.scope, runtimeCounters.key],
      set: {
        count: sql`CASE WHEN ${runtimeCounters.resetAt} < ${nowTs} THEN 1 ELSE ${runtimeCounters.count} + 1 END`,
        resetAt: sql`CASE WHEN ${runtimeCounters.resetAt} < ${nowTs} THEN ${windowTs} ELSE ${runtimeCounters.resetAt} END`,
      },
    })
    .returning({ count: runtimeCounters.count });
  return res[0]?.count ?? 0;
}
