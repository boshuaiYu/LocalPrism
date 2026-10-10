import { describe, expect, it } from "vitest";
import {
  appendTeachAskReplyNote,
  buildTeachAskPrompt,
  diagnosticMessageFromTeachSource,
  stripTeachAskReplyNote,
} from "@/lib/latex-teach-ask";
import {
  EMPTY_PROJECT_LESSON,
  lessonRefForDiagnostic,
  lessonRefForSelection,
  resolveLesson,
} from "@/lib/latex-teaching";

const figureSelection = String.raw`\begin{figure}[htbp]`;

function figureLesson(language: "en" | "zh") {
  const ref = lessonRefForSelection({
    selected: figureSelection,
    line: figureSelection,
    selectionStartInLine: 0,
    selectionEndInLine: figureSelection.length,
  });
  if (!ref) throw new Error("figure lesson missing");
  return resolveLesson(ref, language);
}

describe("buildTeachAskPrompt", () => {
  it("builds a Chinese construct prompt with the selection when it is known", () => {
    const lesson = figureLesson("zh");
    const prompt = buildTeachAskPrompt({
      lesson,
      language: "zh",
      selectedText: figureSelection,
    });

    expect(prompt).toContain("请讲解这个 LaTeX 结构");
    expect(prompt).toContain(lesson.tag);
    expect(prompt).toContain("浮动图片环境");
    expect(prompt).toContain(lesson.what);
    expect(prompt).toContain("选中文本");
    expect(prompt).toContain(figureSelection);
    expect(prompt).not.toContain("报错信息");
  });

  it("builds an English construct prompt and omits an unknown selection", () => {
    const lesson = figureLesson("en");
    const prompt = buildTeachAskPrompt({
      lesson,
      language: "en",
      selectedText: "   ",
    });

    expect(prompt).toContain("Explain this LaTeX construct.");
    expect(prompt).toContain(lesson.tag);
    expect(prompt).toContain("Floating figure");
    expect(prompt).toContain(lesson.what);
    expect(prompt).not.toContain("Selected text");
  });

  it("builds an error prompt from the tag, title, detail, and diagnostic", () => {
    const message = "File `miss.png' not found";
    const ref = lessonRefForDiagnostic(message);
    const lesson = resolveLesson(ref, "en");
    const prompt = buildTeachAskPrompt({
      lesson,
      language: "en",
      detail: ref.kind === "error" ? ref.detail : "",
      diagnosticMessage: diagnosticMessageFromTeachSource(
        `diag:${ref.kind === "error" ? ref.id : "x"}:${message}`,
        "error",
      ),
    });

    expect(prompt).toContain("Explain this LaTeX error");
    expect(prompt).toContain(lesson.tag);
    expect(prompt).toContain("Missing file");
    expect(prompt).toContain("Detail: miss.png");
    expect(prompt).toContain(`Message: ${message}`);
    expect(prompt).not.toContain("Selected text");
  });

  it("does not repeat a diagnostic that is already the detail", () => {
    const prompt = buildTeachAskPrompt({
      lesson: {
        kind: "error",
        tag: "! Error",
        title: "Generic",
        what: "unused",
      },
      language: "zh",
      detail: "Something broke",
      diagnosticMessage: "Something broke",
    });

    expect(prompt).toContain("请讲解这个 LaTeX 报错");
    expect(prompt).toContain("细节：Something broke");
    expect(prompt).not.toContain("报错信息");
    expect(prompt.match(/Something broke/g)).toHaveLength(1);
  });

  it("builds a guide prompt from the title and explanation only", () => {
    const lesson = resolveLesson(EMPTY_PROJECT_LESSON, "zh");
    const prompt = buildTeachAskPrompt({
      lesson,
      language: "zh",
      selectedText: figureSelection,
      diagnosticMessage: "File `miss.png' not found",
    });

    expect(prompt).toContain("请讲解这份 LaTeX 入门引导");
    expect(prompt).toContain("一份最小的文稿");
    expect(prompt).toContain(lesson.what);
    expect(prompt).not.toContain(figureSelection);
    expect(prompt).not.toContain("miss.png");
  });

  it("reads diagnostic text from diag and compile source keys", () => {
    expect(
      diagnosticMessageFromTeachSource(
        "diag:file-not-found:File `miss.png' not found",
        "error",
      ),
    ).toBe("File `miss.png' not found");
    expect(
      diagnosticMessageFromTeachSource("compile:0:Emergency stop", "error"),
    ).toBe("Emergency stop");
    expect(diagnosticMessageFromTeachSource("sel:0:12", "construct")).toBe("");
    expect(diagnosticMessageFromTeachSource("guide:empty", "guide")).toBe("");
    expect(diagnosticMessageFromTeachSource("diag:1", "error")).toBe("");
  });

  it("adds a reply-format note for the model and strips it back off", () => {
    const lesson = "请讲解这个 LaTeX 结构。";
    const zh = appendTeachAskReplyNote(lesson, "zh");
    const en = appendTeachAskReplyNote("Explain this LaTeX construct.", "en");

    expect(zh).toContain("回复格式：");
    expect(zh).toContain("$$...$$");
    expect(zh).toContain("latex 代码块");
    expect(zh).not.toContain("```");
    expect(en).toContain("Reply format:");
    expect(en).toContain("fenced latex code block");
    expect(stripTeachAskReplyNote(zh)).toBe(lesson);
    expect(stripTeachAskReplyNote(en)).toBe("Explain this LaTeX construct.");
    expect(stripTeachAskReplyNote(`${zh}\n`)).toBe(lesson);
    expect(stripTeachAskReplyNote(`${zh}\r\n`)).toBe(lesson);
    expect(stripTeachAskReplyNote(`${en} \n`)).toBe(
      "Explain this LaTeX construct.",
    );
    expect(appendTeachAskReplyNote(zh, "zh")).toBe(zh);
    expect(stripTeachAskReplyNote(lesson)).toBe(lesson);
    expect(stripTeachAskReplyNote(`${lesson}\n`)).toBe(`${lesson}\n`);
  });
});
