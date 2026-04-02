import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-utils";
import { getYoloJobStatus } from "@/lib/yolo";
import { logger } from "@/lib/logger";

export async function GET(req: Request) {
  const { session, error } = await requireAuth();
  if (error) return error;

  const url = new URL(req.url);
  const jobName = url.searchParams.get("jobName");

  if (!jobName) {
    return NextResponse.json({ error: "jobName required" }, { status: 400 });
  }

  try {
    const status = await getYoloJobStatus(jobName);
    return NextResponse.json(status);
  } catch (err) {
    logger.error("YOLO status check failed:", err);
    return NextResponse.json(
      { error: "Failed to check status" },
      { status: 500 }
    );
  }
}
