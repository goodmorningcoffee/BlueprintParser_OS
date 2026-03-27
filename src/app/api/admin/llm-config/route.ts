import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { llmConfigs } from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { encryptApiKey, maskApiKey, decryptApiKey } from "@/lib/crypto";

/**
 * GET /api/admin/llm-config
 * Returns LLM configs for the admin's company (keys masked) + which env vars are set.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  let configs: any[] = [];
  try {
    const rows = await db
      .select()
      .from(llmConfigs)
      .where(
        and(
          eq(llmConfigs.companyId, session.user.companyId),
          isNull(llmConfigs.userId) // company-wide only for now
        )
      );

    configs = rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      model: r.model,
      maskedKey: r.encryptedApiKey ? maskApiKey(decryptApiKey(r.encryptedApiKey)) : null,
      hasKey: !!r.encryptedApiKey,
      baseUrl: r.baseUrl,
      isDemo: r.isDemo,
      isDefault: r.isDefault,
      config: r.config,
    }));
  } catch {
    // Table may not exist yet
  }

  return NextResponse.json({
    configs,
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
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const { provider, model, apiKey, baseUrl, isDemo, config } = await req.json();

  if (!provider || !model) {
    return NextResponse.json({ error: "provider and model required" }, { status: 400 });
  }

  const companyId = session.user.companyId;
  const encrypted = apiKey ? encryptApiKey(apiKey) : null;

  // Check if config already exists for this scope
  const [existing] = await db
    .select()
    .from(llmConfigs)
    .where(
      and(
        eq(llmConfigs.companyId, companyId),
        isNull(llmConfigs.userId),
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
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const { id } = await req.json();
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  // Verify ownership
  const [config] = await db
    .select()
    .from(llmConfigs)
    .where(
      and(eq(llmConfigs.id, id), eq(llmConfigs.companyId, session.user.companyId))
    )
    .limit(1);

  if (!config) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await db.delete(llmConfigs).where(eq(llmConfigs.id, id));
  return NextResponse.json({ success: true });
}
