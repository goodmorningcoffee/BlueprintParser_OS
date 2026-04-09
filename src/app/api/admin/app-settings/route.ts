import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

// GET — read all app settings (admin)
export async function GET() {
  const { error } = await requireAdmin();
  if (error) return error;

  const rows = await db.select().from(appSettings);
  const settings: Record<string, unknown> = {};
  for (const r of rows) settings[r.key] = r.value;
  return NextResponse.json(settings);
}

// PUT — update an app setting (root admin only)
export async function PUT(req: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  if (!session.user.isRootAdmin) {
    return NextResponse.json({ error: "Root admin required" }, { status: 403 });
  }

  const { key, value } = await req.json();
  if (!key || value === undefined) {
    return NextResponse.json({ error: "key and value required" }, { status: 400 });
  }

  // Normalize URLs in header_links to always include protocol
  if (key === "header_links" && typeof value === "object" && value !== null) {
    for (const k of Object.keys(value)) {
      if (typeof value[k] === "string" && value[k] && !/^https?:\/\//i.test(value[k])) {
        value[k] = `https://${value[k]}`;
      }
    }
  }

  const [existing] = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
  if (existing) {
    await db.update(appSettings)
      .set({ value, updatedBy: session.user.dbId, updatedAt: new Date() })
      .where(eq(appSettings.key, key));
  } else {
    await db.insert(appSettings).values({ key, value, updatedBy: session.user.dbId });
  }

  return NextResponse.json({ success: true });
}
