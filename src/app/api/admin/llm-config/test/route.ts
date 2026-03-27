import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createLLMClient, LLMError } from "@/lib/llm";

/**
 * POST /api/admin/llm-config/test
 * Test an LLM connection without saving to DB.
 * Makes a tiny completion request (max_tokens: 5) to verify the key works.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const { provider, model, apiKey, baseUrl } = await req.json();
  if (!provider || !model) {
    return NextResponse.json({ error: "provider and model required" }, { status: 400 });
  }

  const start = Date.now();

  try {
    const client = createLLMClient(provider, apiKey || "", baseUrl);

    // Tiny request to test connectivity — max_tokens: 5 to minimize cost
    let gotResponse = false;
    const timeout = setTimeout(() => {
      if (!gotResponse) throw new Error("Timeout");
    }, 10000);

    const stream = client.streamChat({
      model,
      messages: [{ role: "user", content: "Say OK" }],
      maxTokens: 5,
      temperature: 0,
    });

    for await (const chunk of stream) {
      gotResponse = true;
      break; // Just need the first chunk to confirm it works
    }
    clearTimeout(timeout);

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
