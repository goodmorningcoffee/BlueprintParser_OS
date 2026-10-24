// [cross-set F3 2026-10-24] Knowledge graph v2 — links between SETS (projects) of ONE company.
//
// Pure: no DB, no S3, no logging. The service (src/server/services/cross-set-links.ts) streams a
// company's pages through reduceCrossSetProject one project at a time, keeps only the reduced keys,
// and hands the lot to computeCrossSetLinks. Three link kinds:
//   • twin_of      (sheet ↔ sheet)      identical comparable page text (page-dedup pageTextKey) in
//                                       two projects — confidence 1. A text owned by more than
//                                       CROSS_PROJECT_MAX_OWNERS projects is a stock sheet (firm
//                                       standard notes), not a link: dropped and counted.
//   • revision_of  (sheet → sheet)      the same normalised sheet number in two projects AND content
//                                       support: 3-shingle Jaccard over the boilerplate-stripped
//                                       normalised lines ≥ REVISION_MIN_CONTENT (confidence = that
//                                       score). Direction: older project → newer (createdAt).
//                                       Pairs that are already twins are not repeated here.
//   • copy_of      (project → project)  page-dedup crossProjectReport copy=true (≥ 95 % of the newer
//                                       project's comparable pages found in the older one).
// Never on sheet number alone and never on visual similarity: the "number twins" generator was
// refuted at .30 precision (master_plan_2026-10-24/notes/gaussian_tools.md §2.1–2.2) — A-101 exists
// in every architectural set. Cost is ~O(Σ bucket²): pages are bucketed by text key and by sheet
// key, a bucket over BUCKET_PAGE_CAP pages is dropped whole, and the company's sheet buckets share
// ONE comparison budget (COMPARISON_BUDGET); everything dropped is counted in `dropped` so the caller
// can log it. The compute is a generator: computeCrossSetLinks drains it synchronously (tests, the
// measure script), computeCrossSetLinksAsync gives the event loop a turn at every yield — the web
// process runs it inside a request and must keep answering its health check.

import { CROSS_PROJECT_MAX_OWNERS, crossProjectReport, pageTextKey } from "../page-dedup/cross-project";
import { DEDUP_THRESHOLDS } from "../page-dedup/detect";
import { boilerplateLines, normalizeDrawingNumber, normalizeLine, normalizedLines, removePhrase, tokensOf } from "../page-dedup/normalize";
import { jaccard, jaccardUpperBound, shingles } from "../page-dedup/similarity";
import { normaliseSheetNumber } from "./sheet-number";

export const CROSS_SET_VERSION = 1;

/**
 * Content-score floor for revision_of. The in-project detector's review floor is 0.70 and its
 * "near" line 0.90 (DEDUP_THRESHOLDS); across sets the title block, dates and issue stamps differ
 * on every page, so even after the per-project boilerplate strip a genuinely re-issued sheet scores
 * lower than an in-set duplicate. 0.5 is the point where fewer than half the 3-word shingles are
 * shared — below it two "A-101"s are two floor plans that merely share a legend. Measured on the
 * corpus by scripts/cross-set-links-measure.ts (the score distribution is printed there).
 */
export const REVISION_MIN_CONTENT = 0.5;
/**
 * A page takes part in revision_of only with this many content shingles (≈ 22 own tokens after the
 * boilerplate strip) AND DEDUP_THRESHOLDS.minContentTokens tokens — the in-project detector's
 * `eligible` rule. Below it two pages whose own text is "FIRST FLOOR PLAN" (one shingle each) score
 * 1.0 on the same sheet number: a link on the number plus a generic title, the refuted generator.
 */
export const REVISION_MIN_SHINGLES = 20;
/** A text / sheet bucket with more pages than this is dropped whole (counted), never compared. */
export const BUCKET_PAGE_CAP = 100;
/**
 * Jaccard evaluations allowed per company pass; sheet buckets past it are skipped (counted). One
 * evaluation over ~800-shingle pages costs ~18 µs, so this is ~10 s of CPU, handed out in slices.
 */
export const COMPARISON_BUDGET = 500_000;
/** The async runner yields to the event loop after this many comparisons (and after every bucket). */
export const YIELD_EVERY = 2_000;
/** Title text kept per page (page name as stored). */
export const TITLE_CAP = 120;

// ── input ──────────────────────────────────────────────────────────────────────────────────────

export interface CrossSetPageInput {
  pageNumber: number;
  drawingNumber: string | null;
  /** The page's stored name (title-block title); optional. */
  title?: string | null;
  rawText: string | null;
  /** Hidden duplicate (lib/page-dedup visibility) — never linked. */
  hidden?: boolean;
}

export interface CrossSetProjectInput {
  publicId: string;
  /** ISO string or Date; orders revision_of (older → newer) and copy_of (original → copy). */
  createdAt: string | Date | null;
  pages: CrossSetPageInput[];
}

// ── reduced form (what the service keeps in memory per page) ───────────────────────────────────

export interface CrossSetPageKey {
  pageNumber: number;
  drawingNumber: string | null;
  /** normaliseSheetNumber(drawingNumber); null → never a revision candidate. */
  sheetKey: string | null;
  title: string | null;
  /** normalizeLine(title) for the title-match flag. */
  titleKey: string | null;
  /** page-dedup pageTextKey — exact-text identity. */
  textKey: string;
  /** 3-shingles over the boilerplate-stripped normalised lines (the detector's `content` recipe). */
  content: Uint32Array;
  /** Own tokens behind `content`; with `content.length` it gates revision_of (REVISION_MIN_SHINGLES). */
  contentTokens: number;
}

export interface CrossSetProjectKeys {
  publicId: string;
  createdAt: string;
  pages: CrossSetPageKey[];
  /** Pages left out: hidden duplicates, and pages too blank to compare (pageTextKey null). */
  omitted: { hidden: number; blank: number };
}

function isoOf(value: string | Date | null): string {
  if (!value) return "";
  const d = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/** Reduce one project's pages to keys + shingles; the raw text is not retained. */
export function reduceCrossSetProject(input: CrossSetProjectInput): CrossSetProjectKeys {
  const visible = input.pages.filter((p) => !p.hidden);
  const lines = visible.map((p) => normalizedLines(p.rawText));
  const boiler = boilerplateLines(lines);
  const pages: CrossSetPageKey[] = [];
  let blank = 0;
  visible.forEach((p, i) => {
    const textKey = pageTextKey(p.rawText);
    if (!textKey) { blank++; return; }
    const dn = normalizeDrawingNumber(p.drawingNumber);
    const contentLines: string[] = [];
    for (const line of lines[i]) {
      if (boiler.has(line)) continue;
      const stripped = removePhrase(line, dn);
      if (stripped) contentLines.push(stripped);
    }
    const title = p.title ? p.title.trim().slice(0, TITLE_CAP) : null;
    const titleKey = title ? normalizeLine(title) || null : null;
    const contentTokens = tokensOf(contentLines);
    pages.push({
      pageNumber: p.pageNumber,
      drawingNumber: p.drawingNumber,
      sheetKey: normaliseSheetNumber(p.drawingNumber),
      title: title || null,
      titleKey,
      textKey,
      content: shingles(contentTokens),
      contentTokens: contentTokens.length,
    });
  });
  return { publicId: input.publicId, createdAt: isoOf(input.createdAt), pages, omitted: { hidden: input.pages.length - visible.length, blank } };
}

// ── output ─────────────────────────────────────────────────────────────────────────────────────

export type CrossSetLinkKind = "twin_of" | "revision_of";

export interface CrossSetEnd {
  project: string;
  page: number;
  sheet: string | null;
}

export interface CrossSetPageLink {
  kind: CrossSetLinkKind;
  /** The page in the OLDER project (createdAt, then publicId). */
  from: CrossSetEnd;
  /** The page in the newer project. */
  to: CrossSetEnd;
  /** twin_of = 1; revision_of = the content Jaccard. */
  confidence: number;
  /** Both pages carry the same normalised title (revision_of only; a supporting signal, not a gate).
   *  pages.name is usually the drawing number itself, so this is informative only for hand-named pages. */
  titleMatch?: boolean;
}

export interface CrossSetProjectLink {
  kind: "copy_of";
  /** The copy (newer project). */
  from: string;
  /** The original (older project). */
  to: string;
  /** Distinct page texts of the copy found in the original / its comparable pages. */
  shared: number;
  pages: number;
}

export interface CrossSetDropped {
  /** Text keys owned by more than CROSS_PROJECT_MAX_OWNERS projects (stock sheets). */
  stockTexts: number;
  /** Pages whose sheet content matched more than CROSS_PROJECT_MAX_OWNERS projects (a firm-standard
   *  sheet that differs only by project name): their revision_of links were dropped. */
  stockSheets: number;
  /** Buckets over BUCKET_PAGE_CAP pages, dropped whole. */
  oversizedBuckets: number;
  /** Sheet buckets skipped, whole or in part, once COMPARISON_BUDGET was spent. */
  truncatedBuckets: number;
  /** Comparisons actually made (Jaccard evaluations, after the size prefilter). */
  comparisons: number;
}

export interface CrossSetLinks {
  v: typeof CROSS_SET_VERSION;
  computedAt: string;
  projects: number;
  pages: number;
  links: CrossSetPageLink[];
  projectLinks: CrossSetProjectLink[];
  dropped: CrossSetDropped;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/** Older first: createdAt ascending ("" — unknown — last), then publicId. */
export function sortByAge<T extends { createdAt: string; publicId: string }>(projects: readonly T[]): T[] {
  return [...projects].sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      if (!a.createdAt) return 1;
      if (!b.createdAt) return -1;
      return a.createdAt < b.createdAt ? -1 : 1;
    }
    return a.publicId.localeCompare(b.publicId);
  });
}

export interface CrossSetComputeOptions {
  now?: Date;
  revisionMin?: number;
  /** Override of COMPARISON_BUDGET (tests, the measure script). */
  comparisonBudget?: number;
}

type Slot = { pi: number; page: CrossSetPageKey };
const revisionEligible = (p: CrossSetPageKey) => p.contentTokens >= DEDUP_THRESHOLDS.minContentTokens && p.content.length >= REVISION_MIN_SHINGLES;

/**
 * The compute itself, one yield per sheet bucket and per YIELD_EVERY comparisons. Both runners drain
 * it and then call `finish`; nothing is observable until then.
 */
function startCrossSetLinks(input: readonly CrossSetProjectKeys[], opts: CrossSetComputeOptions) {
  const projects = sortByAge(input);
  const revisionMin = opts.revisionMin ?? REVISION_MIN_CONTENT;
  const budget = opts.comparisonBudget ?? COMPARISON_BUDGET;
  const dropped: CrossSetDropped = { stockTexts: 0, stockSheets: 0, oversizedBuckets: 0, truncatedBuckets: 0, comparisons: 0 };
  const links: CrossSetPageLink[] = [];
  const end = (pi: number, page: CrossSetPageKey): CrossSetEnd => ({ project: projects[pi].publicId, page: page.pageNumber, sheet: page.drawingNumber });

  function* steps(): Generator<void, void, void> {
    // 1. twin_of — bucket by exact text key.
    const byText = new Map<string, Slot[]>();
    for (let pi = 0; pi < projects.length; pi++) {
      for (const page of projects[pi].pages) {
        const list = byText.get(page.textKey);
        if (list) list.push({ pi, page });
        else byText.set(page.textKey, [{ pi, page }]);
      }
    }
    for (const slots of byText.values()) {
      const owners = new Set(slots.map((s) => s.pi));
      if (owners.size < 2) continue;
      if (owners.size > CROSS_PROJECT_MAX_OWNERS) { dropped.stockTexts++; continue; }
      if (slots.length > BUCKET_PAGE_CAP) { dropped.oversizedBuckets++; continue; }
      for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
          if (slots[i].pi === slots[j].pi) continue; // in-project duplicates are the v1 graph's business
          links.push({ kind: "twin_of", from: end(slots[i].pi, slots[i].page), to: end(slots[j].pi, slots[j].page), confidence: 1 });
        }
      }
      yield;
    }

    // 2. revision_of — bucket by normalised sheet number; content support required, thin pages out.
    const bySheet = new Map<string, Slot[]>();
    for (let pi = 0; pi < projects.length; pi++) {
      for (const page of projects[pi].pages) {
        if (!page.sheetKey || !revisionEligible(page)) continue;
        const list = bySheet.get(page.sheetKey);
        if (list) list.push({ pi, page });
        else bySheet.set(page.sheetKey, [{ pi, page }]);
      }
    }
    let sinceYield = 0;
    for (const slots of bySheet.values()) {
      if (new Set(slots.map((s) => s.pi)).size < 2) continue;
      if (slots.length > BUCKET_PAGE_CAP) { dropped.oversizedBuckets++; continue; }
      if (dropped.comparisons >= budget) { dropped.truncatedBuckets++; continue; }
      // Candidates of this bucket, then the stock rule: a page whose content matched more than
      // CROSS_PROJECT_MAX_OWNERS projects is a firm-standard sheet, and none of its links survive.
      const found: Array<{ i: number; j: number; score: number; titleMatch: boolean }> = [];
      const matched = new Map<number, Set<number>>();
      const note = (slot: number, otherPi: number) => { const set = matched.get(slot); if (set) set.add(otherPi); else matched.set(slot, new Set([otherPi])); };
      let truncated = false;
      outer: for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
          const a = slots[i];
          const b = slots[j];
          if (a.pi === b.pi) continue;
          if (a.page.textKey === b.page.textKey) continue; // twin (or stock): not a revision
          if (jaccardUpperBound(a.page.content.length, b.page.content.length) < revisionMin) continue;
          if (dropped.comparisons >= budget) { truncated = true; break outer; }
          dropped.comparisons++;
          if (++sinceYield >= YIELD_EVERY) { sinceYield = 0; yield; }
          const score = jaccard(a.page.content, b.page.content);
          if (score < revisionMin) continue;
          note(i, b.pi);
          note(j, a.pi);
          found.push({ i, j, score, titleMatch: Boolean(a.page.titleKey && a.page.titleKey === b.page.titleKey) });
        }
      }
      const stock = new Set<number>();
      for (const [slot, owners] of matched) if (owners.size > CROSS_PROJECT_MAX_OWNERS) stock.add(slot);
      dropped.stockSheets += stock.size;
      for (const f of found) {
        if (stock.has(f.i) || stock.has(f.j)) continue;
        const a = slots[f.i];
        const b = slots[f.j];
        links.push({ kind: "revision_of", from: end(a.pi, a.page), to: end(b.pi, b.page), confidence: round(f.score), ...(f.titleMatch ? { titleMatch: true } : {}) });
      }
      if (truncated) dropped.truncatedBuckets++;
      yield;
    }
  }

  function finish(): CrossSetLinks {
    // 3. copy_of — the exact-copy report, oldest project first so B is always the newer one.
    const projectLinks: CrossSetProjectLink[] = crossProjectReport(projects.map((p) => ({ project: p.publicId, keys: p.pages.map((pg) => pg.textKey) })))
      .filter((pair) => pair.copy)
      .map((pair) => ({ kind: "copy_of", from: pair.b, to: pair.a, shared: pair.shared, pages: pair.bPages }));

    links.sort((x, y) => x.from.project.localeCompare(y.from.project) || x.from.page - y.from.page || x.to.project.localeCompare(y.to.project) || x.to.page - y.to.page || x.kind.localeCompare(y.kind));
    return {
      v: CROSS_SET_VERSION,
      computedAt: (opts.now ?? new Date()).toISOString(),
      projects: projects.length,
      pages: projects.reduce((n, p) => n + p.pages.length, 0),
      links,
      projectLinks,
      dropped,
    };
  }

  return { steps: steps(), finish };
}

/** Links over reduced projects, in one synchronous pass. Input order does not matter: projects are sorted by age here. */
export function computeCrossSetLinks(input: readonly CrossSetProjectKeys[], opts: CrossSetComputeOptions = {}): CrossSetLinks {
  const run = startCrossSetLinks(input, opts);
  while (!run.steps.next().done) { /* drain */ }
  return run.finish();
}

const giveEventLoopATurn = (): Promise<void> =>
  new Promise((resolve) => (typeof setImmediate === "function" ? setImmediate(resolve) : setTimeout(resolve, 0)));

/**
 * The same links, with the event loop given a turn after every bucket and every YIELD_EVERY
 * comparisons — the service's runner (a large company is minutes of CPU, never one unbroken block).
 * `yieldFn` replaces the turn (tests count it).
 */
export async function computeCrossSetLinksAsync(input: readonly CrossSetProjectKeys[], opts: CrossSetComputeOptions & { yieldFn?: () => Promise<void> } = {}): Promise<CrossSetLinks> {
  const run = startCrossSetLinks(input, opts);
  const turn = opts.yieldFn ?? giveEventLoopATurn;
  while (!run.steps.next().done) await turn();
  return run.finish();
}

/** Convenience for callers that hold whole projects (the measurement script, tests). */
export function buildCrossSetLinks(input: readonly CrossSetProjectInput[], opts: CrossSetComputeOptions = {}): CrossSetLinks {
  return computeCrossSetLinks(input.map(reduceCrossSetProject), opts);
}

// ── per-project storage shapes ─────────────────────────────────────────────────────────────────

export const CROSS_SET_INTELLIGENCE_KEY = "crossSetLinks";
export const LINKED_PROJECTS_CAP = 200;
/** Links kept per page in the per-project file: the strongest first (twins, then by content score). */
export const PAGE_LINK_CAP = 25;

/** Where one project's cross-set links live in S3 — DERIVED from its data prefix, beside the v1 graph. */
export function crossSetObjectKey(dataUrl: string): string {
  return `${dataUrl}/graph/cross-set.v1.json`;
}

export interface ProjectCrossSetLink {
  kind: CrossSetLinkKind;
  /** The other project's publicId (never its name — resolved at read time against the caller's access). */
  project: string;
  page: number;
  sheet: string | null;
  confidence: number;
  /** Whether the other set is older or newer than this one. */
  direction: "older" | "newer";
  titleMatch?: boolean;
}

export interface ProjectCrossSetLinks {
  v: typeof CROSS_SET_VERSION;
  computedAt: string;
  project: string;
  pages: Record<number, ProjectCrossSetLink[]>;
  /** copy_of at project level: this set is a `copy` of the other, or the `original` the other copies. */
  projects: Array<{ publicId: string; kind: "copy_of"; role: "copy" | "original"; shared: number; pages: number }>;
}

/** One project's view of the company result: every link touching it, keyed by its own page. */
export function projectCrossSetLinks(result: CrossSetLinks, publicId: string): ProjectCrossSetLinks {
  const pages: Record<number, ProjectCrossSetLink[]> = {};
  const add = (own: CrossSetEnd, other: CrossSetEnd, l: CrossSetPageLink, direction: ProjectCrossSetLink["direction"]) => {
    (pages[own.page] ??= []).push({ kind: l.kind, project: other.project, page: other.page, sheet: other.sheet, confidence: l.confidence, direction, ...(l.titleMatch ? { titleMatch: true } : {}) });
  };
  for (const l of result.links) {
    if (l.from.project === publicId) add(l.from, l.to, l, "newer");
    else if (l.to.project === publicId) add(l.to, l.from, l, "older");
  }
  const byStrength = (a: ProjectCrossSetLink, b: ProjectCrossSetLink) => b.confidence - a.confidence || a.project.localeCompare(b.project) || a.page - b.page || a.kind.localeCompare(b.kind);
  for (const [page, list] of Object.entries(pages)) {
    list.sort(byStrength);
    if (list.length > PAGE_LINK_CAP) pages[Number(page)] = list.slice(0, PAGE_LINK_CAP);
  }
  const projects: ProjectCrossSetLinks["projects"] = [];
  for (const p of result.projectLinks) {
    if (p.from === publicId) projects.push({ publicId: p.to, kind: "copy_of", role: "copy", shared: p.shared, pages: p.pages });
    else if (p.to === publicId) projects.push({ publicId: p.from, kind: "copy_of", role: "original", shared: p.shared, pages: p.pages });
  }
  return { v: CROSS_SET_VERSION, computedAt: result.computedAt, project: publicId, pages, projects };
}

export interface CrossSetSummary {
  v: typeof CROSS_SET_VERSION;
  computedAt: string;
  /** publicIds only — projectIntelligence reaches every member and the export. */
  linkedProjects: Array<{ publicId: string; twins: number; revisions: number; copy: "copy" | "original" | null }>;
}

/** The compact record for projects.projectIntelligence.crossSetLinks. */
export function crossSetSummary(file: ProjectCrossSetLinks): CrossSetSummary {
  const by = new Map<string, { publicId: string; twins: number; revisions: number; copy: "copy" | "original" | null }>();
  const entry = (publicId: string) => {
    let e = by.get(publicId);
    if (!e) { e = { publicId, twins: 0, revisions: 0, copy: null }; by.set(publicId, e); }
    return e;
  };
  for (const list of Object.values(file.pages)) {
    for (const l of list) {
      const e = entry(l.project);
      if (l.kind === "twin_of") e.twins++;
      else e.revisions++;
    }
  }
  for (const p of file.projects) entry(p.publicId).copy = p.role;
  const linkedProjects = [...by.values()]
    .sort((a, b) => b.twins + b.revisions - (a.twins + a.revisions) || a.publicId.localeCompare(b.publicId))
    .slice(0, LINKED_PROJECTS_CAP);
  return { v: CROSS_SET_VERSION, computedAt: file.computedAt, linkedProjects };
}

export function isProjectCrossSetLinks(value: unknown): value is ProjectCrossSetLinks {
  if (!value || typeof value !== "object") return false;
  const f = value as Partial<ProjectCrossSetLinks>;
  return f.v === CROSS_SET_VERSION && typeof f.computedAt === "string" && typeof f.project === "string" && !!f.pages && typeof f.pages === "object" && Array.isArray(f.projects);
}

/**
 * projectIntelligence as a PUBLIC reader may see it: without the cross-set summary. Publishing a set
 * as a demo flips the same row (services/demo.ts), so the summary written while it was private — the
 * publicIds of the company's other sets, with counts — is still there; the demo GET strips it here.
 */
export function publicProjectIntelligence<T extends Record<string, unknown>>(projectIntelligence: T): Omit<T, typeof CROSS_SET_INTELLIGENCE_KEY> {
  if (!(CROSS_SET_INTELLIGENCE_KEY in projectIntelligence)) return projectIntelligence;
  const { [CROSS_SET_INTELLIGENCE_KEY]: _dropped, ...rest } = projectIntelligence;
  void _dropped;
  return rest;
}

export function storedCrossSetSummary(projectIntelligence: unknown): CrossSetSummary | null {
  if (!projectIntelligence || typeof projectIntelligence !== "object") return null;
  const s = (projectIntelligence as Record<string, unknown>)[CROSS_SET_INTELLIGENCE_KEY] as Partial<CrossSetSummary> | undefined;
  if (!s || typeof s !== "object" || s.v !== CROSS_SET_VERSION || typeof s.computedAt !== "string" || !Array.isArray(s.linkedProjects)) return null;
  return s as CrossSetSummary;
}
