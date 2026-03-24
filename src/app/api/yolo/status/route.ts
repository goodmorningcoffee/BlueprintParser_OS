import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getYoloJobStatus } from "@/lib/yolo";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
