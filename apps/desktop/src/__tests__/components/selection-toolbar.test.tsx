import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectionToolbar } from "@/components/workspace/editor/selection-toolbar";
import { useLatexTeachStore } from "@/stores/latex-teach-store";

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
});
