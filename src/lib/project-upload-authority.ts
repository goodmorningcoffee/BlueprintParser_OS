/** Lifetime configured on every project-path presigned POST. */
export const PROJECT_UPLOAD_PRESIGN_TTL_SECONDS = 15 * 60;

/**
 * Browser-writable objects live outside every project's immutable asset prefix. A completed
 * presigned POST can therefore never replace `${projectPath}/original.pdf` (or any other asset
 * served for that project), even when S3 accepted the request immediately before policy expiry.
 */
export const PROJECT_UPLOAD_STAGING_ROOT = "_bp-staging";

const RESERVED_STORAGE_ROOTS = new Set([
  PROJECT_UPLOAD_STAGING_ROOT,
  "_bp-public",
  "models",
  "tmp",
  "config",
  "csi-databases",
]);

export function isSafeCompanyDataKey(dataKey: string): boolean {
  return /^[a-z0-9-]+$/.test(dataKey) && !RESERVED_STORAGE_ROOTS.has(dataKey);
}

export function isCanonicalProjectPath(
  dataKey: string,
  projectPath: string,
): boolean {
  if (!isSafeCompanyDataKey(dataKey)) return false;
  const prefix = `${dataKey}/`;
  return (
    projectPath.startsWith(prefix) &&
    /^[a-f0-9]{20}$/.test(projectPath.slice(prefix.length))
  );
}

export function projectUploadStagingPrefix(projectPath: string): string {
  return `${PROJECT_UPLOAD_STAGING_ROOT}/${projectPath}/`;
}

/** Keep browser-supplied names from introducing extra S3 path components. */
export function sanitizeProjectUploadFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() || "file";
  const scrubbed = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/_+/g, "_");
  return scrubbed.slice(0, 120) || "file";
}

/** The one canonical key derivation shared by the signer and project-create verifier. */
export function projectUploadStagingKey(
  projectPath: string,
  filename: string,
  index: number,
): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error("Invalid project upload staging index");
  }
  const idx3 = index.toString().padStart(3, "0");
  return `${projectUploadStagingPrefix(projectPath)}${idx3}_${sanitizeProjectUploadFilename(filename)}`;
}

/**
 * SigV4 policy expiry is minted from an application host clock while publication uses PostgreSQL's
 * clock. Retain a conservative drain window for transient uploads and pre-isolation credentials;
 * namespace separation, not this clock estimate, is the final-asset immutability boundary.
 */
export const PROJECT_UPLOAD_CLOCK_SKEW_SECONDS = 15 * 60;

export const PROJECT_UPLOAD_PUBLICATION_FENCE_SECONDS =
  PROJECT_UPLOAD_PRESIGN_TTL_SECONDS + PROJECT_UPLOAD_CLOCK_SKEW_SECONDS;
