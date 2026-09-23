import { describe, expect, it } from "vitest";
import type { ClaudeStreamMessage } from "@/stores/claude-chat-store";
import {
  canRewindTo,
  rewindAnchor,
  rewindKeepEnd,
  rewindMatchText,
  rewindTextsMatch,
} from "@/lib/chat-rewind";

function user(text: string, extra: Partial<ClaudeStreamMessage> = {}) {
  return {
    type: "user" as const,
    message: { content: [{ type: "text" as const, text }] },
    ...extra,
  };
}

function assistant(text: string, extra: Partial<ClaudeStreamMessage> = {}) {
  return {
    type: "assistant" as const,
    message: { content: [{ type: "text" as const, text }] },
    ...extra,
  };
}

describe("chat rewind", () => {
  it("strips editor context so a displayed prompt matches the stored prompt", () => {
    expect(rewindMatchText("@main.tex:4:1-4:8\nRewrite the abstract")).toBe(
      "Rewrite the abstract",
    );
    expect(
      rewindTextsMatch(
        rewindMatchText("@main.tex:4:1-4:8\nRewrite the abstract"),
        rewindMatchText(
          "[Currently open file: main.tex]\n\nRewrite the abstract",
        ),
      ),
    ).toBe(true);
  });

  it("keeps the selected user message and drops the later reply", () => {
    const messages = [
      user("First question"),
      assistant("First answer"),
      user("Second question"),
      assistant("Second answer"),
    ];
    expect(rewindKeepEnd(messages, 2)).toBe(2);
    expect(canRewindTo(messages, 2)).toBe(true);
    expect(canRewindTo(messages, 3)).toBe(false);
    expect(rewindAnchor(messages, 2)).toMatchObject({
      role: "user",
      text: "Second question",
      ordinal: 1,
      userTurnOrdinal: 2,
    });
  });

  it("keeps tool results that belong to the selected assistant message", () => {
    const messages: ClaudeStreamMessage[] = [
      user("Edit the section"),
      assistant("I'll edit it", {
        message: {
          content: [
            { type: "text", text: "I'll edit it" },
            { type: "tool_use", id: "tool-1", name: "Edit" },
          ],
        },
      }),
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }],
        },
      },
      user("Thanks"),
    ];
    expect(rewindKeepEnd(messages, 1)).toBe(2);
    expect(rewindAnchor(messages, 1)?.role).toBe("assistant");
  });

  it("keeps the rest of a Codex turn when the click is mid-turn", () => {
    const messages = [
      user("Draft", { codexTurnId: "turn-1" }),
      assistant("Drafted", { codexTurnId: "turn-1" }),
      user("Revise", { codexTurnId: "turn-2" }),
      assistant("Revised", { codexTurnId: "turn-2" }),
    ];
    expect(rewindKeepEnd(messages, 0)).toBe(1);
    expect(rewindAnchor(messages, 0)).toMatchObject({
      codexTurnId: "turn-1",
      userTurnOrdinal: 1,
    });
    expect(canRewindTo(messages, 0)).toBe(true);
  });

  it("counts repeated prompts separately", () => {
    const messages = [
      user("Continue"),
      assistant("Once"),
      user("Continue"),
      assistant("Twice"),
    ];
    expect(rewindAnchor(messages, 0)?.ordinal).toBe(1);
    expect(rewindAnchor(messages, 2)?.ordinal).toBe(2);
  });
});
