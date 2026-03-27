import OpenAI from "openai";
import type { LLMClient, LLMStreamOptions } from "./types";
import { LLMError } from "./types";

/**
 * OpenAI adapter — also handles any OpenAI-compatible endpoint (Ollama, vLLM, etc.)
 * by passing a custom baseURL.
 */
export class OpenAIAdapter implements LLMClient {
  public readonly provider: string;
  private client: OpenAI;

  constructor(apiKey: string, baseUrl?: string) {
    this.provider = baseUrl ? "custom" : "openai";
    this.client = new OpenAI({
      apiKey: apiKey || "ollama", // Ollama doesn't need a real key
      ...(baseUrl && { baseURL: baseUrl }),
    });
  }

  async *streamChat(options: LLMStreamOptions): AsyncIterable<string> {
    try {
      const stream = await this.client.chat.completions.create({
        model: options.model,
        messages: options.messages,
        temperature: options.temperature ?? 0.3,
        max_tokens: options.maxTokens ?? 2048,
        stream: true,
      });

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) yield content;
      }
    } catch (err: any) {
      throw new LLMError(
        err.message || "OpenAI API error",
        this.provider,
        err.status || err.statusCode
      );
    }
  }
}
