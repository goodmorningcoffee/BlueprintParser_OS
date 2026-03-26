import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { TextractPageData } from "@/types";

interface SearchWordMatch {
  text: string;
  bbox: [number, number, number, number];
}

interface SearchResult {
  pageNumber: number;
  pageName: string;
  snippet: string;
  rank: number;
  matchCount: number;
  wordMatches: SearchWordMatch[];
}

/**
 * Full-text search for demo projects (public, no auth).
 *
 * With projectId: in-project search (same format as /api/search, with wordMatches)
 * Without projectId: cross-project search (project-level counts)
 *
 * GET /api/demo/search?projectId=<publicId>&q=<term>
 * GET /api/demo/search?q=<term>
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const projectPublicId = url.searchParams.get("projectId");
  const query = url.searchParams.get("q")?.trim();

  if (!query || query.length < 2 || query.length > 200) {
    return NextResponse.json({ error: "q must be 2-200 chars" }, { status: 400 });
  }

  // In-project search (with wordMatches for highlighting)
  if (projectPublicId) {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.publicId, projectPublicId), eq(projects.isDemo, true)))
      .limit(1);

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const phraseMatch = query.match(/^"(.+)"$/);
    const isExactPhrase = !!phraseMatch;
    const searchText = phraseMatch ? phraseMatch[1] : query;
    const queryTerms = searchText.toLowerCase().split(/\s+/).filter((t) => t.length > 0);

    const searchResults = await db.execute(
      isExactPhrase
        ? sql`
            SELECT page_number, name, textract_data,
              ts_headline('english', raw_text, phraseto_tsquery('english', ${searchText}),
                'MaxWords=20, MinWords=10, StartSel=<mark>, StopSel=</mark>') as snippet,
              ts_rank(search_vector, phraseto_tsquery('english', ${searchText})) as rank
            FROM pages
            WHERE project_id = ${project.id}
              AND search_vector @@ phraseto_tsquery('english', ${searchText})
            ORDER BY rank DESC
          `
        : sql`
            SELECT page_number, name, textract_data,
              ts_headline('english', raw_text, plainto_tsquery('english', ${searchText}),
                'MaxWords=20, MinWords=10, StartSel=<mark>, StopSel=</mark>') as snippet,
              ts_rank(search_vector, plainto_tsquery('english', ${searchText})) as rank
            FROM pages
            WHERE project_id = ${project.id}
              AND search_vector @@ plainto_tsquery('english', ${searchText})
            ORDER BY rank DESC
          `
    );

    const termRegexes = queryTerms.map(
      (term) => new RegExp(`\\b${escapeRegex(term)}\\b`, "i")
    );

    const results: SearchResult[] = searchResults.rows.map((row: any) => {
      const textractData = row.textract_data as TextractPageData | null;
      const wordMatches: SearchWordMatch[] = [];

      if (textractData?.words) {
        if (isExactPhrase && queryTerms.length > 1) {
          const words = textractData.words;
          for (let i = 0; i <= words.length - queryTerms.length; i++) {
            let allMatch = true;
            for (let j = 0; j < queryTerms.length; j++) {
              if (!termRegexes[j].test(words[i + j].text)) { allMatch = false; break; }
            }
            if (allMatch) {
              for (let j = 0; j < queryTerms.length; j++) {
                wordMatches.push({ text: words[i + j].text, bbox: words[i + j].bbox });
              }
            }
          }
        } else {
          for (const word of textractData.words) {
            if (termRegexes.some((regex) => regex.test(word.text))) {
              wordMatches.push({ text: word.text, bbox: word.bbox });
            }
          }
        }
      }

      return {
        pageNumber: row.page_number as number,
        pageName: (row.name as string) || `Page ${row.page_number}`,
        snippet: (row.snippet as string) || "",
        rank: row.rank as number,
        matchCount: wordMatches.length,
        wordMatches,
      };
    });

    return NextResponse.json({ query, results });
  }

  // Cross-project search (no projectId)
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

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
