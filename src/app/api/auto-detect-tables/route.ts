/**
 * POST /api/auto-detect-tables
 *
 * Stage 2c: emit AutoTableProposal[] for a project by reading stored
 * pageIntelligence.ensembleRegions and filtering through the auto-table-detector.
 *
 * Admin-gated. Read-only endpoint — does NOT commit ParsedRegions. That's a
 * downstream user-review step. Future Stage 2d may add `?commit=1` to
 * auto-promote above-threshold proposals into ParsedRegions automatically.
 *
 * Request body:
 *   {
 *     projectId: string,       // project publicId
 *     pageNumbers?: number[],   // optional filter
 *     config?: Partial<AutoTableDetectorConfig>
 *   }
 *
 * Response:
 *   {
 *     projectId: string,
 *     proposalsByPage: Record<number, AutoTableProposal[]>,
 *     totalProposals: number,
 *     pagesWithoutEnsemble: number
 *   }
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { projects, pages } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import {
  detectAutoTables,
  type AutoTableDetectorConfig,
} from "@/lib/auto-detect/auto-table-detector";
import type { AutoTableProposal, EnsembleRegion } from "@/types";
import { logger } from "@/lib/logger";

interface RequestBody {
  projectId?: string;
  pageNumbers?: number[];
  config?: Partial<AutoTableDetectorConfig>;
}

export async function POST(req: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.projectId || typeof body.projectId !== "string") {
    return NextResponse.json({ error: "projectId (publicId) required" }, { status: 400 });
  }

  // Resolve projectId via publicId + company scope.
  const [project] = await db
    .select({ id: projects.id, companyId: projects.companyId, publicId: projects.publicId })
    .from(projects)
    .where(and(eq(projects.publicId, body.projectId), eq(projects.companyId, session.user.companyId)))
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Pull pageIntelligence (we only need ensembleRegions + pageNumber).
  const projectPages = await db
    .select({ pageNumber: pages.pageNumber, pageIntelligence: pages.pageIntelligence })
    .from(pages)
    .where(eq(pages.projectId, project.id))
    .orderBy(pages.pageNumber);

  const pageFilter = body.pageNumbers && body.pageNumbers.length > 0
    ? new Set(body.pageNumbers)
    : null;

  const proposalsByPage: Record<number, AutoTableProposal[]> = {};
  let totalProposals = 0;
  let pagesWithoutEnsemble = 0;

  for (const page of projectPages) {
    if (pageFilter && !pageFilter.has(page.pageNumber)) continue;
    const intel = (page.pageIntelligence || {}) as Record<string, unknown>;
    const ensembleRegions = intel.ensembleRegions as EnsembleRegion[] | undefined;
    if (!ensembleRegions || ensembleRegions.length === 0) {
      pagesWithoutEnsemble++;
      continue;
    }
    try {
      const proposals = detectAutoTables(page.pageNumber, ensembleRegions, body.config);
      if (proposals.length > 0) {
        proposalsByPage[page.pageNumber] = proposals;
        totalProposals += proposals.length;
      }
    } catch (err) {
      logger.error(`[auto-detect-tables] page ${page.pageNumber} failed:`, err);
    }
  }

  return NextResponse.json({
    projectId: body.projectId,
    proposalsByPage,
    totalProposals,
    pagesWithoutEnsemble,
  });
}
