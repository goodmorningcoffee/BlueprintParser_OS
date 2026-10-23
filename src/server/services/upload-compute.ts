// [2026-10-23 owner ask] The Fargate compute size for upload processing. Stored in the existing
// app_settings table under UPLOAD_COMPUTE_SETTING_KEY as { preset } — no schema change.
//
//   GET /api/admin/upload-compute → { preset, valid, defaultPreset, presets }        (auth:"root")
//   PUT /api/admin/upload-compute   { preset } — must be on the code allowlist      (auth:"root")
//       The write and its audit_log row commit in one transaction.
//
// readUploadComputePreset() is the RUN-PATH reader (createProject's StartExecution input): it never
// throws — a missing row, an off-allowlist value or a failed read all resolve to the default (8 vCPU ·
// 16 GB, today's task definition), and the anomaly is logged. The generic /api/admin/app-settings
// route refuses this key, so every write passes the allowlist.

import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { appSettings, auditLog } from "@/lib/db/schema";
import type { AuthSession } from "@/lib/api-utils";
import { ApiError } from "@/server/api/envelope";
import { logger } from "@/lib/logger";
import {
  DEFAULT_UPLOAD_COMPUTE_PRESET,
  UPLOAD_COMPUTE_PRESETS,
  UPLOAD_COMPUTE_SETTING_KEY,
  isUploadComputePreset,
  resolveUploadComputeSetting,
  type UploadComputePreset,
} from "@/lib/upload-compute";

export const UPLOAD_COMPUTE_AUDIT_ACTION = "upload_compute_preset_changed";

export const zUploadComputePut = z
  .object({
    preset: z.string().max(16).refine(isUploadComputePreset, {
      message: "preset is not an upload compute preset",
    }),
  })
  .strict();
export type UploadComputePutBody = z.infer<typeof zUploadComputePut>;

async function storedValue(): Promise<unknown> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, UPLOAD_COMPUTE_SETTING_KEY))
    .limit(1);
  return row?.value;
}

/** Run-path reader. Never throws; unknown/missing/failed read → the default preset (+ log when anomalous). */
export async function readUploadComputePreset(): Promise<UploadComputePreset> {
  try {
    const value = await storedValue();
    const resolved = resolveUploadComputeSetting(value);
    if (!resolved.valid && value !== undefined) {
      logger.warn("[upload-compute] app_settings holds an unknown preset; using the default", {
        key: UPLOAD_COMPUTE_SETTING_KEY,
        stored: typeof resolved.raw === "string" ? resolved.raw.slice(0, 16) : typeof resolved.raw,
        fallback: DEFAULT_UPLOAD_COMPUTE_PRESET,
      });
    }
    return resolved.preset;
  } catch (err) {
    logger.error(`[upload-compute] reading ${UPLOAD_COMPUTE_SETTING_KEY} failed; using ${DEFAULT_UPLOAD_COMPUTE_PRESET}`, { error: err });
    return resolveUploadComputeSetting(undefined).preset;
  }
}

export async function getUploadComputeSetting(): Promise<{
  preset: string;
  valid: boolean;
  defaultPreset: string;
  presets: readonly UploadComputePreset[];
}> {
  const resolved = resolveUploadComputeSetting(await storedValue());
  return {
    preset: resolved.preset.id,
    valid: resolved.valid,
    defaultPreset: DEFAULT_UPLOAD_COMPUTE_PRESET,
    presets: UPLOAD_COMPUTE_PRESETS,
  };
}

export async function putUploadComputePreset(
  body: UploadComputePutBody,
  session: AuthSession,
): Promise<{ success: true; preset: string }> {
  // The route is auth:"root"; this is the in-service belt so no other caller can reach a write.
  if (!session.user.isRootAdmin) throw new ApiError("FORBIDDEN", "Root admin required");
  if (!isUploadComputePreset(body.preset)) {
    throw new ApiError("VALIDATION", "preset is not an upload compute preset");
  }
  const preset = body.preset;

  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, UPLOAD_COMPUTE_SETTING_KEY))
      .for("update");
    const before = row ? resolveUploadComputeSetting(row.value).raw ?? null : null;
    await tx
      .insert(appSettings)
      .values({ key: UPLOAD_COMPUTE_SETTING_KEY, value: { preset }, updatedBy: session.user.dbId })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: { preset }, updatedBy: session.user.dbId, updatedAt: new Date() },
      });
    await tx.insert(auditLog).values({
      action: UPLOAD_COMPUTE_AUDIT_ACTION,
      userId: session.user.dbId,
      companyId: session.user.companyId,
      details: { before, after: preset },
    });
  });

  return { success: true, preset };
}
