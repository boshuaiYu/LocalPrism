import { describe, expect, it } from "vitest";
import {
  THIRD_PARTY_PRESETS,
  thirdPartyPresetById,
} from "@/lib/third-party-presets";

describe("third-party presets", () => {
  it("ships a short Anthropic-compatible preset list plus Custom", () => {
    const ids = THIRD_PARTY_PRESETS.map((preset) => preset.id);
    expect(ids).toEqual([
      "deepseek",
      "kimi",
      "qwen",
      "glm",
      "siliconflow",
      "gemini",
      "ollama",
      "openai",
      "custom",
    ]);
    expect(ids).not.toContain("cursor");
    expect(
      THIRD_PARTY_PRESETS.filter(
        (preset) => !["gemini", "ollama", "openai"].includes(preset.id),
      ).every((preset) => preset.apiFormat === "anthropic"),
    ).toBe(true);
    expect(thirdPartyPresetById("openai")).toMatchObject({
      name: "OpenAI",
      apiFormat: "openai_chat",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      editBaseUrl: true,
    });
    expect(thirdPartyPresetById("gemini")?.apiFormat).toBe("openai_chat");
    expect(thirdPartyPresetById("ollama")?.apiFormat).toBe("openai_chat");
  });

  it("looks up a preset by id", () => {
    expect(thirdPartyPresetById("kimi")?.baseUrl).toContain("moonshot");
    expect(thirdPartyPresetById("missing")).toBeUndefined();
  });
});
