import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient, LLMStreamOptions } from "./types";
import { LLMError } from "./types";

export class AnthropicAdapter implements LLMClient {
  public readonly provider = "anthropic";
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async *streamChat(options: LLMStreamOptions): AsyncIterable<string> {
    try {
      // Anthropic takes system as a top-level parameter, not in messages array
      const systemMsg = options.messages.find((m) => m.role === "system");
      const nonSystemMsgs = options.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

      // Anthropic requires messages to start with "user" role
      // If first message is assistant (from chat history), prepend a minimal user message
      if (nonSystemMsgs.length > 0 && nonSystemMsgs[0].role === "assistant") {
        nonSystemMsgs.unshift({ role: "user", content: "(continuing conversation)" });
      }

      const stream = this.client.messages.stream({
        model: options.model,
        system: systemMsg?.content || undefined,
        messages: nonSystemMsgs,
        max_tokens: options.maxTokens ?? 2048,
        temperature: options.temperature ?? 0.3,
      });

      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield event.delta.text;
        }
      }
    } catch (err: any) {
      throw new LLMError(
        err.message || "Anthropic API error",
        "anthropic",
        err.status || err.statusCode
      );
    }
  }
}
