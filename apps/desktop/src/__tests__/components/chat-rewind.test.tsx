import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatMessages } from "@/components/claude-chat/chat-messages";
import {
  useClaudeChatStore,
  type ClaudeStreamMessage,
} from "@/stores/claude-chat-store";

function user(text: string): ClaudeStreamMessage {
  return {
    type: "user",
    message: { content: [{ type: "text", text }] },
  };
}

describe("chat rewind control", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    HTMLElement.prototype.scrollTo = () => undefined;
    useClaudeChatStore.getState().resetForProject("/project-a");
    const tab = useClaudeChatStore.getState().tabs[0];
    const messages = [
      user("Rewrite the abstract"),
      user("Check the citations"),
    ];
    useClaudeChatStore.setState({
      tabs: [
        {
          ...tab,
          messages,
          projectPath: "/project-a",
          isStreaming: false,
        },
      ],
      messages,
      isStreaming: false,
      sessionId: null,
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("asks before removing later messages", async () => {
    await act(async () => {
      root.render(<ChatMessages />);
    });

    const rewindButtons = container.querySelectorAll(
      '[data-testid="rewind-here"]',
    );
    expect(rewindButtons).toHaveLength(1);
    await act(async () => {
      (rewindButtons[0] as HTMLButtonElement).click();
    });
    expect(container.textContent).toContain("Project files stay");

    await act(async () => {
      (
        container.querySelector(
          '[data-testid="rewind-cancel"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(useClaudeChatStore.getState().messages).toHaveLength(2);

    const again = container.querySelector(
      '[data-testid="rewind-here"]',
    ) as HTMLButtonElement;
    await act(async () => {
      again.click();
    });
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="rewind-confirm"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(
      useClaudeChatStore
        .getState()
        .messages.map((message) => message.message?.content?.[0]?.text),
    ).toEqual(["Rewrite the abstract"]);
    expect(
      container.querySelector('[data-testid="rewind-regenerate"]')?.textContent,
    ).toBe("Regenerate");
  });
});
