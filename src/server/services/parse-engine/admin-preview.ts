/**
 * POST /api/admin/classifiers/parse-preview — ROOT ONLY. The admin Classifiers tab's parse preview (table
 * pipeline PLAN §5 WP-3.P, C1-M7): for each proposal the draft-recipe dry run just showed, parse its box with
 * the parse engine at the `instant` budget and return the structure, so the tab can render the read-only
 * StructurePreviewGrid next to the proposal.
 *
 *   - Root, not the project route: the classifier preview spans companies (root picks any company), and the
 *     project route's access resolver is per company. The shell is `auth:"root"` (requireVerifiedRoot, 2FA).
 *   - Compute only. `loadPageEvidence` (the one evidence loader) + `runParseEngine` at `instant`: pure methods on
 *     stored evidence. No crop runs, no paid call, **no cache read or write**, no lease, no capability, and no
 *     `pages` / `projects` write, so there is no INTERNAL_MUTATION_SINKS entry.
 *   - Demo projects are refused, as the sibling `/api/admin/classifiers/preview` refuses them for every role.
 *   - The kill switch refuses (403); the per-tool modes do not apply (this is a diagnostic over the engine, and
 *     the workspace flag gates only the viewer's route).
 *   - Loads each page once (items are grouped by page). A missing page or an engine failure is reported on the
 *     item; one bad item never fails the batch. Raw OCR `sources` never leave the server.
 */

import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { runParseEngine } from "@/lib/parse-engine/engine";
import { zBboxMinMax } from "@/lib/parse-engine/schema";
import { ParseEngineNotImplementedError, STRUCTURE_KINDS, type EnginePageEvidence, type ParseEngineFlags, type ParseRequest, type ParseResult, type StructureKind } from "@/lib/parse-engine/types";
import { ApiError } from "@/server/api/envelope";
import { loadPageEvidence, type LoadedPageEvidence } from "./evidence";
import { readParseEngineFlags } from "./flags";

/** At most this many boxes per call (the dry run shows ≤ 20 pages; a page rarely holds more than two). */
export const ADMIN_PARSE_PREVIEW_MAX_ITEMS = 40;

const PUBLIC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const zAdminParsePreviewBody = z.strictObject({
  projectId: z.string().min(1).max(64),
  items: z.array(z.strictObject({
    page: z.number().int().min(1),
    bbox: zBboxMinMax,
    kind: z.enum(STRUCTURE_KINDS as [StructureKind, ...StructureKind[]]),
    proposalId: z.string().min(1).max(256).optional(),
  })).min(1).max(ADMIN_PARSE_PREVIEW_MAX_ITEMS),
});
export type AdminParsePreviewBody = z.infer<typeof zAdminParsePreviewBody>;

export type AdminParsePreviewError = "page-not-found" | "engine-unavailable" | "failed";

export interface AdminParsePreviewItem {
  proposalId: string | null;
  page: number;
  kind: StructureKind;
  /** The page's drawing number (the paragraph address of a notes / spec preview). */
  drawingNumber: string | null;
  result?: ParseResult;
  error?: AdminParsePreviewError;
}

export interface AdminParsePreviewResult { projectId: string; budget: "instant"; items: AdminParsePreviewItem[] }

export interface AdminParsePreviewDeps {
  readFlags(): Promise<ParseEngineFlags>;
  findProject(publicId: string): Promise<{ id: number; isDemo: boolean } | null>;
  loadEvidence(projectId: number, page: number): Promise<LoadedPageEvidence | null>;
  runEngine(evidence: EnginePageEvidence, request: ParseRequest): Promise<ParseResult>;
}

export const defaultAdminParsePreviewDeps: AdminParsePreviewDeps = {
  readFlags: readParseEngineFlags,
  async findProject(publicId) {
    // No company filter: root previews any company's project (the reason this is a root route).
    const [row] = await db.select({ id: projects.id, isDemo: projects.isDemo }).from(projects).where(eq(projects.publicId, publicId)).limit(1);
    return row ?? null;
  },
  loadEvidence: (projectId, page) => loadPageEvidence(null, projectId, page),
  runEngine: (evidence, request) => runParseEngine(evidence, request),
};

/** The `instant` request for one previewed box (exactly the strict `zParseRequest` shape). */
export function previewRequest(item: AdminParsePreviewBody["items"][number]): ParseRequest {
  return {
    page: item.page,
    bbox: [...item.bbox] as ParseRequest["bbox"],
    kind: item.kind,
    budget: "instant",
    ...(item.proposalId ? { hints: { proposalId: item.proposalId } } : {}),
  };
}

export async function adminParsePreview(body: AdminParsePreviewBody, deps: AdminParsePreviewDeps = defaultAdminParsePreviewDeps): Promise<AdminParsePreviewResult> {
  if ((await deps.readFlags()).killSwitch) throw new ApiError("FORBIDDEN", "The parse engine is switched off");
  // A zero-area box is the caller's error (as in run.ts), not an engine failure on one item.
  if (body.items.some((i) => !(i.bbox[2] > i.bbox[0] && i.bbox[3] > i.bbox[1]))) throw new ApiError("VALIDATION", "every box must have a positive width and height");
  if (!PUBLIC_ID.test(body.projectId)) throw new ApiError("NOT_FOUND", "Project not found");
  const project = await deps.findProject(body.projectId);
  if (!project) throw new ApiError("NOT_FOUND", "Project not found");
  if (project.isDemo) throw new ApiError("FORBIDDEN", "Demo projects are read-only");

  const pages = new Map<number, { evidence: EnginePageEvidence; drawingNumber: string | null } | null>();
  const items: AdminParsePreviewItem[] = [];
  for (const item of body.items) {
    if (!pages.has(item.page)) {
      const loaded = await deps.loadEvidence(project.id, item.page);
      if (loaded) {
        const { sources, ...evidence } = loaded; // raw OCR slices stay on the server
        pages.set(item.page, { evidence, drawingNumber: sources.drawingNumber ?? null });
      } else pages.set(item.page, null);
    }
    const page = pages.get(item.page);
    const base = { proposalId: item.proposalId ?? null, page: item.page, kind: item.kind, drawingNumber: page?.drawingNumber ?? null };
    if (!page) { items.push({ ...base, error: "page-not-found" }); continue; }
    try {
      items.push({ ...base, result: await deps.runEngine(page.evidence, previewRequest(item)) });
    } catch (err) {
      if (err instanceof ParseEngineNotImplementedError || (err as { code?: unknown } | null)?.code === "NOT_IMPLEMENTED") {
        items.push({ ...base, error: "engine-unavailable" });
        continue;
      }
      logger.warn("[parse-engine] admin parse preview failed on one box", { projectId: project.id, page: item.page, error: err });
      items.push({ ...base, error: "failed" });
    }
  }
  return { projectId: body.projectId, budget: "instant", items };
}
