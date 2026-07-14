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
import { eq as drizzleEq, sql } from "drizzle-orm";
import { db } from "@/lib/db";

// vitest ProvidedContext typing for `inject("dbUp")` (set in global-setup.ts)
declare module "vitest" {
  export interface ProvidedContext {
    dbUp: boolean;
  }
}
import {
  annotations,
  companies,
  labelingSessions,
  labelStudioProjectIntents,
  pages,
  projects,
  users,
} from "@/lib/db/schema";
import type { AuthSession } from "@/lib/api-utils";
import { PROJECT_UPLOAD_PUBLICATION_FENCE_SECONDS } from "@/lib/project-upload-authority";

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
const fixtureCompanyDataKeys = new Map<number, string>();

export type FixtureUser = {
  id: number;
  companyId: number;
  username: string;
  email: string;
  role: string;
  canRunModels: boolean;
  isRootAdmin: boolean;
};

export async function createCompany(
  over: Partial<typeof companies.$inferInsert> = {},
) {
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
  fixtureCompanyDataKeys.set(row.id, row.dataKey);
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
  let companyDataKey = fixtureCompanyDataKeys.get(companyId);
  if (!companyDataKey) {
    const [company] = await db
      .select({ dataKey: companies.dataKey })
      .from(companies)
      .where(drizzleEq(companies.id, companyId))
      .limit(1);
    if (!company) throw new Error(`Fixture company ${companyId} not found`);
    companyDataKey = company.dataKey;
    fixtureCompanyDataKeys.set(companyId, companyDataKey);
  }
  const storageId = randomUUID().replace(/-/g, "").slice(0, 20);
  const [row] = await db
    .insert(projects)
    .values({
      name: `Project-${tag}`,
      dataUrl: `${companyDataKey}/${storageId}`,
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

/**
 * Create a protocol-valid Label Studio session without calling the external provider. Migration
 * 0037 intentionally rejects the old bare-session fixture shape, so route tests that only need a
 * read/blocker witness must still pass through an exact provisioning intent and immutable provider
 * binding. No grants are created here; grant/retirement tests own their richer fixtures directly.
 */
export async function createLabelingSessionFixture(
  project: Pick<
    typeof projects.$inferSelect,
    "id" | "companyId" | "lifecycleEpoch"
  >,
  over: Partial<typeof labelingSessions.$inferInsert> = {},
) {
  const intentId = randomUUID();
  const providerProjectId =
    over.labelStudioProjectId ??
    1_000_000_000 + (parseInt(intentId.slice(0, 8), 16) % 1_000_000_000);
  const providerBaseUrl = over.providerBaseUrl ?? "https://labelstudio.test";
  const providerInstanceId =
    over.providerInstanceId ?? `fixture-provider-${intentId}`;
  const requestedStatus = over.status ?? "active";
  const {
    status: _status,
    projectId: _projectId,
    companyId: _companyId,
    provisioningIntentId: _provisioningIntentId,
    labelStudioProjectId: _labelStudioProjectId,
    providerBaseUrl: _providerBaseUrl,
    providerInstanceId: _providerInstanceId,
    ...sessionFields
  } = over;

  return db.transaction(async (tx) => {
    await tx.insert(labelStudioProjectIntents).values({
      id: intentId,
      projectId: project.id,
      companyId: project.companyId,
      lifecycleEpoch: project.lifecycleEpoch,
      marker: `bp-labeling-intent:${intentId}`,
      providerProjectId,
      providerBaseUrl,
      providerInstanceId,
      state: "cleanup_pending",
    });
    const [created] = await tx
      .insert(labelingSessions)
      .values({
        projectId: project.id,
        companyId: project.companyId,
        labelStudioProjectId: providerProjectId,
        providerBaseUrl,
        providerInstanceId,
        provisioningIntentId: intentId,
        labelStudioUrl: `${providerBaseUrl}/projects/${providerProjectId}`,
        taskType: "generic",
        status: "active",
        ...sessionFields,
      })
      .returning();
    await tx
      .delete(labelStudioProjectIntents)
      .where(drizzleEq(labelStudioProjectIntents.id, intentId));
    if (requestedStatus === "retiring") {
      const [retiring] = await tx
        .update(labelingSessions)
        .set({ status: "retiring", updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(drizzleEq(labelingSessions.id, created.id))
        .returning();
      return retiring;
    }
    if (requestedStatus !== "active") {
      throw new Error(`Unsupported Label Studio fixture status: ${requestedStatus}`);
    }
    return created;
  });
}

/** Publish an already-seeded private fixture through the same monotonic lifecycle transition
 * enforced in production. Tests must create child rows before calling this helper. */
export async function publishDemoFixture(projectId: number) {
  const [row] = await db
    .update(projects)
    .set({
      isDemo: true,
      lifecycleEpoch: sql`${projects.lifecycleEpoch} + 1`,
    })
    .where(drizzleEq(projects.id, projectId))
    .returning();
  if (!row) throw new Error("Project fixture not found");
  return row;
}

/** Age a private fixture past every app-minted project upload authority using the DB clock. */
export async function ageProjectForPublication(
  projectId: number,
): Promise<void> {
  await db
    .update(projects)
    .set({
      createdAt: sql`CURRENT_TIMESTAMP - (${PROJECT_UPLOAD_PUBLICATION_FENCE_SECONDS + 1} * INTERVAL '1 second')`,
    })
    .where(drizzleEq(projects.id, projectId));
}

/** One call = company + member user + completed project (the common base). */
export async function createWorld(
  projectOver: Partial<typeof projects.$inferInsert> = {},
) {
  const company = await createCompany();
  const user = await createUser(company.id);
  const project = await createProject(company.id, user.id, projectOver);
  return { company, user, project };
}

export async function annotationsFor(projectId: number) {
  const { eq } = await import("drizzle-orm");
  return db
    .select()
    .from(annotations)
    .where(eq(annotations.projectId, projectId));
}

// ── request builders ─────────────────────────────────────────────────────────
export function makeReq(
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Request {
  const { method = "POST", body, headers = {} } = opts;
  return new Request(`http://test.local${path}`, {
    method,
    headers:
      body !== undefined
        ? { "content-type": "application/json", ...headers }
        : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** App-Router dynamic params arrive as a Promise in Next 15+/16. */
export function params<T extends Record<string, string>>(
  p: T,
): { params: Promise<T> } {
  return { params: Promise.resolve(p) };
}

export async function readJson(
  res: Response,
): Promise<{ status: number; body: any }> {
  return { status: res.status, body: await res.json() };
}
