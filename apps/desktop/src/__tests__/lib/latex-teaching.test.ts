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
import {
  bindTeachDocumentScope,
  useLatexTeachStore,
} from "@/stores/latex-teach-store";
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

  it("keeps an explain lesson ahead of a selection that is still active", () => {
    const figure = lessonRefForSelection({
      selected: String.raw`\begin{figure}`,
      line: String.raw`\begin{figure}`,
      selectionStartInLine: 0,
      selectionEndInLine: 13,
    })!;
    const missing = lessonRefForDiagnostic("File `miss.png' not found");
    useSettingsStore.getState().setLatexTeaching(true);

    useLatexTeachStore.getState().present(figure, "sel:1:14", {
      x: 10,
      y: 20,
      width: 30,
      height: 8,
    });
    expect(useLatexTeachStore.getState().lesson?.id).toBe("figure");

    useLatexTeachStore
      .getState()
      .forcePresent(missing, "compile:0:File `miss.png' not found", {
        x: 200,
        y: 40,
        width: 48,
        height: 16,
      });
    expect(useLatexTeachStore.getState().lesson?.id).toBe("file-not-found");
    expect(useLatexTeachStore.getState().anchor).toMatchObject({
      x: 200,
      y: 40,
    });

    useLatexTeachStore.getState().present(figure, "sel:1:14", {
      x: 1,
      y: 1,
      width: 1,
      height: 1,
    });
    useLatexTeachStore.getState().present(figure, "sel:20:34", {
      x: 2,
      y: 2,
      width: 2,
      height: 2,
    });
    expect(useLatexTeachStore.getState().lesson?.id).toBe("file-not-found");
    expect(useLatexTeachStore.getState().anchor).toMatchObject({
      x: 200,
      y: 40,
    });
    expect(useLatexTeachStore.getState().sourceKey).toBe(
      "compile:0:File `miss.png' not found",
    );

    useLatexTeachStore.getState().dismiss();
    useLatexTeachStore.getState().present(figure, "sel:1:14");
    expect(useLatexTeachStore.getState().open).toBe(true);
    expect(useLatexTeachStore.getState().lesson?.id).toBe("figure");
  });

  it("lets a selection replace an open guide", () => {
    const figure = lessonRefForSelection({
      selected: String.raw`\begin{figure}`,
      line: String.raw`\begin{figure}`,
      selectionStartInLine: 0,
      selectionEndInLine: 13,
    })!;
    useSettingsStore.getState().setLatexTeaching(true);
    useLatexTeachStore
      .getState()
      .forcePresent({ kind: "guide", id: "empty-project" }, "guide:empty");

    useLatexTeachStore.getState().present(figure, "sel:0:13");
    expect(useLatexTeachStore.getState().lesson?.id).toBe("figure");
  });

  it("clears an open lesson when the project or active file changes", () => {
    const scope = createTeachScope();
    bindTeachDocumentScope(scope);
    useSettingsStore.getState().setLatexTeaching(true);
    const missing = lessonRefForDiagnostic("File `miss.png' not found");
    const show = () => {
      useLatexTeachStore
        .getState()
        .forcePresent(missing, "diag:11:File `miss.png' not found", {
          x: 40,
          y: 80,
          width: 20,
          height: 12,
        });
    };

    show();
    expect(useLatexTeachStore.getState().open).toBe(true);
    expect(useLatexTeachStore.getState().anchor).toMatchObject({ x: 40 });

    scope.setState({ activeFileId: "chapter.tex" });
    expect(useLatexTeachStore.getState().open).toBe(false);
    expect(useLatexTeachStore.getState().lesson).toBeNull();
    expect(useLatexTeachStore.getState().sourceKey).toBeNull();
    expect(useLatexTeachStore.getState().anchor).toBeNull();

    show();
    scope.setState({ projectRoot: "/tmp/localprism-b" });
    expect(useLatexTeachStore.getState().lesson).toBeNull();

    show();
    scope.setState({ projectGeneration: 2 });
    expect(useLatexTeachStore.getState().open).toBe(false);

    show();
    scope.setState({ cursorPosition: 40 });
    expect(useLatexTeachStore.getState().open).toBe(true);
    expect(useLatexTeachStore.getState().lesson?.id).toBe("file-not-found");

    scope.setState({ activeFileId: "chapter.tex" });
    expect(useLatexTeachStore.getState().lesson?.id).toBe("file-not-found");

    const ignored = createTeachScope();
    bindTeachDocumentScope(ignored);
    ignored.setState({ activeFileId: "other.tex" });
    expect(useLatexTeachStore.getState().open).toBe(true);
  });
});

interface TeachScopeState {
  projectRoot: string | null;
  projectGeneration: number;
  activeFileId: string;
  cursorPosition: number;
}

function createTeachScope() {
  let state: TeachScopeState = {
    projectRoot: "/tmp/localprism-a",
    projectGeneration: 1,
    activeFileId: "main.tex",
    cursorPosition: 0,
  };
  const listeners = new Set<
    (state: TeachScopeState, previous: TeachScopeState) => void
  >();
  return {
    getState: () => state,
    setState(partial: Partial<TeachScopeState>) {
      const previous = state;
      state = { ...state, ...partial };
      for (const listener of listeners) listener(state, previous);
    },
    subscribe(
      listener: (state: TeachScopeState, previous: TeachScopeState) => void,
    ) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
