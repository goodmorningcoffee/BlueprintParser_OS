// [refactor P1 reprocess-fold jul8 S062] Service for POST /api/admin/reprocess — the
// DEAD-LAST P1.5 solo. The ENTIRE legacy route body (797L, 5 scope branches, NDJSON
// stream) moved here VERBATIM from src/app/api/admin/reprocess/route.ts; the only
// deltas are (1) auth left to the shell (auth:"admin" — byte-identical
// "Unauthorized"/"Admin only" messages, envelope shape per sanctioned-A) and
// (2) `session` arriving as a parameter. The §E-a owner decision (2026-07-08) keeps the
// body swallow HERE: no body / malformed / non-object → process ALL company projects —
// that contract is load-bearing (4 of 5 consumers send no body). The shell uses
// rawBody:true so it never touches the request stream and auth stays BEFORE parse
// (signed-out + malformed = 401, NOT the PH-5b 400 flip).
//
// Freeze pins (char: admin-reprocess.route.test.ts + admin-reprocess-g3.route.test.ts):
// ★H6/W8 blind-spread project-PI merge; G3/G3b page-level carry; W2-scoped shape-parse
// delete; legacy immutable S3 metadata (the gateway overrides it private/no-store); counter asymmetries;
// verbatim stream literals incl. the §B-owner-locked raw err.message thumbnails line.
// DO NOT add scope validation, an isDemo exclusion, or a projectId(singular) body read —
// those are pre-existing REVIEW-ITEMs deliberately preserved (see SOLOS_RECON_REPROCESS.md).

import { db } from "@/lib/db";
import { projects, pages, companies, annotations } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { detectTextAnnotations } from "@/lib/text-annotations";
import { detectCsiCodes } from "@/lib/csi-detect";
// [refactor jul9 P2-A C1] company CSI context resolver (config + custom DB), threaded
// into the detect call below (D-1/D-2). Uses the already-SELECTed pipelineConfig as the
// preloaded row → zero extra queries for the whole streaming run.
import { getCompanyCsiContext } from "@/lib/csi-company-db";
import { extractRawText } from "@/lib/textract";
import { extractDrawingNumber } from "@/lib/title-block";
import { computePageZones, storedPageZones, type PageZoneDetection, type PageZones } from "@/lib/page-zones";
import { buildEvidenceSummary } from "@/lib/evidence";
import { classifyRegionsV2, type RegionsV2 } from "@/lib/region-classifier-v2";
import { analyzePageIntelligence } from "@/lib/page-analysis";
import { rasterizePage, getPdfPageCount } from "@/lib/pdf-rasterize";
import { downloadFromS3, uploadToS3 } from "@/lib/s3";
import { classifyTextRegions } from "@/lib/text-region-classifier";
import { writeClassifierDebugBundle } from "@/lib/text-region-classifier-debug";
import { getEffectiveRules, runHeuristicEngine } from "@/lib/heuristic-engine";
import { classifyTables } from "@/lib/table-classifier";
import { classifyPageRegions } from "@/lib/composite-classifier";
import { computeCsiSpatialMap } from "@/lib/csi-spatial";
import { computeYoloHeatmap } from "@/lib/spatial/yolo-heatmap";
import { reduceRegionVotes } from "@/lib/ensemble/region-ensemble";
import { collectAllVotes } from "@/lib/ensemble/vote-adapters";
import { carryNonComputedIntelligence, mergeProjectIntelligence } from "@/lib/intelligence-merge";
import type { ClassifiedTable } from "@/types";
import type { AuthSession } from "@/lib/api-utils";
import { resolvePipelineToggles } from "@/lib/pipeline-toggles";
import { scopeLayoutDetections } from "@/lib/yolo-class-scope";

/** YOLO classes aggregated by Layer 2 heatmap. Matches the "Notes agreement"
 *  recipe (text_box + vertical_area + horizontal_area) from the 4-layer plan
 *  but stays deliberately generic — any dense multi-class region surfaces as
 *  a confident region regardless of pattern family. */
const HEATMAP_CLASSES = ["text_box", "vertical_area", "horizontal_area"] as const;
import { analyzeProject, computeProjectSummaries } from "@/lib/project-analysis";
import { visiblePage } from "@/lib/page-dedup";
import type { TextractPageData, TextAnnotation, TextAnnotationResult, CsiCode } from "@/types";
import { logger } from "@/lib/logger";
import { assertProjectWritable } from "@/server/api/access";
// [fix 2026-10-21] shape-parse (compute-then-swap + Lambda fan-out) and the shared NDJSON/debug stream.
import { reprocessProjectShapeParse } from "./reprocess-shape-parse";
import { reprocessEvidenceScope } from "./reprocess-evidence";
import { computePageShapes } from "./yolo-post-enrichment";
import { writeProjectTagFamilies } from "./tag-families-write";
import { reprocessGraphScope } from "./reprocess-graph";
import { reprocessCrossSetScope } from "./reprocess-cross-set";
import { refreshProjectGraph } from "./project-graph";
import { reprocessTilesScope } from "./reprocess-tiles";
import { reprocessChannelsScope } from "./reprocess-channels";
import { readTilesSetting } from "./tiles-setting";
import { createReprocessStream } from "./reprocess-stream";
import { loadProjectYoloCsiCodes, withYoloCsiCodes } from "./reprocess-yolo-csi";
import {
  type ProjectWriteCapability,
  withProjectMutationLease,
  withProjectWrite,
} from "@/server/api/project-write-capability";

/**
 * POST /api/admin/reprocess
 *
 * Re-runs detectors on all existing pages that already have OCR data.
 * Query param ?scope=intelligence → only re-runs page intelligence + project analysis (fast).
 * Default (no scope) → re-runs CSI detection + text annotations + intelligence (full).
 *
 * Streams progress as newline-delimited JSON.
 */
export async function reprocessProjects(req: Request, session: AuthSession): Promise<Response> {
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope"); // "intelligence" or null (full)
  const debugClassifier = url.searchParams.get("debug") === "1"; // emit Stage 1 classifier trace
  const trace = url.searchParams.get("trace") === "1"; // admin Debug toggle → {type:"debug"} lines

  // Read optional projectIds filter from request body
  // [refactor P1 reprocess-fold] §E-a: this swallow stays IN-SERVICE (shell rawBody:true).
  // "No body = process ALL company projects" is the consumer contract — never 400 here.
  let selectedProjectIds: string[] | undefined;
  try {
    const body = await req.json();
    if (body.projectIds && Array.isArray(body.projectIds)) {
      selectedProjectIds = body.projectIds;
    }
  } catch { /* no body = process all projects */ }

  // Load pipeline config for this company
  const [company] = await db
    .select({ pipelineConfig: companies.pipelineConfig })
    .from(companies)
    .where(eq(companies.id, session.user.companyId))
    .limit(1);
  const enabledDetectorIds = company?.pipelineConfig?.textAnnotation?.enabledDetectors;

  // [refactor jul9 P2-A C1] Resolve the company's CSI context ONCE for the whole
  // streaming run (I-1: resolved here, before any per-page detect). Company is a
  // constant across the run (= session.user.companyId); passing the already-fetched
  // pipelineConfig as `preloadedPipelineConfig` avoids a second PK read. The resolver
  // is never re-entered mid-run — this is a stable snapshot for the run.
  const csiCtx = await getCompanyCsiContext(session.user.companyId, company?.pipelineConfig);

  // Get all completed projects for this company
  // [refactor jul8 P1-review T2, OWNER-SANCTIONED] + isDemo exclusion: legacy reprocessed
  // isDemo projects of the admin's own company, which could mutate the hand-curated public
  // demo content (pageIntelligence/csiCodes rewrites). Owner policy (2026-07-08): admin
  // reprocess NEVER touches demo projects — "demo never writes" now holds here too. This is
  // the ONLY behavior delta vs the S062 fold (freeze-pinned: demo project excluded from the
  // start count and byte-untouched after a no-body run).
  const allCompanyProjects = await db
    .select({
      id: projects.id,
      name: projects.name,
      publicId: projects.publicId,
      companyId: projects.companyId,
      isDemo: projects.isDemo,
      lifecycleEpoch: projects.lifecycleEpoch,
      dataUrl: projects.dataUrl,
      numPages: projects.numPages,
    })
    .from(projects)
    .where(and(eq(projects.companyId, session.user.companyId), eq(projects.isDemo, false)));

  // Filter to selected projects if specified
  const allProjects = selectedProjectIds
    ? allCompanyProjects.filter((p) => selectedProjectIds!.includes(p.publicId))
    : allCompanyProjects;
  const writeCapabilities = new Map(
    allProjects.map((project) => [project.id, assertProjectWritable(project)]),
  );
  const withReprocessLease = <T>(
    projectId: number,
    operation: (writeCapability: ProjectWriteCapability) => Promise<T>,
  ): Promise<T> => {
    const writeCapability = writeCapabilities.get(projectId);
    if (!writeCapability) throw new Error("Missing project write capability");
    return withProjectMutationLease(
      writeCapability,
      {
        kind: `admin-reprocess:${scope ?? "full"}`,
        // Only one admin reprocess may own a project at a time, regardless of scope.
        idempotencyKey: "admin-reprocess",
      },
      () => operation(writeCapability),
    );
  };

  const stream = new ReadableStream({
    async start(controller) {
      const out = createReprocessStream(controller, { scope: scope ?? "full", debug: trace });
      const { send, debug } = out;

      let totalPages = 0;
      let updatedPages = 0;
      let skippedPages = 0;

      const companyHeuristics = company?.pipelineConfig?.heuristics;
      // Stage 2d: pluggable pipeline toggles. The existing PipelineTab UI
      // drives `disabledSteps` for on/off; advanced tuning lives on dedicated
      // keys. Defaults: heatmap + ensemble on.
      // [refactor jul9 P2-A S1] Stage 2c (auto-table-detector → autoTableProposals)
      // removed here: the STORED key had zero readers repo-wide (U1-F1); the
      // auto-detect-tables route computes proposals on demand from ensembleRegions.
      // [fix 2026-10-24 T1a] one shared accessor: top level, else the tab's legacy nested copy.
      const { disabledSteps, ensembleConfig } = resolvePipelineToggles(company?.pipelineConfig);
      const heatmapEnabled = !disabledSteps.has("yolo-heatmap");
      const ensembleEnabled = !disabledSteps.has("ensemble");

      send({ type: "start", projects: allProjects.length });
      debug("run.start", { projects: allProjects.length, selected: selectedProjectIds?.length ?? null, disabledSteps: [...disabledSteps] });

      if (scope === "page-names") {
        // Page-names reprocess: re-extract drawing numbers using improved strategies + YOLO title_block
        // Read pageNaming config to determine which YOLO model(s) + class(es) to use
        const pageNamingConfig = company?.pipelineConfig?.pageNaming;

        const yoloEnabled = pageNamingConfig?.enabled && (pageNamingConfig.yoloSources || []).length > 0;
        const yoloSources = yoloEnabled ? pageNamingConfig!.yoloSources! : [];

        // Build the set of class names to look for (across all configured sources)
        const targetClasses = new Set<string>();
        if (yoloSources.length > 0) {
          for (const src of yoloSources) {
            for (const cls of src.classes) targetClasses.add(cls);
          }
        } else {
          // Fallback: look for title_block if no config
          targetClasses.add("title_block");
        }

        send({ type: "config", yoloEnabled, targetClasses: [...targetClasses], sources: yoloSources.length });

        for (const project of allProjects) {
          try {
          await withReprocessLease(project.id, async (writeCapability) => {
          const projectPages = await db
            .select({
              id: pages.id,
              pageNumber: pages.pageNumber,
              name: pages.name,
              drawingNumber: pages.drawingNumber,
              textractData: pages.textractData,
            })
            .from(pages)
            .where(eq(pages.projectId, project.id))
            .orderBy(pages.pageNumber);

          // Fetch YOLO annotations matching configured classes for this project
          // Query all YOLO annotations and filter by configured model+class pairs
          let titleBlockAnns: { pageNumber: number; minX: number; minY: number; maxX: number; maxY: number }[] = [];
          if (yoloEnabled && targetClasses.size > 0) {
            const allYoloAnns = await db
              .select({
                pageNumber: annotations.pageNumber,
                name: annotations.name,
                minX: annotations.minX,
                minY: annotations.minY,
                maxX: annotations.maxX,
                maxY: annotations.maxY,
                data: annotations.data,
              })
              .from(annotations)
              .where(
                and(
                  eq(annotations.projectId, project.id),
                  eq(annotations.source, "yolo"),
                )
              );

            // Filter by configured model+class pairs
            titleBlockAnns = allYoloAnns.filter(ann => {
              if (!targetClasses.has(ann.name)) return false;
              // If specific models are configured, check modelId matches
              if (yoloSources.length > 0) {
                const annModelId = (ann.data as any)?.modelId;
                return yoloSources.some(src =>
                  src.classes.includes(ann.name) &&
                  (annModelId === undefined || src.modelId === annModelId)
                );
              }
              return true;
            });
          } else if (targetClasses.size > 0) {
            // Fallback mode: just look for title_block class across all YOLO annotations
            const allYoloAnns = await db
              .select({
                pageNumber: annotations.pageNumber,
                name: annotations.name,
                minX: annotations.minX,
                minY: annotations.minY,
                maxX: annotations.maxX,
                maxY: annotations.maxY,
              })
              .from(annotations)
              .where(
                and(
                  eq(annotations.projectId, project.id),
                  eq(annotations.source, "yolo"),
                )
              );
            titleBlockAnns = allYoloAnns.filter(ann => targetClasses.has(ann.name));
          }

          // [zones T2] pageNumber → zones built from the configured title-block class(es).
          // page-zones picks the box (ties → bottom-right, the pick this loop used to make by
          // hand) and extractDrawingNumber searches INSIDE it instead of the fixed corner.
          const detsByPage = new Map<number, PageZoneDetection[]>();
          for (const ann of titleBlockAnns) {
            if (!detsByPage.has(ann.pageNumber)) detsByPage.set(ann.pageNumber, []);
            detsByPage.get(ann.pageNumber)!.push({ ...ann, name: "title_block" });
          }
          // `models: "any"`: the company CHOSE these classes (any model), so the yolo_medium gate is off here.
          const zonesByPage = new Map<number, PageZones>();
          for (const [pageNumber, dets] of detsByPage) zonesByPage.set(pageNumber, computePageZones(dets, { models: "any" }));

          send({
            type: "project",
            name: project.name,
            pages: projectPages.length,
            yoloTitleBlocks: zonesByPage.size,
          });

          for (const page of projectPages) {
            totalPages++;
            if (!page.textractData) { skippedPages++; continue; }
            const textractData = page.textractData as TextractPageData;

            try {
              const newDrawingNumber = extractDrawingNumber(textractData, null, zonesByPage.get(page.pageNumber) ?? null);
              // [fix 2026-10-21] Auto names are `drawingNumber || "Page N"`; anything else was typed by a user (page rename) — keep it.
              const manualName = page.name !== null && page.name !== page.drawingNumber && page.name !== `Page ${page.pageNumber}`;
              const newName = manualName ? page.name! : newDrawingNumber || `Page ${page.pageNumber}`;

              // Only update if the name actually changed
              if (newDrawingNumber !== page.drawingNumber || newName !== page.name) {
                await withProjectWrite(writeCapability, project.id, async (tx) => {
                  await tx.update(pages).set({
                    drawingNumber: newDrawingNumber,
                    name: newName,
                  }).where(eq(pages.id, page.id));
                });
                updatedPages++;
                debug("page.written", { project: project.name, page: page.pageNumber, drawingNumber: newDrawingNumber, manualNameKept: manualName });
              } else {
                skippedPages++;
              }
            } catch (err) {
              logger.error(`[reprocess-page-names] Page ${page.pageNumber} failed:`, err);
              debug("page.failed", { project: project.name, page: page.pageNumber, reason: err instanceof Error ? err.message : String(err) });
            }

            if ((updatedPages + skippedPages) % 10 === 0) {
              send({ type: "progress", updated: updatedPages, skipped: skippedPages, total: totalPages, project: project.name });
            }
          }
          });
          } catch (err) {
            // [csi-rebuild S8 / TILE_015 C1] Per-project guard. Without it one failing
            // project throws out of the loop and the NDJSON stream ends with no `done`,
            // leaving the client waiting on a response that already stopped. The
            // `thumbnails` scope already guarded itself this way; the other four did not.
            logger.error(`[reprocess-page-names] Project ${project.name} failed:`, err);
            send({ type: "error", project: project.name, error: err instanceof Error ? err.message : "Failed" });
          }
        }

        send({ type: "done", updated: updatedPages, skipped: skippedPages, total: totalPages });
        out.close();
        return;
      }

      if (scope === "thumbnails") {
        // Thumbnail + page PNG regeneration: download PDF, rasterize, upload to S3
        for (const project of allProjects) {
          try {
            await withReprocessLease(project.id, async (writeCapability) => {
            const pdfKey = `${project.dataUrl}/original.pdf`;
            let pdfBuffer: Buffer;
            try {
              pdfBuffer = await downloadFromS3(pdfKey);
            } catch {
              send({ type: "error", project: project.name, error: "PDF not found in S3" });
              return;
            }
            const pageCount = project.numPages || await getPdfPageCount(pdfBuffer);
            send({ type: "project", name: project.name, pages: pageCount });
            // [fix 2026-10-24 DOUBLE_BACK] A permanently deleted page (page-permanent-delete.ts) has
            // no row: regenerating its PNGs would re-upload what that tool removed. A project with
            // no page rows at all keeps the whole-PDF behaviour.
            const pageRows = await db.select({ pageNumber: pages.pageNumber }).from(pages).where(eq(pages.projectId, project.id));
            const withRow = new Set(pageRows.map((r) => r.pageNumber));

            // The durable `admin-reprocess:thumbnails` lease is also the asset gateway's
            // fail-closed read fence, so stable legacy keys cannot be observed mid-rebuild.
            for (let pg = 1; pg <= pageCount; pg++) {
                if (withRow.size > 0 && !withRow.has(pg)) {
                  debug("page.noRow", { project: project.name, page: pg });
                  continue;
                }
                const pageKey = String(pg).padStart(4, "0");
                try {
                  // Thumbnail at 72 DPI
                  const thumbBuffer = await rasterizePage(pdfBuffer, pg, 72);
                  await uploadToS3(
                    `${project.dataUrl}/thumbnails/page_${pageKey}.png`,
                    thumbBuffer,
                    "image/png",
                    "public, max-age=31536000, immutable",
                  );
                  // Full page at 300 DPI (also regenerate if missing)
                  const pageBuffer = await rasterizePage(pdfBuffer, pg, 300);
                  await uploadToS3(
                    `${project.dataUrl}/pages/page_${pageKey}.png`,
                    pageBuffer,
                    "image/png",
                    "public, max-age=31536000, immutable",
                  );
                  updatedPages++;
                  debug("page.uploaded", { project: project.name, page: pg, thumbBytes: thumbBuffer.length, pageBytes: pageBuffer.length });
                } catch (err) {
                  logger.error(`[reprocess-thumbnails] Page ${pg} failed for ${project.name}:`, err);
                  skippedPages++;
                  debug("page.failed", { project: project.name, page: pg, reason: err instanceof Error ? err.message : String(err) });
                }
                totalPages++;
                if (totalPages % 3 === 0) {
                  send({ type: "progress", updated: updatedPages, skipped: skippedPages, total: totalPages, project: project.name });
                }
            }
            // Release PDF buffer between projects
            // @ts-ignore
            pdfBuffer = null;
            });
          } catch (err) {
            logger.error(`[reprocess-thumbnails] Project ${project.name} failed:`, err);
            // [refactor P1 reprocess-fold] §B owner-locked (2026-07-08): raw err.message
            // INSIDE the 200 stream is DOMAIN data (client parses by `type`), not an HTTP
            // error envelope — NOT a B-retire site. Preserve verbatim.
            send({ type: "error", project: project.name, error: err instanceof Error ? err.message : "Failed" });
          }
        }

        send({ type: "done", updated: updatedPages, skipped: skippedPages, total: totalPages });
        out.close();
        return;
      }

      if (scope === "shape-parse") {
        const { isLambdaCvEnabled } = await import("@/lib/lambda-cv");
        const useLambda = isLambdaCvEnabled();
        send({ type: "config", useLambda });
        debug("lambda.config", { useLambda, flag: process.env.LAMBDA_CV_ENABLED ?? null, functionName: process.env.LAMBDA_CV_FUNCTION_NAME ?? null, bucketConfigured: !!process.env.S3_BUCKET });
        // skipped = empty + failed (the old single counter); empty = scanned, no shapes; failed = not scanned, rows kept.
        const sp = { empty: 0, failed: 0 };
        const counts = (c = { updated: 0, empty: 0, failed: 0 }) => ({ updated: updatedPages + c.updated, skipped: sp.empty + sp.failed + c.empty + c.failed, empty: sp.empty + c.empty, failed: sp.failed + c.failed, total: totalPages });
        for (const project of allProjects) {
          try {
          const projectPages = await db.select({ pageNumber: pages.pageNumber }).from(pages)
            .where(eq(pages.projectId, project.id)).orderBy(pages.pageNumber);
          if (projectPages.length === 0) continue;
          await withReprocessLease(project.id, async (writeCapability) => {
            send({ type: "project", name: project.name, pages: projectPages.length });
            totalPages += projectPages.length;
            const c = await reprocessProjectShapeParse({
              project, pages: projectPages, writeCapability, useLambda, stream: out,
              onPage: (run) => { if ((run.updated + run.empty + run.failed) % 5 === 0) send({ type: "progress", ...counts(run), project: project.name }); },
            });
            updatedPages += c.updated; sp.empty += c.empty; sp.failed += c.failed; skippedPages = sp.empty + sp.failed;
            send({ type: "progress", ...counts(), project: project.name });
          });
          } catch (err) {
            // Per-project guard — see the page-names scope for why (S8 / TILE_015 C1).
            logger.error(`[reprocess-shape-parse] Project ${project.name} failed:`, err);
            send({ type: "error", project: project.name, error: err instanceof Error ? err.message : "Failed" });
          }
        }

        send({ type: "done", ...counts() });
        out.close();
        return;
      }

      if (scope === "evidence") {
        // [evidence T4] evidence summary only — loop + per-project guard live in reprocess-evidence.ts.
        send({ type: "done", ...(await reprocessEvidenceScope({ projects: allProjects, withLease: withReprocessLease, stream: out })) });
        out.close();
        return;
      }

      if (scope === "graph") {
        // [graph T8 2026-10-24] knowledge graph only — loop + per-project guard live in reprocess-graph.ts.
        send({ type: "done", ...(await reprocessGraphScope({ projects: allProjects, withLease: withReprocessLease, stream: out })) });
        out.close();
        return;
      }

      if (scope === "cross-set") {
        // [cross-set F3 2026-10-24] company-wide cross-set links — compute + per-project guard live in reprocess-cross-set.ts.
        send({ type: "done", ...(await reprocessCrossSetScope({ companyId: session.user.companyId, projects: allProjects, withLease: withReprocessLease, stream: out })) });
        out.close();
        return;
      }

      if (scope === "tiles") {
        // [tiles T9 2026-10-24] Loop + per-project guard live in reprocess-tiles.ts (zero line headroom here).
        await reprocessTilesScope({ projects: allProjects, withReprocessLease, stream: out, levels: (await readTilesSetting()).levels, isRootAdmin: session.user.isRootAdmin });
        out.close();
        return;
      }

      if (scope === "channels") {
        // [census F2 2026-10-24] PDF channel census — loop + per-project guard live in reprocess-channels.ts.
        await reprocessChannelsScope({ projects: allProjects, withReprocessLease, stream: out, isRootAdmin: session.user.isRootAdmin });
        out.close();
        return;
      }

      if (scope === "intelligence") {
        // Intelligence-only reprocess: re-run page analysis + project analysis on existing data.
        // Pulls existing YOLO annotations from the `annotations` table (no SageMaker
        // re-run). If YOLO data exists for a page, it's passed to runHeuristicEngine
        // and classifyPageRegions — mirrors /api/yolo/load post-processing.
        for (const project of allProjects) {
          try {
          await withReprocessLease(project.id, async (writeCapability) => {
          const projectPages = await db
            .select({
              id: pages.id,
              pageNumber: pages.pageNumber,
              drawingNumber: pages.drawingNumber,
              textractData: pages.textractData,
              rawText: pages.rawText,
              csiCodes: pages.csiCodes,
              textAnnotations: pages.textAnnotations,
              storedIntelligence: pages.pageIntelligence,
              keynotes: pages.keynotes,
            })
            .from(pages)
            .where(eq(pages.projectId, project.id))
            .orderBy(pages.pageNumber);

          // Fetch all existing YOLO annotations for this project, group by page.
          // No SageMaker invocation here — we only read what's already in the DB.
          const yoloAnns = await db
            .select({
              name: annotations.name,
              minX: annotations.minX,
              minY: annotations.minY,
              maxX: annotations.maxX,
              maxY: annotations.maxY,
              pageNumber: annotations.pageNumber,
              data: annotations.data,
            })
            .from(annotations)
            .where(
              and(eq(annotations.projectId, project.id), eq(annotations.source, "yolo")),
            );
          const yoloByPage = new Map<
            number,
            Array<{ name: string; minX: number; minY: number; maxX: number; maxY: number; confidence: number; modelName?: string }>
          >();
          for (const a of yoloAnns) {
            if (!yoloByPage.has(a.pageNumber)) yoloByPage.set(a.pageNumber, []);
            const data = a.data as { confidence?: number; modelName?: string } | null;
            yoloByPage.get(a.pageNumber)!.push({
              name: a.name,
              minX: a.minX,
              minY: a.minY,
              maxX: a.maxX,
              maxY: a.maxY,
              confidence: data?.confidence ?? 0,
              modelName: data?.modelName,
            });
          }

          send({
            type: "project",
            name: project.name,
            pages: projectPages.length,
            yoloPages: yoloByPage.size,
          });

          const rules = getEffectiveRules(companyHeuristics);

          for (const page of projectPages) {
            totalPages++;
            if (!page.textractData) { skippedPages++; continue; }
            const textractData = page.textractData as TextractPageData;
            const csiCodes: CsiCode[] = page.csiCodes || [];
            const textAnns = page.textAnnotations?.annotations || [];

            try {
              // [refactor jun12 P0.5-G3] This used to start from {} and wholesale-write
              // at the end of the loop — destroying user parsedRegions (and any other
              // non-computed key) on every page of every project. Start from the
              // existing intelligence with computed keys cleared instead; same merge
              // semantics as yolo/load. See src/lib/intelligence-merge.ts.
              let pageIntelligence: Record<string, unknown> = carryNonComputedIntelligence(page.storedIntelligence);
              // Page intelligence: classification, cross-refs, note blocks
              const intel = analyzePageIntelligence(page.drawingNumber, textractData, csiCodes);
              if (intel.classification || intel.crossRefs || intel.noteBlocks) {
                pageIntelligence = { ...pageIntelligence, ...intel };
              }

              // [zones T2] detector zones once per page: persisted, and fed to the classifier's
              // title-block drop. Absent (no YOLO) ⇒ the classifier keeps its fixed zone.
              const pageYolo = yoloByPage.get(page.pageNumber);
              const pageZones = pageYolo?.length ? computePageZones(pageYolo) : undefined;
              if (pageZones) pageIntelligence.pageZones = pageZones;
              // [evidence T4] fused OCR × YOLO evidence summary (src/lib/evidence; a computed key).
              const evidence = buildEvidenceSummary({ textract: textractData, detections: pageYolo, zones: pageZones });
              if (evidence) pageIntelligence.evidence = evidence;

              // Text region classification (with optional debug bundle to S3)
              const debugWrites: Promise<void>[] = [];
              const textRegions = classifyTextRegions(textractData, csiCodes, {
                debug: debugClassifier,
                pageNumber: page.pageNumber,
                zones: pageZones,
                onDebug: (bundle) => {
                  debugWrites.push(
                    writeClassifierDebugBundle(project.dataUrl, page.pageNumber, bundle),
                  );
                },
              });
              if (textRegions.length > 0) pageIntelligence.textRegions = textRegions;

              // Heuristic engine — YOLO-aware if annotations exist on this page
              const inferences = runHeuristicEngine(rules, {
                rawText: page.rawText || "",
                yoloDetections: pageYolo,
                textRegions: textRegions.length > 0 ? textRegions : undefined,
                csiCodes,
                pageNumber: page.pageNumber,
              });
              if (inferences.length > 0) pageIntelligence.heuristicInferences = inferences;

              // Table classification
              if (textRegions.length > 0) {
                const classified = classifyTables({ textRegions, heuristicInferences: inferences, csiCodes, pageNumber: page.pageNumber });
                if (classified.length > 0) pageIntelligence.classifiedTables = classified;
              }

              // Composite page region classifier — fires only if YOLO data exists.
              // Mirrors the per-page enrichment loop in services/yolo.ts `yoloLoad`, so the
              // intelligence reprocess keeps classifiedRegions in sync with the current YOLO state.
              if (pageYolo && pageYolo.length > 0) {
                // [regions v2 2026-10-24] SHADOW detector-first classifier — mirrors yolo-post-enrichment.ts;
                // `regionsV2` is persisted beside the legacy keys, read by nothing yet.
                try {
                  pageIntelligence.regionsV2 = classifyRegionsV2({ pageNumber: page.pageNumber, detections: pageYolo, zones: pageZones, textractData, csiCodes });
                } catch (err) {
                  logger.error(`[reprocess-intel] classifyRegionsV2 failed for page ${page.pageNumber}:`, err);
                }
                try { // [tag-mapping v2] shape ensemble → `shapes`, the post-YOLO enrichment's own helper
                  pageIntelligence.shapes = computePageShapes({ yoloDets: pageYolo, keynotes: page.keynotes, words: textractData.words, zones: pageZones ?? computePageZones(pageYolo),
                    regionsV2: pageIntelligence.regionsV2 as RegionsV2 | undefined, sheetNumbers: projectPages.map((p) => p.drawingNumber) });
                } catch (err) { logger.error(`[reprocess-intel] Shape ensemble failed for page ${page.pageNumber}:`, err); }
                try {
                  const regions = classifyPageRegions({
                    pageNumber: page.pageNumber,
                    yoloAnnotations: pageYolo.map((d) => ({
                      name: d.name,
                      bbox: [d.minX, d.minY, d.maxX, d.maxY],
                      modelName: d.modelName,
                    })),
                    textRegions: textRegions as Parameters<typeof classifyPageRegions>[0]["textRegions"],
                    parsedRegions: (page.storedIntelligence as any)?.parsedRegions,
                    legacyClassifiedTables: pageIntelligence.classifiedTables as ClassifiedTable[] | undefined,
                  });
                  const hasRegions = regions.tables.length > 0 || regions.titleBlocks.length > 0 || regions.drawings.length > 0;
                  if (hasRegions) pageIntelligence.classifiedRegions = regions;
                } catch (err) {
                  logger.error(`[reprocess-intel] classifyPageRegions failed for page ${page.pageNumber}:`, err);
                }

                // Stage 2a Layer 2: YOLO density heatmap. Universal module —
                // aggregates text_box + vertical_area + horizontal_area into
                // confident-region bboxes. Consumed by LLM context-builder
                // and (Stage 2b) the ensemble reducer. Gated on pipelineConfig.heatmap.
                if (heatmapEnabled) {
                  try {
                    // [fix 2026-10-24 T1a] layout classes from their own model (yolo_text's
                    // per-word text_box would flood the density) — lib/yolo-class-scope.ts.
                    const heatmap = computeYoloHeatmap(page.pageNumber, scopeLayoutDetections(pageYolo), {
                      classes: [...HEATMAP_CLASSES],
                    });
                    if (heatmap.confidentRegions.length > 0
                      || Object.values(heatmap.classContributions).some((v) => v > 0)) {
                      pageIntelligence.yoloHeatmap = heatmap;
                    }
                  } catch (err) {
                    logger.error(`[reprocess-intel] computeYoloHeatmap failed for page ${page.pageNumber}:`, err);
                  }
                }
              }

              // Stage 2b: ensemble reducer — cross-signal agreement across
              // table-classifier + composite-classifier + yolo-heatmap +
              // parsed-region. Suppresses keyword-only false positives.
              // Gated on pipelineConfig.ensemble.
              if (ensembleEnabled) {
                try {
                  const intel = pageIntelligence as any;
                  const votes = collectAllVotes({
                    classifiedTables: intel.classifiedTables,
                    classifiedRegionsTables: intel.classifiedRegions?.tables,
                    yoloHeatmap: intel.yoloHeatmap,
                    // [refactor jun12 G3b] was `intel.parsedRegions` — the freshly
                    // rebuilt object never had that key, so parsed-region votes were
                    // silently absent from every reprocess ensemble. Read from the
                    // page's STORED intelligence, same as the composite classifier.
                    // (Post-G3 the carried-over key also lives on pageIntelligence,
                    // but read the source of truth, not a side effect of the merge.)
                    parsedRegions: (page.storedIntelligence as any)?.parsedRegions,
                  });
                  if (votes.length > 0) {
                    const ensembleRegions = reduceRegionVotes(page.pageNumber, votes, ensembleConfig);
                    if (ensembleRegions.length > 0) {
                      pageIntelligence.ensembleRegions = ensembleRegions;
                    }
                  }
                } catch (err) {
                  logger.error(`[reprocess-intel] ensemble reducer failed for page ${page.pageNumber}:`, err);
                }
              }

              // CSI spatial map — feeds YOLO tags + classifiedTables into the heatmap
              const spatialMap = computeCsiSpatialMap(
                page.pageNumber,
                textAnns,
                pageYolo
                  ? pageYolo.map((d) => ({
                      name: d.name,
                      minX: d.minX,
                      minY: d.minY,
                      maxX: d.maxX,
                      maxY: d.maxY,
                      confidence: d.confidence,
                    }))
                  : undefined,
                pageIntelligence.classifiedTables as any,
              );
              if (spatialMap) pageIntelligence.csiSpatialMap = spatialMap;

              await withProjectWrite(writeCapability, project.id, async (tx) => {
                await tx.update(pages).set({ pageIntelligence }).where(eq(pages.id, page.id));
              });
              // Flush classifier debug writes (if any). Errors inside the writer
              // are already logged; allSettled keeps a single write failure from
              // aborting the loop.
              if (debugWrites.length > 0) await Promise.allSettled(debugWrites);
              updatedPages++;
              debug("page.written", { project: project.name, page: page.pageNumber, keys: Object.keys(pageIntelligence), yolo: pageYolo?.length ?? 0 });
            } catch (err) {
              logger.error(`[reprocess-intel] Page ${page.pageNumber} failed:`, err);
              debug("page.failed", { project: project.name, page: page.pageNumber, reason: err instanceof Error ? err.message : String(err) });
            }

            if (updatedPages % 5 === 0) send({ type: "progress", updated: updatedPages, total: totalPages, project: project.name });
          }

          // [tag-mapping v2] project tag families from the fresh `shapes` (yolo/load's writer) — before the graph reads them.
          await writeProjectTagFamilies(writeCapability, project.id).catch((err) => logger.error(`[reprocess-intel] Tag families failed for ${project.name}:`, err));
          // Project-level analysis
          try {
            const allProcessedPages = await db
              .select({ pageNumber: pages.pageNumber, drawingNumber: pages.drawingNumber, pageIntelligence: pages.pageIntelligence, csiCodes: pages.csiCodes })
              .from(pages).where(and(eq(pages.projectId, project.id), visiblePage(pages.pageIntelligence))).orderBy(pages.pageNumber);

            const { intelligence, summary } = analyzeProject(allProcessedPages.map(p => ({
              pageNumber: p.pageNumber, drawingNumber: p.drawingNumber,
              pageIntelligence: p.pageIntelligence ?? null, csiCodes: p.csiCodes,
            })));

            // [bugfix jul5 H6/DR002] preserve ALL user/unknown PI keys (classCsiOverrides,
            // yoloTags, future keys) — the old classCsiOverrides-only merge silently wiped
            // yoloTags company-wide. See mergeProjectIntelligence.
            await withProjectWrite(writeCapability, project.id, async (tx) => {
              const [currentProject] = await tx
                .select({ pi: projects.projectIntelligence })
                .from(projects)
                .where(eq(projects.id, project.id));
              const mergedIntel = mergeProjectIntelligence(
                currentProject?.pi,
                intelligence as Record<string, unknown>,
              );

              await tx
                .update(projects)
                .set({ projectIntelligence: mergedIntel, projectSummary: summary })
                .where(eq(projects.id, project.id));
            });
            send({ type: "project-analysis", project: project.name });
          } catch (err) {
            logger.error(`[reprocess-intel] Project analysis failed for ${project.name}:`, err);
          }

          // Recompute project summaries (chunking indexes)
          try {
            await computeProjectSummaries(project.id, writeCapability);
            send({ type: "project-summaries", project: project.name });
          } catch (err) {
            logger.error(`[reprocess-intel] Summary computation failed for ${project.name}:`, err);
          }
          // [graph T8] knowledge graph (services/project-graph.ts) — never throws.
          const graph = await refreshProjectGraph(project.id, writeCapability);
          send({ type: "project-graph", project: project.name, ok: graph.ok, references: graph.summary?.references, reason: graph.reason });
          });
          } catch (err) {
            // Per-project guard — see the page-names scope for why (S8 / TILE_015 C1).
            logger.error(`[reprocess-intelligence] Project ${project.name} failed:`, err);
            send({ type: "error", project: project.name, error: err instanceof Error ? err.message : "Failed" });
          }
        }

        send({ type: "done", updated: updatedPages, skipped: skippedPages, total: totalPages });
        out.close();
        return;
      }

      // Full reprocess (existing behavior)
      for (const project of allProjects) {
        try {
        await withReprocessLease(project.id, async (writeCapability) => {
        // Fetch pages with existing textractData (core columns only)
        const projectPages = await db
          .select({
            id: pages.id,
            pageNumber: pages.pageNumber,
            textractData: pages.textractData,
            rawText: pages.rawText, drawingNumber: pages.drawingNumber, // [csi-v2 S6] CSI context
            csiCodes: pages.csiCodes, // [fix 2026-10-21] previous YOLO-class codes survive (reprocess-yolo-csi.ts)
            pageIntelligence: pages.pageIntelligence, // [zones T2] persisted pageZones for the detectors
          })
          .from(pages)
          .where(eq(pages.projectId, project.id))
          .orderBy(pages.pageNumber);

        send({ type: "project", name: project.name, pages: projectPages.length });
        const projectYoloCsi = await loadProjectYoloCsiCodes(project.id);
        debug("project.yolo-csi", { project: project.name, models: projectYoloCsi.models, codes: projectYoloCsi.codes.length });

        for (const page of projectPages) {
          totalPages++;

          if (!page.textractData) {
            skippedPages++;
            continue;
          }

          const textractData = page.textractData as TextractPageData;

          try {
            // Preserve user notes from existing text annotations
            let existingNotes: Record<string, string> = {};
            try {
              const [existing] = await db
                .select({ textAnnotations: pages.textAnnotations })
                .from(pages)
                .where(eq(pages.id, page.id))
                .limit(1);
              if (existing?.textAnnotations) {
                const prev = existing.textAnnotations as TextAnnotationResult;
                for (const ann of prev.annotations || []) {
                  if (ann.note) existingNotes[`${ann.type}:${ann.text}`] = ann.note;
                }
              }
            } catch { /* legacy migration-safety swallow (column now exists) — kept verbatim */ }

            // Re-run CSI detection (before text annotations, since CSI feeds into them). [csi-v2 S6]
            // Pass Textract lines + drawing number so trigger spans + bboxes land on each code.
            const rawText = page.rawText || extractRawText(textractData);
            // [refactor jul9 P2-A C1] 4-arg: thread company config + DB (D-1/D-2).
            const csiCodes = detectCsiCodes(rawText, { lines: textractData.lines, context: { drawingNumber: page.drawingNumber } }, csiCtx.config, csiCtx.db);

            // Re-run text annotation detectors (with CSI codes + pipeline config)
            const textAnnotationResult = detectTextAnnotations(textractData, csiCodes, enabledDetectorIds, storedPageZones(page.pageIntelligence));

            // Merge back user notes from previous run
            for (const ann of textAnnotationResult.annotations) {
              const key = `${ann.type}:${ann.text}`;
              if (existingNotes[key]) ann.note = existingNotes[key];
            }

            const storedCsi = withYoloCsiCodes(csiCodes, page.csiCodes, projectYoloCsi);
            // Update page — legacy two-step write; see the fallback in the catch below.
            try {
              await withProjectWrite(writeCapability, project.id, async (tx) => {
                await tx
                  .update(pages)
                  .set({
                    textAnnotations: textAnnotationResult.annotations.length > 0 ? textAnnotationResult : null,
                    csiCodes: storedCsi.length > 0 ? storedCsi : null,
                  })
                  .where(eq(pages.id, page.id));
              });
            } catch (err) {
              // Legacy migration-safety fallback (column now exists) — retry csiCodes only. Logged: it used to hide real write errors.
              logger.warn(`[reprocess] textAnnotations write failed for page ${page.pageNumber} of ${project.name}; retrying csiCodes only:`, err);
              await withProjectWrite(writeCapability, project.id, async (tx) => {
                await tx
                  .update(pages)
                  .set({ csiCodes: storedCsi.length > 0 ? storedCsi : null })
                  .where(eq(pages.id, page.id));
              });
              send({ type: "warning", project: project.name, message: `Page ${page.pageNumber}: text annotations not saved (${err instanceof Error ? err.message : "write failed"}); CSI codes saved` });
            }

            updatedPages++;
            debug("page.written", { project: project.name, page: page.pageNumber, csiCodes: storedCsi.length, yoloCsiKept: storedCsi.length - csiCodes.length, textAnnotations: textAnnotationResult.annotations.length });
          } catch (err) {
            logger.error(`[reprocess] Page ${page.pageNumber} failed:`, err);
            skippedPages++;
            debug("page.failed", { project: project.name, page: page.pageNumber, reason: err instanceof Error ? err.message : String(err) });
          }

          if (updatedPages % 5 === 0) {
            send({ type: "progress", updated: updatedPages, total: totalPages, project: project.name });
          }
        }

        // Recompute project summaries after full reprocess
        try {
          await computeProjectSummaries(project.id, writeCapability);
          send({ type: "project-summaries", project: project.name });
        } catch (err) {
          logger.error(`[reprocess] Summary computation failed for ${project.name}:`, err);
        }
        });
        } catch (err) {
          // Per-project guard — see the page-names scope for why (S8 / TILE_015 C1).
          logger.error(`[reprocess-full] Project ${project.name} failed:`, err);
          send({ type: "error", project: project.name, error: err instanceof Error ? err.message : "Failed" });
        }
      }

      send({ type: "done", updated: updatedPages, skipped: skippedPages, total: totalPages });
      out.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Transfer-Encoding": "chunked" },
  });
}
