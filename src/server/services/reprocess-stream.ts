// [fix 2026-10-21 reprocess-persistence] NDJSON stream + debug helper shared by EVERY
// /api/admin/reprocess scope.
//
// 1. A send() that cannot throw. The work runs inside ReadableStream.start; when the client
//    goes away (tab closed, ALB idle timeout) enqueue() throws, and the per-project guards
//    used to call send() again inside their catch — so the throw escaped the loop and the
//    run stopped half-way through a project. Now a closed stream is noted once and the run
//    FINISHES server-side: every write still lands, the client just stops hearing about it.
// 2. The admin "Debug" toggle (?trace=1). Owner 2026-10-21: "you can add debug print
//    statements in the admin that can print when we run processing". debug() emits
//    {type:"debug", scope, step, ...fields} into the same stream and the same line to the
//    server log as `[reprocess-debug] …`. It is a no-op when the toggle is off. Never pass
//    secrets or signed URLs; string values that look like either are redacted here anyway.
import { logger } from "@/lib/logger";

export type ReprocessEvent = Record<string, unknown>;
export type ReprocessSend = (event: ReprocessEvent) => void;
export type ReprocessDebug = (step: string, fields?: ReprocessEvent) => void;

export interface ReprocessStream {
  send: ReprocessSend;
  debug: ReprocessDebug;
  /** True once the client has gone away (sends are dropped from then on). */
  isClosed(): boolean;
  close(): void;
  readonly debugEnabled: boolean;
}

const SECRETISH = /(X-Amz-(Signature|Credential|Security-Token)|https?:\/\/|AKIA[0-9A-Z]{12,})/i;

function redact(value: unknown): unknown {
  if (typeof value === "string") return SECRETISH.test(value) ? "[redacted]" : value;
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /secret|password|token|credential|signature/i.test(k) ? "[redacted]" : redact(v);
    }
    return out;
  }
  return value;
}

export function createReprocessStream(
  controller: ReadableStreamDefaultController<Uint8Array>,
  opts: { scope: string; debug: boolean },
): ReprocessStream {
  const encoder = new TextEncoder();
  let closed = false;

  const send: ReprocessSend = (event) => {
    if (closed) return;
    try {
      controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
    } catch (err) {
      closed = true;
      logger.warn(
        `[reprocess] client stream closed during scope ${opts.scope}; finishing the run server-side`,
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
  };

  const debug: ReprocessDebug = (step, fields = {}) => {
    if (!opts.debug) return;
    const safe = redact(fields) as ReprocessEvent;
    logger.info(`[reprocess-debug] ${opts.scope} ${step}`, safe);
    send({ type: "debug", scope: opts.scope, step, ...safe });
  };

  return {
    send,
    debug,
    isClosed: () => closed,
    close: () => {
      if (closed) return;
      closed = true;
      try {
        controller.close();
      } catch {
        /* already closed by the runtime */
      }
    },
    debugEnabled: opts.debug,
  };
}
