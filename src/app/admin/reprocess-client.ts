// [fix 2026-10-21 reprocess-persistence] Client side of POST /api/admin/reprocess (NDJSON).
//
// Moved out of admin/page.tsx so every event type is rendered. The old inline reader printed
// only start/project/progress/done, so every per-project `error`, every `warning` (including
// "Lambda failed …"), the `config` line and the project-analysis/summaries confirmations were
// silently dropped — the owner's 40-project shape-parse run printed "0 pages updated" and
// nothing else. The Debug toggle (owner: "you can add debug print statements in the admin
// that can print when we run processing") adds ?trace=1, and the server then streams
// {type:"debug"} lines for every step; they are rendered here verbatim.

export type ReprocessEvent = Record<string, unknown>;

/**
 * Build the endpoint URL. `scope` is typed unknown on purpose: tab buttons once passed React's
 * click event here (`onClick={onReprocess}`), producing ?scope=[object Object]. Anything that is
 * not a non-empty string now means "no scope" (= full), which is what those buttons meant.
 */
export function reprocessUrl(scope: unknown, debug: boolean, classifierDebug = false): string {
  const params = new URLSearchParams();
  if (typeof scope === "string" && scope.length > 0) params.set("scope", scope);
  // [2026-10-24 Reprocess tab] debug=1 = the Page Intelligence tab's old "Classifier debug" (Stage A–F
  // bundles written to S3 by the intelligence branch); distinct from trace=1, which only streams lines.
  if (classifierDebug) params.set("debug", "1");
  if (debug) params.set("trace", "1");
  const qs = params.toString();
  return qs ? `/api/admin/reprocess?${qs}` : "/api/admin/reprocess";
}

const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

function debugLine(e: ReprocessEvent): string {
  const fields = Object.entries(e)
    .filter(([k]) => k !== "type" && k !== "scope" && k !== "step")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  return `  [debug ${str(e.scope)}] ${str(e.step)}${fields ? ` ${fields}` : ""}`;
}

/** One NDJSON event → one log line (null = nothing to show). Every known type is rendered. */
export function formatReprocessEvent(e: ReprocessEvent): string | null {
  switch (e.type) {
    case "start":
      return `Found ${num(e.projects)} projects`;
    case "config":
      if ("useLambda" in e) return `Shape parse engine: ${e.useLambda ? "Lambda fan-out" : "local python (Lambda disabled)"}`;
      if ("yoloEnabled" in e) {
        const classes = Array.isArray(e.targetClasses) ? e.targetClasses.join(", ") : "";
        return `Page names: ${e.yoloEnabled ? `YOLO title blocks (${classes})` : "text only (no YOLO page-naming config)"}`;
      }
      return `Config: ${JSON.stringify(e)}`;
    case "project":
      return `Processing: ${str(e.name)} (${num(e.pages)} pages)`;
    case "progress": {
      const parts = [`${num(e.updated)} pages updated`];
      if ("empty" in e) parts.push(`${num(e.empty)} no shapes found`);
      if ("failed" in e) parts.push(`${num(e.failed)} failed`);
      return `  ${parts.join(", ")}...`;
    }
    case "warning":
      return `  WARNING${e.project ? ` [${str(e.project)}]` : ""}: ${str(e.message)}`;
    case "error":
      return `  ERROR${e.project ? ` [${str(e.project)}]` : ""}: ${str(e.error)}`;
    case "project-analysis":
      return `  project analysis saved (${str(e.project)})`;
    case "project-summaries":
      return `  project summaries saved (${str(e.project)})`;
    case "heartbeat":
      return null; // keep-alive during a long Lambda fan-out
    case "debug":
      return debugLine(e);
    case "done": {
      let line = `Done! ${num(e.updated)} pages updated, ${num(e.skipped)} skipped.`;
      if ("empty" in e || "failed" in e) {
        line += ` (${num(e.empty)} scanned with no shapes, ${num(e.failed)} failed — failed pages kept their previous shapes)`;
      }
      return line;
    }
    default:
      return `  ${JSON.stringify(e)}`;
  }
}

/** Run one reprocess request and feed every rendered line to `onLine`. Throws on network failure. */
export async function runReprocess(
  opts: { scope?: unknown; projectIds?: string[]; debug: boolean; classifierDebug?: boolean },
  onLine: (line: string) => void,
): Promise<void> {
  const res = await fetch(reprocessUrl(opts.scope, opts.debug, opts.classifierDebug === true), {
    method: "POST",
    ...(opts.projectIds
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectIds: opts.projectIds }) }
      : {}),
  });
  if (!res.ok || !res.body) {
    onLine(`Error: ${res.status}`);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;
  const handle = (raw: string) => {
    if (!raw.trim()) return;
    let event: ReprocessEvent;
    try {
      event = JSON.parse(raw);
    } catch {
      onLine(`  (unparseable line) ${raw.slice(0, 200)}`);
      return;
    }
    if (event.type === "done") sawDone = true;
    const line = formatReprocessEvent(event);
    if (line !== null) onLine(line);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) handle(line);
  }
  handle(buffer);
  if (!sawDone) onLine("Stream ended without a 'done' line — the run may have been cut off; check the server log.");
}
