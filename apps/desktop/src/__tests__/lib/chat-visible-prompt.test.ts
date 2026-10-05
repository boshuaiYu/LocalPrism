import { describe, expect, it } from "vitest";
import { ACADEMIC_POLISH_INSTRUCTIONS } from "@/lib/agent-presets";
import { applyReplyStyleToPrompt } from "@/lib/reply-mode";
import { visibleUserPromptText } from "@/lib/chat-visible-prompt";

const AMBIENT_FILE =
  "[Currently open file: main.tex. Location only — do not read this file unless the user asked to use the document. File tools must use paths relative to the current working directory, such as main.tex.]";

describe("visibleUserPromptText", () => {
  it("leaves an ordinary user message unchanged", () => {
    const text = "第二轮上下文测试，请只回复 B。";
    expect(visibleUserPromptText(text)).toBe(text);
  });

  it("hides a leading open-file header and keeps a selection label", () => {
    const stored = [
      "[Currently open file: main.tex]",
      "[Selection: Pasted image]",
      "[Selected text:",
      "[Temporary pasted image: C:\\\\Temp\\\\paste.png]",
      "Use this image file as visual context for the user's message.",
      "]",
      "",
      "Please inspect this image",
    ].join("\n");
    expect(visibleUserPromptText(stored)).toBe(
      "Pasted image\nPlease inspect this image",
    );
    expect(visibleUserPromptText(visibleUserPromptText(stored))).toBe(
      "Pasted image\nPlease inspect this image",
    );
  });

  it("hides reply-mode instructions and the ambient file line from history", () => {
    const userText = "第二轮上下文测试，请只回复 B。";
    const stored = [
      "[Reply mode: academic-polish. Follow this speaking style for this turn only. Do not rewrite earlier messages.]",
      ACADEMIC_POLISH_INSTRUCTIONS,
      "",
      AMBIENT_FILE,
      "",
      userText,
    ].join("\n");
    expect(visibleUserPromptText(stored)).toBe(userText);
    expect(visibleUserPromptText(stored)).not.toContain("Currently open file");
    expect(visibleUserPromptText(stored)).not.toContain("Reply mode");
    expect(visibleUserPromptText(stored)).not.toContain("保持原意");
  });

  it("hides an older instruction block that sits above the ambient file line", () => {
    const userText = "第二轮上下文测试，请只回复 B。";
    const stored = [
      "保持原意、术语、数字、单位、统计量和论断强度。",
      "原样保留 LaTeX：命令、环境、公式、标签。",
      "不编造引用、数据、结果或参考文献。",
      "用户选中了片段时，只修改该片段。",
      "输出：",
      "可直接粘贴的修订文本，LaTeX 保持完整。",
      "简短列出值得注意的修改。",
      AMBIENT_FILE,
      userText,
    ].join("\n");
    expect(visibleUserPromptText(stored)).toBe(userText);
  });

  it("strips a marked reply-mode block and keeps the text sent after it", () => {
    const styled = applyReplyStyleToPrompt("请审这一段", "peer-review", [
      { id: "peer-review", instructions: "自定义审稿口吻" },
    ]);
    expect(styled).toContain("自定义审稿口吻");
    expect(styled).toContain("[/Reply mode]");
    expect(visibleUserPromptText(styled)).toBe("请审这一段");
  });

  it("strips built-in reply-mode instructions from older prompts without a file line", () => {
    const stored = [
      "[Reply mode: academic-polish. Follow this speaking style for this turn only. Do not rewrite earlier messages.]",
      ACADEMIC_POLISH_INSTRUCTIONS,
      "",
      "只改摘要。",
    ].join("\n");
    expect(visibleUserPromptText(stored)).toBe("只改摘要。");
  });
});
