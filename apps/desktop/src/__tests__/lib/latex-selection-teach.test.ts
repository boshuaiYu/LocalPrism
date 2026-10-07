import { beforeEach, describe, expect, it } from "vitest";
import { translate } from "@/lib/i18n";
import { resolveLesson } from "@/lib/latex-teaching";
import {
  isSelectionTeachSource,
  releaseSelectionLessonForToolbar,
  selectionExplainAction,
} from "@/lib/latex-selection-teach";
import { useLatexTeachStore } from "@/stores/latex-teach-store";
import { useSettingsStore } from "@/stores/settings-store";

const figureLine = String.raw`  \begin{figure}[htbp]`;
const sectionLine = String.raw`\section{Intro}`;

describe("selection toolbar and teach float", () => {
  beforeEach(() => {
    useSettingsStore.setState({ latexTeaching: false, uiLanguage: "zh" });
    useLatexTeachStore.getState().reset();
  });

  it("does not auto-open a lesson when the selection toolbar is shown", () => {
    useSettingsStore.getState().setLatexTeaching(true);
    const explain = selectionExplainAction({
      teachingEnabled: true,
      isTex: true,
      from: 2,
      to: figureLine.length,
      selected: String.raw`\begin{figure}[htbp]`,
      line: figureLine,
      selectionStartInLine: 2,
      selectionEndInLine: figureLine.length,
    });
    expect(explain?.lesson.id).toBe("figure");

    releaseSelectionLessonForToolbar(useLatexTeachStore.getState());
    expect(useLatexTeachStore.getState().open).toBe(false);
    expect(useLatexTeachStore.getState().lesson).toBeNull();
  });

  it("closes a selection lesson when the Proofread toolbar takes the selection", () => {
    useSettingsStore.getState().setLatexTeaching(true);
    const explain = selectionExplainAction({
      teachingEnabled: true,
      isTex: true,
      from: 0,
      to: 13,
      selected: String.raw`\begin{figure}`,
      line: String.raw`\begin{figure}`,
      selectionStartInLine: 0,
      selectionEndInLine: 13,
    })!;
    useLatexTeachStore
      .getState()
      .forcePresent(explain.lesson, explain.sourceKey, {
        x: 8,
        y: 20,
        width: 40,
        height: 12,
      });
    expect(useLatexTeachStore.getState().open).toBe(true);

    releaseSelectionLessonForToolbar(useLatexTeachStore.getState());
    expect(useLatexTeachStore.getState().open).toBe(false);
  });

  it("keeps diagnostic, compile, and guide lessons when the toolbar appears", () => {
    useSettingsStore.getState().setLatexTeaching(true);
    const cases = [
      {
        lesson: {
          kind: "error" as const,
          id: "file-not-found",
          label: "file",
          detail: "miss.png",
        },
        sourceKey: "diag:file-not-found:File `miss.png' not found",
      },
      {
        lesson: {
          kind: "error" as const,
          id: "file-not-found",
          label: "file",
          detail: "miss.png",
        },
        sourceKey: "compile:0:File `miss.png' not found",
      },
      {
        lesson: { kind: "guide" as const, id: "empty-project" as const },
        sourceKey: "guide:empty",
      },
    ];

    for (const entry of cases) {
      useLatexTeachStore.getState().forcePresent(entry.lesson, entry.sourceKey);
      releaseSelectionLessonForToolbar(useLatexTeachStore.getState());
      expect(useLatexTeachStore.getState().open).toBe(true);
      expect(useLatexTeachStore.getState().sourceKey).toBe(entry.sourceKey);
      expect(isSelectionTeachSource(entry.sourceKey)).toBe(false);
    }
  });

  it("resolves Explain to a different lesson per construct, in zh and en", () => {
    const figure = selectionExplainAction({
      teachingEnabled: true,
      isTex: true,
      from: 2,
      to: figureLine.length,
      selected: String.raw`\begin{figure}[htbp]`,
      line: figureLine,
      selectionStartInLine: 2,
      selectionEndInLine: figureLine.length,
    });
    const section = selectionExplainAction({
      teachingEnabled: true,
      isTex: true,
      from: 0,
      to: sectionLine.length,
      selected: sectionLine,
      line: sectionLine,
      selectionStartInLine: 0,
      selectionEndInLine: sectionLine.length,
    });

    expect(figure?.lesson.id).toBe("figure");
    expect(section?.lesson.id).toBe("section");
    expect(figure?.sourceKey).toBe(`sel:2:${figureLine.length}`);
    expect(section?.sourceKey).not.toBe(figure?.sourceKey);

    expect(resolveLesson(figure!.lesson, "zh").title).toBe("浮动图片环境");
    expect(resolveLesson(figure!.lesson, "en").title).toBe("Floating figure");
    expect(resolveLesson(section!.lesson, "zh").title).toBe("章节标题");
    expect(resolveLesson(section!.lesson, "en").title).toBe("Section heading");
    expect(resolveLesson(section!.lesson, "zh").title).not.toBe(
      resolveLesson(figure!.lesson, "zh").title,
    );

    expect(translate("zh", "teach.entry")).toBe("讲解");
    expect(translate("en", "teach.entry")).toBe("Explain");
  });

  it("hides Explain when teaching is off, the file is not tex, or the selection is prose", () => {
    const figure = {
      from: 0,
      to: 13,
      selected: String.raw`\begin{figure}`,
      line: String.raw`\begin{figure}`,
      selectionStartInLine: 0,
      selectionEndInLine: 13,
    };
    expect(
      selectionExplainAction({
        teachingEnabled: false,
        isTex: true,
        ...figure,
      }),
    ).toBeNull();
    expect(
      selectionExplainAction({
        teachingEnabled: true,
        isTex: false,
        ...figure,
      }),
    ).toBeNull();
    expect(
      selectionExplainAction({
        teachingEnabled: true,
        isTex: true,
        from: 0,
        to: 5,
        selected: "hello",
        line: String.raw`hello \section{A}`,
        selectionStartInLine: 0,
        selectionEndInLine: 5,
      }),
    ).toBeNull();
  });

  it("opens the selection lesson only after an explicit Explain action", () => {
    useSettingsStore.getState().setLatexTeaching(true);
    const explain = selectionExplainAction({
      teachingEnabled: true,
      isTex: true,
      from: 0,
      to: sectionLine.length,
      selected: sectionLine,
      line: sectionLine,
      selectionStartInLine: 0,
      selectionEndInLine: sectionLine.length,
    })!;

    expect(useLatexTeachStore.getState().open).toBe(false);
    useLatexTeachStore
      .getState()
      .forcePresent(explain.lesson, explain.sourceKey, {
        x: 16,
        y: 48,
        width: 90,
        height: 18,
      });
    expect(useLatexTeachStore.getState().open).toBe(true);
    expect(useLatexTeachStore.getState().lesson?.id).toBe("section");
    expect(useLatexTeachStore.getState().sourceKey).toBe(
      `sel:0:${sectionLine.length}`,
    );
    expect(
      resolveLesson(useLatexTeachStore.getState().lesson!, "zh").what,
    ).toContain("编号");
  });
});
