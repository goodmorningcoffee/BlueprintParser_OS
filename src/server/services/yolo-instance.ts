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
//
// [2026-10-22] Stage 2 + timeout (owner: "select any gpu that we have a quota for, with its price
// shown and estimated … ability to modify timeout time in the admin"):
//   GET  /api/admin/yolo-instance/options → current type + timeout, the LIVE-annotated allowlist
//        (quota, $/h — services/yolo-instance-catalog.ts) and past-run timing for the cost estimate.
//   PUT  /api/admin/yolo-runtime { maxRuntimeSeconds } — 900..86400, audited     (auth:"root")
// readYoloMaxRuntimeSeconds() is the run-path reader for MaxRuntimeInSeconds: never throws, default 3600.

import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { appSettings, auditLog } from "@/lib/db/schema";
import type { AuthSession } from "@/lib/api-utils";
import { ApiError } from "@/server/api/envelope";
import { logger } from "@/lib/logger";
import {
  DEFAULT_YOLO_INSTANCE_TYPE,
  DEFAULT_YOLO_MAX_RUNTIME_SECONDS,
  MAX_YOLO_MAX_RUNTIME_SECONDS,
  MIN_YOLO_MAX_RUNTIME_SECONDS,
  YOLO_INSTANCE_OPTIONS,
  YOLO_INSTANCE_SETTING_KEY,
  YOLO_MAX_RUNTIME_SETTING_KEY,
  isYoloInstanceType,
  isYoloMaxRuntimeSeconds,
  resolveYoloInstanceSetting,
  resolveYoloMaxRuntimeSetting,
  type YoloInstanceOption,
} from "@/lib/yolo-instances";
import { getYoloInstanceCatalog } from "@/server/services/yolo-instance-catalog";
import { getYoloRunStats } from "@/server/services/yolo-run-stats";
import type { YoloInstanceOptionsResponse } from "@/lib/yolo-cost";

export const YOLO_INSTANCE_AUDIT_ACTION = "yolo_instance_type_changed";

export const zYoloInstancePut = z
  .object({
    instanceType: z.string().max(64).refine(isYoloInstanceType, {
      message: "instanceType is not a YOLO-compatible SageMaker processing instance type",
    }),
  })
  .strict();
export type YoloInstancePutBody = z.infer<typeof zYoloInstancePut>;

export const YOLO_RUNTIME_AUDIT_ACTION = "yolo_max_runtime_changed";

export const zYoloRuntimePut = z
  .object({
    maxRuntimeSeconds: z.number().refine(isYoloMaxRuntimeSeconds, {
      message: `maxRuntimeSeconds must be a whole number of seconds between ${MIN_YOLO_MAX_RUNTIME_SECONDS} and ${MAX_YOLO_MAX_RUNTIME_SECONDS}`,
    }),
  })
  .strict();
export type YoloRuntimePutBody = z.infer<typeof zYoloRuntimePut>;

async function storedValue(key: string = YOLO_INSTANCE_SETTING_KEY): Promise<unknown> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .limit(1);
  return row?.value;
}

/** Run-path reader for MaxRuntimeInSeconds. Never throws; missing/out-of-range → 3600 (+ log when invalid). */
export async function readYoloMaxRuntimeSeconds(): Promise<number> {
  try {
    const value = await storedValue(YOLO_MAX_RUNTIME_SETTING_KEY);
    const resolved = resolveYoloMaxRuntimeSetting(value);
    if (!resolved.valid && value !== undefined) {
      logger.warn("[yolo] app_settings holds an invalid YOLO timeout; using the default", {
        key: YOLO_MAX_RUNTIME_SETTING_KEY,
        fallback: DEFAULT_YOLO_MAX_RUNTIME_SECONDS,
      });
    }
    return resolved.seconds;
  } catch (err) {
    logger.error(`[yolo] reading ${YOLO_MAX_RUNTIME_SETTING_KEY} failed; using ${DEFAULT_YOLO_MAX_RUNTIME_SECONDS}`, { error: err });
    return DEFAULT_YOLO_MAX_RUNTIME_SECONDS;
  }
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

export async function putYoloMaxRuntime(
  body: YoloRuntimePutBody,
  session: AuthSession,
): Promise<{ success: true; maxRuntimeSeconds: number }> {
  if (!session.user.isRootAdmin) throw new ApiError("FORBIDDEN", "Root admin required");
  if (!isYoloMaxRuntimeSeconds(body.maxRuntimeSeconds)) {
    throw new ApiError("VALIDATION", "maxRuntimeSeconds is out of range");
  }
  const seconds = body.maxRuntimeSeconds;
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, YOLO_MAX_RUNTIME_SETTING_KEY))
      .for("update");
    const before = row ? resolveYoloMaxRuntimeSetting(row.value).raw ?? null : null;
    await tx
      .insert(appSettings)
      .values({ key: YOLO_MAX_RUNTIME_SETTING_KEY, value: { seconds }, updatedBy: session.user.dbId })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: { seconds }, updatedBy: session.user.dbId, updatedAt: new Date() },
      });
    await tx.insert(auditLog).values({
      action: YOLO_RUNTIME_AUDIT_ACTION,
      userId: session.user.dbId,
      companyId: session.user.companyId,
      details: { before, after: seconds },
    });
  });
  return { success: true, maxRuntimeSeconds: seconds };
}

/** Root-only picker + cost-estimate payload. AWS/DB-history failures degrade inside their helpers. */
export async function getYoloInstanceOptions(url?: string): Promise<YoloInstanceOptionsResponse> {
  const refresh = url ? new URL(url).searchParams.get("refresh") === "1" : false;
  const [resolved, maxRuntimeSeconds, catalog, runStats] = await Promise.all([
    storedValue().then(resolveYoloInstanceSetting),
    readYoloMaxRuntimeSeconds(),
    getYoloInstanceCatalog({ refresh }),
    getYoloRunStats(),
  ]);
  return {
    instanceType: resolved.instanceType,
    valid: resolved.valid,
    defaultInstanceType: DEFAULT_YOLO_INSTANCE_TYPE,
    maxRuntimeSeconds,
    runtimeBounds: { min: MIN_YOLO_MAX_RUNTIME_SECONDS, max: MAX_YOLO_MAX_RUNTIME_SECONDS, default: DEFAULT_YOLO_MAX_RUNTIME_SECONDS },
    catalog,
    runStats,
  };
}
