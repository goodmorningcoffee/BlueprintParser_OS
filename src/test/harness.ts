// [refactor jun12 P0.3] Route characterization harness.
//
// Purpose: call App-Router route handlers DIRECTLY (no HTTP server) against
// the local test database, with auth() mocked but everything else real —
// api-utils' resolveProjectAccess, drizzle, the actual SQL. These tests FREEZE
// today's behavior (including quirks) so the P1 route-shell migration refactors
// against a spec instead of vibes. When P1 deliberately changes a contract
// (e.g. the unified error envelope), the test changes in the SAME commit.
//
// Recipe for a route test file:
//
//   // @vitest-environment node
//   import { describe, it, expect, vi, inject } from "vitest";
//   vi.mock("@/lib/auth", async () => {
//     const { sessionState } = await import("@/test/harness");
//     return { auth: async () => sessionState.current };
//   });
//   import { POST } from "@/app/api/annotations/route";   // AFTER the mock
//   const dbUp = inject("dbUp") as boolean;
//   describe.skipIf(!dbUp)("annotations", () => { ... });
//
// Why mock @/lib/auth and not api-utils: api-utils carries real authz logic
// (tenancy 404s, scope resolution) — that logic is exactly what we're freezing.
// The async-factory + dynamic-import form avoids vi.mock hoisting pitfalls.

import { randomUUID } from "crypto";
import { db } from "@/lib/db";

// vitest ProvidedContext typing for `inject("dbUp")` (set in global-setup.ts)
declare module "vitest" {
  export interface ProvidedContext {
    dbUp: boolean;
  }
}
import { annotations, companies, pages, projects, users } from "@/lib/db/schema";
import type { AuthSession } from "@/lib/api-utils";

// ── session control ─────────────────────────────────────────────────────────
/** Mutable holder read by the auth() mock. Set per-test; null = signed out. */
export const sessionState: { current: AuthSession | null } = { current: null };

export function asUser(u: FixtureUser): void {
  sessionState.current = {
    user: {
      companyId: u.companyId,
      dbId: u.id,
      username: u.username,
      role: u.role,
      canRunModels: u.canRunModels,
      isRootAdmin: u.isRootAdmin,
      email: u.email,
    },
  };
}
export function signedOut(): void {
  sessionState.current = null;
}

// ── fixtures (unique per call → test files stay parallel-safe) ──────────────
const uniq = () => randomUUID().slice(0, 8);

export type FixtureUser = {
  id: number;
  companyId: number;
  username: string;
  email: string;
  role: string;
  canRunModels: boolean;
  isRootAdmin: boolean;
};

export async function createCompany(over: Partial<typeof companies.$inferInsert> = {}) {
  const tag = uniq();
  const [row] = await db
    .insert(companies)
    .values({
      name: `TestCo-${tag}`,
      dataKey: `testco-${tag}`,
      accessKey: `ak-${tag}`,
      emailDomain: `${tag}.test`,
      ...over,
    })
    .returning();
  return row;
}

export async function createUser(
  companyId: number,
  over: Partial<typeof users.$inferInsert> = {},
): Promise<FixtureUser> {
  const tag = uniq();
  const [row] = await db
    .insert(users)
    .values({
      username: `user-${tag}`,
      email: `user-${tag}@test.invalid`,
      companyId,
      ...over,
    })
    .returning();
  return {
    id: row.id,
    companyId: row.companyId,
    username: row.username,
    email: row.email,
    role: row.role,
    canRunModels: row.canRunModels,
    isRootAdmin: row.isRootAdmin,
  };
}

export async function createProject(
  companyId: number,
  authorId: number,
  over: Partial<typeof projects.$inferInsert> = {},
) {
  const tag = uniq();
  const [row] = await db
    .insert(projects)
    .values({
      name: `Project-${tag}`,
      dataUrl: `testco/${tag}`,
      companyId,
      authorId,
      status: "completed",
      numPages: 3,
      ...over,
    })
    .returning();
  return row;
}

export async function createPage(
  projectId: number,
  pageNumber: number,
  over: Partial<typeof pages.$inferInsert> = {},
) {
  const [row] = await db
    .insert(pages)
    .values({ projectId, pageNumber, name: `Page ${pageNumber}`, ...over })
    .returning();
  return row;
}

/** One call = company + member user + completed project (the common base). */
export async function createWorld(projectOver: Partial<typeof projects.$inferInsert> = {}) {
  const company = await createCompany();
  const user = await createUser(company.id);
  const project = await createProject(company.id, user.id, projectOver);
  return { company, user, project };
}

export async function annotationsFor(projectId: number) {
  const { eq } = await import("drizzle-orm");
  return db.select().from(annotations).where(eq(annotations.projectId, projectId));
}

// ── request builders ─────────────────────────────────────────────────────────
export function makeReq(
  path: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Request {
  const { method = "POST", body, headers = {} } = opts;
  return new Request(`http://test.local${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json", ...headers } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** App-Router dynamic params arrive as a Promise in Next 15+/16. */
export function params<T extends Record<string, string>>(p: T): { params: Promise<T> } {
  return { params: Promise.resolve(p) };
}

export async function readJson(res: Response): Promise<{ status: number; body: any }> {
  return { status: res.status, body: await res.json() };
}
