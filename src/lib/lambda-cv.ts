/**
 * lambda-cv.ts — Lambda fan-out orchestrator for CV pipeline.
 *
 * Generic orchestrator used by both symbol search and shape parse routes
 * to distribute page processing across parallel Lambda invocations.
 *
 * Workflow: partition pages → invoke Lambdas → collect results from S3 →
 * retry failures → clean up temp S3 prefix.
 *
 * Feature-flagged: if LAMBDA_CV_ENABLED !== "true", callers fall back to
 * local Python child_process execution.
 */

import {
  LambdaClient,
  InvokeCommand,
} from "@aws-sdk/client-lambda";
import { uploadToS3, downloadFromS3, deleteProjectFiles } from "@/lib/s3";
import { logger } from "@/lib/logger";
import type {
  TemplateMatchHit,
  KeynoteShapeData,
  BboxLTWH,
} from "@/types";

// One page per Lambda invocation. Lambda has 2GB (or more, if bumped via
// `aws lambda update-function-configuration --memory-size N`). A single
// full-size construction page at 300 DPI plus Tesseract OCR + OpenCV
// intermediates can approach that ceiling; packing multiple pages into
// one invocation historically caused SIGKILLs. Batching is still useful
// on tiny-page projects — override via env var to re-batch for cost.
export const TEMPLATE_MATCH_BATCH_SIZE = parseInt(process.env.LAMBDA_CV_BATCH_SIZE || "1", 10);
export const SHAPE_PARSE_BATCH_SIZE = 1;

let lambdaClient: LambdaClient | null = null;

function getLambdaClient(): LambdaClient {
  if (!lambdaClient) {
    lambdaClient = new LambdaClient({
      region: process.env.AWS_REGION || "us-east-1",
      ...(process.env.AWS_ACCESS_KEY_ID && {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        },
      }),
    });
  }
  return lambdaClient;
}

export function isLambdaCvEnabled(): boolean {
  return (
    process.env.LAMBDA_CV_ENABLED === "true" &&
    !!process.env.LAMBDA_CV_FUNCTION_NAME
  );
}

function functionName(): string {
  return process.env.LAMBDA_CV_FUNCTION_NAME || "beaver-cv-pipeline";
}

function s3Bucket(): string {
  return process.env.S3_BUCKET || "";
}

// ═══════════════════════════════════════════════════════════════════
// Generic fan-out core
// ═══════════════════════════════════════════════════════════════════
//
// [fix 2026-10-21 reprocess-persistence] Owner: "we want the fan out to work thats the point of
// having lambda". The old core could not tell "this page was scanned and has no shapes" from
// "this page was never scanned": a result file it could not read became zero rows, a retry
// failure was swallowed by a bare `catch {}`, and callers only ever looked at `results`. Every
// page now lands in exactly one of `okPages` (scanned, results — possibly none — are real) or
// `failedPages` (with a reason in `pageErrors`), and every invocation is reported through
// `onInvocation` so the admin debug stream can print what actually happened.

/** One Lambda invocation, as the admin debug stream prints it. No signed URLs, no credentials. */
export interface LambdaInvocationDiag {
  action: string;
  functionName: string;
  batchIdx: number;
  attempt: "batch" | "retry";
  /** Page FILE names only (page_0001.png) — the storage prefix is not printed. */
  pages: string[];
  ok: boolean;
  durationMs: number;
  /** The handler's own `status` ("success" | "partial" | "error"), when it returned one. */
  lambdaStatus?: string;
  /** AWS FunctionError ("Unhandled" = crash/timeout/OOM), when the runtime reported one. */
  functionError?: string;
  resultKey: string;
  resultFound: boolean;
  resultCount: number;
  /** match_count the handler reported; a mismatch with resultCount is a contract break. */
  reportedCount?: number;
  okPages: number;
  failedPages: number;
  error?: string;
}

interface FanOutOpts<T> {
  action: string;
  batchSize: number;
  pageS3Keys: string[];
  jobId?: string;
  extraPayload?: Record<string, unknown>;
  config?: Record<string, unknown>;
  resultMapper: (r: any) => T;
  onBatchComplete?: (batchIdx: number, count: number) => void;
  onInvocation?: (diag: LambdaInvocationDiag) => void;
}

export interface FanOutResult<T> {
  results: (T & { pageS3Key: string })[];
  failedPages: string[];
  warnings: string[];
  /** Pages the Lambda confirmed it scanned. A page here with no results genuinely has none. */
  okPages: string[];
  /** Why each failed page failed (last error seen for it). */
  pageErrors: Record<string, string>;
}

function assertLambdaOk(resp: any): void {
  if (resp?.status === "error") {
    throw new Error(resp.error || "Lambda returned error status");
  }
}

/** Thrown by invokeLambda when the runtime reports FunctionError (crash, timeout, OOM, import error). */
class LambdaFunctionError extends Error {
  constructor(readonly functionError: string, message: string) {
    super(message);
  }
}

function pageFileName(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface InvocationOutcome<T> {
  mapped: (T & { pageS3Key: string })[];
  warnings: string[];
  okPages: string[];
  failed: Record<string, string>;
}

/** Max invocations in flight at once (the SDK's default socket pool is 50 per host). */
function maxConcurrency(): number {
  const n = parseInt(process.env.LAMBDA_CV_MAX_CONCURRENCY || "50", 10);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

/**
 * One invocation: invoke → check status → read the result file → split the pages into ok / failed.
 * Throws when the invocation as a whole produced nothing usable, so the caller can retry per page.
 */
async function invokeOnce<T>(
  opts: FanOutOpts<T>,
  bucket: string,
  jobId: string,
  pageKeys: string[],
  resultKey: string,
  batchIdx: number,
  attempt: "batch" | "retry",
): Promise<InvocationOutcome<T>> {
  const started = Date.now();
  const diag: LambdaInvocationDiag = {
    action: opts.action, functionName: functionName(), batchIdx, attempt,
    pages: pageKeys.map(pageFileName), ok: false, durationMs: 0,
    resultKey, resultFound: false, resultCount: 0, okPages: 0, failedPages: pageKeys.length,
  };
  try {
    const resp = await invokeLambda({
      action: opts.action,
      job_id: jobId,
      s3_bucket: bucket,
      page_s3_keys: pageKeys,
      result_s3_key: resultKey,
      config: opts.config || {},
      ...opts.extraPayload,
    });
    diag.lambdaStatus = typeof resp?.status === "string" ? resp.status : undefined;
    if (typeof resp?.match_count === "number") diag.reportedCount = resp.match_count;
    assertLambdaOk(resp);
    let parsed: any;
    try {
      parsed = JSON.parse((await downloadFromS3(resultKey)).toString("utf-8"));
    } catch (err) {
      throw new Error(`Result file s3://${bucket}/${resultKey} unreadable after a successful invoke: ${errMessage(err)}`);
    }
    diag.resultFound = true;
    const rows: any[] = Array.isArray(parsed?.results) ? parsed.results : [];
    const mapped: (T & { pageS3Key: string })[] = [];
    for (const r of rows) {
      if (typeof r?.page_s3_key !== "string" || !pageKeys.includes(r.page_s3_key)) continue;
      mapped.push({ ...opts.resultMapper(r), pageS3Key: r.page_s3_key });
    }
    diag.resultCount = mapped.length;
    const warnings: string[] = Array.isArray(parsed?.warnings) ? [...parsed.warnings] : [];
    if (diag.reportedCount !== undefined && diag.reportedCount !== mapped.length) {
      warnings.push(
        `Lambda reported ${diag.reportedCount} results but ${mapped.length} were read back from ${resultKey}`,
      );
    }
    // Per-page status: the handler lists the pages it scanned (pages_ok) and why the others
    // failed (page_errors). An older handler without those lists is only trusted when it
    // reports full success; on "partial" its unlisted pages are retried individually.
    const listed: unknown = parsed?.pages_ok ?? resp?.pages_ok;
    const pageErrors: Record<string, string> =
      parsed?.page_errors && typeof parsed.page_errors === "object" ? parsed.page_errors : {};
    const okSet = new Set<string>(
      Array.isArray(listed)
        ? listed.filter((k): k is string => typeof k === "string" && pageKeys.includes(k))
        : resp?.status === "success" || resp?.status === undefined
          ? pageKeys
          : mapped.map((m) => m.pageS3Key),
    );
    const failed: Record<string, string> = {};
    for (const key of pageKeys) {
      if (!okSet.has(key)) failed[key] = String(pageErrors[key] ?? "Lambda did not report this page as scanned");
    }
    diag.ok = true;
    diag.okPages = okSet.size;
    diag.failedPages = Object.keys(failed).length;
    return { mapped: mapped.filter((m) => okSet.has(m.pageS3Key)), warnings, okPages: [...okSet], failed };
  } catch (err) {
    // Debug lines carry page basenames only, never the project storage prefix.
    diag.error = pageKeys.reduce((m, k) => m.split(k).join(k.slice(k.lastIndexOf("/") + 1)), errMessage(err));
    if (err instanceof LambdaFunctionError) diag.functionError = err.functionError;
    throw err;
  } finally {
    diag.durationMs = Date.now() - started;
    try {
      opts.onInvocation?.(diag);
    } catch {
      /* a diagnostics sink (e.g. a closed client stream) must never fail the fan-out */
    }
  }
}

async function fanOut<T>(opts: FanOutOpts<T>): Promise<FanOutResult<T>> {
  const bucket = s3Bucket();
  if (!bucket) throw new Error("S3_BUCKET env var is not set — cannot fan out to Lambda");
  const jobId = opts.jobId || crypto.randomUUID();

  try {
    const batches = partition(opts.pageS3Keys, opts.batchSize);

    // Each batch settles on its own so onBatchComplete fires as that batch settles, not after
    // all batches finish — the caller's stream flushes progress in real time. A small pool caps
    // invocations in flight so a 300-page project does not throttle itself into retries.
    const runBatch = async (batch: string[], idx: number): Promise<InvocationOutcome<T>> => {
      const primaryResultKey = `tmp/cv-jobs/${jobId}/results/batch_${idx}.json`;
      let outcome: InvocationOutcome<T>;
      let retryKeys: string[];
      try {
        outcome = await invokeOnce(opts, bucket, jobId, batch, primaryResultKey, idx, "batch");
        retryKeys = batch.length > 1 ? Object.keys(outcome.failed) : [];
      } catch (err) {
        // SDK threw (network, throttle, AccessDenied, missing function), the runtime reported
        // FunctionError (timeout, OOM, import error), the handler returned {status:"error"}, or
        // the result file could not be read. Retry each page alone.
        logger.warn(`[LAMBDA_CV] ${opts.action} batch ${idx} failed: ${errMessage(err)}`);
        outcome = { mapped: [], warnings: [], okPages: [], failed: {} };
        for (const key of batch) outcome.failed[key] = errMessage(err);
        retryKeys = batch;
      }
      for (const pageKey of retryKeys) {
        const retryKey = `tmp/cv-jobs/${jobId}/results/retry_${pageKey.replace(/\//g, "_")}.json`;
        try {
          const retry = await invokeOnce(opts, bucket, jobId, [pageKey], retryKey, idx, "retry");
          outcome.mapped.push(...retry.mapped);
          outcome.warnings.push(...retry.warnings);
          if (retry.okPages.includes(pageKey)) {
            outcome.okPages.push(pageKey);
            delete outcome.failed[pageKey];
          } else {
            outcome.failed[pageKey] = retry.failed[pageKey] ?? outcome.failed[pageKey];
          }
        } catch (err) {
          outcome.failed[pageKey] = errMessage(err);
          logger.warn(`[LAMBDA_CV] ${opts.action} retry failed for ${pageFileName(pageKey)}: ${errMessage(err)}`);
        }
      }
      // A closed client stream (caller's controller) must not turn into a retry storm.
      try {
        opts.onBatchComplete?.(idx, outcome.mapped.length);
      } catch {
        /* diagnostics sink */
      }
      return outcome;
    };

    const outcomes: InvocationOutcome<T>[] = new Array(batches.length);
    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        const idx = next++;
        outcomes[idx] = await runBatch(batches[idx], idx);
      }
    };
    await Promise.all(Array.from({ length: Math.min(maxConcurrency(), batches.length) }, worker));

    const allResults: (T & { pageS3Key: string })[] = [];
    const failedPages: string[] = [];
    const okPages: string[] = [];
    const allWarnings: string[] = [];
    const pageErrors: Record<string, string> = {};
    for (const outcome of outcomes) {
      allResults.push(...outcome.mapped);
      allWarnings.push(...outcome.warnings);
      okPages.push(...outcome.okPages);
      for (const [key, reason] of Object.entries(outcome.failed)) {
        failedPages.push(key);
        pageErrors[key] = reason;
      }
    }

    return { results: allResults, failedPages, warnings: allWarnings, okPages, pageErrors };
  } finally {
    cleanupJob(jobId).catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════════════
// Public API — thin wrappers
// ═══════════════════════════════════════════════════════════════════

interface TemplateMatchFanOutOpts {
  templateBuffer: Buffer;
  pageS3Keys: string[];
  config?: Record<string, unknown>;
  onBatchComplete?: (batchIdx: number, matchCount: number) => void;
}

export async function fanOutTemplateMatch(
  opts: TemplateMatchFanOutOpts
): Promise<FanOutResult<TemplateMatchHit>> {
  const bucket = s3Bucket();
  if (!bucket) throw new Error("S3_BUCKET env var is not set");
  const jobId = crypto.randomUUID();
  const templateKey = `tmp/cv-jobs/${jobId}/template.png`;
  await uploadToS3(templateKey, opts.templateBuffer, "image/png");

  return fanOut<TemplateMatchHit>({
    action: "template_match",
    batchSize: TEMPLATE_MATCH_BATCH_SIZE,
    pageS3Keys: opts.pageS3Keys,
    jobId,
    extraPayload: { template_s3_key: templateKey },
    config: opts.config,
    resultMapper: (r) => ({
      targetIndex: r.page_index ?? 0,
      bbox: r.bbox as BboxLTWH,
      confidence: r.confidence,
      method: r.method,
      scale: r.scale,
    }),
    onBatchComplete: opts.onBatchComplete,
  });
}

interface ShapeParseFanOutOpts {
  pageS3Keys: string[];
  config?: Record<string, unknown>;
  onBatchComplete?: (batchIdx: number, shapeCount: number) => void;
  onInvocation?: (diag: LambdaInvocationDiag) => void;
}

// Callers: `server/services/reprocess-shape-parse.ts` (admin reprocess — streams onInvocation into
// the NDJSON debug lines, which also keeps the ALB idle timer fed) and
// `server/services/shape-parse.ts` (viewer scanAll, kind:json — no progress stream). Both treat
// `failedPages` as NOT scanned: an empty `results` is only "no shapes" for pages in `okPages`.
export async function fanOutShapeParse(
  opts: ShapeParseFanOutOpts
): Promise<FanOutResult<KeynoteShapeData>> {
  return fanOut<KeynoteShapeData>({
    action: "shape_parse",
    batchSize: SHAPE_PARSE_BATCH_SIZE,
    pageS3Keys: opts.pageS3Keys,
    config: opts.config,
    resultMapper: (r) => ({
      shape: r.shape || "circle",
      text: r.text || "",
      bbox: r.bbox || [0, 0, 0, 0],
      contour: r.contour || [],
    }),
    onBatchComplete: opts.onBatchComplete,
    onInvocation: opts.onInvocation,
  });
}

// ═══════════════════════════════════════════════════════════════════
// Internals
// ═══════════════════════════════════════════════════════════════════

function partition<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function invokeLambda(payload: Record<string, unknown>): Promise<any> {
  const client = getLambdaClient();
  const cmd = new InvokeCommand({
    FunctionName: functionName(),
    InvocationType: "RequestResponse",
    Payload: Buffer.from(JSON.stringify(payload)),
  });

  const resp = await client.send(cmd);

  if (resp.FunctionError) {
    let errPayload: { errorMessage?: string; errorType?: string } = {};
    try {
      errPayload = resp.Payload ? JSON.parse(Buffer.from(resp.Payload).toString()) : {};
    } catch {
      /* non-JSON error payload: fall back to the FunctionError label */
    }
    const kind = errPayload.errorType ? ` (${errPayload.errorType})` : "";
    throw new LambdaFunctionError(
      resp.FunctionError,
      `Lambda error: ${errPayload.errorMessage || resp.FunctionError}${kind}`,
    );
  }

  if (resp.Payload) {
    return JSON.parse(Buffer.from(resp.Payload).toString());
  }
  return { status: "success" };
}

async function cleanupJob(jobId: string): Promise<void> {
  try {
    await deleteProjectFiles(`tmp/cv-jobs/${jobId}`);
  } catch (err) {
    logger.warn(`[LAMBDA_CV] Cleanup failed for job ${jobId}:`, err);
  }
}
