import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient, LLMStreamOptions, LLMToolUseOptions, ToolStreamEvent } from "./types";
import { LLMError } from "./types";

/** Retry with exponential backoff on 429 rate limit errors */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (err.status === 429 && attempt < maxRetries) {
        const retryAfter = err.headers?.["retry-after"];
        const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : Math.min(1000 * Math.pow(2, attempt), 30000);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Max retries exceeded");
}

function toDetailedError(err: any, model?: string): LLMError {
  if (err.status === 429) {
    const wait = err.headers?.["retry-after"] || "30";
    return new LLMError(`Rate limited — try again in ${wait}s. Consider using Sonnet for better rate limits.`, "anthropic", 429);
  }
  if (err.status === 404) {
    return new LLMError(`Model not found: "${model}". Go to Admin → AI Models to select a valid model.`, "anthropic", 404);
  }
  if (err.status === 400) {
    return new LLMError(`Bad request: ${err.error?.error?.message || err.message}. Check model name and API key.`, "anthropic", 400);
  }
  return new LLMError(err.message || "Anthropic API error", "anthropic", err.status || err.statusCode);
}

export class AnthropicAdapter implements LLMClient {
  public readonly provider = "anthropic";
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  private prepareMessages(messages: LLMStreamOptions["messages"]) {
    const systemMsg = messages.find((m) => m.role === "system");
    const nonSystemMsgs = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    if (nonSystemMsgs.length > 0 && nonSystemMsgs[0].role === "assistant") {
      nonSystemMsgs.unshift({ role: "user", content: "(continuing conversation)" });
    }

    return { system: systemMsg?.content || undefined, messages: nonSystemMsgs };
  }

  async *streamChat(options: LLMStreamOptions): AsyncIterable<string> {
    try {
      const { system, messages } = this.prepareMessages(options.messages);

      const stream = await withRetry(() =>
        Promise.resolve(this.client.messages.stream({
          model: options.model,
          system,
          messages,
          max_tokens: options.maxTokens ?? 2048,
          temperature: options.temperature ?? 0.3,
        }))
      );

      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield event.delta.text;
        }
      }
    } catch (err: any) {
      throw toDetailedError(err, options.model);
    }
  }

  async *streamChatWithTools(options: LLMToolUseOptions): AsyncIterable<ToolStreamEvent> {
    try {
      const { system, messages: preparedMsgs } = this.prepareMessages(options.messages);
      const maxRounds = options.maxToolRounds ?? 10;

      const msgHistory: Anthropic.MessageParam[] = preparedMsgs.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      const tools: Anthropic.Tool[] = options.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool["input_schema"],
      }));

      for (let round = 0; round < maxRounds; round++) {
        // Stream the response — text arrives in real-time
        const stream = await withRetry(() =>
          Promise.resolve(this.client.messages.stream({
            model: options.model,
            system,
            messages: msgHistory,
            tools,
            max_tokens: options.maxTokens ?? 4096,
            temperature: options.temperature ?? 0.3,
          }))
        );

        // Yield text deltas as they arrive (real-time streaming)
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            yield { type: "text_delta", text: event.delta.text };
          } else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
            yield { type: "tool_call_start", name: event.content_block.name, id: event.content_block.id };
          }
        }

        // Get the complete message to extract tool_use blocks
        const finalMsg = await stream.finalMessage();

        const toolUseBlocks = finalMsg.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
        );

        // If no tool calls, we're done
        if (toolUseBlocks.length === 0 || finalMsg.stop_reason !== "tool_use") {
          yield { type: "done" };
          return;
        }

        // Execute tool calls
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of toolUseBlocks) {
          let resultStr: string;
          try {
            const result = await options.executeToolCall(
              block.name,
              block.input as Record<string, unknown>,
            );
            resultStr = JSON.stringify(result);
          } catch (toolErr: any) {
            resultStr = JSON.stringify({ error: `Tool failed: ${toolErr.message || "unknown error"}` });
          }

          yield { type: "tool_call_result", name: block.name, id: block.id, result: resultStr };

          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: resultStr,
          });
        }

        // Add assistant response + tool results to history for next round
        msgHistory.push({ role: "assistant", content: finalMsg.content });
        msgHistory.push({ role: "user", content: toolResults });
      }

      yield { type: "text_delta", text: "\n\n(Reached maximum tool call rounds)" };
      yield { type: "done" };
    } catch (err: any) {
      throw toDetailedError(err, options.model);
    }
  }
}
