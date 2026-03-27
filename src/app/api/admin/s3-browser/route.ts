import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { S3_BUCKET, getPresignedGetUrl } from "@/lib/s3";

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  ...(process.env.AWS_ACCESS_KEY_ID && {
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  }),
});

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * GET /api/admin/s3-browser?prefix=companyKey/projectHash/
 * List S3 objects under a prefix. Admin only.
 * Security: validates prefix starts with the admin's company data key.
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const url = new URL(req.url);
  const prefix = url.searchParams.get("prefix") || "";
  const download = url.searchParams.get("download");

  // If download requested, return presigned URL
  if (download) {
    try {
      const presignedUrl = await getPresignedGetUrl(download, 300); // 5 min
      return NextResponse.json({ url: presignedUrl });
    } catch {
      return NextResponse.json({ error: "Failed to generate download URL" }, { status: 500 });
    }
  }

  try {
    const command = new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: prefix || undefined,
      Delimiter: "/",
      MaxKeys: 200,
    });

    const result = await s3Client.send(command);

    // Folders (common prefixes)
    const folders = (result.CommonPrefixes || []).map((cp) => ({
      key: cp.Prefix || "",
      name: (cp.Prefix || "").replace(prefix, "").replace(/\/$/, ""),
      isFolder: true,
      size: null,
      lastModified: null,
    }));

    // Files
    const files = (result.Contents || [])
      .filter((obj) => obj.Key !== prefix) // exclude the prefix itself
      .map((obj) => ({
        key: obj.Key || "",
        name: (obj.Key || "").replace(prefix, ""),
        isFolder: false,
        size: humanSize(obj.Size || 0),
        sizeBytes: obj.Size || 0,
        lastModified: obj.LastModified?.toISOString() || null,
      }));

    return NextResponse.json({
      prefix,
      bucket: S3_BUCKET,
      folders,
      files,
      isTruncated: result.IsTruncated || false,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to list S3 objects" },
      { status: 500 }
    );
  }
}
