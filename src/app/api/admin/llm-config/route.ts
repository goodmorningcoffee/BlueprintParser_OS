import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { llmConfigs, companies } from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { encryptApiKey, maskApiKey, decryptApiKey } from "@/lib/crypto";

/**
 * GET /api/admin/llm-config
 * Returns LLM configs for the admin's company (keys masked) + which env vars are set.
 */
export async function GET(req: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const url = new URL(req.url);
  const includeUsers = url.searchParams.get("includeUsers") === "true";
  // Root admin can query any company's configs
  const queryCompanyId = session.user.isRootAdmin && url.searchParams.get("companyId")
    ? Number(url.searchParams.get("companyId"))
    : session.user.companyId;

  let configs: any[] = [];
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

  // Fetch custom system prompt from pipelineConfig
  let systemPrompt: string | undefined;
  try {
    const [company] = await db.select({ pipelineConfig: companies.pipelineConfig })
      .from(companies).where(eq(companies.id, session.user.companyId)).limit(1);
    systemPrompt = (company?.pipelineConfig as any)?.llm?.systemPrompt;
  } catch { /* ignore */ }

  return NextResponse.json({
    configs,
    systemPrompt: systemPrompt || null,
    envDefaults: {
      groq: !!process.env.GROQ_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
    },
  });
}

/**
 * POST /api/admin/llm-config
 * Create or update an LLM config for the admin's company.
 */
export async function POST(req: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const { provider, model, apiKey, baseUrl, isDemo, config, userId, targetCompanyId } = await req.json();

  if (!provider || !model) {
    return NextResponse.json({ error: "provider and model required" }, { status: 400 });
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

    return NextResponse.json({
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
    });
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

  return NextResponse.json({
    id: created.id,
    provider,
    model,
    maskedKey: apiKey ? maskApiKey(apiKey) : null,
    hasKey: !!apiKey,
    baseUrl: baseUrl || null,
    isDemo: isDemo || false,
    isDefault: true,
    config: config || null,
  });
}

/**
 * DELETE /api/admin/llm-config
 * Remove an LLM config. Chat falls back to env var.
 */
export async function DELETE(req: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const { id } = await req.json();
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
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
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await db.delete(llmConfigs).where(eq(llmConfigs.id, id));
  return NextResponse.json({ success: true });
}

/**
 * PUT /api/admin/llm-config
 * Update company-level LLM settings (system prompt).
 */
export async function PUT(req: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const { systemPrompt } = await req.json();

  // Merge into pipelineConfig.llm
  const [company] = await db
    .select({ pipelineConfig: companies.pipelineConfig })
    .from(companies)
    .where(eq(companies.id, session.user.companyId))
    .limit(1);

  const existing = (company?.pipelineConfig as Record<string, unknown>) || {};
  const existingLlm = (existing.llm as Record<string, unknown>) || {};
  const updated = {
    ...existing,
    llm: { ...existingLlm, systemPrompt: systemPrompt || undefined },
  };

  await db
    .update(companies)
    .set({ pipelineConfig: updated as any, updatedAt: new Date() })
    .where(eq(companies.id, session.user.companyId));

  return NextResponse.json({ success: true });
}
