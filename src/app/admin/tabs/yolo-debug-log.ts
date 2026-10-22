// [2026-10-22 owner: "add a debug statement printer I can copy and paste from the /admin AI Models tab that
// gives you insight into what goes wrong"] Client-side event log for YOLO runs (bulk queue, batch starts,
// polls, loads, non-2xx answers, exceptions). A ring buffer of DEBUG_LOG_MAX events, kept in
// sessionStorage (every access in try/catch — storage can be blocked) so a reload does not lose it.
// Every string is REDACTED on the way in and again when the report is built (./YoloDebugReport.tsx).
// Pure apart from sessionStorage; root-only consumers.

export const DEBUG_LOG_MAX = 2000;
const STORAGE_KEY = "bp.yoloDebugLog.v1";
const MAX_TEXT = 4000;

export interface YoloDebugEvent {
  /** ISO timestamp. */
  t: string;
  kind: string;
  msg: string;
  data?: unknown;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;

/**
 * Remove secrets from free text: URL query strings (presigned S3 URLs carry their signature there),
 * bearer/JWT tokens, AWS access key ids, key=value secrets, AWS account ids inside ARNs / ECR hosts /
 * the data bucket name, and every email except `keepEmail` (the root's own).
 */
export function redactDebugText(text: string, keepEmail?: string | null): string {
  const keep = keepEmail?.toLowerCase();
  return text
    .replace(/\b(https?:\/\/[^\s"'<>?]+)\?[^\s"'<>]*/gu, "$1?[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/gu, "[redacted-jwt]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[redacted-key]")
    .replace(
      /\b((?:x-amz-[a-z-]+|token|secret|password|passwd|authorization|api[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|session[_-]?token|signature|credential|cookie)["']?\s*[:=]\s*["']?)[^\s"',;}&]+/giu,
      "$1[redacted]",
    )
    .replace(/(arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:)\d{12}/gu, "$1<account>")
    .replace(/\b\d{12}(?=\.dkr\.ecr\.)/gu, "<account>")
    .replace(/\bbeaver-data-\d{12}\b/gu, "beaver-data-<account>")
    .replace(EMAIL, (m) => (keep && m.toLowerCase() === keep ? m : "[redacted-email]"));
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}… [${text.length - MAX_TEXT} more chars]` : text;
}

/** JSON-able, redacted, size-bounded copy of arbitrary event data. */
export function sanitizeDebugData(data: unknown, keepEmail?: string | null): unknown {
  if (data === undefined) return undefined;
  let json: string;
  try {
    json = JSON.stringify(data, (_k, v: unknown) =>
      v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v,
    );
  } catch {
    json = JSON.stringify(String(data));
  }
  if (json === undefined) return undefined;
  const redacted = clip(redactDebugText(json, keepEmail));
  try {
    return JSON.parse(redacted);
  } catch {
    return redacted;
  }
}

let events: YoloDebugEvent[] | null = null;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function load(): YoloDebugEvent[] {
  if (events) return events;
  events = [];
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) events = parsed.slice(-DEBUG_LOG_MAX) as YoloDebugEvent[];
  } catch {
    events = [];
  }
  return events;
}

function persist(): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(events ?? []));
  } catch {
    /* quota or blocked storage: the in-memory log still works */
  }
}

/** Append one event (redacted, bounded). Never throws. */
export function logYoloDebug(kind: string, msg: string, data?: unknown): void {
  try {
    const list = load();
    const event: YoloDebugEvent = { t: new Date().toISOString(), kind, msg: clip(redactDebugText(msg)) };
    const safe = sanitizeDebugData(data);
    if (safe !== undefined) event.data = safe;
    list.push(event);
    if (list.length > DEBUG_LOG_MAX) list.splice(0, list.length - DEBUG_LOG_MAX);
    persist();
    for (const fn of listeners) fn();
  } catch {
    /* debugging must never break the run */
  }
}

/** An exception with message + stack. */
export function logYoloDebugError(msg: string, err: unknown): void {
  logYoloDebug("exception", msg, err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : { value: String(err) });
}

export function readYoloDebugEvents(): readonly YoloDebugEvent[] {
  return load();
}

export function clearYoloDebugLog(): void {
  events = [];
  persist();
  for (const fn of listeners) fn();
}

export function subscribeYoloDebug(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Test hook: forget the in-memory copy (the next read reloads from sessionStorage). */
export function resetYoloDebugLogForTests(): void {
  events = null;
}
