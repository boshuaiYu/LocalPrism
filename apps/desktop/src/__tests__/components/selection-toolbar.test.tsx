import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectionToolbar } from "@/components/workspace/editor/selection-toolbar";
import {
  releaseSelectionLessonForToolbar,
  selectionExplainAction,
  shouldReleaseSelectionLesson,
} from "@/lib/latex-selection-teach";
import { useLatexTeachStore } from "@/stores/latex-teach-store";
import { useSettingsStore } from "@/stores/settings-store";

describe("selection toolbar actions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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
    useLatexTeachStore.getState().reset();
    useSettingsStore.setState({ latexTeaching: false });
  });

  it("keeps Proofread beside Explain and does not open the teach float", async () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();

    await act(async () => {
      root.render(
        <SelectionToolbar
          actions={[
            { id: "proofread", label: "Proofread", icon: <span>p</span> },
            { id: "explain", label: "讲解", icon: <span>e</span> },
          ]}
          contextLabel="@main.tex:1:1-1:14"
          onAction={onAction}
          onDismiss={onDismiss}
          onSendPrompt={vi.fn()}
          position={{ top: 12, left: 16 }}
        />,
      );
    });

    const proofread = document.body.querySelector(
      '[data-testid="selection-action-proofread"]',
    );
    const explain = document.body.querySelector(
      '[data-testid="selection-action-explain"]',
    );
    expect(proofread?.textContent).toContain("Proofread");
    expect(explain?.textContent).toContain("讲解");
    expect(
      document.body.querySelector('[data-testid="latex-teach-panel"]'),
    ).toBeNull();

    await act(async () => {
      if (proofread instanceof HTMLButtonElement) proofread.click();
      if (explain instanceof HTMLButtonElement) explain.click();
    });

    expect(onAction).toHaveBeenNthCalledWith(1, "proofread");
    expect(onAction).toHaveBeenNthCalledWith(2, "explain");
    expect(useLatexTeachStore.getState().open).toBe(false);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("refreshes an open lesson on one Explain click and ignores the selection echo", async () => {
    useSettingsStore.getState().setLatexTeaching(true);
    const figureLine = String.raw`  \begin{figure}[htbp]`;
    const sectionLine = String.raw`\section{Figure demo}`;
    const figure = selectionExplainAction({
      teachingEnabled: true,
      isTex: true,
      from: 2,
      to: figureLine.length,
      selected: String.raw`\begin{figure}[htbp]`,
      line: figureLine,
      selectionStartInLine: 2,
      selectionEndInLine: figureLine.length,
    })!;
    const section = selectionExplainAction({
      teachingEnabled: true,
      isTex: true,
      from: 0,
      to: sectionLine.length,
      selected: sectionLine,
      line: sectionLine,
      selectionStartInLine: 0,
      selectionEndInLine: sectionLine.length,
    })!;
    useLatexTeachStore.getState().forcePresent(figure.lesson, figure.sourceKey);
    let held: string | null = figure.sourceKey;
    if (
      shouldReleaseSelectionLesson({
        open: true,
        sourceKey: figure.sourceKey,
        heldSelectionKey: held,
        selectionKey: section.sourceKey,
      })
    ) {
      held = null;
      releaseSelectionLessonForToolbar(useLatexTeachStore.getState());
    }
    expect(useLatexTeachStore.getState().open).toBe(false);

    const onAction = vi.fn((actionId: string) => {
      if (actionId !== "explain") return;
      held = section.sourceKey;
      useLatexTeachStore
        .getState()
        .forcePresent(section.lesson, section.sourceKey, null, {
          selectedText: sectionLine,
        });
      if (
        shouldReleaseSelectionLesson({
          open: useLatexTeachStore.getState().open,
          sourceKey: useLatexTeachStore.getState().sourceKey,
          heldSelectionKey: held,
          selectionKey: section.sourceKey,
        })
      ) {
        held = null;
        releaseSelectionLessonForToolbar(useLatexTeachStore.getState());
      }
    });

    await act(async () => {
      root.render(
        <SelectionToolbar
          actions={[
            { id: "proofread", label: "Proofread", icon: <span>p</span> },
            { id: "explain", label: "讲解", icon: <span>e</span> },
          ]}
          contextLabel="@main.tex:8:1-8:22"
          onAction={onAction}
          onDismiss={vi.fn()}
          onSendPrompt={vi.fn()}
          position={{ top: 20, left: 12 }}
        />,
      );
    });

    const explain = document.body.querySelector(
      '[data-testid="selection-action-explain"]',
    );
    expect(explain).toBeInstanceOf(HTMLButtonElement);
    const button = explain as HTMLButtonElement;
    const outside = vi.fn();
    document.addEventListener("mousedown", outside);
    const press = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      button.dispatchEvent(press);
    });
    document.removeEventListener("mousedown", outside);

    expect(press.defaultPrevented).toBe(true);
    expect(outside).not.toHaveBeenCalled();
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith("explain");
    expect(useLatexTeachStore.getState().open).toBe(true);
    expect(useLatexTeachStore.getState().lesson?.id).toBe("section");
    expect(useLatexTeachStore.getState().sourceKey).toBe(section.sourceKey);

    await act(async () => {
      button.click();
    });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(useLatexTeachStore.getState().open).toBe(true);
    expect(useLatexTeachStore.getState().lesson?.id).toBe("section");
  });
});
