/**
 * Admin › Classifiers (track 3 builder) — the three non-preview routes under /api/admin/classifiers:
 *   GET  /                 built-ins, the company overlay, the effective recipes and the signal catalog
 *                          (every YOLO model the company can run with its class list + the static tool
 *                          signal types of lib/classifier-engine/catalog.ts)
 *   PUT  /overlay          strict-validated overlay (lib/classifier-engine/overlay-edit.ts) → version bump
 *                          per changed recipe → companies.pipeline_config.classifiers, audited. A weight
 *                          fitter's overlay (track 4) is accepted through the same path unchanged.
 *   POST /run              reprocess scope "classifiers" for ONE project of the caller's company —
 *                          delegates to reprocessProjects (its leases, demo exclusion and NDJSON stream).
 * Company admin or root; root may name another company for GET / PUT (`companyId`). Demo projects are
 * refused for /run (reprocess never touches them; checked here first so the caller sees a 403, not an
 * empty stream). Preview lives in classifier-preview.ts.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, modelAccess, models, projects } from "@/lib/db/schema";
import { audit } from "@/lib/audit";
import type { AuthSession } from "@/lib/api-utils";
import { ApiError } from "@/server/api/envelope";
import {
  BUILT_IN_RECIPES, BUILT_IN_RECIPES_HASH, applyOverlay, bumpOverlayVersions, isClassifierOverlay, staticCatalog, validateOverlay,
  type CatalogModel, type ClassifierOverlay,
} from "@/lib/classifier-engine";
import { SCHEDULE_GROUP_NAMES, SCHEDULE_KINDS } from "@/lib/classifier-engine/vocabulary";
import { updatePipelineConfig } from "./company-config";
import { reprocessProjects } from "./reprocess";

/** projects.public_id is a uuid; anything else can only be "not found" (and would fail the query). */
const PUBLIC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Root may act on any company; a company admin only on their own (another id → 403). */
export function builderCompanyId(session: AuthSession, requested: unknown): number {
  const asked = typeof requested === "number" && Number.isInteger(requested) && requested > 0 ? requested
    : typeof requested === "string" && /^\d+$/.test(requested) ? Number(requested) : undefined;
  if (session.user.isRootAdmin) return asked ?? session.user.companyId;
  if (asked !== undefined && asked !== session.user.companyId) throw new ApiError("FORBIDDEN", "Company admins can only edit their own company");
  return session.user.companyId;
}

async function readOverlay(companyId: number): Promise<{ overlay: ClassifierOverlay | null; companyName: string }> {
  const [row] = await db.select({ name: companies.name, pipelineConfig: companies.pipelineConfig }).from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!row) throw new ApiError("NOT_FOUND", "Company not found");
  const stored = (row.pipelineConfig as { classifiers?: unknown } | null)?.classifiers;
  return { overlay: isClassifierOverlay(stored) ? stored : null, companyName: row.name };
}

/** Own models + models shared with the company (company-wide or per-user grants), each with its class list. */
export async function catalogModels(companyId: number): Promise<CatalogModel[]> {
  const own = await db.select({ id: models.id, name: models.name, config: models.config }).from(models).where(eq(models.companyId, companyId));
  const shared = await db
    .select({ id: models.id, name: models.name, config: models.config })
    .from(modelAccess)
    .innerJoin(models, eq(modelAccess.modelId, models.id))
    .where(and(eq(modelAccess.companyId, companyId), eq(modelAccess.enabled, true)));
  const out = new Map<number, CatalogModel>();
  for (const [rows, isShared] of [[own, false], [shared, true]] as const) {
    for (const m of rows) {
      if (out.has(m.id)) continue;
      const classes = Array.isArray(m.config?.classes) ? m.config.classes.filter((c): c is string => typeof c === "string") : [];
      out.set(m.id, { id: m.id, name: m.name, classes, shared: isShared });
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getClassifierBuilder(req: Request, session: AuthSession): Promise<unknown> {
  const companyId = builderCompanyId(session, new URL(req.url).searchParams.get("companyId") ?? undefined);
  const { overlay, companyName } = await readOverlay(companyId);
  return {
    companyId, companyName,
    builtIns: BUILT_IN_RECIPES, builtInsHash: BUILT_IN_RECIPES_HASH,
    overlay, effective: applyOverlay(BUILT_IN_RECIPES, overlay),
    catalog: staticCatalog(await catalogModels(companyId)),
    vocabulary: { kinds: SCHEDULE_KINDS, groups: SCHEDULE_GROUP_NAMES },
  };
}

export async function putClassifierOverlay(session: AuthSession, body: Record<string, unknown>): Promise<unknown> {
  const companyId = builderCompanyId(session, body.companyId);
  // `{ overlay }` from the tab, or a bare overlay (custom / patches at the top) from the fitter.
  const input = body.overlay !== undefined ? body.overlay : body.custom !== undefined || body.patches !== undefined ? body : undefined;
  if (input === undefined) throw new ApiError("VALIDATION", "overlay required");
  const checked = validateOverlay(input, BUILT_IN_RECIPES);
  if (checked.errors.length || !checked.overlay) throw new ApiError("VALIDATION", `overlay rejected: ${checked.errors.slice(0, 8).join("; ")}`);
  const { overlay: stored } = await readOverlay(companyId);
  const next: ClassifierOverlay = { ...bumpOverlayVersions(checked.overlay, stored, BUILT_IN_RECIPES), updatedAt: new Date().toISOString(), updatedBy: session.user.dbId };
  await updatePipelineConfig(companyId, (current) => ({ ...current, classifiers: next }), { touchUpdatedAt: true });
  const versions = {
    ...Object.fromEntries(Object.entries(next.patches).map(([id, p]) => [id, p.version])),
    ...Object.fromEntries(next.custom.map((r) => [r.id, r.version])),
  };
  audit("admin.classifiers.overlay_put", {
    userId: session.user.dbId, companyId,
    details: { patched: Object.keys(next.patches), custom: next.custom.map((r) => r.id), versions, builtInsHash: BUILT_IN_RECIPES_HASH },
  });
  return { success: true, overlay: next, effective: applyOverlay(BUILT_IN_RECIPES, next), versions };
}

export async function runClassifiersOnProject(session: AuthSession, body: Record<string, unknown>): Promise<Response> {
  const publicId = body.projectId;
  if (typeof publicId !== "string" || !publicId) throw new ApiError("VALIDATION", "projectId required");
  if (!PUBLIC_ID.test(publicId)) throw new ApiError("NOT_FOUND", "Project not found");
  const [project] = await db
    .select({ id: projects.id, publicId: projects.publicId, isDemo: projects.isDemo })
    .from(projects)
    .where(and(eq(projects.publicId, publicId), eq(projects.companyId, session.user.companyId)))
    .limit(1);
  if (!project) throw new ApiError("NOT_FOUND", "Project not found");
  if (project.isDemo) throw new ApiError("FORBIDDEN", "Demo projects are read-only");
  audit("admin.classifiers.run", { userId: session.user.dbId, companyId: session.user.companyId, details: { projectPublicId: project.publicId, scope: "classifiers" } });
  const req = new Request("http://internal/api/admin/reprocess?scope=classifiers", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectIds: [project.publicId] }),
  });
  return reprocessProjects(req, session);
}
