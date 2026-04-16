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
// Template Match Fan-out
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
  const jobId = crypto.randomUUID();
  const bucket = s3Bucket();
  const templateKey = `tmp/cv-jobs/${jobId}/template.png`;

  await uploadToS3(templateKey, opts.templateBuffer, "image/png");

  try {
    const batches = partition(opts.pageS3Keys, TEMPLATE_MATCH_BATCH_SIZE);
    const allResults: (TemplateMatchHit & { pageS3Key: string })[] = [];
    const failedPages: string[] = [];

    const outcomes = await Promise.allSettled(
      batches.map((batch, idx) =>
        invokeLambda({
          action: "template_match",
          job_id: jobId,
          s3_bucket: bucket,
          template_s3_key: templateKey,
          page_s3_keys: batch,
          result_s3_key: `tmp/cv-jobs/${jobId}/results/batch_${idx}.json`,
          config: opts.config || {},
        })
      )
    );

    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i];
      if (outcome.status === "fulfilled" && outcome.value.status !== "error") {
        const resultKey = `tmp/cv-jobs/${jobId}/results/batch_${i}.json`;
        const parsed = await readResultsFromS3(bucket, resultKey);
        if (parsed?.results) {
          for (const r of parsed.results) {
            allResults.push({
              targetIndex: r.page_index ?? 0,
              bbox: r.bbox as BboxLTWH,
              confidence: r.confidence,
              method: r.method,
              scale: r.scale,
              pageS3Key: r.page_s3_key,
            });
          }
        }
        opts.onBatchComplete?.(i, parsed?.results?.length ?? 0);
      } else {
        const batchPages = batches[i];
        const error = outcome.status === "rejected" ? outcome.reason : outcome.value?.error;
        logger.warn(`[LAMBDA_CV] Batch ${i} failed: ${error}`);

        // Retry failed batch with batch_size=1
        for (const pageKey of batchPages) {
          try {
            const retryKey = `tmp/cv-jobs/${jobId}/results/retry_${pageKey.replace(/\//g, "_")}.json`;
            await invokeLambda({
              action: "template_match",
              job_id: jobId,
              s3_bucket: bucket,
              template_s3_key: templateKey,
              page_s3_keys: [pageKey],
              result_s3_key: retryKey,
              config: opts.config || {},
            });
            const parsed = await readResultsFromS3(bucket, retryKey);
            if (parsed?.results) {
              for (const r of parsed.results) {
                allResults.push({
                  targetIndex: r.page_index ?? 0,
                  bbox: r.bbox as BboxLTWH,
                  confidence: r.confidence,
                  method: r.method,
                  scale: r.scale,
                  pageS3Key: r.page_s3_key,
                });
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
    cleanupJob(bucket, jobId).catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════════════
// Shape Parse Fan-out
// ═══════════════════════════════════════════════════════════════════

interface ShapeParseFanOutOpts {
  pageS3Keys: string[];
  config?: Record<string, unknown>;
  onBatchComplete?: (batchIdx: number, shapeCount: number) => void;
}

export async function fanOutShapeParse(
  opts: ShapeParseFanOutOpts
): Promise<{ results: (KeynoteShapeData & { pageS3Key: string })[]; failedPages: string[] }> {
  const jobId = crypto.randomUUID();
  const bucket = s3Bucket();

  try {
    const batches = partition(opts.pageS3Keys, SHAPE_PARSE_BATCH_SIZE);
    const allResults: (KeynoteShapeData & { pageS3Key: string })[] = [];
    const failedPages: string[] = [];

    const outcomes = await Promise.allSettled(
      batches.map((batch, idx) =>
        invokeLambda({
          action: "shape_parse",
          job_id: jobId,
          s3_bucket: bucket,
          page_s3_keys: batch,
          result_s3_key: `tmp/cv-jobs/${jobId}/results/batch_${idx}.json`,
          config: opts.config || {},
        })
      )
    );

    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i];
      if (outcome.status === "fulfilled" && outcome.value.status !== "error") {
        const resultKey = `tmp/cv-jobs/${jobId}/results/batch_${i}.json`;
        const parsed = await readResultsFromS3(bucket, resultKey);
        if (parsed?.results) {
          for (const r of parsed.results) {
            allResults.push({
              shape: r.shape || "circle",
              text: r.text || "",
              bbox: r.bbox || [0, 0, 0, 0],
              contour: r.contour || [],
              pageS3Key: r.page_s3_key,
            });
          }
        }
        opts.onBatchComplete?.(i, parsed?.results?.length ?? 0);
      } else {
        const batchPages = batches[i];
        const error = outcome.status === "rejected" ? outcome.reason : outcome.value?.error;
        logger.warn(`[LAMBDA_CV] Shape parse batch ${i} failed: ${error}`);

        for (const pageKey of batchPages) {
          try {
            const retryKey = `tmp/cv-jobs/${jobId}/results/retry_${pageKey.replace(/\//g, "_")}.json`;
            await invokeLambda({
              action: "shape_parse",
              job_id: jobId,
              s3_bucket: bucket,
              page_s3_keys: [pageKey],
              result_s3_key: retryKey,
              config: opts.config || {},
            });
            const parsed = await readResultsFromS3(bucket, retryKey);
            if (parsed?.results) {
              for (const r of parsed.results) {
                allResults.push({
                  shape: r.shape || "circle",
                  text: r.text || "",
                  bbox: r.bbox || [0, 0, 0, 0],
                  contour: r.contour || [],
                  pageS3Key: r.page_s3_key,
                });
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
    cleanupJob(bucket, jobId).catch(() => {});
  }
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

async function cleanupJob(_bucket: string, jobId: string): Promise<void> {
  try {
    await deleteProjectFiles(`tmp/cv-jobs/${jobId}`);
  } catch (err) {
    logger.warn(`[LAMBDA_CV] Cleanup failed for job ${jobId}:`, err);
  }
}
