/**
 * The parse-engine run service (table pipeline PLAN §1.2, §1.3 E-3, §3.2; WP-3.E; C1-M3, C1-M8).
 *
 *   POST /api/projects/[id]/parse-engine/parse  → `postParseEngineParse` → `runParse`
 *   (the commit route, WP-3.G, calls `runParse` with `mode: "cache-only"` before it takes any lock)
 *
 * `runParse` is the one place a parse request becomes an engine call:
 *   1. **geometry**: every box (the request box and each continuation part) must have a positive area;
 *   2. **budget gate** (E-3): `thorough` is refused for demo projects and signed-out callers (403), and
 *      needs its tick: `hints.allowPaidTextract` ("Textract this crop ($)") or `hints.tatr`
 *      ("Detect cells (model)"), else 400;
 *   3. **per-caller in-flight cap** (`concurrency.ts`): standard ≤ 2, thorough ≤ 1 → else 429;
 *   4. **evidence**: `loadPageEvidence` (one page, stored slices only; a read, outside any write);
 *   5. **crop methods** for the budget (standard: rulings / img2table; thorough: + the paid Textract crop
 *      / TATR), each through the S3 crop cache (`crop-cache.ts`) under `cropCachePolicy`:
 *        - reads are open to every caller of the route;
 *        - writes happen only for a signed-in caller on a non-demo project: paid results ALWAYS (K17, so a
 *          second paid crop of the same box is free), standard results only while `cropCache` is on;
 *        - demo and signed-out calls never write any cache (C1-M8);
 *        - a paid miss is charged like the classic live Textract (company cap, root exempt but recorded);
 *          over the cap the method is skipped with an error and the engine flags `paid-evidence-skipped`;
 *        - `mode: "cache-only"` (commit) reads paid results from the cache only; a miss throws
 *          `PaidCropExpiredError` (409) so a commit never pays twice;
 *   6. **engine**: `runParseEngine(evidence + crops, request)`. The engine stub (until WP-3.D) throws
 *      `ParseEngineNotImplementedError`; this answers 501.
 * No project or page row is written here, and heavy work never runs inside a project write (rule 11).
 *
 * Crop runners: this WP lands the paid Textract crop (the one with an existing implementation). The
 * rulings runner (`server/services/parse-engine/rulings.ts`, WP-3.B), img2table and TATR join
 * `DEFAULT_CROP_RUNNERS` when the engine is assembled (WP-3.D); a requested method with no runner is
 * reported as `error: "unavailable"`, never silently dropped.
 */

import { downloadFromS3 } from "@/lib/s3";
import { analyzePageImage } from "@/lib/textract";
import { audit } from "@/lib/audit";
import { checkTextractCap, recordComputeUsage } from "@/lib/compute-usage";
import { assertDemoFeatureEnabled } from "@/lib/demo-features";
import { logger } from "@/lib/logger";
import { trustedClientIp } from "@/lib/trusted-client-ip";
import type { AuthSession, ProjectAccessRow, ProjectAccessScope } from "@/lib/api-utils";
import { runParseEngine } from "@/lib/parse-engine/engine";
import {
  ParseEngineNotImplementedError,
  type BboxMinMax,
  type Budget,
  type EnginePageEvidence,
  type ParseEngineFlags,
  type ParseRequest,
  type ParseResult,
} from "@/lib/parse-engine/types";
import type {
  CropMethodId,
  CropMethodOutcome,
  CropTextractEvidence,
  EnginePageEvidenceWithCrops,
} from "@/lib/parse-engine/types-crop";
import type { TextractTable, TextractWord } from "@/types";
import { ApiError } from "@/server/api/envelope";
import { buildPageEvidence, loadPageEvidence, type LoadedPageEvidence } from "./evidence";
import { readParseEngineFlags } from "./flags";
import { acquireParseSlot, type ParseCallerKey } from "./concurrency";
import { q3Box, readCropCache, s3CropCacheStore, writeCropCache, type CropCacheStore } from "./crop-cache";

// ── callers, projects, policy ───────────────────────────────────────────────────────────────────

export interface ParseCaller {
  /** The signed-in user's id, or null for a signed-out (demo) viewer. */
  userId: number | null;
  isRoot: boolean;
  /** Trusted client address (ALB hop): the concurrency key of a signed-out caller. */
  ip: string;
}

export type ParseProject = Pick<ProjectAccessRow, "id" | "companyId" | "isDemo" | "dataUrl">;

/** A call is a "demo call" when the project is a demo, the access was demo-scoped or nobody is signed in. */
export function isDemoCall(project: ParseProject, caller: ParseCaller, scope: ProjectAccessScope | null): boolean {
  return project.isDemo || scope === "demo" || caller.userId === null;
}

export interface CropCachePolicy { readStandard: boolean; readPaid: boolean; writeStandard: boolean; writePaid: boolean }

/** Who may read and write the crop caches (E-3, C1-M8). Pure. */
export function cropCachePolicy(demoCall: boolean, flags: Pick<ParseEngineFlags, "cropCache">): CropCachePolicy {
  return {
    readStandard: flags.cropCache,
    readPaid: true,
    writeStandard: !demoCall && flags.cropCache,
    writePaid: !demoCall,
  };
}

export const callerKey = (caller: ParseCaller): ParseCallerKey =>
  caller.userId !== null ? `user:${caller.userId}` : `ip:${caller.ip}`;

/** The engine is asked for nothing it cannot be given: a positive-area box, and parts likewise. */
function assertBoxes(request: ParseRequest): void {
  for (const b of [request.bbox, ...(request.parts ?? [])]) {
    if (!(b[2] > b[0] && b[3] > b[1])) throw new ApiError("VALIDATION", "Every box must have a positive width and height");
  }
}

/** E-3 budget gate. Throws FORBIDDEN / VALIDATION. */
export function assertBudgetAllowed(request: ParseRequest, demoCall: boolean): void {
  if (request.budget !== "thorough") return;
  if (demoCall) throw new ApiError("FORBIDDEN", "Paid crop methods (Textract, cell detection) need a signed-in account on your own project");
  if (!request.hints?.allowPaidTextract && !request.hints?.tatr) {
    throw new ApiError("VALIDATION", "The thorough budget needs allowPaidTextract or tatr");
  }
}

// ── crop runners ────────────────────────────────────────────────────────────────────────────────

export interface CropRunContext {
  project: ParseProject;
  page: number;
  /** The request box rounded to 3 dp: the crop that is run and the cache key's box. */
  box: BboxMinMax;
  evidence: EnginePageEvidence;
}

export interface CropRunner {
  method: CropMethodId;
  budget: Exclude<Budget, "instant">;
  paid: boolean;
  /** The request asks for this method (thorough runners need their tick). */
  wanted(request: ParseRequest): boolean;
  /** The method's payload, in full-page MinMax coordinates. Throws on failure. */
  run(ctx: CropRunContext): Promise<unknown>;
}

const BUDGET_RANK: Record<Budget, number> = { instant: 0, standard: 1, thorough: 2 };

/** Crop coordinates (0–1 of the crop) → full page, LTWH. */
function remapLtwh(b: readonly number[], box: BboxMinMax): [number, number, number, number] {
  const w = box[2] - box[0];
  const h = box[3] - box[1];
  return [box[0] + b[0] * w, box[1] + b[1] * h, b[2] * w, b[3] * h];
}

/** A Textract crop response mapped back onto the page (words and tables; lines and LAYOUT are dropped). */
export function remapTextractCrop(
  data: { words?: readonly TextractWord[]; tables?: readonly TextractTable[] },
  box: BboxMinMax,
): { words: TextractWord[]; tables: TextractTable[] } {
  return {
    words: (data.words ?? []).map((w) => ({ ...w, bbox: remapLtwh(w.bbox, box) })),
    tables: (data.tables ?? []).map((t) => ({
      ...t,
      bbox: remapLtwh(t.bbox, box),
      cells: t.cells.map((c) => ({ ...c, bbox: remapLtwh(c.bbox, box) })),
    })),
  };
}

/** The cached raw Textract crop → the engine view, through the one evidence conversion (`buildPageEvidence`). */
export function textractCropEvidence(raw: unknown, page: number): CropTextractEvidence | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { words?: unknown }).words)) return null;
  const r = raw as { words: unknown; tables?: unknown };
  const ev = buildPageEvidence({
    pageNumber: page, drawingNumber: null, keynotes: null, csiCodes: null,
    words: r.words, tables: Array.isArray(r.tables) ? r.tables : null, layout: null,
    pageZones: null, regionsV2: null, parsedRegions: null, channels: null, classifierProposals: null, yolo: [],
  }, { recompute: true });
  return { words: ev.words, lines: ev.lines, tables: ev.textractTables };
}

async function cropPagePng(png: Buffer, box: BboxMinMax): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const meta = await sharp(png).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) throw new Error("page image has no size");
  const left = Math.max(0, Math.min(W - 1, Math.round(box[0] * W)));
  const top = Math.max(0, Math.min(H - 1, Math.round(box[1] * H)));
  const width = Math.max(1, Math.min(W - left, Math.round((box[2] - box[0]) * W)));
  const height = Math.max(1, Math.min(H - top, Math.round((box[3] - box[1]) * H)));
  return sharp(png).extract({ left, top, width, height }).png().toBuffer();
}

export interface TextractCropIo {
  downloadPagePng(dataUrl: string, page: number): Promise<Buffer>;
  crop(png: Buffer, box: BboxMinMax): Promise<Buffer>;
  analyze(png: Buffer): Promise<{ words?: TextractWord[]; tables?: TextractTable[] }>;
}

const defaultTextractIo: TextractCropIo = {
  downloadPagePng: (dataUrl, page) => downloadFromS3(`${dataUrl}/pages/page_${String(page).padStart(4, "0")}.png`),
  crop: cropPagePng,
  analyze: analyzePageImage,
};

/** The paid Textract crop (thorough, ticked). Its cached value is the raw crop response mapped onto the page. */
export function textractCropRunner(io: TextractCropIo = defaultTextractIo): CropRunner {
  return {
    method: "textract",
    budget: "thorough",
    paid: true,
    wanted: (request) => request.hints?.allowPaidTextract === true,
    async run({ project, page, box }) {
      if (!project.dataUrl) throw new Error("project has no storage root");
      const png = await io.crop(await io.downloadPagePng(project.dataUrl, page), box);
      return remapTextractCrop(await io.analyze(png), box);
    },
  };
}

/** The runners this release ships. WP-3.D appends rulings (3.B), img2table and TATR. */
export const DEFAULT_CROP_RUNNERS: readonly CropRunner[] = [textractCropRunner()];

/** Methods a request asks for that have no runner yet (reported, never dropped silently). */
const REQUESTED_WITHOUT_RUNNER = (request: ParseRequest, runners: readonly CropRunner[]): CropMethodId[] =>
  request.budget === "thorough" && request.hints?.tatr && !runners.some((r) => r.method === "tatr") ? ["tatr"] : [];

/** A paid crop the commit needs is no longer cached: the user must run it again (and pay) in the workspace. */
export class PaidCropExpiredError extends ApiError {
  readonly methods: CropMethodId[];
  constructor(methods: CropMethodId[]) {
    super("CONFLICT", `A paid result is no longer cached (${methods.join(", ")}); run it again before accepting`);
    this.name = "PaidCropExpiredError";
    this.methods = methods;
  }
}

// ── the run ────────────────────────────────────────────────────────────────────────────────────

export interface RunParseDeps {
  readFlags(): Promise<ParseEngineFlags>;
  loadEvidence(projectId: number, page: number): Promise<LoadedPageEvidence | null>;
  runEngine(evidence: EnginePageEvidenceWithCrops, request: ParseRequest): Promise<ParseResult>;
  cache: CropCacheStore;
  runners: readonly CropRunner[];
  /** Admit one paid crop call (company cap; root exempt) and record its usage. */
  chargePaid(project: ParseProject, caller: ParseCaller, method: CropMethodId, page: number): Promise<boolean>;
  now(): number;
}

async function chargePaidTextract(project: ParseProject, caller: ParseCaller, method: CropMethodId, page: number): Promise<boolean> {
  if (!caller.isRoot) {
    const cap = await checkTextractCap(project.companyId, 1);
    if (!cap.allowed) {
      audit("textract_cap_hit", { userId: caller.userId ?? undefined, companyId: project.companyId, details: { projectId: project.id, pageNumber: page, surface: "parse-engine", method } });
      return false;
    }
  }
  await recordComputeUsage({ companyId: project.companyId, userId: caller.userId, projectId: project.id, resource: "textract", pages: 1 }).catch(() => {});
  return true;
}

export const defaultRunParseDeps: RunParseDeps = {
  readFlags: readParseEngineFlags,
  loadEvidence: (projectId, page) => loadPageEvidence(null, projectId, page),
  runEngine: (evidence, request) => runParseEngine(evidence, request),
  cache: s3CropCacheStore,
  runners: DEFAULT_CROP_RUNNERS,
  chargePaid: chargePaidTextract,
  now: () => Date.now(),
};

export interface RunParseInput {
  project: ParseProject;
  caller: ParseCaller;
  scope: ProjectAccessScope | null;
  request: ParseRequest;
  /** "cache-only": paid methods are served from the crop cache only (the commit re-run, WP-3.G). */
  mode?: "live" | "cache-only";
  /** Pre-read flags (the route already read them); read here otherwise. */
  flags?: ParseEngineFlags;
}

async function gatherCrops(
  input: RunParseInput, evidence: EnginePageEvidence, flags: ParseEngineFlags, deps: RunParseDeps,
): Promise<Partial<Record<CropMethodId, CropMethodOutcome>>> {
  const { project, caller, scope, request } = input;
  const policy = cropCachePolicy(isDemoCall(project, caller, scope), flags);
  const box = q3Box(request.bbox);
  const out: Partial<Record<CropMethodId, CropMethodOutcome>> = {};
  const expired: CropMethodId[] = [];
  const runners = deps.runners.filter((r) => BUDGET_RANK[r.budget] <= BUDGET_RANK[request.budget] && r.wanted(request));
  for (const method of REQUESTED_WITHOUT_RUNNER(request, deps.runners)) {
    out[method] = { method, budget: "thorough", paid: true, box, cached: false, error: "unavailable" };
  }
  for (const runner of runners) {
    const base = { method: runner.method, budget: runner.budget, paid: runner.paid, box };
    const t0 = deps.now();
    const canRead = runner.paid ? policy.readPaid : policy.readStandard;
    const canWrite = runner.paid ? policy.writePaid : policy.writeStandard;
    if (canRead && project.dataUrl) {
      const hit = await readCropCache(deps.cache, project.dataUrl, request.page, box, runner.method);
      if (hit) {
        out[runner.method] = { ...base, cached: true, value: hit.value, ms: deps.now() - t0 };
        continue;
      }
    }
    if (runner.paid && input.mode === "cache-only") {
      expired.push(runner.method);
      continue;
    }
    if (runner.paid && !(await deps.chargePaid(project, caller, runner.method, request.page))) {
      out[runner.method] = { ...base, cached: false, error: "cap-reached", ms: deps.now() - t0 };
      continue;
    }
    try {
      const value = await runner.run({ project, page: request.page, box, evidence });
      if (canWrite && project.dataUrl) await writeCropCache(deps.cache, project.dataUrl, request.page, box, runner.method, value);
      out[runner.method] = { ...base, cached: false, value, ms: deps.now() - t0 };
    } catch (err) {
      logger.warn("[parse-engine] crop method failed; it casts no vote", { method: runner.method, projectId: project.id, page: request.page, error: err });
      out[runner.method] = { ...base, cached: false, error: "failed", ms: deps.now() - t0 };
    }
  }
  if (expired.length) throw new PaidCropExpiredError(expired);
  // The engine reads the Textract crop in its own coordinates (the cache holds the raw response).
  const tx = out.textract;
  if (tx?.value !== undefined) {
    const view = textractCropEvidence(tx.value, request.page);
    out.textract = view ? { ...tx, value: view } : { ...tx, value: undefined, error: "malformed" };
  }
  return out;
}

/** One parse: budget gate, in-flight cap, evidence, crop methods (cached), engine. See the header. */
export async function runParse(input: RunParseInput, deps: RunParseDeps = defaultRunParseDeps): Promise<ParseResult> {
  const { project, caller, scope, request } = input;
  assertBoxes(request);
  assertBudgetAllowed(request, isDemoCall(project, caller, scope));
  const slot = acquireParseSlot(callerKey(caller), request.budget, deps.now());
  if (!slot) {
    throw new ApiError("RATE_LIMITED", `Too many ${request.budget} parses in flight for this account; try again when one finishes`);
  }
  try {
    const flags = input.flags ?? (await deps.readFlags());
    const loaded = await deps.loadEvidence(project.id, request.page);
    if (!loaded) throw new ApiError("NOT_FOUND", "Page not found");
    const { sources: _sources, ...evidence } = loaded;
    void _sources; // raw OCR slices never reach the engine (it takes EnginePageEvidence)
    const crops = request.budget === "instant" ? {} : await gatherCrops(input, evidence, flags, deps);
    const engineInput: EnginePageEvidenceWithCrops = Object.keys(crops).length ? { ...evidence, crops } : evidence;
    try {
      return await deps.runEngine(engineInput, request);
    } catch (err) {
      if (err instanceof ParseEngineNotImplementedError || (err as { code?: unknown } | null)?.code === "NOT_IMPLEMENTED") {
        throw new ApiError("INTERNAL", "The parse engine is not available yet", 501);
      }
      throw err;
    }
  } finally {
    slot.release();
  }
}

// ── the route service ──────────────────────────────────────────────────────────────────────────

export interface ParseRouteContext {
  req: Request;
  body: ParseRequest;
  project: ProjectAccessRow;
  session: AuthSession | null;
  scope: ProjectAccessScope | null;
}

/** POST /api/projects/[id]/parse-engine/parse — compute only; see the header. */
export async function postParseEngineParse(ctx: ParseRouteContext, deps: RunParseDeps = defaultRunParseDeps): Promise<ParseResult> {
  const flags = await deps.readFlags();
  // The workspace is the only caller of this route; the kill switch (or workspace=legacy) turns it off.
  if (flags.tools.workspace !== "engine") throw new ApiError("FORBIDDEN", "The parse engine is switched off");
  if (ctx.project.isDemo && (await assertDemoFeatureEnabled(ctx.project.companyId, "tableParse"))) {
    throw new ApiError("FORBIDDEN", "Table parsing is disabled for this demo");
  }
  const caller: ParseCaller = {
    userId: typeof ctx.session?.user?.dbId === "number" ? ctx.session.user.dbId : null,
    isRoot: ctx.session?.user?.isRootAdmin === true,
    ip: trustedClientIp(ctx.req.headers.get("x-forwarded-for")),
  };
  return runParse({ project: ctx.project, caller, scope: ctx.scope, request: ctx.body, flags }, deps);
}
