/**
 * GET/PUT /api/admin/quota-overrides  (ROOT ONLY — per-user / per-company daily quota limits)
 *
 * [2026-10-21] Thin shells — behavior lives in services/quota-overrides.ts. auth:"root" on BOTH
 * methods: a company admin gets 403 and can neither read nor set overrides. PUT body is strictly
 * validated by zQuotaOverridePut (integers 0..1,000,000 or null; unknown keys → 400).
 */

import { defineRoute } from "@/server/api/defineRoute";
import {
  getQuotaOverrides,
  putQuotaOverride,
  zQuotaOverridePut,
} from "@/server/services/quota-overrides";

export const GET = defineRoute({
  auth: "root",
  handler: () => getQuotaOverrides(),
});

export const PUT = defineRoute({
  auth: "root",
  body: zQuotaOverridePut,
  handler: ({ body, session }) => putQuotaOverride(body, session!),
});
