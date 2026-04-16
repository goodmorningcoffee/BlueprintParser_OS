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

const TEMPLATE_MATCH_BATCH_SIZE = parseInt(process.env.LAMBDA_CV_BATCH_SIZE || "5", 10);
const SHAPE_PARSE_BATCH_SIZE = 3;

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

async function fanOut<T>(opts: FanOutOpts<T>): Promise<{ results: (T & { pageS3Key: string })[]; failedPages: string[] }> {
  const bucket = s3Bucket();
  if (!bucket) throw new Error("S3_BUCKET env var is not set — cannot fan out to Lambda");
  const jobId = opts.jobId || crypto.randomUUID();

  try {
    const batches = partition(opts.pageS3Keys, opts.batchSize);
    const allResults: (T & { pageS3Key: string })[] = [];
    const failedPages: string[] = [];

    const outcomes = await Promise.allSettled(
      batches.map((batch, idx) =>
        invokeLambda({
          action: opts.action,
          job_id: jobId,
          s3_bucket: bucket,
          page_s3_keys: batch,
          result_s3_key: `tmp/cv-jobs/${jobId}/results/batch_${idx}.json`,
          config: opts.config || {},
          ...opts.extraPayload,
        })
      )
    );

    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i];
      if (outcome.status === "fulfilled" && outcome.value.status !== "error") {
        const parsed = await readResultsFromS3(bucket, `tmp/cv-jobs/${jobId}/results/batch_${i}.json`);
        if (parsed?.results) {
          for (const r of parsed.results) {
            allResults.push({ ...opts.resultMapper(r), pageS3Key: r.page_s3_key });
          }
        }
        opts.onBatchComplete?.(i, parsed?.results?.length ?? 0);
      } else {
        const batchPages = batches[i];
        const error = outcome.status === "rejected" ? outcome.reason : outcome.value?.error;
        logger.warn(`[LAMBDA_CV] ${opts.action} batch ${i} failed: ${error}`);

        for (const pageKey of batchPages) {
          try {
            const retryKey = `tmp/cv-jobs/${jobId}/results/retry_${pageKey.replace(/\//g, "_")}.json`;
            await invokeLambda({
              action: opts.action,
              job_id: jobId,
              s3_bucket: bucket,
              page_s3_keys: [pageKey],
              result_s3_key: retryKey,
              config: opts.config || {},
              ...opts.extraPayload,
            });
            const parsed = await readResultsFromS3(bucket, retryKey);
            if (parsed?.results) {
              for (const r of parsed.results) {
                allResults.push({ ...opts.resultMapper(r), pageS3Key: r.page_s3_key });
              }
            }
          } catch {
            failedPages.push(pageKey);
          }
        }
      }
    }

    return { results: allResults, failedPages };
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
): Promise<{ results: (TemplateMatchHit & { pageS3Key: string })[]; failedPages: string[] }> {
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

export async function fanOutShapeParse(
  opts: ShapeParseFanOutOpts
): Promise<{ results: (KeynoteShapeData & { pageS3Key: string })[]; failedPages: string[] }> {
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
