export const MODEL_STORAGE_ROOT = "models";

export function canonicalModelSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

export function canonicalModelStoragePath(name: string): string {
  return `${MODEL_STORAGE_ROOT}/${canonicalModelSlug(name)}`;
}

export function isCanonicalModelStoragePath(
  name: string,
  s3Path: string,
): boolean {
  const slug = canonicalModelSlug(name);
  return slug.length > 0 && s3Path === `${MODEL_STORAGE_ROOT}/${slug}`;
}
