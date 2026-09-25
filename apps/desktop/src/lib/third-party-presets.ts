import type { MessageKey } from "@/lib/i18n";
import type { ProviderApiFormat } from "@/stores/provider-store";

export interface ThirdPartyPreset {
  id: string;
  name: string;
  /** Chrome label when `name` is not a product name, such as Custom. */
  nameKey?: MessageKey;
  baseUrl: string;
  model: string;
  apiFormat: ProviderApiFormat;
  note: MessageKey;
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
    note: "providers.preset.deepseek.note",
  },
  {
    id: "kimi",
    name: "Kimi",
    baseUrl: "https://api.moonshot.ai/anthropic",
    model: "kimi-k2-turbo-preview",
    apiFormat: "anthropic",
    note: "providers.preset.kimi.note",
  },
  {
    id: "qwen",
    name: "Qwen",
    baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
    model: "qwen-plus",
    apiFormat: "anthropic",
    note: "providers.preset.qwen.note",
  },
  {
    id: "glm",
    name: "GLM",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    model: "glm-4.5",
    apiFormat: "anthropic",
    note: "providers.preset.glm.note",
  },
  {
    id: "siliconflow",
    name: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn",
    model: "deepseek-ai/DeepSeek-V3",
    apiFormat: "anthropic",
    note: "providers.preset.siliconflow.note",
  },
  {
    id: "gemini",
    name: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    apiFormat: "openai_chat",
    note: "providers.preset.gemini.note",
  },
  {
    id: "ollama",
    name: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    model: "llama3.2",
    apiFormat: "openai_chat",
    note: "providers.preset.ollama.note",
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiFormat: "openai_chat",
    editBaseUrl: true,
    note: "providers.preset.openai.note",
  },
  {
    id: "custom",
    name: "Custom",
    nameKey: "providers.preset.custom.name",
    baseUrl: "",
    model: "",
    apiFormat: "anthropic",
    editBaseUrl: true,
    note: "providers.preset.custom.note",
  },
];

export function thirdPartyPresetById(
  id: string | null | undefined,
): ThirdPartyPreset | undefined {
  if (!id) return undefined;
  return THIRD_PARTY_PRESETS.find((preset) => preset.id === id);
}
