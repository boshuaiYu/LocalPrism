import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useApprovalStore } from "@/stores/approval-store";
import {
  CLAUDE_CODE_PROVIDER_ID,
  SELECTED_PROVIDER_CREDENTIAL_STORAGE_KEY,
  loadSelectedProviderCredentialId,
  offsetToLineCol,
  useClaudeChatStore,
} from "@/stores/claude-chat-store";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useClaudeChatStore.setState({ selectedProviderCredentialId: null });
});

describe("offsetToLineCol", () => {
  it("returns line 1, col 1 for offset 0 on empty string", () => {
    expect(offsetToLineCol("", 0)).toEqual({ line: 1, col: 1 });
  });

  it("returns line 1, col 1 for offset 0 on non-empty string", () => {
    expect(offsetToLineCol("hello", 0)).toEqual({ line: 1, col: 1 });
  });

  it("returns correct col within a single line", () => {
    expect(offsetToLineCol("hello world", 5)).toEqual({ line: 1, col: 6 });
  });

  it("handles offset at end of single line", () => {
    expect(offsetToLineCol("hello", 5)).toEqual({ line: 1, col: 6 });
  });

  it("handles multiple lines correctly", () => {
    const content = "line1\nline2\nline3";
    // offset 6 is start of "line2"
    expect(offsetToLineCol(content, 6)).toEqual({ line: 2, col: 1 });
    // offset 11 is end of "line2" (the newline before line3)
    expect(offsetToLineCol(content, 11)).toEqual({ line: 2, col: 6 });
    // offset 12 is start of "line3"
    expect(offsetToLineCol(content, 12)).toEqual({ line: 3, col: 1 });
  });

  it("returns correct position at end of multi-line content", () => {
    const content = "ab\ncd\nef";
    expect(offsetToLineCol(content, 8)).toEqual({ line: 3, col: 3 });
  });

  it("handles content with only newlines", () => {
    expect(offsetToLineCol("\n\n", 1)).toEqual({ line: 2, col: 1 });
    expect(offsetToLineCol("\n\n", 2)).toEqual({ line: 3, col: 1 });
  });
});

describe("provider selection persistence", () => {
  it("persists Claude Code as an explicit provider selection", () => {
    useClaudeChatStore
      .getState()
      .setSelectedProviderCredentialId(CLAUDE_CODE_PROVIDER_ID);

    expect(
      sessionStorage.getItem(SELECTED_PROVIDER_CREDENTIAL_STORAGE_KEY),
    ).toBe(CLAUDE_CODE_PROVIDER_ID);
    expect(
      localStorage.getItem(SELECTED_PROVIDER_CREDENTIAL_STORAGE_KEY),
    ).toBeNull();
    expect(loadSelectedProviderCredentialId()).toBe(CLAUDE_CODE_PROVIDER_ID);
  });

  it("persists and clears OpenAI-compatible provider selections", () => {
    useClaudeChatStore.getState().setSelectedProviderCredentialId("qwen");

    expect(
      sessionStorage.getItem(SELECTED_PROVIDER_CREDENTIAL_STORAGE_KEY),
    ).toBe("qwen");
    expect(
      localStorage.getItem(SELECTED_PROVIDER_CREDENTIAL_STORAGE_KEY),
    ).toBeNull();

    useClaudeChatStore.getState().setSelectedProviderCredentialId(null);

    expect(
      sessionStorage.getItem(SELECTED_PROVIDER_CREDENTIAL_STORAGE_KEY),
    ).toBeNull();
    expect(loadSelectedProviderCredentialId()).toBeNull();
  });

  it("keeps provider selections isolated between chat tabs", () => {
    const store = useClaudeChatStore.getState();
    const firstTabId = store.activeTabId;

    store.setSelectedProviderCredentialId("qwen");
    const secondTabId = store.createTab();
    useClaudeChatStore.getState().setSelectedProviderCredentialId("gemini");

    expect(useClaudeChatStore.getState().selectedProviderCredentialId).toBe(
      "gemini",
    );

    useClaudeChatStore.getState().setActiveTab(firstTabId);
    expect(useClaudeChatStore.getState().selectedProviderCredentialId).toBe(
      "qwen",
    );

    useClaudeChatStore.getState().setActiveTab(secondTabId);
    expect(useClaudeChatStore.getState().selectedProviderCredentialId).toBe(
      "gemini",
    );
  });
});

describe("project-scoped chat state", () => {
  it("resets tabs for a new project without clearing a pending initial prompt", () => {
    useClaudeChatStore.setState((state) => {
      const baseTab = state.tabs[0];
      const message = {
        type: "user" as const,
        message: { content: [{ type: "text" as const, text: "old project" }] },
      };

      return {
        pendingInitialPrompt: "build this project",
        pendingAttachments: [
          {
            label: "old attachment",
            filePath: "/project-a/old.png",
            selectedText: "old",
          },
        ],
        pendingPinnedContextRemovalLabels: ["@old.tex"],
        activeProjectPath: "/project-a",
        activeTabId: "tab-project-a",
        sessionId: "session-project-a",
        messages: [message],
        tabs: [
          {
            ...baseTab,
            id: "tab-project-a",
            title: "Old project chat",
            projectPath: "/project-a",
            sessionId: "session-project-a",
            messages: [message],
          },
        ],
      };
    });

    useClaudeChatStore.getState().resetForProject("/project-b");

    const state = useClaudeChatStore.getState();
    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    expect(state.activeProjectPath).toBe("/project-b");
    expect(activeTab?.projectPath).toBe("/project-b");
    expect(state.sessionId).toBeNull();
    expect(state.messages).toEqual([]);
    expect(state.pendingAttachments).toEqual([]);
    expect(state.pendingPinnedContextRemovalLabels).toEqual([]);
    expect(state.pendingInitialPrompt).toBe("build this project");
  });
});

describe("pinned context removal requests", () => {
  it("queues and consumes pinned context labels to remove", () => {
    const chat = useClaudeChatStore.getState();

    chat.requestPinnedContextRemoval(["@main.tex:1:1-1:5"]);
    chat.requestPinnedContextRemoval(["@main.tex:2:1-2:5"]);

    expect(
      useClaudeChatStore.getState().pendingPinnedContextRemovalLabels,
    ).toEqual(["@main.tex:1:1-1:5", "@main.tex:2:1-2:5"]);

    expect(
      useClaudeChatStore.getState().consumePendingPinnedContextRemovals(),
    ).toEqual(["@main.tex:1:1-1:5", "@main.tex:2:1-2:5"]);
    expect(
      useClaudeChatStore.getState().pendingPinnedContextRemovalLabels,
    ).toEqual([]);
  });
});

describe("queued guidance", () => {
  it("queues and consumes guidance for the active tab", () => {
    const chat = useClaudeChatStore.getState();
    const tabId = chat.activeTabId;

    chat.clearQueuedGuidance(tabId);
    chat.queueGuidance(tabId, "please focus on the API key deletion flow", {
      label: "@main.tex:1:1-1:8",
      filePath: "main.tex",
      selectedText: "selected",
    });

    expect(
      useClaudeChatStore.getState().tabs.find((tab) => tab.id === tabId)
        ?.queuedGuidance,
    ).toHaveLength(1);

    const queued = useClaudeChatStore.getState().consumeQueuedGuidance(tabId);
    expect(queued?.prompt).toBe("please focus on the API key deletion flow");
    expect(queued?.contextOverride?.filePath).toBe("main.tex");
    expect(
      useClaudeChatStore.getState().tabs.find((tab) => tab.id === tabId)
        ?.queuedGuidance,
    ).toHaveLength(0);
  });

  it("keeps a short slash label on queued guidance while storing the engine prompt", () => {
    const chat = useClaudeChatStore.getState();
    const tabId = chat.activeTabId;
    const expanded = "Help the user install LocalPrism skills.";

    chat.clearQueuedGuidance(tabId);
    chat.queueGuidance(tabId, expanded, undefined, "/install-skills");

    const queued = useClaudeChatStore
      .getState()
      .tabs.find((tab) => tab.id === tabId)?.queuedGuidance?.[0];
    expect(queued?.prompt).toBe(expanded);
    expect(queued?.displayPrompt).toBe("/install-skills");
  });

  it("can remove and consume a specific queued guidance item", () => {
    const chat = useClaudeChatStore.getState();
    const tabId = chat.activeTabId;

    chat.clearQueuedGuidance(tabId);
    chat.queueGuidance(tabId, "first");
    chat.queueGuidance(tabId, "second");
    chat.queueGuidance(tabId, "third");

    const queue = useClaudeChatStore
      .getState()
      .tabs.find((tab) => tab.id === tabId)?.queuedGuidance;
    expect(queue?.map((item) => item.prompt)).toEqual([
      "first",
      "second",
      "third",
    ]);

    chat.removeQueuedGuidance(tabId, queue![1].id);
    expect(
      useClaudeChatStore
        .getState()
        .tabs.find((tab) => tab.id === tabId)
        ?.queuedGuidance?.map((item) => item.prompt),
    ).toEqual(["first", "third"]);

    const thirdId = useClaudeChatStore
      .getState()
      .tabs.find((tab) => tab.id === tabId)?.queuedGuidance?.[1].id;
    const selected = chat.consumeQueuedGuidance(tabId, thirdId);
    expect(selected?.prompt).toBe("third");
    expect(
      useClaudeChatStore
        .getState()
        .tabs.find((tab) => tab.id === tabId)
        ?.queuedGuidance?.map((item) => item.prompt),
    ).toEqual(["first"]);
  });

  it("marks multiple queued guidance items as displayed in chat", () => {
    const chat = useClaudeChatStore.getState();
    const tabId = chat.activeTabId;

    chat.clearQueuedGuidance(tabId);
    chat.queueGuidance(tabId, "first");
    chat.queueGuidance(tabId, "second");
    chat.queueGuidance(tabId, "third");

    const queue = useClaudeChatStore
      .getState()
      .tabs.find((tab) => tab.id === tabId)?.queuedGuidance;
    const secondId = queue?.[1].id;
    const thirdId = queue?.[2].id;

    expect(
      useClaudeChatStore
        .getState()
        .displayQueuedGuidanceInChat(tabId, secondId),
    ).toBe(secondId);
    expect(
      useClaudeChatStore.getState().displayQueuedGuidanceInChat(tabId, thirdId),
    ).toBe(thirdId);

    expect(
      useClaudeChatStore
        .getState()
        .tabs.find((tab) => tab.id === tabId)
        ?.queuedGuidance?.map((item) => ({
          prompt: item.prompt,
          displayedInChat: item.displayedInChat ?? false,
        })),
    ).toEqual([
      { prompt: "first", displayedInChat: false },
      { prompt: "second", displayedInChat: true },
      { prompt: "third", displayedInChat: true },
    ]);
  });

  it("consumes displayed guidance before ordinary queued guidance", () => {
    const chat = useClaudeChatStore.getState();
    const tabId = chat.activeTabId;

    chat.clearQueuedGuidance(tabId);
    chat.queueGuidance(tabId, "first");
    chat.queueGuidance(tabId, "second");

    const secondId = useClaudeChatStore
      .getState()
      .tabs.find((tab) => tab.id === tabId)?.queuedGuidance?.[1].id;
    useClaudeChatStore.getState().displayQueuedGuidanceInChat(tabId, secondId);

    const selected = chat.consumeQueuedGuidance(tabId);
    expect(selected?.prompt).toBe("second");
    expect(
      useClaudeChatStore
        .getState()
        .tabs.find((tab) => tab.id === tabId)
        ?.queuedGuidance?.map((item) => item.prompt),
    ).toEqual(["first"]);
  });
});

function approvalRequest(id: string, tabId: string) {
  return {
    requestId: id,
    method: "claude/can_use_tool" as const,
    runtime: "claude" as const,
    threadId: `${id}-thread`,
    turnId: `${id}-turn`,
    tabId,
    agentRunId: null,
    title: "PowerShell",
    command: "Get-Location",
    cwd: null,
    diff: null,
    permissions: null,
    questions: [],
    details: null,
  };
}

function resetChatToSingleIdleTab() {
  const state = useClaudeChatStore.getState();
  const tab = state.tabs[0];
  useClaudeChatStore.setState({
    tabs: [
      {
        ...tab,
        title: "New Chat",
        isStreaming: false,
        streamingStartedAt: null,
        cancelledAttempts: [],
        messages: [],
        lastTurnUsage: null,
        sessionId: null,
        sessionRef: null,
        activeAttemptId: null,
        error: null,
      },
    ],
    activeTabId: tab.id,
    isStreaming: false,
    streamingStartedAt: null,
    messages: [],
    lastTurnUsage: null,
    sessionId: null,
    error: null,
  });
}

describe("newSession approval isolation", () => {
  beforeEach(() => {
    useApprovalStore.getState().reset();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    resetChatToSingleIdleTab();
  });

  afterEach(() => {
    useApprovalStore.getState().reset();
    resetChatToSingleIdleTab();
  });

  it("cancels leftover prompts when the same tab is reset", async () => {
    const tabId = useClaudeChatStore.getState().activeTabId;
    useApprovalStore.getState().enqueue(approvalRequest("stale", tabId));

    useClaudeChatStore.getState().newSession();
    await vi.waitFor(() => {
      expect(useApprovalStore.getState().pending).toEqual({});
    });
    expect(invoke).toHaveBeenCalledWith("runtime_request_respond", {
      request: {
        requestId: "stale",
        decision: "cancel",
        persistence: null,
        answers: {},
      },
    });
  });

  it("keeps a streaming tab's prompt parked when opening a new chat", () => {
    const oldTabId = useClaudeChatStore.getState().activeTabId;
    useClaudeChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === oldTabId
          ? {
              ...tab,
              isStreaming: true,
              streamingStartedAt: 1,
              activeAttemptId: "attempt-old",
            }
          : tab,
      ),
      isStreaming: true,
    }));
    useApprovalStore.getState().enqueue(approvalRequest("live", oldTabId));

    useClaudeChatStore.getState().newSession();
    const state = useClaudeChatStore.getState();
    expect(state.activeTabId).not.toBe(oldTabId);
    expect(useApprovalStore.getState().pending["s:live"]?.tabId).toBe(oldTabId);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("cancels leftover prompts when closing an idle tab", async () => {
    const firstTabId = useClaudeChatStore.getState().activeTabId;
    const secondTabId = useClaudeChatStore.getState().createTab();
    useApprovalStore.getState().enqueue(approvalRequest("keep", firstTabId));
    useApprovalStore.getState().enqueue(approvalRequest("gone", secondTabId));

    useClaudeChatStore.getState().setActiveTab(firstTabId);
    useClaudeChatStore.getState().closeTab(secondTabId);

    await vi.waitFor(() => {
      expect(Object.keys(useApprovalStore.getState().pending)).toEqual([
        "s:keep",
      ]);
    });
    expect(invoke).toHaveBeenCalledWith("runtime_request_respond", {
      request: {
        requestId: "gone",
        decision: "cancel",
        persistence: null,
        answers: {},
      },
    });
  });

  it("does not cancel a streaming tab that cannot be closed", () => {
    const tabId = useClaudeChatStore.getState().activeTabId;
    useClaudeChatStore.getState().createTab();
    useClaudeChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              isStreaming: true,
              streamingStartedAt: 1,
              activeAttemptId: "attempt-live",
            }
          : tab,
      ),
    }));
    useApprovalStore.getState().enqueue(approvalRequest("live", tabId));

    useClaudeChatStore.getState().closeTab(tabId);
    expect(
      useClaudeChatStore.getState().tabs.some((tab) => tab.id === tabId),
    ).toBe(true);
    expect(useApprovalStore.getState().pending["s:live"]?.tabId).toBe(tabId);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("cancels leftover prompts when changing runtime resets the tab", async () => {
    const tabId = useClaudeChatStore.getState().activeTabId;
    useApprovalStore.getState().enqueue(approvalRequest("stale", tabId));

    expect(useClaudeChatStore.getState().changeTabRuntime(tabId, "api")).toBe(
      "changed",
    );
    await vi.waitFor(() => {
      expect(useApprovalStore.getState().pending).toEqual({});
    });
    expect(invoke).toHaveBeenCalledWith("runtime_request_respond", {
      request: {
        requestId: "stale",
        decision: "cancel",
        persistence: null,
        answers: {},
      },
    });
  });

  it("cancels leftover prompts when the project tabs are replaced", async () => {
    const tabId = useClaudeChatStore.getState().activeTabId;
    useApprovalStore.getState().enqueue(approvalRequest("stale", tabId));

    expect(
      useClaudeChatStore.getState().resetForProject("/other-project"),
    ).toBe("reset");
    await vi.waitFor(() => {
      expect(useApprovalStore.getState().pending).toEqual({});
    });
  });
});

describe("close last conversation", () => {
  beforeEach(() => {
    useApprovalStore.getState().reset();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    resetChatToSingleIdleTab();
  });

  afterEach(() => {
    useApprovalStore.getState().reset();
    resetChatToSingleIdleTab();
  });

  it("replaces the last idle tab with a new empty conversation", async () => {
    const onlyId = useClaudeChatStore.getState().activeTabId;
    useClaudeChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === onlyId
          ? {
              ...tab,
              title: "Literature review",
              sessionId: "sess-last",
              messages: [
                {
                  type: "user",
                  message: { content: [{ type: "text", text: "hello" }] },
                },
              ],
            }
          : tab,
      ),
      sessionId: "sess-last",
    }));
    useApprovalStore.getState().enqueue(approvalRequest("last", onlyId));

    useClaudeChatStore.getState().closeTab(onlyId);

    const state = useClaudeChatStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].id).not.toBe(onlyId);
    expect(state.tabs[0].title).toBe("New Chat");
    expect(state.tabs[0].sessionId).toBeNull();
    expect(state.tabs[0].messages).toEqual([]);
    expect(state.activeTabId).toBe(state.tabs[0].id);
    expect(state.sessionId).toBeNull();
    await vi.waitFor(() => {
      expect(useApprovalStore.getState().pending).toEqual({});
    });
  });

  it("does not replace the last tab while it is streaming", () => {
    const tabId = useClaudeChatStore.getState().activeTabId;
    useClaudeChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              title: "Streaming",
              isStreaming: true,
              streamingStartedAt: 1,
              activeAttemptId: "attempt-last",
            }
          : tab,
      ),
      isStreaming: true,
    }));

    useClaudeChatStore.getState().closeTab(tabId);

    const state = useClaudeChatStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].id).toBe(tabId);
    expect(state.tabs[0].title).toBe("Streaming");
  });

  it("does not replace the last tab while it is stopping", () => {
    const tabId = useClaudeChatStore.getState().activeTabId;
    useClaudeChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              title: "Stopping",
              isStreaming: false,
              cancelledAttempts: [
                {
                  attemptId: "attempt-stop",
                  attemptEpoch: 1,
                  runtime: "claude",
                  mode: "terminate",
                },
              ],
            }
          : tab,
      ),
    }));

    useClaudeChatStore.getState().closeTab(tabId);

    const state = useClaudeChatStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].id).toBe(tabId);
    expect(state.tabs[0].title).toBe("Stopping");
  });
});

describe("close sessions after an account switch", () => {
  const accountA = "official-claude\0a@example.com";
  const accountB = "official-chatgpt\0b@example.com";

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(true);
    resetChatToSingleIdleTab();
    useClaudeChatStore.setState((state) => ({
      activeAccountKey: null,
      accountObserved: false,
      isStreaming: false,
      tabs: state.tabs.map((tab) => ({
        ...tab,
        openedUnderAccountKey: undefined,
        isStreaming: false,
        streamingStartedAt: null,
        cancelledAttempts: [],
        activeAttemptId: null,
      })),
    }));
  });

  afterEach(() => {
    useClaudeChatStore.setState({
      activeAccountKey: null,
      accountObserved: false,
    });
    resetChatToSingleIdleTab();
  });

  function streamActiveTab(attemptId: string) {
    const tabId = useClaudeChatStore.getState().activeTabId;
    useClaudeChatStore.setState((state) => ({
      isStreaming: true,
      tabs: state.tabs.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              title: "Live turn",
              isStreaming: true,
              streamingStartedAt: 1,
              activeAttemptId: attemptId,
              cancelledAttempts: [],
            }
          : tab,
      ),
    }));
    return tabId;
  }

  it("keeps the first signed-in account's live turn from being closed", () => {
    const tabId = streamActiveTab("attempt-current");

    useClaudeChatStore.getState().noteActiveAccount(accountA);

    const claimed = useClaudeChatStore.getState().tabs[0];
    expect(claimed?.openedUnderAccountKey).toBe(accountA);
    expect(claimed?.isStreaming).toBe(true);
    useClaudeChatStore.getState().closeTab(tabId);
    expect(
      useClaudeChatStore.getState().tabs.some((tab) => tab.id === tabId),
    ).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("closes a session that is still running under the previous account", () => {
    const foreignId = streamActiveTab("attempt-foreign");
    useClaudeChatStore.getState().noteActiveAccount(accountA);
    useClaudeChatStore.getState().noteActiveAccount(accountB);

    const released = useClaudeChatStore
      .getState()
      .tabs.find((tab) => tab.id === foreignId);
    expect(released?.openedUnderAccountKey).toBe(accountA);
    expect(released?.isStreaming).toBe(false);
    expect(released?.cancelledAttempts).toEqual([]);
    expect(invoke).toHaveBeenCalledWith("runtime_interrupt_turn", {
      runtime: "claude",
      tabId: foreignId,
      attemptId: "attempt-foreign",
      mode: "terminate",
    });

    useClaudeChatStore.setState((state) => ({
      isStreaming: true,
      tabs: state.tabs.map((tab) =>
        tab.id === foreignId
          ? {
              ...tab,
              isStreaming: true,
              streamingStartedAt: 2,
              activeAttemptId: "attempt-stuck",
            }
          : tab,
      ),
    }));
    useClaudeChatStore.getState().closeTab(foreignId);

    const state = useClaudeChatStore.getState();
    expect(state.tabs.some((tab) => tab.id === foreignId)).toBe(false);
    expect(state.tabs[0]?.openedUnderAccountKey).toBe(accountB);
    expect(invoke).toHaveBeenCalledWith("runtime_interrupt_turn", {
      runtime: "claude",
      tabId: foreignId,
      attemptId: "attempt-stuck",
      mode: "terminate",
    });
  });

  it("still refuses to close a live turn owned by the signed-in account", () => {
    const foreignId = streamActiveTab("attempt-foreign");
    useClaudeChatStore.getState().noteActiveAccount(accountA);
    useClaudeChatStore.getState().noteActiveAccount(accountB);
    const currentId = useClaudeChatStore.getState().createTab();
    useClaudeChatStore.setState((state) => ({
      isStreaming: true,
      tabs: state.tabs.map((tab) =>
        tab.id === currentId
          ? {
              ...tab,
              title: "Current account",
              isStreaming: true,
              streamingStartedAt: 3,
              activeAttemptId: "attempt-current",
            }
          : tab,
      ),
    }));

    useClaudeChatStore.getState().closeTab(currentId);
    expect(
      useClaudeChatStore.getState().tabs.some((tab) => tab.id === currentId),
    ).toBe(true);
    expect(
      useClaudeChatStore.getState().tabs.find((tab) => tab.id === currentId)
        ?.openedUnderAccountKey,
    ).toBe(accountB);

    useClaudeChatStore.getState().closeTab(foreignId);
    expect(
      useClaudeChatStore.getState().tabs.some((tab) => tab.id === foreignId),
    ).toBe(false);
  });

  it("unlocks a session that is stuck stopping after the account changes", () => {
    const tabId = useClaudeChatStore.getState().activeTabId;
    useClaudeChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              title: "Stopping",
              isStreaming: false,
              cancelledAttempts: [
                {
                  attemptId: "attempt-stop",
                  attemptEpoch: 1,
                  runtime: "claude",
                  mode: "terminate",
                },
              ],
            }
          : tab,
      ),
    }));
    useClaudeChatStore.getState().noteActiveAccount(accountA);
    useClaudeChatStore.getState().noteActiveAccount(accountB);

    const released = useClaudeChatStore.getState().tabs[0];
    expect(released?.cancelledAttempts).toEqual([]);
    useClaudeChatStore.getState().closeTab(tabId);
    expect(
      useClaudeChatStore.getState().tabs.some((tab) => tab.id === tabId),
    ).toBe(false);
  });
});
