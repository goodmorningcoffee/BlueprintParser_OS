// [2026-10-21 owner ask] The SageMaker instance type for YOLO processing jobs. Stored in the existing
// app_settings table under YOLO_INSTANCE_SETTING_KEY as { instanceType } — no schema change.
//
//   GET  /api/admin/yolo-instance → { instanceType, valid, defaultInstanceType, options }  (auth:"root")
//   PUT  /api/admin/yolo-instance   { instanceType } — must be on the code allowlist     (auth:"root")
//        The write and its audit_log row commit in one transaction.
//
// readYoloInstanceType() is the RUN-PATH reader (startYoloJob): it never throws — a missing row,
// an off-allowlist value or a failed read all resolve to the default, and the anomaly is logged.
// The generic /api/admin/app-settings route refuses this key, so every write passes the allowlist.

import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { appSettings, auditLog } from "@/lib/db/schema";
import type { AuthSession } from "@/lib/api-utils";
import { ApiError } from "@/server/api/envelope";
import { logger } from "@/lib/logger";
import {
  DEFAULT_YOLO_INSTANCE_TYPE,
  YOLO_INSTANCE_OPTIONS,
  YOLO_INSTANCE_SETTING_KEY,
  isYoloInstanceType,
  resolveYoloInstanceSetting,
  type YoloInstanceOption,
} from "@/lib/yolo-instances";

export const YOLO_INSTANCE_AUDIT_ACTION = "yolo_instance_type_changed";

export const zYoloInstancePut = z
  .object({
    instanceType: z.string().max(64).refine(isYoloInstanceType, {
      message: "instanceType is not a YOLO-compatible SageMaker processing instance type",
    }),
  })
  .strict();
export type YoloInstancePutBody = z.infer<typeof zYoloInstancePut>;

async function storedValue(): Promise<unknown> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, YOLO_INSTANCE_SETTING_KEY))
    .limit(1);
  return row?.value;
}

/** Run-path reader. Never throws; unknown/missing → DEFAULT_YOLO_INSTANCE_TYPE (+ log when unknown). */
export async function readYoloInstanceType(): Promise<string> {
  try {
    const value = await storedValue();
    const resolved = resolveYoloInstanceSetting(value);
    if (!resolved.valid && value !== undefined) {
      logger.warn("[yolo] app_settings holds an unknown YOLO instance type; using the default", {
        key: YOLO_INSTANCE_SETTING_KEY,
        stored: typeof resolved.raw === "string" ? resolved.raw.slice(0, 64) : typeof resolved.raw,
        fallback: DEFAULT_YOLO_INSTANCE_TYPE,
      });
    }
    return resolved.instanceType;
  } catch (err) {
    logger.error(`[yolo] reading ${YOLO_INSTANCE_SETTING_KEY} failed; using ${DEFAULT_YOLO_INSTANCE_TYPE}`, { error: err });
    return DEFAULT_YOLO_INSTANCE_TYPE;
  }
}

export async function getYoloInstanceSetting(): Promise<{
  instanceType: string;
  valid: boolean;
  defaultInstanceType: string;
  options: readonly YoloInstanceOption[];
}> {
  const resolved = resolveYoloInstanceSetting(await storedValue());
  return {
    instanceType: resolved.instanceType,
    valid: resolved.valid,
    defaultInstanceType: DEFAULT_YOLO_INSTANCE_TYPE,
    options: YOLO_INSTANCE_OPTIONS,
  };
}

export async function putYoloInstanceType(
  body: YoloInstancePutBody,
  session: AuthSession,
): Promise<{ success: true; instanceType: string }> {
  // The route is auth:"root"; this is the in-service belt so no other caller can reach a write.
  if (!session.user.isRootAdmin) throw new ApiError("FORBIDDEN", "Root admin required");
  if (!isYoloInstanceType(body.instanceType)) {
    throw new ApiError("VALIDATION", "instanceType is not a YOLO-compatible SageMaker processing instance type");
  }
  const instanceType = body.instanceType;

  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, YOLO_INSTANCE_SETTING_KEY))
      .for("update");
    const before = row ? resolveYoloInstanceSetting(row.value).raw ?? null : null;
    await tx
      .insert(appSettings)
      .values({ key: YOLO_INSTANCE_SETTING_KEY, value: { instanceType }, updatedBy: session.user.dbId })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: { instanceType }, updatedBy: session.user.dbId, updatedAt: new Date() },
      });
    await tx.insert(auditLog).values({
      action: YOLO_INSTANCE_AUDIT_ACTION,
      userId: session.user.dbId,
      companyId: session.user.companyId,
      details: { before, after: instanceType },
    });
  });

  return { success: true, instanceType };
}
