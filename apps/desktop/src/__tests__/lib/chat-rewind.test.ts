import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClaudeStreamMessage } from "@/stores/claude-chat-store";
import {
  canRewindTo,
  rewindAnchor,
  rewindKeepEnd,
  rewindMatchText,
  rewindTextsMatch,
  rewindUserResendPrompt,
} from "@/lib/chat-rewind";
import {
  appendTeachAskReplyNote,
  buildTeachAskPrompt,
  teachAskReplyNote,
} from "@/lib/latex-teach-ask";
import { lessonRefForSelection, resolveLesson } from "@/lib/latex-teaching";
import { applyReplyStyleToPrompt } from "@/lib/reply-mode";

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
  it("matches a saved transcript prompt to the visible user text", () => {
    const stored = [
      "[Reply mode: academic-polish. Follow this speaking style for this turn only. Do not rewrite earlier messages.]",
      "你是一个学术 LaTeX 论文润色的智能体。",
      "",
      "[Currently open file: main.tex. Location only — do not read this file unless the user asked to use the document. File tools must use paths relative to the current working directory, such as main.tex.]",
      "[Selection: @main.tex:4:1-4:8]",
      "[Selected text:",
      "Hello abstract",
      "]",
      "",
      "请回复 OK",
    ].join("\n");
    expect(rewindMatchText(stored)).toBe("请回复 OK");
    expect(rewindMatchText("@main.tex:4:1-4:8\n请回复 OK")).toBe("请回复 OK");
    expect(
      rewindTextsMatch(rewindMatchText(stored), rewindMatchText("请回复 OK")),
    ).toBe(true);
  });

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
    expect(
      rewindTextsMatch(
        "Rewrite the abstract carefully",
        "Rewrite the abstract carefully now",
      ),
    ).toBe(false);
  });

  it("matches a learning lesson to the saved prompt that ends with the reply-format note", () => {
    const lesson = "请讲解这个 LaTeX 结构。\n\n结构：figure\n标题：单行公式";
    const stored = appendTeachAskReplyNote(
      applyReplyStyleToPrompt(lesson, "peer-review", [
        { id: "peer-review", instructions: "自定义审稿口吻" },
      ]),
      "zh",
    );
    expect(stored).toContain("回复格式：");
    expect(rewindMatchText(stored)).toBe(rewindMatchText(lesson));
    expect(rewindMatchText(`${stored}\n`)).toBe(rewindMatchText(lesson));
    expect(rewindMatchText(`${stored}\r\n`)).toBe(rewindMatchText(lesson));
    expect(
      rewindTextsMatch(rewindMatchText(stored), rewindMatchText(lesson)),
    ).toBe(true);
    expect(
      rewindTextsMatch(
        rewindMatchText(lesson),
        rewindMatchText(`${lesson}更多`),
      ),
    ).toBe(false);
    expect(
      rewindMatchText(appendTeachAskReplyNote(`${lesson}更多`, "zh")),
    ).not.toBe(rewindMatchText(lesson));

    const messages = [
      user(stored),
      assistant("公式说明"),
      user(lesson),
      assistant("再讲一次"),
    ];
    expect(rewindAnchor(messages, 0)).toMatchObject({
      role: "user",
      text: rewindMatchText(lesson),
      ordinal: 1,
    });
    expect(rewindAnchor(messages, 2)?.ordinal).toBe(2);
  });

  it("matches a figure lesson ending in [htbp] when the saved prompt has a reply-style wrapper and the note", () => {
    const selectedText = String.raw`\begin{figure}[htbp]`;
    const ref = lessonRefForSelection({
      selected: selectedText,
      line: selectedText,
      selectionStartInLine: 0,
      selectionEndInLine: selectedText.length,
    });
    if (!ref) throw new Error("figure lesson missing");
    const lesson = buildTeachAskPrompt({
      lesson: resolveLesson(ref, "zh"),
      language: "zh",
      selectedText,
    });
    expect(lesson.trimEnd().endsWith("[htbp]")).toBe(true);
    const stored = appendTeachAskReplyNote(
      applyReplyStyleToPrompt(lesson, "peer-review"),
      "zh",
    );
    expect(stored).toContain("[Reply mode: peer-review.");
    expect(stored).toContain("[/Reply mode]");
    expect(stored.endsWith(teachAskReplyNote("zh"))).toBe(true);
    expect(rewindMatchText(lesson).length).toBeGreaterThan(0);
    expect(rewindMatchText(stored)).toBe(rewindMatchText(lesson));
    expect(rewindMatchText(`${stored}\n`)).toBe(rewindMatchText(lesson));
    expect(rewindMatchText(`${stored}\r\n`)).toBe(rewindMatchText(lesson));
    expect(rewindMatchText(stored.replace(/\n/g, "\r\n"))).toBe(
      rewindMatchText(lesson),
    );
    const storedEn = appendTeachAskReplyNote(
      applyReplyStyleToPrompt(lesson, "peer-review"),
      "en",
    );
    expect(rewindMatchText(`${storedEn}\r\n`)).toBe(rewindMatchText(lesson));

    const longLesson = `${"请讲解这个公式。".repeat(40)}\n\\begin{figure}[htbp]`;
    expect([...longLesson].length).toBeGreaterThan(280);
    const longStored = appendTeachAskReplyNote(
      applyReplyStyleToPrompt(longLesson, "peer-review"),
      "zh",
    );
    expect(rewindMatchText(longStored)).toBe(rewindMatchText(longLesson));
    expect([...rewindMatchText(longStored)].length).toBe(280);

    const messages = [user(stored), assistant("figure 说明")];
    expect(rewindAnchor(messages, 0)).toMatchObject({
      role: "user",
      text: rewindMatchText(lesson),
      ordinal: 1,
    });
  });

  it("keeps the Rust rewind notes identical to the i18n reply-format strings", () => {
    const rust = readFileSync(
      resolve(__dirname, "../../../src-tauri/src/claude.rs"),
      "utf8",
    );
    for (const language of ["en", "zh"] as const) {
      const note = teachAskReplyNote(language);
      expect(note.length).toBeGreaterThan(0);
      expect(rust).toContain(`"${note}"`);
    }
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
          content: [
            { type: "tool_result", tool_use_id: "tool-1", content: "ok" },
          ],
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

  it("asks to resend a user turn whose reply was removed", () => {
    const messages = [user("你好"), assistant("Hello"), user("Next")];
    expect(rewindUserResendPrompt(messages, 0)).toBe("你好");
    expect(rewindUserResendPrompt(messages, 1)).toBeNull();
  });

  it("does not resend a Codex turn that still includes its reply", () => {
    const messages = [
      user("Draft", { codexTurnId: "turn-1" }),
      assistant("Drafted", { codexTurnId: "turn-1" }),
      user("Revise", { codexTurnId: "turn-2" }),
    ];
    expect(rewindUserResendPrompt(messages, 0)).toBeNull();
    expect(rewindUserResendPrompt(messages, 2)).toBe("Revise");
  });
});
