import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

function ensureProtocol(url: string): string {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url}`;
}

// Public GET — returns header link config for the demo page
export async function GET() {
  const defaults = {
    home: "https://blueprintparser.com",
    hded: "https://hded.blueprintparser.com",
    modelExchange: "https://models.blueprintparser.com",
    planExchange: "https://planexchange.blueprintparser.com",
    labelFleet: "https://www.labelfleet.xyz",
  };

  try {
    const [row] = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, "header_links"))
      .limit(1);
    const links = row ? { ...defaults, ...(row.value as Record<string, string>) } : defaults;
    const sanitized = Object.fromEntries(
      Object.entries(links).map(([k, v]) => [k, ensureProtocol(v)])
    );
    return NextResponse.json({ headerLinks: sanitized });
  } catch {
    return NextResponse.json({ headerLinks: defaults });
  }
}
