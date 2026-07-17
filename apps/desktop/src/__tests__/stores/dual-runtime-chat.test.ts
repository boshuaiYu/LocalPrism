import { invoke } from "@tauri-apps/api/core";
import { remove } from "@tauri-apps/plugin-fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDocumentState, createSnapshotMock } = vi.hoisted(() => ({
  getDocumentState: vi.fn(),
  createSnapshotMock: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@/stores/document-store", () => ({
  useDocumentStore: { getState: getDocumentState },
}));

vi.mock("@/stores/history-store", () => ({
  useHistoryStore: {
    getState: vi.fn(() => ({ createSnapshot: createSnapshotMock })),
  },
}));

import {
  CLAUDE_CODE_PROVIDER_ID,
  type TabState,
  useClaudeChatStore,
} from "@/stores/claude-chat-store";
import { projectChatStorageKey } from "@/stores/chat-persistence";

const projectPath = "/project";

function makeTab(overrides: Partial<TabState> = {}): TabState {
  const tab: TabState = {
    id: "tab-runtime",
    title: "New Chat",
    projectPath,
    runtime: "claude",
    sessionRef: null,
    sessionId: null,
    runtimeModel: null,
    reasoningEffort: null,
    agentId: null,
    providerKey: CLAUDE_CODE_PROVIDER_ID,
    sessionProviderKey: null,
    messages: [],
    isStreaming: false,
    streamingStartedAt: null,
    error: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    draft: { input: "", pinnedContexts: [] },
    queuedGuidance: [],
    forceQueuedGuidanceOnComplete: false,
    forcedQueuedGuidanceId: null,
    pendingTemporaryFilePaths: [],
    activeAttemptId: null,
    ...overrides,
  };
  if (tab.isStreaming && !tab.activeAttemptId) {
    tab.activeAttemptId = "tab-runtime-active";
  }
  return tab;
}

function resetStore(tab = makeTab()) {
  useClaudeChatStore.setState({
    messages: tab.messages,
    sessionId: tab.sessionId,
    isStreaming: tab.isStreaming,
    streamingStartedAt: tab.streamingStartedAt,
    error: tab.error,
    totalInputTokens: tab.totalInputTokens,
    totalOutputTokens: tab.totalOutputTokens,
    tabs: [tab],
    activeTabId: tab.id,
    activeProjectPath: projectPath,
    pendingInitialPrompt: null,
    pendingAttachments: [],
    pendingPinnedContextRemovalLabels: [],
    selectedModel: "opus",
    selectedProviderCredentialId: CLAUDE_CODE_PROVIDER_ID,
    selectedProviderModels: {},
    effortLevel: "medium",
  });
}

function setupDocument(overrides: Record<string, unknown> = {}) {
  const state: {
    projectRoot: string;
    files: any[];
    activeFileId: string | null;
    selectionRange: null;
    isProjectMutating: boolean;
    saveAllFiles: ReturnType<typeof vi.fn>;
    [key: string]: unknown;
  } = {
    projectRoot: projectPath,
    files: [],
    activeFileId: null,
    selectionRange: null,
    isProjectMutating: false,
    saveAllFiles: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
  getDocumentState.mockReturnValue(state);
  return state;
}

function runtimeRequest() {
  const call = vi
    .mocked(invoke)
    .mock.calls.find(([command]) => command === "runtime_start_turn");
  return (call?.[1] as { request?: Record<string, unknown> })?.request;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("dual-runtime chat dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockResolvedValue(undefined);
    createSnapshotMock.mockReset().mockResolvedValue(null);
    setupDocument();
    resetStore();
  });

  it("sends new and resumed Claude turns as typed runtime requests", async () => {
    await useClaudeChatStore.getState().sendPrompt("First prompt");

    expect(runtimeRequest()).toEqual({
      runtime: "claude",
      projectPath,
      tabId: "tab-runtime",
      attemptId: expect.any(String),
      sessionId: null,
      prompt: "First prompt",
      model: "opus",
      reasoningEffort: "medium",
      agentId: null,
      providerCredentialId: null,
      providerModelOverride: null,
    });
    vi.clearAllMocks();
    vi.mocked(invoke).mockResolvedValue(undefined);
    resetStore(
      makeTab({
        sessionId: "legacy-shadow-must-not-win",
        sessionRef: {
          runtime: "claude",
          sessionId: "claude-session",
          projectPath,
        },
      }),
    );

    await useClaudeChatStore.getState().sendPrompt("Resume prompt");

    expect(runtimeRequest()).toEqual(
      expect.objectContaining({
        runtime: "claude",
        sessionId: "claude-session",
        model: "opus",
        reasoningEffort: "medium",
      }),
    );
  });

  it("prefers the target Claude tab's model and effort", async () => {
    resetStore(
      makeTab({
        runtime: "claude",
        runtimeModel: "claude-sonnet-4-6",
        reasoningEffort: "high",
      }),
    );
    useClaudeChatStore.setState({
      selectedModel: "haiku",
      effortLevel: "low",
    });

    await useClaudeChatStore.getState().sendPrompt("Use tab selection");

    expect(runtimeRequest()).toEqual(
      expect.objectContaining({
        runtime: "claude",
        model: "claude-sonnet-4-6",
        reasoningEffort: "high",
      }),
    );
  });

  it("falls back to legacy global Claude model and effort selections", async () => {
    resetStore(
      makeTab({
        runtime: "claude",
        runtimeModel: null,
        reasoningEffort: null,
      }),
    );
    useClaudeChatStore.setState({
      selectedModel: "sonnet",
      effortLevel: "low",
    });

    await useClaudeChatStore.getState().sendPrompt("Use legacy selection");

    expect(runtimeRequest()).toEqual(
      expect.objectContaining({
        runtime: "claude",
        model: "sonnet",
        reasoningEffort: "low",
      }),
    );
  });

  it("preserves OpenAI-compatible credential and model overrides on Claude runtime", async () => {
    resetStore(
      makeTab({
        runtime: "claude",
        providerKey: "openai-compatible:provider-1",
      }),
    );
    useClaudeChatStore.setState({
      selectedProviderCredentialId: "provider-1",
      selectedProviderModels: { "provider-1": "gpt-5-compatible" },
    });

    await useClaudeChatStore.getState().sendPrompt("Use provider");

    expect(runtimeRequest()).toEqual(
      expect.objectContaining({
        runtime: "claude",
        model: "opus",
        providerCredentialId: "provider-1",
        providerModelOverride: "gpt-5-compatible",
      }),
    );
  });

  it("routes Codex by tab runtime even when its model name looks like Claude", async () => {
    resetStore(
      makeTab({
        runtime: "codex",
        runtimeModel: "claude-opus-looking-model",
        reasoningEffort: "high",
        agentId: "reviewer",
        providerKey: "openai-compatible:must-not-forward",
        sessionProviderKey: "openai-compatible:must-not-forward",
      }),
    );

    await useClaudeChatStore.getState().sendPrompt("Review this");

    expect(runtimeRequest()).toEqual({
      runtime: "codex",
      projectPath,
      tabId: "tab-runtime",
      attemptId: expect.any(String),
      sessionId: null,
      prompt: "Review this",
      model: "claude-opus-looking-model",
      reasoningEffort: "high",
      agentId: "reviewer",
      providerCredentialId: null,
      providerModelOverride: null,
    });
    expect(useClaudeChatStore.getState().tabs[0]).toEqual(
      expect.objectContaining({
        providerKey: "openai-compatible:must-not-forward",
        sessionProviderKey: "openai-compatible:must-not-forward",
      }),
    );
  });

  it("resumes Codex only from a matching Codex session ref", async () => {
    resetStore(
      makeTab({
        runtime: "codex",
        runtimeModel: "gpt-5.4",
        sessionId: "stale-shadow",
        sessionRef: {
          runtime: "codex",
          sessionId: "codex-thread-1",
          projectPath,
        },
      }),
    );

    await useClaudeChatStore.getState().sendPrompt("Continue Codex");

    expect(runtimeRequest()).toEqual(
      expect.objectContaining({
        runtime: "codex",
        sessionId: "codex-thread-1",
      }),
    );
  });

  it("trims the Codex model and normalizes blank optional selections to null", async () => {
    resetStore(
      makeTab({
        runtime: "codex",
        runtimeModel: "  gpt-5.4  ",
        reasoningEffort: "   ",
        agentId: "   ",
      }),
    );

    await useClaudeChatStore.getState().sendPrompt("Normalize options");

    expect(runtimeRequest()).toEqual(
      expect.objectContaining({
        model: "gpt-5.4",
        reasoningEffort: null,
        agentId: null,
      }),
    );
  });

  it("does not start or mutate a Codex turn without a selected model", async () => {
    const document = setupDocument({
      files: [{ id: "dirty", isDirty: true }],
      saveAllFiles: vi.fn(() => Promise.resolve()),
    });
    resetStore(makeTab({ runtime: "codex", runtimeModel: "  " }));
    const before = useClaudeChatStore.getState().tabs[0];

    await useClaudeChatStore.getState().sendPrompt("Must not send");

    const after = useClaudeChatStore.getState().tabs[0];
    expect(invoke).not.toHaveBeenCalled();
    expect(document.saveAllFiles).not.toHaveBeenCalled();
    expect(createSnapshotMock).not.toHaveBeenCalled();
    expect(after.messages).toEqual(before.messages);
    expect(after.isStreaming).toBe(false);
    expect(after.error).toMatch(/model/i);
  });

  it.each([
    {
      name: "cross-runtime",
      ref: { runtime: "codex" as const, sessionId: "wrong", projectPath },
    },
    {
      name: "cross-project",
      ref: {
        runtime: "claude" as const,
        sessionId: "wrong",
        projectPath: "/other-project",
      },
    },
  ])("ignores a $name session ref and its legacy shadow", async ({ ref }) => {
    resetStore(
      makeTab({
        runtime: "claude",
        sessionRef: ref,
        sessionId: "legacy-shadow",
      }),
    );

    await useClaudeChatStore.getState().sendPrompt("Fresh turn");

    expect(runtimeRequest()).toEqual(
      expect.objectContaining({ sessionId: null }),
    );
  });

  it("does not resume from a legacy-only session id", async () => {
    resetStore(makeTab({ sessionId: "legacy-only", sessionRef: null }));

    await useClaudeChatStore.getState().sendPrompt("Fresh turn");

    expect(runtimeRequest()).toEqual(
      expect.objectContaining({ sessionId: null }),
    );
  });

  it("interrupts cancellation with the tab's explicit runtime", async () => {
    resetStore(makeTab({ runtime: "codex", isStreaming: true }));
    vi.mocked(invoke).mockResolvedValueOnce(true);

    await useClaudeChatStore.getState().cancelExecution("tab-runtime");

    expect(invoke).toHaveBeenCalledWith("runtime_interrupt_turn", {
      runtime: "codex",
      tabId: "tab-runtime",
      attemptId: "tab-runtime-active",
      mode: "terminate",
    });
  });

  it("interrupts forced queued guidance with the tab's explicit runtime", async () => {
    resetStore(
      makeTab({
        runtime: "codex",
        isStreaming: true,
        queuedGuidance: [{ id: "guidance-1", prompt: "Now", createdAt: 1 }],
      }),
    );
    vi.mocked(invoke).mockResolvedValueOnce(true);

    await useClaudeChatStore
      .getState()
      .forceQueuedGuidanceNow("tab-runtime", "guidance-1");

    expect(invoke).toHaveBeenCalledWith("runtime_interrupt_turn", {
      runtime: "codex",
      tabId: "tab-runtime",
      attemptId: "tab-runtime-active",
      mode: "interrupt",
    });
  });

  it("coalesces repeated forced guidance stops for the same attempt", async () => {
    const stop = deferred<boolean>();
    resetStore(
      makeTab({
        runtime: "claude",
        isStreaming: true,
        attemptEpoch: 11,
        queuedGuidance: [{ id: "guidance-1", prompt: "Now", createdAt: 1 }],
        cancelledAttempts: [],
      }),
    );
    vi.mocked(invoke).mockReturnValue(
      stop.promise as ReturnType<typeof invoke>,
    );

    const first = useClaudeChatStore
      .getState()
      .forceQueuedGuidanceNow("tab-runtime", "guidance-1");
    const second = useClaudeChatStore
      .getState()
      .forceQueuedGuidanceNow("tab-runtime", "guidance-1");

    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([name]) => name === "runtime_interrupt_turn"),
    ).toHaveLength(1);
    await second;
    stop.resolve(true);
    await first;
    expect(useClaudeChatStore.getState().tabs[0].cancelledAttempts).toEqual([
      expect.objectContaining({ attemptEpoch: 11, mode: "interrupt" }),
    ]);
  });

  it("atomically supersedes a pending forced interrupt with ordinary stop", async () => {
    resetStore(
      makeTab({
        runtime: "claude",
        isStreaming: true,
        attemptEpoch: 4,
        queuedGuidance: [{ id: "guidance-1", prompt: "Now", createdAt: 1 }],
        cancelledAttempts: [],
      }),
    );
    vi.mocked(invoke).mockResolvedValue(true);

    await useClaudeChatStore
      .getState()
      .forceQueuedGuidanceNow("tab-runtime", "guidance-1");
    expect(useClaudeChatStore.getState().tabs[0].cancelledAttempts).toEqual([
      expect.objectContaining({ attemptEpoch: 4, mode: "interrupt" }),
    ]);

    const outcome = await useClaudeChatStore
      .getState()
      .cancelExecution("tab-runtime");

    expect(outcome).toBe("stopped");
    expect(useClaudeChatStore.getState().tabs[0].cancelledAttempts).toEqual([
      expect.objectContaining({ attemptEpoch: 4, mode: "terminate" }),
    ]);
    expect(
      useClaudeChatStore
        .getState()
        ._consumeAttemptCancellation("tab-runtime", "tab-runtime-active"),
    ).toEqual(expect.objectContaining({ attemptEpoch: 4, mode: "terminate" }));
    expect(
      useClaudeChatStore
        .getState()
        ._consumeAttemptCancellation("tab-runtime", "tab-runtime-active"),
    ).toBeNull();
  });

  it("supersedes an in-flight preflight force request instead of orphaning its marker", async () => {
    const forcedStop = deferred<boolean>();
    resetStore(
      makeTab({
        runtime: "claude",
        isStreaming: true,
        attemptEpoch: 5,
        preflightAttemptEpoch: 5,
        queuedGuidance: [{ id: "guidance-1", prompt: "Now", createdAt: 1 }],
        cancelledAttempts: [],
      }),
    );
    vi.mocked(invoke)
      .mockReturnValueOnce(forcedStop.promise as ReturnType<typeof invoke>)
      .mockResolvedValueOnce(true);

    const forcing = useClaudeChatStore
      .getState()
      .forceQueuedGuidanceNow("tab-runtime", "guidance-1");
    await expect(
      useClaudeChatStore.getState().cancelExecution("tab-runtime"),
    ).resolves.toBe("stopped");
    forcedStop.resolve(false);
    await forcing;

    const tab = useClaudeChatStore.getState().tabs[0];
    expect(tab.attemptEpoch).toBe(6);
    expect(tab.cancelledAttempts).toEqual([
      expect.objectContaining({
        attemptId: "tab-runtime-active",
        mode: "terminate",
      }),
    ]);
  });

  it("keeps a stopping tab intact when newSession opens another tab", async () => {
    const stop = deferred<boolean>();
    resetStore(
      makeTab({
        runtime: "claude",
        isStreaming: true,
        attemptEpoch: 8,
        pendingTemporaryFilePaths: ["old-attempt.tmp"],
        cancelledAttempts: [],
      }),
    );
    vi.mocked(invoke).mockReturnValue(
      stop.promise as ReturnType<typeof invoke>,
    );

    const cancelling = useClaudeChatStore
      .getState()
      .cancelExecution("tab-runtime");
    useClaudeChatStore.getState().newSession();

    const stateWhileStopping = useClaudeChatStore.getState();
    expect(stateWhileStopping.tabs).toHaveLength(2);
    expect(stateWhileStopping.activeTabId).not.toBe("tab-runtime");
    expect(
      stateWhileStopping.tabs.find((tab) => tab.id === "tab-runtime"),
    ).toEqual(
      expect.objectContaining({
        attemptEpoch: 9,
        cancelledAttempts: [
          expect.objectContaining({ attemptEpoch: 8, mode: "terminate" }),
        ],
      }),
    );

    stop.resolve(false);
    await expect(cancelling).resolves.toBe("not-found");
    expect(
      useClaudeChatStore
        .getState()
        .tabs.find((tab) => tab.id === "tab-runtime"),
    ).toEqual(
      expect.objectContaining({
        cancelledAttempts: [],
        pendingTemporaryFilePaths: [],
      }),
    );
  });

  it("does not close or reset a tab while its stop is awaiting completion", async () => {
    resetStore(
      makeTab({
        runtime: "claude",
        isStreaming: true,
        attemptEpoch: 2,
        cancelledAttempts: [],
      }),
    );
    useClaudeChatStore.getState().createTab();
    vi.mocked(invoke).mockResolvedValue(true);

    await useClaudeChatStore.getState().cancelExecution("tab-runtime");
    useClaudeChatStore.getState().closeTab("tab-runtime");
    const resetResult = useClaudeChatStore
      .getState()
      .resetForProject("/other-project");

    const state = useClaudeChatStore.getState();
    expect(resetResult).toBe("blocked-stopping");
    expect(state.tabs.some((tab) => tab.id === "tab-runtime")).toBe(true);
    expect(state.activeProjectPath).toBe(projectPath);
    expect(
      state.tabs.find((tab) => tab.id === "tab-runtime")?.cancelledAttempts,
    ).toHaveLength(1);
  });

  it("keeps a conservative stopping marker when stop transport rejects", async () => {
    resetStore(
      makeTab({
        runtime: "claude",
        isStreaming: true,
        attemptEpoch: 3,
        cancelledAttempts: [],
      }),
    );
    vi.mocked(invoke).mockRejectedValue(new Error("stop transport failed"));

    await expect(
      useClaudeChatStore.getState().cancelExecution("tab-runtime"),
    ).resolves.toBe("uncertain");
    await useClaudeChatStore.getState().sendPrompt("Must stay blocked");

    const tab = useClaudeChatStore.getState().tabs[0];
    expect(tab.cancelledAttempts).toEqual([
      expect.objectContaining({ attemptEpoch: 3, mode: "terminate" }),
    ]);
    expect(tab.error).toMatch(/waiting|confirm|stop/i);
    expect(tab.isStreaming).toBe(true);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([name]) => name === "runtime_start_turn"),
    ).toBe(false);
  });

  it("allows an uncertain Claude stop to be retried without replacing its attempt marker", async () => {
    resetStore(
      makeTab({
        runtime: "claude",
        isStreaming: true,
        attemptEpoch: 6,
        cancelledAttempts: [],
      }),
    );
    vi.mocked(invoke)
      .mockRejectedValueOnce(new Error("transport failed"))
      .mockResolvedValueOnce(true);

    await expect(
      useClaudeChatStore.getState().cancelExecution("tab-runtime"),
    ).resolves.toBe("uncertain");
    const marker = useClaudeChatStore.getState().tabs[0].cancelledAttempts?.[0];
    expect(marker).toEqual(
      expect.objectContaining({ attemptEpoch: 6, mode: "terminate" }),
    );

    await expect(
      useClaudeChatStore.getState().cancelExecution("tab-runtime"),
    ).resolves.toBe("stopped");
    const tab = useClaudeChatStore.getState().tabs[0];
    expect(tab.attemptEpoch).toBe(7);
    expect(tab.isStreaming).toBe(false);
    expect(tab.cancelledAttempts).toEqual([marker]);

    expect(
      useClaudeChatStore
        .getState()
        ._consumeAttemptCancellation("tab-runtime", "tab-runtime-active"),
    ).toEqual(marker);
    expect(useClaudeChatStore.getState().tabs[0].cancelledAttempts).toEqual([]);
  });

  it("rejects queued and forced guidance while an uncertain terminate marker exists", async () => {
    resetStore(
      makeTab({
        runtime: "claude",
        isStreaming: true,
        attemptEpoch: 12,
        queuedGuidance: [
          { id: "guidance-1", prompt: "Existing", createdAt: 1 },
        ],
        cancelledAttempts: [],
      }),
    );
    vi.mocked(invoke).mockRejectedValueOnce(new Error("transport failed"));
    await useClaudeChatStore.getState().cancelExecution("tab-runtime");
    const marker = useClaudeChatStore.getState().tabs[0].cancelledAttempts?.[0];
    vi.mocked(invoke).mockClear();

    useClaudeChatStore.getState().queueGuidance("tab-runtime", "New guidance");
    await useClaudeChatStore
      .getState()
      .forceQueuedGuidanceNow("tab-runtime", "guidance-1");

    const tab = useClaudeChatStore.getState().tabs[0];
    expect(tab.cancelledAttempts).toEqual([marker]);
    expect(tab.queuedGuidance).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not start a turn while the project is mutating", async () => {
    setupDocument({ isProjectMutating: true });

    await useClaudeChatStore.getState().sendPrompt("Blocked by rename");

    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([name]) => name === "runtime_start_turn"),
    ).toBe(false);
    expect(useClaudeChatStore.getState().tabs[0].isStreaming).toBe(false);
    expect(useClaudeChatStore.getState().tabs[0].error).toMatch(/project/i);
  });

  it("rechecks the project mutation guard after deferred preflight work", async () => {
    const save = deferred<void>();
    const document = setupDocument({
      isProjectMutating: false,
      files: [{ id: "dirty", isDirty: true }],
      saveAllFiles: vi.fn(() => save.promise),
    });

    const sending = useClaudeChatStore.getState().sendPrompt("Old project");
    await vi.waitFor(() => expect(document.saveAllFiles).toHaveBeenCalled());
    document.isProjectMutating = true;
    save.resolve();
    await sending;

    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([name]) => name === "runtime_start_turn"),
    ).toBe(false);
  });

  it("cleans temporary context when a deferred preflight becomes unstable", async () => {
    const save = deferred<void>();
    const document = setupDocument({
      isProjectMutating: false,
      files: [{ id: "dirty", isDirty: true }],
      saveAllFiles: vi.fn(() => save.promise),
    });

    const sending = useClaudeChatStore.getState().sendPrompt("Old project", {
      label: "Pasted image",
      filePath: "/tmp/paste.png",
      selectedText: "",
      temporaryFilePaths: ["/tmp/paste.png"],
    });
    await vi.waitFor(() => expect(document.saveAllFiles).toHaveBeenCalled());
    document.isProjectMutating = true;
    save.resolve();
    await sending;

    await vi.waitFor(() =>
      expect(remove).toHaveBeenCalledWith("/tmp/paste.png"),
    );
    expect(
      useClaudeChatStore.getState().tabs[0].pendingTemporaryFilePaths,
    ).toEqual([]);
  });

  it("starts only the resent turn after a deferred save is cancelled with no process", async () => {
    const save = deferred<void>();
    let documentState: ReturnType<typeof setupDocument>;
    const saveAllFiles = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(save.promise)
      .mockImplementationOnce(async () => {
        documentState.files = documentState.files.map((file) => ({
          ...file,
          isDirty: false,
        }));
      });
    documentState = setupDocument({
      projectGeneration: 1,
      contentGeneration: 1,
      files: [{ id: "dirty", isDirty: true }],
      saveAllFiles,
    });
    vi.mocked(invoke).mockImplementation((command) =>
      Promise.resolve(command === "runtime_interrupt_turn" ? false : undefined),
    );

    const oldSend = useClaudeChatStore.getState().sendPrompt("Old prompt");
    await vi.waitFor(() => expect(saveAllFiles).toHaveBeenCalledTimes(1));
    await useClaudeChatStore.getState().cancelExecution("tab-runtime");
    await useClaudeChatStore.getState().sendPrompt("New prompt");
    save.resolve();
    await oldSend;

    const starts = vi
      .mocked(invoke)
      .mock.calls.filter(([name]) => name === "runtime_start_turn");
    expect(starts).toHaveLength(1);
    expect(
      (starts[0][1] as { request?: { prompt?: string } }).request?.prompt,
    ).toBe("New prompt");
    expect(useClaudeChatStore.getState().tabs[0].isStreaming).toBe(true);
  });

  it("cleans only captured temporary files when local preflight is cancelled", async () => {
    resetStore(
      makeTab({
        isStreaming: true,
        attemptEpoch: 5,
        preflightAttemptEpoch: 5,
        pendingTemporaryFilePaths: ["old-context.tmp"],
      }),
    );

    const cancelling = useClaudeChatStore
      .getState()
      .cancelExecution("tab-runtime");
    useClaudeChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === "tab-runtime"
          ? { ...tab, pendingTemporaryFilePaths: ["new-context.tmp"] }
          : tab,
      ),
    }));

    await expect(cancelling).resolves.toBe("not-found");
    expect(invoke).not.toHaveBeenCalledWith(
      "runtime_interrupt_turn",
      expect.anything(),
    );
    await vi.waitFor(() =>
      expect(remove).toHaveBeenCalledWith("old-context.tmp"),
    );
    expect(remove).not.toHaveBeenCalledWith("new-context.tmp");
    expect(
      useClaudeChatStore.getState().tabs[0].pendingTemporaryFilePaths,
    ).toEqual(["new-context.tmp"]);
  });

  it("cleans a stopped attempt's temporary files after definitive not-found", async () => {
    resetStore(
      makeTab({
        runtime: "codex",
        isStreaming: true,
        attemptEpoch: 9,
        preflightAttemptEpoch: null,
        pendingTemporaryFilePaths: ["stale-context.tmp"],
      }),
    );
    vi.mocked(invoke).mockResolvedValueOnce(false);

    await expect(
      useClaudeChatStore.getState().cancelExecution("tab-runtime"),
    ).resolves.toBe("not-found");

    await vi.waitFor(() =>
      expect(remove).toHaveBeenCalledWith("stale-context.tmp"),
    );
    const tab = useClaudeChatStore.getState().tabs[0];
    expect(tab.cancelledAttempts).toEqual([]);
    expect(tab.pendingTemporaryFilePaths).toEqual([]);
  });

  it("retries the exact stop after an already-dispatched start finishes registering", async () => {
    const start = deferred<void>();
    let stopCalls = 0;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "runtime_start_turn") return start.promise;
      if (command === "runtime_interrupt_turn") {
        stopCalls += 1;
        return Promise.resolve(stopCalls !== 1);
      }
      return Promise.resolve(undefined);
    });

    const sending = useClaudeChatStore.getState().sendPrompt("Race start");
    await vi.waitFor(() =>
      expect(runtimeRequest()?.attemptId).toEqual(expect.any(String)),
    );
    const attemptId = runtimeRequest()?.attemptId as string;
    const cancelling = useClaudeChatStore
      .getState()
      .cancelExecution("tab-runtime");
    await vi.waitFor(() => expect(stopCalls).toBe(1));
    start.resolve();

    await expect(cancelling).resolves.toBe("stopped");
    await sending;
    const stops = vi
      .mocked(invoke)
      .mock.calls.filter(([name]) => name === "runtime_interrupt_turn");
    expect(stops).toHaveLength(2);
    expect(stops[0][1]).toEqual(stops[1][1]);
    expect(stops[0][1]).toEqual({
      runtime: "claude",
      tabId: "tab-runtime",
      attemptId,
      mode: "terminate",
    });
  });

  it("makes an accepted pending stop retryable when deferred interrupt later fails", async () => {
    const start = deferred<void>();
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "runtime_start_turn") return start.promise;
      if (command === "runtime_interrupt_turn") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });

    const sending = useClaudeChatStore.getState().sendPrompt("Pending Codex");
    await vi.waitFor(() =>
      expect(runtimeRequest()?.attemptId).toEqual(expect.any(String)),
    );
    const attemptId = runtimeRequest()?.attemptId as string;
    await expect(
      useClaudeChatStore.getState().cancelExecution("tab-runtime"),
    ).resolves.toBe("stopped");
    expect(useClaudeChatStore.getState().tabs[0].isStreaming).toBe(false);

    start.reject(new Error("deferred interrupt failed"));
    await sending;
    let tab = useClaudeChatStore.getState().tabs[0];
    expect(tab.isStreaming).toBe(true);
    expect(tab.cancelledAttempts).toEqual([
      expect.objectContaining({ attemptId }),
    ]);
    expect(tab.error).toMatch(/retry stop|confirm/i);

    await expect(
      useClaudeChatStore.getState().cancelExecution("tab-runtime"),
    ).resolves.toBe("stopped");
    tab = useClaudeChatStore.getState().tabs[0];
    expect(tab.isStreaming).toBe(false);
    const stops = vi
      .mocked(invoke)
      .mock.calls.filter(([name]) => name === "runtime_interrupt_turn");
    expect(stops).toHaveLength(2);
    expect(stops[0][1]).toEqual(stops[1][1]);
  });

  it("keeps a dispatched pending attempt blocked and retryable when stop rejects", async () => {
    const start = deferred<void>();
    const stop = deferred<boolean>();
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "runtime_start_turn") return start.promise;
      if (command === "runtime_interrupt_turn") return stop.promise;
      return Promise.resolve(undefined);
    });

    const sending = useClaudeChatStore.getState().sendPrompt("Pending start");
    await vi.waitFor(() =>
      expect(runtimeRequest()?.attemptId).toEqual(expect.any(String)),
    );
    const attemptId = runtimeRequest()?.attemptId as string;
    const cancelling = useClaudeChatStore
      .getState()
      .cancelExecution("tab-runtime");
    stop.reject(new Error("deferred interrupt failed"));
    await expect(cancelling).resolves.toBe("uncertain");

    let tab = useClaudeChatStore.getState().tabs[0];
    expect(tab.isStreaming).toBe(true);
    expect(tab.cancelledAttempts).toEqual([
      expect.objectContaining({ attemptId }),
    ]);
    await useClaudeChatStore.getState().sendPrompt("Must remain blocked");
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([name]) => name === "runtime_start_turn"),
    ).toHaveLength(1);

    vi.mocked(invoke).mockImplementation((command) =>
      Promise.resolve(command === "runtime_interrupt_turn" ? true : undefined),
    );
    await expect(
      useClaudeChatStore.getState().cancelExecution("tab-runtime"),
    ).resolves.toBe("stopped");
    start.resolve();
    await sending;
    tab = useClaudeChatStore.getState().tabs[0];
    expect(tab.isStreaming).toBe(false);
    expect(tab.cancelledAttempts).toHaveLength(1);
  });

  it("invalidates a deferred snapshot when the tab is cancelled", async () => {
    const snapshot = deferred<null>();
    createSnapshotMock
      .mockReturnValueOnce(snapshot.promise)
      .mockResolvedValue(null);
    vi.mocked(invoke).mockImplementation((command) =>
      Promise.resolve(command === "runtime_interrupt_turn" ? false : undefined),
    );

    const oldSend = useClaudeChatStore.getState().sendPrompt("Old prompt");
    await vi.waitFor(() => expect(createSnapshotMock).toHaveBeenCalledTimes(1));
    await useClaudeChatStore.getState().cancelExecution("tab-runtime");
    await useClaudeChatStore.getState().sendPrompt("New prompt");
    snapshot.resolve(null);
    await oldSend;

    const starts = vi
      .mocked(invoke)
      .mock.calls.filter(([name]) => name === "runtime_start_turn");
    expect(starts).toHaveLength(1);
    expect(
      (starts[0][1] as { request?: { prompt?: string } }).request?.prompt,
    ).toBe("New prompt");
  });

  it("invalidates a deferred send when its tab runtime changes", async () => {
    const save = deferred<void>();
    setupDocument({
      files: [{ id: "dirty", isDirty: true }],
      saveAllFiles: vi.fn(() => save.promise),
    });

    const sending = useClaudeChatStore.getState().sendPrompt("Old prompt");
    useClaudeChatStore.getState()._setStreaming("tab-runtime", false);
    expect(
      useClaudeChatStore.getState().changeTabRuntime("tab-runtime", "codex"),
    ).toBe("changed");
    save.resolve();
    await sending;

    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([name]) => name === "runtime_start_turn"),
    ).toBe(false);
    expect(useClaudeChatStore.getState().tabs[0].runtime).toBe("codex");
  });

  it("invalidates a deferred snapshot when its tab runtime changes", async () => {
    const snapshot = deferred<null>();
    createSnapshotMock.mockReturnValueOnce(snapshot.promise);

    const sending = useClaudeChatStore.getState().sendPrompt("Old prompt");
    await vi.waitFor(() => expect(createSnapshotMock).toHaveBeenCalledTimes(1));
    useClaudeChatStore.getState()._setStreaming("tab-runtime", false);
    expect(
      useClaudeChatStore.getState().changeTabRuntime("tab-runtime", "codex"),
    ).toBe("changed");
    snapshot.resolve(null);
    await sending;

    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([name]) => name === "runtime_start_turn"),
    ).toBe(false);
  });

  it("refuses to reset project scope during deferred preflight work", async () => {
    const snapshot = deferred<null>();
    createSnapshotMock.mockReturnValueOnce(snapshot.promise);

    const sending = useClaudeChatStore.getState().sendPrompt("Old prompt");
    await vi.waitFor(() => expect(createSnapshotMock).toHaveBeenCalledTimes(1));
    const resetResult = useClaudeChatStore
      .getState()
      .resetForProject("/other-project");
    snapshot.resolve(null);
    await sending;

    expect(resetResult).toBe("blocked-stopping");
    expect(runtimeRequest()?.prompt).toBe("Old prompt");
    expect(useClaudeChatStore.getState().activeProjectPath).toBe(projectPath);
  });

  it("invalidates deferred preflight work when a new session replaces it", async () => {
    const snapshot = deferred<null>();
    createSnapshotMock.mockReturnValueOnce(snapshot.promise);

    const sending = useClaudeChatStore.getState().sendPrompt("Old prompt");
    await vi.waitFor(() => expect(createSnapshotMock).toHaveBeenCalledTimes(1));
    useClaudeChatStore.getState()._setStreaming("tab-runtime", false);
    useClaudeChatStore.getState().newSession();
    snapshot.resolve(null);
    await sending;

    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([name]) => name === "runtime_start_turn"),
    ).toBe(false);
    const oldTab = useClaudeChatStore
      .getState()
      .tabs.find((tab) => tab.id === "tab-runtime");
    expect(oldTab?.isStreaming).toBe(false);
  });

  it("cleans discarded pending and queued temporary contexts for a new session", async () => {
    resetStore(
      makeTab({
        pendingTemporaryFilePaths: ["/tmp/pending.png"],
        queuedGuidance: [
          {
            id: "queued",
            prompt: "Use this",
            createdAt: 1,
            contextOverride: {
              label: "Queued image",
              filePath: "/tmp/queued.png",
              selectedText: "",
              temporaryFilePaths: ["/tmp/queued.png"],
            },
          },
        ],
      }),
    );

    useClaudeChatStore.getState().newSession();

    await vi.waitFor(() => {
      expect(remove).toHaveBeenCalledWith("/tmp/pending.png");
      expect(remove).toHaveBeenCalledWith("/tmp/queued.png");
    });
    expect(useClaudeChatStore.getState().tabs[0]).toEqual(
      expect.objectContaining({
        pendingTemporaryFilePaths: [],
        queuedGuidance: [],
      }),
    );
  });

  it("invalidates deferred preflight work when its tab closes", async () => {
    const snapshot = deferred<null>();
    createSnapshotMock.mockReturnValueOnce(snapshot.promise);
    useClaudeChatStore.getState().createTab();

    const sending = useClaudeChatStore
      .getState()
      .sendPrompt("Old prompt", undefined, { tabId: "tab-runtime" });
    await vi.waitFor(() => expect(createSnapshotMock).toHaveBeenCalledTimes(1));
    useClaudeChatStore.getState()._setStreaming("tab-runtime", false);
    useClaudeChatStore.getState().closeTab("tab-runtime");
    snapshot.resolve(null);
    await sending;

    expect(
      useClaudeChatStore
        .getState()
        .tabs.some((tab) => tab.id === "tab-runtime"),
    ).toBe(false);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([name]) => name === "runtime_start_turn"),
    ).toBe(false);
  });

  it("surfaces a current save failure and ends only that attempt", async () => {
    setupDocument({
      files: [{ id: "dirty", isDirty: true }],
      saveAllFiles: vi.fn(() => Promise.reject(new Error("save failed"))),
    });

    await useClaudeChatStore.getState().sendPrompt("Will fail");

    const tab = useClaudeChatStore.getState().tabs[0];
    expect(tab.isStreaming).toBe(false);
    expect(tab.error).toBe("save failed");
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([name]) => name === "runtime_start_turn"),
    ).toBe(false);
  });

  it("rolls forced guidance back when no turn was stopped", async () => {
    resetStore(
      makeTab({
        runtime: "claude",
        isStreaming: true,
        attemptEpoch: 4,
        queuedGuidance: [{ id: "guidance-1", prompt: "Now", createdAt: 1 }],
      }),
    );
    vi.mocked(invoke).mockResolvedValueOnce(false);

    await useClaudeChatStore
      .getState()
      .forceQueuedGuidanceNow("tab-runtime", "guidance-1");

    const tab = useClaudeChatStore.getState().tabs[0];
    expect(tab.queuedGuidance?.[0]?.displayedInChat).toBe(false);
    expect(tab.forceQueuedGuidanceOnComplete).toBe(false);
    expect(tab.forcedQueuedGuidanceId).toBeNull();
    expect(tab.cancelledAttempts).toEqual([]);
  });

  it("blocks resend and runtime changes until a stopped Claude turn completes", async () => {
    resetStore(
      makeTab({
        runtime: "claude",
        isStreaming: true,
        attemptEpoch: 7,
        cancelledAttempts: [],
      }),
    );
    vi.mocked(invoke).mockResolvedValueOnce(true);

    await useClaudeChatStore.getState().cancelExecution("tab-runtime");
    await useClaudeChatStore.getState().sendPrompt("Too early");

    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([name]) => name === "runtime_start_turn"),
    ).toBe(false);
    expect(useClaudeChatStore.getState().tabs[0].error).toMatch(/waiting/i);
    expect(
      useClaudeChatStore.getState().changeTabRuntime("tab-runtime", "codex"),
    ).toBe("blocked-stopping");

    expect(
      useClaudeChatStore
        .getState()
        ._consumeAttemptCancellation("tab-runtime", "tab-runtime-active"),
    ).toEqual(expect.objectContaining({ attemptEpoch: 7, mode: "terminate" }));
    vi.mocked(invoke).mockResolvedValue(undefined);
    await useClaudeChatStore.getState().sendPrompt("After completion");
    expect(runtimeRequest()?.prompt).toBe("After completion");
  });

  it("prevents an older rejected attempt from overwriting a resent turn", async () => {
    const oldStart = deferred<void>();
    vi.mocked(invoke).mockImplementation((command, payload) => {
      if (command !== "runtime_start_turn") return Promise.resolve(undefined);
      const prompt = (payload as { request?: { prompt?: string } })?.request
        ?.prompt;
      return prompt === "Old prompt"
        ? oldStart.promise
        : Promise.resolve(undefined);
    });

    const oldSend = useClaudeChatStore.getState().sendPrompt("Old prompt");
    await vi.waitFor(() => expect(runtimeRequest()?.prompt).toBe("Old prompt"));
    useClaudeChatStore.getState()._setStreaming("tab-runtime", false);
    await useClaudeChatStore.getState().sendPrompt("New prompt");

    oldStart.reject(new Error("stale failure"));
    await oldSend;

    const tab = useClaudeChatStore.getState().tabs[0];
    expect(tab.error).toBeNull();
    expect(tab.isStreaming).toBe(true);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([name]) => name === "runtime_start_turn"),
    ).toHaveLength(2);
  });
});

describe("temporary chat file ownership", () => {
  const context = (path: string) => ({
    label: "Attachment",
    filePath: path,
    selectedText: "",
    temporaryFilePaths: [path],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    setupDocument();
    resetStore();
  });

  it("discards only the new attachment when a busy attempt rejects a send", async () => {
    resetStore(
      makeTab({
        isStreaming: true,
        pendingTemporaryFilePaths: ["existing-attempt.tmp"],
      }),
    );

    await useClaudeChatStore
      .getState()
      .sendPrompt("Busy", context("rejected-send.tmp"));

    await vi.waitFor(() =>
      expect(remove).toHaveBeenCalledWith("rejected-send.tmp"),
    );
    expect(remove).not.toHaveBeenCalledWith("existing-attempt.tmp");
    expect(
      useClaudeChatStore.getState().tabs[0].pendingTemporaryFilePaths,
    ).toEqual(["existing-attempt.tmp"]);
  });

  it.each([
    {
      name: "there is no open project",
      setup: () => setupDocument({ projectRoot: null }),
      tab: () => makeTab(),
    },
    {
      name: "the project is mutating",
      setup: () => setupDocument({ isProjectMutating: true }),
      tab: () => makeTab(),
    },
    {
      name: "a Codex model is missing",
      setup: () => setupDocument(),
      tab: () => makeTab({ runtime: "codex", runtimeModel: "  " }),
    },
  ])("cleans an abandoned prompt when $name", async ({ setup, tab }) => {
    setup();
    resetStore(tab() as TabState & { pendingTemporaryFilePaths?: string[] });
    useClaudeChatStore.setState((state) => ({
      tabs: state.tabs.map((candidate) => ({
        ...candidate,
        pendingTemporaryFilePaths: ["pending-prompt.tmp"],
      })),
    }));

    await useClaudeChatStore
      .getState()
      .sendPrompt("Rejected", context("direct-context.tmp"));

    await vi.waitFor(() => {
      expect(remove).toHaveBeenCalledWith("pending-prompt.tmp");
      expect(remove).toHaveBeenCalledWith("direct-context.tmp");
    });
    expect(
      useClaudeChatStore.getState().tabs[0].pendingTemporaryFilePaths,
    ).toEqual([]);
  });

  it("cleans idle pending and queued attachments when messages are cleared", async () => {
    resetStore(
      makeTab({
        pendingTemporaryFilePaths: ["clear-pending.tmp"],
        queuedGuidance: [
          {
            id: "clear-guidance",
            prompt: "Later",
            createdAt: 1,
            contextOverride: context("clear-queued.tmp"),
          },
        ],
      }),
    );

    useClaudeChatStore.getState().clearMessages();

    await vi.waitFor(() => {
      expect(remove).toHaveBeenCalledWith("clear-pending.tmp");
      expect(remove).toHaveBeenCalledWith("clear-queued.tmp");
    });
    expect(useClaudeChatStore.getState().tabs[0]).toEqual(
      expect.objectContaining({
        pendingTemporaryFilePaths: [],
        queuedGuidance: [],
      }),
    );
  });

  it("does not delete a discarded path that a new attempt has claimed", async () => {
    resetStore(makeTab({ pendingTemporaryFilePaths: ["reused.tmp"] }));

    useClaudeChatStore.getState().clearMessages();
    useClaudeChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) => ({
        ...tab,
        isStreaming: true,
        activeAttemptId: "new-attempt",
        pendingTemporaryFilePaths: ["reused.tmp"],
      })),
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(remove).not.toHaveBeenCalledWith("reused.tmp");
  });

  it("cleans removed guidance only after its path has no remaining owner", async () => {
    resetStore(
      makeTab({
        pendingTemporaryFilePaths: ["shared.tmp"],
        queuedGuidance: [
          {
            id: "remove-me",
            prompt: "Later",
            createdAt: 1,
            contextOverride: {
              ...context("unique.tmp"),
              temporaryFilePaths: ["unique.tmp", "shared.tmp"],
            },
          },
          {
            id: "keep-me",
            prompt: "Keep",
            createdAt: 2,
            contextOverride: context("also-kept.tmp"),
          },
        ],
      }),
    );

    useClaudeChatStore
      .getState()
      .removeQueuedGuidance("tab-runtime", "remove-me");

    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith("unique.tmp"));
    expect(remove).not.toHaveBeenCalledWith("shared.tmp");
    expect(remove).not.toHaveBeenCalledWith("also-kept.tmp");
  });

  it("cleans all unowned guidance paths when the queue is cleared", async () => {
    resetStore(
      makeTab({
        pendingTemporaryFilePaths: ["shared.tmp"],
        queuedGuidance: [
          {
            id: "clear-me",
            prompt: "Later",
            createdAt: 1,
            contextOverride: {
              ...context("queued-only.tmp"),
              temporaryFilePaths: ["queued-only.tmp", "shared.tmp"],
            },
          },
        ],
      }),
    );

    useClaudeChatStore.getState().clearQueuedGuidance("tab-runtime");

    await vi.waitFor(() =>
      expect(remove).toHaveBeenCalledWith("queued-only.tmp"),
    );
    expect(remove).not.toHaveBeenCalledWith("shared.tmp");
  });

  it("cleans a rejected queued attachment", async () => {
    resetStore(
      makeTab({
        cancelledAttempts: [
          {
            attemptId: "stopping",
            attemptEpoch: 1,
            runtime: "claude",
            mode: "terminate",
          },
        ],
      }),
    );

    useClaudeChatStore
      .getState()
      .queueGuidance("tab-runtime", "Rejected", context("rejected-queue.tmp"));

    await vi.waitFor(() =>
      expect(remove).toHaveBeenCalledWith("rejected-queue.tmp"),
    );
    expect(useClaudeChatStore.getState().tabs[0].queuedGuidance).toEqual([]);
  });

  it("cleans an idle tab's attachments when the tab closes", async () => {
    resetStore(
      makeTab({
        pendingTemporaryFilePaths: ["closed-pending.tmp"],
        queuedGuidance: [
          {
            id: "closed-guidance",
            prompt: "Later",
            createdAt: 1,
            contextOverride: context("closed-queued.tmp"),
          },
        ],
      }),
    );
    useClaudeChatStore.getState().createTab();

    useClaudeChatStore.getState().closeTab("tab-runtime");

    await vi.waitFor(() => {
      expect(remove).toHaveBeenCalledWith("closed-pending.tmp");
      expect(remove).toHaveBeenCalledWith("closed-queued.tmp");
    });
  });

  it("cleans discarded attachments when a tab changes runtime", async () => {
    resetStore(
      makeTab({
        pendingTemporaryFilePaths: ["runtime-pending.tmp"],
        queuedGuidance: [
          {
            id: "runtime-guidance",
            prompt: "Later",
            createdAt: 1,
            contextOverride: context("runtime-queued.tmp"),
          },
        ],
      }),
    );

    expect(
      useClaudeChatStore.getState().changeTabRuntime("tab-runtime", "codex"),
    ).toBe("changed");

    await vi.waitFor(() => {
      expect(remove).toHaveBeenCalledWith("runtime-pending.tmp");
      expect(remove).toHaveBeenCalledWith("runtime-queued.tmp");
    });
    expect(
      useClaudeChatStore.getState().tabs[0].pendingTemporaryFilePaths,
    ).toEqual([]);
  });

  it("cleans attachments discarded by a project reset", async () => {
    resetStore(
      makeTab({
        pendingTemporaryFilePaths: ["project-pending.tmp"],
        queuedGuidance: [
          {
            id: "project-guidance",
            prompt: "Later",
            createdAt: 1,
            contextOverride: context("project-queued.tmp"),
          },
        ],
      }),
    );

    expect(
      useClaudeChatStore.getState().resetForProject("/other-project"),
    ).toBe("reset");

    await vi.waitFor(() => {
      expect(remove).toHaveBeenCalledWith("project-pending.tmp");
      expect(remove).toHaveBeenCalledWith("project-queued.tmp");
    });
  });
});

describe("per-tab runtime selection lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDocument();
    resetStore();
  });

  it("inherits the active Codex selection when creating a tab", () => {
    resetStore(
      makeTab({
        runtime: "codex",
        runtimeModel: "gpt-5.4",
        reasoningEffort: "high",
        agentId: "reviewer",
        providerKey: "openai-compatible:provider-1",
        sessionId: "old-thread",
        sessionRef: {
          runtime: "codex",
          sessionId: "old-thread",
          projectPath,
        },
        messages: [{ type: "user", result: "old message" }],
      }),
    );

    const newTabId = useClaudeChatStore.getState().createTab();

    expect(
      useClaudeChatStore.getState().tabs.find((tab) => tab.id === newTabId),
    ).toEqual(
      expect.objectContaining({
        runtime: "codex",
        runtimeModel: "gpt-5.4",
        reasoningEffort: "high",
        agentId: "reviewer",
        providerKey: "openai-compatible:provider-1",
        sessionId: null,
        sessionRef: null,
        messages: [],
      }),
    );
  });

  it.each([
    {
      name: "running",
      busyState: { isStreaming: true, cancelledAttempts: [] },
    },
    {
      name: "stopping",
      busyState: {
        isStreaming: false,
        cancelledAttempts: [
          {
            attemptId: "stopping",
            attemptEpoch: 3,
            runtime: "codex" as const,
            mode: "terminate" as const,
          },
        ],
      },
    },
  ])("inherits the $name Codex tab selection for a new session", ({
    busyState,
  }) => {
    resetStore(
      makeTab({
        runtime: "codex",
        runtimeModel: "gpt-5.4",
        reasoningEffort: "high",
        agentId: "reviewer",
        providerKey: "openai-compatible:busy-provider",
        ...busyState,
      }),
    );

    useClaudeChatStore.getState().newSession();

    const state = useClaudeChatStore.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs.find((tab) => tab.id === state.activeTabId)).toEqual(
      expect.objectContaining({
        runtime: "codex",
        runtimeModel: "gpt-5.4",
        reasoningEffort: "high",
        agentId: "reviewer",
        providerKey: "openai-compatible:busy-provider",
        sessionId: null,
        sessionRef: null,
        messages: [],
      }),
    );
  });

  it("preserves an idle tab's Codex selection when starting a new session", () => {
    resetStore(
      makeTab({
        runtime: "codex",
        runtimeModel: "gpt-5.4",
        reasoningEffort: "high",
        agentId: "reviewer",
        sessionId: "old-thread",
        sessionRef: {
          runtime: "codex",
          sessionId: "old-thread",
          projectPath,
        },
        messages: [{ type: "user", result: "old message" }],
      }),
    );

    useClaudeChatStore.getState().newSession();

    expect(useClaudeChatStore.getState().tabs).toEqual([
      expect.objectContaining({
        id: "tab-runtime",
        runtime: "codex",
        runtimeModel: "gpt-5.4",
        reasoningEffort: "high",
        agentId: "reviewer",
        sessionId: null,
        sessionRef: null,
        messages: [],
      }),
    ]);
  });
});

describe("typed conversation resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDocument();
    resetStore();
  });

  it("reads and converts Codex history through its complete reference", async () => {
    const reference = {
      runtime: "codex" as const,
      sessionId: "thread-7",
      projectPath,
    };
    vi.mocked(invoke).mockResolvedValueOnce({
      reference,
      items: [
        {
          type: "userMessage",
          content: [{ type: "text", text: "Question" }],
        },
        { type: "reasoning", summary: ["Plan", "Check"] },
        { type: "agentMessage", text: "Answer" },
      ],
    });

    await useClaudeChatStore
      .getState()
      .resumeConversation(reference, "Codex history");

    expect(invoke).toHaveBeenCalledWith("runtime_read_conversation", {
      reference,
    });
    const tab = useClaudeChatStore.getState().tabs[0];
    expect(tab).toEqual(
      expect.objectContaining({
        runtime: "codex",
        sessionRef: reference,
        sessionId: "thread-7",
        title: "Codex history",
      }),
    );
    expect(tab.messages).toEqual([
      {
        type: "user",
        message: { content: [{ type: "text", text: "Question" }] },
      },
      {
        type: "assistant",
        subtype: "reasoning",
        message: {
          content: [{ type: "thinking", thinking: "Plan\nCheck" }],
        },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Answer" }] },
      },
    ]);
  });

  it("preserves the selected Claude provider when creating a tab during resume", async () => {
    const reference = {
      runtime: "claude" as const,
      sessionId: "pending-claude-session",
      projectPath,
    };
    const history = deferred<unknown>();
    resetStore(
      makeTab({
        runtime: "claude",
        providerKey: "openai-compatible:provider-1",
      }),
    );
    useClaudeChatStore.setState({
      selectedProviderCredentialId: "provider-1",
    });
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "runtime_read_conversation") {
        return history.promise as ReturnType<typeof invoke>;
      }
      return Promise.resolve(undefined) as ReturnType<typeof invoke>;
    });

    const resuming = useClaudeChatStore
      .getState()
      .resumeConversation(reference);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("runtime_read_conversation", {
        reference,
      }),
    );
    expect(useClaudeChatStore.getState().tabs[0].providerKey).toBeNull();
    expect(useClaudeChatStore.getState().selectedProviderCredentialId).toBe(
      "provider-1",
    );

    const newTabId = useClaudeChatStore.getState().createTab();
    const providerKeyBeforeSend = useClaudeChatStore
      .getState()
      .tabs.find((tab) => tab.id === newTabId)?.providerKey;
    await useClaudeChatStore.getState().sendPrompt("Continue with provider");
    history.resolve({ reference, items: [] });
    await resuming;

    expect(providerKeyBeforeSend).toBe("openai-compatible:provider-1");
    expect(invoke).toHaveBeenCalledWith("runtime_start_turn", {
      request: expect.objectContaining({
        runtime: "claude",
        tabId: newTabId,
        providerCredentialId: "provider-1",
      }),
    });
  });

  it("preserves runtime selection when reusing a tab with the same runtime", async () => {
    const reference = {
      runtime: "codex" as const,
      sessionId: "thread-same-runtime",
      projectPath,
    };
    resetStore(
      makeTab({
        runtime: "codex",
        runtimeModel: "gpt-5.4",
        reasoningEffort: "high",
        agentId: "reviewer",
      }),
    );
    vi.mocked(invoke).mockResolvedValueOnce({ reference, items: [] });

    await useClaudeChatStore.getState().resumeConversation(reference);

    expect(useClaudeChatStore.getState().tabs[0]).toEqual(
      expect.objectContaining({
        runtime: "codex",
        runtimeModel: "gpt-5.4",
        reasoningEffort: "high",
        agentId: "reviewer",
      }),
    );
  });

  it("clears incompatible runtime selection when reusing a cross-runtime tab", async () => {
    const reference = {
      runtime: "codex" as const,
      sessionId: "thread-cross-runtime",
      projectPath,
    };
    resetStore(
      makeTab({
        runtime: "claude",
        runtimeModel: "claude-opus-4-6",
        reasoningEffort: "high",
        agentId: "claude-agent",
      }),
    );
    vi.mocked(invoke).mockResolvedValueOnce({ reference, items: [] });

    await useClaudeChatStore.getState().resumeConversation(reference);

    expect(useClaudeChatStore.getState().tabs[0]).toEqual(
      expect.objectContaining({
        runtime: "codex",
        runtimeModel: null,
        reasoningEffort: null,
        agentId: null,
        providerKey: null,
      }),
    );
  });

  it("inherits same-runtime selection into a fresh carrier when resuming from a busy tab", async () => {
    const oldReference = {
      runtime: "codex" as const,
      sessionId: "old-thread",
      projectPath,
    };
    const reference = {
      runtime: "codex" as const,
      sessionId: "new-thread",
      projectPath,
    };
    const oldMessages: TabState["messages"] = [
      { type: "user", result: "old conversation" },
    ];
    resetStore(
      makeTab({
        runtime: "codex",
        runtimeModel: "gpt-5.4",
        reasoningEffort: "high",
        agentId: "reviewer",
        sessionId: oldReference.sessionId,
        sessionRef: oldReference,
        messages: oldMessages,
        isStreaming: true,
      }),
    );
    vi.mocked(invoke).mockResolvedValueOnce({ reference, items: [] });

    await useClaudeChatStore.getState().resumeConversation(reference);

    const state = useClaudeChatStore.getState();
    const carrier = state.tabs.find((tab) => tab.id === state.activeTabId);
    expect(state.tabs).toHaveLength(2);
    expect(carrier).toEqual(
      expect.objectContaining({
        runtime: "codex",
        runtimeModel: "gpt-5.4",
        reasoningEffort: "high",
        agentId: "reviewer",
        sessionId: reference.sessionId,
        sessionRef: reference,
        messages: [],
      }),
    );
    expect(state.tabs.find((tab) => tab.id === "tab-runtime")).toEqual(
      expect.objectContaining({
        sessionId: oldReference.sessionId,
        sessionRef: oldReference,
        messages: oldMessages,
        isStreaming: true,
      }),
    );
  });

  it("keeps a fresh busy-resume carrier selection empty across runtimes", async () => {
    const oldReference = {
      runtime: "claude" as const,
      sessionId: "old-session",
      projectPath,
    };
    const reference = {
      runtime: "codex" as const,
      sessionId: "new-thread",
      projectPath,
    };
    resetStore(
      makeTab({
        runtime: "claude",
        runtimeModel: "claude-opus-4-6",
        reasoningEffort: "high",
        agentId: "claude-agent",
        sessionId: oldReference.sessionId,
        sessionRef: oldReference,
        messages: [{ type: "user", result: "old conversation" }],
        isStreaming: true,
      }),
    );
    vi.mocked(invoke).mockResolvedValueOnce({ reference, items: [] });

    await useClaudeChatStore.getState().resumeConversation(reference);

    const state = useClaudeChatStore.getState();
    expect(state.tabs.find((tab) => tab.id === state.activeTabId)).toEqual(
      expect.objectContaining({
        runtime: "codex",
        runtimeModel: null,
        reasoningEffort: null,
        agentId: null,
        sessionId: reference.sessionId,
        sessionRef: reference,
        messages: [],
      }),
    );
  });

  it("reuses only the tab matching runtime, project, and session", async () => {
    const reference = {
      runtime: "codex" as const,
      sessionId: "shared-session",
      projectPath,
    };
    const base = makeTab();
    resetStore(base);
    useClaudeChatStore.setState({
      tabs: [
        base,
        makeTab({
          id: "wrong-runtime",
          runtime: "claude",
          sessionId: reference.sessionId,
          sessionRef: { ...reference, runtime: "claude" },
        }),
        makeTab({
          id: "exact-match",
          runtime: "codex",
          sessionId: reference.sessionId,
          sessionRef: reference,
          messages: [
            {
              type: "user",
              message: { content: [{ type: "text", text: "old" }] },
            },
          ],
        }),
      ],
    });
    vi.mocked(invoke).mockResolvedValueOnce({
      reference,
      items: [{ type: "agentMessage", text: "fresh" }],
    });

    await useClaudeChatStore.getState().resumeConversation(reference);

    const state = useClaudeChatStore.getState();
    expect(state.tabs).toHaveLength(3);
    expect(state.activeTabId).toBe("exact-match");
    expect(state.tabs.find((tab) => tab.id === "wrong-runtime")?.runtime).toBe(
      "claude",
    );
    expect(
      state.tabs.find((tab) => tab.id === "exact-match")?.messages,
    ).toEqual([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "fresh" }] },
      },
    ]);
  });

  it("does not reuse a same-runtime same-session tab from another project", async () => {
    const reference = {
      runtime: "codex" as const,
      sessionId: "shared-session",
      projectPath,
    };
    const base = makeTab({ runtime: "codex", runtimeModel: "gpt-5.4" });
    const wrongProject = makeTab({
      id: "wrong-project",
      projectPath: "/other-project",
      runtime: "codex",
      runtimeModel: "other-model",
      sessionId: reference.sessionId,
      sessionRef: reference,
      messages: [{ type: "user", result: "other project history" }],
    });
    resetStore(base);
    useClaudeChatStore.setState({ tabs: [base, wrongProject] });
    vi.mocked(invoke).mockResolvedValueOnce({
      reference,
      items: [{ type: "agentMessage", text: "current project history" }],
    });

    await useClaudeChatStore.getState().resumeConversation(reference);

    const state = useClaudeChatStore.getState();
    expect(state.activeTabId).toBe(base.id);
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs.find((tab) => tab.id === wrongProject.id)).toEqual(
      wrongProject,
    );
    expect(state.tabs.find((tab) => tab.id === base.id)).toEqual(
      expect.objectContaining({
        sessionRef: reference,
        messages: [
          {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "current project history" }],
            },
          },
        ],
      }),
    );
  });

  it("discards late or mismatched history by full reference and request ownership", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const referenceA = {
      runtime: "codex" as const,
      sessionId: "thread-a",
      projectPath,
    };
    const referenceB = {
      runtime: "claude" as const,
      sessionId: "session-b",
      projectPath,
    };
    vi.mocked(invoke).mockImplementation((_command, payload) => {
      const reference = (payload as { reference: { sessionId: string } })
        .reference;
      return (
        reference.sessionId === "thread-a" ? first.promise : second.promise
      ) as ReturnType<typeof invoke>;
    });

    const resumeA = useClaudeChatStore
      .getState()
      .resumeConversation(referenceA, "A");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    const resumeB = useClaudeChatStore
      .getState()
      .resumeConversation(referenceB, "B");
    second.resolve({
      reference: referenceB,
      items: [
        {
          type: "user",
          message: { content: [{ type: "text", text: "winner" }] },
        },
      ],
    });
    await resumeB;
    first.resolve({
      reference: { ...referenceA, projectPath: "/wrong-project" },
      items: [{ type: "agentMessage", text: "stale" }],
    });
    await resumeA;

    const tab = useClaudeChatStore.getState().tabs[0];
    expect(tab.sessionRef).toEqual(referenceB);
    expect(tab.title).toBe("B");
    expect(tab.messages[0]?.message?.content?.[0]?.text).toBe("winner");
  });

  it("lets the second same-reference request win over a late first response", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const reference = {
      runtime: "codex" as const,
      sessionId: "same-thread",
      projectPath,
    };
    vi.mocked(invoke)
      .mockReturnValueOnce(first.promise as ReturnType<typeof invoke>)
      .mockReturnValueOnce(second.promise as ReturnType<typeof invoke>);

    const firstResume = useClaudeChatStore
      .getState()
      .resumeConversation(reference);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    const secondResume = useClaudeChatStore
      .getState()
      .resumeConversation(reference);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    second.resolve({
      reference,
      items: [{ type: "agentMessage", text: "winner" }],
    });
    await secondResume;
    first.resolve({
      reference,
      items: [{ type: "agentMessage", text: "stale" }],
    });
    await firstResume;

    const tab = useClaudeChatStore.getState().tabs[0];
    expect(tab.sessionRef).toEqual(reference);
    expect(tab.messages).toEqual([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "winner" }] },
      },
    ]);
  });

  it("invalidates an in-flight history request when messages are cleared", async () => {
    const history = deferred<unknown>();
    const reference = {
      runtime: "codex" as const,
      sessionId: "thread-clear",
      projectPath,
    };
    vi.mocked(invoke).mockReturnValue(
      history.promise as ReturnType<typeof invoke>,
    );

    const resuming = useClaudeChatStore
      .getState()
      .resumeConversation(reference);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    useClaudeChatStore.getState().clearMessages();
    history.resolve({
      reference,
      items: [{ type: "agentMessage", text: "must stay discarded" }],
    });
    await resuming;

    const tab = useClaudeChatStore.getState().tabs[0];
    expect(tab.messages).toEqual([]);
    expect(tab.resumeRequestId).toBeNull();
  });

  it("rejects a backend history response whose echoed reference differs", async () => {
    const reference = {
      runtime: "codex" as const,
      sessionId: "thread-requested",
      projectPath,
    };
    vi.mocked(invoke).mockResolvedValueOnce({
      reference: { ...reference, sessionId: "thread-other" },
      items: [{ type: "agentMessage", text: "wrong thread" }],
    });

    await useClaudeChatStore.getState().resumeConversation(reference);

    const tab = useClaudeChatStore.getState().tabs[0];
    expect(tab.sessionRef).toEqual(reference);
    expect(tab.messages).toEqual([]);
    expect(tab.resumeRequestId).toBeNull();
  });

  it("rejects an echoed reference with the requested session but wrong runtime", async () => {
    const reference = {
      runtime: "codex" as const,
      sessionId: "thread-requested",
      projectPath,
    };
    vi.mocked(invoke).mockResolvedValueOnce({
      reference: { ...reference, runtime: "claude" },
      items: [{ type: "agentMessage", text: "wrong runtime" }],
    });

    await useClaudeChatStore.getState().resumeConversation(reference);

    const tab = useClaudeChatStore.getState().tabs[0];
    expect(tab.sessionRef).toEqual(reference);
    expect(tab.messages).toEqual([]);
    expect(tab.resumeRequestId).toBeNull();
  });

  it("rejects an echoed reference with the requested runtime and session but wrong project", async () => {
    const reference = {
      runtime: "codex" as const,
      sessionId: "thread-requested",
      projectPath,
    };
    vi.mocked(invoke).mockResolvedValueOnce({
      reference: { ...reference, projectPath: "/other-project" },
      items: [{ type: "agentMessage", text: "wrong project" }],
    });

    await useClaudeChatStore.getState().resumeConversation(reference);

    const tab = useClaudeChatStore.getState().tabs[0];
    expect(tab.sessionRef).toEqual(reference);
    expect(tab.messages).toEqual([]);
    expect(tab.resumeRequestId).toBeNull();
  });
});

describe("changeTabRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDocument();
    resetStore();
  });

  it("blocks a streaming tab without changing it", () => {
    resetStore(makeTab({ isStreaming: true }));
    const before = useClaudeChatStore.getState().tabs[0];

    const result = useClaudeChatStore
      .getState()
      .changeTabRuntime("tab-runtime", "codex");

    expect(result).toBe("blocked-streaming");
    expect(useClaudeChatStore.getState().tabs[0]).toEqual(before);
  });

  it("requires confirmation for a session and leaves all state untouched", () => {
    resetStore(
      makeTab({
        sessionId: "legacy-session",
        sessionRef: {
          runtime: "claude",
          sessionId: "session-1",
          projectPath,
        },
      }),
    );
    const before = useClaudeChatStore.getState();

    const result = useClaudeChatStore
      .getState()
      .changeTabRuntime("tab-runtime", "codex");

    expect(result).toBe("confirmation-required");
    expect(useClaudeChatStore.getState()).toEqual(before);
  });

  it("requires confirmation for a legacy-only session shadow", () => {
    resetStore(makeTab({ sessionId: "legacy-only", sessionRef: null }));
    const before = useClaudeChatStore.getState();

    const result = useClaudeChatStore
      .getState()
      .changeTabRuntime("tab-runtime", "codex");

    expect(result).toBe("confirmation-required");
    expect(useClaudeChatStore.getState()).toEqual(before);
  });

  it("atomically switches a confirmed session to fresh runtime state", () => {
    resetStore(
      makeTab({
        title: "Existing session",
        sessionId: "session-1",
        sessionRef: {
          runtime: "claude",
          sessionId: "session-1",
          projectPath,
        },
        runtimeModel: "old-model",
        reasoningEffort: "high",
        agentId: "old-agent",
        sessionProviderKey: "openai-compatible:provider-1",
        messages: [{ type: "user", result: "old" }],
        error: "old error",
        totalInputTokens: 8,
        totalOutputTokens: 5,
        draft: { input: "draft", pinnedContexts: [] },
        queuedGuidance: [{ id: "queued", prompt: "q", createdAt: 1 }],
        forceQueuedGuidanceOnComplete: true,
        forcedQueuedGuidanceId: "queued",
        pendingTemporaryFilePaths: ["/tmp/private"],
      }),
    );

    const result = useClaudeChatStore
      .getState()
      .changeTabRuntime("tab-runtime", "codex", { confirmSessionReset: true });

    expect(result).toBe("changed");
    expect(useClaudeChatStore.getState().tabs[0]).toEqual(
      expect.objectContaining({
        runtime: "codex",
        title: "New Chat",
        sessionRef: null,
        sessionId: null,
        runtimeModel: null,
        reasoningEffort: null,
        agentId: null,
        sessionProviderKey: null,
        messages: [],
        error: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        draft: { input: "draft", pinnedContexts: [] },
        queuedGuidance: [],
        forceQueuedGuidanceOnComplete: false,
        forcedQueuedGuidanceId: null,
        pendingTemporaryFilePaths: [],
      }),
    );
    expect(useClaudeChatStore.getState()).toEqual(
      expect.objectContaining({
        messages: [],
        sessionId: null,
        error: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      }),
    );
  });

  it("is idempotent for the same runtime", () => {
    const before = useClaudeChatStore.getState();

    const result = useClaudeChatStore
      .getState()
      .changeTabRuntime("tab-runtime", "claude");

    expect(result).toBe("unchanged");
    expect(useClaudeChatStore.getState()).toEqual(before);
  });

  it("reports a missing tab without changing state", () => {
    const before = useClaudeChatStore.getState();

    const result = useClaudeChatStore
      .getState()
      .changeTabRuntime("missing-tab", "codex");

    expect(result).toBe("not-found");
    expect(useClaudeChatStore.getState()).toEqual(before);
  });
});

describe("updateTabRuntimeSelection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setupDocument();
    resetStore();
  });

  it("atomically updates only the requested tab", () => {
    const matchingSessionId = "shared-session-id";
    const target = makeTab({
      sessionId: matchingSessionId,
      runtimeModel: "old-model",
      reasoningEffort: "low",
      agentId: "old-agent",
    });
    const other = makeTab({
      id: "other-tab",
      sessionId: matchingSessionId,
      runtimeModel: "other-model",
      reasoningEffort: "medium",
      agentId: "other-agent",
    });
    resetStore(target);
    useClaudeChatStore.setState({ tabs: [target, other] });

    const result = useClaudeChatStore
      .getState()
      .updateTabRuntimeSelection(target.id, {
        runtimeModel: "new-model",
        reasoningEffort: "high",
        agentId: "new-agent",
      });

    expect(result).toBe("changed");
    expect(
      useClaudeChatStore.getState().tabs.find((tab) => tab.id === target.id),
    ).toEqual(
      expect.objectContaining({
        runtimeModel: "new-model",
        reasoningEffort: "high",
        agentId: "new-agent",
      }),
    );
    expect(
      useClaudeChatStore.getState().tabs.find((tab) => tab.id === other.id),
    ).toEqual(other);
    const persisted = JSON.parse(
      localStorage.getItem(projectChatStorageKey(projectPath)) ?? "null",
    );
    expect(
      persisted.tabs.find((tab: TabState) => tab.id === target.id),
    ).toEqual(
      expect.objectContaining({
        runtimeModel: "new-model",
        reasoningEffort: "high",
        agentId: "new-agent",
      }),
    );
  });

  it("reports an unchanged selection without replacing tabs", () => {
    const beforeTabs = useClaudeChatStore.getState().tabs;

    const result = useClaudeChatStore
      .getState()
      .updateTabRuntimeSelection("tab-runtime", {
        runtimeModel: null,
        reasoningEffort: null,
        agentId: null,
      });

    expect(result).toBe("unchanged");
    expect(useClaudeChatStore.getState().tabs).toBe(beforeTabs);
  });

  it("reports a missing tab without replacing tabs", () => {
    const beforeTabs = useClaudeChatStore.getState().tabs;

    const result = useClaudeChatStore
      .getState()
      .updateTabRuntimeSelection("missing-tab", {
        runtimeModel: "new-model",
        reasoningEffort: "high",
        agentId: "new-agent",
      });

    expect(result).toBe("not-found");
    expect(useClaudeChatStore.getState().tabs).toBe(beforeTabs);
  });

  it("rejects a streaming tab without changing it", () => {
    resetStore(makeTab({ isStreaming: true }));
    const before = useClaudeChatStore.getState().tabs[0];

    const result = useClaudeChatStore
      .getState()
      .updateTabRuntimeSelection("tab-runtime", {
        runtimeModel: "new-model",
        reasoningEffort: "high",
        agentId: "new-agent",
      });

    expect(result).toBe("blocked-streaming");
    expect(useClaudeChatStore.getState().tabs[0]).toEqual(before);
  });

  it("rejects a stopping tab without changing it", () => {
    resetStore(
      makeTab({
        cancelledAttempts: [
          {
            attemptId: "stopping",
            attemptEpoch: 2,
            runtime: "claude",
            mode: "terminate",
          },
        ],
      }),
    );
    const before = useClaudeChatStore.getState().tabs[0];

    const result = useClaudeChatStore
      .getState()
      .updateTabRuntimeSelection("tab-runtime", {
        runtimeModel: "new-model",
        reasoningEffort: "high",
        agentId: "new-agent",
      });

    expect(result).toBe("blocked-stopping");
    expect(useClaudeChatStore.getState().tabs[0]).toEqual(before);
  });

  it("updates a conversation title by the full runtime project and session reference", () => {
    const claudeReference = {
      runtime: "claude" as const,
      projectPath,
      sessionId: "shared-session",
    };
    const codexReference = {
      ...claudeReference,
      runtime: "codex" as const,
    };
    useClaudeChatStore.setState({
      tabs: [
        makeTab({
          id: "tab-claude",
          title: "Claude title",
          runtime: "claude",
          sessionId: claudeReference.sessionId,
          sessionRef: claudeReference,
        }),
        makeTab({
          id: "tab-codex",
          title: "Codex title",
          runtime: "codex",
          sessionId: codexReference.sessionId,
          sessionRef: codexReference,
        }),
      ],
      activeTabId: "tab-claude",
      activeProjectPath: projectPath,
    });

    useClaudeChatStore
      .getState()
      ._setConversationTitle(codexReference, "Updated Codex");

    expect(
      useClaudeChatStore.getState().tabs.map((tab) => [tab.id, tab.title]),
    ).toEqual([
      ["tab-claude", "Claude title"],
      ["tab-codex", "Updated Codex"],
    ]);
  });
});
