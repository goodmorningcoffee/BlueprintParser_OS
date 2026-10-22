// [2026-10-21/22 owner asks] Cost estimate for YOLO SageMaker runs, shown next to Run all / Run on
// selected / each per-project Run (root only). Pure and client-safe.
//
//   ≈ $X · N pages · J jobs  =  Σ_jobs (startup_s + pages × s_per_page ÷ GPUs) × $/h ÷ 3600
//
// startup_s and s_per_page are fitted from completed YOLO processing_jobs (per model × instance; see
// services/yolo-run-stats.ts). With no history the stated defaults below are used and LABELLED as an
// assumption. A job's estimated runtime above the root-set timeout (MaxRuntimeInSeconds) is flagged:
// SageMaker stops it there, so its results would be incomplete.
// [2026-10-22] s_per_page is per GPU: the inference script spreads a job's pages over every GPU of the
// machine, so a job's inference time divides by the instance's GPU count. Bulk runs are planned as
// batched jobs (src/lib/yolo-chunk-plan.ts) — see yoloBatchEstimateFor.

import type { YoloInstanceOption } from "@/lib/yolo-instances";
import {
  estimateYoloBatchRun,
  planYoloChunks,
  type YoloBatchRunEstimate,
  type YoloChunk,
  type YoloChunkProject,
} from "@/lib/yolo-chunk-plan";

export const DEFAULT_YOLO_STARTUP_SECONDS = 240;
export const DEFAULT_YOLO_SECONDS_PER_PAGE = 1.5;
/** Fewer distinct page counts than this → no slope fit; the startup default is used instead. */
const MIN_RUNS_FOR_FIT = 3;
const MAX_STARTUP_SECONDS = 1800;
// [2026-10-22] A fit implying < 30 s boot or > 10 s/page per GPU is an outlier artefact (seen: 0 s + 64.68 s/page).
const MIN_FIT_STARTUP_SECONDS = 30, MAX_SECONDS_PER_PAGE = 10;

export interface YoloRunSample {
  pages: number;
  seconds: number;
}

export interface YoloRunTiming {
  startupSeconds: number;
  secondsPerPage: number;
  /** Past runs the numbers came from; 0 = the stated default assumption. */
  runs: number;
  /** "model" = this model on this instance; "instance" = any model on this instance; "default". */
  basis: "model" | "instance" | "default";
}

export const DEFAULT_YOLO_RUN_TIMING: YoloRunTiming = {
  startupSeconds: DEFAULT_YOLO_STARTUP_SECONDS,
  secondsPerPage: DEFAULT_YOLO_SECONDS_PER_PAGE,
  runs: 0,
  basis: "default",
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Fit startup + per-page seconds to past runs. ≥3 runs over ≥2 distinct page counts → least squares
 * (clamped: startup 0–30 min, per-page ≥ 0); otherwise the default startup with the mean per-page
 * remainder. Invalid samples are ignored; no valid sample → null.
 */
export function fitYoloRunTiming(samples: readonly YoloRunSample[]): Omit<YoloRunTiming, "basis"> | null {
  const ok = samples.filter(
    (s) => Number.isFinite(s.pages) && Number.isFinite(s.seconds) && s.pages > 0 && s.seconds > 0,
  );
  if (ok.length === 0) return null;
  const n = ok.length;
  const meanP = ok.reduce((a, s) => a + s.pages, 0) / n;
  const meanS = ok.reduce((a, s) => a + s.seconds, 0) / n;
  const varP = ok.reduce((a, s) => a + (s.pages - meanP) ** 2, 0);
  if (n >= MIN_RUNS_FOR_FIT && varP > 0) {
    const slope = ok.reduce((a, s) => a + (s.pages - meanP) * (s.seconds - meanS), 0) / varP;
    if (slope >= 0 && slope <= MAX_SECONDS_PER_PAGE && meanS - slope * meanP >= MIN_FIT_STARTUP_SECONDS) {
      const startup = clamp(meanS - slope * meanP, 0, MAX_STARTUP_SECONDS);
      return { startupSeconds: Math.round(startup), secondsPerPage: round2(slope), runs: n };
    }
  }
  const startup = Math.min(DEFAULT_YOLO_STARTUP_SECONDS, ...ok.map((s) => s.seconds));
  const perPage = ok.reduce((a, s) => a + Math.max(0, s.seconds - startup) / s.pages, 0) / n;
  return { startupSeconds: Math.round(startup), secondsPerPage: round2(Math.min(perPage, MAX_SECONDS_PER_PAGE)), runs: n };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export interface YoloRunStat extends Omit<YoloRunTiming, "basis"> {
  /** null = any model (the per-instance pool). */
  modelId: number | null;
  instanceType: string;
}

/** The best timing for a model on an instance: this model's history, else the instance's, else the default. */
export function pickYoloRunTiming(
  stats: readonly YoloRunStat[],
  modelId: number,
  instanceType: string,
): YoloRunTiming {
  const own = stats.find((s) => s.modelId === modelId && s.instanceType === instanceType);
  if (own) return { ...own, basis: "model" };
  const pool = stats.find((s) => s.modelId === null && s.instanceType === instanceType);
  if (pool) return { ...pool, basis: "instance" };
  return DEFAULT_YOLO_RUN_TIMING;
}

export interface YoloCostEstimate {
  usd: number;
  pages: number;
  jobs: number;
  /** Projects with no page count (their runs are refused by the server, so they cost nothing). */
  unknownPages: number;
  /** Jobs whose estimated runtime exceeds the timeout. */
  overTimeout: number;
  longestJobSeconds: number;
}

export function estimateYoloCost(
  pagesPerJob: readonly (number | null | undefined)[],
  usdPerHour: number,
  timing: Pick<YoloRunTiming, "startupSeconds" | "secondsPerPage">,
  maxRuntimeSeconds: number,
  gpus = 1,
): YoloCostEstimate {
  const devices = Math.max(1, Math.floor(gpus) || 1);
  let seconds = 0;
  let pages = 0;
  let jobs = 0;
  let unknownPages = 0;
  let overTimeout = 0;
  let longest = 0;
  for (const p of pagesPerJob) {
    if (!p || p <= 0) {
      unknownPages += 1;
      continue;
    }
    // A job is billed until it ends or the timeout stops it.
    const raw = timing.startupSeconds + (p * timing.secondsPerPage) / devices;
    if (raw > maxRuntimeSeconds) overTimeout += 1;
    const billed = Math.min(raw, maxRuntimeSeconds);
    seconds += billed;
    longest = Math.max(longest, raw);
    pages += p;
    jobs += 1;
  }
  return { usd: (seconds * usdPerHour) / 3600, pages, jobs, unknownPages, overTimeout, longestJobSeconds: longest };
}

export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export function formatMinutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m >= 120 && m % 60 === 0 ? `${m / 60} h` : `${m} min`;
}

/** e.g. "≈ $1.23 · 840 pages · 3 jobs". */
export function yoloCostHeadline(e: YoloCostEstimate): string {
  return `≈ ${formatUsd(e.usd)} · ${e.pages} page${e.pages === 1 ? "" : "s"} · ${e.jobs} job${e.jobs === 1 ? "" : "s"}`;
}

/** "based on K past runs" or the stated assumption. */
export function yoloTimingBasis(t: YoloRunTiming): string {
  if (t.basis === "default" || t.runs === 0) {
    return `assumed ${t.startupSeconds} s startup + ${t.secondsPerPage} s/page (no past runs on this instance)`;
  }
  const scope = t.basis === "model" ? "" : " (any model)";
  return `based on ${t.runs} past run${t.runs === 1 ? "" : "s"}${scope}: ${t.startupSeconds} s startup + ${t.secondsPerPage} s/page`;
}

// ── GET /api/admin/yolo-instance/options payload (shared by the server and the admin UI) ──────────

export interface YoloCatalogOption extends YoloInstanceOption {
  priceSource: "live" | "table";
  /** Processing-job instance quota; null when quotas could not be read. */
  quota: number | null;
}

export interface YoloInstanceCatalog {
  region: string;
  checkedAt: string;
  quotaStatus: "live" | "unavailable";
  /** live = every type priced live; partial = some from the table; approximate = all from the table. */
  priceStatus: "live" | "partial" | "approximate";
  priceTableAsOf: string;
  options: YoloCatalogOption[];
}

export interface YoloInstanceOptionsResponse {
  instanceType: string;
  valid: boolean;
  defaultInstanceType: string;
  maxRuntimeSeconds: number;
  runtimeBounds: { min: number; max: number; default: number };
  catalog: YoloInstanceCatalog;
  runStats: YoloRunStat[];
}

/**
 * The picker's choices (owner 2026-10-21): with live quotas, ONLY the allowlisted types whose
 * processing quota is > 0 (the saved type is kept in the list even at 0 so the select never lies);
 * quotas unreachable → the whole allowlist, and the caller warns "quota could not be checked".
 */
export function selectableYoloOptions(
  catalog: YoloInstanceCatalog,
  current: string,
): { options: YoloCatalogOption[]; zeroQuota: YoloCatalogOption[] } {
  if (catalog.quotaStatus !== "live") return { options: [...catalog.options], zeroQuota: [] };
  const options = catalog.options.filter((o) => (o.quota ?? 0) > 0 || o.type === current);
  const zeroQuota = catalog.options.filter((o) => (o.quota ?? 0) <= 0 && o.gpu !== null);
  return { options, zeroQuota };
}

/** The estimate for one model on the CURRENT instance over these projects' page counts, or null. */
export function yoloEstimateFor(
  data: YoloInstanceOptionsResponse | null,
  modelId: number,
  pagesPerJob: readonly (number | null | undefined)[],
): { estimate: YoloCostEstimate; timing: YoloRunTiming; option: YoloCatalogOption; maxRuntimeSeconds: number } | null {
  if (!data) return null;
  const option = data.catalog.options.find((o) => o.type === data.instanceType);
  if (!option) return null;
  const timing = pickYoloRunTiming(data.runStats, modelId, data.instanceType);
  return {
    estimate: estimateYoloCost(pagesPerJob, option.usdPerHour, timing, data.maxRuntimeSeconds, option.gpus),
    timing,
    option,
    maxRuntimeSeconds: data.maxRuntimeSeconds,
  };
}

/** One-line text for the bulk bar / confirm dialog. */
export function yoloEstimateText(e: NonNullable<ReturnType<typeof yoloEstimateFor>>): string {
  const price = `${e.option.type} @ ${formatUsd(e.option.usdPerHour)}/h${e.option.priceSource === "live" ? "" : " (approx.)"}`;
  const parts = [yoloCostHeadline(e.estimate), price, yoloTimingBasis(e.timing), `timeout ${formatMinutes(e.maxRuntimeSeconds)}`];
  if (e.estimate.overTimeout > 0) {
    parts.push(`⚠ ${e.estimate.overTimeout} job${e.estimate.overTimeout === 1 ? "" : "s"} may hit the timeout (longest ≈ ${formatMinutes(e.estimate.longestJobSeconds)})`);
  }
  if (e.estimate.unknownPages > 0) parts.push(`${e.estimate.unknownPages} with unknown page count (refused, $0)`);
  return parts.join(" · ");
}

/** GPUs a job gets on this instance type (a CPU type counts as one device). */
export function gpusPerMachine(option: Pick<YoloInstanceOption, "gpus">): number {
  return Math.max(1, Math.floor(option.gpus) || 1);
}

/** The batched-job plan + estimate for a bulk run with `machines` jobs at once on the CURRENT instance. */
export function yoloBatchEstimateFor(
  data: YoloInstanceOptionsResponse | null,
  modelId: number,
  projects: readonly YoloChunkProject[],
  machines: number,
): {
  chunks: YoloChunk[];
  estimate: YoloBatchRunEstimate;
  timing: YoloRunTiming;
  option: YoloCatalogOption;
  machines: number;
  maxRuntimeSeconds: number;
  unknownPages: number;
} | null {
  if (!data) return null;
  const option = data.catalog.options.find((o) => o.type === data.instanceType);
  if (!option) return null;
  const timing = pickYoloRunTiming(data.runStats, modelId, data.instanceType);
  const chunks = planYoloChunks(projects, {
    machines,
    gpusPerMachine: gpusPerMachine(option),
    timing,
    maxRuntimeSeconds: data.maxRuntimeSeconds,
  });
  return {
    chunks,
    estimate: estimateYoloBatchRun(chunks, machines, option.usdPerHour, data.maxRuntimeSeconds),
    timing,
    option,
    machines,
    maxRuntimeSeconds: data.maxRuntimeSeconds,
    unknownPages: projects.filter((p) => !(typeof p.pages === "number" && p.pages > 0)).length,
  };
}

/** One-line text for the bulk bar / confirm dialog: total $, wall clock, jobs, machines. */
export function yoloBatchEstimateText(e: NonNullable<ReturnType<typeof yoloBatchEstimateFor>>): string {
  const x = e.estimate;
  const price = `${e.option.type} @ ${formatUsd(e.option.usdPerHour)}/h${e.option.priceSource === "live" ? "" : " (approx.)"}`;
  const parts = [
    `≈ ${formatUsd(x.usd)} · ${x.pages} page${x.pages === 1 ? "" : "s"} · ${x.jobs} job${x.jobs === 1 ? "" : "s"}`,
    `≈ ${formatMinutes(x.wallSeconds)} wall clock on ${e.machines} machine${e.machines === 1 ? "" : "s"}${x.waves > 1 ? ` (${x.waves} waves)` : ""}`,
    price,
    yoloTimingBasis(e.timing),
    `timeout ${formatMinutes(e.maxRuntimeSeconds)}`,
  ];
  if (x.overTimeout > 0) {
    parts.push(`⚠ ${x.overTimeout} job${x.overTimeout === 1 ? "" : "s"} may hit the timeout (longest ≈ ${formatMinutes(x.longestJobSeconds)})`);
  }
  if (e.unknownPages > 0) parts.push(`${e.unknownPages} with unknown page count (refused, $0)`);
  return parts.join(" · ");
}
