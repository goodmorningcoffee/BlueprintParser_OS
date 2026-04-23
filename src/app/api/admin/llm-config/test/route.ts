import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import { createLLMClient, LLMError } from "@/lib/llm";

/**
 * POST /api/admin/llm-config/test
 * Test an LLM connection without saving to DB.
 * Makes a tiny completion request (max_tokens: 5) to verify the key works.
 */
export async function POST(req: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const { provider, model, apiKey, baseUrl } = await req.json();
  if (!provider || !model) {
    return NextResponse.json({ error: "provider and model required" }, { status: 400 });
  }

  const start = Date.now();

  try {
    const client = createLLMClient(provider, apiKey || "", baseUrl);

    // Tiny request to test connectivity — max_tokens: 5 to minimize cost.
    // SECURITY: the timeout is expressed via Promise.race rather than
    // `setTimeout(() => throw)`. A throw inside a timer callback escapes
    // the async/await chain and becomes an uncaughtException that crashes
    // the entire Node process (here: the whole ECS task). One misconfigured
    // admin test could have taken the app down.
    const stream = client.streamChat({
      model,
      messages: [{ role: "user", content: "Say OK" }],
      maxTokens: 5,
      temperature: 0,
    });

    const TIMEOUT_MS = 10_000;
    const firstChunk = await Promise.race<{ kind: "ok" } | { kind: "timeout" }>([
      (async () => {
        for await (const _chunk of stream) {
          return { kind: "ok" } as const;
        }
        return { kind: "ok" } as const;
      })(),
      new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), TIMEOUT_MS),
      ),
    ]);

    if (firstChunk.kind === "timeout") {
      return NextResponse.json({
        success: false,
        error: "Timeout waiting for LLM response",
        responseTime: Date.now() - start,
      });
    }

    const responseTime = Date.now() - start;
    return NextResponse.json({ success: true, responseTime });
  } catch (err) {
    const responseTime = Date.now() - start;
    const message =
      err instanceof LLMError
        ? err.isRateLimit
          ? "Rate limited by provider — key is valid but try again later"
          : err.message
        : err instanceof Error
          ? err.message
          : "Connection failed";

    return NextResponse.json({ success: false, error: message, responseTime });
  }
}
