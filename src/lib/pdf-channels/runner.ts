// [census F2 2026-10-24] Run scripts/pdf_channels.py over one PDF. Spawn shape mirrors processing.ts
// runPythonConcat and lib/tiles/cut.ts: stdin JSON in, timeout with SIGTERM → SIGKILL escalation.
// The one difference is the parse: pymupdf releases newer than the Dockerfile pin print to STDOUT on
// `import fitz` (Dockerfile note, 2026-09-29), so the result is the LAST line that parses as a JSON
// object with a `status` — never the whole stream. The script is also handed a total budget a few
// seconds under the timeout, so a slow PDF comes back truncated (remaining pages "budget") instead
// of being killed with nothing.

import { spawn as nodeSpawn } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { logger } from "@/lib/logger";
import type { PdfChannelsResult } from "./types";

// [census F2] 300 s: measured 2026-10-24 on 29 real sets (646 pages) at 0.42 s/page, a 115-page set
// took 61.6 s; the census runs beside the page loop, so the budget never delays an upload.
export const DEFAULT_CHANNELS_TIMEOUT_MS = 300_000;
const MAX_CHANNELS_TIMEOUT_MS = 600_000;
/** Head-room between the script's own total budget and the hard kill. */
const BUDGET_MARGIN_MS = 5_000;
const KILL_GRACE_MS = 3_000;

/** PDF_CHANNELS_TIMEOUT_MS → 1 s..10 min; anything unparseable is the 300 s default. */
export function channelsTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PDF_CHANNELS_TIMEOUT_MS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_CHANNELS_TIMEOUT_MS;
  const n = Number(raw);
  return n < 1_000 ? DEFAULT_CHANNELS_TIMEOUT_MS : Math.min(n, MAX_CHANNELS_TIMEOUT_MS);
}

/**
 * The script's result from its stdout: the last line that is a JSON object with a `status`. Throws
 * on no such line, on a script-reported error, and on an ok line without a pages array.
 */
export function parseChannelsOutput(stdout: string): PdfChannelsResult {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("status" in parsed)) continue;
    const out = parsed as Record<string, unknown>;
    if (out.status !== "ok") {
      throw new Error(`pdf_channels.py: ${String(out.error ?? "error")}${out.message ? ` — ${String(out.message)}` : ""}`);
    }
    if (!Array.isArray(out.pages)) throw new Error("pdf_channels.py: ok result without pages");
    return out as unknown as PdfChannelsResult;
  }
  throw new Error("pdf_channels.py: no JSON result line");
}

export interface RunChannelsOptions {
  timeoutMs?: number;
  maxPaths?: number;
  pageTimeBudgetMs?: number;
  /** Injectable for tests. */
  spawn?: typeof nodeSpawn;
  scriptPath?: string;
}

/** Census one PDF on disk. Throws on timeout, spawn failure, unparseable output or a script error. */
export async function runPdfChannels(pdfPath: string, opts: RunChannelsOptions = {}): Promise<PdfChannelsResult> {
  const timeoutMs = opts.timeoutMs ?? channelsTimeoutMs();
  const spawn = opts.spawn ?? nodeSpawn;
  const scriptPath = opts.scriptPath ?? join(process.cwd(), "scripts", "pdf_channels.py");
  const config = {
    pdfPath,
    maxPaths: opts.maxPaths,
    pageTimeBudgetMs: opts.pageTimeBudgetMs,
    totalBudgetMs: Math.max(1_000, timeoutMs - BUDGET_MARGIN_MS),
  };
  const stdout = await new Promise<string>((resolve, reject) => {
    const proc = spawn("python3", [scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    const killTimer = setTimeout(() => {
      settled = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, KILL_GRACE_MS);
      reject(new Error(`pdf_channels.py timed out (${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);

    let out = "";
    let err = "";
    proc.stdout?.on("data", (c: Buffer) => {
      out += c.toString();
    });
    proc.stderr?.on("data", (c: Buffer) => {
      err += c.toString();
    });
    proc.on("close", (code) => {
      clearTimeout(killTimer);
      if (err.trim()) logger.info(`[pdf-channels] ${err.trim().slice(0, 500)}`);
      if (settled) return;
      settled = true;
      if (!out.trim()) reject(new Error(`pdf_channels.py exited with code ${code}, no output. stderr: ${err.slice(0, 500)}`));
      else resolve(out);
    });
    proc.on("error", (e) => {
      clearTimeout(killTimer);
      if (settled) return;
      settled = true;
      reject(e);
    });
    proc.stdin?.write(JSON.stringify(config));
    proc.stdin?.end();
  });
  return parseChannelsOutput(stdout);
}

/** Census an in-memory PDF: written to a tempdir (removed afterwards), then runPdfChannels. */
export async function runPdfChannelsOnBuffer(pdf: Buffer, opts: RunChannelsOptions = {}): Promise<PdfChannelsResult> {
  const dir = await mkdtemp(join(tmpdir(), "bp2-channels-"));
  try {
    const path = join(dir, "source.pdf");
    await writeFile(path, pdf);
    return await runPdfChannels(path, opts);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
