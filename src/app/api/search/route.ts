import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { TextractPageData, TextractWord } from "@/types";

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
 * Full-text search across all pages in a project.
 * Uses PostgreSQL tsvector/tsquery with word-level bounding box matching.
 *
 * GET /api/search?projectId=<publicId>&q=<term>
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const projectPublicId = url.searchParams.get("projectId");
  const query = url.searchParams.get("q")?.trim();

  if (!projectPublicId || !query || query.length < 2) {
    return NextResponse.json(
      { error: "projectId and q (min 2 chars) required" },
      { status: 400 }
    );
  }

  // Verify project ownership
  const [project] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.publicId, projectPublicId),
        eq(projects.companyId, session.user.companyId)
      )
    )
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Detect exact phrase mode: user wraps query in double quotes
  // "door schedule" → exact phrase (phraseto_tsquery, consecutive highlight)
  // door schedule   → both words independently (plainto_tsquery, highlight each)
  const phraseMatch = query.match(/^"(.+)"$/);
  const isExactPhrase = !!phraseMatch;
  const searchText = phraseMatch ? phraseMatch[1] : query;

  const queryTerms = searchText
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  // plainto_tsquery: finds pages with ALL terms (AND), order doesn't matter
  // phraseto_tsquery: finds pages with terms adjacent and in order
  const searchResults = await db.execute(
    isExactPhrase
      ? sql`
          SELECT
            page_number,
            name,
            textract_data,
            ts_headline('english', raw_text, phraseto_tsquery('english', ${searchText}),
              'MaxWords=20, MinWords=10, StartSel=<mark>, StopSel=</mark>') as snippet,
            ts_rank(search_vector, phraseto_tsquery('english', ${searchText})) as rank
          FROM pages
          WHERE project_id = ${project.id}
            AND search_vector @@ phraseto_tsquery('english', ${searchText})
          ORDER BY rank DESC
        `
      : sql`
          SELECT
            page_number,
            name,
            textract_data,
            ts_headline('english', raw_text, plainto_tsquery('english', ${searchText}),
              'MaxWords=20, MinWords=10, StartSel=<mark>, StopSel=</mark>') as snippet,
            ts_rank(search_vector, plainto_tsquery('english', ${searchText})) as rank
          FROM pages
          WHERE project_id = ${project.id}
            AND search_vector @@ plainto_tsquery('english', ${searchText})
          ORDER BY rank DESC
        `
  );

  // Build word-boundary regexes for precise matching
  const termRegexes = queryTerms.map(
    (term) => new RegExp(`\\b${escapeRegex(term)}\\b`, "i")
  );

  const results: SearchResult[] = searchResults.rows.map((row: any) => {
    const textractData = row.textract_data as TextractPageData | null;
    const wordMatches: SearchWordMatch[] = [];

    if (textractData?.words) {
      if (isExactPhrase && queryTerms.length > 1) {
        // Exact phrase: find consecutive word sequences matching in order
        const words = textractData.words;
        for (let i = 0; i <= words.length - queryTerms.length; i++) {
          let allMatch = true;
          for (let j = 0; j < queryTerms.length; j++) {
            if (!termRegexes[j].test(words[i + j].text)) {
              allMatch = false;
              break;
            }
          }
          if (allMatch) {
            for (let j = 0; j < queryTerms.length; j++) {
              wordMatches.push({
                text: words[i + j].text,
                bbox: words[i + j].bbox,
              });
            }
          }
        }
      } else {
        // Default: highlight every word matching ANY query term independently
        for (const word of textractData.words) {
          if (termRegexes.some((regex) => regex.test(word.text))) {
            wordMatches.push({
              text: word.text,
              bbox: word.bbox,
            });
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

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
