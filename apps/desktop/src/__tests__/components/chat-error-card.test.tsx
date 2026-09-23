import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatMessages } from "@/components/claude-chat/chat-messages";
import { useClaudeChatStore } from "@/stores/claude-chat-store";

describe("failed chat turns", () => {
  let container: HTMLDivElement;
  let root: Root;
  let snapshot: ReturnType<typeof useClaudeChatStore.getState>;

  beforeEach(() => {
    snapshot = useClaudeChatStore.getState();
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
    useClaudeChatStore.setState(snapshot, true);
  });

  it("renders a historical failure as a card with retry and details", async () => {
    const dump = `${"x".repeat(180)} API Error: boom`;
    const sendPrompt = vi.fn(async () => undefined);
    useClaudeChatStore.setState({
      error: null,
      isStreaming: false,
      sendPrompt,
      messages: [
        {
          type: "user",
          message: {
            content: [
              { type: "text", text: "@main.tex:1:1-1:8\nfix the proof" },
            ],
          },
        },
        {
          type: "result",
          is_error: true,
          result: dump,
        },
        {
          type: "user",
          message: { content: [{ type: "text", text: "later question" }] },
        },
      ],
    });

    await act(async () => root.render(<ChatMessages />));

    const card = await vi.waitFor(() => {
      const node = container.querySelector('[data-testid="chat-error-card"]');
      if (!(node instanceof HTMLElement)) throw new Error("error card missing");
      return node;
    });
    expect(card.textContent).toContain("This turn didn't finish");
    expect(card.textContent).toContain("Retry");
    expect(card.textContent).toContain("Details");
    expect(card.textContent).not.toContain(dump);
    expect(container.textContent).toContain("fix the proof");

    const retry = Array.from(card.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Retry"),
    );
    expect(retry).toBeInstanceOf(HTMLButtonElement);
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    await act(async () => (retry as HTMLButtonElement).click());
    expect(sendPrompt).toHaveBeenCalledWith("fix the proof");
  });

  it("keeps the sticky banner as the only card while the same error is active", async () => {
    const dump = "Claude process exited unexpectedly.";
    useClaudeChatStore.setState({
      error: dump,
      isStreaming: false,
      messages: [
        {
          type: "user",
          message: { content: [{ type: "text", text: "hello" }] },
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: dump }] },
        },
        { type: "result", is_error: true, result: dump },
      ],
    });

    await act(async () => root.render(<ChatMessages />));
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="chat-error-card"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain(dump);
    expect(container.textContent).toContain("hello");
  });
});
