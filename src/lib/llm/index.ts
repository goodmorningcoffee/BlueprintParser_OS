import type { LLMClient } from "./types";
import { LLMError } from "./types";
import { GroqAdapter } from "./groq";
import { AnthropicAdapter } from "./anthropic";
import { OpenAIAdapter } from "./openai";

export { LLMError } from "./types";
export type { LLMClient, LLMStreamOptions, ChatMessage, ResolvedLLMConfig } from "./types";

/**
 * Factory: create an LLM client for a given provider.
 */
export function createLLMClient(
  provider: string,
  apiKey: string,
  baseUrl?: string
): LLMClient {
  switch (provider) {
    case "groq":
      return new GroqAdapter(apiKey);
    case "anthropic":
      return new AnthropicAdapter(apiKey);
    case "openai":
      return new OpenAIAdapter(apiKey);
    case "custom":
      return new OpenAIAdapter(apiKey, baseUrl);
    default:
      throw new LLMError(`Unknown LLM provider: ${provider}`, provider);
  }
}
