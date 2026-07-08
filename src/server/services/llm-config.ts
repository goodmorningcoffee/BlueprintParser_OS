// [refactor jul7 S056] admin/llm-config SOLO — 4-method admin route (GET list configs + masked
// keys + env defaults, POST create/update, PUT company system-prompt, DELETE), folded from the
// legacy route (git show 2015ee4:src/app/api/admin/llm-config/route.ts). Char:
// __tests__/admin-llm-config.route.test.ts (LC-*). requireAdmin → the shell provides
// auth:"admin". Sanctioned diffs:
//   • A — the POST/DELETE validation flat {error} → envelope ApiError, byte-verbatim message +
//     status ("provider and model required"@400, "id required"@400, "Not found"@404).
//   • E — POST/PUT/DELETE `await req.json()` (no catch) subsumed by the shell raw-parse
//     (malformed → 400 BAD_REQUEST "Invalid JSON body"). GET reads searchParams → NO E.
//   • NO B — this route has ZERO catch-500 literals and ZERO err.message leaks; the shell's
//     generic INTERNAL 500 is NEW uniform wrapping for the three write methods (which had no
//     try/catch at all), NOT a B leak-retirement.
// PRESERVED verbatim (DR006 traps):
//   • the GET per-row decrypt catch → "***decrypt-error***";
//   • the TWO GET swallow-catches (llmConfigs query throws → configs=[]; pipelineConfig query
//     throws → systemPrompt=undefined→null) are LOAD-BEARING control-flow fallbacks @200, NOT B
//     — do NOT convert to error responses;
//   • in-body isRootAdmin scope-WIDENING stays in-service (root ?companyId override on the
//     config query; root targetCompanyId on POST; root deletes any id) — these WIDEN, they do
//     not gate the route, so the shell stays auth:"admin";
//   • systemPrompt is ALWAYS read for session.user.companyId, NOT the overridden query company;
//   • the PUT jsonb SPREAD-MERGE (never a column replace); POST apiKey==="unchanged" leaves the
//     stored key untouched.
// Uses REAL @/lib/crypto (random-IV ciphertext — assert via mask/round-trip, never bytes).

import { db } from "@/lib/db";
import { llmConfigs, companies } from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { encryptApiKey, maskApiKey, decryptApiKey } from "@/lib/crypto";
import { ApiError } from "@/server/api/envelope";
import type { AuthSession } from "@/lib/api-utils";

/**
 * GET /api/admin/llm-config
 * Returns LLM configs for the admin's company (keys masked) + which env vars are set.
 */
export async function getLlmConfigs(req: Request, session: AuthSession): Promise<unknown> {
  const url = new URL(req.url);
  const includeUsers = url.searchParams.get("includeUsers") === "true";
  // Root admin can query any company's configs
  const queryCompanyId = session.user.isRootAdmin && url.searchParams.get("companyId")
    ? Number(url.searchParams.get("companyId"))
    : session.user.companyId;

  let configs: unknown[] = [];
  try {
    const rows = await db
      .select()
      .from(llmConfigs)
      .where(
        includeUsers
          ? eq(llmConfigs.companyId, queryCompanyId)
          : and(
              eq(llmConfigs.companyId, queryCompanyId),
              isNull(llmConfigs.userId)
            )
      );

    configs = rows.map((r) => {
      let maskedKey: string | null = null;
      if (r.encryptedApiKey) {
        try { maskedKey = maskApiKey(decryptApiKey(r.encryptedApiKey)); }
        catch { maskedKey = "***decrypt-error***"; }
      }
      return {
        id: r.id,
        userId: r.userId,
        provider: r.provider,
        model: r.model,
        maskedKey,
        hasKey: !!r.encryptedApiKey,
        baseUrl: r.baseUrl,
        isDemo: r.isDemo,
        isDefault: r.isDefault,
        config: r.config,
      };
    });
  } catch {
    // Table may not exist yet
  }

  // Fetch custom system prompt from pipelineConfig (ALWAYS the admin's OWN company)
  let systemPrompt: string | undefined;
  try {
    const [company] = await db.select({ pipelineConfig: companies.pipelineConfig })
      .from(companies).where(eq(companies.id, session.user.companyId)).limit(1);
    systemPrompt = company?.pipelineConfig?.llm?.systemPrompt;
  } catch { /* ignore */ }

  return {
    configs,
    systemPrompt: systemPrompt || null,
    envDefaults: {
      groq: !!process.env.GROQ_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
    },
  };
}

/**
 * POST /api/admin/llm-config
 * Create or update an LLM config for the admin's company.
 */
export async function upsertLlmConfig(session: AuthSession, body: Record<string, unknown>): Promise<unknown> {
  const { provider, model, apiKey, baseUrl, isDemo, config, userId, targetCompanyId } = body as {
    provider?: string; model?: string; apiKey?: string; baseUrl?: string;
    isDemo?: boolean; config?: typeof llmConfigs.$inferInsert["config"];
    userId?: number; targetCompanyId?: number;
  };

  if (!provider || !model) {
    throw new ApiError("VALIDATION", "provider and model required");
  }

  // Root admin can set configs for any company/user
  const companyId = (targetCompanyId && session.user.isRootAdmin) ? targetCompanyId : session.user.companyId;
  const encrypted = apiKey ? encryptApiKey(apiKey) : null;

  // Check if config already exists for this scope (company-wide or per-user)
  const [existing] = await db
    .select()
    .from(llmConfigs)
    .where(
      and(
        eq(llmConfigs.companyId, companyId),
        userId ? eq(llmConfigs.userId, userId) : isNull(llmConfigs.userId),
        eq(llmConfigs.isDemo, isDemo || false)
      )
    )
    .limit(1);

  if (existing) {
    // Update existing
    const updates: Record<string, unknown> = {
      provider,
      model,
      baseUrl: baseUrl || null,
      isDefault: true,
      config: config || null,
      updatedAt: new Date(),
    };
    // Only update key if a new one was provided (not "unchanged")
    if (apiKey && apiKey !== "unchanged") {
      updates.encryptedApiKey = encrypted;
    }
    await db.update(llmConfigs).set(updates).where(eq(llmConfigs.id, existing.id));

    return {
      id: existing.id,
      provider,
      model,
      maskedKey: apiKey && apiKey !== "unchanged"
        ? maskApiKey(apiKey)
        : existing.encryptedApiKey
          ? maskApiKey(decryptApiKey(existing.encryptedApiKey))
          : null,
      hasKey: !!(apiKey || existing.encryptedApiKey),
      baseUrl: baseUrl || null,
      isDemo: isDemo || false,
      isDefault: true,
      config: config || null,
    };
  }

  // Insert new
  const [created] = await db
    .insert(llmConfigs)
    .values({
      companyId,
      userId: userId || null,
      provider,
      model,
      encryptedApiKey: encrypted,
      baseUrl: baseUrl || null,
      isDemo: isDemo || false,
      isDefault: true,
      config: config || null,
    })
    .returning();

  return {
    id: created.id,
    provider,
    model,
    maskedKey: apiKey ? maskApiKey(apiKey) : null,
    hasKey: !!apiKey,
    baseUrl: baseUrl || null,
    isDemo: isDemo || false,
    isDefault: true,
    config: config || null,
  };
}

/**
 * DELETE /api/admin/llm-config
 * Remove an LLM config. Chat falls back to env var.
 */
export async function deleteLlmConfig(session: AuthSession, body: Record<string, unknown>): Promise<unknown> {
  const { id } = body as { id?: number };
  if (!id) {
    throw new ApiError("VALIDATION", "id required");
  }

  // Verify ownership (root admin can delete any config)
  const [config] = await db
    .select()
    .from(llmConfigs)
    .where(
      session.user.isRootAdmin
        ? eq(llmConfigs.id, id)
        : and(eq(llmConfigs.id, id), eq(llmConfigs.companyId, session.user.companyId))
    )
    .limit(1);

  if (!config) {
    throw new ApiError("NOT_FOUND", "Not found");
  }

  await db.delete(llmConfigs).where(eq(llmConfigs.id, id));
  return { success: true };
}

/**
 * PUT /api/admin/llm-config
 * Update company-level LLM settings (system prompt).
 */
export async function updateLlmSettings(session: AuthSession, body: Record<string, unknown>): Promise<unknown> {
  const { systemPrompt } = body as { systemPrompt?: string };

  // Merge into pipelineConfig.llm
  const [company] = await db
    .select({ pipelineConfig: companies.pipelineConfig })
    .from(companies)
    .where(eq(companies.id, session.user.companyId))
    .limit(1);

  const existing = company?.pipelineConfig || {};
  const existingLlm = existing.llm || {};
  const updated = {
    ...existing,
    llm: { ...existingLlm, systemPrompt: systemPrompt || undefined },
  };

  await db
    .update(companies)
    .set({ pipelineConfig: updated, updatedAt: new Date() })
    .where(eq(companies.id, session.user.companyId));

  return { success: true };
}
