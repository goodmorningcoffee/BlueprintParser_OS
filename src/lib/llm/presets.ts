export interface ProviderPreset {
  label: string;
  models: { id: string; label: string }[];
  defaultModel: string;
  needsKey: boolean;
  needsUrl: boolean;
  keyPrefix?: string;
}

export const LLM_PRESETS: Record<string, ProviderPreset> = {
  groq: {
    label: "Groq (Free)",
    models: [
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (best quality)" },
      { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B (fastest)" },
      { id: "mixtral-8x7b-32768", label: "Mixtral 8x7B (32K context)" },
    ],
    defaultModel: "llama-3.3-70b-versatile",
    needsKey: true,
    needsUrl: false,
    keyPrefix: "gsk_",
  },
  anthropic: {
    label: "Anthropic (Claude)",
    models: [
      { id: "claude-opus-4-6-20250501", label: "Claude Opus 4.6 (most capable, 1M context)" },
      { id: "claude-sonnet-4-6-20250514", label: "Claude Sonnet 4.6 (fast + capable)" },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (fastest + cheapest)" },
    ],
    defaultModel: "claude-opus-4-6-20250501",
    needsKey: true,
    needsUrl: false,
    keyPrefix: "sk-ant-",
  },
  openai: {
    label: "OpenAI (GPT)",
    models: [
      { id: "gpt-4o-mini", label: "GPT-4o Mini (fast + cheap)" },
      { id: "gpt-4o", label: "GPT-4o (best quality)" },
      { id: "gpt-4.1-nano", label: "GPT-4.1 Nano (cheapest)" },
    ],
    defaultModel: "gpt-4o-mini",
    needsKey: true,
    needsUrl: false,
    keyPrefix: "sk-",
  },
  custom: {
    label: "Custom / Ollama",
    models: [],
    defaultModel: "",
    needsKey: false,
    needsUrl: true,
  },
};

export const PROVIDER_ORDER = ["groq", "anthropic", "openai", "custom"] as const;
