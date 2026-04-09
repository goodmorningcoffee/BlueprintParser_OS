import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
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

export function getS3Url(projectPath: string, filename: string): string {
  const cdnDomain = process.env.CLOUDFRONT_DOMAIN;
  if (cdnDomain) {
    return `https://${cdnDomain}/${projectPath}/${filename}`;
  }
  return `https://${S3_BUCKET}.s3.amazonaws.com/${projectPath}/${filename}`;
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
