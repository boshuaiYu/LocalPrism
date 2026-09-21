import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  listen,
  type Event as TauriEvent,
  type EventCallback,
} from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { remove } from "@tauri-apps/plugin-fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getDocumentState,
  refreshFiles,
  createSnapshot,
  compileLatex,
  resolveCompileTarget,
} = vi.hoisted(() => ({
  getDocumentState: vi.fn(),
  refreshFiles: vi.fn(() => Promise.resolve()),
  createSnapshot: vi.fn(() => Promise.resolve()),
  compileLatex: vi.fn(() => Promise.resolve(new Uint8Array([1]))),
  resolveCompileTarget: vi.fn((_activeFileId: string, files: any[]) => {
    const file = files.find((candidate) => candidate.type === "tex");
    return file ? { rootId: file.id, targetPath: file.relativePath } : null;
  }),
}));

vi.mock("@/stores/document-store", () => ({
  useDocumentStore: { getState: getDocumentState },
}));

vi.mock("@/stores/history-store", () => ({
  useHistoryStore: {
    getState: vi.fn(() => ({ createSnapshot })),
  },
}));

vi.mock("@/lib/latex-compiler", () => ({
  compileLatex,
  resolveCompileTarget,
  activeCompileUsesTexlive: () => false,
  formatCompileError: (error: unknown) => String(error),
}));

import { useClaudeEvents } from "@/hooks/use-claude-events";
import {
  CLAUDE_CODE_PROVIDER_ID,
  type TabState,
  useClaudeChatStore,
} from "@/stores/claude-chat-store";

function Probe() {
  useClaudeEvents();
  return null;
}

function completeEvent(
  tabId: string,
  success = false,
  attemptId = `${tabId}-attempt-1`,
): TauriEvent<unknown> {
  return {
    event: "claude-complete",
    id: 1,
    payload: { tab_id: tabId, attempt_id: attemptId, success },
  };
}

function dataEvent(
  event: "claude-output" | "claude-error",
  tabId: string,
  data: string,
  attemptId = `${tabId}-attempt-1`,
): TauriEvent<unknown> {
  return {
    event,
    id: 1,
    payload: { tab_id: tabId, attempt_id: attemptId, data },
  };
}

function runtimeEvent(
  tabId: string,
  attemptId: string,
  event: Record<string, unknown>,
): TauriEvent<unknown> {
  return {
    event: "runtime-event",
    id: 1,
    payload: {
      runtime: "codex",
      windowLabel: "main",
      tabId,
      attemptId,
      sessionId: null,
      turnId: "turn-1",
      sequence: 1,
      event,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makeTab(base: TabState, id: string): TabState {
  return {
    ...base,
    id,
    title: id,
    projectPath: "/project",
    runtime: "claude",
    sessionRef: null,
    sessionId: null,
    providerKey: CLAUDE_CODE_PROVIDER_ID,
    sessionProviderKey: CLAUDE_CODE_PROVIDER_ID,
    messages: [],
    isStreaming: true,
    streamingStartedAt: 1,
    streamingStatus: null,
    error: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    queuedGuidance: [],
    forceQueuedGuidanceOnComplete: false,
    forcedQueuedGuidanceId: null,
    pendingTemporaryFilePaths: [],
    attemptEpoch: 1,
    activeAttemptId: `${id}-attempt-1`,
    cancelledAttempts: [],
  };
}

describe("useClaudeEvents cancellation isolation", () => {
  let container: HTMLDivElement;
  let root: Root;
  const callbacks = new Map<string, EventCallback<unknown>>();

  beforeEach(async () => {
    vi.clearAllMocks();
    callbacks.clear();
    refreshFiles.mockReset().mockResolvedValue(undefined);
    createSnapshot.mockReset().mockResolvedValue(undefined);
    compileLatex.mockReset().mockResolvedValue(new Uint8Array([1]));
    vi.mocked(remove).mockReset().mockResolvedValue(undefined);
    vi.mocked(invoke).mockResolvedValue(true);
    vi.mocked(listen).mockImplementation((event, callback) => {
      callbacks.set(event, callback as EventCallback<unknown>);
      return Promise.resolve(vi.fn());
    });
    getDocumentState.mockReturnValue({
      projectRoot: null,
      files: [],
      activeFileId: null,
      isCompiling: false,
      refreshFiles,
    });

    const state = useClaudeChatStore.getState();
    const tabA = makeTab(state.tabs[0], "tab-a");
    const tabB = makeTab(state.tabs[0], "tab-b");
    useClaudeChatStore.setState({
      tabs: [tabA, tabB],
      activeTabId: tabA.id,
      activeProjectPath: "/project",
      messages: tabA.messages,
      sessionId: null,
      isStreaming: true,
      streamingStartedAt: 1,
      streamingStatus: null,
      error: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    });

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("consumes only tab A's cancelled attempt and preserves tab A's newer attempt and tab B's real error", async () => {
    await act(async () => {
      await useClaudeChatStore.getState().cancelExecution("tab-a");
    });

    await act(async () => {
      useClaudeChatStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === "tab-a"
            ? {
                ...tab,
                isStreaming: true,
                streamingStartedAt: 2,
                attemptEpoch: (tab.attemptEpoch ?? 0) + 1,
                activeAttemptId: "tab-a-attempt-new",
                pendingTemporaryFilePaths: ["new-attempt.tmp"],
                error: null,
              }
            : tab,
        ),
      }));
    });

    const complete = callbacks.get("claude-complete");
    expect(complete).toBeDefined();
    await act(async () => {
      complete?.(completeEvent("tab-a"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      useClaudeChatStore.getState().tabs.find((tab) => tab.id === "tab-a")
        ?.isStreaming,
    ).toBe(true);
    expect(
      useClaudeChatStore.getState().tabs.find((tab) => tab.id === "tab-a")
        ?.pendingTemporaryFilePaths,
    ).toEqual(["new-attempt.tmp"]);
    expect(
      useClaudeChatStore
        .getState()
        ._consumeAttemptCancellation("tab-a", "tab-a-attempt-1"),
    ).toBeNull();

    await act(async () => {
      complete?.(completeEvent("tab-b"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      useClaudeChatStore.getState().tabs.find((tab) => tab.id === "tab-b")
        ?.error,
    ).toMatch(/failed to start|exited unexpectedly/i);
  });

  it("does not let an older completion consume a newer attempt after an await", async () => {
    const snapshot = deferred<void>();
    createSnapshot.mockReturnValueOnce(snapshot.promise);
    getDocumentState.mockReturnValue({
      projectRoot: "/project",
      files: [],
      activeFileId: null,
      isCompiling: false,
      refreshFiles,
    });

    const complete = callbacks.get("claude-complete");
    await act(async () => {
      complete?.(completeEvent("tab-a", true));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(createSnapshot).toHaveBeenCalledTimes(1));

    await act(async () => {
      useClaudeChatStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === "tab-a"
            ? {
                ...tab,
                isStreaming: true,
                streamingStartedAt: 2,
                attemptEpoch: 2,
                activeAttemptId: "tab-a-attempt-2",
                pendingTemporaryFilePaths: ["new-attempt.tmp"],
                queuedGuidance: [
                  { id: "new-guidance", prompt: "Keep me", createdAt: 2 },
                ],
              }
            : tab,
        ),
      }));
      snapshot.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const tab = useClaudeChatStore
      .getState()
      .tabs.find((candidate) => candidate.id === "tab-a");
    expect(tab?.isStreaming).toBe(true);
    expect(tab?.pendingTemporaryFilePaths).toEqual(["new-attempt.tmp"]);
    expect(tab?.queuedGuidance).toEqual([
      { id: "new-guidance", prompt: "Keep me", createdAt: 2 },
    ]);
  });

  it("does not refresh a reopened incarnation of the same project after Claude completion", async () => {
    const snapshot = deferred<void>();
    createSnapshot.mockReturnValueOnce(snapshot.promise);
    const documentState: any = {
      projectRoot: "/project",
      projectGeneration: 1,
      files: [],
      activeFileId: null,
      isCompiling: false,
      refreshFiles,
    };
    getDocumentState.mockImplementation(() => documentState);

    const complete = callbacks.get("claude-complete");
    await act(async () => {
      complete?.(completeEvent("tab-a", true));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(createSnapshot).toHaveBeenCalledTimes(1));

    documentState.projectGeneration = 2;
    await act(async () => {
      snapshot.resolve();
      await snapshot.promise;
      await Promise.resolve();
    });

    expect(refreshFiles).not.toHaveBeenCalled();
    expect(compileLatex).not.toHaveBeenCalled();
  });

  it("does not refresh a reopened incarnation of the same project after Codex completion", async () => {
    const snapshot = deferred<void>();
    createSnapshot.mockReturnValueOnce(snapshot.promise);
    const documentState: any = {
      projectRoot: "/project",
      projectGeneration: 1,
      files: [],
      activeFileId: null,
      isCompiling: false,
      refreshFiles,
    };
    getDocumentState.mockImplementation(() => documentState);
    await act(async () => {
      useClaudeChatStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === "tab-a" ? { ...tab, runtime: "codex" as const } : tab,
        ),
      }));
    });

    const runtime = callbacks.get("runtime-event");
    await act(async () => {
      runtime?.(
        runtimeEvent("tab-a", "tab-a-attempt-1", {
          type: "turnCompleted",
          turnId: "turn-a",
        }),
      );
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(createSnapshot).toHaveBeenCalledTimes(1));

    documentState.projectGeneration = 2;
    await act(async () => {
      snapshot.resolve();
      await snapshot.promise;
      await Promise.resolve();
    });

    expect(refreshFiles).not.toHaveBeenCalled();
  });

  it("consumes a provisional stop marker when completion wins the response race", async () => {
    const stop = deferred<boolean>();
    vi.mocked(invoke).mockImplementation((command) =>
      command === "runtime_interrupt_turn"
        ? stop.promise
        : Promise.resolve(true),
    );

    const cancelling = useClaudeChatStore.getState().cancelExecution("tab-a");
    expect(
      useClaudeChatStore.getState().tabs.find((tab) => tab.id === "tab-a")
        ?.cancelledAttempts,
    ).toHaveLength(1);

    const complete = callbacks.get("claude-complete");
    await act(async () => {
      complete?.(completeEvent("tab-a"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      useClaudeChatStore.getState().tabs.find((tab) => tab.id === "tab-a")
        ?.cancelledAttempts,
    ).toEqual([]);

    stop.resolve(true);
    await cancelling;
    expect(
      useClaudeChatStore.getState().tabs.find((tab) => tab.id === "tab-a")
        ?.cancelledAttempts,
    ).toEqual([]);
  });

  it("treats false as terminal-won when completion clears the marker first", async () => {
    const stop = deferred<boolean>();
    vi.mocked(invoke).mockImplementation((command) =>
      command === "runtime_interrupt_turn"
        ? stop.promise
        : Promise.resolve(true),
    );

    const cancelling = useClaudeChatStore.getState().cancelExecution("tab-a");
    const complete = callbacks.get("claude-complete");
    await act(async () => {
      complete?.(completeEvent("tab-a", false, "tab-a-attempt-1"));
      await Promise.resolve();
      await Promise.resolve();
    });

    stop.resolve(false);
    await expect(cancelling).resolves.toBe("stopped");
    expect(
      useClaudeChatStore.getState().tabs.find((tab) => tab.id === "tab-a")
        ?.cancelledAttempts,
    ).toEqual([]);
  });

  it("keeps queued Claude terminal files while deleting files with no owner", async () => {
    await act(async () => {
      useClaudeChatStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === "tab-a"
            ? {
                ...tab,
                pendingTemporaryFilePaths: [
                  "claude-terminal-shared.tmp",
                  "claude-terminal-orphan.tmp",
                ],
                queuedGuidance: [
                  {
                    id: "queued-claude",
                    prompt: "Keep the shared attachment",
                    createdAt: 1,
                    contextOverride: {
                      label: "Queued attachment",
                      filePath: "claude-terminal-shared.tmp",
                      selectedText: "",
                      temporaryFilePaths: ["claude-terminal-shared.tmp"],
                    },
                  },
                ],
              }
            : tab,
        ),
      }));
    });

    const complete = callbacks.get("claude-complete");
    await act(async () => {
      complete?.(completeEvent("tab-a", false));
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() =>
      expect(remove).toHaveBeenCalledWith("claude-terminal-orphan.tmp"),
    );
    expect(remove).not.toHaveBeenCalledWith("claude-terminal-shared.tmp");
  });

  it("keeps another tab's pending Claude terminate file while deleting files with no owner", async () => {
    await act(async () => {
      useClaudeChatStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === "tab-a"
            ? {
                ...tab,
                attemptEpoch: 2,
                cancelledAttempts: [
                  {
                    attemptId: "tab-a-attempt-1",
                    attemptEpoch: 1,
                    runtime: "claude" as const,
                    mode: "terminate" as const,
                    temporaryFilePaths: [
                      "claude-terminate-shared.tmp",
                      "claude-terminate-orphan.tmp",
                    ],
                  },
                ],
              }
            : tab.id === "tab-b"
              ? {
                  ...tab,
                  pendingTemporaryFilePaths: ["claude-terminate-shared.tmp"],
                }
              : tab,
        ),
      }));
    });

    const complete = callbacks.get("claude-complete");
    await act(async () => {
      complete?.(completeEvent("tab-a", false));
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() =>
      expect(remove).toHaveBeenCalledWith("claude-terminate-orphan.tmp"),
    );
    expect(remove).not.toHaveBeenCalledWith("claude-terminate-shared.tmp");
  });

  it("keeps queued Codex terminal files while deleting files with no owner", async () => {
    await act(async () => {
      useClaudeChatStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === "tab-a"
            ? {
                ...tab,
                runtime: "codex" as const,
                pendingTemporaryFilePaths: [
                  "codex-terminal-shared.tmp",
                  "codex-terminal-orphan.tmp",
                ],
                queuedGuidance: [
                  {
                    id: "queued-codex",
                    prompt: "Keep the shared attachment",
                    createdAt: 1,
                    contextOverride: {
                      label: "Queued attachment",
                      filePath: "codex-terminal-shared.tmp",
                      selectedText: "",
                      temporaryFilePaths: ["codex-terminal-shared.tmp"],
                    },
                  },
                ],
              }
            : tab,
        ),
      }));
    });

    const runtime = callbacks.get("runtime-event");
    await act(async () => {
      runtime?.(
        runtimeEvent("tab-a", "tab-a-attempt-1", {
          type: "turnFailed",
          turnId: "turn-a",
          message: "failed",
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() =>
      expect(remove).toHaveBeenCalledWith("codex-terminal-orphan.tmp"),
    );
    expect(remove).not.toHaveBeenCalledWith("codex-terminal-shared.tmp");
  });

  it("keeps another tab's pending Codex terminate file while deleting files with no owner", async () => {
    await act(async () => {
      useClaudeChatStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === "tab-a"
            ? {
                ...tab,
                runtime: "codex" as const,
                attemptEpoch: 2,
                cancelledAttempts: [
                  {
                    attemptId: "tab-a-attempt-1",
                    attemptEpoch: 1,
                    runtime: "codex" as const,
                    mode: "terminate" as const,
                    temporaryFilePaths: [
                      "codex-terminate-shared.tmp",
                      "codex-terminate-orphan.tmp",
                    ],
                  },
                ],
              }
            : tab.id === "tab-b"
              ? {
                  ...tab,
                  pendingTemporaryFilePaths: ["codex-terminate-shared.tmp"],
                }
              : tab,
        ),
      }));
    });

    const runtime = callbacks.get("runtime-event");
    await act(async () => {
      runtime?.(
        runtimeEvent("tab-a", "tab-a-attempt-1", {
          type: "turnInterrupted",
          turnId: "turn-a",
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() =>
      expect(remove).toHaveBeenCalledWith("codex-terminate-orphan.tmp"),
    );
    expect(remove).not.toHaveBeenCalledWith("codex-terminate-shared.tmp");
  });

  it("ignores old Claude output, error, completion, and Ask cancellation", async () => {
    await act(async () => {
      useClaudeChatStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === "tab-a"
            ? {
                ...tab,
                attemptEpoch: 2,
                activeAttemptId: "tab-a-attempt-2",
                isStreaming: true,
              }
            : tab,
        ),
      }));
    });
    vi.mocked(invoke).mockClear();

    const output = callbacks.get("claude-output");
    const error = callbacks.get("claude-error");
    const complete = callbacks.get("claude-complete");
    const askMessage = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "ask-1", name: "AskUserQuestion" }],
      },
    });
    await act(async () => {
      output?.(
        dataEvent("claude-output", "tab-a", askMessage, "tab-a-attempt-1"),
      );
      error?.(
        dataEvent("claude-error", "tab-a", "Error: old", "tab-a-attempt-1"),
      );
      complete?.(completeEvent("tab-a", false, "tab-a-attempt-1"));
      await Promise.resolve();
      await Promise.resolve();
    });

    let tab = useClaudeChatStore
      .getState()
      .tabs.find((candidate) => candidate.id === "tab-a");
    expect(tab?.messages).toEqual([]);
    expect(tab?.error).toBeNull();
    expect(tab?.isStreaming).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith(
      "cancel_claude_execution",
      expect.anything(),
    );

    await act(async () => {
      output?.(
        dataEvent("claude-output", "tab-a", askMessage, "tab-a-attempt-2"),
      );
      await Promise.resolve();
    });
    expect(invoke).toHaveBeenCalledWith("cancel_claude_execution", {
      tabId: "tab-a",
      attemptId: "tab-a-attempt-2",
    });
    tab = useClaudeChatStore
      .getState()
      .tabs.find((candidate) => candidate.id === "tab-a");
    expect(tab?.messages).toHaveLength(1);
  });

  it("clears only the exact Codex terminal marker and never ends a newer attempt", async () => {
    await act(async () => {
      useClaudeChatStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === "tab-a"
            ? {
                ...tab,
                runtime: "codex" as const,
                attemptEpoch: 3,
                activeAttemptId: "codex-new-attempt",
                isStreaming: true,
                cancelledAttempts: [
                  {
                    attemptId: "codex-old-attempt",
                    attemptEpoch: 1,
                    runtime: "codex" as const,
                    mode: "terminate" as const,
                  },
                ],
              }
            : tab,
        ),
      }));
    });

    const runtime = callbacks.get("runtime-event");
    await act(async () => {
      runtime?.(
        runtimeEvent("tab-a", "codex-old-attempt", {
          type: "turnInterrupted",
          turnId: "old-turn",
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    let tab = useClaudeChatStore
      .getState()
      .tabs.find((candidate) => candidate.id === "tab-a");
    expect(tab?.cancelledAttempts).toEqual([]);
    expect(tab?.isStreaming).toBe(true);

    await act(async () => {
      runtime?.(
        runtimeEvent("tab-a", "codex-new-attempt", {
          type: "turnCompleted",
          turnId: "new-turn",
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    tab = useClaudeChatStore
      .getState()
      .tabs.find((candidate) => candidate.id === "tab-a");
    expect(tab?.isStreaming).toBe(false);
    expect(
      useClaudeChatStore
        .getState()
        .tabs.find((candidate) => candidate.id === "tab-b")?.isStreaming,
    ).toBe(true);
  });

  it("does not publish a completion compile after a newer attempt starts in the same project", async () => {
    const compilation = deferred<Uint8Array<ArrayBuffer>>();
    compileLatex.mockReturnValueOnce(compilation.promise);
    const setPdfData = vi.fn();
    const setCompileError = vi.fn();
    const setIsCompiling = vi.fn();
    const documentState: any = {
      projectRoot: "/project",
      projectGeneration: 1,
      contentGeneration: 1,
      isProjectMutating: false,
      files: [
        {
          id: "main.tex",
          relativePath: "main.tex",
          absolutePath: "/project/main.tex",
          type: "tex",
          content: "text",
          isDirty: false,
        },
      ],
      activeFileId: "main.tex",
      isCompiling: false,
      pendingRecompile: false,
      refreshFiles,
      saveAllFiles: vi.fn(() => Promise.resolve()),
      setPdfData,
      setCompileError,
      setIsCompiling: vi.fn((value: boolean) => {
        setIsCompiling(value);
        documentState.isCompiling = value;
      }),
      setPendingRecompile: vi.fn((value: boolean) => {
        documentState.pendingRecompile = value;
      }),
    };
    getDocumentState.mockImplementation(() => documentState);

    const complete = callbacks.get("claude-complete");
    await act(async () => {
      complete?.(completeEvent("tab-a", true, "tab-a-attempt-1"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(compileLatex).toHaveBeenCalledTimes(1));

    await act(async () => {
      useClaudeChatStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === "tab-a"
            ? {
                ...tab,
                attemptEpoch: 2,
                activeAttemptId: "tab-a-attempt-2",
                isStreaming: true,
              }
            : tab,
        ),
      }));
      compilation.resolve(new Uint8Array(new ArrayBuffer(1)));
      await compilation.promise;
      await Promise.resolve();
    });

    expect(setPdfData).not.toHaveBeenCalled();
    expect(setCompileError).not.toHaveBeenCalled();
    expect(setIsCompiling).toHaveBeenCalledWith(false);
  });

  it("does not publish a stale completion compile after project switch and releases the compile slot", async () => {
    const compilation = deferred<Uint8Array<ArrayBuffer>>();
    compileLatex.mockReturnValueOnce(compilation.promise);
    const setPdfData = vi.fn();
    const setCompileError = vi.fn();
    const setIsCompiling = vi.fn();
    const documentState: any = {
      projectRoot: "/project",
      files: [
        {
          id: "main.tex",
          relativePath: "main.tex",
          type: "tex",
          content: "text",
        },
      ],
      activeFileId: "main.tex",
      isCompiling: false,
      refreshFiles,
      saveAllFiles: vi.fn(() => Promise.resolve()),
      setPdfData,
      setCompileError,
      setIsCompiling: vi.fn((value: boolean) => {
        setIsCompiling(value);
        documentState.isCompiling = value;
      }),
      setPendingRecompile: vi.fn(),
    };
    getDocumentState.mockImplementation(() => documentState);

    const complete = callbacks.get("claude-complete");
    await act(async () => {
      complete?.(completeEvent("tab-a", true, "tab-a-attempt-1"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(compileLatex).toHaveBeenCalledTimes(1));

    await act(async () => {
      useClaudeChatStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === "tab-a"
            ? {
                ...tab,
                attemptEpoch: 2,
                activeAttemptId: "tab-a-attempt-2",
                isStreaming: true,
              }
            : tab,
        ),
      }));
      documentState.projectRoot = "/other-project";
      documentState.isCompiling = false;
      compilation.resolve(new Uint8Array(new ArrayBuffer(1)));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setPdfData).not.toHaveBeenCalled();
    expect(setCompileError).not.toHaveBeenCalled();
    expect(setIsCompiling).toHaveBeenCalledWith(true);
    expect(setIsCompiling).toHaveBeenCalledWith(false);
  });

  it("does not publish a stale completion compile after same-project reopen and releases the compile slot", async () => {
    const compilation = deferred<Uint8Array<ArrayBuffer>>();
    compileLatex.mockReturnValueOnce(compilation.promise);
    const setPdfData = vi.fn();
    const setCompileError = vi.fn();
    const setIsCompiling = vi.fn();
    const documentState: any = {
      projectRoot: "/project",
      projectGeneration: 1,
      files: [
        {
          id: "main.tex",
          relativePath: "main.tex",
          type: "tex",
          content: "text",
        },
      ],
      activeFileId: "main.tex",
      isCompiling: false,
      refreshFiles,
      saveAllFiles: vi.fn(() => Promise.resolve()),
      setPdfData,
      setCompileError,
      setIsCompiling: vi.fn((value: boolean) => {
        setIsCompiling(value);
        documentState.isCompiling = value;
      }),
      setPendingRecompile: vi.fn(),
    };
    getDocumentState.mockImplementation(() => documentState);

    const complete = callbacks.get("claude-complete");
    await act(async () => {
      complete?.(completeEvent("tab-a", true, "tab-a-attempt-1"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(compileLatex).toHaveBeenCalledTimes(1));

    documentState.projectGeneration = 2;
    documentState.isCompiling = false;
    await act(async () => {
      compilation.resolve(new Uint8Array(new ArrayBuffer(1)));
      await compilation.promise;
      await Promise.resolve();
    });

    expect(setPdfData).not.toHaveBeenCalled();
    expect(setCompileError).not.toHaveBeenCalled();
    expect(setIsCompiling).toHaveBeenCalledWith(true);
    expect(setIsCompiling).toHaveBeenCalledWith(false);
  });

  it("ignores all legacy Claude events for a Codex tab", async () => {
    await act(async () => {
      useClaudeChatStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === "tab-a" ? { ...tab, runtime: "codex" as const } : tab,
        ),
      }));
    });

    const output = callbacks.get("claude-output");
    const error = callbacks.get("claude-error");
    const complete = callbacks.get("claude-complete");
    await act(async () => {
      output?.(
        dataEvent(
          "claude-output",
          "tab-a",
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "legacy" }] },
          }),
        ),
      );
      error?.(dataEvent("claude-error", "tab-a", "Error: legacy"));
      complete?.(completeEvent("tab-a"));
      await Promise.resolve();
      await Promise.resolve();
    });

    const tab = useClaudeChatStore
      .getState()
      .tabs.find((candidate) => candidate.id === "tab-a");
    expect(tab?.messages).toEqual([]);
    expect(tab?.error).toBeNull();
    expect(tab?.isStreaming).toBe(true);
  });

  it("preserves Codex reasoning when the final assistant message replaces streamed text", async () => {
    await act(async () => {
      useClaudeChatStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === "tab-a" ? { ...tab, runtime: "codex" as const } : tab,
        ),
      }));
    });

    const runtime = callbacks.get("runtime-event");
    await act(async () => {
      runtime?.(
        runtimeEvent("tab-a", "tab-a-attempt-1", {
          type: "reasoningSummaryDelta",
          delta: "Inspecting the project",
        }),
      );
      runtime?.(
        runtimeEvent("tab-a", "tab-a-attempt-1", {
          type: "assistantDelta",
          delta: "Draft",
        }),
      );
      runtime?.(
        runtimeEvent("tab-a", "tab-a-attempt-1", {
          type: "assistantCompleted",
          content: "Final answer",
        }),
      );
      await Promise.resolve();
    });

    const tab = useClaudeChatStore
      .getState()
      .tabs.find((candidate) => candidate.id === "tab-a");
    expect(tab?.messages).toHaveLength(1);
    expect(tab?.messages[0]).toEqual(
      expect.objectContaining({
        subtype: "streaming_final",
        message: {
          content: [
            { type: "thinking", thinking: "Inspecting the project" },
            { type: "text", text: "Final answer" },
          ],
        },
      }),
    );
  });

  it("stall-fails a Codex turn with reconnect noise but no assistant progress", async () => {
    vi.useFakeTimers();
    try {
      // Remount under fake timers so the stall interval is controlled.
      await act(async () => {
        root.unmount();
      });
      container.remove();
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      await act(async () => {
        root.render(<Probe />);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      await act(async () => {
        useClaudeChatStore.setState((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.id === "tab-a"
              ? {
                  ...tab,
                  runtime: "codex" as const,
                  isStreaming: true,
                  activeAttemptId: "tab-a-attempt-1",
                  streamingStartedAt: Date.now(),
                  streamingStatus: "Codex is working…",
                  error: null,
                }
              : tab,
          ),
        }));
      });

      const runtime = callbacks.get("runtime-event");
      await act(async () => {
        runtime?.(
          runtimeEvent("tab-a", "tab-a-attempt-1", { type: "turnStarted" }),
        );
        runtime?.(
          runtimeEvent("tab-a", "tab-a-attempt-1", {
            type: "warning",
            message: "Reconnecting... 2/5",
          }),
        );
        await Promise.resolve();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(90_000);
      });

      let tab = useClaudeChatStore
        .getState()
        .tabs.find((candidate) => candidate.id === "tab-a");
      // WebSocket reconnect storms often finish after ~75–120s; do not abort yet.
      expect(tab?.isStreaming).toBe(true);
      expect(tab?.error).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(90_000);
      });

      tab = useClaudeChatStore
        .getState()
        .tabs.find((candidate) => candidate.id === "tab-a");
      expect(tab?.isStreaming).toBe(false);
      expect(tab?.streamingStatus).toBeNull();
      expect(tab?.error).toMatch(/no reply progress/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stall-fails a Claude turn that never produces a reply", async () => {
    vi.useFakeTimers();
    try {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      await act(async () => {
        root.render(<Probe />);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      await act(async () => {
        useClaudeChatStore.setState((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.id === "tab-a"
              ? {
                  ...tab,
                  runtime: "claude" as const,
                  isStreaming: true,
                  activeAttemptId: "tab-a-attempt-1",
                  streamingStartedAt: Date.now(),
                  streamingStatus: "Thinking...",
                  error: null,
                }
              : tab,
          ),
        }));
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(90_000);
      });

      let tab = useClaudeChatStore
        .getState()
        .tabs.find((candidate) => candidate.id === "tab-a");
      expect(tab?.isStreaming).toBe(true);
      expect(tab?.error).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(90_000);
      });

      tab = useClaudeChatStore
        .getState()
        .tabs.find((candidate) => candidate.id === "tab-a");
      expect(tab?.isStreaming).toBe(false);
      expect(tab?.error).toMatch(/no reply/i);
      expect(tab?.error).not.toMatch(/Codex/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps streaming through Codex reconnect warnings and clears on turnCompleted", async () => {
    await act(async () => {
      useClaudeChatStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === "tab-a"
            ? {
                ...tab,
                runtime: "codex" as const,
                error: null,
                isStreaming: true,
                streamingStatus: null,
              }
            : tab,
        ),
      }));
    });

    const runtime = callbacks.get("runtime-event");
    await act(async () => {
      runtime?.(
        runtimeEvent("tab-a", "tab-a-attempt-1", {
          type: "warning",
          message: "Reconnecting... 2/5 (request timed out)",
        }),
      );
      await Promise.resolve();
    });

    let tab = useClaudeChatStore
      .getState()
      .tabs.find((candidate) => candidate.id === "tab-a");
    expect(tab?.error).toBeNull();
    expect(tab?.isStreaming).toBe(true);
    expect(tab?.streamingStatus).toMatch(/reconnecting 2\/5/i);
    expect(tab?.streamingStatus).toMatch(
      /request timed out; still waiting for a reply/i,
    );

    await act(async () => {
      runtime?.(
        runtimeEvent("tab-a", "tab-a-attempt-1", {
          type: "assistantDelta",
          delta: "hello",
        }),
      );
      runtime?.(
        runtimeEvent("tab-a", "tab-a-attempt-1", {
          type: "turnCompleted",
          turnId: "turn-a",
        }),
      );
      await Promise.resolve();
    });

    tab = useClaudeChatStore
      .getState()
      .tabs.find((candidate) => candidate.id === "tab-a");
    expect(tab?.error).toBeNull();
    expect(tab?.isStreaming).toBe(false);
    expect(tab?.streamingStatus).toBeNull();
    expect(tab?.activeAttemptId).toBeNull();
    const lastMessage = tab?.messages[tab.messages.length - 1];
    expect(lastMessage).toEqual(
      expect.objectContaining({
        subtype: "streaming_delta",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
    );
  });

  it("surfaces an error when Codex completes with no visible reply", async () => {
    await act(async () => {
      useClaudeChatStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === "tab-a"
            ? {
                ...tab,
                runtime: "codex" as const,
                error: null,
                isStreaming: true,
                streamingStatus: "Waiting for Codex…",
                activeAttemptId: "tab-a-attempt-1",
                messages: [
                  {
                    type: "user",
                    message: { content: [{ type: "text", text: "你好" }] },
                  },
                ],
              }
            : tab,
        ),
      }));
    });

    const runtime = callbacks.get("runtime-event");
    await act(async () => {
      runtime?.(
        runtimeEvent("tab-a", "tab-a-attempt-1", { type: "turnStarted" }),
      );
      runtime?.(
        runtimeEvent("tab-a", "tab-a-attempt-1", {
          type: "assistantCompleted",
          content: "   ",
        }),
      );
      runtime?.(
        runtimeEvent("tab-a", "tab-a-attempt-1", {
          type: "turnCompleted",
          turnId: "turn-empty",
        }),
      );
      await Promise.resolve();
    });

    const tab = useClaudeChatStore
      .getState()
      .tabs.find((candidate) => candidate.id === "tab-a");
    expect(tab?.isStreaming).toBe(false);
    expect(tab?.activeAttemptId).toBeNull();
    expect(tab?.error).toMatch(/finished without a reply/i);
    expect(
      tab?.messages.some(
        (message) =>
          message.type === "assistant" &&
          Array.isArray(message.message?.content) &&
          message.message.content.some(
            (block) =>
              block.type === "text" &&
              /finished without a reply/i.test(block.text ?? ""),
          ),
      ),
    ).toBe(true);
  });

  it("surfaces empty Codex completion even after streaming was already cleared", async () => {
    await act(async () => {
      useClaudeChatStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === "tab-a"
            ? {
                ...tab,
                runtime: "codex" as const,
                error: null,
                // Premature clear: the bug that left only the user bubble.
                isStreaming: false,
                streamingStatus: null,
                activeAttemptId: null,
                messages: [
                  {
                    type: "user",
                    message: { content: [{ type: "text", text: "你好" }] },
                  },
                ],
              }
            : tab,
        ),
      }));
    });

    const runtime = callbacks.get("runtime-event");
    await act(async () => {
      runtime?.(
        runtimeEvent("tab-a", "tab-a-attempt-1", {
          type: "turnCompleted",
          turnId: "turn-late",
        }),
      );
      await Promise.resolve();
    });

    const tab = useClaudeChatStore
      .getState()
      .tabs.find((candidate) => candidate.id === "tab-a");
    expect(tab?.error).toMatch(/finished without a reply/i);
    expect(
      tab?.messages.some(
        (message) =>
          message.type === "assistant" &&
          Array.isArray(message.message?.content) &&
          message.message.content.some(
            (block) =>
              block.type === "text" &&
              /finished without a reply/i.test(block.text ?? ""),
          ),
      ),
    ).toBe(true);
  });

  it("surfaces Codex reconnect progress when the warning uses a unicode ellipsis", async () => {
    await act(async () => {
      useClaudeChatStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === "tab-a"
            ? {
                ...tab,
                runtime: "codex" as const,
                error: null,
                isStreaming: true,
                streamingStatus: "Waiting for Codex…",
              }
            : tab,
        ),
      }));
    });

    const runtime = callbacks.get("runtime-event");
    await act(async () => {
      runtime?.(
        runtimeEvent("tab-a", "tab-a-attempt-1", {
          type: "warning",
          message: "Codex will retry after an error: Reconnecting… 3/5",
        }),
      );
      await Promise.resolve();
    });

    const tab = useClaudeChatStore
      .getState()
      .tabs.find((candidate) => candidate.id === "tab-a");
    expect(tab?.error).toBeNull();
    expect(tab?.isStreaming).toBe(true);
    expect(tab?.streamingStatus).toBe(
      "Codex reconnecting 3/5 (request timed out; still waiting for a reply)…",
    );
  });

  it("keeps streaming through soft Codex warnings", async () => {
    await act(async () => {
      useClaudeChatStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === "tab-a"
            ? {
                ...tab,
                runtime: "codex" as const,
                error: null,
                isStreaming: true,
                streamingStatus: "Waiting for Codex…",
              }
            : tab,
        ),
      }));
    });

    const runtime = callbacks.get("runtime-event");
    await act(async () => {
      runtime?.(
        runtimeEvent("tab-a", "tab-a-attempt-1", {
          type: "warning",
          message: "temporary",
        }),
      );
      await Promise.resolve();
    });

    const tab = useClaudeChatStore
      .getState()
      .tabs.find((candidate) => candidate.id === "tab-a");
    expect(tab?.error).toBeNull();
    expect(tab?.isStreaming).toBe(true);
    expect(tab?.streamingStatus).toBe("temporary");
  });

  it("surfaces Codex turnFailed and clears streaming", async () => {
    await act(async () => {
      useClaudeChatStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === "tab-a"
            ? { ...tab, runtime: "codex" as const, isStreaming: true }
            : tab,
        ),
      }));
    });

    const runtime = callbacks.get("runtime-event");
    await act(async () => {
      runtime?.(
        runtimeEvent("tab-a", "tab-a-attempt-1", {
          type: "turnFailed",
          turnId: "turn-a",
          message: "Unsupported value: 'minimal'",
        }),
      );
      await Promise.resolve();
    });

    const tab = useClaudeChatStore
      .getState()
      .tabs.find((candidate) => candidate.id === "tab-a");
    expect(tab?.isStreaming).toBe(false);
    expect(tab?.error).toBe("Unsupported value: 'minimal'");
  });

  it("surfaces Claude stderr and exit code instead of a generic rate-limit guess", async () => {
    const output = callbacks.get("claude-output");
    const complete = callbacks.get("claude-complete");
    await act(async () => {
      output?.(
        dataEvent(
          "claude-output",
          "tab-a",
          JSON.stringify({
            type: "system",
            subtype: "init",
            session_id: "s1",
          }),
        ),
      );
      complete?.({
        event: "claude-complete",
        id: 1,
        payload: {
          tab_id: "tab-a",
          attempt_id: "tab-a-attempt-1",
          success: false,
          exit_code: 1,
          stderr_tail: "Error: prompt is too long (tokens=210000)",
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    const error = useClaudeChatStore
      .getState()
      .tabs.find((tab) => tab.id === "tab-a")?.error;
    expect(error).toMatch(/context limit|too long/i);
    expect(error).not.toMatch(
      /This may be due to rate limiting or an API error/,
    );
  });
});
