import { db } from "@/lib/db";
import { computeUsage, companies, users } from "@/lib/db/schema";
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
        message: `Company SageMaker page limit reached (${companyUsed}/${company.limit} pages used; this run needs ${pagesToCharge}). Ask your root admin to raise the limit or reset the counter.`,
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
        message: `Your personal SageMaker page limit reached (${userUsed}/${userLimit} pages used; this run needs ${pagesToCharge}). Ask your root admin to raise your limit.`,
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
 * In-memory per-company cooldown for cap-hit alert emails so repeated blocked
 * runs can't spam ROOT_ADMIN_EMAIL (an email-cost / DoS vector). The abuse-event
 * + audit-log entries still fire on every hit (cheap, drive the root badge); only
 * the email is throttled. Per-process state — bounds emails to ~1 per company per
 * window per ECS task, enough to neutralize the spam vector without new schema.
 */
const CAP_ALERT_COOLDOWN_MS = 15 * 60 * 1000;
const lastCapAlertAt = new Map<number, number>();
export function shouldSendCapAlert(companyId: number): boolean {
  const now = Date.now();
  const prev = lastCapAlertAt.get(companyId) ?? 0;
  if (now - prev < CAP_ALERT_COOLDOWN_MS) return false;
  lastCapAlertAt.set(companyId, now);
  return true;
}
