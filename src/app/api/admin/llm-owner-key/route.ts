/**
 * GET/PUT /api/admin/llm-owner-key  (ROOT ONLY, verified 2FA)
 *
 * [2026-10-25 root hardening] Which companies may run chat on the OWNER's environment LLM keys
 * (lib/llm/owner-key-grant.ts). PUT { companyId, granted } — strictly validated, audited; the
 * service re-checks through requireVerifiedRoot. Thin shell over services/llm-owner-key.ts.
 */

import { defineRoute } from "@/server/api/defineRoute";
import { getLlmOwnerKeyGrants, putLlmOwnerKeyGrant, zLlmOwnerKeyPut } from "@/server/services/llm-owner-key";

export const GET = defineRoute({
  auth: "root",
  handler: ({ session }) => getLlmOwnerKeyGrants(session!),
});

export const PUT = defineRoute({
  auth: "root",
  body: zLlmOwnerKeyPut,
  handler: ({ body, session }) => putLlmOwnerKeyGrant(session!, body),
});
