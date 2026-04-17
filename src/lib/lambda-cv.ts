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

interface FanOutOpts<T> {
  action: string;
  batchSize: number;
  pageS3Keys: string[];
  jobId?: string;
  extraPayload?: Record<string, unknown>;
  config?: Record<string, unknown>;
  resultMapper: (r: any) => T;
  onBatchComplete?: (batchIdx: number, count: number) => void;
}

interface FanOutResult<T> {
  results: (T & { pageS3Key: string })[];
  failedPages: string[];
  warnings: string[];
}

function assertLambdaOk(resp: any): void {
  if (resp?.status === "error") {
    throw new Error(resp.error || "Lambda returned error status");
  }
}

async function fanOut<T>(opts: FanOutOpts<T>): Promise<FanOutResult<T>> {
  const bucket = s3Bucket();
  if (!bucket) throw new Error("S3_BUCKET env var is not set — cannot fan out to Lambda");
  const jobId = opts.jobId || crypto.randomUUID();

  try {
    const batches = partition(opts.pageS3Keys, opts.batchSize);

    // Each batch runs in its own async function so onBatchComplete fires as
    // that batch settles, not after all batches finish. The caller's
    // ReadableStream can then flush progress chunks to the client in real
    // time instead of going silent until the slowest Lambda returns.
    const batchPromises = batches.map(async (batch, idx) => {
      const primaryResultKey = `tmp/cv-jobs/${jobId}/results/batch_${idx}.json`;
      try {
        const resp = await invokeLambda({
          action: opts.action,
          job_id: jobId,
          s3_bucket: bucket,
          page_s3_keys: batch,
          result_s3_key: primaryResultKey,
          config: opts.config || {},
          ...opts.extraPayload,
        });
        assertLambdaOk(resp);
        const parsed = await readResultsFromS3(bucket, primaryResultKey);
        const mapped: (T & { pageS3Key: string })[] = [];
        if (parsed?.results) {
          for (const r of parsed.results) {
            mapped.push({ ...opts.resultMapper(r), pageS3Key: r.page_s3_key });
          }
        }
        const warnings: string[] = Array.isArray(parsed?.warnings) ? parsed.warnings : [];
        opts.onBatchComplete?.(idx, mapped.length);
        return { kind: "success" as const, mapped, warnings };
      } catch (err) {
        // This catch fires on three distinct conditions:
        //   (a) AWS SDK threw (FunctionError, network, throttle) — invokeLambda throws.
        //   (b) Lambda returned {status: "error"} — assertLambdaOk threw above.
        //   (c) `opts.onBatchComplete` itself threw — e.g. if the caller's
        //       ReadableStream controller was closed because the client disconnected.
        //       In (c) we'll retry N pages even though the client is gone. Waste, not
        //       catastrophe — the fetch is already aborted upstream. Not worth guarding.
        logger.warn(`[LAMBDA_CV] ${opts.action} batch ${idx} failed: ${err}`);
        const retryResults: (T & { pageS3Key: string })[] = [];
        const retryWarnings: string[] = [];
        const retryFailed: string[] = [];
        for (const pageKey of batch) {
          try {
            const retryKey = `tmp/cv-jobs/${jobId}/results/retry_${pageKey.replace(/\//g, "_")}.json`;
            const retryResp = await invokeLambda({
              action: opts.action,
              job_id: jobId,
              s3_bucket: bucket,
              page_s3_keys: [pageKey],
              result_s3_key: retryKey,
              config: opts.config || {},
              ...opts.extraPayload,
            });
            assertLambdaOk(retryResp);
            const parsed = await readResultsFromS3(bucket, retryKey);
            if (parsed?.results) {
              for (const r of parsed.results) {
                retryResults.push({ ...opts.resultMapper(r), pageS3Key: r.page_s3_key });
              }
            }
            if (Array.isArray(parsed?.warnings)) {
              retryWarnings.push(...parsed.warnings);
            }
          } catch {
            retryFailed.push(pageKey);
          }
        }
        opts.onBatchComplete?.(idx, retryResults.length);
        return { kind: "retry" as const, retryResults, retryWarnings, retryFailed };
      }
    });

    const outcomes = await Promise.all(batchPromises);

    const allResults: (T & { pageS3Key: string })[] = [];
    const failedPages: string[] = [];
    const allWarnings: string[] = [];
    for (const outcome of outcomes) {
      if (outcome.kind === "success") {
        allResults.push(...outcome.mapped);
        allWarnings.push(...outcome.warnings);
      } else {
        allResults.push(...outcome.retryResults);
        allWarnings.push(...outcome.retryWarnings);
        failedPages.push(...outcome.retryFailed);
      }
    }

    return { results: allResults, failedPages, warnings: allWarnings };
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
}

// NOTE: unlike `fanOutTemplateMatch`, current callers of
// `fanOutShapeParse` (src/app/api/shape-parse/route.ts:76) don't pass
// `onBatchComplete` — Shape Parse scanAll has no progress stream today.
// The UI just spins during a multi-minute scan. To add progress, the
// route would need to switch to a ReadableStream response (same pattern
// as symbol-search/route.ts) and thread onBatchComplete through.
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
    const errPayload = resp.Payload
      ? JSON.parse(Buffer.from(resp.Payload).toString())
      : { errorMessage: resp.FunctionError };
    throw new Error(`Lambda error: ${errPayload.errorMessage || resp.FunctionError}`);
  }

  if (resp.Payload) {
    return JSON.parse(Buffer.from(resp.Payload).toString());
  }
  return { status: "success" };
}

async function readResultsFromS3(bucket: string, key: string): Promise<any> {
  try {
    const buf = await downloadFromS3(key);
    return JSON.parse(buf.toString("utf-8"));
  } catch (err) {
    logger.warn(`[LAMBDA_CV] Failed to read results from s3://${bucket}/${key}:`, err);
    return null;
  }
}

async function cleanupJob(jobId: string): Promise<void> {
  try {
    await deleteProjectFiles(`tmp/cv-jobs/${jobId}`);
  } catch (err) {
    logger.warn(`[LAMBDA_CV] Cleanup failed for job ${jobId}:`, err);
  }
}
