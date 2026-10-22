import { beforeEach, describe, expect, it } from "vitest";
import { newProjectFileTemplate } from "@/lib/new-project-file";
import {
  isStarterTex,
  lessonRefForDiagnostic,
  lessonRefForSelection,
  resolveLesson,
  sameTeachLesson,
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
    expect(
      isStarterTex(String.raw`\documentclass{article} % 50\% draft
\begin{document}
% \\ only a comment
\end{document}
`),
    ).toBe(true);
    expect(
      isStarterTex(String.raw`\documentclass{article}
\begin{document}
\\% a line break, then a comment
\end{document}
`),
    ).toBe(false);
    expect(
      isStarterTex(String.raw`\documentclass{article}
\begin{document}
50\% done
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

describe("latex teaching selection labels", () => {
  function selection(selected: string) {
    return {
      selected,
      line: selected,
      selectionStartInLine: 0,
      selectionEndInLine: selected.length,
    };
  }

  it("labels a selection that contains a matched begin and end as the whole environment", () => {
    const ref = lessonRefForSelection(
      selection(String.raw`\begin{equation} E = mc^{2} \end{equation}`),
    );
    expect(ref).toMatchObject({ kind: "construct", id: "equation" });
    const zh = resolveLesson(ref!, "zh");
    const en = resolveLesson(ref!, "en");
    expect(zh.tag).toBe("equation 环境");
    expect(zh.banner).toBe("已选中 equation 环境");
    expect(zh.title).toBe("单行公式");
    expect(en.tag).toBe("equation environment");
    expect(en.banner).toBe("Selected equation environment");
    expect(en.title).toBe("Displayed equation");
  });

  it("keeps the opening tag when only \\begin{equation} is selected", () => {
    const ref = lessonRefForSelection(selection(String.raw`\begin{equation}`))!;
    expect(ref).toMatchObject({
      kind: "construct",
      id: "equation",
      label: String.raw`\begin{equation}`,
    });
    expect(resolveLesson(ref, "zh").tag).toBe(String.raw`\begin{equation}`);
    expect(resolveLesson(ref, "zh").banner).toBe(
      String.raw`已选中 \begin{equation}`,
    );
    expect(resolveLesson(ref, "en").tag).toBe(String.raw`\begin{equation}`);
    expect(resolveLesson(ref, "en").banner).toBe(
      String.raw`Selected \begin{equation}`,
    );
  });

  it("keeps a single command label when the selection is one command", () => {
    const ref = lessonRefForSelection(selection(String.raw`\textbf{Hello}`))!;
    expect(ref).toMatchObject({
      kind: "construct",
      id: "textbf",
      label: String.raw`\textbf`,
    });
    expect(resolveLesson(ref, "zh").tag).toBe(String.raw`\textbf`);
    expect(resolveLesson(ref, "zh").banner).toBe(String.raw`已选中 \textbf`);
    expect(resolveLesson(ref, "en").tag).toBe(String.raw`\textbf`);
    expect(resolveLesson(ref, "en").banner).toBe(String.raw`Selected \textbf`);
  });

  it("labels a starred environment with the star kept on the name", () => {
    const ref = lessonRefForSelection(
      selection(String.raw`\begin{align*} a &= b \end{align*}`),
    )!;
    expect(ref).toMatchObject({ kind: "construct", id: "align" });
    expect(resolveLesson(ref, "zh").tag).toBe("align* 环境");
    expect(resolveLesson(ref, "zh").banner).toBe("已选中 align* 环境");
    expect(resolveLesson(ref, "en").tag).toBe("align* environment");
    expect(resolveLesson(ref, "en").banner).toBe("Selected align* environment");
    expect(resolveLesson(ref, "zh").title).toBe("多行对齐公式");
  });

  it("uses the outermost complete environment when environments are nested", () => {
    const ref = lessonRefForSelection(
      selection(
        [
          String.raw`\begin{figure}[htbp]`,
          String.raw`  \centering`,
          String.raw`  \begin{equation}`,
          "    E = mc^{2}",
          String.raw`  \end{equation}`,
          String.raw`\end{figure}`,
        ].join("\n"),
      ),
    )!;
    expect(ref.id).toBe("figure");
    expect(resolveLesson(ref, "zh").tag).toBe("figure 环境");
    expect(resolveLesson(ref, "zh").banner).toBe("已选中 figure 环境");
    expect(resolveLesson(ref, "en").tag).toBe("figure environment");
    expect(resolveLesson(ref, "en").banner).toBe("Selected figure environment");
    expect(resolveLesson(ref, "zh").title).toBe("浮动图片环境");
  });

  it("keeps an inner complete environment when the outer begin has no matching end", () => {
    const ref = lessonRefForSelection(
      selection(
        [
          String.raw`\begin{figure}`,
          String.raw`  \begin{equation}`,
          "    E = mc^{2}",
          String.raw`  \end{equation}`,
        ].join("\n"),
      ),
    )!;
    expect(ref.id).toBe("equation");
    expect(resolveLesson(ref, "zh").banner).toBe("已选中 equation 环境");
    expect(resolveLesson(ref, "en").banner).toBe(
      "Selected equation environment",
    );
  });

  it("does not treat a starred begin and an unstarred end as one environment", () => {
    const ref = lessonRefForSelection(
      selection(String.raw`\begin{align*} a &= b \end{align}`),
    )!;
    expect(ref).toMatchObject({
      kind: "construct",
      id: "align",
      label: String.raw`\begin{align*}`,
    });
    expect(resolveLesson(ref, "zh").banner).toBe(
      String.raw`已选中 \begin{align*}`,
    );
    expect(resolveLesson(ref, "en").banner).toBe(
      String.raw`Selected \begin{align*}`,
    );
  });

  it("prefers a complete environment over a command that appears first", () => {
    const ref = lessonRefForSelection(
      selection(
        [
          String.raw`\label{eq:energy}`,
          String.raw`\begin{equation}`,
          "  E = mc^{2}",
          String.raw`\end{equation}`,
        ].join("\n"),
      ),
    )!;
    expect(ref.id).toBe("equation");
    expect(resolveLesson(ref, "zh").banner).toBe("已选中 equation 环境");
    expect(resolveLesson(ref, "en").tag).toBe("equation environment");
  });

  it("keeps the closing tag when only \\end{equation} is selected", () => {
    const ref = lessonRefForSelection(selection(String.raw`\end{equation}`))!;
    expect(ref).toMatchObject({
      kind: "construct",
      id: "equation",
      label: String.raw`\end{equation}`,
    });
    expect(ref).not.toHaveProperty("wholeEnvironment");
    expect(resolveLesson(ref, "zh").banner).toBe(
      String.raw`已选中 \end{equation}`,
    );
    expect(resolveLesson(ref, "en").banner).toBe(
      String.raw`Selected \end{equation}`,
    );
  });

  it("does not pair a begin and end whose names differ", () => {
    const ref = lessonRefForSelection(
      selection(String.raw`\begin{equation} E = mc^{2} \end{figure}`),
    )!;
    expect(ref).toMatchObject({
      kind: "construct",
      id: "equation",
      label: String.raw`\begin{equation}`,
    });
    expect(ref).not.toHaveProperty("wholeEnvironment");
  });

  it("only closes the environment on top of the stack", () => {
    const ref = lessonRefForSelection(
      selection(
        String.raw`\begin{figure} \begin{equation} E = mc^{2} \end{figure}`,
      ),
    )!;
    expect(ref).not.toHaveProperty("wholeEnvironment");
    expect(ref).toMatchObject({ label: String.raw`\begin{figure}` });
    expect(resolveLesson(ref, "en").banner).toBe(
      String.raw`Selected \begin{figure}`,
    );
  });

  it("ignores a commented-out \\end when pairing", () => {
    const ref = lessonRefForSelection(
      selection(
        [
          String.raw`\begin{equation}`,
          "E = mc^{2}",
          String.raw`% \end{equation}`,
        ].join("\n"),
      ),
    )!;
    expect(ref).not.toHaveProperty("wholeEnvironment");
    expect(resolveLesson(ref, "zh").banner).toBe(
      String.raw`已选中 \begin{equation}`,
    );
  });

  it("ignores a commented-out \\begin when pairing", () => {
    const ref = lessonRefForSelection(
      selection(
        [
          String.raw`% \begin{equation}`,
          "E = mc^{2}",
          String.raw`\end{equation}`,
        ].join("\n"),
      ),
    )!;
    expect(ref).not.toHaveProperty("wholeEnvironment");
    expect(resolveLesson(ref, "en").banner).toBe(
      String.raw`Selected \end{equation}`,
    );
  });

  it("keeps an escaped percent sign when stripping comments", () => {
    const ref = lessonRefForSelection(
      selection(
        [String.raw`\begin{equation}`, String.raw`50\% \end{equation}`].join(
          "\n",
        ),
      ),
    )!;
    expect(ref).toMatchObject({ wholeEnvironment: "equation" });
    expect(resolveLesson(ref, "en").banner).toBe(
      "Selected equation environment",
    );
  });

  it("treats a percent after a line break \\\\ as a comment when pairing", () => {
    const ref = lessonRefForSelection(
      selection(String.raw`\begin{equation} a \\% \end{equation}`),
    )!;
    expect(ref).toMatchObject({ id: "equation" });
    expect(ref).not.toHaveProperty("wholeEnvironment");
    expect(resolveLesson(ref, "en").banner).toBe(
      String.raw`Selected \begin{equation}`,
    );
  });

  it("keeps a percent after an odd run of backslashes when pairing", () => {
    for (const text of [
      String.raw`\begin{equation} 100\% \end{equation}`,
      String.raw`\begin{equation} a \\\% \end{equation}`,
    ]) {
      expect(lessonRefForSelection(selection(text))).toMatchObject({
        wholeEnvironment: "equation",
      });
    }
  });

  it("prefers live code over a commented construct in the per-line fallback", () => {
    const line = String.raw`\emph{x} % \begin{figure}`;
    const selected = "ph{x} % \\";
    const start = line.indexOf(selected);
    expect(
      lessonRefForSelection({
        selected,
        line,
        selectionStartInLine: start,
        selectionEndInLine: start + selected.length,
      }),
    ).toMatchObject({ kind: "construct", label: String.raw`\emph` });
  });

  it("still explains a construct selected inside a comment in the per-line fallback", () => {
    const line = String.raw`% \begin{figure}`;
    const start = line.indexOf("egin{fig");
    expect(
      lessonRefForSelection({
        selected: "egin{fig",
        line,
        selectionStartInLine: start,
        selectionEndInLine: start + "egin{fig".length,
      }),
    ).toMatchObject({ id: "figure", label: String.raw`\begin{figure}` });
  });

  it("changes only the title and banner for an uncatalogued environment", () => {
    const ref = lessonRefForSelection(
      selection(
        String.raw`\begin{theorem} Every bounded sequence converges. \end{theorem}`,
      ),
    )!;
    expect(ref).toMatchObject({
      kind: "construct",
      id: "environment",
      wholeEnvironment: "theorem",
    });
    const zh = resolveLesson(ref, "zh");
    const en = resolveLesson(ref, "en");
    expect(zh.tag).toBe("theorem 环境");
    expect(zh.banner).toBe("已选中 theorem 环境");
    expect(zh.title).toBe("环境");
    expect(
      zh.what.startsWith(String.raw`\begin{theorem} 用来开始或结束一个环境。`),
    ).toBe(true);
    expect(en.tag).toBe("theorem environment");
    expect(en.banner).toBe("Selected theorem environment");
    expect(
      en.what.startsWith(
        String.raw`\begin{theorem} begins or ends an environment.`,
      ),
    ).toBe(true);
    for (const text of [zh.what, en.what, ...zh.points, ...en.points]) {
      expect(text).not.toContain("theorem 环境");
      expect(text).not.toContain("theorem environment");
    }
  });

  it("uses the earliest of sibling complete environments", () => {
    const ref = lessonRefForSelection(
      selection(
        [
          String.raw`\begin{equation} a = b \end{equation}`,
          String.raw`\begin{figure} \centering \end{figure}`,
        ].join("\n"),
      ),
    )!;
    expect(ref).toMatchObject({ id: "equation", wholeEnvironment: "equation" });
    expect(resolveLesson(ref, "en").banner).toBe(
      "Selected equation environment",
    );
  });

  it("pairs a same-name nest from the inside out", () => {
    const ref = lessonRefForSelection(
      selection(
        [
          String.raw`\begin{minipage}{0.5\textwidth}`,
          String.raw`  \begin{minipage}{0.4\textwidth} x \end{minipage}`,
          String.raw`\end{minipage}`,
        ].join("\n"),
      ),
    )!;
    expect(ref).toMatchObject({ wholeEnvironment: "minipage" });
    expect(resolveLesson(ref, "zh").banner).toBe("已选中 minipage 环境");
  });

  it("pairs only the inner environment when a same-name outer is unclosed", () => {
    const ref = lessonRefForSelection(
      selection(
        [
          String.raw`\begin{minipage}{0.5\textwidth}`,
          String.raw`  \begin{minipage}{0.4\textwidth} x \end{minipage}`,
        ].join("\n"),
      ),
    )!;
    expect(ref).toMatchObject({ wholeEnvironment: "minipage" });
  });

  it("does not treat an unstarred begin and a starred end as one environment", () => {
    const ref = lessonRefForSelection(
      selection(String.raw`\begin{align} a &= b \end{align*}`),
    )!;
    expect(ref).toMatchObject({
      id: "align",
      label: String.raw`\begin{align}`,
    });
    expect(ref).not.toHaveProperty("wholeEnvironment");
  });

  it("tells a begin-only lesson apart from the whole environment", () => {
    const opening = lessonRefForSelection(
      selection(String.raw`\begin{equation}`),
    )!;
    const whole = lessonRefForSelection(
      selection(String.raw`\begin{equation} x \end{equation}`),
    )!;
    expect(sameTeachLesson(opening, whole)).toBe(false);
    expect(sameTeachLesson(whole, { ...whole })).toBe(true);
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
