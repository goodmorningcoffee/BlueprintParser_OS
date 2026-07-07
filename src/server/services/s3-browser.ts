// [refactor jul7 S054] admin/s3-browser SOLO — list S3 objects / presign a download, folded
// from the legacy route (git show f096326:src/app/api/admin/s3-browser/route.ts). Char:
// __tests__/admin-s3-browser.route.test.ts (SB-*). requireAdmin (the shell provides
// auth:"admin"). Sanctioned diffs:
//   • A — flat auth → envelope; the three security 403 literals ("Access denied", "Access
//     denied: path outside company scope") stay byte-verbatim as ApiError("FORBIDDEN", …).
//   • B — both legacy catch-500s RETIRED: the list catch LEAKED err.message ({error:
//     err.message || "Failed to list S3 objects"}, DR002 :109) and the download catch returned
//     a fixed "Failed to generate download URL"; both now let the S3 error propagate → the
//     shell renders a generic INTERNAL 500 (no S3/IAM detail leak — a hardening).
//   • NO E — GET reads query params, not a body.
// ⚠️ SECURITY-LOAD-BEARING, preserved byte-exact: the WEIGHTS-2 fail-closed models/ backstop
// (no tenant may list/download weights; root exempt) + the anchored dataKey+"/" company scope.

import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { S3_BUCKET, getPresignedGetUrl } from "@/lib/s3";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { AuthSession } from "@/lib/api-utils";
import { ApiError } from "@/server/api/envelope";

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

export async function getS3Browser(req: Request, session: AuthSession): Promise<unknown> {
  const url = new URL(req.url);
  const prefix = url.searchParams.get("prefix") || "";
  const download = url.searchParams.get("download");

  const target = download || prefix;

  // Model weights live under models/ and are a root-managed asset. No tenant
  // (company-admin or member) may list or download them through the app — this
  // is the fail-closed backstop behind the s3Path redaction + CloudFront Deny
  // (weights-leak audit, finding 2). root_admin (the trusted owner) is exempt.
  if (!session.user.isRootAdmin && /^\/?models\//i.test(target)) {
    throw new ApiError("FORBIDDEN", "Access denied");
  }

  // Validate the target is within this company's data scope. Anchored match
  // (dataKey + "/") and fail-closed: previously a falsy dataKey skipped the
  // check entirely, and a bare startsWith let "ab" match "abc/...".
  const [company] = await db.select({ dataKey: companies.dataKey }).from(companies).where(eq(companies.id, session.user.companyId)).limit(1);
  if (!session.user.isRootAdmin && target) {
    if (!company?.dataKey || !target.startsWith(company.dataKey + "/")) {
      throw new ApiError("FORBIDDEN", "Access denied: path outside company scope");
    }
  }

  // If download requested, return presigned URL. [B] no try/catch — a presign
  // error propagates to the shell's generic INTERNAL 500 (legacy returned a
  // fixed "Failed to generate download URL"; retired).
  if (download) {
    const presignedUrl = await getPresignedGetUrl(download, 300); // 5 min
    return { url: presignedUrl };
  }

  // [B] no try/catch — a ListObjectsV2 error propagates to the shell's generic
  // INTERNAL 500 (legacy leaked err.message here; retired).
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

  return {
    prefix,
    bucket: S3_BUCKET,
    folders,
    files,
    isTruncated: result.IsTruncated || false,
  };
}
