import { beforeEach, describe, expect, it } from "vitest";
import { newProjectFileTemplate } from "@/lib/new-project-file";
import {
  isStarterTex,
  lessonRefForDiagnostic,
  lessonRefForSelection,
  resolveLesson,
  shouldOfferEmptyGuide,
  shouldShowTeachEntry,
  shouldShowTeachPanel,
  teachActionForDiagnostic,
} from "@/lib/latex-teaching";
import { useLatexTeachStore } from "@/stores/latex-teach-store";
import { useSettingsStore } from "@/stores/settings-store";

const figureLine = String.raw`  \begin{figure}[htbp]`;

describe("latex teaching catalog", () => {
  beforeEach(() => {
    useSettingsStore.setState({ latexTeaching: false, uiLanguage: "zh" });
    useLatexTeachStore.getState().reset();
  });

  it("explains a selected figure environment in Chinese", () => {
    const ref = lessonRefForSelection({
      selected: String.raw`\begin{figure}[htbp]`,
      line: figureLine,
      selectionStartInLine: 2,
      selectionEndInLine: figureLine.length,
    });
    expect(ref).toMatchObject({ kind: "construct", id: "figure" });
    const lesson = resolveLesson(ref!, "zh");
    expect(lesson.title).toBe("浮动图片环境");
    expect(lesson.what).toContain("浮动");
    expect(lesson.points.some((point) => point.includes("[htbp]"))).toBe(true);
    expect(lesson.snippet).toContain(String.raw`\includegraphics`);
    expect(lesson.insertable).toBe(true);
    expect(resolveLesson(ref!, "en").title).toBe("Floating figure");
  });

  it("explains a construct when the selection is only the environment name", () => {
    const start = figureLine.indexOf("figure");
    const ref = lessonRefForSelection({
      selected: "figure",
      line: figureLine,
      selectionStartInLine: start,
      selectionEndInLine: start + "figure".length,
    });
    expect(ref?.id).toBe("figure");
  });

  it("ignores a prose selection that does not touch a command", () => {
    const line = String.raw`hello \section{A}`;
    expect(
      lessonRefForSelection({
        selected: "hello",
        line,
        selectionStartInLine: 0,
        selectionEndInLine: 5,
      }),
    ).toBeNull();
  });

  it("explains a missing image and keeps unknown messages teachable", () => {
    const missing = lessonRefForDiagnostic("File `miss.png' not found");
    expect(missing).toMatchObject({
      kind: "error",
      id: "file-not-found",
      detail: "miss.png",
    });
    const lesson = resolveLesson(missing, "zh");
    expect(lesson.title).toBe("找不到文件");
    expect(lesson.what).toContain("miss.png");
    expect(lesson.insertable).toBe(false);

    expect(
      lessonRefForDiagnostic("Undefined control sequence \\incldegraphics").id,
    ).toBe("undefined-control");
    expect(
      lessonRefForDiagnostic("! LaTeX Error: File `graphicx.sty' not found.")
        .id,
    ).toBe("package-not-found");
    expect(lessonRefForDiagnostic("Something odd happened").id).toBe("generic");
  });

  it("treats a skeleton tex file as an empty-project guide", () => {
    const blank = `\\documentclass[12pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}

\\begin{document}

% Start writing here.

\\end{document}
`;
    expect(isStarterTex(newProjectFileTemplate("main.tex", "tex"))).toBe(true);
    expect(isStarterTex(blank)).toBe(true);
    expect(isStarterTex("")).toBe(true);
    expect(
      isStarterTex(String.raw`\documentclass{article}
\begin{document}
Hello
\end{document}
`),
    ).toBe(false);
    expect(shouldOfferEmptyGuide(false, blank)).toBe(false);
    expect(shouldOfferEmptyGuide(true, blank)).toBe(true);
    expect(
      resolveLesson({ kind: "guide", id: "empty-project" }, "zh").title,
    ).toBe("一份最小的文稿");
  });

  it("hides every teach surface while the setting is off", () => {
    expect(shouldShowTeachEntry(false)).toBe(false);
    expect(shouldShowTeachPanel(false, true)).toBe(false);
    expect(
      teachActionForDiagnostic(false, "File `miss.png' not found"),
    ).toBeNull();

    const ref = lessonRefForDiagnostic("File `miss.png' not found");
    useLatexTeachStore.getState().present(ref, "sel:1:2");
    useLatexTeachStore.getState().forcePresent(ref, "diag:1");
    expect(useLatexTeachStore.getState().open).toBe(false);
  });

  it("opens from a selection or a diagnostic only after the setting is on", () => {
    const ref = lessonRefForSelection({
      selected: String.raw`\begin{figure}`,
      line: String.raw`\begin{figure}`,
      selectionStartInLine: 0,
      selectionEndInLine: 13,
    })!;
    useSettingsStore.getState().setLatexTeaching(true);

    useLatexTeachStore.getState().present(ref, "sel:1:8");
    expect(useLatexTeachStore.getState().open).toBe(true);

    useLatexTeachStore.getState().dismiss();
    expect(useLatexTeachStore.getState().open).toBe(false);
    useLatexTeachStore.getState().present(ref, "sel:1:8");
    expect(useLatexTeachStore.getState().open).toBe(true);

    const action = teachActionForDiagnostic(true, "File `miss.png' not found");
    expect(action?.ref.id).toBe("file-not-found");
    useLatexTeachStore.getState().dismiss();
    useLatexTeachStore.getState().forcePresent(action!.ref, action!.sourceKey);
    expect(useLatexTeachStore.getState().lesson?.id).toBe("file-not-found");
  });

  it("closes an open lesson when teaching is turned off", () => {
    useSettingsStore.getState().setLatexTeaching(true);
    useLatexTeachStore
      .getState()
      .forcePresent({ kind: "guide", id: "empty-project" }, "guide:empty");
    expect(useLatexTeachStore.getState().open).toBe(true);
    useSettingsStore.getState().setLatexTeaching(false);
    expect(useLatexTeachStore.getState().open).toBe(false);
    expect(useLatexTeachStore.getState().lesson).toBeNull();
  });
});
