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
  });

  it("interpolates named values", () => {
    expect(
      translate("en", "providers.signInTo", { name: "Claude Official" }),
    ).toBe("Sign in to Claude Official");
    expect(translate("zh", "chat.summaryMeta", { count: 4 })).toContain("4");
  });
});
