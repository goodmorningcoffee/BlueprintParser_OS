// [refactor jul6 S040] ADMIN B5 write-cluster — usage (GET compute dashboard + PUT limit/
// reset mutations) + projects (GET cross-company god-view), folded from the legacy routes
// (git show 4787e3d:src/app/api/admin/{usage,projects}/route.ts at the freeze). Char:
// __tests__/admin-usage.route.test.ts (UGET/UPUT/PROJ).
//
// All 3 handlers are requireRootAdmin (root cross-company; the shell provides auth:"root").
// None use session.user beyond the auth gate → the handlers take only what they read.
// Sanctioned diffs:
//   • A — flat auth errors → envelope; the usage-PUT 400 validation literals stay
//     byte-verbatim here as ApiError("VALIDATION", ...).
//   • E — usage PUT's graceful `req.json().catch(()=>({}))` is subsumed by the shell
//     raw-parse: a malformed body now → 400 BAD_REQUEST "Invalid JSON body" (was {} →
//     "target ... required"; both 400, message/code drift).
//   • NO B — neither route had a catch-500 literal; unexpected errors (raw-SQL/db) propagate
//     to the shell's generic INTERNAL 500 (inherent defineRoute property).
// The 2 raw-SQL aggregates, the int4 clamp, the null-clear sub-cap semantics, and the
// god-view join are ported verbatim.

import { db } from "@/lib/db";
import { companies, users, projects } from "@/lib/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { ApiError } from "@/server/api/envelope";
import { audit } from "@/lib/audit";
import type { AuthSession } from "@/lib/api-utils";

// ── usage GET ─────────────────────────────────────────────────────────────────

export async function getUsage(): Promise<unknown> {
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

  return {
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
  };
}

// ── usage PUT ─────────────────────────────────────────────────────────────────

export async function updateUsage(rawBody: Record<string, unknown>, session: AuthSession): Promise<unknown> {
  const body = rawBody as { target?: unknown; id?: unknown; action?: unknown; value?: unknown };
  const target = body?.target;
  const id = Number(body?.id);
  const action = body?.action;

  if ((target !== "company" && target !== "user") || !Number.isInteger(id) || id <= 0) {
    throw new ApiError("VALIDATION", "target ('company'|'user') and a numeric id are required");
  }
  // [2026-10-25] Every page-limit / window change is a root money decision: one audit row each,
  // with the value it replaced.
  const before = target === "company"
    ? (await db.select({ sagemaker: companies.sagemakerPageLimit, textract: companies.textractPageLimit, windowStart: companies.usageWindowStart }).from(companies).where(eq(companies.id, id)).limit(1))[0]
    : (await db.select({ sagemaker: users.sagemakerPageLimit, windowStart: users.usageWindowStart }).from(users).where(eq(users.id, id)).limit(1))[0];
  const record = (after: Record<string, unknown>) =>
    audit("usage_limit_changed", { userId: session.user.dbId, companyId: session.user.companyId, details: { target, id, action, before: before ?? null, after } });

  if (action === "reset") {
    const windowStart = new Date();
    if (target === "company") {
      await db.update(companies).set({ usageWindowStart: windowStart }).where(eq(companies.id, id));
    } else {
      await db.update(users).set({ usageWindowStart: windowStart }).where(eq(users.id, id));
    }
    record({ windowStart });
    return { success: true };
  }

  if (target === "company" && (action === "setSagemakerLimit" || action === "setTextractLimit")) {
    const value = Number(body?.value);
    // Postgres int4 max — reject out-of-range before it 500s at the DB layer.
    if (!Number.isInteger(value) || value < 0 || value > 2147483647) {
      throw new ApiError("VALIDATION", "value must be an integer between 0 and 2147483647");
    }
    if (action === "setSagemakerLimit") {
      await db.update(companies).set({ sagemakerPageLimit: value }).where(eq(companies.id, id));
    } else {
      await db.update(companies).set({ textractPageLimit: value }).where(eq(companies.id, id));
    }
    record({ [action === "setSagemakerLimit" ? "sagemaker" : "textract"]: value });
    return { success: true };
  }

  if (target === "user" && action === "setSagemakerLimit") {
    const raw = body?.value;
    let value: number | null;
    if (raw === null || raw === undefined || raw === "") {
      value = null; // clear the per-user sub-cap (governed by company pool)
    } else {
      value = Number(raw);
      if (!Number.isInteger(value) || value < 0 || value > 2147483647) {
        throw new ApiError("VALIDATION", "value must be an integer between 0 and 2147483647, or null");
      }
    }
    await db.update(users).set({ sagemakerPageLimit: value }).where(eq(users.id, id));
    record({ sagemaker: value });
    return { success: true };
  }

  throw new ApiError("VALIDATION", "Unknown or invalid action for target");
}

// ── projects GET (cross-company god-view) ─────────────────────────────────────

export async function getAdminProjects(): Promise<unknown> {
  const rows = await db
    .select({
      id: projects.publicId,
      name: projects.name,
      status: projects.status,
      numPages: projects.numPages,
      createdAt: projects.createdAt,
      companyId: projects.companyId,
      companyName: companies.name,
      author: users.username,
    })
    .from(projects)
    .innerJoin(companies, eq(companies.id, projects.companyId))
    .leftJoin(users, eq(users.id, projects.authorId))
    .orderBy(desc(projects.createdAt))
    .limit(1000);

  return { projects: rows };
}
