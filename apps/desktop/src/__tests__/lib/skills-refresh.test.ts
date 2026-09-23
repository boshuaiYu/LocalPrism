import { describe, expect, it } from "vitest";
import { shouldRefreshSkillsAfterTool } from "@/lib/skills-refresh";

describe("shouldRefreshSkillsAfterTool", () => {
  it("refreshes after the skill tool and skill file writes", () => {
    expect(shouldRefreshSkillsAfterTool("Skill", { skill: "init" })).toBe(true);
    expect(
      shouldRefreshSkillsAfterTool("Write", {
        file_path: "D:/LocalPrism/claude-home/skills/writer/SKILL.md",
      }),
    ).toBe(true);
    expect(
      shouldRefreshSkillsAfterTool("Edit", {
        path: "/papers/demo/.localprism/skills/writer/notes.md",
      }),
    ).toBe(true);
    expect(
      shouldRefreshSkillsAfterTool("Bash", {
        command: "cp -R ./writer ~/claude-home/skills/writer",
      }),
    ).toBe(true);
  });

  it("ignores ordinary file edits and reads", () => {
    expect(
      shouldRefreshSkillsAfterTool("Write", {
        file_path: "/papers/demo/main.tex",
      }),
    ).toBe(false);
    expect(
      shouldRefreshSkillsAfterTool("Read", {
        file_path: "D:/LocalPrism/claude-home/skills/writer/SKILL.md",
      }),
    ).toBe(false);
    expect(shouldRefreshSkillsAfterTool("Bash", { command: "ls" })).toBe(false);
  });
});
