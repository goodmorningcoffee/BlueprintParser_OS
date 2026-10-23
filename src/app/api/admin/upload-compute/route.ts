/**
 * GET/PUT /api/admin/upload-compute  (ROOT ONLY — the Fargate size for upload processing)
 *
 * [2026-10-23] Thin shells — behavior lives in services/upload-compute.ts. auth:"root" on BOTH
 * methods: a company admin gets 403 and can neither read nor change the preset. PUT body is
 * strictly validated by zUploadComputePut (allowlisted presets only; unknown keys → 400).
 */

import { defineRoute } from "@/server/api/defineRoute";
import {
  getUploadComputeSetting,
  putUploadComputePreset,
  zUploadComputePut,
} from "@/server/services/upload-compute";

export const GET = defineRoute({
  auth: "root",
  handler: () => getUploadComputeSetting(),
});

export const PUT = defineRoute({
  auth: "root",
  body: zUploadComputePut,
  handler: ({ body, session }) => putUploadComputePreset(body, session!),
});
