import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { projectMutationLeases, projects } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { ApiError } from "@/server/api/envelope";

export { isDemoWriteProtectionError } from "@/server/api/project-write-errors";

const projectWriteCapabilityBrand: unique symbol = Symbol(
  "ProjectWriteCapability",
);
const projectMutationLeaseBrand: unique symbol = Symbol("ProjectMutationLease");

type TransactionCallback = Parameters<typeof db.transaction>[0];
export type ProjectWriteTransaction = Parameters<TransactionCallback>[0];

// Shared by the application and migration trigger. Hash collisions only create conservative
// contention; they cannot weaken isolation. The transaction-scoped lock prevents a deleted storage
// root from being reused between the tombstone check and the projects INSERT.
export const PROJECT_STORAGE_ADVISORY_LOCK_SEED = 2026071401;

export async function lockProjectStorageRoot(
  tx: ProjectWriteTransaction,
  storageRoot: string,
): Promise<void> {
  if (!storageRoot) throw new Error("Project storage root is required");
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${storageRoot}, ${PROJECT_STORAGE_ADVISORY_LOCK_SEED}))`,
  );
}

export interface WritableProjectIdentity {
  id: number;
  publicId: string;
  companyId: number;
  isDemo: boolean;
  lifecycleEpoch: number;
}

/** Unforgeable authority for one lifecycle generation of one private project. */
export interface ProjectWriteCapability {
  readonly projectId: number;
  readonly publicId: string;
  readonly companyId: number;
  readonly lifecycleEpoch: number;
  readonly [projectWriteCapabilityBrand]: true;
}

export interface ProjectMutationLease {
  readonly token: string;
  readonly projectId: number;
  readonly lifecycleEpoch: number;
  readonly kind: string;
  readonly expiresAt: Date;
  readonly [projectMutationLeaseBrand]: true;
}

export interface ProjectMutationLeaseOptions {
  kind: string;
  /** Distinct keys may coexist; one live lease per project/key is enforced. */
  idempotencyKey?: string;
  /** Long operations heartbeat at one third of this diagnostic interval. Minimum 30 seconds. */
  ttlMs?: number;
}

function assertCapabilityBinding(
  capability: ProjectWriteCapability,
  projectId: number,
): void {
  if (
    capability?.[projectWriteCapabilityBrand] !== true ||
    capability.projectId !== projectId
  ) {
    throw new Error("Invalid project write capability");
  }
}

function assertLockedProjectWritable(
  capability: ProjectWriteCapability,
  current:
    | {
        publicId: string;
        companyId: number;
        isDemo: boolean;
        lifecycleEpoch: number;
      }
    | undefined,
): void {
  if (
    !current ||
    current.publicId !== capability.publicId ||
    current.companyId !== capability.companyId
  ) {
    throw new Error("Invalid project write capability");
  }
  if (current.isDemo) {
    throw new ApiError("FORBIDDEN", "Demo projects are read-only");
  }
  if (current.lifecycleEpoch !== capability.lifecycleEpoch) {
    throw new ApiError("FORBIDDEN", "Project write capability expired");
  }
}

export function assertProjectWritable(
  project: WritableProjectIdentity,
): ProjectWriteCapability {
  if (project.isDemo) {
    throw new ApiError("FORBIDDEN", "Demo projects are read-only");
  }
  return Object.freeze({
    projectId: project.id,
    publicId: project.publicId,
    companyId: project.companyId,
    lifecycleEpoch: project.lifecycleEpoch,
    [projectWriteCapabilityBrand]: true as const,
  });
}

/** Runtime binding/lifecycle precheck. It is advisory; sinks must use withProjectWrite. */
export async function assertProjectWriteCapability(
  capability: ProjectWriteCapability,
  projectId: number,
): Promise<void> {
  assertCapabilityBinding(capability, projectId);

  const [current] = await db
    .select({
      publicId: projects.publicId,
      companyId: projects.companyId,
      isDemo: projects.isDemo,
      lifecycleEpoch: projects.lifecycleEpoch,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  assertLockedProjectWritable(capability, current);
}

/**
 * Atomic project mutation boundary. The parent is always locked before any child row, and every
 * sink must use the supplied transaction handle. Publication either happens before this callback
 * (and validation rejects it) or after the callback commits.
 */
export async function withProjectWrite<T>(
  capability: ProjectWriteCapability,
  projectId: number,
  write: (tx: ProjectWriteTransaction) => Promise<T>,
): Promise<T> {
  assertCapabilityBinding(capability, projectId);
  return withProjectWrites([capability], write);
}

/**
 * Deletion boundary for a project and its permanent storage-root tombstone. The advisory lock is
 * deliberately acquired before the parent row lock; project creation uses the same order.
 */
export async function withProjectStorageWrite<T>(
  capability: ProjectWriteCapability,
  projectId: number,
  storageRoot: string,
  write: (tx: ProjectWriteTransaction) => Promise<T>,
): Promise<T> {
  assertCapabilityBinding(capability, projectId);
  return withProjectWritesInternal([capability], [storageRoot], write);
}

/**
 * Atomic boundary for one mutation spanning several projects. Every capability is validated before
 * the callback runs, and parents are locked by ascending id so concurrent bulk operations cannot
 * invert their lock order. Duplicate references to the same exact authority are collapsed.
 */
export async function withProjectWrites<T>(
  capabilities: readonly ProjectWriteCapability[],
  write: (tx: ProjectWriteTransaction) => Promise<T>,
): Promise<T> {
  return withProjectWritesInternal(capabilities, [], write);
}

async function withProjectWritesInternal<T>(
  capabilities: readonly ProjectWriteCapability[],
  storageRoots: readonly string[],
  write: (tx: ProjectWriteTransaction) => Promise<T>,
): Promise<T> {
  const byProjectId = new Map<number, ProjectWriteCapability>();
  for (const capability of capabilities) {
    assertCapabilityBinding(capability, capability.projectId);
    const prior = byProjectId.get(capability.projectId);
    if (
      prior &&
      (prior.publicId !== capability.publicId ||
        prior.companyId !== capability.companyId ||
        prior.lifecycleEpoch !== capability.lifecycleEpoch)
    ) {
      throw new Error("Conflicting project write capabilities");
    }
    byProjectId.set(capability.projectId, capability);
  }

  const ordered = [...byProjectId.values()].sort(
    (a, b) => a.projectId - b.projectId,
  );
  if (ordered.length === 0) {
    throw new Error("At least one project write capability is required");
  }

  return db.transaction(async (tx) => {
    for (const storageRoot of [...new Set(storageRoots)].sort()) {
      await lockProjectStorageRoot(tx, storageRoot);
    }
    for (const capability of ordered) {
      const [current] = await tx
        .select({
          publicId: projects.publicId,
          companyId: projects.companyId,
          isDemo: projects.isDemo,
          lifecycleEpoch: projects.lifecycleEpoch,
        })
        .from(projects)
        .where(eq(projects.id, capability.projectId))
        .for("update")
        .limit(1);
      assertLockedProjectWritable(capability, current);
    }
    return write(tx);
  });
}

export async function acquireProjectMutationLease(
  capability: ProjectWriteCapability,
  options: ProjectMutationLeaseOptions,
): Promise<ProjectMutationLease> {
  const ttlMs = Math.max(30_000, options.ttlMs ?? 300_000);
  const token = randomUUID();

  return withProjectWrite(capability, capability.projectId, async (tx) => {
    if (options.idempotencyKey !== undefined) {
      const [existing] = await tx
        .select({ token: projectMutationLeases.token })
        .from(projectMutationLeases)
        .where(
          and(
            eq(projectMutationLeases.projectId, capability.projectId),
            eq(projectMutationLeases.idempotencyKey, options.idempotencyKey),
            eq(projectMutationLeases.status, "active"),
          ),
        )
        .limit(1);
      if (existing) {
        throw new ApiError("CONFLICT", "Project mutation already in progress");
      }
    }
    const [row] = await tx
      .insert(projectMutationLeases)
      .values({
        token,
        projectId: capability.projectId,
        lifecycleEpoch: capability.lifecycleEpoch,
        kind: options.kind,
        idempotencyKey: options.idempotencyKey,
        expiresAt: sql`CURRENT_TIMESTAMP + (${ttlMs} * INTERVAL '1 millisecond')`,
        heartbeatAt: sql`CURRENT_TIMESTAMP`,
      })
      .returning({
        token: projectMutationLeases.token,
        expiresAt: projectMutationLeases.expiresAt,
      });
    if (!row) throw new Error("Failed to acquire project mutation lease");
    return Object.freeze({
      token: row.token,
      projectId: capability.projectId,
      lifecycleEpoch: capability.lifecycleEpoch,
      kind: options.kind,
      expiresAt: row.expiresAt,
      [projectMutationLeaseBrand]: true as const,
    });
  });
}

async function heartbeatProjectMutationLease(
  capability: ProjectWriteCapability,
  lease: ProjectMutationLease,
  ttlMs: number,
): Promise<void> {
  if (
    lease?.[projectMutationLeaseBrand] !== true ||
    lease.projectId !== capability.projectId ||
    lease.lifecycleEpoch !== capability.lifecycleEpoch
  ) {
    throw new Error("Invalid project mutation lease");
  }
  await withProjectWrite(capability, lease.projectId, async (tx) => {
    const updated = await tx
      .update(projectMutationLeases)
      .set({
        heartbeatAt: sql`CURRENT_TIMESTAMP`,
        expiresAt: sql`CURRENT_TIMESTAMP + (${ttlMs} * INTERVAL '1 millisecond')`,
      })
      .where(
        and(
          eq(projectMutationLeases.token, lease.token),
          eq(projectMutationLeases.projectId, lease.projectId),
          eq(projectMutationLeases.lifecycleEpoch, lease.lifecycleEpoch),
          eq(projectMutationLeases.status, "active"),
        ),
      )
      .returning({ token: projectMutationLeases.token });
    if (updated.length !== 1)
      throw new Error("Project mutation lease is no longer active");
  });
}

export async function releaseProjectMutationLease(
  capability: ProjectWriteCapability,
  lease: ProjectMutationLease,
): Promise<void> {
  if (
    lease?.[projectMutationLeaseBrand] !== true ||
    lease.projectId !== capability.projectId ||
    lease.lifecycleEpoch !== capability.lifecycleEpoch
  ) {
    throw new Error("Invalid project mutation lease");
  }
  await withProjectWrite(capability, lease.projectId, async (tx) => {
    await tx
      .delete(projectMutationLeases)
      .where(
        and(
          eq(projectMutationLeases.token, lease.token),
          eq(projectMutationLeases.projectId, lease.projectId),
          eq(projectMutationLeases.lifecycleEpoch, lease.lifecycleEpoch),
        ),
      );
  });
}

/**
 * Coordinate a long external mutation without retaining a DB connection or row lock.
 *
 * Expiry is diagnostic only. An active row remains a publication blocker until explicit release:
 * losing a heartbeat cannot prove that an already-started external system stopped writing. A
 * crashed worker therefore fails closed and requires provider/operator reconciliation.
 */
export async function withProjectMutationLease<T>(
  capability: ProjectWriteCapability,
  options: ProjectMutationLeaseOptions,
  operation: (lease: ProjectMutationLease) => Promise<T>,
): Promise<T> {
  const ttlMs = Math.max(30_000, options.ttlMs ?? 300_000);
  const lease = await acquireProjectMutationLease(capability, {
    ...options,
    ttlMs,
  });
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let operationError: unknown;

  const scheduleHeartbeat = () => {
    timer = setTimeout(
      () => {
        void heartbeatProjectMutationLease(capability, lease, ttlMs)
          .catch((error) => {
            logger.error("Project mutation lease heartbeat failed:", error);
          })
          .finally(() => {
            if (!stopped) scheduleHeartbeat();
          });
      },
      Math.max(10_000, Math.floor(ttlMs / 3)),
    );
  };
  scheduleHeartbeat();

  try {
    return await operation(lease);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    try {
      await releaseProjectMutationLease(capability, lease);
    } catch (releaseError) {
      // Successful project deletion removes its own lease by cascade. Confirm absence rather than
      // swallowing every release error: for every surviving project, a failed explicit release is
      // an indefinite publication blocker and must be visible to the caller/operations.
      let removedByProjectDelete = false;
      if (options.kind === "project-delete") {
        const [remainingProject] = await db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.id, capability.projectId))
          .limit(1);
        removedByProjectDelete = !remainingProject;
      }
      if (!removedByProjectDelete) {
        logger.error("Project mutation lease release failed:", releaseError);
        if (operationError === undefined) throw releaseError;
      }
    }
  }
}
