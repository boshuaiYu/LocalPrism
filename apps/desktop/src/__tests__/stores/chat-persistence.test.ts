import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_TABS_STORAGE_KEY,
  migratePersistedChat,
  projectChatStorageKey,
  projectPersistedChat,
  readPersistedChat,
  readPersistedChatForProject,
  writePersistedChat,
} from "@/stores/chat-persistence";
import {
  normalizeTabSessionProjection,
  useClaudeChatStore,
} from "@/stores/claude-chat-store";

const persistedTab = (overrides: Record<string, unknown> = {}) => ({
  id: "tab-persisted",
  title: "Persisted chat",
  projectPath: "/project-a",
  runtime: "claude",
  sessionRef: {
    runtime: "claude",
    sessionId: "session-a",
    projectPath: "/project-a",
  },
  providerKey: "openai-compatible:qwen",
  sessionProviderKey: "openai-compatible:qwen",
  runtimeModel: "claude-opus-4-6",
  reasoningEffort: "high",
  agentId: "reviewer",
  ...overrides,
});

const persistedDocument = (
  tabs = [persistedTab()],
  activeTabId = "tab-persisted",
) => ({ version: 2, activeTabId, tabs });

function resetStoreToUnscopedDefault() {
  const current = useClaudeChatStore.getState();
  const base = current.tabs[0];
  useClaudeChatStore.setState({
    activeProjectPath: null,
    activeTabId: "tab-test-default",
    tabs: [
      {
        ...base,
        id: "tab-test-default",
        title: "New Chat",
        projectPath: null,
        runtime: "claude",
        sessionId: null,
        sessionRef: null,
        providerKey: null,
        sessionProviderKey: null,
        runtimeModel: null,
        reasoningEffort: null,
        agentId: null,
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
      },
    ],
    sessionId: null,
    messages: [],
    isStreaming: false,
    streamingStartedAt: null,
    error: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  resetStoreToUnscopedDefault();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chat persistence migration", () => {
  it("returns a safe Claude default document for null or unknown versions", () => {
    for (const input of [
      null,
      { version: 99, activeTabId: "untrusted", tabs: [persistedTab()] },
    ]) {
      const migrated = migratePersistedChat(input);

      expect(migrated.version).toBe(2);
      expect(migrated.tabs).toHaveLength(1);
      expect(migrated.activeTabId).toBe(migrated.tabs[0].id);
      expect(migrated.tabs[0]).toMatchObject({
        runtime: "claude",
        sessionId: null,
        sessionRef: null,
        messages: [],
        isStreaming: false,
        error: null,
      });
    }
  });

  it("migrates a plain v1 document without changing ids, sessions, or provider keys", () => {
    const migrated = migratePersistedChat({
      version: 1,
      activeTabId: "legacy-tab",
      tabs: [
        {
          id: "legacy-tab",
          title: "Legacy",
          projectPath: "/legacy",
          sessionId: "legacy-session",
          providerKey: "openai-compatible:provider-a",
          sessionProviderKey: "openai-compatible:provider-b",
        },
      ],
    });

    expect(migrated.activeTabId).toBe("legacy-tab");
    expect(migrated.tabs[0]).toMatchObject({
      id: "legacy-tab",
      projectPath: "/legacy",
      runtime: "claude",
      sessionId: "legacy-session",
      sessionRef: {
        runtime: "claude",
        sessionId: "legacy-session",
        projectPath: "/legacy",
      },
      providerKey: "openai-compatible:provider-a",
      sessionProviderKey: "openai-compatible:provider-b",
    });
  });

  it("keeps a v1 session id without fabricating a reference when projectPath is missing", () => {
    const migrated = migratePersistedChat({
      version: 1,
      activeTabId: "legacy-tab",
      tabs: [{ id: "legacy-tab", sessionId: "legacy-session" }],
    });

    expect(migrated.tabs[0].sessionId).toBe("legacy-session");
    expect(migrated.tabs[0].sessionRef).toBeNull();
  });

  it("projects the authoritative v2 session reference to legacy sessionId", () => {
    const migrated = migratePersistedChat(
      persistedDocument([
        persistedTab({
          runtime: "codex",
          projectPath: "/codex-project",
          sessionId: "untrusted-shadow",
          sessionRef: {
            runtime: "codex",
            sessionId: "codex-session",
            projectPath: "/codex-project",
          },
        }),
      ]),
    );

    expect(migrated.tabs[0].sessionId).toBe("codex-session");
    expect(migrated.tabs[0].sessionRef?.sessionId).toBe("codex-session");
  });

  it("repairs invalid active ids and duplicate or blank tab ids", () => {
    const migrated = migratePersistedChat(
      persistedDocument(
        [
          persistedTab({ id: "same" }),
          persistedTab({ id: "same", title: "Duplicate" }),
          persistedTab({ id: "  ", title: "Blank" }),
        ],
        "missing",
      ),
    );

    expect(new Set(migrated.tabs.map((tab) => tab.id)).size).toBe(3);
    expect(migrated.tabs.every((tab) => tab.id.trim().length > 0)).toBe(true);
    expect(migrated.activeTabId).toBe(migrated.tabs[0].id);
  });

  it("drops a session reference when its runtime or project does not match the tab", () => {
    const migrated = migratePersistedChat(
      persistedDocument([
        persistedTab({
          runtime: "codex",
          sessionRef: {
            runtime: "claude",
            sessionId: "wrong-runtime",
            projectPath: "/project-a",
          },
        }),
        persistedTab({
          id: "wrong-project",
          sessionRef: {
            runtime: "claude",
            sessionId: "wrong-project",
            projectPath: "/project-b",
          },
        }),
      ]),
    );

    expect(migrated.tabs.map((tab) => tab.sessionRef)).toEqual([null, null]);
    expect(migrated.tabs.map((tab) => tab.sessionId)).toEqual([null, null]);
  });

  it("hydrates every ephemeral field into an idle state", () => {
    const migrated = migratePersistedChat(
      persistedDocument([
        persistedTab({
          messages: [{ type: "user", apiKey: "secret" }],
          draft: { input: "secret draft", pinnedContexts: ["/tmp/secret"] },
          queuedGuidance: [{ prompt: "secret" }],
          pendingTemporaryFilePaths: ["/tmp/secret"],
          isStreaming: true,
          streamingStartedAt: 42,
          error: "raw backend error",
          totalInputTokens: 123,
          totalOutputTokens: 456,
        }),
      ]),
    );

    expect(migrated.tabs[0]).toMatchObject({
      messages: [],
      draft: { input: "", pinnedContexts: [] },
      queuedGuidance: [],
      pendingTemporaryFilePaths: [],
      isStreaming: false,
      streamingStartedAt: null,
      error: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      forceQueuedGuidanceOnComplete: false,
      forcedQueuedGuidanceId: null,
    });
  });
});

describe("chat persistence I/O", () => {
  it.each([
    ["C:\\Work\\Paper\\", "c:/work/paper"],
    ["C:\\", "c:/"],
    ["C:/", "c:/"],
    ["\\\\Server\\Share\\", "//server/share"],
    ["\\\\Server\\Share\\Folder\\", "//server/share/folder"],
  ])("uses one project key for equivalent path spellings %s", (left, right) => {
    expect(projectChatStorageKey(left)).toBe(projectChatStorageKey(right));
  });

  it("preserves the POSIX root instead of canonicalizing it to an empty path", () => {
    expect(projectChatStorageKey("/")).not.toBe(projectChatStorageKey(""));
  });

  it("rebinds a canonical project match and its session reference to the current path spelling", () => {
    const persistedPath = "C:\\Work\\Paper";
    const currentPath = "c:/work/paper";
    localStorage.setItem(
      projectChatStorageKey(persistedPath),
      JSON.stringify(
        persistedDocument([
          persistedTab({
            projectPath: persistedPath,
            sessionRef: {
              runtime: "claude",
              sessionId: "windows-session",
              projectPath: persistedPath,
            },
          }),
        ]),
      ),
    );

    const restored = readPersistedChatForProject(currentPath);

    expect(restored.tabs[0]).toMatchObject({
      projectPath: currentPath,
      sessionId: "windows-session",
      sessionRef: {
        runtime: "claude",
        sessionId: "windows-session",
        projectPath: currentPath,
      },
    });
  });

  it("safely projects null input to a default Claude document", () => {
    expect(() => projectPersistedChat(null as never)).not.toThrow();
    expect(projectPersistedChat(null as never).tabs[0].runtime).toBe("claude");
  });

  it("uses a strict v2 whitelist and never stores chat content or secrets", () => {
    const projected = projectPersistedChat({
      activeTabId: "tab-persisted",
      tabs: [
        {
          ...persistedTab(),
          sessionId: "legacy-shadow",
          messages: [{ type: "user", apiKey: "sk-secret" }],
          draft: { input: "secret draft", pinnedContexts: [] },
          queuedGuidance: [{ prompt: "secret guidance" }],
          pendingTemporaryFilePaths: ["C:/tmp/secret.txt"],
          attemptEpoch: 99,
          preflightAttemptEpoch: 99,
          cancelledAttempts: [
            { attemptId: "private-attempt", mode: "terminate" },
          ],
          attachments: [{ path: "C:/tmp/attachment" }],
          isStreaming: true,
          streamingStartedAt: 123,
          error: "raw event",
          totalInputTokens: 10,
          totalOutputTokens: 20,
          apiKey: "sk-top-secret",
          rawEvent: { payload: "secret" },
        },
      ],
    });

    expect(Object.keys(projected).sort()).toEqual([
      "activeTabId",
      "tabs",
      "version",
    ]);
    expect(Object.keys(projected.tabs[0]).sort()).toEqual(
      [
        "agentId",
        "id",
        "projectPath",
        "providerKey",
        "reasoningEffort",
        "runtime",
        "runtimeModel",
        "sessionProviderKey",
        "sessionRef",
        "title",
      ].sort(),
    );
    const json = JSON.stringify(projected);
    for (const forbidden of [
      "sk-secret",
      "sk-top-secret",
      "secret draft",
      "secret guidance",
      "C:/tmp/secret.txt",
      "attachment",
      "rawEvent",
      "legacy-shadow",
      "private-attempt",
      "cancelledAttempts",
      "attemptEpoch",
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it("returns a safe default for malformed JSON and storage get failures", () => {
    const malformedStorage = { getItem: () => "{not-json" };
    const throwingStorage = {
      getItem: () => {
        throw new Error("denied");
      },
    };

    expect(() => readPersistedChat(malformedStorage)).not.toThrow();
    expect(readPersistedChat(malformedStorage).tabs[0].runtime).toBe("claude");
    expect(() => readPersistedChat(throwingStorage)).not.toThrow();
    expect(readPersistedChat(throwingStorage).tabs[0].runtime).toBe("claude");
  });

  it("swallows storage set failures", () => {
    const throwingStorage = {
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };

    expect(() =>
      writePersistedChat(
        { activeTabId: "tab-persisted", tabs: [persistedTab()] },
        throwingStorage,
      ),
    ).not.toThrow();
  });
});

describe("chat store persistence integration", () => {
  it("restores a Windows project session across path case and separator changes", () => {
    const persistedPath = "C:\\Work\\Paper";
    const currentPath = "c:/work/paper";
    localStorage.setItem(
      projectChatStorageKey(persistedPath),
      JSON.stringify(
        persistedDocument([
          persistedTab({
            projectPath: persistedPath,
            sessionRef: {
              runtime: "claude",
              sessionId: "windows-session",
              projectPath: persistedPath,
            },
          }),
        ]),
      ),
    );

    useClaudeChatStore.getState().resetForProject(currentPath);

    expect(useClaudeChatStore.getState().tabs[0]).toMatchObject({
      projectPath: currentPath,
      sessionId: "windows-session",
      sessionRef: {
        runtime: "claude",
        sessionId: "windows-session",
        projectPath: currentPath,
      },
    });
    expect(useClaudeChatStore.getState().sessionId).toBe("windows-session");
  });

  it("does not rewrite localStorage for message-only or streaming updates", () => {
    let raw = JSON.stringify(persistedDocument());
    const storage = {
      getItem: vi.fn(() => raw),
      setItem: vi.fn((_key: string, value: string) => {
        raw = value;
      }),
      clear: vi.fn(),
      removeItem: vi.fn(),
      key: vi.fn(),
      length: 1,
    };
    vi.stubGlobal("localStorage", storage);
    useClaudeChatStore.getState().resetForProject("/project-a");
    storage.setItem.mockClear();
    const tabId = useClaudeChatStore.getState().activeTabId;

    useClaudeChatStore.getState()._appendMessage(tabId, {
      type: "user",
      message: { content: [{ type: "text", text: "ephemeral" }] },
    });
    useClaudeChatStore.getState()._setStreaming(tabId, true);

    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("does not rebind an existing session when only runtime or project changes", () => {
    useClaudeChatStore.getState().resetForProject("/project-a");
    const tabId = useClaudeChatStore.getState().activeTabId;
    useClaudeChatStore.getState()._setSessionId(tabId, "session-a");
    const tab = useClaudeChatStore.getState().tabs[0];

    expect(
      normalizeTabSessionProjection(tab, { runtime: "codex" }),
    ).toMatchObject({ runtime: "codex", sessionId: null, sessionRef: null });
    expect(
      normalizeTabSessionProjection(tab, { projectPath: "/project-b" }),
    ).toMatchObject({
      projectPath: "/project-b",
      sessionId: null,
      sessionRef: null,
    });
  });

  it("never writes the persisted tabs while activeProjectPath is null", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    useClaudeChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) => ({ ...tab, title: "Still unscoped" })),
    }));

    expect(
      setItem.mock.calls.filter(([key]) => key === CHAT_TABS_STORAGE_KEY),
    ).toHaveLength(0);
  });

  it("restores matching project tabs before persistence can overwrite them", () => {
    localStorage.setItem(
      CHAT_TABS_STORAGE_KEY,
      JSON.stringify(
        persistedDocument(
          [
            persistedTab({
              id: "tab-restored",
              title: "Restored",
              projectPath: "/restored",
              sessionRef: {
                runtime: "claude",
                sessionId: "restored-session",
                projectPath: "/restored",
              },
            }),
          ],
          "tab-restored",
        ),
      ),
    );
    useClaudeChatStore.getState().resetForProject("/restored");

    const state = useClaudeChatStore.getState();
    expect(state.activeTabId).toBe("tab-restored");
    expect(state.sessionId).toBe("restored-session");
    expect(state.tabs[0]).toMatchObject({
      id: "tab-restored",
      projectPath: "/restored",
      sessionId: "restored-session",
      messages: [],
      isStreaming: false,
    });
    expect(
      JSON.parse(localStorage.getItem(CHAT_TABS_STORAGE_KEY) ?? "null").tabs[0]
        .title,
    ).toBe("Restored");
  });

  it("uses a fresh default tab when the persisted document is for another project", () => {
    localStorage.setItem(
      CHAT_TABS_STORAGE_KEY,
      JSON.stringify(persistedDocument()),
    );

    useClaudeChatStore.getState().resetForProject("/project-b");

    const state = useClaudeChatStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({
      projectPath: "/project-b",
      runtime: "claude",
      sessionId: null,
      sessionRef: null,
      title: "New Chat",
    });
  });

  it("preserves each project's tabs across an A to B to A round trip", () => {
    useClaudeChatStore.getState().resetForProject("/project-a");
    const projectATabId = useClaudeChatStore.getState().activeTabId;
    useClaudeChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === projectATabId
          ? {
              ...tab,
              title: "Project A Codex",
              runtime: "codex" as const,
              sessionId: "thread-a",
              sessionRef: {
                runtime: "codex" as const,
                sessionId: "thread-a",
                projectPath: "/project-a",
              },
              runtimeModel: "gpt-5.4",
            }
          : tab,
      ),
      sessionId: "thread-a",
    }));

    useClaudeChatStore.getState().resetForProject("/project-b");
    const projectBTabId = useClaudeChatStore.getState().activeTabId;
    useClaudeChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === projectBTabId
          ? {
              ...tab,
              title: "Project B Claude",
              sessionId: "session-b",
              sessionRef: {
                runtime: "claude" as const,
                sessionId: "session-b",
                projectPath: "/project-b",
              },
            }
          : tab,
      ),
      sessionId: "session-b",
    }));

    useClaudeChatStore.getState().resetForProject("/project-a");
    const restoredA = useClaudeChatStore.getState();
    expect(restoredA.activeTabId).toBe(projectATabId);
    expect(restoredA.tabs[0]).toMatchObject({
      id: projectATabId,
      title: "Project A Codex",
      runtime: "codex",
      sessionId: "thread-a",
      runtimeModel: "gpt-5.4",
    });

    useClaudeChatStore.getState().resetForProject("/project-b");
    const restoredB = useClaudeChatStore.getState();
    expect(restoredB.activeTabId).toBe(projectBTabId);
    expect(restoredB.tabs[0]).toMatchObject({
      id: projectBTabId,
      title: "Project B Claude",
      runtime: "claude",
      sessionId: "session-b",
    });
  });

  it("creates a unique tab id after restoring a high persisted id", () => {
    localStorage.setItem(
      CHAT_TABS_STORAGE_KEY,
      JSON.stringify(
        persistedDocument(
          [persistedTab({ id: "tab-2000000000" })],
          "tab-2000000000",
        ),
      ),
    );
    useClaudeChatStore.getState().resetForProject("/project-a");
    const restoredIds = useClaudeChatStore.getState().tabs.map((tab) => tab.id);

    const createdId = useClaudeChatStore.getState().createTab();

    expect(restoredIds).not.toContain(createdId);
    const suffix = /^tab-(\d+)$/.exec(createdId)?.[1];
    expect(suffix).toBeDefined();
    expect(BigInt(suffix!)).toBeGreaterThan(2000000000n);
  });

  it("keeps generated ids unique after restoring MAX_SAFE_INTEGER", () => {
    const restoredId = `tab-${Number.MAX_SAFE_INTEGER}`;
    localStorage.setItem(
      CHAT_TABS_STORAGE_KEY,
      JSON.stringify(
        persistedDocument([persistedTab({ id: restoredId })], restoredId),
      ),
    );
    useClaudeChatStore.getState().resetForProject("/project-a");

    const firstCreatedId = useClaudeChatStore.getState().createTab();
    const secondCreatedId = useClaudeChatStore.getState().createTab();

    expect(firstCreatedId).not.toBe(restoredId);
    expect(secondCreatedId).not.toBe(restoredId);
    expect(secondCreatedId).not.toBe(firstCreatedId);
  });

  it("keeps sessionRef authoritative and sessionId synchronized when setting and clearing", () => {
    useClaudeChatStore.getState().resetForProject("/project-a");
    const tabId = useClaudeChatStore.getState().activeTabId;

    useClaudeChatStore.getState()._setSessionId(tabId, "session-next");
    let tab = useClaudeChatStore.getState().tabs[0];
    expect(tab.sessionId).toBe("session-next");
    expect(tab.sessionRef).toEqual({
      runtime: "claude",
      sessionId: "session-next",
      projectPath: "/project-a",
    });
    expect(useClaudeChatStore.getState().sessionId).toBe("session-next");

    useClaudeChatStore.getState().newSession();
    tab = useClaudeChatStore.getState().tabs[0];
    expect(tab.sessionId).toBeNull();
    expect(tab.sessionRef).toBeNull();
    expect(useClaudeChatStore.getState().sessionId).toBeNull();
  });
});
