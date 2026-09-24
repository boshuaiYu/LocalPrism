import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/claude-chat/session-selector", () => ({
  SessionSelector: () => <div data-testid="session-selector" />,
}));

vi.mock("@/components/claude-chat/workspace-account-button", () => ({
  WorkspaceAccountButton: () => <div data-testid="workspace-account-button" />,
}));

import { ChatTabBar } from "@/components/claude-chat/chat-tab-bar";
import { useApprovalStore } from "@/stores/approval-store";
import { type TabState, useClaudeChatStore } from "@/stores/claude-chat-store";

function makeTab(
  id: string,
  title: string,
  runtime: TabState["runtime"],
  isStreaming = false,
): TabState {
  const baseTab = useClaudeChatStore.getState().tabs[0];
  return {
    ...baseTab,
    id,
    title,
    projectPath: "C:/project",
    runtime,
    sessionRef: null,
    sessionId: null,
    messages: [],
    isStreaming,
    streamingStartedAt: isStreaming ? 1 : null,
    cancelledAttempts: [],
    activeAttemptId: isStreaming ? `${id}-attempt` : null,
  };
}

function tabButton(container: HTMLElement, tabId: string): HTMLButtonElement {
  const button = container.querySelector(`button[data-tab-id="${tabId}"]`);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Tab button not found: ${tabId}`);
  }
  return button;
}

describe("ChatTabBar runtime badges", () => {
  let container: HTMLDivElement;
  let root: Root;
  let chatSnapshot: ReturnType<typeof useClaudeChatStore.getState>;
  let scrollIntoViewDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    chatSnapshot = useClaudeChatStore.getState();
    useApprovalStore.getState().reset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView",
    );
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useClaudeChatStore.setState(chatSnapshot, true);
    useApprovalStore.getState().reset();
    if (scrollIntoViewDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollIntoView",
        scrollIntoViewDescriptor,
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });

  async function renderTabs(tabs: TabState[]) {
    const activeTab = tabs[0];
    useClaudeChatStore.setState({
      tabs,
      activeTabId: activeTab.id,
      activeProjectPath: activeTab.projectPath,
      messages: activeTab.messages,
      sessionId: activeTab.sessionId,
      isStreaming: activeTab.isStreaming,
      streamingStartedAt: activeTab.streamingStartedAt,
      error: activeTab.error,
      totalInputTokens: activeTab.totalInputTokens,
      totalOutputTokens: activeTab.totalOutputTokens,
    });
    await act(async () => root.render(<ChatTabBar />));
  }

  it("reserves titlebar space beside window caption buttons", async () => {
    await renderTabs([makeTab("tab-claude", "Hello", "claude")]);
    const bar = container.querySelector("[data-testid='chat-tab-bar']");
    expect(bar?.className).toContain("--titlebar-height");
    expect(bar?.className).toContain("--window-controls-inset");
  });

  it("shows tab titles without runtime badges", async () => {
    await renderTabs([
      makeTab("tab-claude", "Literature review", "claude"),
      makeTab("tab-codex", "Run checks", "codex"),
    ]);

    const claudeTab = tabButton(container, "tab-claude");
    const codexTab = tabButton(container, "tab-codex");
    expect(claudeTab.getAttribute("aria-label")).toBe("Literature review");
    expect(codexTab.getAttribute("aria-label")).toBe("Run checks");
    expect(claudeTab.textContent).not.toContain("Claude");
    expect(codexTab.textContent).not.toContain("Codex");
    expect(
      container.querySelector('[data-testid="workspace-account-button"]'),
    ).not.toBeNull();
  });

  it("keeps the streaming indicator and close-button protections", async () => {
    await renderTabs([
      makeTab("tab-claude", "Streaming", "claude", true),
      makeTab("tab-codex", "Idle", "codex"),
    ]);

    const streamingTab = tabButton(container, "tab-claude");
    const idleTab = tabButton(container, "tab-codex");
    expect(streamingTab.querySelector(".animate-ping")).not.toBeNull();
    expect(
      streamingTab.querySelector('[role="button"][aria-label="Close tab"]'),
    ).toBeNull();

    const closeButton = idleTab.querySelector(
      '[role="button"][aria-label="Close tab"]',
    );
    expect(closeButton).toBeInstanceOf(HTMLSpanElement);
    await act(async () => (closeButton as HTMLSpanElement).click());

    expect(useClaudeChatStore.getState().tabs.map((tab) => tab.id)).toEqual([
      "tab-claude",
    ]);
    expect(useClaudeChatStore.getState().activeTabId).toBe("tab-claude");
  });

  it("can close a streaming tab that was opened under another account", async () => {
    useClaudeChatStore.setState({
      accountObserved: true,
      activeAccountKey: "account-b",
    });
    await renderTabs([
      {
        ...makeTab("tab-foreign", "Other account", "claude", true),
        openedUnderAccountKey: "account-a",
      },
      {
        ...makeTab("tab-current", "Current account", "claude", true),
        openedUnderAccountKey: "account-b",
      },
    ]);

    const foreignTab = tabButton(container, "tab-foreign");
    const currentTab = tabButton(container, "tab-current");
    expect(
      foreignTab.querySelector('[role="button"][aria-label="Close tab"]'),
    ).toBeInstanceOf(HTMLSpanElement);
    expect(
      currentTab.querySelector('[role="button"][aria-label="Close tab"]'),
    ).toBeNull();

    await act(async () => {
      (
        foreignTab.querySelector(
          '[role="button"][aria-label="Close tab"]',
        ) as HTMLSpanElement
      ).click();
    });

    expect(useClaudeChatStore.getState().tabs.map((tab) => tab.id)).toEqual([
      "tab-current",
    ]);
  });

  it("keeps tab switching, creation, and closing keyboard shortcuts", async () => {
    await renderTabs([
      makeTab("tab-claude", "Claude work", "claude"),
      makeTab("tab-codex", "Codex work", "codex"),
    ]);

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true }),
      );
    });
    expect(useClaudeChatStore.getState().activeTabId).toBe("tab-codex");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          ctrlKey: true,
          shiftKey: true,
        }),
      );
    });
    expect(useClaudeChatStore.getState().activeTabId).toBe("tab-claude");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "t", ctrlKey: true }),
      );
    });
    const createdTabId = useClaudeChatStore.getState().activeTabId;
    expect(useClaudeChatStore.getState().tabs).toHaveLength(3);
    expect(createdTabId).not.toBe("tab-claude");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "w", ctrlKey: true }),
      );
    });
    expect(useClaudeChatStore.getState().tabs).toHaveLength(2);
    expect(
      useClaudeChatStore.getState().tabs.some((tab) => tab.id === createdTabId),
    ).toBe(false);
  });

  it("marks the originating tab when a tool approval is parked", async () => {
    await renderTabs([
      makeTab("tab-old", "你好", "claude", true),
      makeTab("tab-new", "New Chat", "claude"),
    ]);
    useApprovalStore.getState().enqueue({
      requestId: "req-old",
      method: "claude/can_use_tool",
      runtime: "claude",
      threadId: "thread-old",
      turnId: "turn-old",
      tabId: "tab-old",
      agentRunId: null,
      title: "PowerShell",
      command: "Get-Location",
      cwd: null,
      diff: null,
      permissions: null,
      questions: [],
      details: null,
    });
    await act(async () => root.render(<ChatTabBar />));

    const oldTab = tabButton(container, "tab-old");
    const newTab = tabButton(container, "tab-new");
    expect(oldTab.getAttribute("aria-label")).toBe("你好 (needs approval)");
    expect(
      oldTab.querySelector('[data-testid="tab-approval-indicator"]'),
    ).not.toBeNull();
    expect(newTab.getAttribute("aria-label")).toBe("New Chat");
    expect(
      newTab.querySelector('[data-testid="tab-approval-indicator"]'),
    ).toBeNull();
    useApprovalStore.getState().reset();
  });

  it("shows a close control on the last idle tab", async () => {
    await renderTabs([makeTab("tab-only", "Literature review", "claude")]);

    const onlyTab = tabButton(container, "tab-only");
    expect(
      onlyTab.querySelector('[role="button"][aria-label="Close tab"]'),
    ).toBeInstanceOf(HTMLSpanElement);
  });
});
