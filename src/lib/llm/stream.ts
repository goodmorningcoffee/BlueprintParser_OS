import { db } from "@/lib/db";
import { chatMessages } from "@/lib/db/schema";
import { createLLMClient, LLMError } from "./index";
import type { ResolvedLLMConfig, ChatMessage } from "./types";
import { logger } from "@/lib/logger";
import {
  assertProjectWriteCapability,
  isDemoWriteProtectionError,
  type ProjectWriteCapability,
  withProjectWrite,
} from "@/server/api/project-write-capability";
import { ApiError } from "@/server/api/envelope";

function isRetiredProjectWrite(error: unknown): boolean {
  return (
    (error instanceof ApiError && error.code === "FORBIDDEN") ||
    (error instanceof Error && error.message === "Invalid project write capability") ||
    isDemoWriteProtectionError(error)
  );
}

/**
 * Create an SSE-encoded ReadableStream from an LLM provider.
 * Handles: client creation, streaming, response accumulation, DB save.
 *
 * Used by both authenticated and demo chat routes.
 */
export function streamChatResponse(
  config: ResolvedLLMConfig,
  messages: ChatMessage[],
  // [refactor jun13 P0.5-G2] null = global (cross-project) chat. Callers used
  // to pass 0, which violated the NOT NULL FK *after* the response had fully
  // streamed — the catch below then appended an error event to a good answer
  // and the assistant message was never saved.
  projectId: number | null,
  pageNumber: number | null,
  userId: number | null,
  noPersist = false,
  writeCapability?: ProjectWriteCapability,
): Response {
  // A caller can request less authority, never more: a project-scoped stream without a branded
  // capability is read-only even if a direct caller lies with noPersist=false.
  const isDemo = noPersist || (projectId !== null && !writeCapability);
  const preventPersistence = isDemo;
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

        if (!preventPersistence) {
          let canPersist = true;
          if (projectId !== null) {
            try {
              await assertProjectWriteCapability(writeCapability!, projectId);
            } catch {
              canPersist = false;
            }
          }
          if (canPersist) {
            if (projectId === null) {
              await db.insert(chatMessages).values({
                projectId,
                pageNumber,
                role: "assistant",
                content: fullResponse,
                model: `${config.provider}/${config.model}`,
                userId,
              });
            } else {
              try {
                await withProjectWrite(writeCapability!, projectId, async (tx) => {
                  await tx.insert(chatMessages).values({
                    projectId,
                    pageNumber,
                    role: "assistant",
                    content: fullResponse,
                    model: `${config.provider}/${config.model}`,
                    userId,
                  });
                });
              } catch (error) {
                // A project may retire while the provider is streaming. That still completes the
                // already-produced response, but the retired lifecycle cannot adopt it.
                if (!isRetiredProjectWrite(error)) throw error;
              }
            }
          }
        }

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
