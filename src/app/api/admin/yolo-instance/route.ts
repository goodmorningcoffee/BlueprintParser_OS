/**
 * GET/PUT /api/admin/yolo-instance  (ROOT ONLY — the SageMaker instance type for YOLO jobs)
 *
 * [2026-10-21] Thin shells — behavior lives in services/yolo-instance.ts. auth:"root" on BOTH
 * methods: a company admin gets 403 and can neither read nor change the instance. PUT body is
 * strictly validated by zYoloInstancePut (allowlisted instance types only; unknown keys → 400).
 */

import { defineRoute } from "@/server/api/defineRoute";
import {
  getYoloInstanceSetting,
  putYoloInstanceType,
  zYoloInstancePut,
} from "@/server/services/yolo-instance";

export const GET = defineRoute({
  auth: "root",
  handler: () => getYoloInstanceSetting(),
});

export const PUT = defineRoute({
  auth: "root",
  body: zYoloInstancePut,
  handler: ({ body, session }) => putYoloInstanceType(body, session!),
});
