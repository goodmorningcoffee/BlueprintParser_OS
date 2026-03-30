import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-utils";
import { getYoloJobStatus } from "@/lib/yolo";

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
    console.error("YOLO status check failed:", err);
    return NextResponse.json(
      { error: "Failed to check status" },
      { status: 500 }
    );
  }
}
