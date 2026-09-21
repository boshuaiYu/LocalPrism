import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatRestoreButton } from "@/components/claude-chat/chat-restore-button";

describe("ChatRestoreButton", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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
  });

  it("opens chat from the collapsed assistant icon", async () => {
    const onOpen = vi.fn();
    await act(async () =>
      root.render(<ChatRestoreButton attention onOpen={onOpen} />),
    );

    const button = container.querySelector('[data-testid="open-ai-assistant"]');
    expect(button).toBeInstanceOf(HTMLButtonElement);
    expect(button?.getAttribute("aria-label")).toBe("Open AI Assistant");
    expect(
      container.querySelector('[data-testid="open-ai-assistant-attention"]'),
    ).not.toBeNull();

    await act(async () => (button as HTMLButtonElement).click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
