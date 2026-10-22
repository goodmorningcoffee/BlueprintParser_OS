// [2026-10-22 bulk YOLO incident] CreateProcessingJob refusals, classified by the AWS error name.
// Fifteen starts fired within 3 s; 9 were refused (throttling) and surfaced as a generic 500 while
// their processing_jobs rows stayed "running" as phantoms. Every refusal now carries the AWS name:
//   retryable  (Throttling*, ResourceLimitExceeded, ServiceUnavailable, capacity) → 429 RETRYABLE
//   validation (ValidationException, InvalidParameter*, …)                         → 400 VALIDATION
//   anything else                                                                   → 500 INTERNAL, naming the error
// `confirmedAbsent` decides whether the caller closes its rows: a Describe found no job under the
// name, or — when Describe stayed inconclusive — AWS answered the create with a 4xx that is not a
// name collision (a collision means an SDK retry of a create AWS had already accepted). An
// unconfirmed refusal is never retryable: the job may exist, so a rerun could double it.

import { ApiError } from "@/server/api/envelope";
import { isSageMakerQuotaError, yoloQuotaMessage } from "@/lib/yolo-instances";

type RefusalCode = "RETRYABLE" | "VALIDATION" | "INTERNAL";

/** SageMaker refused (or may not have accepted) CreateProcessingJob. */
export class YoloStartRefusedError extends ApiError {
  readonly confirmedAbsent: boolean;
  readonly awsName: string | null;
  constructor(message: string, confirmedAbsent: boolean, code: RefusalCode = "RETRYABLE", awsName: string | null = null) {
    super(code, message);
    this.confirmedAbsent = confirmedAbsent;
    this.awsName = awsName;
  }
}

export interface AwsErrorFacts {
  name: string;
  message: string;
  httpStatus: number | null;
}

const RETRYABLE_NAME = /Throttl|TooManyRequests|RequestLimitExceeded|ResourceLimitExceeded|ServiceUnavailable|InsufficientCapacity|CapacityError/iu;
const VALIDATION_NAME = /^(ValidationException|InvalidParameter\w*|MissingParameter|ResourceNotFound|SerializationException)$/u;
const NAME_COLLISION = /ResourceInUse|already exists|must be unique/iu;

/** ARNs and 12-digit account ids out; one line; bounded. */
export function scrubAwsMessage(message: string): string {
  return message
    .replace(/arn:aws[\w-]*:[^\s"',)]+/gu, "<arn>")
    .replace(/\b\d{12}\b/gu, "<account>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 300);
}

export function awsErrorFacts(err: unknown): AwsErrorFacts {
  const e = (err && typeof err === "object" ? err : {}) as {
    name?: unknown; Code?: unknown; __type?: unknown; message?: unknown; $metadata?: { httpStatusCode?: unknown };
  };
  const name = [e.name, e.Code, e.__type].find((v): v is string => typeof v === "string" && v.length > 0) ?? "Error";
  const status = e.$metadata?.httpStatusCode;
  return {
    name: name.replace(/^.*#/u, ""),
    message: scrubAwsMessage(typeof e.message === "string" ? e.message : String(err)),
    httpStatus: typeof status === "number" ? status : null,
  };
}

export function createErrorKind(f: AwsErrorFacts): "retryable" | "validation" | "other" {
  if (RETRYABLE_NAME.test(f.name) || f.httpStatus === 429 || f.httpStatus === 503) return "retryable";
  if (VALIDATION_NAME.test(f.name)) return "validation";
  return "other";
}

/** AWS answered the create itself with a 4xx that is not a job-name collision: no job was made. */
export function isDefinitiveRejection(f: AwsErrorFacts): boolean {
  return f.httpStatus !== null && f.httpStatus >= 400 && f.httpStatus < 500 && !NAME_COLLISION.test(`${f.name} ${f.message}`);
}

export function refusedStartError(err: unknown, instanceType: string, confirmedAbsent: boolean): YoloStartRefusedError {
  const f = awsErrorFacts(err);
  if (!confirmedAbsent) {
    return new YoloStartRefusedError(
      `SageMaker start outcome unknown (${f.name}) — check Stuck jobs before retrying`, false, "INTERNAL", f.name);
  }
  const kind = createErrorKind(f);
  if (kind === "retryable") {
    const message = isSageMakerQuotaError(err)
      ? yoloQuotaMessage(instanceType)
      : `SageMaker is busy (${f.name}): ${f.message} — retry shortly`;
    return new YoloStartRefusedError(message, true, "RETRYABLE", f.name);
  }
  if (kind === "validation") {
    return new YoloStartRefusedError(`SageMaker rejected the job (${f.name}): ${f.message}`, true, "VALIDATION", f.name);
  }
  return new YoloStartRefusedError(`Failed to start SageMaker job (${f.name})`, true, "INTERNAL", f.name);
}

/**
 * A CreateProcessingJob call threw. Ask SageMaker whether the job exists anyway (present → the
 * start succeeded; return its name), else throw the classified refusal.
 */
export async function settleCreateFailure(
  err: unknown,
  jobName: string,
  instanceType: string,
  presence: (jobName: string) => Promise<"present" | "absent" | "unknown">,
): Promise<string> {
  const found = await presence(jobName);
  if (found === "present") return jobName;
  throw refusedStartError(err, instanceType, found === "absent" || isDefinitiveRejection(awsErrorFacts(err)));
}
