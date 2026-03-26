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

const S3_BUCKET = process.env.S3_BUCKET || "beaver-public";

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
 * Upload a file buffer to S3.
 */
export async function uploadToS3(
  key: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}

/**
 * Delete all S3 objects under a project path prefix.
 */
export async function deleteProjectFiles(projectPath: string): Promise<void> {
  const prefix = `${projectPath}/`;

  const listed = await s3Client.send(
    new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: prefix,
    })
  );

  if (!listed.Contents || listed.Contents.length === 0) return;

  await s3Client.send(
    new DeleteObjectsCommand({
      Bucket: S3_BUCKET,
      Delete: {
        Objects: listed.Contents.map((obj) => ({ Key: obj.Key! })),
        Quiet: true,
      },
    })
  );
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
 * Used for Label Studio image imports — 24h TTL.
 */
export async function getPresignedGetUrl(key: string, expiresIn = 7200): Promise<string> {
  return getSignedUrl(s3Client, new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }), { expiresIn });
}

export { S3_BUCKET };
