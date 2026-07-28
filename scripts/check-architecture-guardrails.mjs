#!/usr/bin/env node

/**
 * Baseline-aware architecture guardrails installed after P2.
 *
 * Every exception is an approved ceiling, not a target: deleting an occurrence or shrinking a file
 * passes, while a new exception path or growth above a path's frozen ceiling fails. Keep the lists
 * path-sorted and lower their ceilings when deliberately retiring debt.
 *
 * Exact scopes and syntax:
 * - raw fetch: `fetch` followed by optional horizontal/vertical whitespace and `(` in production
 *   TypeScript/TSX files below `src/components` and `src/stores`;
 * - DB placement: static/dynamic imports, re-exports, or `require()` resolving to `src/lib/db` or a
 *   child module in production TypeScript/TSX below `src`, outside `src/server/services` and
 *   `src/lib/db`;
 * - route shell: every exported HTTP method in a `route.ts` below `src/app/api` must be the result of
 *   canonical `defineRoute`, alias such a handler, or return its result through an explicitly trusted
 *   response-policy import. A file-level sentinel import/call cannot authorize an unrelated raw
 *   export. Classified framework, health, and raw-route exceptions have exact method inventories;
 *   the sole raw CORS preflight is path+method scoped so it cannot exempt GET/HEAD handlers;
 * - `as any`: literal `as` + whitespace + `any` in production TypeScript/TSX below `src`;
 * - max lines: production TypeScript/TSX below `src` has an 800-line ceiling; approved oversized files
 *   may not grow past their frozen logical-line counts.
 *
 * "Production" excludes `src/test/**`, any `__tests__` directory, and `*.test.*`/`*.spec.*` files.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const ROOT = process.cwd();
const MAX_LINES = 800;
const HTTP_METHODS = new Set([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
]);

const RAW_FETCH_BASELINE = {
  expectedFiles: 26,
  expectedOccurrences: 40,
  approved: [
    { path: "src/components/auth/LoginForm.tsx", max: 1 },
    { path: "src/components/auth/RegisterForm.tsx", max: 1 },
    { path: "src/components/dashboard/ProjectCard.tsx", max: 2 },
    { path: "src/components/dashboard/UploadWidget.tsx", max: 2 },
    { path: "src/components/viewer/AnnotationListItem.tsx", max: 1 },
    { path: "src/components/viewer/AreaTab.tsx", max: 1 },
    { path: "src/components/viewer/AutoParseTab.tsx", max: 1 },
    { path: "src/components/viewer/BucketFillAssignDialog.tsx", max: 1 },
    { path: "src/components/viewer/CalibrationInput.tsx", max: 2 },
    { path: "src/components/viewer/ChatPanel.tsx", max: 2 },
    { path: "src/components/viewer/CountTab.tsx", max: 1 },
    { path: "src/components/viewer/DetectionPanel.tsx", max: 3 },
    { path: "src/components/viewer/GuidedParseTab.tsx", max: 1 },
    { path: "src/components/viewer/KeynotePanel.tsx", max: 3 },
    { path: "src/components/viewer/LabelingWizard.tsx", max: 2 },
    { path: "src/components/viewer/LinearTab.tsx", max: 1 },
    { path: "src/components/viewer/NotesParser.tsx", max: 2 },
    { path: "src/components/viewer/PageSidebar.tsx", max: 1 },
    { path: "src/components/viewer/SpecParser.tsx", max: 1 },
    { path: "src/components/viewer/SymbolSearchPanel.tsx", max: 2 },
    { path: "src/components/viewer/TableParsePanel.tsx", max: 1 },
    { path: "src/components/viewer/TakeoffPanel.tsx", max: 1 },
    { path: "src/components/viewer/TextPanel.tsx", max: 2 },
    { path: "src/components/viewer/ViewAllPanel.tsx", max: 3 },
    { path: "src/components/viewer/ViewerToolbar.tsx", max: 1 },
    { path: "src/components/viewer/tools/bucketFill.ts", max: 1 },
  ],
};

const DB_IMPORT_BASELINE = {
  expectedFiles: 29,
  // [P5.4-C rebudget 2026-07-23] 53→54: login-lockout's DELETE became a recognized
  // db.delete builder sink when the unprovable db.execute(sql`…`) form was replaced
  // (security-policy gate); matches the login-lockout per-file ceiling bump to 2.
  expectedOccurrences: 54,
  approved: [
    {
      path: "src/app/api/auto-detect-tables/route.ts",
      max: 2,
      reason: "raw-route",
    },
    { path: "src/app/api/demo/chat/route.ts", max: 2, reason: "raw-route" },
    { path: "src/app/api/demo/csi/route.ts", max: 1, reason: "raw-route" },
    {
      path: "src/lib/admin-logs/manual-ban-cache.ts",
      max: 2,
      reason: "shared-infrastructure",
    },
    {
      path: "src/lib/admin-logs/record-abuse.ts",
      max: 2,
      reason: "shared-infrastructure",
    },
    { path: "src/lib/api-utils.ts", max: 2, reason: "shared-infrastructure" },
    { path: "src/lib/audit.ts", max: 2, reason: "shared-infrastructure" },
    { path: "src/lib/auth.ts", max: 2, reason: "shared-infrastructure" },
    {
      path: "src/lib/compute-usage.ts",
      max: 2,
      reason: "shared-infrastructure",
    },
    {
      path: "src/lib/csi-company-db.ts",
      max: 2,
      reason: "read-only-csi-resolver",
    },
    { path: "src/lib/demo-features.ts", max: 2, reason: "legacy-demo-gate" },
    {
      path: "src/lib/label-studio-asset-grant.ts",
      max: 2,
      reason: "revocable-asset-authority",
    },
    {
      path: "src/lib/label-studio-project-intent.ts",
      max: 2,
      reason: "durable-project-intent",
    },
    {
      path: "src/lib/label-studio-session-retirement.ts",
      max: 2,
      reason: "durable-provider-retirement",
    },
    { path: "src/lib/llm/resolve.ts", max: 2, reason: "legacy-domain-engine" },
    { path: "src/lib/llm/stream.ts", max: 2, reason: "legacy-domain-engine" },
    { path: "src/lib/llm/tools.ts", max: 2, reason: "legacy-domain-engine" },
    {
      path: "src/lib/login-lockout.ts",
      max: 2,
      // [P5.4-C rebudget 2026-07-23] +1: the login_lockouts upsert + DELETE became
      // drizzle-builder sinks (db.insert/db.delete) — the security checker forbids the
      // prior unprovable db.execute(sql`…`) form; both are now recognized db placements.
      reason: "shared-runtime-state",
    },
    {
      path: "src/lib/parse-history.ts",
      max: 2,
      reason: "shared-runtime-state",
    },
    { path: "src/lib/processing.ts", max: 2, reason: "legacy-domain-engine" },
    {
      path: "src/lib/project-analysis.ts",
      max: 2,
      reason: "legacy-domain-engine",
    },
    {
      path: "src/lib/project-asset-deletion.ts",
      max: 2,
      reason: "durable-storage-retirement",
    },
    {
      path: "src/lib/project-asset-object-events.ts",
      max: 2,
      reason: "durable-storage-retirement",
    },
    {
      path: "src/lib/project-delete.ts",
      max: 1,
      reason: "shared-infrastructure",
    },
    { path: "src/lib/quotas.ts", max: 1, reason: "shared-infrastructure" },
    {
      path: "src/lib/services/chat/global.ts",
      max: 2,
      reason: "legacy-domain-engine",
    },
    {
      path: "src/lib/services/chat/scoped.ts",
      max: 2,
      reason: "legacy-domain-engine",
    },
    {
      path: "src/server/api/project-write-capability.ts",
      max: 2,
      reason: "shared-lifecycle-authority",
    },
    { path: "src/types/index.ts", max: 1, reason: "shared-schema-types" },
  ],
};

const ROUTE_SHELL_BASELINE = {
  expectedExceptions: 5,
  approved: [
    {
      path: "src/app/api/auth/[...nextauth]/route.ts",
      classification: "framework",
      methods: ["GET", "POST"],
    },
    {
      path: "src/app/api/auto-detect-tables/route.ts",
      classification: "raw",
      methods: ["POST"],
    },
    {
      path: "src/app/api/demo/chat/route.ts",
      classification: "raw",
      methods: ["POST"],
    },
    {
      path: "src/app/api/demo/csi/route.ts",
      classification: "raw",
      methods: ["GET"],
    },
    {
      path: "src/app/api/health/route.ts",
      classification: "health",
      methods: ["GET"],
    },
  ],
};

/**
 * Raw response shells may apply only these reviewed, security-header policies. The value at
 * `responseArgument` must itself be derived from the route's canonical handler result.
 */
const TRUSTED_ROUTE_RESPONSE_POLICIES = [
  {
    module: "@/lib/label-studio-asset-grant",
    imported: "withLabelStudioAssetResponsePolicy",
    responseArgument: 1,
  },
  {
    module: "@/server/services/project-assets",
    imported: "withProjectAssetResponsePolicy",
    responseArgument: 0,
  },
];

const ROUTE_METHOD_EXCEPTION_BASELINE = {
  expectedExceptions: 1,
  approved: [
    {
      path: "src/app/api/label-assets/[id]/route.ts",
      method: "OPTIONS",
      classification: "cors-preflight",
    },
  ],
};

const AS_ANY_BASELINE = {
  expectedFiles: 44,
  expectedOccurrences: 142,
  approved: [
    { path: "src/app/(dashboard)/home/page.tsx", max: 2 },
    { path: "src/app/api/demo/chat/route.ts", max: 1 },
    { path: "src/app/docs/sections/12-for-llms.tsx", max: 1 },
    { path: "src/components/viewer/AnnotationOverlay.tsx", max: 6 },
    { path: "src/components/viewer/AreaTab.tsx", max: 6 },
    { path: "src/components/viewer/AutoQtoTab.tsx", max: 3 },
    { path: "src/components/viewer/CountTab.tsx", max: 4 },
    { path: "src/components/viewer/KeynoteItem.tsx", max: 2 },
    { path: "src/components/viewer/KeynotePanel.tsx", max: 7 },
    { path: "src/components/viewer/LinearTab.tsx", max: 4 },
    { path: "src/components/viewer/PageIntelligencePanel.tsx", max: 2 },
    { path: "src/components/viewer/PageSidebar.tsx", max: 3 },
    { path: "src/components/viewer/ParseRegionLayer.tsx", max: 1 },
    { path: "src/components/viewer/ParsedTableCellOverlay.tsx", max: 1 },
    { path: "src/components/viewer/ParsedTableItem.tsx", max: 2 },
    { path: "src/components/viewer/SymbolSearchPanel.tsx", max: 2 },
    { path: "src/components/viewer/TableCompareModal.tsx", max: 2 },
    { path: "src/components/viewer/TableParsePanel.tsx", max: 4 },
    { path: "src/components/viewer/TakeoffPanel.tsx", max: 6 },
    { path: "src/components/viewer/TextAnnotationOverlay.tsx", max: 1 },
    { path: "src/components/viewer/ViewerToolbar.tsx", max: 2 },
    { path: "src/components/viewer/render/existingAnnotations.ts", max: 3 },
    { path: "src/components/viewer/tools/pointerGroup.ts", max: 7 },
    { path: "src/components/viewer/tools/tagPick.ts", max: 1 },
    { path: "src/hooks/useChunkLoader.ts", max: 1 },
    { path: "src/lib/context-builder.ts", max: 4 },
    { path: "src/lib/csi-spatial-refresh-target.ts", max: 3 },
    { path: "src/lib/csi-spatial.ts", max: 1 },
    { path: "src/lib/detectors/orchestrator.ts", max: 1 },
    { path: "src/lib/llm/tools.ts", max: 12 },
    { path: "src/lib/processing.ts", max: 8 },
    { path: "src/lib/project-analysis.ts", max: 6 },
    { path: "src/lib/quotas.ts", max: 4 },
    { path: "src/lib/services/chat/global.ts", max: 3 },
    { path: "src/lib/services/chat/scoped.ts", max: 3 },
    { path: "src/server/services/companies.ts", max: 4 },
    { path: "src/server/services/demo-landing.ts", max: 1 },
    { path: "src/server/services/llm-preview.ts", max: 2 },
    { path: "src/server/services/projects.ts", max: 3 },
    { path: "src/server/services/reprocess.ts", max: 6 },
    { path: "src/server/services/running-jobs.ts", max: 1 },
    { path: "src/server/services/table-parse.ts", max: 1 },
    { path: "src/server/services/yolo-admin.ts", max: 1 },
    { path: "src/server/services/yolo.ts", max: 4 },
  ],
};

const MAX_LINES_BASELINE = {
  expectedFiles: 22,
  approved: [
    {
      path: "src/app/project/[id]/csi-graph/page.tsx",
      maxLines: 912,
      reason: "route-ui",
    },
    {
      path: "src/components/viewer/AnnotationOverlay.tsx",
      maxLines: 1571,
      reason: "viewer-hot-exception",
    },
    {
      path: "src/components/viewer/AreaTab.tsx",
      maxLines: 806,
      reason: "viewer-tool",
    },
    {
      path: "src/components/viewer/AutoParseTab.tsx",
      maxLines: 902,
      reason: "viewer-tool",
    },
    {
      path: "src/components/viewer/AutoQtoTab.tsx",
      maxLines: 1743,
      reason: "viewer-tool",
    },
    {
      path: "src/components/viewer/DetectionPanel.tsx",
      maxLines: 1193,
      reason: "viewer-tool",
    },
    {
      // [bucketfill P3] 868 -> 869: net +1, and it is the `polygonCentroid` IMPORT. The §3.4
      // consumer sweep found this file re-implementing the vertex-mean centroid bug already fixed
      // in areaCalc.ts, twice. Replacing both with the shared function made the LOGIC shorter;
      // only the import line is new. Bumped rather than absorbed, because a bug fix should not
      // have to argue with a ceiling.
      // [bucketfill P3] 869 -> 872: net +3, of which the CODE is +0 — the banner's two style lines
      // became conditional in place. The three added lines are the comment explaining why the tone
      // is DERIVED from `bucketFillPreview` rather than stored: a message with a preview is a
      // caveat on a number the user can still accept, one without is a refusal. Storing it would
      // add a key to an exact-set store freeze and create a second source of truth that can
      // disagree with the first. Comment cut to three lines before bumping, so this is the floor.
      // [bucketfill P3] 872 -> 874: net +2 — one import and one comment line. The preview badge
      // compared `method === "vector"`, a string NO producer has ever emitted (the real values are
      // client-vector / client-raster / server-raster), so the branch shipped dead and every fill
      // was labelled "Raster". Invisible because that label was correct for the only engine that
      // could run; live vector would have silently mislabelled every vector fill. Comment cut to
      // one line before bumping.
      path: "src/components/viewer/DrawingPreviewLayer.tsx",
      maxLines: 874,
      reason: "viewer-hot-exception",
    },
    {
      path: "src/components/viewer/KeynotePanel.tsx",
      maxLines: 1606,
      reason: "viewer-tool",
    },
    {
      path: "src/components/viewer/NotesParser.tsx",
      maxLines: 818,
      reason: "viewer-tool",
    },
    {
      path: "src/components/viewer/ParsedTableItem.tsx",
      maxLines: 884,
      reason: "viewer-tool",
    },
    {
      path: "src/components/viewer/SymbolSearchPanel.tsx",
      maxLines: 923,
      reason: "viewer-tool",
    },
    {
      path: "src/components/viewer/TextPanel.tsx",
      maxLines: 909,
      reason: "viewer-tool",
    },
    {
      path: "src/components/viewer/ViewAllPanel.tsx",
      maxLines: 1664,
      reason: "viewer-tool",
    },
    {
      path: "src/lib/db/schema.ts",
      maxLines: 984,
      // [P4.1 rebudget 2026-07-23] +1: csiCodes $type<CsiCode[]> widening (5065f95, U9-D).
      // [P5.4 rebudget 2026-07-23] +61: runtime_counters/login_lockouts/op_log tables +
      // manual_ip_bans auto-ban columns (Stage B, migration 0039_runtime_state).
      reason: "immutable-provider-binding-and-retirement-authority",
    },
    {
      path: "src/lib/processing.ts",
      maxLines: 825,
      // [P4.1 rebudget 2026-07-23] +11: U7 shape-parse observe-sink hoist (b170db0).
      reason: "legacy-domain-engine",
    },
    {
      path: "src/server/services/labeling.ts",
      maxLines: 1099,
      reason: "binding-first-provider-collision-quarantine-state-machine",
    },
    {
      path: "src/server/services/projects.ts",
      maxLines: 804,
      reason: "legacy-service",
    },
    {
      path: "src/server/services/reprocess.ts",
      maxLines: 926,
      // [P4.1 rebudget 2026-07-23] +18: U7 observe at both shape-parse writers (b170db0).
      // [csi-rebuild S8 rebudget 2026-07-25] +27: per-project try/catch on the four
      // scopes that lacked one (TILE_015 C1). Without them a single failing project
      // truncated the NDJSON stream with no `done`. Comments are consolidated to one
      // full explanation plus three references specifically to keep this bump small.
      reason: "legacy-service",
    },
    {
      path: "src/server/services/yolo.ts",
      maxLines: 963,
      // [P4.1 rebudget 2026-07-23] +14: U7 yolo.load observe (b170db0) + U9-C merge unification (e5f441e).
      reason: "legacy-service",
    },
    {
      path: "src/stores/viewerCommands.ts",
      maxLines: 2504,
      reason: "viewer-command-owner",
    },
    {
      // [bucketfill P3] 1163 -> 1164: ONE line for `AreaPolygonData.method`, the engine-provenance
      // field PLAN §5 phase 3 requires. Bumped deliberately rather than absorbed: the field is
      // mandatory, and the comment documenting it was cut to a trailing one-liner first so the
      // bump is the true minimum. This ceiling exists to stop drift, not to block a required field.
      path: "src/types/index.ts",
      maxLines: 1164,
      reason: "legacy-schema-catalog",
    },
    {
      path: "src/workers/bucket-fill.worker.ts",
      maxLines: 838,
      reason: "viewer-worker",
    },
  ],
};

const violations = [];
const improvements = [];

function comparePath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function report(rule, message) {
  violations.push({ rule, message });
}

function assertSortedUnique(rule, approved) {
  for (let index = 1; index < approved.length; index += 1) {
    if (comparePath(approved[index - 1].path, approved[index].path) >= 0) {
      report(
        rule,
        `allowlist must be strictly path-sorted: ${approved[index - 1].path} / ${approved[index].path}`,
      );
    }
  }
}

function assertSortedUniqueRouteMethods(rule, approved) {
  for (let index = 1; index < approved.length; index += 1) {
    const previous = `${approved[index - 1].path}:${approved[index - 1].method}`;
    const current = `${approved[index].path}:${approved[index].method}`;
    if (comparePath(previous, current) >= 0) {
      report(
        rule,
        `allowlist must be strictly path/method-sorted: ${previous} / ${current}`,
      );
    }
  }
}

function assertSortedUniqueStrings(rule, label, values) {
  for (let index = 1; index < values.length; index += 1) {
    if (comparePath(values[index - 1], values[index]) >= 0) {
      report(
        rule,
        `${label} must be strictly sorted and unique: ${values[index - 1]} / ${values[index]}`,
      );
    }
  }
}

function validateCountBaseline(rule, baseline) {
  assertSortedUnique(rule, baseline.approved);
  if (baseline.approved.length !== baseline.expectedFiles) {
    report(
      rule,
      `manifest expectedFiles=${baseline.expectedFiles}, allowlist has ${baseline.approved.length}`,
    );
  }
  const total = baseline.approved.reduce((sum, entry) => sum + entry.max, 0);
  if (total !== baseline.expectedOccurrences) {
    report(
      rule,
      `manifest expectedOccurrences=${baseline.expectedOccurrences}, ceilings sum to ${total}`,
    );
  }
}

function validateManifest() {
  validateCountBaseline("raw-fetch", RAW_FETCH_BASELINE);
  validateCountBaseline("db-placement", DB_IMPORT_BASELINE);
  validateCountBaseline("as-any", AS_ANY_BASELINE);
  assertSortedUnique("route-shell", ROUTE_SHELL_BASELINE.approved);
  if (
    ROUTE_SHELL_BASELINE.approved.length !==
    ROUTE_SHELL_BASELINE.expectedExceptions
  ) {
    report(
      "route-shell",
      `manifest expectedExceptions=${ROUTE_SHELL_BASELINE.expectedExceptions}, allowlist has ${ROUTE_SHELL_BASELINE.approved.length}`,
    );
  }
  const validClassifications = new Set(["framework", "health", "raw"]);
  for (const entry of ROUTE_SHELL_BASELINE.approved) {
    if (!validClassifications.has(entry.classification)) {
      report(
        "route-shell",
        `${entry.path} has invalid classification ${entry.classification}`,
      );
    }
    if (!Array.isArray(entry.methods) || entry.methods.length === 0) {
      report("route-shell", `${entry.path} has no exception method inventory`);
      continue;
    }
    assertSortedUniqueStrings(
      "route-shell",
      `${entry.path} method inventory`,
      entry.methods,
    );
    for (const method of entry.methods) {
      if (!HTTP_METHODS.has(method)) {
        report(
          "route-shell",
          `${entry.path} inventories invalid method ${method}`,
        );
      }
    }
  }
  assertSortedUniqueStrings(
    "route-shell",
    "trusted response policies",
    TRUSTED_ROUTE_RESPONSE_POLICIES.map(
      (entry) => `${entry.module}:${entry.imported}`,
    ),
  );
  for (const entry of TRUSTED_ROUTE_RESPONSE_POLICIES) {
    if (
      !Number.isSafeInteger(entry.responseArgument) ||
      entry.responseArgument < 0
    ) {
      report(
        "route-shell",
        `${entry.module}:${entry.imported} has invalid response argument ${entry.responseArgument}`,
      );
    }
  }
  assertSortedUniqueRouteMethods(
    "route-shell",
    ROUTE_METHOD_EXCEPTION_BASELINE.approved,
  );
  if (
    ROUTE_METHOD_EXCEPTION_BASELINE.approved.length !==
    ROUTE_METHOD_EXCEPTION_BASELINE.expectedExceptions
  ) {
    report(
      "route-shell",
      `manifest expected method exceptions=${ROUTE_METHOD_EXCEPTION_BASELINE.expectedExceptions}, allowlist has ${ROUTE_METHOD_EXCEPTION_BASELINE.approved.length}`,
    );
  }
  for (const entry of ROUTE_METHOD_EXCEPTION_BASELINE.approved) {
    if (
      entry.method !== "OPTIONS" ||
      entry.classification !== "cors-preflight" ||
      ROUTE_SHELL_BASELINE.approved.some((route) => route.path === entry.path)
    ) {
      report(
        "route-shell",
        `${entry.path}:${entry.method} is not a narrow non-route CORS-preflight exception`,
      );
    }
  }
  assertSortedUnique("max-lines", MAX_LINES_BASELINE.approved);
  if (MAX_LINES_BASELINE.approved.length !== MAX_LINES_BASELINE.expectedFiles) {
    report(
      "max-lines",
      `manifest expectedFiles=${MAX_LINES_BASELINE.expectedFiles}, allowlist has ${MAX_LINES_BASELINE.approved.length}`,
    );
  }
  for (const entry of MAX_LINES_BASELINE.approved) {
    if (entry.maxLines <= MAX_LINES) {
      report(
        "max-lines",
        `${entry.path} ceiling ${entry.maxLines} must exceed ${MAX_LINES}`,
      );
    }
  }
}

function isProductionSource(relative) {
  if (!relative.startsWith("src/") || !/\.tsx?$/u.test(relative)) return false;
  if (relative.startsWith("src/test/") || relative.includes("/__tests__/"))
    return false;
  return !/\.(?:test|spec)\.tsx?$/u.test(relative);
}

async function walk(relativeDirectory) {
  const entries = await readdir(path.join(ROOT, relativeDirectory), {
    withFileTypes: true,
  });
  entries.sort((left, right) => comparePath(left.name, right.name));
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      files.push(...(await walk(relative)));
    } else if (entry.isFile() && isProductionSource(relative)) {
      files.push(relative);
    }
  }
  return files;
}

function countMatches(text, expression) {
  return [...text.matchAll(expression)].length;
}

function logicalLineCount(text) {
  if (text.length === 0) return 0;
  const breaks = countMatches(text, /\r\n|\r|\n/gu);
  return breaks + (/(?:\r\n|\r|\n)$/u.test(text) ? 0 : 1);
}

function parseSource(file, text) {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function moduleSpecifierText(node) {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

function isDbSpecifier(specifier, importer) {
  if (specifier === "@/lib/db" || specifier?.startsWith("@/lib/db/"))
    return true;
  if (!specifier?.startsWith(".")) return false;
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(importer), specifier),
  );
  return resolved === "src/lib/db" || resolved.startsWith("src/lib/db/");
}

function countDbImports(source) {
  let count = 0;
  function visit(node) {
    let specifier = null;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = moduleSpecifierText(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      specifier = moduleSpecifierText(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const isDynamicImport =
        node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire)
        specifier = moduleSpecifierText(node.arguments[0]);
    }
    if (isDbSpecifier(specifier, source.fileName)) count += 1;
    ts.forEachChild(node, visit);
  }
  visit(source);
  return count;
}

function importsCanonicalDefineRoute(source) {
  return source.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      moduleSpecifierText(statement.moduleSpecifier) !==
        "@/server/api/defineRoute"
    ) {
      return false;
    }
    const bindings = statement.importClause?.namedBindings;
    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some(
        (element) =>
          element.name.text === "defineRoute" &&
          element.propertyName === undefined,
      )
    );
  });
}

function trustedRouteResponsePolicyBindings(source) {
  const trustedImports = new Map(
    TRUSTED_ROUTE_RESPONSE_POLICIES.map((entry) => [
      `${entry.module}:${entry.imported}`,
      entry.responseArgument,
    ]),
  );
  const bindings = new Map();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      statement.importClause?.isTypeOnly
    ) {
      continue;
    }
    const modulePath = moduleSpecifierText(statement.moduleSpecifier);
    const namedBindings = statement.importClause?.namedBindings;
    if (!modulePath || !namedBindings || !ts.isNamedImports(namedBindings))
      continue;

    for (const element of namedBindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = element.propertyName?.text ?? element.name.text;
      const responseArgument = trustedImports.get(`${modulePath}:${imported}`);
      if (responseArgument !== undefined) {
        bindings.set(element.name.text, responseArgument);
      }
    }
  }
  return bindings;
}

function hasExportModifier(node) {
  return Boolean(
    node.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ),
  );
}

function unwrapRouteExpression(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isAwaitExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function isCanonicalDefineRouteCall(node, canonicalImport) {
  const expression = unwrapRouteExpression(node);
  return Boolean(
    canonicalImport &&
    expression &&
    ts.isCallExpression(expression) &&
    ts.isIdentifier(unwrapRouteExpression(expression.expression)) &&
    unwrapRouteExpression(expression.expression).text === "defineRoute",
  );
}

function bindingIdentifiers(name) {
  if (ts.isIdentifier(name)) return [name.text];
  const identifiers = [];
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      identifiers.push(...bindingIdentifiers(element.name));
    }
  }
  return identifiers;
}

function topLevelBindings(source) {
  const bindings = new Map();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          bindings.set(declaration.name.text, declaration.initializer);
        }
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      bindings.set(statement.name.text, statement);
    }
  }
  return bindings;
}

function canonicalHandlerNames(bindings, canonicalImport) {
  const handlers = new Set();
  if (!canonicalImport) return handlers;

  for (const [name, target] of bindings) {
    if (isCanonicalDefineRouteCall(target, canonicalImport)) handlers.add(name);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, target] of bindings) {
      const expression = unwrapRouteExpression(target);
      if (
        !handlers.has(name) &&
        expression &&
        ts.isIdentifier(expression) &&
        handlers.has(expression.text)
      ) {
        handlers.add(name);
        changed = true;
      }
    }
  }
  return handlers;
}

/**
 * Conservative response-value tracking for the small reviewed policy wrappers used by raw routes.
 * Arbitrary calls never preserve provenance: only the canonical handler and an exact trusted import
 * may be invoked. Immutable local values and Response reconstruction preserve provenance so security
 * headers can cover shell-generated responses without authorizing discarded handler results.
 */
function expressionDerivesFromHandler(
  node,
  handlerNames,
  responsePolicies,
  derivedNames,
) {
  const expression = unwrapRouteExpression(node);
  if (!expression) return false;

  if (ts.isIdentifier(expression)) {
    return derivedNames.has(expression.text);
  }
  if (ts.isCallExpression(expression)) {
    const callee = unwrapRouteExpression(expression.expression);
    if (ts.isIdentifier(callee) && handlerNames.has(callee.text)) return true;
    if (!ts.isIdentifier(callee)) return false;
    const responseArgument = responsePolicies.get(callee.text);
    if (responseArgument === undefined) return false;
    return expressionDerivesFromHandler(
      expression.arguments[responseArgument],
      handlerNames,
      responsePolicies,
      derivedNames,
    );
  }
  if (ts.isNewExpression(expression)) {
    const constructor = unwrapRouteExpression(expression.expression);
    if (!ts.isIdentifier(constructor) || constructor.text !== "Response") {
      return false;
    }
    return (expression.arguments ?? []).some((argument) =>
      expressionDerivesFromHandler(
        argument,
        handlerNames,
        responsePolicies,
        derivedNames,
      ),
    );
  }
  if (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) {
    return expressionDerivesFromHandler(
      expression.expression,
      handlerNames,
      responsePolicies,
      derivedNames,
    );
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.some((property) => {
      if (ts.isPropertyAssignment(property)) {
        return expressionDerivesFromHandler(
          property.initializer,
          handlerNames,
          responsePolicies,
          derivedNames,
        );
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return derivedNames.has(property.name.text);
      }
      if (ts.isSpreadAssignment(property)) {
        return expressionDerivesFromHandler(
          property.expression,
          handlerNames,
          responsePolicies,
          derivedNames,
        );
      }
      return false;
    });
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.some((element) =>
      expressionDerivesFromHandler(
        element,
        handlerNames,
        responsePolicies,
        derivedNames,
      ),
    );
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      expressionDerivesFromHandler(
        expression.whenTrue,
        handlerNames,
        responsePolicies,
        derivedNames,
      ) &&
      expressionDerivesFromHandler(
        expression.whenFalse,
        handlerNames,
        responsePolicies,
        derivedNames,
      )
    );
  }
  if (ts.isBinaryExpression(expression)) {
    if (expression.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return expressionDerivesFromHandler(
        expression.right,
        handlerNames,
        responsePolicies,
        derivedNames,
      );
    }
    if (
      expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      expression.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return (
        expressionDerivesFromHandler(
          expression.left,
          handlerNames,
          responsePolicies,
          derivedNames,
        ) &&
        expressionDerivesFromHandler(
          expression.right,
          handlerNames,
          responsePolicies,
          derivedNames,
        )
      );
    }
    return false;
  }
  return false;
}

function functionLocalBindingNames(node) {
  const names = new Set();
  for (const parameter of node.parameters) {
    for (const name of bindingIdentifiers(parameter.name)) names.add(name);
  }

  function visit(current) {
    if (current !== node.body && ts.isFunctionLike(current)) {
      if (ts.isFunctionDeclaration(current) && current.name) {
        names.add(current.name.text);
      }
      return;
    }
    if (ts.isVariableDeclaration(current)) {
      for (const name of bindingIdentifiers(current.name)) names.add(name);
    } else if (ts.isClassDeclaration(current) && current.name) {
      names.add(current.name.text);
    } else if (ts.isCatchClause(current) && current.variableDeclaration) {
      for (const name of bindingIdentifiers(current.variableDeclaration.name)) {
        names.add(name);
      }
    }
    ts.forEachChild(current, visit);
  }
  if (node.body) visit(node.body);
  return names;
}

function functionReturnsHandlerResult(node, handlerNames, responsePolicies) {
  const shadowedNames = functionLocalBindingNames(node);
  const availableHandlers = new Set(
    [...handlerNames].filter((name) => !shadowedNames.has(name)),
  );
  const availablePolicies = new Map(
    [...responsePolicies].filter(([name]) => !shadowedNames.has(name)),
  );

  if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
    return expressionDerivesFromHandler(
      node.body,
      availableHandlers,
      availablePolicies,
      new Set(),
    );
  }
  if (!node.body || !ts.isBlock(node.body)) return false;

  const returns = [];
  function visit(current, incomingNames) {
    if (current !== node.body && ts.isFunctionLike(current)) return;
    if (ts.isBlock(current)) {
      const blockNames = new Set(incomingNames);
      for (const statement of current.statements) visit(statement, blockNames);
      return;
    }
    if (ts.isVariableStatement(current)) {
      const isConst = Boolean(
        current.declarationList.flags & ts.NodeFlags.Const,
      );
      for (const declaration of current.declarationList.declarations) {
        const names = bindingIdentifiers(declaration.name);
        for (const name of names) incomingNames.delete(name);
        if (
          isConst &&
          ts.isIdentifier(declaration.name) &&
          expressionDerivesFromHandler(
            declaration.initializer,
            availableHandlers,
            availablePolicies,
            incomingNames,
          )
        ) {
          incomingNames.add(declaration.name.text);
        }
      }
      return;
    }
    if (ts.isReturnStatement(current)) {
      returns.push(
        expressionDerivesFromHandler(
          current.expression,
          availableHandlers,
          availablePolicies,
          incomingNames,
        ),
      );
      return;
    }
    if (ts.isIfStatement(current)) {
      visit(current.thenStatement, new Set(incomingNames));
      if (current.elseStatement) {
        visit(current.elseStatement, new Set(incomingNames));
      }
      return;
    }
    ts.forEachChild(current, (child) => visit(child, new Set(incomingNames)));
  }
  visit(node.body, new Set());
  return returns.length > 0 && returns.every(Boolean);
}

function exportedHttpMethods(source) {
  const exports = [];
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          if (HTTP_METHODS.has(declaration.name.text)) {
            exports.push({
              method: declaration.name.text,
              target: declaration.initializer ?? null,
            });
          }
        } else {
          for (const name of bindingIdentifiers(declaration.name)) {
            if (HTTP_METHODS.has(name)) {
              exports.push({ method: name, target: null });
            }
          }
        }
      }
    } else if (
      ts.isFunctionDeclaration(statement) &&
      hasExportModifier(statement) &&
      statement.name &&
      HTTP_METHODS.has(statement.name.text)
    ) {
      exports.push({ method: statement.name.text, target: statement });
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (!HTTP_METHODS.has(element.name.text)) continue;
        exports.push({
          method: element.name.text,
          target: statement.moduleSpecifier
            ? null
            : ts.factory.createIdentifier(
                element.propertyName?.text ?? element.name.text,
              ),
        });
      }
    }
  }
  return exports;
}

function routeExportIsBound(
  target,
  canonicalImport,
  bindings,
  handlerNames,
  responsePolicies,
  resolving = new Set(),
) {
  if (!target) return false;
  if (
    ts.isFunctionDeclaration(target) ||
    ts.isFunctionExpression(target) ||
    ts.isArrowFunction(target)
  ) {
    return functionReturnsHandlerResult(target, handlerNames, responsePolicies);
  }

  const expression = unwrapRouteExpression(target);
  if (!expression) return false;
  if (isCanonicalDefineRouteCall(expression, canonicalImport)) return true;
  if (ts.isFunctionExpression(expression) || ts.isArrowFunction(expression)) {
    return functionReturnsHandlerResult(
      expression,
      handlerNames,
      responsePolicies,
    );
  }
  if (ts.isIdentifier(expression)) {
    if (handlerNames.has(expression.text)) return true;
    if (resolving.has(expression.text)) return false;
    const binding = bindings.get(expression.text);
    if (!binding) return false;
    const next = new Set(resolving);
    next.add(expression.text);
    return routeExportIsBound(
      binding,
      canonicalImport,
      bindings,
      handlerNames,
      responsePolicies,
      next,
    );
  }
  return false;
}

function analyzeRouteShell(source) {
  const canonicalImport = importsCanonicalDefineRoute(source);
  const bindings = topLevelBindings(source);
  const handlerNames = canonicalHandlerNames(bindings, canonicalImport);
  const responsePolicies = trustedRouteResponsePolicyBindings(source);
  const exports = exportedHttpMethods(source);
  return {
    exports,
    unbound: exports.filter(
      (entry) =>
        !routeExportIsBound(
          entry.target,
          canonicalImport,
          bindings,
          handlerNames,
          responsePolicies,
        ),
    ),
  };
}

function checkCountCeilings(rule, observed, baseline) {
  const approved = new Map(
    baseline.approved.map((entry) => [entry.path, entry.max]),
  );
  for (const [file, count] of [...observed].sort(([left], [right]) =>
    comparePath(left, right),
  )) {
    const ceiling = approved.get(file);
    if (ceiling === undefined) {
      report(
        rule,
        `${file} has ${count} unapproved occurrence${count === 1 ? "" : "s"}`,
      );
    } else if (count > ceiling) {
      report(rule, `${file} grew from ceiling ${ceiling} to ${count}`);
    }
  }
  for (const entry of baseline.approved) {
    const count = observed.get(entry.path) ?? 0;
    if (count < entry.max)
      improvements.push(`${rule}: ${entry.path} ${entry.max} -> ${count}`);
  }
}

validateManifest();

const files = await walk("src");
const rawFetch = new Map();
const dbImports = new Map();
const asAny = new Map();
const routeExceptions = new Set();
const routeMethodExceptions = new Set();
const oversized = new Map();
const lineCounts = new Map();
const approvedRouteExceptions = new Map(
  ROUTE_SHELL_BASELINE.approved.map((entry) => [entry.path, entry]),
);
const approvedRouteMethodExceptions = new Set(
  ROUTE_METHOD_EXCEPTION_BASELINE.approved.map(
    (entry) => `${entry.path}:${entry.method}`,
  ),
);
let routeCount = 0;

for (const file of files) {
  const text = await readFile(path.join(ROOT, file), "utf8");
  const source = parseSource(file, text);

  if (file.startsWith("src/components/") || file.startsWith("src/stores/")) {
    const count = countMatches(text, /\bfetch\s*\(/gu);
    if (count > 0) rawFetch.set(file, count);
  }

  if (
    !file.startsWith("src/server/services/") &&
    !file.startsWith("src/lib/db/")
  ) {
    const count = countDbImports(source);
    if (count > 0) dbImports.set(file, count);
  }

  const asAnyCount = countMatches(text, /\bas\s+any\b/gu);
  if (asAnyCount > 0) asAny.set(file, asAnyCount);

  if (file.startsWith("src/app/api/") && file.endsWith("/route.ts")) {
    routeCount += 1;
    if (source.parseDiagnostics.length > 0) {
      report(
        "route-shell",
        `${file} has ${source.parseDiagnostics.length} syntax diagnostic${source.parseDiagnostics.length === 1 ? "" : "s"}; route binding cannot be proven`,
      );
    }
    const route = analyzeRouteShell(source);
    if (route.exports.length === 0) {
      report("route-shell", `${file} exports no supported HTTP method`);
    } else if (approvedRouteExceptions.has(file)) {
      const exception = approvedRouteExceptions.get(file);
      const observedMethods = [
        ...new Set(route.exports.map((entry) => entry.method)),
      ].sort(comparePath);
      if (
        route.exports.length !== observedMethods.length ||
        observedMethods.length !== exception.methods.length ||
        observedMethods.some(
          (method, index) => method !== exception.methods[index],
        )
      ) {
        report(
          "route-shell",
          `${file} ${exception.classification} exception method inventory drifted: expected ${exception.methods.join(", ")}; observed ${observedMethods.join(", ")}`,
        );
      }
      if (route.unbound.length > 0) routeExceptions.add(file);
    } else {
      for (const entry of route.unbound) {
        const key = `${file}:${entry.method}`;
        if (approvedRouteMethodExceptions.has(key)) {
          routeMethodExceptions.add(key);
        } else {
          report(
            "route-shell",
            `${file} ${entry.method} export is not structurally bound to a canonical defineRoute-derived handler`,
          );
        }
      }
    }
  }

  const lines = logicalLineCount(text);
  lineCounts.set(file, lines);
  if (lines > MAX_LINES) oversized.set(file, lines);
}

checkCountCeilings("raw-fetch", rawFetch, RAW_FETCH_BASELINE);
checkCountCeilings("db-placement", dbImports, DB_IMPORT_BASELINE);
checkCountCeilings("as-any", asAny, AS_ANY_BASELINE);

for (const entry of ROUTE_SHELL_BASELINE.approved) {
  if (!routeExceptions.has(entry.path)) {
    improvements.push(
      `route-shell: ${entry.path} no longer needs ${entry.classification} exception`,
    );
  }
}
for (const entry of ROUTE_METHOD_EXCEPTION_BASELINE.approved) {
  const key = `${entry.path}:${entry.method}`;
  if (!routeMethodExceptions.has(key)) {
    improvements.push(
      `route-shell: ${key} no longer needs ${entry.classification} exception`,
    );
  }
}

const approvedOversized = new Map(
  MAX_LINES_BASELINE.approved.map((entry) => [entry.path, entry.maxLines]),
);
for (const [file, lines] of [...oversized].sort(([left], [right]) =>
  comparePath(left, right),
)) {
  const ceiling = approvedOversized.get(file);
  if (ceiling === undefined) {
    report(
      "max-lines",
      `${file} has ${lines} lines (unapproved ceiling is ${MAX_LINES})`,
    );
  } else if (lines > ceiling) {
    report(
      "max-lines",
      `${file} grew from ceiling ${ceiling} to ${lines} lines`,
    );
  }
}
for (const entry of MAX_LINES_BASELINE.approved) {
  const lines = lineCounts.get(entry.path) ?? 0;
  if (lines < entry.maxLines)
    improvements.push(`max-lines: ${entry.path} ${entry.maxLines} -> ${lines}`);
}

const totals = {
  rawFetch: [...rawFetch.values()].reduce((sum, count) => sum + count, 0),
  dbImports: [...dbImports.values()].reduce((sum, count) => sum + count, 0),
  routeExceptions: routeExceptions.size,
  routeMethodExceptions: routeMethodExceptions.size,
  asAny: [...asAny.values()].reduce((sum, count) => sum + count, 0),
  oversized: oversized.size,
};

if (violations.length > 0) {
  console.error("Architecture guardrails FAILED:");
  for (const violation of violations.sort((left, right) => {
    return comparePath(
      `${left.rule}:${left.message}`,
      `${right.rule}:${right.message}`,
    );
  })) {
    console.error(`- [${violation.rule}] ${violation.message}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    "Architecture guardrails OK: " +
      `raw-fetch ${totals.rawFetch}/${RAW_FETCH_BASELINE.expectedOccurrences}; ` +
      `DB exceptions ${totals.dbImports}/${DB_IMPORT_BASELINE.expectedOccurrences}; ` +
      `route exceptions ${totals.routeExceptions}/${ROUTE_SHELL_BASELINE.expectedExceptions} ` +
      `and method exceptions ${totals.routeMethodExceptions}/${ROUTE_METHOD_EXCEPTION_BASELINE.expectedExceptions} ` +
      `across ${routeCount} routes; ` +
      `as-any ${totals.asAny}/${AS_ANY_BASELINE.expectedOccurrences}; ` +
      `oversized ${totals.oversized}/${MAX_LINES_BASELINE.expectedFiles} (>${MAX_LINES}).`,
  );
  if (improvements.length > 0) {
    console.log(
      "Baseline improvements available (safe to lower these ceilings):",
    );
    for (const improvement of improvements.sort(comparePath))
      console.log(`- ${improvement}`);
  }
}
