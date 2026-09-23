import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_PRESETS } from "@/lib/agent-presets";
import { skillPackDisplayName } from "@/lib/default-skill-packs";
import { translate } from "@/lib/i18n";

describe("translate", () => {
  it("keeps English settings labels and switches them to Chinese", () => {
    expect(translate("en", "settings.title")).toBe("Settings");
    expect(translate("zh", "settings.title")).toBe("设置");
    expect(translate("zh", "settings.providers")).toBe("服务商");
    expect(translate("zh", "chat.compress")).toBe("压缩更早的消息");
    expect(translate("en", "chat.scrollToBottom")).toBe("Scroll to latest");
    expect(translate("zh", "chat.scrollToBottom")).toBe("跳到最新");
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

  it("translates the skills and agents tour in English and Chinese", () => {
    const keys = [
      "tour.skills.body",
      "tour.skillCategories.body",
      "tour.skillImport.body",
      "tour.agents.body",
      "tour.agentRoles.body",
      "tour.agentSkills.body",
      "tour.updates.body",
    ] as const;
    for (const key of keys) {
      expect(translate("en", key).length).toBeGreaterThan(10);
      expect(translate("zh", key).length).toBeGreaterThan(4);
      expect(translate("zh", key)).not.toBe(translate("en", key));
    }
    for (const id of [
      "paper-spine",
      "academic-research-skills",
      "nature-skills",
      "scientific-agent-skills",
      "paper-humanizer-skill",
    ] as const) {
      const name = skillPackDisplayName(id);
      expect(translate("en", "tour.skillCategories.body")).toContain(name);
      expect(translate("zh", "tour.skillCategories.body")).toContain(name);
    }
    for (const preset of BUILTIN_AGENT_PRESETS) {
      expect(translate("en", "tour.agentRoles.body")).toContain(preset.name);
      expect(translate("zh", "tour.agentRoles.body")).toContain(preset.name);
      expect(translate("en", "tour.agentRoles.body")).toContain(
        preset.titleSecondary,
      );
      expect(translate("zh", "tour.agentRoles.body")).toContain(
        preset.titleSecondary,
      );
    }
    expect(translate("en", "tour.agentRoles.body").toLowerCase()).toContain(
      "settings list",
    );
    expect(translate("zh", "tour.agentRoles.body")).toContain("设置");
    expect(translate("en", "tour.agentSkills.body").toLowerCase()).toContain(
      "context",
    );
    expect(translate("zh", "tour.agentSkills.body")).toContain("上下文");
    expect(translate("en", "tour.updates.body").toLowerCase()).toContain(
      "checks for updates",
    );
    expect(translate("zh", "tour.updates.body")).toContain("检查更新");
    expect(translate("en", "tour.updates.body")).not.toContain("Beta");
    expect(translate("zh", "tour.updates.body")).not.toContain("Beta");
    expect(translate("en", "tour.skills.body").toLowerCase()).toContain(
      "callable",
    );
  });

  it("interpolates named values", () => {
    expect(
      translate("en", "providers.signInTo", { name: "Claude Official" }),
    ).toBe("Sign in to Claude Official");
    expect(translate("zh", "chat.summaryMeta", { count: 4 })).toContain("4");
  });
});
