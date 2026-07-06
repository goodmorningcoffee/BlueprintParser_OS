// [refactor jul6 S047] admin/app-settings SOLO — GET all settings (bare {key:value} map) +
// PUT upsert one, folded from the legacy route (git show bd9b292:src/app/api/admin/
// app-settings/route.ts). Char: __tests__/admin-app-settings.route.test.ts (AS-*). Both
// methods requireAdmin (the shell provides auth:"admin"). ⚠️ PUT keeps a SECONDARY in-service
// isRootAdmin gate — do NOT bump the shell to auth:"root" (that would break GET's
// admin-readable path). Sanctioned diffs:
//   • A — flat auth errors → envelope; the in-service 403 "Root admin required" + the 400
//     "key and value required" stay byte-verbatim as ApiError.
//   • E — legacy PUT `await req.json()` subsumed by the shell raw-parse ("Invalid JSON body").
//   • NO B — no catch-500 literal; unexpected db errors → shell generic INTERNAL 500.
// PRESERVED byte-exact: the GET row→{key:value}-map collapse; the header_links URL-normalize;
// the value WHOLE-REPLACE upsert (correct k-v semantics) with updatedBy=session.user.dbId.

import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { AuthSession } from "@/lib/api-utils";
import { ApiError } from "@/server/api/envelope";

export async function getAppSettings(): Promise<unknown> {
  const rows = await db.select().from(appSettings);
  const settings: Record<string, unknown> = {};
  for (const r of rows) settings[r.key] = r.value;
  return settings;
}

export async function putAppSetting(rawBody: Record<string, unknown>, session: AuthSession): Promise<unknown> {
  // Secondary root gate (on top of the shell's requireAdmin) — root admins only.
  if (!session.user.isRootAdmin) {
    throw new ApiError("FORBIDDEN", "Root admin required");
  }

  const { key, value } = rawBody as { key?: string; value?: unknown };
  if (!key || value === undefined) {
    throw new ApiError("VALIDATION", "key and value required");
  }

  // Normalize URLs in header_links to always include protocol
  if (key === "header_links" && typeof value === "object" && value !== null) {
    const v = value as Record<string, unknown>;
    for (const k of Object.keys(v)) {
      if (typeof v[k] === "string" && v[k] && !/^https?:\/\//i.test(v[k] as string)) {
        v[k] = `https://${v[k]}`;
      }
    }
  }

  const [existing] = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
  if (existing) {
    await db.update(appSettings)
      .set({ value: value as Record<string, unknown>, updatedBy: session.user.dbId, updatedAt: new Date() })
      .where(eq(appSettings.key, key));
  } else {
    await db.insert(appSettings).values({ key, value: value as Record<string, unknown>, updatedBy: session.user.dbId });
  }

  return { success: true };
}
