import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

const { mockDocumentState, getDocumentState, createSnapshotMock } = vi.hoisted(
  () => ({
    mockDocumentState: {} as any,
    getDocumentState: vi.fn(),
    createSnapshotMock: vi.fn(() => Promise.resolve(null)),
  }),
);

vi.mock("@/stores/document-store", () => ({
  useDocumentStore: {
    getState: getDocumentState,
  },
}));

vi.mock("@/stores/history-store", () => ({
  useHistoryStore: {
    getState: vi.fn(() => ({
      createSnapshot: createSnapshotMock,
    })),
  },
}));

import {
  CLAUDE_CODE_PROVIDER_ID,
  useClaudeChatStore,
} from "@/stores/claude-chat-store";

function resetClaudeChatStore() {
  useClaudeChatStore.setState({
    messages: [],
    sessionId: null,
    isStreaming: false,
    streamingStartedAt: null,
    streamingStatus: null,
    error: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    tabs: [
      {
        id: "tab-default",
        title: "New Chat",
        projectPath: "/project",
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
        streamingStatus: null,
        error: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        draft: { input: "", pinnedContexts: [] },
      },
    ],
    activeTabId: "tab-default",
    activeProjectPath: "/project",
    pendingInitialPrompt: null,
    pendingAttachments: [],
    pendingPinnedContextRemovalLabels: [],
    selectedModel: "opus",
    selectedProviderCredentialId: CLAUDE_CODE_PROVIDER_ID,
    selectedProviderModels: {},
    effortLevel: "medium",
  });
}

function setMockDocumentState(overrides: Partial<any> = {}) {
  const content = ["Line 1", "Line 2", "Line 3", "Line 4"].join("\n");

  const state = {
    projectRoot: "/project",
    files: [
      {
        id: "main.tex",
        name: "main.tex",
        relativePath: "main.tex",
        absolutePath: "/project/main.tex",
        type: "tex",
        content,
        isDirty: false,
      },
    ],
    activeFileId: "main.tex",
    selectionRange: null,
    saveAllFiles: vi.fn(() => Promise.resolve()),
    refreshFiles: vi.fn(() => Promise.resolve()),
    reloadFile: vi.fn(() => Promise.resolve()),
    ...overrides,
  };

  Object.keys(mockDocumentState).forEach(
    (key) => delete mockDocumentState[key],
  );
  Object.assign(mockDocumentState, state);
  getDocumentState.mockImplementation(() => mockDocumentState);
  return mockDocumentState;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function claudeHistory(sessionId: string, items: unknown[]) {
  return {
    reference: {
      runtime: "claude" as const,
      sessionId,
      projectPath: "/project",
    },
    items,
  };
}

describe("useClaudeChatStore.sendPrompt context assembly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetClaudeChatStore();
    setMockDocumentState();
  });

  it("uses a plain file label and full file content for whole-file mentions", async () => {
    const wholeFileText =
      "\\section{Intro}\nThis is the full file.\n\\textbf{Important note}";

    await useClaudeChatStore.getState().sendPrompt("Please revise this", {
      label: "@main.tex",
      filePath: "main.tex",
      selectedText: wholeFileText,
    });

    expect(invoke).toHaveBeenCalledWith("runtime_start_turn", {
      request: expect.objectContaining({
        runtime: "claude",
        projectPath: "/project",
        tabId: "tab-default",
        prompt: expect.stringContaining("[Selection: @main.tex]"),
      }),
    });

    const prompt = (vi.mocked(invoke).mock.calls[0]?.[1] as any)?.request
      ?.prompt as string;
    expect(prompt).toContain("[Currently open file: main.tex]");
    expect(prompt).toContain("[Selection: @main.tex]");
    expect(prompt).toContain(wholeFileText);

    const userText =
      useClaudeChatStore.getState().messages[0].message?.content?.[0].text;
    expect(userText).toBe("@main.tex\nPlease revise this");
  });

  it("uses a line-range label and only the selected slice for selection context", async () => {
    const state = setMockDocumentState({
      files: [
        {
          id: "main.tex",
          name: "main.tex",
          relativePath: "main.tex",
          absolutePath: "/project/main.tex",
          type: "tex",
          content: "alpha\nbeta\ngamma\ndelta",
          isDirty: false,
        },
      ],
      selectionRange: { start: 6, end: 16 },
    });

    await useClaudeChatStore.getState().sendPrompt("Please revise this");

    expect(invoke).toHaveBeenCalledWith("runtime_start_turn", {
      request: expect.objectContaining({
        runtime: "claude",
        projectPath: "/project",
        tabId: "tab-default",
        prompt: expect.stringContaining("[Selection: @main.tex:2:1-3:6]"),
      }),
    });

    const prompt = (vi.mocked(invoke).mock.calls[0]?.[1] as any)?.request
      ?.prompt as string;
    expect(prompt).toContain("[Currently open file: main.tex]");
    expect(prompt).toContain("[Selection: @main.tex:2:1-3:6]");
    expect(prompt).toContain("[Selected text:\nbeta\ngamma\n]");
    expect(prompt).not.toContain("alpha\na");
    expect(prompt).not.toContain("\ndelta");

    const userText =
      useClaudeChatStore.getState().messages[0].message?.content?.[0].text;
    expect(userText).toBe("@main.tex:2:1-3:6\nPlease revise this");
    expect(state.saveAllFiles).not.toHaveBeenCalled();
    expect(createSnapshotMock).toHaveBeenCalledWith(
      "/project",
      "[claude] Before Claude edit",
    );
  });

  it("sends Claude Code when the Claude provider option is selected", async () => {
    useClaudeChatStore.setState({
      selectedProviderCredentialId: CLAUDE_CODE_PROVIDER_ID,
    });

    await useClaudeChatStore.getState().sendPrompt("Use Claude");

    expect(invoke).toHaveBeenCalledWith("runtime_start_turn", {
      request: expect.objectContaining({
        runtime: "claude",
        providerCredentialId: null,
        providerModelOverride: null,
      }),
    });
  });

  it("starts Claude Code with prior context when switching from a direct provider", async () => {
    useClaudeChatStore.setState((state) => ({
      sessionId: "qwen-session",
      selectedProviderCredentialId: CLAUDE_CODE_PROVIDER_ID,
      tabs: state.tabs.map((tab) =>
        tab.id === "tab-default"
          ? {
              ...tab,
              sessionId: "qwen-session",
              sessionRef: {
                runtime: "claude" as const,
                sessionId: "qwen-session",
                projectPath: "/project",
              },
              providerKey: CLAUDE_CODE_PROVIDER_ID,
              sessionProviderKey: "openai-compatible:qwen-cred",
              messages: [
                {
                  type: "user",
                  message: {
                    content: [{ type: "text", text: "Old DS question" }],
                  },
                },
                {
                  type: "assistant",
                  message: {
                    content: [{ type: "text", text: "Old DS answer" }],
                  },
                },
              ],
            }
          : tab,
      ),
    }));

    await useClaudeChatStore.getState().sendPrompt("Use Claude now");

    expect(invoke).toHaveBeenCalledWith("runtime_start_turn", {
      request: expect.objectContaining({
        runtime: "claude",
        sessionId: null,
        providerCredentialId: null,
        providerModelOverride: null,
        prompt: expect.stringContaining("[Provider switch context]"),
      }),
    });
    const prompt = (vi.mocked(invoke).mock.calls[0]?.[1] as any).request.prompt;
    expect(prompt).toContain("Old DS question");
    expect(prompt).toContain("Old DS answer");
    expect(prompt).toContain("Use Claude now");
  });

  it("keeps the same backend session when switching between OpenAI-compatible providers", async () => {
    useClaudeChatStore.setState((state) => ({
      sessionId: "shared-session",
      selectedProviderCredentialId: "deepseek-cred",
      selectedProviderModels: { "deepseek-cred": "deepseek-chat" },
      tabs: state.tabs.map((tab) =>
        tab.id === "tab-default"
          ? {
              ...tab,
              sessionId: "shared-session",
              sessionRef: {
                runtime: "claude" as const,
                sessionId: "shared-session",
                projectPath: "/project",
              },
              providerKey: "openai-compatible:deepseek-cred",
              sessionProviderKey: "openai-compatible:qwen-cred",
            }
          : tab,
      ),
    }));

    await useClaudeChatStore.getState().sendPrompt("Use DeepSeek now");

    expect(invoke).toHaveBeenCalledWith("runtime_start_turn", {
      request: expect.objectContaining({
        runtime: "claude",
        sessionId: "shared-session",
        providerCredentialId: "deepseek-cred",
        providerModelOverride: "deepseek-chat",
      }),
    });
  });

  it("passes an OpenAI-compatible model override with the provider credential", async () => {
    useClaudeChatStore.getState().setSelectedProviderCredentialId("qwen-cred");
    useClaudeChatStore.setState({
      selectedProviderModels: { "qwen-cred": "qwen3.7-plus" },
    });

    await useClaudeChatStore.getState().sendPrompt("Use Qwen");

    expect(invoke).toHaveBeenCalledWith("runtime_start_turn", {
      request: expect.objectContaining({
        runtime: "claude",
        providerCredentialId: "qwen-cred",
        providerModelOverride: "qwen3.7-plus",
      }),
    });
  });

  it("does not start a runtime when files change while preflight is saving", async () => {
    const save = deferred<void>();
    const documentState = setMockDocumentState({
      projectGeneration: 1,
      contentGeneration: 1,
      files: [
        {
          id: "main.tex",
          name: "main.tex",
          relativePath: "main.tex",
          absolutePath: "/project/main.tex",
          type: "tex",
          content: "version A",
          isDirty: true,
        },
      ],
      saveAllFiles: vi.fn(() => save.promise),
    });

    const sending = useClaudeChatStore.getState().sendPrompt("Review it");
    await vi.waitFor(() =>
      expect(documentState.saveAllFiles).toHaveBeenCalledTimes(1),
    );
    documentState.files = [
      {
        ...documentState.files[0],
        content: "version B",
        isDirty: true,
      },
    ];
    documentState.contentGeneration += 1;
    save.resolve();
    await sending;

    expect(invoke).not.toHaveBeenCalledWith(
      "runtime_start_turn",
      expect.anything(),
    );
    expect(useClaudeChatStore.getState().isStreaming).toBe(false);
    expect(useClaudeChatStore.getState().error).toMatch(/changed|save/i);
  });

  it("does not start a runtime when files change while preflight is snapshotting", async () => {
    const snapshot = deferred<null>();
    createSnapshotMock.mockReturnValueOnce(snapshot.promise);
    const documentState = setMockDocumentState({
      projectGeneration: 1,
      contentGeneration: 1,
    });

    const sending = useClaudeChatStore.getState().sendPrompt("Review it");
    await vi.waitFor(() => expect(createSnapshotMock).toHaveBeenCalledTimes(1));
    documentState.files = [
      {
        ...documentState.files[0],
        content: "changed while snapshotting",
        isDirty: true,
      },
    ];
    documentState.contentGeneration += 1;
    snapshot.resolve(null);
    await sending;

    expect(invoke).not.toHaveBeenCalledWith(
      "runtime_start_turn",
      expect.anything(),
    );
    expect(useClaudeChatStore.getState().isStreaming).toBe(false);
    expect(useClaudeChatStore.getState().error).toMatch(/changed|save/i);
  });
});

describe("useClaudeChatStore.resumeSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetClaudeChatStore();
    setMockDocumentState();
  });

  it("restores token totals from loaded session history", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(
      claudeHistory("session-123", [
        {
          type: "user",
          message: { content: [{ type: "text", text: "hello" }] },
        },
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "hi" }],
            usage: { input_tokens: 11, output_tokens: 7 },
          },
        },
        {
          type: "result",
          subtype: "success",
          usage: { input_tokens: 13, output_tokens: 5 },
        },
      ]),
    );

    await useClaudeChatStore.getState().resumeSession("session-123");

    expect(invoke).toHaveBeenCalledWith("runtime_read_conversation", {
      reference: {
        runtime: "claude",
        projectPath: "/project",
        sessionId: "session-123",
      },
    });

    const state = useClaudeChatStore.getState();
    expect(state.sessionId).toBe("session-123");
    expect(state.messages).toHaveLength(3);
    expect(state.totalInputTokens).toBe(24);
    expect(state.totalOutputTokens).toBe(12);
  });

  it("does not reuse a tab from another project with the same session id", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(
      claudeHistory("shared-session-id", [
        {
          type: "user",
          message: {
            content: [{ type: "text", text: "from current project" }],
          },
        },
      ]),
    );

    useClaudeChatStore.setState((state) => {
      const baseTab = state.tabs[0];
      return {
        tabs: [
          {
            ...baseTab,
            id: "tab-current",
            projectPath: "/project",
            sessionId: null,
            messages: [],
          },
          {
            ...baseTab,
            id: "tab-other",
            title: "Other project",
            projectPath: "/other-project",
            sessionId: "shared-session-id",
            messages: [
              {
                type: "user",
                message: {
                  content: [{ type: "text", text: "from another project" }],
                },
              },
            ],
          },
        ],
        activeTabId: "tab-current",
        activeProjectPath: "/project",
        messages: [],
        sessionId: null,
      };
    });

    await useClaudeChatStore.getState().resumeSession("shared-session-id");

    expect(invoke).toHaveBeenCalledWith("runtime_read_conversation", {
      reference: {
        runtime: "claude",
        projectPath: "/project",
        sessionId: "shared-session-id",
      },
    });

    const state = useClaudeChatStore.getState();
    const otherProjectTab = state.tabs.find((tab) => tab.id === "tab-other");
    expect(state.activeTabId).toBe("tab-current");
    expect(state.activeProjectPath).toBe("/project");
    expect(state.messages[0].message?.content?.[0].text).toBe(
      "from current project",
    );
    expect(otherProjectTab?.messages[0].message?.content?.[0].text).toBe(
      "from another project",
    );
  });

  it("hides internal file and pasted-image context when restoring history", async () => {
    const tempImagePath = [
      "C:\\Temp",
      "LocalPrism",
      "chat-pastes",
      "1781110224092-1-paste-1781110223586-1.png",
    ].join("\\");
    const restoredPrompt = [
      "[Currently open file: main.tex]",
      "[Selection: Pasted image]",
      "[Selected text:",
      `[Temporary pasted image: ${tempImagePath}]`,
      "Use this image file as visual context for the user's message.",
      "]",
      "",
      "Please inspect this image",
    ].join("\n");

    vi.mocked(invoke).mockResolvedValueOnce(
      claudeHistory("session-with-image", [
        {
          type: "user",
          message: {
            content: restoredPrompt,
          },
        },
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "OK" }],
          },
        },
      ]),
    );

    await useClaudeChatStore.getState().resumeSession("session-with-image");

    const state = useClaudeChatStore.getState();
    const userContent = state.messages[0].message?.content as any;
    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);

    expect(userContent).toBe("Pasted image\nPlease inspect this image");
    expect(userContent).not.toContain("[Currently open file:");
    expect(userContent).not.toContain("[Temporary pasted image:");
    expect(activeTab?.title).toBe("Please inspect this image");
  });

  it("does not repurpose a Codex tab while its stop is awaiting terminal completion", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(
      claudeHistory("claude-session", [
        {
          type: "user",
          message: { content: [{ type: "text", text: "restored" }] },
        },
      ]),
    );
    useClaudeChatStore.setState((state) => {
      const tab = state.tabs[0];
      return {
        tabs: [
          {
            ...tab,
            runtime: "codex",
            sessionId: "codex-session",
            activeAttemptId: "codex-attempt",
            cancelledAttempts: [
              {
                attemptId: "codex-attempt",
                attemptEpoch: 1,
                runtime: "codex",
                mode: "terminate",
              },
            ],
          },
        ],
        sessionId: "codex-session",
      };
    });

    await useClaudeChatStore.getState().resumeSession("claude-session");

    const state = useClaudeChatStore.getState();
    const stoppingTab = state.tabs.find((tab) => tab.id === "tab-default");
    const resumedTab = state.tabs.find(
      (tab) => tab.sessionId === "claude-session",
    );
    expect(stoppingTab).toMatchObject({
      runtime: "codex",
      sessionId: "codex-session",
      activeAttemptId: "codex-attempt",
    });
    expect(stoppingTab?.cancelledAttempts).toHaveLength(1);
    expect(resumedTab?.id).not.toBe("tab-default");
    expect(resumedTab?.runtime).toBe("claude");
    expect(state.activeTabId).toBe(resumedTab?.id);
  });

  it("ignores an older history response after a newer session resume wins", async () => {
    const firstHistory = deferred<ReturnType<typeof claudeHistory>>();
    const secondHistory = deferred<ReturnType<typeof claudeHistory>>();
    vi.mocked(invoke).mockImplementation((command, args: any) => {
      if (command !== "runtime_read_conversation") {
        return Promise.resolve() as any;
      }
      return (
        args.reference.sessionId === "session-a"
          ? firstHistory.promise
          : secondHistory.promise
      ) as any;
    });

    const firstResume = useClaudeChatStore
      .getState()
      .resumeSession("session-a", "Session A");
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("runtime_read_conversation", {
        reference: {
          runtime: "claude",
          projectPath: "/project",
          sessionId: "session-a",
        },
      }),
    );
    const secondResume = useClaudeChatStore
      .getState()
      .resumeSession("session-b", "Session B");

    secondHistory.resolve(
      claudeHistory("session-b", [
        {
          type: "user",
          message: { content: [{ type: "text", text: "newer history" }] },
        },
      ]),
    );
    await secondResume;
    firstHistory.resolve(
      claudeHistory("session-a", [
        {
          type: "user",
          message: { content: [{ type: "text", text: "stale history" }] },
        },
      ]),
    );
    await firstResume;

    const state = useClaudeChatStore.getState();
    expect(state.sessionId).toBe("session-b");
    expect(state.messages[0]?.message?.content?.[0]?.text).toBe(
      "newer history",
    );
    expect(state.tabs.find((tab) => tab.id === state.activeTabId)?.title).toBe(
      "Session B",
    );
  });

  it("ignores history loaded for a project that is no longer active", async () => {
    const history = deferred<ReturnType<typeof claudeHistory>>();
    vi.mocked(invoke).mockReturnValue(history.promise as any);

    const resume = useClaudeChatStore
      .getState()
      .resumeSession("old-project-session");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    setMockDocumentState({ projectRoot: "/other-project" });
    useClaudeChatStore.getState().resetForProject("/other-project");

    history.resolve(
      claudeHistory("old-project-session", [
        {
          type: "user",
          message: { content: [{ type: "text", text: "stale project" }] },
        },
      ]),
    );
    await resume;

    const state = useClaudeChatStore.getState();
    expect(state.activeProjectPath).toBe("/other-project");
    expect(state.messages).toEqual([]);
  });
});
