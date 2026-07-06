// [refactor jul6 S037] ADMIN B1 — the six company-jsonb config-clone route contracts
// (demo/config · pipeline · llm/config · csi/config · text-annotations/config ·
// heuristics/config), folded from the legacy routes (git show be5cade^:src/app/api/admin/...
// at the freeze). Char: __tests__/admin-config.route.test.ts (DEMO/PIPE/LLM/CSI/TA/HEU).
// admin/toggles was EVICTED from this batch at STEP-0 recon (S3 app-global storage +
// independent password subsystem — solo fold later; see DR003 B1 plan).
//
// SHARED CORE: all six routes read companies.pipelineConfig for the session company and
// write it back with a TOP-LEVEL SPREAD-MERGE — sibling top-level keys always survive
// (the H6/G3-safe shape; recon confirmed none whole-replace the column). DR003's
// anticipated "merge-mode flag" materialized as `touchUpdatedAt`: the six clones' ONLY
// write-semantics divergence is that heuristics + text-annotations set
// companies.updatedAt and the other four do NOT (frozen per-route; no harmonizing
// in-fold). The read-modify-write is non-atomic exactly like legacy — the concurrent-PUT
// lost-update hazard is pre-existing (H2 class, P1-review ledger).
//
// PRESERVED QUIRKS (each pinned in the freeze):
//   • csi PUT has NO validation — the raw JSON body IS the stored value (scalars/null
//     accepted and written). Its shell therefore uses z.unknown(), NOT zLooseBody; an
//     empty body throws a plain Error here → shell generic INTERNAL 500, no write
//     (legacy: req.json() throw → 500, no write).
//   • heuristics GET swallows BOTH requireAdmin error classes and answers 200 with the
//     built-in-rules fallback (demo-safe read) — so its shell is auth:"none" and this
//     service checks admin-ness inline via auth() (3rd instance of the PR-D1
//     credentials-class idiom; decide-and-pin at phase review).
//   • heuristics PUT writes its TWO keys conditionally (heuristics if isArray, pageNaming
//     if TRUTHY — pageNaming:null is skipped) in ONE update, matching legacy.
//   • textAnnotation PUT REBUILDS its subkey to exactly {enabledDetectors} (sibling
//     subkeys dropped — legacy behavior) and echoes enabledDetectors in the response.
//   • Field-validation 400 literals stay byte-verbatim in-service (diff A at the shell
//     boundary); csi GET TSV stats + llm GET domain-knowledge file reads ported verbatim.

import { readFileSync } from "fs";
import { join } from "path";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import type { AuthSession } from "@/lib/api-utils";
import { ApiError } from "@/server/api/envelope";
import { BUILT_IN_RULES } from "@/lib/heuristic-engine";
import { getAllDetectorMeta } from "@/lib/detectors/registry";

type PipelineConfig = NonNullable<typeof companies.$inferSelect.pipelineConfig>;

/** The pipelineConfig top-level keys the six B1 routes own (typed union per DR003). */
type ConfigKey = "csi" | "demo" | "pipeline" | "llm" | "textAnnotation" | "heuristics" | "pageNaming";

async function readPipelineConfig(companyId: number): Promise<PipelineConfig> {
  const [company] = await db
    .select({ pipelineConfig: companies.pipelineConfig })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return (company?.pipelineConfig || {}) as PipelineConfig;
}

/**
 * Top-level spread-merge write shared by all six routes. `touchUpdatedAt` preserves the
 * frozen per-route split (heuristics + text-annotations touch companies.updatedAt; the
 * other four don't). Values arrive as unknown from loose bodies — the merge is cast at
 * the column boundary exactly like the legacy routes' any-typed req.json() writes.
 */
async function writePipelineConfig(
  companyId: number,
  patch: Partial<Record<ConfigKey, unknown>>,
  opts: { touchUpdatedAt?: boolean } = {},
): Promise<void> {
  const existing = await readPipelineConfig(companyId);
  const updated = { ...existing, ...patch } as PipelineConfig;
  await db
    .update(companies)
    .set(opts.touchUpdatedAt ? { pipelineConfig: updated, updatedAt: new Date() } : { pipelineConfig: updated })
    .where(eq(companies.id, companyId));
}

// ── demo/config ───────────────────────────────────────────────────────────────

export async function getDemoConfig(session: AuthSession): Promise<unknown> {
  const config = await readPipelineConfig(session.user.companyId);
  return { demo: config.demo || {} };
}

export async function putDemoConfig(session: AuthSession, rawBody: Record<string, unknown>): Promise<unknown> {
  const { demo } = rawBody;
  if (!demo || typeof demo !== "object") {
    throw new ApiError("VALIDATION", "demo object required");
  }
  await writePipelineConfig(session.user.companyId, { demo });
  return { success: true };
}

// ── pipeline ──────────────────────────────────────────────────────────────────

export async function getPipelineConfig(session: AuthSession): Promise<unknown> {
  const config = await readPipelineConfig(session.user.companyId);
  return { pipeline: config.pipeline || {} };
}

export async function putPipelineConfig(session: AuthSession, rawBody: Record<string, unknown>): Promise<unknown> {
  const { pipeline } = rawBody;
  if (!pipeline || typeof pipeline !== "object") {
    throw new ApiError("VALIDATION", "pipeline object required");
  }
  await writePipelineConfig(session.user.companyId, { pipeline });
  return { success: true };
}

// ── llm/config ────────────────────────────────────────────────────────────────

export async function getLlmConfig(session: AuthSession): Promise<unknown> {
  const config = await readPipelineConfig(session.user.companyId);

  // Include default domain knowledge so admin editor can show it
  let defaultDomainKnowledge = "";
  try {
    const { readFile } = await import("fs/promises");
    const { join: joinPath } = await import("path");
    defaultDomainKnowledge = await readFile(joinPath(process.cwd(), "src/data/domain-knowledge.md"), "utf-8");
  } catch { /* file not found in production — try dist path */ }

  return { llm: config.llm || {}, defaultDomainKnowledge };
}

export async function putLlmConfig(session: AuthSession, rawBody: Record<string, unknown>): Promise<unknown> {
  const { llm } = rawBody;
  if (!llm || typeof llm !== "object") {
    throw new ApiError("VALIDATION", "llm config object required");
  }
  await writePipelineConfig(session.user.companyId, { llm });
  return { success: true };
}

// ── csi/config ────────────────────────────────────────────────────────────────

export async function getCsiConfig(session: AuthSession): Promise<unknown> {
  const config = await readPipelineConfig(session.user.companyId);
  const csiConfig = config.csi || {};

  // Get CSI database stats
  let totalCodes = 0;
  const divisionSet = new Set<string>();
  try {
    const paths = [
      join(process.cwd(), "src/data/csi-masterformat.tsv"),
      join(process.cwd(), "csi-masterformat.tsv"),
    ];
    for (const p of paths) {
      try {
        const content = readFileSync(p, "utf-8");
        const lines = content.split("\n").filter(l => l.trim());
        totalCodes = Math.max(0, lines.length - 1); // subtract header
        for (const line of lines.slice(1)) {
          const code = line.split("\t")[0] || "";
          if (code.length >= 2) divisionSet.add(code.substring(0, 2));
        }
        break;
      } catch { continue; }
    }
  } catch { /* ignore */ }

  const customDb = csiConfig?.customDatabaseName;
  const source = customDb
    ? `Custom: ${customDb} (${csiConfig?.customDatabaseCodes || "?"} codes)`
    : "Built-in MasterFormat 2018+2016";

  return {
    config: csiConfig,
    stats: { totalCodes, divisions: divisionSet.size, source },
  };
}

/** rawBody is DELIBERATELY unknown — legacy stored whatever JSON arrived (scalars/null too). */
export async function putCsiConfig(session: AuthSession, rawBody: unknown): Promise<unknown> {
  if (rawBody === undefined) {
    // legacy: req.json() on an empty body THREW (Next 500, no write). Plain Error →
    // shell generic INTERNAL 500; must NOT fall through (csi: undefined would DELETE the key).
    throw new Error("csi config: empty body");
  }
  await writePipelineConfig(session.user.companyId, { csi: rawBody });
  return { success: true };
}

// ── text-annotations/config ───────────────────────────────────────────────────

export async function getTextAnnotationConfig(session: AuthSession): Promise<unknown> {
  const detectors = getAllDetectorMeta();
  const config = await readPipelineConfig(session.user.companyId);

  let enabled: string[];
  if (config.textAnnotation?.enabledDetectors) {
    enabled = config.textAnnotation.enabledDetectors;
  } else {
    // Default: all detectors where defaultEnabled is true
    enabled = detectors.filter((d) => d.defaultEnabled).map((d) => d.id);
  }

  return { detectors, enabled };
}

export async function putTextAnnotationConfig(session: AuthSession, rawBody: Record<string, unknown>): Promise<unknown> {
  const { enabledDetectors } = rawBody;

  if (!Array.isArray(enabledDetectors)) {
    throw new ApiError("VALIDATION", "enabledDetectors must be an array");
  }

  // Validate all IDs are known detectors
  const allMeta = getAllDetectorMeta();
  const validIds = new Set(allMeta.map((d) => d.id));
  const invalid = enabledDetectors.filter((id: string) => !validIds.has(id));
  if (invalid.length > 0) {
    throw new ApiError("VALIDATION", `Unknown detector IDs: ${invalid.join(", ")}`);
  }

  // REBUILDS the subkey (sibling subkeys dropped — legacy behavior, frozen TA-4)
  await writePipelineConfig(
    session.user.companyId,
    { textAnnotation: { enabledDetectors } },
    { touchUpdatedAt: true },
  );
  return { success: true, enabledDetectors };
}

// ── heuristics/config ─────────────────────────────────────────────────────────

const builtInRules = () => BUILT_IN_RULES.map((r) => ({ ...r, source: "built-in" as const }));

/**
 * The B1 batch's ONE auth-shape deviation (recon-flagged, frozen HEU-1): legacy GET
 * swallows the requireAdmin error and answers unauth/non-admin callers with the built-in
 * rules fallback. Shell is auth:"none"; admin-ness is checked here inline via auth().
 */
export async function getHeuristicsConfig(): Promise<unknown> {
  const session = (await auth()) as unknown as AuthSession | null;
  const isAdmin = session?.user && (session.user.role === "admin" || session.user.isRootAdmin);
  if (!isAdmin) {
    // For demo/unauthenticated users, return built-in rules only (read-only safe)
    return {
      builtInRules: builtInRules(),
      companyOverrides: [],
      pageNaming: { enabled: false, yoloSources: [] },
    };
  }

  const config = await readPipelineConfig(session.user.companyId);
  const companyHeuristics = config.heuristics || [];
  const pageNaming = config.pageNaming || { enabled: false, yoloSources: [] };

  return {
    builtInRules: builtInRules(),
    companyOverrides: companyHeuristics,
    pageNaming,
  };
}

export async function putHeuristicsConfig(session: AuthSession, rawBody: Record<string, unknown>): Promise<unknown> {
  const { heuristics, pageNaming } = rawBody;

  // At least one of heuristics or pageNaming must be provided
  if (!Array.isArray(heuristics) && !pageNaming) {
    throw new ApiError("VALIDATION", "heuristics array or pageNaming config required");
  }

  // conditional dual-key write in ONE update, matching legacy (pageNaming TRUTHY-gated)
  const patch: Partial<Record<ConfigKey, unknown>> = {};
  if (Array.isArray(heuristics)) patch.heuristics = heuristics;
  if (pageNaming) patch.pageNaming = pageNaming;
  await writePipelineConfig(session.user.companyId, patch, { touchUpdatedAt: true });

  return { success: true };
}
