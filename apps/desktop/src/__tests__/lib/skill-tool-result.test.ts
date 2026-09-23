import { describe, expect, it } from "vitest";
import {
  isSkillInstructionDump,
  isSkillToolName,
  isSkillToolResultEcho,
  collapseRepeatedSkillToolMessages,
  skillToolDisplayName,
} from "@/lib/skill-tool-result";
import type { ClaudeStreamMessage } from "@/stores/claude-chat-store";

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

  it("keeps one Skill card per tool id and per identical init in a turn", () => {
    const skill = (id: string, skillName: string): ClaudeStreamMessage => ({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id,
            name: "Skill",
            input: { skill: skillName },
          },
        ],
      },
    });
    const user = (text: string): ClaudeStreamMessage => ({
      type: "user",
      message: { content: [{ type: "text", text }] },
    });

    const replayed = [
      user("install the skill"),
      skill("toolu_1", "skill"),
      skill("toolu_1", "init"),
      skill("toolu_2", "init"),
      skill("toolu_3", "init"),
      skill("toolu_4", "init"),
      skill("toolu_5", "init"),
    ];
    const collapsed = collapseRepeatedSkillToolMessages(replayed);
    const cards = collapsed.filter((message) => message.type === "assistant");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.message?.content?.[0]?.id).toBe("toolu_5");
    expect(cards[0]?.message?.content?.[0]?.input).toEqual({ skill: "init" });

    const unchanged = collapseRepeatedSkillToolMessages(collapsed);
    expect(unchanged).toBe(collapsed);

    const stringUser = {
      type: "user",
      message: { content: "run init again" },
    } as unknown as ClaudeStreamMessage;
    const nextTurn = collapseRepeatedSkillToolMessages([
      ...collapsed,
      stringUser,
      skill("toolu_9", "init"),
    ]);
    expect(
      nextTurn.filter((message) => message.type === "assistant"),
    ).toHaveLength(2);

    const readTwice: ClaudeStreamMessage[] = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_read",
              name: "Read",
              input: { file_path: "a.tex" },
            },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_read",
              name: "Read",
              input: { file_path: "b.tex" },
            },
            {
              type: "tool_use",
              id: "toolu_other",
              name: "Skill",
              input: { skill: "academic-pipeline", args: "draft" },
            },
          ],
        },
      },
    ];
    const reads = collapseRepeatedSkillToolMessages(readTwice);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.message?.content?.map((block) => block.name)).toEqual([
      "Read",
      "Skill",
    ]);
    expect(reads[0]?.message?.content?.[0]?.input).toEqual({
      file_path: "b.tex",
    });
  });
});
