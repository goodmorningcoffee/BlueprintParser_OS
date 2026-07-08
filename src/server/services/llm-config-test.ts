// [refactor jul8 S060] admin/llm-config/test SOLO — POST LLM connection test (tiny streamChat
// probe, nothing saved), folded from the legacy route
// (git show c33951f:src/app/api/admin/llm-config/test/route.ts). Char:
// __tests__/admin-llm-config-test.route.test.ts (LT-*). requireAdmin → shell auth:"admin".
// ★ THE EVICTION RESOLUTION (this route was EVICTION-flagged since S044): the
// {success:false, error:<msg>, responseTime} bodies are DOMAIN data AT 200 — the `error`
// field is connection-test OUTCOME (deliberate err.message exposure; the tool exists to tell
// the admin WHY a key failed), NOT the envelope and NOT a DR002 B-leak. The try/catch below
// is domain CONTROL-FLOW producing 200 bodies — do NOT convert to thrown ApiErrors; the shell
// passes returned objects through untouched. Sanctioned diffs:
//   • A — auth 401/403 + the one true error path "provider and model required"@400 → envelope.
//   • E — legacy `await req.json()` subsumed by the shell raw-parse.
//   • NO B — the catch is domain control-flow @200, preserved verbatim.
// PRESERVED verbatim: createLLMClient(provider, apiKey || "", baseUrl); the exact probe args
// (maxTokens 5, temperature 0, "Say OK"); the EMPTY-stream-counts-as-success quirk; the
// Promise.race resolve-not-throw timeout (see the SECURITY comment); the 4-way catch ladder.

import { createLLMClient, LLMError } from "@/lib/llm";
import { ApiError } from "@/server/api/envelope";

export async function testLlmConnection(body: Record<string, unknown>): Promise<unknown> {
  const { provider, model, apiKey, baseUrl } = body as {
    provider?: string; model?: string; apiKey?: string; baseUrl?: string;
  };
  if (!provider || !model) {
    throw new ApiError("VALIDATION", "provider and model required");
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
      return {
        success: false,
        error: "Timeout waiting for LLM response",
        responseTime: Date.now() - start,
      };
    }

    const responseTime = Date.now() - start;
    return { success: true, responseTime };
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

    return { success: false, error: message, responseTime };
  }
}
