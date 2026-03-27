export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMStreamOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface LLMClient {
  provider: string;
  streamChat(options: LLMStreamOptions): AsyncIterable<string>;
}

export interface ResolvedLLMConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

export class LLMError extends Error {
  public readonly provider: string;
  public readonly statusCode?: number;
  public readonly isRateLimit: boolean;

  constructor(message: string, provider: string, statusCode?: number) {
    super(message);
    this.name = "LLMError";
    this.provider = provider;
    this.statusCode = statusCode;
    this.isRateLimit = statusCode === 429;
  }
}
