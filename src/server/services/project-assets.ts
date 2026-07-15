import type { ProjectAccessRow } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { companies, projectMutationLeases, projects } from "@/lib/db/schema";
import {
  PDF_RANGE_PROBE_HEADER,
  PDF_RANGE_PROBE_UPSTREAM_RANGE,
  PDF_RANGE_PROBE_VALUE,
} from "@/lib/project-asset-transport";
import { isCanonicalProjectPath } from "@/lib/project-upload-authority";
import { getS3ObjectStream } from "@/lib/s3";
import { ApiError } from "@/server/api/envelope";
import { and, eq, or } from "drizzle-orm";

const PAGE_ASSET_RE = /^(?:pages|thumbnails)\/page_[0-9]{4}\.png$/;
const SINGLE_BYTE_RANGE_RE = /^bytes=(?:[0-9]+-[0-9]*|-[0-9]+)$/;
const PROBE_CONTENT_RANGE_RE = /^bytes 0-0\/([1-9][0-9]*)$/;

export function projectAssetBaseUrl(publicId: string): string {
  return `/api/project-assets/${encodeURIComponent(publicId)}`;
}

export function projectAssetUrl(publicId: string, asset: string): string {
  return `${projectAssetBaseUrl(publicId)}/${asset}`;
}

export function normalizeProjectAssetPath(raw: unknown): string {
  const segments = Array.isArray(raw) ? raw : [raw];
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        typeof segment !== "string" ||
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\") ||
        segment.includes("\0"),
    )
  ) {
    throw new ApiError("NOT_FOUND", "Asset not found");
  }

  const asset = (segments as string[]).join("/");
  if (
    asset !== "original.pdf" &&
    asset !== "thumbnail.png" &&
    !PAGE_ASSET_RE.test(asset)
  ) {
    throw new ApiError("NOT_FOUND", "Asset not found");
  }
  return asset;
}

function s3Status(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
}

function assetNotFound(): ApiError {
  return new ApiError("NOT_FOUND", "Asset not found");
}

/** Tie the upstream S3 reader to the browser request for the full response lifetime. */
function requestBoundBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  expectedLength?: number,
  upstreamSettled?: Promise<void>,
): {
  cancel: (reason?: unknown) => Promise<void>;
  stream: () => ReadableStream<Uint8Array>;
} {
  const reader = body.getReader();
  const exactLength =
    typeof expectedLength === "number" &&
    Number.isSafeInteger(expectedLength) &&
    expectedLength >= 0
      ? expectedLength
      : null;
  let bytesRead = 0;
  let listening = true;
  let settled = false;
  let streamCreated = false;
  let cancelPromise: Promise<void> | null = null;
  const detach = () => {
    if (!listening) return;
    listening = false;
    signal.removeEventListener("abort", abort);
  };
  const cancelUpstream = (reason?: unknown): Promise<void> => {
    if (!cancelPromise) {
      // Cancellation is best-effort: an already-errored SDK body may reject its cancel algorithm.
      // Share and absorb one settlement so completion, browser abort, and downstream cancel cannot
      // race multiple teardown attempts or leave a rejection detached from the response lifetime.
      const cancelStarted = reader.cancel(reason).catch(() => undefined);
      cancelPromise = Promise.all([
        cancelStarted,
        ...(upstreamSettled ? [upstreamSettled.catch(() => undefined)] : []),
      ])
        .then(() => undefined)
        .finally(detach);
    }
    return cancelPromise;
  };
  const abort = () => {
    void cancelUpstream(signal.reason);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();

  const stream = (): ReadableStream<Uint8Array> => {
    if (streamCreated) {
      throw new Error("Project asset response body was already materialized");
    }
    streamCreated = true;
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        if (exactLength !== 0) return;
        await cancelUpstream();
        if (!settled) {
          settled = true;
          controller.close();
        }
      },
      async pull(controller) {
        if (settled) return;
        if (signal.aborted) {
          await cancelUpstream(signal.reason);
          if (!settled) {
            settled = true;
            controller.close();
          }
          return;
        }
        try {
          const chunk = await reader.read();
          if (signal.aborted) {
            await cancelUpstream(signal.reason);
            if (!settled) {
              settled = true;
              controller.close();
            }
            return;
          }
          if (chunk.done) {
            if (exactLength !== null && bytesRead !== exactLength) {
              const error = new Error(
                `S3 project asset body ended at ${bytesRead} of ${exactLength} bytes`,
              );
              await cancelUpstream(error);
              if (!settled) {
                settled = true;
                controller.error(error);
              }
              return;
            }
            if (upstreamSettled) await upstreamSettled;
            detach();
            settled = true;
            controller.close();
          } else {
            const nextBytesRead = bytesRead + chunk.value.byteLength;
            if (exactLength !== null && nextBytesRead > exactLength) {
              const error = new Error(
                `S3 project asset body exceeded its ${exactLength}-byte length`,
              );
              await cancelUpstream(error);
              if (!settled) {
                settled = true;
                controller.error(error);
              }
              return;
            }
            // HTTP consumers are entitled to stop pulling after Content-Length bytes. Do not
            // expose the final framed bytes until the upstream Node body has actually closed: a
            // client can treat Content-Length completion as EOF without observing controller.close().
            if (exactLength !== null && nextBytesRead === exactLength) {
              await cancelUpstream();
              if (signal.aborted) {
                if (!settled) {
                  settled = true;
                  controller.close();
                }
                return;
              }
              if (!settled) {
                bytesRead = nextBytesRead;
                controller.enqueue(chunk.value);
                settled = true;
                controller.close();
              }
            } else {
              bytesRead = nextBytesRead;
              controller.enqueue(chunk.value);
            }
          }
        } catch (error) {
          await cancelUpstream(error);
          if (!settled) {
            settled = true;
            controller.error(error);
          }
        }
      },
      async cancel(reason) {
        settled = true;
        await cancelUpstream(reason);
      },
    });
  };

  return {
    async cancel(reason) {
      settled = true;
      await cancelUpstream(reason);
    },
    stream,
  };
}

/**
 * Revalidate an access-engine snapshot at one serialized admission point.
 *
 * The project SHARE lock orders this read against every supported lifecycle,
 * deletion, processing, and reprocess path (those acquire the parent FOR
 * UPDATE before changing authority). The company join also rejects legacy
 * rows whose storage root does not satisfy migration 0033's validated
 * namespace constraint.
 */
export async function assertCurrentProjectAssetRead(
  project: ProjectAccessRow,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        publicId: projects.publicId,
        companyId: projects.companyId,
        companyDataKey: companies.dataKey,
        isDemo: projects.isDemo,
        dataUrl: projects.dataUrl,
        status: projects.status,
        lifecycleEpoch: projects.lifecycleEpoch,
      })
      .from(projects)
      .innerJoin(companies, eq(companies.id, projects.companyId))
      .where(eq(projects.id, project.id))
      .for("share")
      .limit(1);

    if (
      !current ||
      current.publicId !== project.publicId ||
      current.companyId !== project.companyId ||
      current.isDemo !== project.isDemo ||
      current.dataUrl !== project.dataUrl ||
      current.status !== "completed" ||
      current.lifecycleEpoch !== project.lifecycleEpoch ||
      !isCanonicalProjectPath(current.companyDataKey, current.dataUrl)
    ) {
      throw assetNotFound();
    }

    const [assetWriter] = await tx
      .select({ token: projectMutationLeases.token })
      .from(projectMutationLeases)
      .where(
        and(
          eq(projectMutationLeases.projectId, project.id),
          eq(projectMutationLeases.status, "active"),
          or(
            eq(projectMutationLeases.kind, "project-processing"),
            eq(projectMutationLeases.kind, "admin-reprocess:thumbnails"),
          ),
        ),
      )
      .limit(1);
    if (assetWriter) throw assetNotFound();
  });
}

/** Apply the private, identity-varying policy to successes and every error path. */
export function withProjectAssetResponsePolicy(
  response: Response,
  options: { pdfRangeProbe?: boolean } = {},
): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set(
    "Vary",
    options.pdfRangeProbe
      ? "Cookie, Authorization, Range, X-BlueprintParser-PDF-Range-Probe"
      : "Cookie, Authorization, Range",
  );
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Same-origin, access-checked delivery for the four browser-visible project
 * asset families. The route passes only a project already resolved by the
 * canonical access engine; canonical S3 roots never cross the wire.
 *
 * Responses deliberately override the object's historical one-year cache
 * metadata. Until every rebuild is generation-qualified, storing these stable
 * application URLs could mix old and new pages or outlive demo withdrawal.
 */
export async function serveProjectAsset(
  req: Request,
  project: ProjectAccessRow,
  rawAsset: unknown,
): Promise<Response> {
  const asset = normalizeProjectAssetPath(rawAsset);
  const requestedRange = req.headers.get("range") ?? undefined;
  if (requestedRange && !SINGLE_BYTE_RANGE_RE.test(requestedRange)) {
    return new Response(null, {
      status: 416,
      headers: {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
      },
    });
  }

  // pdf.js' un-ranged request is only a range-capability probe when the viewer
  // explicitly marks it. Bound the S3 side to one byte so reverse-proxy/socket
  // buffering cannot race a downstream AbortSignal and drain megabytes. The
  // client still receives the authoritative full length below and immediately
  // switches to its normal 1 MiB Range requests. Unmarked downloads keep the
  // ordinary full-object behavior.
  const isPdfRangeProbe =
    asset === "original.pdf" &&
    requestedRange === undefined &&
    req.headers.get(PDF_RANGE_PROBE_HEADER) === PDF_RANGE_PROBE_VALUE;
  const upstreamRange = isPdfRangeProbe
    ? PDF_RANGE_PROBE_UPSTREAM_RANGE
    : requestedRange;

  // Reject an unproven legacy root before it can become an S3 read capability.
  // This also avoids fetching while a known asset writer is active.
  await assertCurrentProjectAssetRead(project);

  let object;
  try {
    object = await getS3ObjectStream(`${project.dataUrl}/${asset}`, {
      range: upstreamRange,
      signal: req.signal,
    });
  } catch (error) {
    // Browser navigation commonly cancels pdf.js' initial range-capability probe. The client is
    // already gone; acknowledge that cancellation without routing it through 500/error telemetry.
    if (req.signal.aborted) {
      return new Response(null, {
        status: 499,
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    const status = s3Status(error);
    if (status === 404) {
      throw new ApiError("NOT_FOUND", "Asset not found");
    }
    if (status === 416) {
      return new Response(null, {
        status: 416,
        headers: {
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, no-store",
        },
      });
    }
    throw error;
  }

  let advertisedContentLength = object.contentLength;
  if (isPdfRangeProbe) {
    const match = object.contentRange
      ? PROBE_CONTENT_RANGE_RE.exec(object.contentRange)
      : null;
    const total = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(total) || total <= 0) {
      await object.body.cancel().catch(() => undefined);
      throw new Error("S3 PDF range probe returned no authoritative total");
    }
    advertisedContentLength = total;
  }

  const boundBody = requestBoundBody(
    object.body,
    req.signal,
    object.contentLength,
    object.bodySettled,
  );
  try {
    // S3 acquisition can take arbitrarily longer than access resolution. Make
    // response admission linearizable after that external wait: a withdrawal,
    // deletion, status change, or rebuild that won first is now observed; a
    // supported writer that starts later waits behind this lock.
    await assertCurrentProjectAssetRead(project);
    if (req.signal.aborted) {
      await boundBody.cancel(req.signal.reason);
      return new Response(null, {
        status: 499,
        headers: { "Cache-Control": "private, no-store" },
      });
    }

    const headers = new Headers({
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      // Never trust mutable S3 metadata on a same-origin response. The path
      // allowlist defines the only two media types this endpoint can emit.
      "Content-Type":
        asset === "original.pdf" ? "application/pdf" : "image/png",
      "X-Content-Type-Options": "nosniff",
      Vary: "Cookie, Authorization, Range, X-BlueprintParser-PDF-Range-Probe",
    });
    if (advertisedContentLength !== undefined) {
      headers.set("Content-Length", String(advertisedContentLength));
    }
    // The upstream probe range is an implementation detail, not a response to a
    // browser Range header. Only client-requested ranges receive a 206 contract.
    if (object.contentRange && requestedRange) {
      headers.set("Content-Range", object.contentRange);
    }
    if (object.eTag) headers.set("ETag", object.eTag);
    if (object.lastModified) {
      headers.set("Last-Modified", object.lastModified.toUTCString());
    }

    return new Response(boundBody.stream(), {
      status: requestedRange && object.contentRange ? 206 : 200,
      headers,
    });
  } catch (error) {
    await boundBody.cancel(error);
    throw error;
  }
}
