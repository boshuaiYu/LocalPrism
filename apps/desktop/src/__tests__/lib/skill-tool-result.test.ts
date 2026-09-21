import { describe, expect, it } from "vitest";
import {
  isSkillInstructionDump,
  isSkillToolName,
  isSkillToolResultEcho,
  skillToolDisplayName,
} from "@/lib/skill-tool-result";

const dump = [
  "Base directory for this skill: D:\\LocalPrism\\claude-home\\skills\\academic-pipeline",
  "Academic Pipeline v3.22.0 — Full Academic Research Workflow Orchestrator",
  "Routing discipline (v3.9.2): see CLAUDE.md",
].join("\n");

describe("skill tool result helpers", () => {
  it("recognizes Skill tool names and dump prefixes", () => {
    expect(isSkillToolName("Skill")).toBe(true);
    expect(isSkillToolName("skill")).toBe(true);
    expect(isSkillToolName("Read")).toBe(false);
    expect(isSkillInstructionDump(dump)).toBe(true);
    expect(isSkillInstructionDump("Here are three papers.")).toBe(false);
    expect(skillToolDisplayName({ skill: "/academic-pipeline" })).toBe(
      "academic-pipeline",
    );
  });

  it("treats assistant echoes of the Skill tool result as dumps", () => {
    expect(
      isSkillToolResultEcho(dump, [{ type: "tool_result", content: dump }]),
    ).toBe(true);
    expect(
      isSkillToolResultEcho("Found 3 papers on industrial agents.", [
        { type: "tool_result", content: dump },
      ]),
    ).toBe(false);
    expect(
      isSkillToolResultEcho(
        [
          "三篇相关论文如下。",
          "Base directory for this skill: D:\\LocalPrism\\claude-home\\skills\\academic-pipeline",
        ].join("\n"),
        [{ type: "tool_result", content: dump }],
      ),
    ).toBe(false);
    expect(
      isSkillToolResultEcho("A".repeat(200), [
        { type: "tool_result", content: "A".repeat(200) },
      ]),
    ).toBe(false);
  });
});
