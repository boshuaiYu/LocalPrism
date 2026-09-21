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
      "cursor",
      "custom",
    ]);
    expect(
      THIRD_PARTY_PRESETS.filter((preset) => preset.id !== "cursor").every(
        (preset) => preset.apiFormat === "anthropic",
      ),
    ).toBe(true);
    expect(thirdPartyPresetById("cursor")).toMatchObject({
      name: "Cursor",
      apiFormat: "openai_chat",
      model: "composer-2.5",
    });
  });

  it("looks up a preset by id", () => {
    expect(thirdPartyPresetById("kimi")?.baseUrl).toContain("moonshot");
    expect(thirdPartyPresetById("missing")).toBeUndefined();
  });
});
