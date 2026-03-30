import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-utils";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

interface GlobalSearchResult {
  projectId: string;
  projectName: string;
  matchCount: number;
  pageCount: number;
}

/**
 * Cross-project full-text search.
 * Searches OCR text across all pages for the user's company, grouped by project.
 *
 * GET /api/search/global?q=<term>
 */
export async function GET(req: Request) {
  const { session, error } = await requireAuth();
  if (error) return error;

  const url = new URL(req.url);
  const query = url.searchParams.get("q")?.trim();

  if (!query || query.length < 2) {
    return NextResponse.json(
      { error: "q (min 2 chars) required" },
      { status: 400 }
    );
  }

  const companyId = session.user.companyId;

  const searchResults = await db.execute(sql`
    SELECT
      p.public_id AS project_id,
      p.name AS project_name,
      COUNT(pg.id)::int AS page_count,
      SUM(
        array_length(
          regexp_split_to_array(
            lower(pg.raw_text),
            '\\s+'
          ),
          1
        )
      )::int AS total_words,
      COUNT(pg.id)::int AS match_count
    FROM pages pg
    JOIN projects p ON pg.project_id = p.id
    WHERE p.company_id = ${companyId}
      AND p.status = 'completed'
      AND pg.search_vector @@ plainto_tsquery('english', ${query})
    GROUP BY p.id, p.public_id, p.name
    ORDER BY match_count DESC
  `);

  const results: GlobalSearchResult[] = searchResults.rows.map((row: any) => ({
    projectId: row.project_id as string,
    projectName: row.project_name as string,
    matchCount: row.match_count as number,
    pageCount: row.page_count as number,
  }));

  return NextResponse.json({ query, results });
}
