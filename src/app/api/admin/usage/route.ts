import { NextResponse } from "next/server";
import { requireRootAdmin } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { companies, users } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";

/**
 * Root-only compute-usage dashboard data. Aggregates the compute_usage ledger
 * per company (SageMaker + Textract) and per user (SageMaker sub-cap), each
 * summed since that row's own usageWindowStart anchor.
 */
export async function GET() {
  const { error } = await requireRootAdmin();
  if (error) return error;

  const companyRows = await db.execute(sql`
    SELECT c.id,
           c.name,
           c.sagemaker_page_limit AS sagemaker_limit,
           c.textract_page_limit  AS textract_limit,
           c.usage_reset_interval AS reset_interval,
           c.usage_window_start   AS window_start,
           COALESCE(SUM(cu.pages) FILTER (
             WHERE cu.resource = 'sagemaker'
               AND (c.usage_window_start IS NULL OR cu.created_at >= c.usage_window_start)
           ), 0)::int AS sagemaker_used,
           COALESCE(SUM(cu.pages) FILTER (
             WHERE cu.resource = 'textract'
               AND (c.usage_window_start IS NULL OR cu.created_at >= c.usage_window_start)
           ), 0)::int AS textract_used
    FROM companies c
    LEFT JOIN compute_usage cu ON cu.company_id = c.id
    GROUP BY c.id
    ORDER BY c.name
  `);

  const userRows = await db.execute(sql`
    SELECT u.id,
           u.username,
           u.email,
           u.company_id,
           u.sagemaker_page_limit AS sagemaker_limit,
           u.usage_window_start   AS window_start,
           COALESCE(SUM(cu.pages) FILTER (
             WHERE cu.resource = 'sagemaker'
               AND (u.usage_window_start IS NULL OR cu.created_at >= u.usage_window_start)
           ), 0)::int AS sagemaker_used
    FROM users u
    LEFT JOIN compute_usage cu ON cu.user_id = u.id
    GROUP BY u.id
    ORDER BY u.company_id, u.username
  `);

  return NextResponse.json({
    companies: (companyRows.rows as Record<string, unknown>[]).map((r) => ({
      id: r.id,
      name: r.name,
      sagemakerLimit: r.sagemaker_limit,
      sagemakerUsed: r.sagemaker_used,
      textractLimit: r.textract_limit,
      textractUsed: r.textract_used,
      resetInterval: r.reset_interval,
      windowStart: r.window_start,
    })),
    users: (userRows.rows as Record<string, unknown>[]).map((r) => ({
      id: r.id,
      username: r.username,
      email: r.email,
      companyId: r.company_id,
      sagemakerLimit: r.sagemaker_limit, // null = governed only by company pool
      sagemakerUsed: r.sagemaker_used,
      windowStart: r.window_start,
    })),
  });
}

/**
 * Root-only mutations: raise/lower a limit, or reset a counter (advance the
 * window anchor so used → 0). Body:
 *   { target: 'company'|'user', id: number, action, value? }
 * Actions: 'setSagemakerLimit' | 'setTextractLimit' (company only) | 'reset'.
 * For a user 'setSagemakerLimit', value === null clears the sub-cap.
 */
export async function PUT(req: Request) {
  const { error } = await requireRootAdmin();
  if (error) return error;

  const body = await req.json().catch(() => ({}));
  const target = body?.target;
  const id = Number(body?.id);
  const action = body?.action;

  if ((target !== "company" && target !== "user") || !Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "target ('company'|'user') and a numeric id are required" }, { status: 400 });
  }

  if (action === "reset") {
    if (target === "company") {
      await db.update(companies).set({ usageWindowStart: new Date() }).where(eq(companies.id, id));
    } else {
      await db.update(users).set({ usageWindowStart: new Date() }).where(eq(users.id, id));
    }
    return NextResponse.json({ success: true });
  }

  if (target === "company" && (action === "setSagemakerLimit" || action === "setTextractLimit")) {
    const value = Number(body?.value);
    // Postgres int4 max — reject out-of-range before it 500s at the DB layer.
    if (!Number.isInteger(value) || value < 0 || value > 2147483647) {
      return NextResponse.json({ error: "value must be an integer between 0 and 2147483647" }, { status: 400 });
    }
    if (action === "setSagemakerLimit") {
      await db.update(companies).set({ sagemakerPageLimit: value }).where(eq(companies.id, id));
    } else {
      await db.update(companies).set({ textractPageLimit: value }).where(eq(companies.id, id));
    }
    return NextResponse.json({ success: true });
  }

  if (target === "user" && action === "setSagemakerLimit") {
    const raw = body?.value;
    let value: number | null;
    if (raw === null || raw === undefined || raw === "") {
      value = null; // clear the per-user sub-cap (governed by company pool)
    } else {
      value = Number(raw);
      if (!Number.isInteger(value) || value < 0 || value > 2147483647) {
        return NextResponse.json({ error: "value must be an integer between 0 and 2147483647, or null" }, { status: 400 });
      }
    }
    await db.update(users).set({ sagemakerPageLimit: value }).where(eq(users.id, id));
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "Unknown or invalid action for target" }, { status: 400 });
}
