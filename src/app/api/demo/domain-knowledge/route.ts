/**
 * GET /api/demo/domain-knowledge
 *
 * Serves the built-in domain knowledge file for the demo admin panel.
 * No auth required — this is static reference content.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { NextResponse } from "next/server";

export async function GET() {
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
