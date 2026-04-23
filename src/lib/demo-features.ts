import { NextResponse } from "next/server";
import { db } from "./db";
import { companies } from "./db/schema";
import { eq } from "drizzle-orm";
import { apiError } from "./api-utils";

/**
 * Demo feature runtime kill-switches.
 *
 * The admin "Demo Features" panel at `src/app/admin/tabs/ProjectsTab.tsx`
 * writes per-feature booleans to `companies.pipelineConfig.demo.{key}` via
 * PUT `/api/admin/demo/config`. Expensive parser/chat/yolo routes call
 * `assertDemoFeatureEnabled` here so that an admin can disable any of these
 * features at launch time without a code deploy — a 403 lands immediately
 * for any anonymous-demo request, auth'd users are unaffected.
 *
 * Defaults mirror the `defaultOn` column in ProjectsTab's DEMO_FEATURES
 * array. If a new toggle is added there, add it to both this file's
 * `DemoFeatureKey` union and the `DEFAULT_ON` table below.
 */

export type DemoFeatureKey =
  | "autoQto"
  | "tableParse"
  | "keynoteParse"
  | "takeoff"
  | "symbolSearch"
  | "bucketFill"
  | "chat"
  | "yoloRun"
  | "labeling";

const DEFAULT_ON: Record<DemoFeatureKey, boolean> = {
  autoQto: true,
  tableParse: true,
  keynoteParse: true,
  takeoff: true,
  symbolSearch: true,
  bucketFill: true,
  chat: true,
  yoloRun: false,
  labeling: false,
};

const FEATURE_LABELS: Record<DemoFeatureKey, string> = {
  autoQto: "Auto-QTO",
  tableParse: "Table/Schedule Parse",
  keynoteParse: "Keynote Parse",
  takeoff: "Quantity Takeoff",
  symbolSearch: "Symbol Search",
  bucketFill: "Bucket Fill",
  chat: "LLM Chat",
  yoloRun: "YOLO Inference",
  labeling: "Labeling Wizard",
};

/**
 * Returns a 403 NextResponse if the feature is disabled for the given
 * company's demo config. Returns null if the feature is enabled.
 *
 * Callers use it right after `resolveProjectAccess`:
 *   const { project } = access;
 *   if (project.isDemo) {
 *     const gate = await assertDemoFeatureEnabled(project.companyId, "tableParse");
 *     if (gate) return gate;
 *   }
 */
export async function assertDemoFeatureEnabled(
  companyId: number,
  key: DemoFeatureKey,
): Promise<NextResponse | null> {
  const [row] = await db
    .select({ pipelineConfig: companies.pipelineConfig })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);

  const demo =
    (row?.pipelineConfig as { demo?: Record<string, boolean> } | null)?.demo ?? {};

  // Null/undefined means "not explicitly set" → fall through to defaultOn.
  const enabled = demo[key] ?? DEFAULT_ON[key];
  if (!enabled) {
    return apiError(
      `${FEATURE_LABELS[key]} is disabled for demo users. Sign in to use this feature.`,
      403,
    );
  }
  return null;
}
