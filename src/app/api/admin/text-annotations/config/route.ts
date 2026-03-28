import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { companies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getAllDetectorMeta } from "@/lib/detectors/registry";

export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const detectors = getAllDetectorMeta();

  const [company] = await db
    .select({ pipelineConfig: companies.pipelineConfig })
    .from(companies)
    .where(eq(companies.id, session.user.companyId))
    .limit(1);

  let enabled: string[];
  if (company?.pipelineConfig?.textAnnotation?.enabledDetectors) {
    enabled = company.pipelineConfig.textAnnotation.enabledDetectors;
  } else {
    // Default: all detectors where defaultEnabled is true
    enabled = detectors.filter((d) => d.defaultEnabled).map((d) => d.id);
  }

  return NextResponse.json({ detectors, enabled });
}

export async function PUT(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const body = await req.json();
  const { enabledDetectors } = body;

  if (!Array.isArray(enabledDetectors)) {
    return NextResponse.json(
      { error: "enabledDetectors must be an array" },
      { status: 400 }
    );
  }

  // Validate all IDs are known detectors
  const allMeta = getAllDetectorMeta();
  const validIds = new Set(allMeta.map((d) => d.id));
  const invalid = enabledDetectors.filter((id: string) => !validIds.has(id));
  if (invalid.length > 0) {
    return NextResponse.json(
      { error: `Unknown detector IDs: ${invalid.join(", ")}` },
      { status: 400 }
    );
  }

  // Load existing config and merge
  const [company] = await db
    .select({ pipelineConfig: companies.pipelineConfig })
    .from(companies)
    .where(eq(companies.id, session.user.companyId))
    .limit(1);

  const existing = company?.pipelineConfig || {};
  const updated = {
    ...existing,
    textAnnotation: { enabledDetectors },
  };

  await db
    .update(companies)
    .set({ pipelineConfig: updated, updatedAt: new Date() })
    .where(eq(companies.id, session.user.companyId));

  return NextResponse.json({ success: true, enabledDetectors });
}
