import Groq from "groq-sdk";
import type { LLMClient, LLMStreamOptions } from "./types";
import { LLMError } from "./types";

export class GroqAdapter implements LLMClient {
  public readonly provider = "groq";
  private client: Groq;

  constructor(apiKey: string) {
    this.client = new Groq({ apiKey });
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
        err.message || "Groq API error",
        "groq",
        err.status || err.statusCode
      );
    }
  }
}
