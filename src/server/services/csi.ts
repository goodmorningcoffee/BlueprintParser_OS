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

import { auth } from "@/lib/auth";
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
// This route is PUBLIC and the matcher is synchronous: every database entry is compared against
// every input word, so cost is linear in input size (measured with the real database: 50,000
// characters ≈ 1 s of event-loop block, 1 MB ≈ 18 s — long enough to fail the ALB health check).
// An anonymous caller gets a small bound (measured ≈0.4–0.6 s at 20,000 with its 20/min rule, so
// one address cannot hold the loop for most of a minute). A signed-in caller gets room for a large
// schedule, because the viewer treats a refusal here as "no CSI tags" and saves without them.
export const CSI_DETECT_MAX_CHARS = 20_000;
export const CSI_DETECT_MAX_CHARS_SIGNED_IN = 250_000;

const NEITHER_MODE =
  "Provide either { text: string } or { headers: string[], rows: Record<string,string>[] }";

/** Characters the matcher will actually process, or null when the grid is not the documented shape. */
function gridChars(headers: unknown, rows: unknown): number | null {
  // A string passes a truthiness check and then SPREADS to characters in the matcher, uncounted.
  if (!Array.isArray(headers) || !Array.isArray(rows)) return null;
  let total = 0;
  for (const header of headers) {
    if (typeof header !== "string") return null;
    total += header.length;
  }
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    for (const value of Object.values(row)) {
      if (value == null || value === "") continue;
      if (typeof value !== "string") return null;
      total += value.length;
    }
  }
  return total;
}

async function assertWithinCap(chars: number): Promise<void> {
  if (chars <= CSI_DETECT_MAX_CHARS) return;
  const session = chars <= CSI_DETECT_MAX_CHARS_SIGNED_IN ? await auth() : null;
  if (!session?.user) {
    throw new ApiError("VALIDATION", `Input too large (max ${CSI_DETECT_MAX_CHARS} characters)`);
  }
}

// `body.config` is deliberately NOT forwarded. No client sends it, and on a public route it is a
// lever: `{"matchingConfidenceThreshold":-1}` returns all 8,951 codes (0.6 MB) for a 66-byte request.
export async function csiDetect(body: Record<string, unknown>): Promise<unknown> {
  if (body.headers && body.rows) {
    const chars = gridChars(body.headers, body.rows);
    if (chars === null) throw new ApiError("VALIDATION", NEITHER_MODE);
    await assertWithinCap(chars);
    // Grid mode: detect CSI from parsed table/keynote (WINS over text — CQ-2)
    const csiTags = detectCsiFromGrid(
      body.headers as string[],
      body.rows as Record<string, string>[],
    );
    return {
      csiTags: csiTags.map((c) => ({ code: c.code, description: c.description })),
    };
  }

  if (body.text && typeof body.text === "string") {
    await assertWithinCap(body.text.length);
    // Text mode: detect CSI from raw text
    const csiTags = detectCsiCodes(body.text);
    return {
      csiTags: csiTags.map((c) => ({ code: c.code, description: c.description })),
    };
  }

  throw new ApiError("VALIDATION", NEITHER_MODE);
}
