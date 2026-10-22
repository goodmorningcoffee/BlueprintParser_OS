// [fix 2026-10-21 reprocess-persistence] Admin › Pipeline › Reprocess "Shape Parse (Keynotes)",
// one project at a time. Moved out of reprocess.ts (zero line headroom) and rebuilt after the
// owner ran it over 40 projects and got "Done! 0 pages updated, 0 skipped" with no warning.
//
// What was wrong (all in the old inline branch):
//   • It deleted every shape-parse annotation of the project FIRST, then computed.
//   • It read only `results` from the Lambda fan-out and declared success unconditionally, so
//     a fan-out where every page failed (failedPages) looked like "0 shapes", the sequential
//     fallback never ran, and the deleted rows were never replaced.
//   • The sequential path wrote keynotes=NULL when python crashed (extractKeynotes swallows).
// Now:
//   • COMPUTE, THEN SWAP PER PAGE (shape-parse-persist.ts). A page whose scan failed is left
//     exactly as it was.
//   • Lambda is the primary engine (owner: "we want the fan out to work thats the point of
//     having lambda"). Only the specific pages the fan-out could not scan fall back to the
//     local engine, each with a loud `warning` line naming the reason.
//   • Three counters: updated (shapes written) · empty (confirmed scan, no shapes) · failed.
//   • Debug (?trace=1): Lambda config, every invocation, fallback reasons, rows per page.
import { downloadFromS3 } from "@/lib/s3";
import { logger } from "@/lib/logger";
import type { KeynoteShapeData } from "@/types";
import type { ProjectWriteCapability } from "@/server/api/project-write-capability";
import type { ReprocessStream } from "./reprocess-stream";
import { swapShapeParsePage } from "./shape-parse-persist";

export interface ShapeParseCounters {
  /** pages whose shapes were written */
  updated: number;
  /** pages scanned successfully that have no shapes (cleared) */
  empty: number;
  /** pages that could not be scanned — previous results left untouched */
  failed: number;
}

export function pageImageKey(dataUrl: string, pageNumber: number): string {
  return `${dataUrl}/pages/page_${String(pageNumber).padStart(4, "0")}.png`;
}

type PageOutcome = { ok: true; keynotes: KeynoteShapeData[]; engine: "lambda" | "local" } | { ok: false; reason: string };

/** Scan pages with the local python engine (download page PNG → extract_keynotes.py). */
async function scanLocally(
  dataUrl: string,
  pageNumber: number,
): Promise<PageOutcome> {
  const { extractKeynotes } = await import("@/lib/keynotes");
  try {
    const png = await downloadFromS3(pageImageKey(dataUrl, pageNumber));
    const result = await extractKeynotes(png);
    if (result.failed) return { ok: false, reason: result.warnings[0] ?? "local extraction failed" };
    return { ok: true, keynotes: result.keynotes, engine: "local" };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Scan every page with the Lambda fan-out. Returns an outcome per page number; pages the
 * fan-out did not confirm come back {ok:false} with the fan-out's reason.
 */
async function scanWithLambda(
  project: { name: string; dataUrl: string },
  pageNumbers: number[],
  stream: ReprocessStream,
): Promise<Map<number, PageOutcome>> {
  const { fanOutShapeParse, SHAPE_PARSE_BATCH_SIZE } = await import("@/lib/lambda-cv");
  const keyToPage = new Map(pageNumbers.map((pn) => [pageImageKey(project.dataUrl, pn), pn]));
  const out = new Map<number, PageOutcome>();
  const total = Math.ceil(pageNumbers.length / SHAPE_PARSE_BATCH_SIZE);
  let done = 0;
  stream.debug("lambda.fanout.start", {
    project: project.name, pages: pageNumbers.length, chunks: total, chunkSize: SHAPE_PARSE_BATCH_SIZE,
  });
  const fan = await fanOutShapeParse({
    pageS3Keys: [...keyToPage.keys()],
    onInvocation: (diag) => {
      done += diag.attempt === "batch" ? 1 : 0;
      // Always one line per invocation: it is also the keep-alive that stops the ALB idle
      // timeout (300 s) from cutting a long fan-out. Full detail only with Debug on.
      stream.send({ type: "heartbeat", project: project.name, invocations: done, of: total });
      stream.debug("lambda.invoke", { project: project.name, ...diag });
    },
  });
  for (const r of fan.results ?? []) {
    const pn = keyToPage.get(r.pageS3Key);
    if (pn === undefined) continue;
    const prior = out.get(pn);
    const keynotes = prior && prior.ok ? prior.keynotes : [];
    keynotes.push({ shape: r.shape, text: r.text, bbox: r.bbox, contour: r.contour });
    out.set(pn, { ok: true, keynotes, engine: "lambda" });
  }
  for (const key of fan.okPages ?? []) {
    const pn = keyToPage.get(key);
    if (pn !== undefined && !out.has(pn)) out.set(pn, { ok: true, keynotes: [], engine: "lambda" });
  }
  // A page the fan-out did not confirm is NOT "no shapes" — legacy result objects without
  // okPages fall here too, unless they carried shapes for the page.
  for (const [key, pn] of keyToPage) {
    if (!out.has(pn)) {
      out.set(pn, { ok: false, reason: fan.pageErrors?.[key] ?? "Lambda did not confirm this page was scanned" });
    }
  }
  const warnings = fan.warnings ?? [];
  if (warnings.length > 0) {
    stream.debug("lambda.fanout.warnings", { project: project.name, count: warnings.length, first: warnings.slice(0, 5) });
  }
  stream.debug("lambda.fanout.done", {
    project: project.name,
    okPages: fan.okPages?.length ?? 0,
    failedPages: fan.failedPages?.length ?? 0,
    shapes: (fan.results ?? []).length,
  });
  return out;
}

export async function reprocessProjectShapeParse(args: {
  project: { id: number; name: string; dataUrl: string };
  pages: { pageNumber: number }[];
  writeCapability: ProjectWriteCapability;
  useLambda: boolean;
  stream: ReprocessStream;
  /** Called after every page settles, with the running totals for this project. */
  onPage?: (counters: ShapeParseCounters) => void;
}): Promise<ShapeParseCounters> {
  const { project, writeCapability, stream } = args;
  const counters: ShapeParseCounters = { updated: 0, empty: 0, failed: 0 };
  const pageNumbers = args.pages.map((p) => p.pageNumber);

  let outcomes = new Map<number, PageOutcome>();
  if (args.useLambda) {
    let fanOutThrew = false;
    try {
      outcomes = await scanWithLambda(project, pageNumbers, stream);
    } catch (err) {
      fanOutThrew = true;
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(`[reprocess-shape-parse] Lambda fan-out failed for ${project.name}:`, err);
      stream.send({ type: "warning", project: project.name, message: `Lambda fan-out failed (${reason}) — scanning every page locally` });
      for (const pn of pageNumbers) outcomes.set(pn, { ok: false, reason });
    }
    const lambdaFailed = pageNumbers.filter((pn) => !outcomes.get(pn)?.ok);
    if (lambdaFailed.length > 0 && !fanOutThrew) {
      const first = outcomes.get(lambdaFailed[0]);
      stream.send({
        type: "warning",
        project: project.name,
        message: `Lambda could not scan ${lambdaFailed.length}/${pageNumbers.length} pages (first: ${first && !first.ok ? first.reason : "unknown"}) — local fallback for those pages only`,
      });
    }
  }

  for (const pageNumber of pageNumbers) {
    let outcome = outcomes.get(pageNumber);
    if (!outcome?.ok) {
      if (args.useLambda) {
        stream.debug("fallback.local", { project: project.name, page: pageNumber, reason: outcome && !outcome.ok ? outcome.reason : "not scanned" });
      }
      outcome = await scanLocally(project.dataUrl, pageNumber);
    }
    if (!outcome.ok) {
      counters.failed++;
      logger.error(`[reprocess-shape-parse] Page ${pageNumber} failed for ${project.name}: ${outcome.reason}`);
      stream.debug("page.failed", { project: project.name, page: pageNumber, reason: outcome.reason, kept: "previous results" });
    } else {
      try {
        const swapped = await swapShapeParsePage(
          writeCapability,
          project.id,
          { pageNumber, keynotes: outcome.keynotes },
          outcome.engine === "lambda" ? "reprocess.shapeParse.fanout" : "reprocess.shapeParse.sequential",
        );
        if (swapped.pageMissing) counters.failed++;
        else if (outcome.keynotes.length > 0) counters.updated++;
        else counters.empty++;
        stream.debug("page.written", {
          project: project.name, page: pageNumber, engine: outcome.engine,
          shapes: outcome.keynotes.length, rowsInserted: swapped.annotations.length,
          rowsRemoved: swapped.removedAnnotationIds.length,
        });
      } catch (err) {
        counters.failed++;
        logger.error(`[reprocess-shape-parse] Page ${pageNumber} write failed for ${project.name}:`, err);
        stream.debug("page.write-failed", { project: project.name, page: pageNumber, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    args.onPage?.(counters);
  }
  return counters;
}
