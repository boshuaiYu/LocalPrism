import type { ProviderApiFormat } from "@/stores/provider-store";

export interface ThirdPartyPreset {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiFormat: ProviderApiFormat;
  note: string;
  editBaseUrl?: boolean;
}

/** Claude-CLI-friendly Anthropic-compatible presets shown as cards. */
export const THIRD_PARTY_PRESETS: ThirdPartyPreset[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    model: "deepseek-chat",
    apiFormat: "anthropic",
    note: "Anthropic-compatible DeepSeek endpoint.",
  },
  {
    id: "kimi",
    name: "Kimi",
    baseUrl: "https://api.moonshot.ai/anthropic",
    model: "kimi-k2-turbo-preview",
    apiFormat: "anthropic",
    note: "Moonshot / Kimi Anthropic-compatible endpoint.",
  },
  {
    id: "qwen",
    name: "Qwen",
    baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
    model: "qwen-plus",
    apiFormat: "anthropic",
    note: "Qwen Anthropic-compatible DashScope endpoint.",
  },
  {
    id: "glm",
    name: "GLM",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    model: "glm-4.5",
    apiFormat: "anthropic",
    note: "Zhipu BigModel Anthropic-compatible endpoint.",
  },
  {
    id: "siliconflow",
    name: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn",
    model: "deepseek-ai/DeepSeek-V3",
    apiFormat: "anthropic",
    note: "SiliconFlow Anthropic-compatible endpoint.",
  },
  {
    id: "gemini",
    name: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    apiFormat: "openai_chat",
    note: "Google Gemini OpenAI-compatible chat endpoint.",
  },
  {
    id: "ollama",
    name: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    model: "llama3.2",
    apiFormat: "openai_chat",
    note: "Local Ollama OpenAI-compatible endpoint.",
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiFormat: "openai_chat",
    editBaseUrl: true,
    note: "OpenAI-compatible chat completions. Defaults to api.openai.com/v1.",
  },
  {
    id: "custom",
    name: "Custom",
    baseUrl: "",
    model: "",
    apiFormat: "anthropic",
    editBaseUrl: true,
    note: "Paste any Anthropic-compatible base URL and model.",
  },
];

export function thirdPartyPresetById(
  id: string | null | undefined,
): ThirdPartyPreset | undefined {
  if (!id) return undefined;
  return THIRD_PARTY_PRESETS.find((preset) => preset.id === id);
}
