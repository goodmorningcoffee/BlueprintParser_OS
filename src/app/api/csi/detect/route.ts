import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { detectCsiCodes, detectCsiFromGrid } from "@/lib/csi-detect";
import { logger } from "@/lib/logger";

/**
 * POST /api/csi/detect
 *
 * Client-callable CSI detection endpoint.
 * Accepts either raw text or a parsed grid (headers + rows).
 * Returns detected CSI codes.
 */
export async function POST(req: Request) {
  // No auth required — CSI detection is purely local text matching, no DB/AWS calls
  try {
    const body = await req.json();

    if (body.headers && body.rows) {
      // Grid mode: detect CSI from parsed table/keynote
      const csiTags = detectCsiFromGrid(
        body.headers as string[],
        body.rows as Record<string, string>[],
        body.config,
      );
      return NextResponse.json({
        csiTags: csiTags.map((c) => ({ code: c.code, description: c.description })),
      });
    }

    if (body.text && typeof body.text === "string") {
      // Text mode: detect CSI from raw text
      const csiTags = detectCsiCodes(body.text, body.config);
      return NextResponse.json({
        csiTags: csiTags.map((c) => ({ code: c.code, description: c.description })),
      });
    }

    return NextResponse.json(
      { error: "Provide either { text: string } or { headers: string[], rows: Record<string,string>[] }" },
      { status: 400 },
    );
  } catch (err) {
    logger.error("[csi/detect] Failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "CSI detection failed" },
      { status: 500 },
    );
  }
}
