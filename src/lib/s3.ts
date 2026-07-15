import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";
import {
  PROJECT_UPLOAD_PRESIGN_TTL_SECONDS,
  isSafeCompanyDataKey,
  projectUploadStagingKey,
  sanitizeProjectUploadFilename,
  projectUploadStagingPrefix,
} from "@/lib/project-upload-authority";
import { canonicalModelStoragePath } from "@/lib/model-storage-authority";

// The offline Playwright harness exposes an S3-shaped fixture endpoint. Production
// deliberately ignores this variable even if it is accidentally present.
const testS3Endpoint =
  process.env.NODE_ENV !== "production"
    ? process.env.BP_TEST_S3_ENDPOINT
    : undefined;

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  ...(testS3Endpoint && {
    endpoint: testS3Endpoint,
    forcePathStyle: true,
  }),
  ...(process.env.AWS_ACCESS_KEY_ID && {
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  }),
});

const S3_BUCKET = process.env.S3_BUCKET ?? "";

export function generateProjectPath(companyDataKey: string): string {
  if (!isSafeCompanyDataKey(companyDataKey)) {
    throw new Error("Company data key is not safe for project storage");
  }
  const projectId = crypto.randomBytes(10).toString("hex");
  return `${companyDataKey}/${projectId}`;
}

// ─── Multi-file staging upload ───────────────────────────────
// Browser uploads land under the isolated `_bp-staging/` root, never under a
// project's final prefix. processing.ts alone writes ${projectPath}/original.pdf.

const STAGING_MAX_BYTES = 500 * 1024 * 1024; // 500 MB per file

const STAGING_CONTENT_TYPE: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
};

export function extensionFromFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "";
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * Strip path separators, truncate to 120 chars, replace non-[A-Za-z0-9._-]
 * with "_", collapse consecutive underscores. Defense-in-depth: File.name
 * from the browser is already just a filename, but we scrub anyway before
 * using it in an S3 key.
 */
export const sanitizeFilename = sanitizeProjectUploadFilename;

export async function createStagingUploadPresignedPost(
  projectPath: string,
  filename: string,
  index: number,
): Promise<{
  url: string;
  fields: Record<string, string>;
  stagingKey: string;
}> {
  const ext = extensionFromFilename(filename);
  const contentType = STAGING_CONTENT_TYPE[ext];
  if (!contentType) {
    throw new Error(`Unsupported staging upload extension: .${ext}`);
  }

  const stagingKey = projectUploadStagingKey(projectPath, filename, index);

  const { url, fields } = await createPresignedPost(s3Client, {
    Bucket: S3_BUCKET,
    Key: stagingKey,
    Fields: { "Content-Type": contentType },
    Conditions: [["content-length-range", 0, STAGING_MAX_BYTES]],
    Expires: PROJECT_UPLOAD_PRESIGN_TTL_SECONDS,
  });

  return { url, fields, stagingKey };
}

/**
 * HeadObject wrapper that returns existence + size without throwing on 404.
 * Used as the idempotency gate in processing.ts. It checks private S3 directly,
 * independent of the browser asset gateway and deny-all CloudFront viewer gate.
 */
export async function headS3Object(
  key: string,
  options?: { signal?: AbortSignal; versionId?: string },
): Promise<{
  exists: boolean;
  size?: number;
  versionId?: string;
  eTag?: string;
}> {
  try {
    const res = await s3Client.send(
      new HeadObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        ...(options?.versionId ? { VersionId: options.versionId } : {}),
      }),
      options?.signal ? { abortSignal: options.signal } : undefined,
    );
    return {
      exists: true,
      size: res.ContentLength,
      versionId: res.VersionId,
      eTag: res.ETag,
    };
  } catch (err: unknown) {
    const name = (
      err as { name?: string; $metadata?: { httpStatusCode?: number } }
    )?.name;
    const status = (err as { $metadata?: { httpStatusCode?: number } })
      ?.$metadata?.httpStatusCode;
    if (name === "NotFound" || name === "NoSuchKey" || status === 404) {
      return { exists: false };
    }
    throw err;
  }
}

/**
 * Fetch one object as a web stream for the same-origin project asset gateway.
 *
 * Project storage roots are private implementation details. Browser reads go
 * through an access-checked application route, which uses this helper instead
 * of exposing a bucket or CloudFront URL. `range` is forwarded verbatim only
 * after the gateway has validated the single-range syntax.
 */
export async function getS3ObjectStream(
  key: string,
  options: {
    range?: string;
    versionId?: string;
    signal?: AbortSignal;
  } = {},
): Promise<{
  body: ReadableStream<Uint8Array>;
  contentType?: string;
  contentLength?: number;
  contentRange?: string;
  eTag?: string;
  lastModified?: Date;
  /** Resolves on the underlying Node response's close event, not merely Web cancel initiation. */
  bodySettled?: Promise<void>;
}> {
  const res = await s3Client.send(
    new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      ...(options.versionId ? { VersionId: options.versionId } : {}),
      ...(options.range ? { Range: options.range } : {}),
    }),
    options.signal ? { abortSignal: options.signal } : undefined,
  );
  if (!res.Body) {
    throw new Error("S3 object response had no body");
  }
  const nodeBody = res.Body as unknown as {
    closed?: boolean;
    once?: (event: "close", listener: () => void) => unknown;
  };
  const bodySettled =
    typeof nodeBody.once === "function"
      ? nodeBody.closed
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            nodeBody.once!("close", resolve);
            // Close cannot fire between the synchronous check and listener registration, but a
            // custom Node-compatible body may expose an already-closed flag only after `.once()`.
            if (nodeBody.closed) resolve();
          })
      : undefined;
  return {
    body: res.Body.transformToWebStream(),
    contentType: res.ContentType,
    contentLength: res.ContentLength,
    contentRange: res.ContentRange,
    eTag: res.ETag,
    lastModified: res.LastModified,
    ...(bodySettled ? { bodySettled } : {}),
  };
}

/** Exact-version stream used by revocable Label Studio snapshot grants. */
export async function getS3ObjectVersionStream(
  key: string,
  versionId: string,
  signal?: AbortSignal,
): Promise<{
  body: ReadableStream<Uint8Array>;
  contentLength?: number;
  eTag?: string;
  lastModified?: Date;
}> {
  const res = await s3Client.send(
    new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      VersionId: versionId,
    }),
    signal ? { abortSignal: signal } : undefined,
  );
  if (!res.Body) throw new Error("S3 object response had no body");
  return {
    body: res.Body.transformToWebStream(),
    contentLength: res.ContentLength,
    eTag: res.ETag,
    lastModified: res.LastModified,
  };
}

function copySource(key: string, versionId: string): string {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${S3_BUCKET}/${encodedKey}?versionId=${encodeURIComponent(versionId)}`;
}

/**
 * Copy one canonical page version to a never-reused Label Studio snapshot key.
 * The destination stays the current version forever (until project-prefix
 * teardown), so S3's noncurrent-version expiry cannot break an old task.
 */
export async function copyS3ObjectVersion(
  sourceKey: string,
  sourceVersionId: string,
  destinationKey: string,
): Promise<string> {
  const existing = await headS3Object(destinationKey);
  if (existing.exists) {
    throw new Error("Label Studio snapshot key already exists");
  }
  const result = await s3Client.send(
    new CopyObjectCommand({
      Bucket: S3_BUCKET,
      Key: destinationKey,
      CopySource: copySource(sourceKey, sourceVersionId),
      MetadataDirective: "REPLACE",
      ContentType: "image/png",
      CacheControl: "private, no-store",
    }),
    { abortSignal: AbortSignal.timeout(30_000) },
  );
  if (!result.VersionId) {
    throw new Error(
      "Versioned Label Studio snapshot copy returned no VersionId",
    );
  }
  return result.VersionId;
}

/** Upload a unique tile snapshot without permitting a same-key overwrite. */
export async function uploadS3VersionedSnapshot(
  key: string,
  body: Buffer,
): Promise<string> {
  const result = await s3Client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: "image/png",
      CacheControl: "private, no-store",
      IfNoneMatch: "*",
    }),
    { abortSignal: AbortSignal.timeout(30_000) },
  );
  if (!result.VersionId) {
    throw new Error(
      "Versioned Label Studio snapshot upload returned no VersionId",
    );
  }
  return result.VersionId;
}

/**
 * Download a file from S3 as a Buffer.
 */
export async function downloadFromS3(
  key: string,
  versionId?: string,
): Promise<Buffer> {
  const res = await s3Client.send(
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: key, VersionId: versionId }),
  );
  return Buffer.from(await res.Body!.transformToByteArray());
}

/**
 * Upload a file buffer to private S3. CacheControl is retained as object
 * metadata for legacy/internal consumers; it does not grant browser access.
 * The project asset gateway always emits its own private, no-store policy.
 */
export async function uploadToS3(
  key: string,
  body: Buffer,
  contentType: string,
  cacheControl?: string,
): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: cacheControl || "public, max-age=86400",
    }),
  );
}

export interface S3PrefixPurgeResult {
  deletedObjects: number;
  emptySweepObserved: boolean;
}

export interface S3PrefixPurgeOptions {
  /** Called once, after listing finds objects but before the first destructive request. */
  onObjectsFound?: () => Promise<void>;
}

const PROJECT_PURGE_MAX_LIST_PAGES = 20;
const PROJECT_PURGE_MAX_SWEEPS = 4;
const PROJECT_PURGE_CALL_TIMEOUT_MS = 30_000;

async function deleteS3PrefixAllVersions(
  prefix: string,
  options: S3PrefixPurgeOptions = {},
): Promise<S3PrefixPurgeResult> {
  // Restart from the beginning after each complete sweep. That catches an object committed while
  // the preceding version listing was in flight. A durable deletion tombstone retries later if
  // sustained concurrent writes prevent a clean observation here.
  let deletedObjects = 0;
  let listPages = 0;
  let objectsAnnounced = false;
  for (let sweep = 0; sweep < PROJECT_PURGE_MAX_SWEEPS; sweep++) {
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    let foundThisSweep = 0;
    let truncated = false;

    do {
      listPages++;
      if (listPages > PROJECT_PURGE_MAX_LIST_PAGES) {
        throw new Error(
          `S3 version purge exceeded its ${PROJECT_PURGE_MAX_LIST_PAGES}-page attempt budget: ${prefix}`,
        );
      }
      const listed = await s3Client.send(
        new ListObjectVersionsCommand({
          Bucket: S3_BUCKET,
          Prefix: prefix,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
        }),
        { abortSignal: AbortSignal.timeout(PROJECT_PURGE_CALL_TIMEOUT_MS) },
      );
      const objects = [
        ...(listed.Versions ?? []),
        ...(listed.DeleteMarkers ?? []),
      ]
        .filter((item) => item.Key && item.VersionId)
        .map((item) => ({ Key: item.Key!, VersionId: item.VersionId! }));
      foundThisSweep += objects.length;

      if (objects.length > 0 && !objectsAnnounced) {
        // The outbox uses this hook to persist a new invalidation generation before deleting a
        // late final object. If the DB write fails or its lease was lost, no destructive S3 call
        // occurs and a later reconciler can safely retry.
        await options.onObjectsFound?.();
        objectsAnnounced = true;
      }

      for (let i = 0; i < objects.length; i += 1000) {
        const response = await s3Client.send(
          new DeleteObjectsCommand({
            Bucket: S3_BUCKET,
            Delete: { Objects: objects.slice(i, i + 1000), Quiet: true },
          }),
          { abortSignal: AbortSignal.timeout(PROJECT_PURGE_CALL_TIMEOUT_MS) },
        );
        if (response.Errors?.length) {
          const codes = [
            ...new Set(response.Errors.map((error) => error.Code ?? "Unknown")),
          ];
          throw new Error(
            `S3 version purge reported ${response.Errors.length} object error(s): ${codes.join(", ")}`,
          );
        }
        deletedObjects += objects.slice(i, i + 1000).length;
      }

      truncated = listed.IsTruncated === true;
      if (truncated) {
        const nextKeyMarker = listed.NextKeyMarker;
        const nextVersionIdMarker = listed.NextVersionIdMarker;
        if (
          !nextKeyMarker ||
          (nextKeyMarker === keyMarker &&
            nextVersionIdMarker === versionIdMarker)
        ) {
          throw new Error(
            `S3 version listing returned a missing or non-progressing continuation marker: ${prefix}`,
          );
        }
        keyMarker = nextKeyMarker;
        versionIdMarker = nextVersionIdMarker;
      } else {
        keyMarker = undefined;
        versionIdMarker = undefined;
      }
    } while (truncated);

    if (foundThisSweep === 0) {
      return { deletedObjects, emptySweepObserved: true };
    }
  }

  throw new Error(
    `S3 prefix remained non-empty after repeated version purges: ${prefix}`,
  );
}

/** Delete every current/noncurrent version and delete marker below a canonical project root. */
export async function deleteProjectFiles(
  projectPath: string,
  options: S3PrefixPurgeOptions = {},
): Promise<S3PrefixPurgeResult> {
  return deleteS3PrefixAllVersions(`${projectPath}/`, options);
}

/** Delete every isolated browser-staging version associated with a project root. */
export async function deleteProjectStagingFiles(
  projectPath: string,
): Promise<S3PrefixPurgeResult> {
  return deleteS3PrefixAllVersions(projectUploadStagingPrefix(projectPath));
}

/**
 * Generate a presigned POST for uploading a YOLO model .pt file directly to S3.
 */
export async function createModelUploadPresignedPost(modelName: string) {
  const s3Path = canonicalModelStoragePath(modelName);
  const key = `${s3Path}/model.pt`;

  const { url, fields } = await createPresignedPost(s3Client, {
    Bucket: S3_BUCKET,
    Key: key,
    Fields: { "Content-Type": "application/octet-stream" },
    Conditions: [
      ["content-length-range", 0, 500 * 1024 * 1024], // 500 MB max
    ],
    Expires: 900,
  });

  return { url, fields, key, s3Path };
}

/**
 * Generate a presigned GET URL for an S3 object.
 * Default 2h TTL. Browser project assets and Label Studio tasks deliberately use
 * their access-checked application gateways instead of persisting these URLs.
 */
export async function getPresignedGetUrl(
  key: string,
  expiresIn = 7200,
): Promise<string> {
  return getSignedUrl(
    s3Client,
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
    { expiresIn },
  );
}

export async function deleteFromS3(key: string): Promise<void> {
  const response = await s3Client.send(
    new DeleteObjectsCommand({
      Bucket: S3_BUCKET,
      Delete: { Objects: [{ Key: key }] },
    }),
  );
  if (response.Errors?.length) {
    throw new Error(
      `S3 delete reported an object error: ${response.Errors[0]?.Code ?? "Unknown"}`,
    );
  }
}

export { s3Client, S3_BUCKET };
