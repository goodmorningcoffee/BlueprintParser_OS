// [refactor jul6 S032] CSI pair route contracts (aggregate GET + detect POST), folded from
// the legacy fat routes (git show ade383e^:src/app/api/csi/{,detect/}route.ts).
// ⚠️ FOLD-ONLY: the CSI TAGGING REBUILD is a P2 sub-project ([[csi-rebuild-placement]],
// S012 locked; owner 2026-07-05: one P2 workstream with the pageIntelligence split + notes
// consolidation). Nothing here redesigns — byte-faithful shell migration only.
// ENGINE BYTE-UNTOUCHED: @/lib/csi-detect. Char: __tests__/csi.route.test.ts (CQ-1..CQ-3).
//   • CQ-1 aggregate: company-scoped completed-only jsonb explode, GROUP BY code fields,
//     ORDER BY page_count DESC LIMIT 200; bare-array response; projectSheetCounts = the
//     per-project fanout of the non-DISTINCT ARRAY_AGG.
//   • CQ-2 detect PUBLIC (deliberate — pure local matching, the docs' "public entry");
//     legacy's dead `auth` import dropped. Grid (headers && rows) WINS over text; text
//     needs typeof string; both modes map to 2-key {code,description}; config passthrough
//     (detectCsiCodes keeps its pinned `undefined` middle arg).
//   • Sanctioned diff B: the leaky catch-all ("CSI detection failed" fallback + err.message)
//     RETIRED — engine throws propagate to the shell's generic INTERNAL 500. Diff E: body
//     parse to the shell (legacy req.json-inside-try leaked SyntaxError messages at 500).

import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { detectCsiCodes, detectCsiFromGrid } from "@/lib/csi-detect";
import type { AuthSession } from "@/lib/api-utils";
import { ApiError } from "@/server/api/envelope";

// ── GET /api/csi ──────────────────────────────────────────────────────────────
export async function csiAggregate(session: AuthSession): Promise<unknown> {
  const results = await db.execute(sql`
    SELECT
      code->>'code' AS code,
      code->>'description' AS description,
      code->>'trade' AS trade,
      code->>'division' AS division,
      COUNT(DISTINCT p.id)::int AS project_count,
      COUNT(*)::int AS page_count,
      ARRAY_AGG(DISTINCT p.public_id) AS project_ids,
      ARRAY_AGG(p.public_id) AS project_ids_all
    FROM projects p
    JOIN pages pg ON pg.project_id = p.id,
    jsonb_array_elements(pg.csi_codes) AS code
    WHERE p.company_id = ${session.user.companyId}
      AND p.status = 'completed'
      AND pg.csi_codes IS NOT NULL
    GROUP BY code->>'code', code->>'description', code->>'trade', code->>'division'
    ORDER BY page_count DESC
    LIMIT 200
  `);

  return results.rows.map((row: any) => {
    const sheetCounts: Record<string, number> = {};
    for (const pid of (row.project_ids_all || [])) {
      sheetCounts[pid] = (sheetCounts[pid] || 0) + 1;
    }
    return {
      code: row.code,
      description: row.description,
      trade: row.trade,
      division: row.division,
      projectCount: row.project_count,
      pageCount: row.page_count,
      projectIds: row.project_ids || [],
      projectSheetCounts: sheetCounts,
    };
  });
}

// ── POST /api/csi/detect ─────────────────────────────────────────────────────
export async function csiDetect(body: Record<string, unknown>): Promise<unknown> {
  if (body.headers && body.rows) {
    // Grid mode: detect CSI from parsed table/keynote (WINS over text — CQ-2)
    const csiTags = detectCsiFromGrid(
      body.headers as string[],
      body.rows as Record<string, string>[],
      body.config as never,
    );
    return {
      csiTags: csiTags.map((c) => ({ code: c.code, description: c.description })),
    };
  }

  if (body.text && typeof body.text === "string") {
    // Text mode: detect CSI from raw text
    const csiTags = detectCsiCodes(body.text, undefined, body.config as never);
    return {
      csiTags: csiTags.map((c) => ({ code: c.code, description: c.description })),
    };
  }

  throw new ApiError(
    "VALIDATION",
    "Provide either { text: string } or { headers: string[], rows: Record<string,string>[] }",
  );
}
