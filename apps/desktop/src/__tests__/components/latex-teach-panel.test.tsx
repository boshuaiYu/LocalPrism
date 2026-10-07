import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProblemsPanel } from "@/components/workspace/editor/problems-panel";
import {
  TeachEmptyEntry,
  TeachPanel,
} from "@/components/workspace/editor/teach-panel";
import {
  lessonRefForDiagnostic,
  lessonRefForSelection,
} from "@/lib/latex-teaching";
import { newProjectFileTemplate } from "@/lib/new-project-file";
import {
  registerTeachAsk,
  useLatexTeachStore,
} from "@/stores/latex-teach-store";
import { useSettingsStore } from "@/stores/settings-store";

const figure = lessonRefForSelection({
  selected: String.raw`\begin{figure}[htbp]`,
  line: String.raw`\begin{figure}[htbp]`,
  selectionStartInLine: 0,
  selectionEndInLine: 20,
})!;

describe("LaTeX teach panel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useSettingsStore.setState({ latexTeaching: false, uiLanguage: "zh" });
    useLatexTeachStore.getState().reset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useSettingsStore.setState({ latexTeaching: false, uiLanguage: "en" });
    useLatexTeachStore.getState().reset();
    registerTeachAsk(null);
  });

  it("shows a Chinese lesson and does not render while teaching is off", async () => {
    useSettingsStore.setState({ latexTeaching: true, uiLanguage: "zh" });
    useLatexTeachStore.getState().forcePresent(figure, "sel:0:20");
    const onInsert = vi.fn();

    await act(async () => {
      root.render(<TeachPanel onInsert={onInsert} />);
    });

    const panel = document.body.querySelector(
      '[data-testid="latex-teach-panel"]',
    );
    expect(panel?.className).toContain("fixed");
    expect(panel?.className).not.toContain("shrink-0");
    expect(panel?.getAttribute("role")).toBe("dialog");
    expect(panel?.textContent).toContain("边写边学");
    expect(panel?.textContent).toContain("拖动");
    expect(panel?.textContent).toContain("浮动图片环境");
    expect(panel?.textContent).toContain("插入示例到光标处");
    expect(
      document.body.querySelector('[data-testid="latex-teach-ask"]'),
    ).toBeNull();
    const insert = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("插入示例"),
    );
    await act(async () => {
      insert?.click();
    });
    expect(onInsert).toHaveBeenCalledWith(
      expect.stringContaining(String.raw`\begin{figure}`),
    );

    useSettingsStore.getState().setLatexTeaching(false);
    await act(async () => {
      root.render(<TeachPanel onInsert={onInsert} />);
    });
    expect(
      document.body.querySelector('[data-testid="latex-teach-panel"]'),
    ).toBeNull();
  });

  it("offers an empty-project guide only for a starter file when teaching is on", async () => {
    const starter = newProjectFileTemplate("main.tex", "tex");
    useSettingsStore.setState({ latexTeaching: true, uiLanguage: "zh" });

    await act(async () => {
      root.render(<TeachEmptyEntry content={starter} />);
    });
    const entry = document.body.querySelector(
      '[data-testid="latex-teach-empty-entry"]',
    );
    expect(entry?.textContent).toContain("空白文稿");
    await act(async () => {
      if (entry instanceof HTMLButtonElement) entry.click();
    });
    expect(useLatexTeachStore.getState().lesson?.id).toBe("empty-project");

    await act(async () => {
      root.render(
        <TeachEmptyEntry
          content={String.raw`\documentclass{article}
\begin{document}
Hello
\end{document}`}
        />,
      );
    });
    expect(
      document.body.querySelector('[data-testid="latex-teach-empty-entry"]'),
    ).toBeNull();

    useSettingsStore.setState({ latexTeaching: false });
    await act(async () => {
      root.render(<TeachEmptyEntry content={starter} />);
    });
    expect(
      document.body.querySelector('[data-testid="latex-teach-empty-entry"]'),
    ).toBeNull();
  });

  it("adds a diagnostic teach entry only while teaching is on", async () => {
    const onNavigate = vi.fn();
    const onFixWithChat = vi.fn();
    const diagnostics = [
      {
        from: 10,
        to: 20,
        severity: "error",
        message: "File `miss.png' not found",
        line: 9,
      },
    ];

    await act(async () => {
      root.render(
        <ProblemsPanel
          diagnostics={diagnostics}
          fileName="main.tex"
          onFixWithChat={onFixWithChat}
          onNavigate={onNavigate}
        />,
      );
    });
    expect(
      document.body.querySelector('[data-testid="latex-teach-diagnostic"]'),
    ).toBeNull();
    expect(container.querySelector('[title="Fix with chat"]')).not.toBeNull();

    useSettingsStore.setState({ latexTeaching: true, uiLanguage: "zh" });
    await act(async () => {
      root.render(
        <ProblemsPanel
          diagnostics={diagnostics}
          fileName="main.tex"
          onFixWithChat={onFixWithChat}
          onNavigate={onNavigate}
        />,
      );
    });
    const teach = document.body.querySelector(
      '[data-testid="latex-teach-diagnostic"]',
    );
    expect(teach?.textContent).toBe("讲解");
    await act(async () => {
      if (teach instanceof HTMLButtonElement) teach.click();
    });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onFixWithChat).not.toHaveBeenCalled();
    expect(useLatexTeachStore.getState().lesson).toMatchObject({
      id: "file-not-found",
      detail: "miss.png",
    });
    expect(useLatexTeachStore.getState().anchor).not.toBeNull();
  });

  it("drags from the header without docking beside the editor", async () => {
    useSettingsStore.setState({ latexTeaching: true, uiLanguage: "zh" });
    useLatexTeachStore.getState().forcePresent(figure, "sel:0:20", {
      x: 40,
      y: 120,
      width: 80,
      height: 18,
    });

    await act(async () => {
      root.render(<TeachPanel />);
    });

    const panel = document.body.querySelector(
      '[data-testid="latex-teach-panel"]',
    );
    const handle = document.body.querySelector(
      '[data-testid="latex-teach-drag"]',
    );
    expect(panel).toBeInstanceOf(HTMLElement);
    expect(handle).toBeInstanceOf(HTMLElement);
    if (!(panel instanceof HTMLElement) || !(handle instanceof HTMLElement)) {
      return;
    }
    const start = Number.parseFloat(panel.style.left);
    expect(start).toBe(40 + 80 + 12);

    const pointer = (type: string, clientX: number, clientY: number) =>
      new MouseEvent(type, {
        bubbles: true,
        button: 0,
        clientX,
        clientY,
      });
    await act(async () => {
      handle.dispatchEvent(pointer("pointerdown", 10, 10));
      handle.dispatchEvent(pointer("pointermove", 28, 24));
    });

    expect(Number.parseFloat(panel.style.left)).toBe(start + 18);
    expect(Number.parseFloat(panel.style.top)).toBe(120 + 14);

    const close = document.body.querySelector(
      '[data-testid="latex-teach-close"]',
    );
    await act(async () => {
      if (close instanceof HTMLButtonElement) close.click();
    });
    expect(useLatexTeachStore.getState().open).toBe(false);
    expect(
      document.body.querySelector('[data-testid="latex-teach-panel"]'),
    ).toBeNull();
  });

  it("keeps the diagnostic lesson when the open selection is presented again", async () => {
    const onNavigate = vi.fn();
    const onFixWithChat = vi.fn();
    const diagnostics = [
      {
        from: 10,
        to: 20,
        severity: "error",
        message: "File `miss.png' not found",
        line: 9,
      },
    ];
    useSettingsStore.setState({ latexTeaching: true, uiLanguage: "zh" });
    useLatexTeachStore.getState().present(figure, "sel:0:20");

    await act(async () => {
      root.render(
        <ProblemsPanel
          diagnostics={diagnostics}
          fileName="main.tex"
          onFixWithChat={onFixWithChat}
          onNavigate={onNavigate}
        />,
      );
    });
    const teach = document.body.querySelector(
      '[data-testid="latex-teach-diagnostic"]',
    );
    await act(async () => {
      if (teach instanceof HTMLButtonElement) teach.click();
    });
    useLatexTeachStore.getState().present(figure, "sel:0:20");
    useLatexTeachStore.getState().present(figure, "sel:4:18");

    expect(onNavigate).not.toHaveBeenCalled();
    expect(useLatexTeachStore.getState().lesson?.id).toBe("file-not-found");

    await act(async () => {
      root.render(<TeachPanel />);
    });
    const panel = document.body.querySelector(
      '[data-testid="latex-teach-panel"]',
    );
    expect(panel?.textContent).toContain("找不到文件");
    expect(panel?.textContent).not.toContain("浮动图片环境");
  });

  it("asks AI beside insert and keeps the local lesson open", async () => {
    useSettingsStore.setState({ latexTeaching: true, uiLanguage: "zh" });
    useLatexTeachStore.getState().forcePresent(figure, "sel:0:20", null, {
      selectedText: String.raw`\begin{figure}[htbp]`,
    });
    const onAskAi = vi.fn();
    const onInsert = vi.fn();

    await act(async () => {
      root.render(<TeachPanel onAskAi={onAskAi} onInsert={onInsert} />);
    });

    const insert = document.body.querySelector(
      '[data-testid="latex-teach-insert"]',
    );
    const ask = document.body.querySelector('[data-testid="latex-teach-ask"]');
    expect(insert?.textContent).toContain("插入示例到光标处");
    expect(ask?.textContent).toContain("问 AI");
    expect(ask?.getAttribute("data-variant")).toBe("secondary");
    expect(insert?.nextElementSibling).toBe(ask);

    await act(async () => {
      if (ask instanceof HTMLButtonElement) ask.click();
    });

    expect(onAskAi).toHaveBeenCalledTimes(1);
    const prompt = String(onAskAi.mock.calls[0]?.[0]);
    expect(prompt).toContain("浮动图片环境");
    expect(prompt).toContain(String.raw`\begin{figure}`);
    expect(prompt).toContain("选中文本");
    expect(onInsert).not.toHaveBeenCalled();
    expect(useLatexTeachStore.getState().open).toBe(true);
    expect(
      document.body.querySelector('[data-testid="latex-teach-panel"]'),
    ).not.toBeNull();
  });

  it("asks about an error without an insert action", async () => {
    useSettingsStore.setState({ latexTeaching: true, uiLanguage: "en" });
    const message = "File `miss.png' not found";
    const ref = lessonRefForDiagnostic(message);
    useLatexTeachStore
      .getState()
      .forcePresent(ref, `diag:${ref.id}:${message}`);
    const onAskAi = vi.fn();

    await act(async () => {
      root.render(<TeachPanel onAskAi={onAskAi} />);
    });

    expect(
      document.body.querySelector('[data-testid="latex-teach-insert"]'),
    ).toBeNull();
    const ask = document.body.querySelector('[data-testid="latex-teach-ask"]');
    expect(ask?.textContent).toContain("Ask AI");
    expect(ask?.getAttribute("data-variant")).toBe("default");

    await act(async () => {
      if (ask instanceof HTMLButtonElement) ask.click();
    });

    const prompt = String(onAskAi.mock.calls[0]?.[0]);
    expect(prompt).toContain("Missing file");
    expect(prompt).toContain("miss.png");
    expect(prompt).toContain(message);
    expect(useLatexTeachStore.getState().open).toBe(true);
  });

  it("sends a guide prompt through the editor ask callback", async () => {
    useSettingsStore.setState({ latexTeaching: true, uiLanguage: "zh" });
    useLatexTeachStore
      .getState()
      .forcePresent({ kind: "guide", id: "empty-project" }, "guide:empty");
    const handler = vi.fn();
    registerTeachAsk(handler);

    await act(async () => {
      root.render(<TeachPanel />);
    });

    const ask = document.body.querySelector('[data-testid="latex-teach-ask"]');
    await act(async () => {
      if (ask instanceof HTMLButtonElement) ask.click();
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const prompt = String(handler.mock.calls[0]?.[0]);
    expect(prompt).toContain("一份最小的文稿");
    expect(prompt).not.toContain("选中文本");
    expect(useLatexTeachStore.getState().open).toBe(true);
  });
});
