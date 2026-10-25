/**
 * POST /api/admin/classifiers/preview — DRY RUN of one draft recipe over ≤ 20 pages of one project
 * (track 3 builder). Reads exactly what reprocess-classifiers.ts reads per page (stored YOLO rows,
 * regionsV2 — computed on the fly when a YOLO page has none stored, like the run does — pageZones,
 * channels, parsedRegions, OCR words + tables ONE page at a time, csiCodes, drawingNumber), runs
 * the engine with ONLY the draft (forced enabled), and returns the proposals
 * with their contributions plus the AGREEMENT with the stored verdicts on those pages: per label
 * class, how many of the user's accept / reject / rename labels the draft would now agree with.
 * NO WRITES — nothing here holds a capability or a lease. Demo projects are refused for every role.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { annotations, pages, projects } from "@/lib/db/schema";
import type { AuthSession } from "@/lib/api-utils";
import { ApiError } from "@/server/api/envelope";
import type { PageZones } from "@/lib/page-zones";
import type { CsiCode, KeynoteShapeData, TextractPageData } from "@/types";
import {
  runClassifierEngine, storedClassifierProposals, storedProposalVerdicts, validateRecipe,
  type ClassifierProposal, type ClassifierRecipe, type ProposalVerdict,
} from "@/lib/classifier-engine";
import { OTHER_SCHEDULE, scheduleKind } from "@/lib/classifier-engine/vocabulary";
import { classifierBoxTagger } from "./classifier-proposals-write";
import { regionsV2OrCompute, storedChannelKind } from "./reprocess-classifiers";
import { builderCompanyId } from "./classifier-builder";

/** projects.public_id is a uuid; anything else can only be "not found" (and would fail the query). */
const PUBLIC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PREVIEW_MAX_PAGES = 20;
/** Agreement row id for reject labels. */
export const REJECTED = "rejected";

export interface AgreementRow { classId: string; name: string; labeled: number; agree: number; disagree: number; notProposed: number }

export interface PreviewPage {
  pageNumber: number;
  proposals: ClassifierProposal[];
  /** Proposals of this recipe stored on the page today. */
  storedCount: number;
  errors: Array<{ recipeId: string; message: string }>;
  ms: number;
}

export interface PreviewResult {
  recipeId: string;
  recipeVersion: number;
  pages: PreviewPage[];
  agreement: { rows: AgreementRow[]; totals: Omit<AgreementRow, "classId" | "name"> };
  summary: { pagesRun: number; pagesWithYolo: number; proposals: number; storedProposals: number; verdicts: number };
}

function parsePages(v: unknown): number[] {
  if (!Array.isArray(v) || !v.length) throw new ApiError("VALIDATION", "pages must be a non-empty list of page numbers");
  if (v.length > PREVIEW_MAX_PAGES) throw new ApiError("VALIDATION", `pages: at most ${PREVIEW_MAX_PAGES} per preview`);
  const out = new Set<number>();
  for (const p of v) {
    if (typeof p !== "number" || !Number.isInteger(p) || p < 1) throw new ApiError("VALIDATION", "pages must be positive integers");
    out.add(p);
  }
  return [...out].sort((a, b) => a - b);
}

function parseRecipe(v: unknown): ClassifierRecipe {
  const source = (v as { source?: unknown } | null)?.source === "built-in" ? "built-in" : "custom";
  try { return { ...validateRecipe(v, source), enabled: true }; }
  catch (e) { throw new ApiError("VALIDATION", `recipe rejected: ${(e as Error).message}`); }
}

/** What the user said the candidate is: a class id, OTHER_SCHEDULE, or REJECTED. */
export function verdictLabel(v: ProposalVerdict): string {
  if (v.verdict === "reject") return REJECTED;
  if (v.verdict === "rename") return v.classId ?? OTHER_SCHEDULE;
  return v.proposedClassId ?? OTHER_SCHEDULE;
}

/** Fold one page's verdicts (this recipe only) against the draft's proposals into the rows. */
export function foldAgreement(rows: Map<string, AgreementRow>, verdicts: Record<string, ProposalVerdict>, recipe: ClassifierRecipe, proposals: readonly ClassifierProposal[]): number {
  let n = 0;
  for (const v of Object.values(verdicts)) {
    if (v.recipeId !== recipe.id) continue;
    n++;
    const label = verdictLabel(v);
    const row = rows.get(label) ?? rows.set(label, {
      classId: label, labeled: 0, agree: 0, disagree: 0, notProposed: 0,
      name: label === REJECTED ? "Rejected (not the target)" : recipe.classes.find((c) => c.id === label)?.name ?? scheduleKind(label)?.name ?? (label === OTHER_SCHEDULE ? recipe.fallbackClassName : label),
    }).get(label)!;
    row.labeled++;
    const draft = proposals.find((p) => p.id === v.proposalId);
    if (label === REJECTED) { if (draft) row.disagree++; else row.agree++; continue; }
    if (!draft) { row.notProposed++; continue; }
    if ((draft.classId ?? OTHER_SCHEDULE) === label) row.agree++; else row.disagree++;
  }
  return n;
}

export async function previewClassifierRecipe(session: AuthSession, body: Record<string, unknown>): Promise<PreviewResult> {
  const companyId = builderCompanyId(session, body.companyId);
  const publicId = body.projectId;
  if (typeof publicId !== "string" || !publicId) throw new ApiError("VALIDATION", "projectId required");
  if (!PUBLIC_ID.test(publicId)) throw new ApiError("NOT_FOUND", "Project not found");
  const pageNumbers = parsePages(body.pages);
  const recipe = parseRecipe(body.recipe);
  const [project] = await db
    .select({ id: projects.id, isDemo: projects.isDemo })
    .from(projects)
    .where(and(eq(projects.publicId, publicId), eq(projects.companyId, companyId)))
    .limit(1);
  if (!project) throw new ApiError("NOT_FOUND", "Project not found");
  if (project.isDemo) throw new ApiError("FORBIDDEN", "Demo projects are read-only");

  const rows = await db
    .select({ id: pages.id, pageNumber: pages.pageNumber, drawingNumber: pages.drawingNumber, csiCodes: pages.csiCodes, keynotes: pages.keynotes, pageIntelligence: pages.pageIntelligence })
    .from(pages)
    .where(and(eq(pages.projectId, project.id), inArray(pages.pageNumber, pageNumbers)))
    .orderBy(pages.pageNumber);
  const yolo = await db
    .select({ name: annotations.name, minX: annotations.minX, minY: annotations.minY, maxX: annotations.maxX, maxY: annotations.maxY, pageNumber: annotations.pageNumber, data: annotations.data })
    .from(annotations)
    .where(and(eq(annotations.projectId, project.id), eq(annotations.source, "yolo"), inArray(annotations.pageNumber, pageNumbers)));
  const byPage = new Map<number, Array<{ name: string; minX: number; minY: number; maxX: number; maxY: number; confidence: number; modelName?: string }>>();
  for (const a of yolo) {
    const data = a.data as { confidence?: number; modelName?: string } | null;
    (byPage.get(a.pageNumber) ?? byPage.set(a.pageNumber, []).get(a.pageNumber)!).push({ name: a.name, minX: a.minX, minY: a.minY, maxX: a.maxX, maxY: a.maxY, confidence: data?.confidence ?? 0, modelName: data?.modelName });
  }

  const tagger = classifierBoxTagger();
  const agreement = new Map<string, AgreementRow>();
  const out: PreviewPage[] = [];
  const summary = { pagesRun: 0, pagesWithYolo: 0, proposals: 0, storedProposals: 0, verdicts: 0 };
  for (const page of rows) {
    summary.pagesRun++;
    const existing = (page.pageIntelligence ?? {}) as Record<string, unknown>;
    const stored = storedClassifierProposals(existing)?.proposals.filter((p) => p.recipeId === recipe.id) ?? [];
    summary.storedProposals += stored.length;
    const detections = byPage.get(page.pageNumber) ?? [];
    if (detections.length) summary.pagesWithYolo++;
    const [ocr] = await db
      // ONE page's OCR at a time, and only the two keys the engine reads (never `lines`; the yolo.ts T5 lesson).
      .select({ words: sql<TextractPageData["words"] | null>`${pages.textractData}->'words'`, tables: sql<TextractPageData["tables"] | null>`${pages.textractData}->'tables'` })
      .from(pages)
      .where(eq(pages.id, page.id));
    const zones = existing.pageZones as PageZones | undefined;
    const textractData = Array.isArray(ocr?.words) ? { words: ocr.words, ...(ocr.tables ? { tables: ocr.tables } : {}) } : null;
    const csiCodes = (page.csiCodes ?? []) as CsiCode[];
    const run = runClassifierEngine({
      pageNumber: page.pageNumber, detections, zones, textractData, csiCodes,
      regionsV2: regionsV2OrCompute(existing, { pageNumber: page.pageNumber, detections, zones, textractData, csiCodes }).regionsV2,
      parsedRegions: existing.parsedRegions as ReadonlyArray<{ bbox?: readonly number[] | null }> | null | undefined,
      drawingNumber: page.drawingNumber,
      channelKind: storedChannelKind(existing),
      keynotes: (page.keynotes ?? null) as readonly KeynoteShapeData[] | null,
      tagger,
    }, [recipe]);
    summary.proposals += run.result.proposals.length;
    summary.verdicts += foldAgreement(agreement, storedProposalVerdicts(existing), recipe, run.result.proposals);
    out.push({ pageNumber: page.pageNumber, proposals: run.result.proposals, storedCount: stored.length, errors: run.errors, ms: run.ms });
  }
  const agreementRows = [...agreement.values()].sort((a, b) => b.labeled - a.labeled || a.name.localeCompare(b.name));
  const totals = agreementRows.reduce((t, r) => ({ labeled: t.labeled + r.labeled, agree: t.agree + r.agree, disagree: t.disagree + r.disagree, notProposed: t.notProposed + r.notProposed }), { labeled: 0, agree: 0, disagree: 0, notProposed: 0 });
  return { recipeId: recipe.id, recipeVersion: recipe.version, pages: out, agreement: { rows: agreementRows, totals }, summary };
}

