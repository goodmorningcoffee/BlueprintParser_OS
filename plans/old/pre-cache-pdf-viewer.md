# PDF Viewer Pre-Cache Tool

## Date: March 31, 2026
## Status: Ready for Implementation
## Effort: ~40 lines of code

---

## Problem

New projects feel slow when opened for the first time. Old projects (previously opened) feel fast.

## Root Cause

All S3 assets (PDF, page PNGs, thumbnails) are cold in CloudFront edge cache for new projects. `uploadToS3()` (s3.ts:64-77) sets NO Cache-Control headers — only ContentType. This means:

- CloudFront uses a short default TTL for objects without explicit Cache-Control
- Browser caching behavior is unpredictable without cache headers
- Every first-visit request goes to S3 origin (~100-500ms per asset)
- For a 40-page project: 40+ cold thumbnail fetches + page PNGs + PDF range requests

Old projects are fast because the browser disk cache has everything from a previous visit.

## What We're NOT Changing

- pdf.js already uses range requests (S3 supports `Accept-Ranges: bytes`) — it doesn't download the full PDF
- PNG fallback already works (shows static image while canvas renders)
- Chunked loading already works (15-page sliding window)

---

## The Fix

### Step 1: Cache-Control Headers on S3 Uploads (~5 lines)

**File: `src/lib/s3.ts`**

Add `CacheControl` parameter to `uploadToS3()`:

```typescript
export async function uploadToS3(
  key: string,
  body: Buffer,
  contentType: string,
  cacheControl?: string
): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: cacheControl || 'public, max-age=86400',
    })
  );
}
```

**File: `src/lib/processing.ts`**

Update calls to pass cache headers:
- Page PNGs: `'public, max-age=31536000, immutable'` (1 year, never changes)
- Thumbnails: `'public, max-age=31536000, immutable'`
- thumbnail.png: `'public, max-age=31536000, immutable'`

The original.pdf upload uses presigned POST (s3.ts:29-41), which doesn't go through `uploadToS3()`. We can set default cache on the bucket or handle it separately.

**Effect:**
- CloudFront respects max-age and caches at edge for the TTL
- Browser caches locally and doesn't revalidate (immutable flag)
- Second visit from any browser = instant load from CF edge

### Step 2: CloudFront Warming After Processing (~30 lines)

**File: `src/lib/s3.ts`** — New function:

```typescript
export async function warmCloudFrontCache(
  projectPath: string,
  numPages: number
): Promise<void> {
  const cfDomain = process.env.CLOUDFRONT_DOMAIN;
  if (!cfDomain) return; // Skip if no CloudFront configured

  const urls: string[] = [];

  // PDF
  urls.push(`https://${cfDomain}/${projectPath}/original.pdf`);

  // Page PNGs + thumbnails for all pages
  for (let i = 1; i <= numPages; i++) {
    const key = String(i).padStart(4, '0');
    urls.push(`https://${cfDomain}/${projectPath}/pages/page_${key}.png`);
    urls.push(`https://${cfDomain}/${projectPath}/thumbnails/page_${key}.png`);
  }

  // Fire HEAD requests in parallel (batched to avoid overwhelming)
  const BATCH_SIZE = 20;
  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    const batch = urls.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(
      batch.map(url => fetch(url, { method: 'HEAD' }).catch(() => {}))
    );
  }
}
```

**File: `src/lib/processing.ts`** — Call at end of `processProject()`:

```typescript
// After all pages processed and summaries computed:
await warmCloudFrontCache(project.dataUrl, project.numPages);
```

**Effect:**
- Runs server-side from ECS (same AWS region as S3) → origin fetch is fast (~20ms per object)
- Pulls all assets into CloudFront edge cache
- User's first visit hits edge cache (~10-50ms) instead of origin (~200-500ms)

### Step 3 (Optional): Backfill Existing Projects

**File: `scripts/backfill-cache-headers.ts`**

One-time script to set Cache-Control on existing S3 objects using CopyObject with metadata replacement.

---

## Files Changed

```
src/lib/s3.ts              — CacheControl param on PutObjectCommand + warmCloudFrontCache()
src/lib/processing.ts      — pass cache headers to uploads + call warming at end
```

## Verification

1. Upload new project → wait for processing → open immediately
2. DevTools Network tab → check Response Headers:
   - `cache-control: public, max-age=31536000, immutable` on PNGs
   - `x-cache: Hit from cloudfront` (if CF warming worked)
3. Compare load feel: before vs after for same-size blueprints
4. Revisit same project → should be instant (browser cache)
