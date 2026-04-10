/**
 * GET /api/projects/[id]/thumbnail/[page]
 *
 * Serves page thumbnail images proxied through the server.
 * Avoids requiring public S3 bucket access from the browser.
 * Includes aggressive caching (1h browser, 24h stale-while-revalidate).
 */

import { resolveProjectAccess } from "@/lib/api-utils";
import { downloadFromS3 } from "@/lib/s3";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; page: string }> }
) {
  const { id, page } = await params;
  const pageNum = parseInt(page, 10);
  if (isNaN(pageNum) || pageNum < 1) {
    return new NextResponse("Invalid page number", { status: 400 });
  }

  const access = await resolveProjectAccess({ publicId: id }, { allowDemo: true });
  if (access.error) return access.error;
  const { project } = access;

  if (!project.dataUrl) {
    return new NextResponse("Not found", { status: 404 });
  }

  const s3Key = `${project.dataUrl}/thumbnails/page_${String(pageNum).padStart(4, "0")}.png`;

  try {
    const buffer = await downloadFromS3(s3Key);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      },
    });
  } catch {
    return new NextResponse("Thumbnail not found", { status: 404 });
  }
}
