/**
 * Root-only reader / writer of the parse-engine flags (table pipeline PLAN §1.1 row 13, §2.2; WP-3.E;
 * C1-D14). The run-path reader and the code defaults stay in `flags.ts` (WP-2.E).
 *
 *   GET /api/admin/parse-engine → { stored, effective, defaults, invalid }            (auth:"root")
 *   PUT /api/admin/parse-engine   { killSwitch, cropCache?, tools }                    (auth:"root")
 *
 * The stored document holds OVERRIDES only: a tool absent from `tools` (and an absent `cropCache`)
 * follows its code default, so a builder's default flip (WP-3.Q) reaches every tool nobody pinned.
 * The PUT replaces the whole document. It is strictly validated (unknown keys, an unknown tool or an
 * unknown mode → 400), written with its audit_log row in one transaction, and is the ONLY writer of
 * `app_settings.parseEngine`: the generic /api/admin/app-settings route refuses the key.
 */

import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { appSettings, auditLog } from "@/lib/db/schema";
import type { AuthSession } from "@/lib/api-utils";
import { ApiError } from "@/server/api/envelope";
import { PARSE_ENGINE_TOOL_IDS, type ParseEngineFlags, type ParseEngineMode, type ParseEngineToolId } from "@/lib/parse-engine/types";
import { PARSE_ENGINE_FLAG_DEFAULTS, PARSE_ENGINE_SETTING_KEY, resolveParseEngineFlags } from "./flags";

export const PARSE_ENGINE_FLAGS_AUDIT_ACTION = "parse_engine_flags_changed";

const zMode = z.enum(["legacy", "engine"]);
const zTools = z.strictObject(
  Object.fromEntries(PARSE_ENGINE_TOOL_IDS.map((id) => [id, zMode.optional()])) as Record<ParseEngineToolId, z.ZodOptional<typeof zMode>>,
);

export const zParseEngineFlagsPut = z.strictObject({
  killSwitch: z.boolean(),
  cropCache: z.boolean().optional(),
  tools: zTools,
});
export type ParseEngineFlagsPut = z.infer<typeof zParseEngineFlagsPut>;

export interface ParseEngineFlagsAdminView {
  /** The stored document as written (null when there is none). */
  stored: unknown;
  /** What callers act on: code defaults ⊕ stored ⊕ kill switch. */
  effective: ParseEngineFlags;
  defaults: ParseEngineFlags;
  /** Stored fields that are ignored (unknown or malformed). */
  invalid: string[];
}

async function storedValue(): Promise<unknown> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, PARSE_ENGINE_SETTING_KEY))
    .limit(1);
  return row?.value ?? null;
}

const defaultsView = (): ParseEngineFlags => ({
  killSwitch: PARSE_ENGINE_FLAG_DEFAULTS.killSwitch,
  tools: { ...PARSE_ENGINE_FLAG_DEFAULTS.tools },
  cropCache: PARSE_ENGINE_FLAG_DEFAULTS.cropCache,
});

export async function getParseEngineFlagsAdmin(): Promise<ParseEngineFlagsAdminView> {
  const stored = await storedValue();
  const { flags, invalid } = resolveParseEngineFlags(stored ?? undefined);
  return { stored, effective: flags, defaults: defaultsView(), invalid };
}

/** The document to store: only the fields the body sets (tools in PARSE_ENGINE_TOOL_IDS order). */
function documentOf(body: ParseEngineFlagsPut): Record<string, unknown> {
  const tools: Partial<Record<ParseEngineToolId, ParseEngineMode>> = {};
  for (const id of PARSE_ENGINE_TOOL_IDS) {
    const mode = body.tools[id];
    if (mode !== undefined) tools[id] = mode;
  }
  return { killSwitch: body.killSwitch, ...(body.cropCache !== undefined ? { cropCache: body.cropCache } : {}), tools };
}

export async function putParseEngineFlags(body: ParseEngineFlagsPut, session: AuthSession): Promise<ParseEngineFlagsAdminView> {
  // The route is auth:"root"; this is the in-service belt so no other caller can reach a write.
  if (!session.user.isRootAdmin) throw new ApiError("FORBIDDEN", "Root admin required");
  const value = documentOf(body);
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, PARSE_ENGINE_SETTING_KEY))
      .for("update");
    await tx
      .insert(appSettings)
      .values({ key: PARSE_ENGINE_SETTING_KEY, value, updatedBy: session.user.dbId })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value, updatedBy: session.user.dbId, updatedAt: new Date() },
      });
    await tx.insert(auditLog).values({
      action: PARSE_ENGINE_FLAGS_AUDIT_ACTION,
      userId: session.user.dbId,
      companyId: session.user.companyId,
      details: { before: row?.value ?? null, after: value },
    });
  });
  const { flags, invalid } = resolveParseEngineFlags(value);
  return { stored: value, effective: flags, defaults: defaultsView(), invalid };
}
