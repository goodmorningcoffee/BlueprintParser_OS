import { db } from "@/lib/db";
import { chatMessages } from "@/lib/db/schema";
import { createLLMClient, LLMError } from "./index";
import type { ResolvedLLMConfig, ChatMessage } from "./types";
import { logger } from "@/lib/logger";

/**
 * Create an SSE-encoded ReadableStream from an LLM provider.
 * Handles: client creation, streaming, response accumulation, DB save.
 *
 * Used by both authenticated and demo chat routes.
 */
export function streamChatResponse(
  config: ResolvedLLMConfig,
  messages: ChatMessage[],
  projectId: number,
  pageNumber: number | null,
  userId: number | null
): Response {
  const client = createLLMClient(config.provider, config.apiKey, config.baseUrl);
  let fullResponse = "";
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const iterable = client.streamChat({
          model: config.model,
          messages,
          temperature: config.temperature ?? 0.3,
          maxTokens: config.maxTokens ?? 2048,
        });

        for await (const content of iterable) {
          fullResponse += content;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ content })}\n\n`)
          );
        }

        // Save assistant response to DB
        await db.insert(chatMessages).values({
          projectId,
          pageNumber,
          role: "assistant",
          content: fullResponse,
          model: `${config.provider}/${config.model}`,
          userId,
        });

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        logger.error("LLM stream error:", err);

        // Send error to client before closing
        const message =
          err instanceof LLMError
            ? err.isRateLimit
              ? "Rate limited by AI provider. Please wait and try again."
              : err.message
            : "Chat failed — check LLM configuration in admin panel.";

        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: message })}\n\n`)
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
