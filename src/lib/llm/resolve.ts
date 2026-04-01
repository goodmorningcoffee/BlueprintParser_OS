import { db } from "@/lib/db";
import { llmConfigs } from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { decryptApiKey } from "@/lib/crypto";
import type { ResolvedLLMConfig } from "./types";

/**
 * Resolve which LLM provider/model/key to use for a chat request.
 *
 * Hierarchy:
 *   1. User-specific config (llm_configs with userId, future)
 *   2. Company-wide config (llm_configs with userId=NULL)
 *   3. Environment variables (GROQ_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY)
 *   4. Env overrides (LLM_PROVIDER + LLM_MODEL + LLM_BASE_URL)
 *
 * Returns null if no LLM is configured anywhere.
 */
export async function resolveLLMConfig(
  companyId: number,
  userId?: number,
  isDemo?: boolean
): Promise<ResolvedLLMConfig | null> {
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
            temperature: (userConfig.config as any)?.temperature,
            maxTokens: (userConfig.config as any)?.maxTokens,
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
          temperature: (companyConfig.config as any)?.temperature,
          maxTokens: (companyConfig.config as any)?.maxTokens,
        };
      }
    }
  } catch {
    // Table may not exist yet — fall through to env vars
  }

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
    return { provider: "anthropic", model: "claude-sonnet-4-20250514", apiKey: process.env.ANTHROPIC_API_KEY };
  }
  if (process.env.OPENAI_API_KEY) {
    return { provider: "openai", model: "gpt-4o-mini", apiKey: process.env.OPENAI_API_KEY };
  }

  return null;
}

function getEnvKey(provider: string): string | undefined {
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
    case "anthropic": return "claude-sonnet-4-20250514";
    case "openai": return "gpt-4o-mini";
    default: return "";
  }
}
