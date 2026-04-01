import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient, LLMStreamOptions, LLMToolUseOptions, ToolStreamEvent } from "./types";
import { LLMError } from "./types";

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

      const stream = this.client.messages.stream({
        model: options.model,
        system,
        messages,
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

  async *streamChatWithTools(options: LLMToolUseOptions): AsyncIterable<ToolStreamEvent> {
    try {
      const { system, messages: preparedMsgs } = this.prepareMessages(options.messages);
      const maxRounds = options.maxToolRounds ?? 10;

      // Convert to Anthropic message format (mutable for the loop)
      const msgHistory: Anthropic.MessageParam[] = preparedMsgs.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      // Convert tool definitions to Anthropic format
      const tools: Anthropic.Tool[] = options.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool["input_schema"],
      }));

      for (let round = 0; round < maxRounds; round++) {
        const response = await this.client.messages.create({
          model: options.model,
          system,
          messages: msgHistory,
          tools,
          max_tokens: options.maxTokens ?? 4096,
          temperature: options.temperature ?? 0.3,
        });

        // Check for tool use blocks
        const toolUseBlocks = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
        );
        const textBlocks = response.content.filter(
          (b): b is Anthropic.TextBlock => b.type === "text"
        );

        // Yield any text that came before/alongside tool calls
        for (const tb of textBlocks) {
          if (tb.text) yield { type: "text_delta", text: tb.text };
        }

        // If no tool calls, we're done
        if (toolUseBlocks.length === 0 || response.stop_reason !== "tool_use") {
          yield { type: "done" };
          return;
        }

        // Execute tool calls
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of toolUseBlocks) {
          yield { type: "tool_call_start", name: block.name, id: block.id };

          const result = await options.executeToolCall(
            block.name,
            block.input as Record<string, unknown>,
          );
          const resultStr = JSON.stringify(result);

          yield { type: "tool_call_result", name: block.name, id: block.id, result: resultStr };

          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: resultStr,
          });
        }

        // Add assistant response + tool results to history for next round
        msgHistory.push({ role: "assistant", content: response.content });
        msgHistory.push({ role: "user", content: toolResults });
      }

      // Hit max rounds — yield what we have
      yield { type: "text_delta", text: "\n\n(Reached maximum tool call rounds)" };
      yield { type: "done" };
    } catch (err: any) {
      throw new LLMError(
        err.message || "Anthropic API error",
        "anthropic",
        err.status || err.statusCode
      );
    }
  }
}
