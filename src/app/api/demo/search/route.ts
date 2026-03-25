import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

/**
 * Cross-project full-text search for demo projects (public, no auth).
 * GET /api/demo/search?q=<term>
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const query = url.searchParams.get("q")?.trim();

  if (!query || query.length < 2 || query.length > 200) {
    return NextResponse.json({ error: "q must be 2-200 chars" }, { status: 400 });
  }

  const searchResults = await db.execute(sql`
    SELECT
      p.public_id AS project_id,
      p.name AS project_name,
      COUNT(DISTINCT pg.id)::int AS page_count,
      COUNT(pg.id)::int AS match_count
    FROM pages pg
    JOIN projects p ON pg.project_id = p.id
    WHERE p.is_demo = true
      AND p.status = 'completed'
      AND pg.search_vector @@ plainto_tsquery('english', ${query})
    GROUP BY p.id, p.public_id, p.name
    ORDER BY match_count DESC
  `);

  return NextResponse.json({
    query,
    results: searchResults.rows.map((row: any) => ({
      projectId: row.project_id,
      projectName: row.project_name,
      matchCount: row.match_count,
      pageCount: row.page_count,
    })),
  });
}
