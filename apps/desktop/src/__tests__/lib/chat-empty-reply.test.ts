import { describe, expect, it } from "vitest";
import { localizeChatNotice } from "@/lib/chat-empty-reply";

describe("localizeChatNotice", () => {
  it("translates an empty Codex reply without naming Cursor models", () => {
    const en = localizeChatNotice("localprism:empty-reply", "en");
    const zh = localizeChatNotice("localprism:empty-reply", "zh");
    expect(en).toMatch(/without a reply/i);
    expect(en).not.toMatch(/GPT-5/);
    expect(zh).toContain("模型选择器");
    expect(zh).not.toMatch(/GPT-5/);
  });

  it("rewrites the leaked GPT-5.5 / GPT-5.6 Sol sentence", () => {
    const text = localizeChatNotice(
      "The model finished without any visible text. Switch to GPT-5.5 or GPT-5.6 Sol and try again.",
      "zh",
    );
    expect(text).not.toMatch(/GPT-5/);
    expect(text).toContain("模型选择器");
  });

  it("rewrites a no-output timeout without recommending a model", () => {
    const text = localizeChatNotice(
      "localprism:no-output-timeout:gpt-5.4",
      "en",
    );
    expect(text).toContain("gpt-5.4");
    expect(text).toMatch(/model picker/i);
    expect(text).not.toMatch(/GPT-5\.5|GPT-5\.6 Sol/);
  });
});
