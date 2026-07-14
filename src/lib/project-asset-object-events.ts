import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { projectAssetDeletions } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import {
  isCanonicalProjectPath,
  PROJECT_UPLOAD_STAGING_ROOT,
} from "@/lib/project-upload-authority";

const sqsClient = new SQSClient({
  region: process.env.AWS_REGION || "us-east-1",
});
const SQS_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BATCHES = 100;
const INVALID_OBJECT_KEY_SEGMENT = /[\u0000-\u001f\u007f]/u;

interface S3ObjectCreatedEvent {
  detail?: {
    object?: { key?: string };
  };
}

function canonicalProjectPathFromObjectKeyParts(
  parts: string[],
  companyIndex: number,
  projectIndex: number,
  objectStartIndex: number,
): string | null {
  const companyDataKey = parts[companyIndex];
  const projectIdentity = parts[projectIndex];
  const objectSegments = parts.slice(objectStartIndex);
  if (
    !companyDataKey ||
    !projectIdentity ||
    objectSegments.length === 0 ||
    objectSegments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        INVALID_OBJECT_KEY_SEGMENT.test(segment),
    )
  ) {
    return null;
  }

  const projectPath = `${companyDataKey}/${projectIdentity}`;
  return isCanonicalProjectPath(companyDataKey, projectPath)
    ? projectPath
    : null;
}

/** Resolve a canonical project root from either a final-asset or isolated staging object event. */
export function retiredProjectPathFromObjectEvent(
  event: S3ObjectCreatedEvent | null,
): string | null {
  const encodedKey = event?.detail?.object?.key;
  if (typeof encodedKey !== "string" || encodedKey.length === 0) return null;

  let key: string;
  try {
    key = decodeURIComponent(encodedKey.replaceAll("+", " "));
  } catch {
    return null;
  }
  const parts = key.split("/");
  if (parts[0] === PROJECT_UPLOAD_STAGING_ROOT) {
    return canonicalProjectPathFromObjectKeyParts(parts, 1, 2, 3);
  }
  return canonicalProjectPathFromObjectKeyParts(parts, 0, 1, 2);
}

async function wakeRetiredProjectPath(projectPath: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: projectAssetDeletions.id,
      })
      .from(projectAssetDeletions)
      .where(eq(projectAssetDeletions.storageRoot, projectPath))
      .for("update")
      .limit(1);
    if (!row) return false;

    // Always increment the durable event generation while holding the row lock. An active
    // reconciler's completion CAS will then fail and re-purge; a terminal row is reopened now.
    // Preserve any live lease rather than stealing another worker's fenced attempt.
    await tx
      .update(projectAssetDeletions)
      .set({
        status: sql`CASE
          WHEN ${projectAssetDeletions.status} = 'completed' THEN 'watching'
          ELSE ${projectAssetDeletions.status}
        END`,
        phase: sql`CASE
          WHEN ${projectAssetDeletions.phase} = 'complete' THEN 'watch'
          ELSE ${projectAssetDeletions.phase}
        END`,
        objectEventGeneration: sql`${projectAssetDeletions.objectEventGeneration} + 1`,
        nextAttemptAt: sql`CURRENT_TIMESTAMP`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(projectAssetDeletions.id, row.id));
    return true;
  });
}

/** Drain durable S3 ObjectCreated notifications and wake matching permanent tombstones. */
export async function drainProjectAssetObjectEvents(
  maxBatches = DEFAULT_MAX_BATCHES,
): Promise<{ received: number; awakened: number; failed: number }> {
  const queueUrl = process.env.PROJECT_ASSET_EVENT_QUEUE_URL;
  if (!queueUrl) return { received: 0, awakened: 0, failed: 0 };

  let received = 0;
  let awakened = 0;
  let failed = 0;

  for (let batch = 0; batch < maxBatches; batch++) {
    const response = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
      }),
      { abortSignal: AbortSignal.timeout(SQS_CALL_TIMEOUT_MS) },
    );
    const messages = response.Messages ?? [];
    if (messages.length === 0) break;

    // Coalesce only messages observed concurrently in this receive batch. A reconciler can
    // terminalize the tombstone between receives, so a later batch must advance the durable
    // generation again before its messages are acknowledged.
    const wakeByProjectPath = new Map<string, Promise<boolean>>();
    const wakeOnce = (projectPath: string): Promise<boolean> => {
      const existing = wakeByProjectPath.get(projectPath);
      if (existing) return existing;

      const pending = wakeRetiredProjectPath(projectPath).then(
        (didWake) => {
          if (didWake) awakened++;
          return didWake;
        },
        (error: unknown) => {
          if (wakeByProjectPath.get(projectPath) === pending) {
            wakeByProjectPath.delete(projectPath);
          }
          throw error;
        },
      );
      wakeByProjectPath.set(projectPath, pending);
      return pending;
    };

    await Promise.all(
      messages.map(async (message) => {
        received++;
        try {
          // Do not mutate durable state for a delivery that cannot be acknowledged.
          if (!message.ReceiptHandle) {
            throw new Error("SQS project asset event had no receipt handle");
          }
          const event = JSON.parse(
            message.Body ?? "null",
          ) as S3ObjectCreatedEvent | null;
          const projectPath = retiredProjectPathFromObjectEvent(event);
          if (projectPath) await wakeOnce(projectPath);
          await sqsClient.send(
            new DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: message.ReceiptHandle,
            }),
            { abortSignal: AbortSignal.timeout(SQS_CALL_TIMEOUT_MS) },
          );
        } catch (error) {
          failed++;
          logger.error("[project-asset-event] event processing failed:", error);
        }
      }),
    );
  }
  return { received, awakened, failed };
}
