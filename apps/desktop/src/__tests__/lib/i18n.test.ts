import { describe, expect, it } from "vitest";
import { translate } from "@/lib/i18n";

describe("translate", () => {
  it("keeps English settings labels and switches them to Chinese", () => {
    expect(translate("en", "settings.title")).toBe("Settings");
    expect(translate("zh", "settings.title")).toBe("设置");
    expect(translate("zh", "settings.providers")).toBe("服务商");
    expect(translate("zh", "chat.compress")).toBe("压缩更早的消息");
    expect(translate("en", "onboarding.skip")).toBe("Skip");
    expect(translate("en", "onboarding.getStarted")).toBe("Get started");
    expect(translate("en", "chrome.outline")).toBe("Outline");
    expect(translate("zh", "chrome.outline")).toBe("大纲");
    expect(translate("en", "chrome.environment")).toBe("Environment");
    expect(translate("zh", "chrome.environment")).toBe("环境");
    expect(translate("zh", "settings.environment")).toBe("环境");
    expect(translate("zh", "editor.openIn")).toBe("在编辑器中打开");
    expect(translate("en", "editor.openWith", { name: "Codex" })).toBe(
      "Open in Codex",
    );
    expect(translate("zh", "editor.openWith", { name: "Codex" })).toBe(
      "在 Codex 中打开",
    );
    expect(translate("en", "editor.choose")).toBe("Choose editor");
    expect(translate("zh", "editor.choose")).toBe("选择编辑器");
    expect(translate("zh", "env.pythonEnvironment")).toBe("Python 环境 (uv)");
  });

  it("interpolates named values", () => {
    expect(
      translate("en", "providers.signInTo", { name: "Claude Official" }),
    ).toBe("Sign in to Claude Official");
    expect(translate("zh", "chat.summaryMeta", { count: 4 })).toContain("4");
  });
});
