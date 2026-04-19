import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  ...(process.env.AWS_ACCESS_KEY_ID && {
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  }),
});

const S3_BUCKET = process.env.S3_BUCKET ?? "";

export function generateProjectPath(companyDataKey: string): string {
  const projectId = crypto.randomBytes(10).toString("hex");
  return `${companyDataKey}/${projectId}`;
}

export async function createUploadPresignedPost(projectPath: string) {
  const key = `${projectPath}/original.pdf`;

  const { url, fields } = await createPresignedPost(s3Client, {
    Bucket: S3_BUCKET,
    Key: key,
    Fields: { "Content-Type": "application/pdf" },
    Conditions: [["content-length-range", 0, 100 * 1024 * 1024]], // 100 MB max
    Expires: 900,
  });

  return { url, fields, key, projectPath };
}

// ─── Multi-file staging upload ───────────────────────────────
// Files land in ${projectPath}/staging/${idx3}_${safeFilename} then get
// concatenated into ${projectPath}/original.pdf by processing.ts pre-stage.

const STAGING_MAX_BYTES = 250 * 1024 * 1024; // 250 MB per file

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
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() || "file";
  const scrubbed = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/_+/g, "_");
  return scrubbed.slice(0, 120) || "file";
}

export async function createStagingUploadPresignedPost(
  projectPath: string,
  filename: string,
  index: number,
): Promise<{ url: string; fields: Record<string, string>; stagingKey: string }> {
  const ext = extensionFromFilename(filename);
  const contentType = STAGING_CONTENT_TYPE[ext];
  if (!contentType) {
    throw new Error(`Unsupported staging upload extension: .${ext}`);
  }

  const safe = sanitizeFilename(filename);
  const idx3 = index.toString().padStart(3, "0");
  const stagingKey = `${projectPath}/staging/${idx3}_${safe}`;

  const { url, fields } = await createPresignedPost(s3Client, {
    Bucket: S3_BUCKET,
    Key: stagingKey,
    Fields: { "Content-Type": contentType },
    Conditions: [["content-length-range", 0, STAGING_MAX_BYTES]],
    Expires: 900,
  });

  return { url, fields, stagingKey };
}

/**
 * HeadObject wrapper that returns existence + size without throwing on 404.
 * Used as the idempotency gate in processing.ts (avoids CloudFront 404-cache
 * poisoning by going straight to S3).
 */
export async function headS3Object(
  key: string,
): Promise<{ exists: boolean; size?: number }> {
  try {
    const res = await s3Client.send(
      new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }),
    );
    return { exists: true, size: res.ContentLength };
  } catch (err: unknown) {
    const name = (err as { name?: string; $metadata?: { httpStatusCode?: number } })?.name;
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (name === "NotFound" || name === "NoSuchKey" || status === 404) {
      return { exists: false };
    }
    throw err;
  }
}

export function getS3Url(projectPath: string, filename: string): string {
  // encodeURI preserves path separators (/) but escapes spaces and special chars
  // that would make fetch() throw "The string did not match the expected pattern"
  const encodedPath = encodeURI(projectPath);
  const encodedFile = encodeURI(filename);
  const cdnDomain = process.env.CLOUDFRONT_DOMAIN;
  if (cdnDomain) {
    return `https://${cdnDomain}/${encodedPath}/${encodedFile}`;
  }
  return `https://${S3_BUCKET}.s3.amazonaws.com/${encodedPath}/${encodedFile}`;
}

/**
 * Download a file from S3 as a Buffer.
 */
export async function downloadFromS3(key: string): Promise<Buffer> {
  const res = await s3Client.send(
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: key })
  );
  return Buffer.from(await res.Body!.transformToByteArray());
}

/**
 * Upload a file buffer to S3.
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
    })
  );
}

/**
 * Delete all S3 objects under a project path prefix.
 */
export async function deleteProjectFiles(projectPath: string): Promise<void> {
  const prefix = `${projectPath}/`;
  let continuationToken: string | undefined;

  do {
    const listed = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    if (!listed.Contents || listed.Contents.length === 0) break;

    // DeleteObjectsCommand accepts max 1000 keys per call
    for (let i = 0; i < listed.Contents.length; i += 1000) {
      const batch = listed.Contents.slice(i, i + 1000);
      await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: S3_BUCKET,
          Delete: {
            Objects: batch.map((obj) => ({ Key: obj.Key! })),
            Quiet: true,
          },
        })
      );
    }

    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
}

/**
 * Generate a presigned POST for uploading a YOLO model .pt file directly to S3.
 */
export async function createModelUploadPresignedPost(modelSlug: string) {
  const s3Path = `models/${modelSlug}`;
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
 * Default 2h TTL. Callers can override (e.g. 604800 for 7-day labeling URLs).
 */
export async function getPresignedGetUrl(key: string, expiresIn = 7200): Promise<string> {
  return getSignedUrl(s3Client, new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }), { expiresIn });
}

export async function deleteFromS3(key: string): Promise<void> {
  await s3Client.send(
    new DeleteObjectsCommand({
      Bucket: S3_BUCKET,
      Delete: { Objects: [{ Key: key }] },
    })
  );
}

/**
 * Warm CloudFront edge cache by issuing HEAD requests for all project assets.
 * Runs server-side from ECS (same AWS region as S3) so origin fetch is fast.
 * Skips silently if CLOUDFRONT_DOMAIN is not configured.
 */
export async function warmCloudFrontCache(
  projectPath: string,
  numPages: number,
): Promise<void> {
  const cfDomain = process.env.CLOUDFRONT_DOMAIN;
  if (!cfDomain) return;

  const urls: string[] = [];
  for (let i = 1; i <= numPages; i++) {
    const key = String(i).padStart(4, "0");
    urls.push(`https://${cfDomain}/${projectPath}/pages/page_${key}.png`);
    urls.push(`https://${cfDomain}/${projectPath}/thumbnails/page_${key}.png`);
  }

  const BATCH = 20;
  for (let i = 0; i < urls.length; i += BATCH) {
    await Promise.allSettled(
      urls.slice(i, i + BATCH).map((url) => fetch(url, { method: "HEAD" }).catch(() => {})),
    );
  }
}

export { s3Client, S3_BUCKET };
