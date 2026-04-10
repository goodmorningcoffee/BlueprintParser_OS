import { NextResponse } from "next/server";
import { resolveProjectAccess } from "@/lib/api-utils";
import { db } from "@/lib/db";
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
 * Full-text search across all pages in a project.
 * Uses PostgreSQL tsvector/tsquery with word-level bounding box matching.
 *
 * GET /api/search?projectId=<publicId>&q=<term>
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const projectPublicId = url.searchParams.get("projectId");
  const query = url.searchParams.get("q")?.trim();

  if (!projectPublicId || !query || query.length < 2) {
    return NextResponse.json(
      { error: "projectId and q (min 2 chars) required" },
      { status: 400 }
    );
  }

  const access = await resolveProjectAccess({ publicId: projectPublicId });
  if (access.error) return access.error;
  const { project } = access;

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
            if (!stemMatch(words[i + j].text, queryTerms[j])) {
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
          if (queryTerms.some((term) => stemMatch(word.text, term))) {
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

/**
 * Stem-aware word matching. Handles PostgreSQL tsvector stemming mismatch:
 * e.g. search "doors" → PG stems to "door" and finds pages, but the Textract
 * word is "DOOR". Exact regex \bdoors\b won't match "DOOR".
 *
 * Fix: check if either word is a prefix of the other (after stripping
 * non-alphanumeric chars). Handles door/doors/doorway, install/installed, etc.
 */
function stemMatch(wordText: string, term: string): boolean {
  const w = wordText.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (w.length === 0) return false;
  // Short words (1-2 chars) require exact match to avoid false positives
  if (w.length <= 2 || term.length <= 2) return w === term;
  return w.startsWith(term) || term.startsWith(w);
}
