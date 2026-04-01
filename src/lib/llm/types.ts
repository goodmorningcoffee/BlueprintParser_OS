export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ─── Tool Use Types ────────────────────────────────────────
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    required?: string[];
  };
}

export interface ToolCallBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

/** Events emitted during tool-use streaming */
export type ToolStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; name: string; id: string }
  | { type: "tool_call_result"; name: string; id: string; result: string }
  | { type: "done" };

export interface LLMStreamOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface LLMToolUseOptions extends LLMStreamOptions {
  tools: ToolDefinition[];
  executeToolCall: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  maxToolRounds?: number; // safety limit, default 10
}

export interface LLMClient {
  provider: string;
  streamChat(options: LLMStreamOptions): AsyncIterable<string>;
  streamChatWithTools?(options: LLMToolUseOptions): AsyncIterable<ToolStreamEvent>;
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
