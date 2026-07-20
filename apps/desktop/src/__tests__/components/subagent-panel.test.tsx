import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentRunStore } from "@/stores/agent-run-store";

const chatState = {
  activeTabId: "tab-1",
  tabs: [
    {
      id: "tab-1",
      sessionId: "root",
      runtime: "codex" as const,
      chatPeer: "codex" as const,
    },
  ],
};

vi.mock("@/stores/claude-chat-store", () => ({
  useClaudeChatStore: Object.assign(
    (selector: (state: typeof chatState) => unknown) => selector(chatState),
    {
      getState: () => chatState,
      setState: (partial: Partial<typeof chatState>) => {
        Object.assign(chatState, partial);
      },
    },
  ),
}));

import { SubagentPanel } from "@/components/subagents/subagent-panel";

describe("SubagentPanel", () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    useAgentRunStore.getState().reset();
    chatState.activeTabId = "tab-1";
    chatState.tabs = [
      {
        id: "tab-1",
        sessionId: "root",
        runtime: "codex",
        chatPeer: "codex",
      },
    ];

    useAgentRunStore.getState().applyEvent(
      { runtime: "codex", sessionId: "root", projectPath: "" },
      {
        type: "subagentDiscovered",
        run: {
          id: "child-1",
          parentId: "root",
          rootConversationId: "root",
          runtime: "codex",
          agentName: "reviewer",
          agentRole: "reviewer",
          model: "gpt-5.4",
          status: "running",
          startedAt: Date.now() - 1500,
          completedAt: null,
          activity: "editing",
          summary: null,
          error: null,
          transcriptAvailable: false,
        },
      },
    );
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  });

  it("renders active section with runtime badge and details", async () => {
    root = createRoot(container);
    await act(async () => {
      root?.render(<SubagentPanel />);
    });

    expect(container.textContent).toContain("Active");
    expect(container.textContent).toContain("reviewer");
    expect(container.textContent).toContain("codex");
    expect(container.textContent).toContain("gpt-5.4");
    expect(container.textContent).toContain("Transcript unavailable");

    const button = Array.from(container.querySelectorAll("button")).find(
      (element) => element.textContent?.includes("reviewer"),
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useAgentRunStore.getState().selectedRunId).toBe("child-1");
    expect(chatState.activeTabId).toBe("tab-1");
  });
});
