/**
 * [2026-10-25 root hardening] Who may run chat on the OWNER's LLM keys (ANTHROPIC_API_KEY /
 * OPENAI_API_KEY / GROQ_API_KEY in the task environment). Before this, every company with no key
 * of its own silently fell through to those keys, and a company admin could pin any model to them
 * with POST /api/admin/llm-config {provider, model} and no apiKey. Now "no key ⇒ owner pays" is a
 * ROOT GRANT per company, stored in app_settings under one key (no migration), written only by
 * the root-only /api/admin/llm-owner-key route (audited) and refused by the generic settings
 * route. Demo chat keeps its own owner-billed path (checked and capped separately).
 *
 * This module is PURE (the key and the lenient parser); the request-path read is
 * isOwnerKeyGranted in ./resolve.ts and the writer is server/services/llm-owner-key.ts.
 */

export const LLM_OWNER_KEY_GRANTS_KEY = "llm_owner_key_grants";

export interface LlmOwnerKeyGrants {
  companies: number[];
}

/** Lenient: any shape in, a well-formed document out. Never throws. */
export function parseOwnerKeyGrants(raw: unknown): LlmOwnerKeyGrants {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { companies?: unknown }).companies)
    ? ((raw as { companies: unknown[] }).companies as unknown[])
    : [];
  return { companies: list.filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0) };
}
