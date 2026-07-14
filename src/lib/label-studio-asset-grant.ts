import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { ProjectAccessRow } from "@/lib/api-utils";
import { db } from "@/lib/db";
import {
  companies,
  labelingSessions,
  labelStudioAssetGrants,
  labelStudioProjectIntents,
  projectMutationLeases,
  projects,
} from "@/lib/db/schema";
import { isCanonicalProjectPath } from "@/lib/project-upload-authority";
import {
  getS3ObjectVersionStream,
  headS3Object,
} from "@/lib/s3";
import { ApiError } from "@/server/api/envelope";
import type { ProjectWriteTransaction } from "@/server/api/project-write-capability";
import { and, eq, gt, inArray, isNotNull, or, sql } from "drizzle-orm";

const GRANT_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNAPSHOT_ACQUIRE_TIMEOUT_MS = 15_000;

export interface LabelStudioGrantSecret {
  id: string;
  token: string;
  tokenHash: string;
  snapshotAsset: string;
}

export interface PreparedLabelStudioGrant extends LabelStudioGrantSecret {
  snapshotVersionId: string;
}

type SnapshotProject = Pick<
  ProjectAccessRow,
  | "id"
  | "publicId"
  | "companyId"
  | "isDemo"
  | "dataUrl"
  | "status"
  | "lifecycleEpoch"
>;

function notFound(): ApiError {
  return new ApiError("NOT_FOUND", "Asset not found");
}

export function hashLabelStudioAssetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createLabelStudioGrantSecret(): LabelStudioGrantSecret {
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  return {
    id,
    token,
    tokenHash: hashLabelStudioAssetToken(token),
    snapshotAsset: `label-studio-assets/${id}.png`,
  };
}

export function labelStudioAssetUrl(id: string, token: string): string {
  if (!UUID_RE.test(id) || !GRANT_TOKEN_RE.test(token)) {
    throw new Error("Invalid Label Studio asset grant material");
  }
  const configured = process.env.NEXTAUTH_URL;
  if (!configured) throw new Error("NEXTAUTH_URL is required for Label Studio assets");
  const origin = new URL(configured).origin;
  const url = new URL(`/api/label-assets/${id}`, origin);
  url.searchParams.set("token", token);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("Label Studio asset URLs require HTTPS in production");
  }
  return url.toString();
}

async function assertNoAssetWriter(
  tx: ProjectWriteTransaction,
  projectId: number,
): Promise<void> {
  const [writer] = await tx
    .select({ token: projectMutationLeases.token })
    .from(projectMutationLeases)
    .where(
      and(
        eq(projectMutationLeases.projectId, projectId),
        eq(projectMutationLeases.status, "active"),
        or(
          eq(projectMutationLeases.kind, "project-processing"),
          eq(projectMutationLeases.kind, "admin-reprocess:thumbnails"),
        ),
      ),
    )
    .limit(1);
  if (writer) {
    throw new ApiError(
      "CONFLICT",
      "Project assets are being rebuilt; retry labeling later",
    );
  }
}

/**
 * Hold a shared parent lock while exact S3 versions are captured. Supported
 * asset writers acquire that parent FOR UPDATE before their lease, so none can
 * start or finish a same-key rebuild inside this bounded snapshot window.
 */
export async function withLabelStudioSnapshotLock<T>(
  project: SnapshotProject,
  operation: (storageRoot: string) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        publicId: projects.publicId,
        companyId: projects.companyId,
        companyDataKey: companies.dataKey,
        isDemo: projects.isDemo,
        dataUrl: projects.dataUrl,
        status: projects.status,
        lifecycleEpoch: projects.lifecycleEpoch,
      })
      .from(projects)
      .innerJoin(companies, eq(companies.id, projects.companyId))
      .where(eq(projects.id, project.id))
      .for("share")
      .limit(1);
    if (
      !current ||
      current.publicId !== project.publicId ||
      current.companyId !== project.companyId ||
      current.isDemo ||
      current.isDemo !== project.isDemo ||
      current.dataUrl !== project.dataUrl ||
      current.status !== "completed" ||
      current.lifecycleEpoch !== project.lifecycleEpoch ||
      !isCanonicalProjectPath(current.companyDataKey, current.dataUrl)
    ) {
      throw new ApiError(
        "CONFLICT",
        "Project assets are not ready for labeling",
      );
    }
    await assertNoAssetWriter(tx, project.id);
    return operation(current.dataUrl);
  });
}

export async function requireVersionedSource(
  key: string,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    SNAPSHOT_ACQUIRE_TIMEOUT_MS,
  );
  try {
    const head = await headS3Object(key, { signal: controller.signal });
    if (!head.exists || !head.versionId) {
      throw new ApiError(
        "CONFLICT",
        "Project assets are not ready for labeling",
      );
    }
    return head.versionId;
  } finally {
    clearTimeout(timeout);
  }
}

export async function activateLabelStudioAssetGrants(
  tx: ProjectWriteTransaction,
  intentId: string,
  sessionId: number,
  expectedGrantIds: readonly string[],
): Promise<void> {
  if (expectedGrantIds.length === 0) {
    throw new Error("A Label Studio session requires at least one asset grant");
  }
  const updated = await tx
    .update(labelStudioAssetGrants)
    .set({
      provisioningIntentId: null,
      labelingSessionId: sessionId,
      state: "active",
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(labelStudioAssetGrants.provisioningIntentId, intentId),
        eq(labelStudioAssetGrants.state, "provisioning"),
        inArray(labelStudioAssetGrants.id, [...expectedGrantIds]),
      ),
    )
    .returning({ id: labelStudioAssetGrants.id });
  if (updated.length !== expectedGrantIds.length) {
    throw new Error("Label Studio asset grant activation count mismatch");
  }
  const [unexpected] = await tx
    .select({ id: labelStudioAssetGrants.id })
    .from(labelStudioAssetGrants)
    .where(eq(labelStudioAssetGrants.provisioningIntentId, intentId))
    .limit(1);
  if (unexpected) {
    throw new Error("Unexpected Label Studio asset grant remained on intent");
  }
}

export async function revokeIntentLabelStudioAssetGrants(
  tx: ProjectWriteTransaction,
  intentId: string,
): Promise<number> {
  const revoked = await tx
    .update(labelStudioAssetGrants)
    .set({
      state: "revoked",
      revokedAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(labelStudioAssetGrants.provisioningIntentId, intentId),
        eq(labelStudioAssetGrants.state, "provisioning"),
      ),
    )
    .returning({ id: labelStudioAssetGrants.id });
  return revoked.length;
}

export async function deleteIntentLabelStudioAssetGrants(
  tx: ProjectWriteTransaction,
  intentId: string,
): Promise<number> {
  const deleted = await tx
    .delete(labelStudioAssetGrants)
    .where(
      and(
        eq(labelStudioAssetGrants.provisioningIntentId, intentId),
        eq(labelStudioAssetGrants.state, "revoked"),
      ),
    )
    .returning({ id: labelStudioAssetGrants.id });
  return deleted.length;
}

export async function revokeSessionLabelStudioAssetGrants(
  tx: ProjectWriteTransaction,
  sessionId: number,
): Promise<number> {
  const revoked = await tx
    .update(labelStudioAssetGrants)
    .set({
      state: "revoked",
      revokedAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(labelStudioAssetGrants.labelingSessionId, sessionId),
        eq(labelStudioAssetGrants.state, "active"),
      ),
    )
    .returning({ id: labelStudioAssetGrants.id });
  return revoked.length;
}

export async function deleteSessionLabelStudioAssetGrants(
  tx: ProjectWriteTransaction,
  sessionId: number,
): Promise<number> {
  const deleted = await tx
    .delete(labelStudioAssetGrants)
    .where(
      and(
        eq(labelStudioAssetGrants.labelingSessionId, sessionId),
        eq(labelStudioAssetGrants.state, "revoked"),
      ),
    )
    .returning({ id: labelStudioAssetGrants.id });
  return deleted.length;
}

function configuredLabelStudioOrigin(): string | null {
  try {
    return process.env.LABEL_STUDIO_URL
      ? new URL(process.env.LABEL_STUDIO_URL).origin
      : null;
  } catch {
    return null;
  }
}

export function withLabelStudioAssetResponsePolicy(
  req: Request,
  response: Response,
): Response {
  const headers = new Headers(response.headers);
  const requestOrigin = req.headers.get("origin");
  const allowedOrigin = configuredLabelStudioOrigin();
  if (requestOrigin && allowedOrigin && requestOrigin === allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
  } else {
    headers.delete("Access-Control-Allow-Origin");
  }
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set("Cache-Control", "private, no-store");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Vary", "Origin");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

interface GrantCandidate {
  projectId: number;
}

async function discoverGrant(
  id: string,
  tokenHash: string,
): Promise<GrantCandidate | null> {
  const [row] = await db
    .select({ projectId: labelStudioAssetGrants.projectId })
    .from(labelStudioAssetGrants)
    .where(
      and(
        eq(labelStudioAssetGrants.id, id),
        eq(labelStudioAssetGrants.tokenHash, tokenHash),
      ),
    )
    .limit(1);
  return row ?? null;
}

function s3Status(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
}

/**
 * Resolve the bearer and acquire the exact S3 version while the project,
 * grant, and current owner remain SHARE-locked. Revocation takes the project
 * FOR UPDATE, so its commit is strictly ordered with this response admission.
 */
export async function serveLabelStudioAsset(
  req: Request,
  id: string,
  rawToken: string | null,
  headOnly = false,
): Promise<Response> {
  if (!UUID_RE.test(id) || !rawToken || !GRANT_TOKEN_RE.test(rawToken)) {
    throw notFound();
  }
  const tokenHash = hashLabelStudioAssetToken(rawToken);
  const candidate = await discoverGrant(id, tokenHash);
  if (!candidate) throw notFound();

  const object = await db.transaction(async (tx) => {
    const [project] = await tx
      .select({
        companyId: projects.companyId,
        companyDataKey: companies.dataKey,
        dataUrl: projects.dataUrl,
        isDemo: projects.isDemo,
        lifecycleEpoch: projects.lifecycleEpoch,
        status: projects.status,
      })
      .from(projects)
      .innerJoin(companies, eq(companies.id, projects.companyId))
      .where(eq(projects.id, candidate.projectId))
      .for("share")
      .limit(1);
    if (
      !project ||
      project.isDemo ||
      project.status !== "completed" ||
      !isCanonicalProjectPath(project.companyDataKey, project.dataUrl)
    ) {
      throw notFound();
    }

    const [grant] = await tx
      .select()
      .from(labelStudioAssetGrants)
      .where(
        and(
          eq(labelStudioAssetGrants.id, id),
          eq(labelStudioAssetGrants.projectId, candidate.projectId),
          eq(labelStudioAssetGrants.companyId, project.companyId),
          eq(labelStudioAssetGrants.lifecycleEpoch, project.lifecycleEpoch),
          eq(labelStudioAssetGrants.tokenHash, tokenHash),
        ),
      )
      .for("share")
      .limit(1);
    if (!grant || (grant.state !== "provisioning" && grant.state !== "active")) {
      throw notFound();
    }

    if (grant.state === "provisioning") {
      if (!grant.provisioningIntentId || grant.labelingSessionId !== null) {
        throw notFound();
      }
      const [owner] = await tx
        .select({
          id: labelStudioProjectIntents.id,
          leaseToken: labelStudioProjectIntents.leaseToken,
        })
        .from(labelStudioProjectIntents)
        .where(
          and(
            eq(labelStudioProjectIntents.id, grant.provisioningIntentId),
            eq(labelStudioProjectIntents.projectId, grant.projectId),
            eq(labelStudioProjectIntents.companyId, grant.companyId),
            eq(
              labelStudioProjectIntents.lifecycleEpoch,
              grant.lifecycleEpoch,
            ),
            eq(labelStudioProjectIntents.state, "cleanup_pending"),
            isNotNull(labelStudioProjectIntents.providerProjectId),
            isNotNull(labelStudioProjectIntents.leaseToken),
            gt(
              labelStudioProjectIntents.leaseExpiresAt,
              sql`CURRENT_TIMESTAMP`,
            ),
          ),
        )
        .for("share")
        .limit(1);
      if (!owner) throw notFound();
      // The request lease is the exact token of the outer long-running project mutation. Intent
      // expiry alone is not authority: once that operation unwinds, its explicit lease release
      // immediately closes every still-provisioning bearer even if a failed DB compensation write
      // left the intent's two-hour diagnostic lease in place.
      const [operation] = await tx
        .select({ token: projectMutationLeases.token })
        .from(projectMutationLeases)
        .where(
          and(
            eq(projectMutationLeases.token, owner.leaseToken!),
            eq(projectMutationLeases.projectId, grant.projectId),
            eq(
              projectMutationLeases.lifecycleEpoch,
              grant.lifecycleEpoch,
            ),
            eq(projectMutationLeases.kind, "labeling-session-create"),
            eq(projectMutationLeases.status, "active"),
          ),
        )
        .for("share")
        .limit(1);
      if (!operation) throw notFound();
    } else {
      if (!grant.labelingSessionId || grant.provisioningIntentId !== null) {
        throw notFound();
      }
      const [owner] = await tx
        .select({ id: labelingSessions.id })
        .from(labelingSessions)
        .where(
          and(
            eq(labelingSessions.id, grant.labelingSessionId),
            eq(labelingSessions.projectId, grant.projectId),
            eq(labelingSessions.companyId, grant.companyId),
            eq(labelingSessions.status, "active"),
          ),
        )
        .for("share")
        .limit(1);
      if (!owner) throw notFound();
    }

    const key = `${project.dataUrl}/label-studio-assets/${grant.id}.png`;
    const controller = new AbortController();
    const abortFromRequest = () => controller.abort(req.signal.reason);
    if (req.signal.aborted) abortFromRequest();
    else req.signal.addEventListener("abort", abortFromRequest, { once: true });
    const timeout = setTimeout(
      () => controller.abort(),
      SNAPSHOT_ACQUIRE_TIMEOUT_MS,
    );
    try {
      if (headOnly) {
        const head = await headS3Object(key, {
          signal: controller.signal,
          versionId: grant.snapshotVersionId,
        });
        if (!head.exists) throw notFound();
        return { body: null, contentLength: head.size };
      }
      return await getS3ObjectVersionStream(
        key,
        grant.snapshotVersionId,
        controller.signal,
      );
    } catch (error) {
      if (
        error instanceof ApiError ||
        s3Status(error) === 403 ||
        s3Status(error) === 404 ||
        (error as { name?: string })?.name === "NoSuchVersion"
      ) {
        throw notFound();
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      req.signal.removeEventListener("abort", abortFromRequest);
    }
  });

  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Type": "image/png",
    "X-Content-Type-Options": "nosniff",
  });
  if (object.contentLength !== undefined) {
    headers.set("Content-Length", String(object.contentLength));
  }
  return new Response(headOnly ? null : object.body, { status: 200, headers });
}
