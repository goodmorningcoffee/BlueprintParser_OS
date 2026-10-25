import { db } from "@/lib/db";
import { appSettings, llmConfigs } from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { decryptApiKey } from "@/lib/crypto";
import { LLM_OWNER_KEY_GRANTS_KEY, parseOwnerKeyGrants } from "./owner-key-grant";
import type { ResolvedLLMConfig } from "./types";

/**
 * [2026-10-25] Request-path read of the owner-key grant list (lib/llm/owner-key-grant.ts): a
 * missing row, a malformed value or a failed read all mean "not granted" — fail closed.
 */
export async function isOwnerKeyGranted(companyId: number): Promise<boolean> {
  try {
    const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, LLM_OWNER_KEY_GRANTS_KEY)).limit(1);
    return parseOwnerKeyGrants(row?.value).companies.includes(companyId);
  } catch {
    return false;
  }
}

/**
 * Resolve which LLM provider/model/key to use for a chat request.
 *
 * Hierarchy — in the order the function actually checks them (re-derived from the body
 * 2026-07-31; the previous version of this list had tiers 3 and 4 the wrong way round and
 * omitted 2b entirely, which inverts the answer for anyone who sets both an API key and
 * LLM_PROVIDER):
 *   1.  User-specific config (llm_configs with userId, future)
 *   2.  Company-wide config (llm_configs with userId=NULL)
 *   2b. Demo fallback — demo sessions prefer the cheapest provider to control costs, and
 *       this is consulted BEFORE either env tier
 *   3.  Env overrides (LLM_PROVIDER + LLM_MODEL + LLM_BASE_URL) — these WIN over a bare key
 *   4.  Whichever env key is set (GROQ_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY)
 *
 * Returns null if no LLM is configured anywhere.
 */
export async function resolveLLMConfig(
  companyId: number,
  userId?: number,
  isDemo?: boolean
): Promise<ResolvedLLMConfig | null> {
  // [2026-10-25 root hardening] The OWNER's environment keys are reachable only by a demo session
  // or a company root has granted (lib/llm/owner-key-grant.ts). Everyone else must bring a key.
  const ownerKeysAllowed = isDemo === true || (await isOwnerKeyGranted(companyId));
  const getEnvKey = (provider: string) => (ownerKeysAllowed ? getOwnerEnvKey(provider) : undefined);
  // 1. Check user-specific config (future per-user provisioning)
  if (userId) {
    try {
      const [userConfig] = await db
        .select()
        .from(llmConfigs)
        .where(
          and(
            eq(llmConfigs.companyId, companyId),
            eq(llmConfigs.userId, userId),
            eq(llmConfigs.isDefault, true)
          )
        )
        .limit(1);

      if (userConfig) {
        let apiKey: string | undefined;
        try {
          apiKey = userConfig.encryptedApiKey
            ? decryptApiKey(userConfig.encryptedApiKey)
            : getEnvKey(userConfig.provider);
        } catch {
          apiKey = getEnvKey(userConfig.provider);
        }
        if (apiKey) {
          return {
            provider: userConfig.provider,
            model: userConfig.model,
            apiKey,
            baseUrl: userConfig.baseUrl || undefined,
            temperature: userConfig.config?.temperature,
            maxTokens: userConfig.config?.maxTokens,
          };
        }
      }
    } catch {
      // Table may not exist yet during migration — fall through
    }
  }

  // 2. Check company-wide config (admin-configured)
  try {
    const [companyConfig] = await db
      .select()
      .from(llmConfigs)
      .where(
        and(
          eq(llmConfigs.companyId, companyId),
          isNull(llmConfigs.userId),
          eq(llmConfigs.isDemo, isDemo || false),
          eq(llmConfigs.isDefault, true)
        )
      )
      .limit(1);

    if (companyConfig) {
      let apiKey: string | undefined;
      try {
        apiKey = companyConfig.encryptedApiKey
          ? decryptApiKey(companyConfig.encryptedApiKey)
          : getEnvKey(companyConfig.provider);
      } catch {
        // Decryption failed (key secret changed between environments) — fall back to env key
        apiKey = getEnvKey(companyConfig.provider);
      }
      if (apiKey || companyConfig.provider === "custom") {
        return {
          provider: companyConfig.provider,
          model: companyConfig.model,
          apiKey: apiKey || "",
          baseUrl: companyConfig.baseUrl || undefined,
          temperature: companyConfig.config?.temperature,
          maxTokens: companyConfig.config?.maxTokens,
        };
      }
    }
  } catch {
    // Table may not exist yet — fall through to env vars
  }

  // 2b. Demo fallback: prefer cheapest provider to control costs
  if (isDemo) {
    if (process.env.GROQ_API_KEY) {
      return { provider: "groq", model: "llama-3.3-70b-versatile", apiKey: process.env.GROQ_API_KEY };
    }
  }
  // No grant: a company without its own key gets no LLM (chat reports "not configured").
  if (!ownerKeysAllowed) return null;

  // 3. Check explicit env var overrides (LLM_PROVIDER + LLM_MODEL)
  if (process.env.LLM_PROVIDER) {
    const apiKey = getEnvKey(process.env.LLM_PROVIDER);
    if (apiKey || process.env.LLM_PROVIDER === "custom") {
      return {
        provider: process.env.LLM_PROVIDER,
        model: process.env.LLM_MODEL || getDefaultModel(process.env.LLM_PROVIDER),
        apiKey: apiKey || "",
        baseUrl: process.env.LLM_BASE_URL,
      };
    }
  }

  // 4. Fall back to whichever env key is set
  if (process.env.GROQ_API_KEY) {
    return { provider: "groq", model: "llama-3.3-70b-versatile", apiKey: process.env.GROQ_API_KEY };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: "anthropic", model: "claude-sonnet-4-6", apiKey: process.env.ANTHROPIC_API_KEY };
  }
  if (process.env.OPENAI_API_KEY) {
    return { provider: "openai", model: "gpt-4o-mini", apiKey: process.env.OPENAI_API_KEY };
  }

  return null;
}

function getOwnerEnvKey(provider: string): string | undefined {
  switch (provider) {
    case "groq": return process.env.GROQ_API_KEY;
    case "anthropic": return process.env.ANTHROPIC_API_KEY;
    case "openai": return process.env.OPENAI_API_KEY;
    default: return undefined;
  }
}

function getDefaultModel(provider: string): string {
  switch (provider) {
    case "groq": return "llama-3.3-70b-versatile";
    case "anthropic": return "claude-sonnet-4-6";
    case "openai": return "gpt-4o-mini";
    default: return "";
  }
}
