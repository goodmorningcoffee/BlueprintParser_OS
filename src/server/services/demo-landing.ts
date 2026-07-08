// [refactor jul8 S060] DEMO LANDING SURFACE shell-fold — the last 3 "stay-public" demo routes
// (plan 03 + 09 N9; DR005 GAP-3): demo/config GET + demo/domain-knowledge GET + demo/admin GET,
// folded from the legacy routes (git show 926c631:src/app/api/demo/{config,domain-knowledge,
// admin}/route.ts). Char: __tests__/demo-landing.route.test.ts (DC/DK/DA-*). Option-B
// (owner-LOCKED): the public endpoints STAY dedicated auth:"none" shells; only internals live
// here. Sanctioned diffs: A on demo/admin's sole error path ("No demo projects" 404 flat →
// envelope). NOTHING else — no E (GETs), no B (the demo/config catch is a LOAD-BEARING
// swallow→defaults @200; domain-knowledge's catch produces its RAW ""-404 contract).
// PRESERVED verbatim:
//   • demo/config: the 5 defaults + row spread + ensureProtocol; swallow-catch → defaults.
//   • demo/domain-knowledge: RAW text/plain NextResponse + Cache-Control "public,
//     max-age=3600" (shell Response-passthrough keeps the header — getPageTextract precedent);
//     read failure → RAW "" 404.
//   • demo/admin: the Reddit-launch SECURITY SCRUB (route-header contract, frozen by DA-2's
//     negative key pins): isDemo-only 5-field projects · models MINIMAL {id,name,type,
//     isDefault} (real configs/classes/keywords stay private) · MOCK_MODELS appended on
//     name-dedup · users NEVER returned · demo-scoped yoloStatus SQL · hardcoded toggles ·
//     pipelineConfig scrubbed to ONLY {demo}. Company = the FIRST isDemo project's companyId.

import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { join } from "path";
import { db } from "@/lib/db";
import { appSettings, annotations as _annotations, companies, models, projects } from "@/lib/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { ApiError } from "@/server/api/envelope";

// ── demo/config ──────────────────────────────────────────────────────────────

function ensureProtocol(url: string): string {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url}`;
}

/** Public GET — returns header link config for the demo page. */
export async function getDemoHeaderLinks(): Promise<unknown> {
  const defaults = {
    home: "https://blueprintparser.com",
    hded: "https://hded.blueprintparser.com",
    modelExchange: "https://models.blueprintparser.com",
    planExchange: "https://planexchange.blueprintparser.com",
    labelFleet: "https://www.labelfleet.xyz",
  };

  try {
    const [row] = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, "header_links"))
      .limit(1);
    const links = row ? { ...defaults, ...(row.value as Record<string, string>) } : defaults;
    const sanitized = Object.fromEntries(
      Object.entries(links).map(([k, v]) => [k, ensureProtocol(v)])
    );
    return { headerLinks: sanitized };
  } catch {
    // LOAD-BEARING swallow (DC-3): never a 500 — the demo landing header always renders.
    return { headerLinks: defaults };
  }
}

// ── demo/domain-knowledge ────────────────────────────────────────────────────

/**
 * Serves the built-in domain knowledge file for the demo admin panel.
 * No auth required — static reference content. RAW Response both branches
 * (the shell passes any returned Response through untouched).
 */
export async function getDemoDomainKnowledge(): Promise<Response> {
  try {
    const content = await readFile(
      join(process.cwd(), "src/data/domain-knowledge.md"),
      "utf-8"
    );
    return new NextResponse(content, {
      headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=3600" },
    });
  } catch {
    return new NextResponse("", { status: 404 });
  }
}

// ── demo/admin ───────────────────────────────────────────────────────────────

// 3 mock YOLO models for demo
const MOCK_MODELS = [
  {
    id: 9001,
    name: "yolo_doors",
    type: "yolo",
    isDefault: true,
    config: {
      confidence: 0.10,
      iou: 0.60,
      imageSize: 1280,
      maxDetections: 2000,
      classes: ["door_single", "door_double", "door_sliding", "door_swing_arc", "door_frame"],
      classCsiCodes: { door_single: ["08 11 16"], door_double: ["08 11 16"], door_sliding: ["08 32 13"], door_frame: ["08 11 00"] },
      classKeywords: { door_single: ["door", "entrance"], door_double: ["double door"], door_sliding: ["sliding door", "pocket door"] },
    },
  },
  {
    id: 9002,
    name: "yolo_general",
    type: "yolo",
    isDefault: false,
    config: {
      confidence: 0.15,
      iou: 0.55,
      imageSize: 1280,
      maxDetections: 2000,
      classes: ["window", "toilet", "sink", "elevator", "staircase", "column", "fire_extinguisher", "sprinkler", "light_fixture"],
      classCsiCodes: { window: ["08 51 00"], toilet: ["22 42 16"], sink: ["22 42 13"], elevator: ["14 21 00"], staircase: ["06 43 00"] },
      classKeywords: { window: ["window", "glazing"], toilet: ["WC", "lavatory"], elevator: ["elev", "lift"] },
    },
  },
  {
    id: 9003,
    name: "yolo_electrical",
    type: "yolo",
    isDefault: false,
    config: {
      confidence: 0.12,
      iou: 0.50,
      imageSize: 2048,
      maxDetections: 3000,
      classes: ["receptacle", "switch", "panel_board", "junction_box", "conduit_run", "luminaire", "exit_sign", "smoke_detector"],
      classCsiCodes: { receptacle: ["26 27 26"], switch: ["26 27 23"], panel_board: ["26 24 16"], luminaire: ["26 51 00"] },
      classKeywords: { receptacle: ["outlet", "plug"], switch: ["switch"], panel_board: ["panel", "breaker"] },
    },
  },
];

/**
 * Returns a read-only, demo-scoped admin bundle. Public — no auth required.
 *
 * Scrubbed for Reddit launch. Before this pass, the endpoint returned ALL
 * projects, models, users, and the full pipelineConfig JSONB for the
 * company that owns the demo projects — even real/private ones. Now it
 * returns only:
 *   - Projects: where isDemo === true
 *   - Models: minimal shape (id + name) to support yoloStatus lookups; real
 *     configs, keywords, CSI codes stay private
 *   - Users: NOT returned
 *   - yoloStatus: scoped to demo projects via SQL
 *   - pipelineConfig: only the `demo.*` subsection (feature toggle state),
 *     so the UI can still respect admin flips — CSI/heuristics/pipeline
 *     tuning stay private
 */
export async function getDemoAdminBundle(): Promise<unknown> {
  // Find company from first demo project
  const [demoProject] = await db
    .select({ companyId: projects.companyId })
    .from(projects)
    .where(eq(projects.isDemo, true))
    .limit(1);

  if (!demoProject) {
    throw new ApiError("NOT_FOUND", "No demo projects");
  }

  const companyId = demoProject.companyId;

  const [projectList, realModels, yoloRows, companyRow] = await Promise.all([
    db
      .select({
        id: projects.publicId,
        name: projects.name,
        numPages: projects.numPages,
        status: projects.status,
        isDemo: projects.isDemo,
      })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), eq(projects.isDemo, true))),
    db
      .select({ id: models.id, name: models.name, type: models.type, isDefault: models.isDefault })
      .from(models)
      .where(eq(models.companyId, companyId)),
    db.execute(sql`
      SELECT p.public_id AS project_id, (a.data->>'modelId')::int AS model_id, (a.data->>'modelName') AS model_name, COUNT(a.id)::int AS detection_count
      FROM annotations a JOIN projects p ON a.project_id = p.id
      WHERE a.source = 'yolo' AND p.company_id = ${companyId} AND p.is_demo = true
      GROUP BY p.public_id, (a.data->>'modelId')::int, (a.data->>'modelName')
    `),
    db.select({ pipelineConfig: companies.pipelineConfig }).from(companies).where(eq(companies.id, companyId)).limit(1),
  ]);

  // Real model list reduced to {id, name, type, isDefault} — no config,
  // classes, or keyword metadata leaks publicly. Mock models already
  // hardcoded for the demo UI shell.
  const realModelNames = new Set(realModels.map((m) => m.name));
  const allModels = [
    ...realModels,
    ...MOCK_MODELS.filter((m) => !realModelNames.has(m.name)).map((m) => ({
      id: m.id,
      name: m.name,
      type: m.type,
      isDefault: m.isDefault,
    })),
  ];

  const yoloStatus: Record<string, Record<string, number>> = {};
  for (const row of yoloRows.rows as any[]) {
    if (!yoloStatus[row.project_id]) yoloStatus[row.project_id] = {};
    yoloStatus[row.project_id][row.model_name || String(row.model_id)] = row.detection_count;
  }

  const toggles = { sagemakerEnabled: true, quotaEnabled: false, hasPassword: true };

  const fullConfig = (companyRow[0]?.pipelineConfig ?? {}) as { demo?: Record<string, unknown> };
  const scrubbedConfig = { demo: fullConfig.demo ?? {} };

  return {
    projects: projectList,
    models: allModels,
    yoloStatus,
    toggles,
    pipelineConfig: scrubbedConfig,
  };
}
