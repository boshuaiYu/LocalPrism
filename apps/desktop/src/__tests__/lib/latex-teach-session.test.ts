import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { displayConversationTitle } from "@/components/claude-chat/session-selector";
import { buildTeachAskPrompt } from "@/lib/latex-teach-ask";
import {
  planLatexTeachAsk,
  type LatexLearnTabLike,
} from "@/lib/latex-learn-tab";
import {
  resetLatexTeachAskQueue,
  sendLatexTeachAsk,
} from "@/lib/latex-teach-session";
import { translate } from "@/lib/i18n";
import { writePersistedChatForProject } from "@/stores/chat-persistence";
import type { ConversationRef, RuntimeTurnRequest } from "@/runtime/types";
import { useChatLayoutStore } from "@/stores/chat-layout-store";
import {
  useClaudeChatStore,
  type ClaudeStreamMessage,
  type TabState,
} from "@/stores/claude-chat-store";
import { useProviderStore } from "@/stores/provider-store";
import { useSettingsStore } from "@/stores/settings-store";

const { mockDocumentState, getDocumentState, createSnapshotMock } = vi.hoisted(
  () => ({
    mockDocumentState: {} as {
      projectRoot: string;
      projectGeneration: number;
      contentGeneration: number;
      isProjectMutating: boolean;
      activeFileId: string;
      selectionRange: { start: number; end: number } | null;
      files: Array<{
        id: string;
        name: string;
        relativePath: string;
        absolutePath: string;
        type: string;
        content: string;
        isDirty: boolean;
      }>;
      saveAllFiles: () => Promise<void>;
    },
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

const PROJECT_A = "/proj-a";
const PROJECT_B = "/proj-b";
const SECRET_SELECTION = "SECRET_SELECTION";

function setDocument(projectRoot = PROJECT_A) {
  mockDocumentState.projectRoot = projectRoot;
  mockDocumentState.projectGeneration = 1;
  mockDocumentState.contentGeneration = 1;
  mockDocumentState.isProjectMutating = false;
  mockDocumentState.activeFileId = "main.tex";
  mockDocumentState.selectionRange = { start: 0, end: SECRET_SELECTION.length };
  mockDocumentState.files = [
    {
      id: "main.tex",
      name: "main.tex",
      relativePath: "main.tex",
      absolutePath: `${projectRoot}/main.tex`,
      type: "tex",
      content: `${SECRET_SELECTION}\nmore text`,
      isDirty: false,
    },
  ];
  mockDocumentState.saveAllFiles = vi.fn(() => Promise.resolve());
  getDocumentState.mockImplementation(() => mockDocumentState);
}

function resetChat(projectPath = PROJECT_A) {
  const base = useClaudeChatStore.getState().tabs[0];
  const main: TabState = {
    ...base,
    id: "tab-main",
    title: "Writing",
    purpose: null,
    projectPath,
    runtime: "claude",
    chatPeer: "claude",
    sessionRef: null,
    sessionId: null,
    runtimeModel: "claude-sonnet",
    reasoningEffort: "high",
    agentId: "peer-review",
    providerKey: base.providerKey,
    sessionProviderKey: null,
    messages: [
      {
        type: "user",
        message: { content: [{ type: "text", text: "writing chat" }] },
      },
    ],
    isStreaming: true,
    streamingStartedAt: 10,
    streamingStatus: null,
    error: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    lastTurnUsage: null,
    draft: {
      input: "draft in progress",
      pinnedContexts: [
        {
          label: "@main.tex:1:1-1:8",
          filePath: "main.tex",
          selectedText: "keep-chip",
        },
      ],
    },
    queuedGuidance: [],
    cancelledAttempts: [],
    activeAttemptId: "main-attempt",
    attemptEpoch: 1,
  };
  useClaudeChatStore.setState({
    tabs: [main],
    activeTabId: main.id,
    activeProjectPath: projectPath,
    messages: main.messages,
    sessionId: null,
    isStreaming: true,
    streamingStartedAt: 10,
    error: null,
    pendingPinnedContextRemovalLabels: ["keep-label"],
    selectedModel: "opus",
    effortLevel: "medium",
  });
}

function learnTabs(): TabState[] {
  return useClaudeChatStore
    .getState()
    .tabs.filter((tab) => tab.purpose === "latex-learn");
}

function messageText(message: ClaudeStreamMessage | undefined): string {
  const content = message?.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

function userTexts(tab: TabState | undefined): string[] {
  return (tab?.messages ?? [])
    .filter((message) => message.type === "user")
    .map((message) => messageText(message));
}

function startRequests(): RuntimeTurnRequest[] {
  return vi.mocked(invoke).mock.calls.flatMap((call) => {
    if (call[0] !== "runtime_start_turn") return [];
    const request = (call[1] as { request?: RuntimeTurnRequest } | undefined)
      ?.request;
    return request ? [request] : [];
  });
}

function lastStart(): RuntimeTurnRequest | undefined {
  const requests = startRequests();
  return requests[requests.length - 1];
}

function stopTab(tabId: string) {
  useClaudeChatStore.setState((state) => {
    const tabs = state.tabs.map((tab) =>
      tab.id === tabId
        ? {
            ...tab,
            isStreaming: false,
            streamingStartedAt: null,
            activeAttemptId: null,
            cancelledAttempts: [],
          }
        : tab,
    );
    const active = tabs.find((tab) => tab.id === state.activeTabId);
    return {
      tabs,
      isStreaming: active?.isStreaming ?? false,
      streamingStartedAt: active?.streamingStartedAt ?? null,
    };
  });
}

function finishTurn(tabId: string, sessionId: string) {
  const chat = useClaudeChatStore.getState();
  chat._setSessionId(tabId, sessionId);
  chat._setStreaming(tabId, false);
  const attemptId = useClaudeChatStore
    .getState()
    .tabs.find((tab) => tab.id === tabId)?.activeAttemptId;
  if (attemptId) {
    useClaudeChatStore.getState()._clearActiveAttempt(tabId, attemptId);
  }
}

function mainTab(): TabState | undefined {
  return useClaudeChatStore
    .getState()
    .tabs.find((tab) => tab.id === "tab-main");
}

const constructPrompt = buildTeachAskPrompt({
  lesson: {
    kind: "construct",
    tag: "figure",
    title: "浮动图片环境",
    what: "放图片",
  },
  language: "zh",
  selectedText: "\\begin{figure}",
});

const errorPrompt = buildTeachAskPrompt({
  lesson: {
    kind: "error",
    tag: "! File",
    title: "找不到文件",
    what: "编译器没有找到图片",
  },
  language: "zh",
  detail: "miss.png",
  diagnosticMessage: "File `miss.png' not found",
});

const guidePrompt = buildTeachAskPrompt({
  lesson: {
    kind: "guide",
    tag: "guide",
    title: "一份最小的文稿",
    what: "从文档类开始",
  },
  language: "zh",
  selectedText: SECRET_SELECTION,
  diagnosticMessage: "File `miss.png' not found",
});

beforeEach(() => {
  resetLatexTeachAskQueue();
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
  useProviderStore.setState({
    ready: true,
    engineInstalled: true,
    activeAuthenticated: true,
    models: [],
  });
  useSettingsStore.setState({ uiLanguage: "zh", latexTeaching: false });
  useChatLayoutStore.setState({ visible: false, suppressAutoOpen: true });
  setDocument(PROJECT_A);
  resetChat(PROJECT_A);
});

describe("planLatexTeachAsk", () => {
  const learn = (
    id: string,
    projectPath: string,
    overrides: Partial<LatexLearnTabLike> = {},
  ): LatexLearnTabLike => ({
    id,
    projectPath,
    purpose: "latex-learn",
    runtime: "claude",
    sessionId: null,
    messages: [],
    ...overrides,
  });

  it("creates once, then reuses the same project tab", () => {
    expect(planLatexTeachAsk([], PROJECT_A)).toEqual({ kind: "create" });
    expect(planLatexTeachAsk([], null)).toEqual({ kind: "missing-project" });

    const tabs = [
      learn("tab-a", `${PROJECT_A}/`, {
        sessionId: "sess-a",
        messages: [{ type: "user" }],
      }),
      learn("tab-b", PROJECT_B, { sessionId: "sess-b" }),
    ];
    expect(planLatexTeachAsk(tabs, PROJECT_A)).toEqual({
      kind: "reuse",
      tabId: "tab-a",
      loadHistory: false,
    });
    expect(planLatexTeachAsk(tabs, PROJECT_B)).toEqual({
      kind: "reuse",
      tabId: "tab-b",
      loadHistory: true,
    });
    expect(planLatexTeachAsk([learn("tab-a", PROJECT_A)], "/other")).toEqual({
      kind: "create",
    });
  });

  it("reloads an empty saved session and ignores a Codex marker", () => {
    expect(
      planLatexTeachAsk(
        [
          learn("tab-shell", PROJECT_A, {
            sessionId: "sess-a",
            messages: [],
            isStreaming: false,
          }),
        ],
        PROJECT_A,
      ),
    ).toEqual({ kind: "reuse", tabId: "tab-shell", loadHistory: true });

    expect(
      planLatexTeachAsk(
        [
          learn("tab-ref", PROJECT_A, {
            sessionId: null,
            sessionRef: { sessionId: "from-ref" },
            messages: [],
          }),
        ],
        PROJECT_A,
      ),
    ).toEqual({ kind: "reuse", tabId: "tab-ref", loadHistory: true });

    expect(
      planLatexTeachAsk(
        [
          learn("tab-busy", PROJECT_A, {
            sessionId: "sess-a",
            messages: [],
            resumeRequestId: "resume-1",
          }),
        ],
        PROJECT_A,
      ),
    ).toEqual({ kind: "reuse", tabId: "tab-busy", loadHistory: false });

    expect(
      planLatexTeachAsk(
        [
          learn("tab-codex", PROJECT_A, {
            runtime: "codex",
            sessionId: "sess-codex",
          }),
        ],
        PROJECT_A,
      ),
    ).toEqual({ kind: "create" });
  });
});

describe("sendLatexTeachAsk", () => {
  it("sends construct, error, and guide prompts into one learning session", async () => {
    const mainBefore = mainTab();
    expect(mainBefore?.isStreaming).toBe(true);

    await sendLatexTeachAsk(constructPrompt);

    const created = learnTabs();
    expect(created).toHaveLength(1);
    const learnId = created[0]?.id;
    expect(learnId).toBeTruthy();
    expect(learnId).not.toBe("tab-main");
    expect(useClaudeChatStore.getState().activeTabId).toBe(learnId);
    expect(created[0]?.title).toBe("边写边学");
    expect(created[0]?.agentId).toBe("peer-review");
    expect(created[0]?.runtimeModel).toBe("claude-sonnet");
    expect(created[0]?.projectPath).toBe(PROJECT_A);
    expect(userTexts(created[0])).toEqual([constructPrompt]);
    expect(useChatLayoutStore.getState().visible).toBe(true);

    const writing = mainTab();
    expect(userTexts(writing)).toEqual(["writing chat"]);
    expect(writing?.draft).toEqual(mainBefore?.draft);
    expect(writing?.isStreaming).toBe(true);
    expect(writing?.agentId).toBe("peer-review");
    expect(
      useClaudeChatStore.getState().pendingPinnedContextRemovalLabels,
    ).toEqual(["keep-label"]);

    const first = startRequests()[0];
    expect(first?.tabId).toBe(learnId);
    expect(first?.sessionId).toBeNull();
    expect(first?.agentId).toBe("peer-review");
    expect(first?.prompt).toContain("请讲解这个 LaTeX 结构");
    expect(first?.prompt).toContain("回复格式：");
    expect(first?.prompt).toContain("latex 代码块");
    expect(userTexts(created[0])[0]).not.toContain("回复格式：");
    expect(first?.prompt).toContain("\\begin{figure}");
    expect(first?.prompt).toContain("[Reply mode: peer-review.");
    expect(first?.prompt).not.toContain(SECRET_SELECTION);
    expect(first?.prompt).not.toContain("[Currently open file:");
    expect(first?.prompt).not.toContain("[Selection:");

    useClaudeChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === "tab-main" ? { ...tab, agentId: "my-tutor" } : tab,
      ),
    }));
    finishTurn(learnId ?? "", "learn-a");
    await sendLatexTeachAsk(errorPrompt);

    const afterError = learnTabs();
    expect(afterError).toHaveLength(1);
    expect(afterError[0]?.id).toBe(learnId);
    expect(userTexts(afterError[0])).toEqual([constructPrompt, errorPrompt]);
    expect(afterError[0]?.agentId).toBe("peer-review");
    expect(mainTab()?.agentId).toBe("my-tutor");
    expect(userTexts(mainTab())).toEqual(["writing chat"]);
    expect(mainTab()?.draft.input).toBe("draft in progress");

    const second = startRequests()[1];
    expect(second?.tabId).toBe(learnId);
    expect(second?.sessionId).toBe("learn-a");
    expect(second?.agentId).toBe("peer-review");
    expect(second?.prompt).toContain("请讲解这个 LaTeX 报错");
    expect(second?.prompt).toContain("miss.png");
    expect(second?.prompt).not.toContain("[Currently open file:");

    useClaudeChatStore
      .getState()
      ._setSessionTitle("learn-a", "Generated title");
    expect(learnTabs()[0]?.title).toBe("边写边学");

    finishTurn(learnId ?? "", "learn-a");
    await sendLatexTeachAsk(guidePrompt);
    const afterGuide = learnTabs();
    expect(afterGuide).toHaveLength(1);
    expect(userTexts(afterGuide[0])).toEqual([
      constructPrompt,
      errorPrompt,
      guidePrompt,
    ]);
    expect(guidePrompt).not.toContain(SECRET_SELECTION);
    expect(startRequests()[2]?.prompt).toContain("请讲解这份 LaTeX 入门引导");
    expect(startRequests()[2]?.prompt).not.toContain(SECRET_SELECTION);
    expect(userTexts(mainTab())).toEqual(["writing chat"]);
    expect(mainTab()?.draft.pinnedContexts[0]?.selectedText).toBe("keep-chip");
  });

  it("queues a second question while the learning turn is still streaming", async () => {
    await sendLatexTeachAsk(constructPrompt);
    await sendLatexTeachAsk(errorPrompt);

    const learn = learnTabs()[0];
    expect(learnTabs()).toHaveLength(1);
    expect(userTexts(learn)).toEqual([constructPrompt]);
    expect(learn?.queuedGuidance).toEqual([
      expect.objectContaining({
        prompt: errorPrompt,
        skipAmbientContext: true,
      }),
    ]);
    expect(startRequests()).toHaveLength(1);
    expect(userTexts(mainTab())).toEqual(["writing chat"]);
  });

  it("uses an English title and recreates the session after it is closed", async () => {
    useSettingsStore.setState({ uiLanguage: "en" });
    await sendLatexTeachAsk("Explain this construct.");
    const first = learnTabs()[0];
    expect(first?.title).toBe("Learn LaTeX");
    expect(lastStart()?.prompt).toContain("Reply format:");
    expect(userTexts(first)).toEqual(["Explain this construct."]);
    finishTurn(first?.id ?? "", "learn-en");

    useClaudeChatStore.getState().closeTab(first?.id ?? "");
    expect(learnTabs()).toHaveLength(0);

    await sendLatexTeachAsk("Explain this error.");
    const recreated = learnTabs();
    expect(recreated).toHaveLength(1);
    expect(recreated[0]?.id).not.toBe(first?.id);
    expect(recreated[0]?.title).toBe("Learn LaTeX");
    expect(userTexts(recreated[0])).toEqual(["Explain this error."]);
    expect(lastStart()?.sessionId).toBeNull();
  });

  it("keeps the learning transcript when the user starts a new chat", async () => {
    await sendLatexTeachAsk(constructPrompt);
    const learnId = learnTabs()[0]?.id ?? "";
    finishTurn(learnId, "learn-a");
    useClaudeChatStore.getState().setActiveTab(learnId);
    useClaudeChatStore.getState().newSession();

    const learn = useClaudeChatStore
      .getState()
      .tabs.find((tab) => tab.id === learnId);
    const activeId = useClaudeChatStore.getState().activeTabId;
    expect(learn?.purpose).toBe("latex-learn");
    expect(userTexts(learn)).toEqual([constructPrompt]);
    expect(activeId).not.toBe(learnId);
    expect(
      useClaudeChatStore.getState().tabs.find((tab) => tab.id === activeId)
        ?.purpose,
    ).not.toBe("latex-learn");
  });

  it("reloads a saved learning session before appending the next question", async () => {
    await sendLatexTeachAsk(constructPrompt);
    const learnId = learnTabs()[0]?.id ?? "";
    finishTurn(learnId, "learn-a");
    useClaudeChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === learnId
          ? { ...tab, messages: [], isStreaming: false, activeAttemptId: null }
          : tab,
      ),
      messages: [],
      isStreaming: false,
    }));
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command !== "runtime_read_conversation") return undefined;
      const reference = (args as { reference: ConversationRef }).reference;
      return {
        reference,
        items: [
          {
            type: "user",
            message: { content: [{ type: "text", text: constructPrompt }] },
          },
          {
            type: "assistant",
            message: { content: [{ type: "text", text: "上一课的回答" }] },
          },
        ],
      };
    });

    await sendLatexTeachAsk(errorPrompt);

    const learn = learnTabs()[0];
    expect(learn?.id).toBe(learnId);
    expect(learn?.title).toBe("边写边学");
    expect(userTexts(learn)).toEqual([constructPrompt, errorPrompt]);
    expect(invoke).toHaveBeenCalledWith("runtime_read_conversation", {
      reference: {
        runtime: "claude",
        projectPath: PROJECT_A,
        sessionId: "learn-a",
      },
    });
    expect(lastStart()?.sessionId).toBe("learn-a");
    expect(userTexts(mainTab())).toEqual(["writing chat"]);
    expect(mainTab()?.draft.input).toBe("draft in progress");
  });

  it("keeps a separate learning session for each project", async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command !== "runtime_read_conversation") return undefined;
      const reference = (args as { reference: ConversationRef }).reference;
      return {
        reference,
        items: [
          {
            type: "user",
            message: { content: [{ type: "text", text: "project A lesson" }] },
          },
        ],
      };
    });

    await sendLatexTeachAsk("project A lesson");
    const learnA = learnTabs()[0];
    finishTurn(learnA?.id ?? "", "learn-a");
    stopTab("tab-main");

    setDocument(PROJECT_B);
    await sendLatexTeachAsk("project B lesson");
    const learnB = learnTabs()[0];
    expect(learnB?.id).not.toBe(learnA?.id);
    expect(learnB?.projectPath).toBe(PROJECT_B);
    expect(userTexts(learnB)).toEqual(["project B lesson"]);
    expect(learnB?.title).toBe("边写边学");
    finishTurn(learnB?.id ?? "", "learn-b");

    setDocument(PROJECT_A);
    await sendLatexTeachAsk("project A follow-up");

    const restored = learnTabs();
    expect(restored).toHaveLength(1);
    expect(restored[0]?.id).toBe(learnA?.id);
    expect(restored[0]?.projectPath).toBe(PROJECT_A);
    expect(restored[0]?.purpose).toBe("latex-learn");
    expect(userTexts(restored[0])).toEqual([
      "project A lesson",
      "project A follow-up",
    ]);
    expect(lastStart()).toEqual(
      expect.objectContaining({
        sessionId: "learn-a",
        tabId: learnA?.id,
        projectPath: PROJECT_A,
      }),
    );
    expect(
      useClaudeChatStore
        .getState()
        .tabs.some((tab) => tab.projectPath === PROJECT_B),
    ).toBe(false);
  });

  it("does not copy a Codex agent onto the new learning session", async () => {
    useClaudeChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === "tab-main"
          ? {
              ...tab,
              runtime: "codex",
              agentId: "codex-agent",
              isStreaming: false,
            }
          : tab,
      ),
      isStreaming: false,
    }));

    await sendLatexTeachAsk(constructPrompt);

    const learn = learnTabs()[0];
    expect(learn?.runtime).toBe("claude");
    expect(learn?.agentId).toBeNull();
    expect(startRequests()[0]?.agentId).toBeNull();
    expect(startRequests()[0]?.prompt).not.toContain("[Reply mode:");
    expect(mainTab()?.agentId).toBe("codex-agent");
    expect(mainTab()?.runtime).toBe("codex");
  });

  it("drops the learning marker when that tab becomes Codex", async () => {
    await sendLatexTeachAsk(constructPrompt);
    const learnId = learnTabs()[0]?.id ?? "";
    finishTurn(learnId, "learn-a");

    const changed = useClaudeChatStore
      .getState()
      .changeTabRuntime(learnId, "codex", { confirmSessionReset: true });
    expect(changed).toBe("changed");
    expect(
      useClaudeChatStore.getState().tabs.find((tab) => tab.id === learnId)
        ?.purpose,
    ).toBeNull();

    await sendLatexTeachAsk(errorPrompt);
    const learn = learnTabs();
    expect(learn).toHaveLength(1);
    expect(learn[0]?.id).not.toBe(learnId);
    expect(learn[0]?.runtime).toBe("claude");
    expect(userTexts(learn[0])).toEqual([errorPrompt]);
  });

  it("reloads history from sessionRef when the legacy session id is empty", async () => {
    await sendLatexTeachAsk(constructPrompt);
    const learnId = learnTabs()[0]?.id ?? "";
    finishTurn(learnId, "learn-a");
    useClaudeChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === learnId
          ? {
              ...tab,
              messages: [],
              sessionId: null,
              isStreaming: false,
              activeAttemptId: null,
            }
          : tab,
      ),
      messages: [],
      isStreaming: false,
      sessionId: null,
    }));
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command !== "runtime_read_conversation") return undefined;
      const reference = (args as { reference: ConversationRef }).reference;
      return {
        reference,
        items: [
          {
            type: "user",
            message: { content: [{ type: "text", text: constructPrompt }] },
          },
        ],
      };
    });

    await sendLatexTeachAsk("follow-up from ref");

    expect(invoke).toHaveBeenCalledWith("runtime_read_conversation", {
      reference: {
        runtime: "claude",
        projectPath: PROJECT_A,
        sessionId: "learn-a",
      },
    });
    expect(userTexts(learnTabs()[0])).toEqual([
      constructPrompt,
      "follow-up from ref",
    ]);
  });

  it("delivers overlapping asks in order through one history reload", async () => {
    await sendLatexTeachAsk(constructPrompt);
    const learnId = learnTabs()[0]?.id ?? "";
    finishTurn(learnId, "learn-a");
    useClaudeChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === learnId
          ? {
              ...tab,
              messages: [],
              isStreaming: false,
              activeAttemptId: null,
              error: null,
              resumeRequestId: null,
            }
          : tab,
      ),
      messages: [],
      isStreaming: state.activeTabId === learnId ? false : state.isStreaming,
    }));

    let reads = 0;
    let releaseHistory!: () => void;
    const historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command !== "runtime_read_conversation") return undefined;
      reads += 1;
      await historyGate;
      const reference = (args as { reference: ConversationRef }).reference;
      return {
        reference,
        items: [
          {
            type: "user",
            message: { content: [{ type: "text", text: "saved lesson" }] },
          },
          {
            type: "assistant",
            message: { content: [{ type: "text", text: "saved answer" }] },
          },
        ],
      };
    });
    vi.mocked(invoke).mockClear();

    const first = sendLatexTeachAsk("first lesson");
    await vi.waitFor(() => expect(reads).toBe(1));
    const second = sendLatexTeachAsk("second lesson");
    expect(reads).toBe(1);
    releaseHistory();
    await first;
    await second;

    expect(reads).toBe(1);
    const learn = learnTabs()[0];
    expect(learn?.id).toBe(learnId);
    expect(userTexts(learn)).toEqual(["saved lesson", "first lesson"]);
    expect(learn?.queuedGuidance).toEqual([
      expect.objectContaining({
        prompt: "second lesson",
        skipAmbientContext: true,
      }),
    ]);
    expect(startRequests()).toHaveLength(1);
    expect(startRequests()[0]?.prompt).toContain("first lesson");
    expect(startRequests()[0]?.prompt).not.toContain("second lesson");
    expect(userTexts(mainTab())).toEqual(["writing chat"]);
    expect(mainTab()?.draft.input).toBe("draft in progress");
  });

  it("does not send a lesson into the project switched to during resume", async () => {
    await sendLatexTeachAsk("seed lesson");
    const learnId = learnTabs()[0]?.id ?? "";
    finishTurn(learnId, "learn-a");
    stopTab("tab-main");
    stopTab(learnId);
    useClaudeChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === learnId
          ? {
              ...tab,
              messages: [],
              isStreaming: false,
              activeAttemptId: null,
              error: null,
              resumeRequestId: null,
            }
          : tab,
      ),
    }));

    let reads = 0;
    let releaseHistory!: () => void;
    const historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command !== "runtime_read_conversation") return undefined;
      reads += 1;
      await historyGate;
      const reference = (args as { reference: ConversationRef }).reference;
      return {
        reference,
        items: [
          {
            type: "user",
            message: { content: [{ type: "text", text: "saved lesson" }] },
          },
        ],
      };
    });
    vi.mocked(invoke).mockClear();

    const first = sendLatexTeachAsk("lesson for A");
    await vi.waitFor(() => expect(reads).toBe(1));
    const second = sendLatexTeachAsk("also for A");
    writePersistedChatForProject(PROJECT_B, {
      version: 2,
      activeTabId: learnId,
      tabs: [
        {
          id: learnId,
          title: "Writing in B",
          projectPath: PROJECT_B,
          runtime: "claude",
          purpose: null,
        },
      ],
    });
    setDocument(PROJECT_B);
    expect(useClaudeChatStore.getState().resetForProject(PROJECT_B)).not.toBe(
      "blocked-stopping",
    );
    releaseHistory();
    await first;
    await second;

    expect(reads).toBe(1);
    expect(startRequests()).toEqual([]);
    const state = useClaudeChatStore.getState();
    expect(state.activeProjectPath).toBe(PROJECT_B);
    const delivered = state.tabs.flatMap((tab) => userTexts(tab));
    expect(delivered).not.toContain("lesson for A");
    expect(delivered).not.toContain("also for A");
    expect(state.tabs.some((tab) => tab.purpose === "latex-learn")).toBe(false);
  });

  it("does not retarget an explicit tab when the open project has changed", async () => {
    await sendLatexTeachAsk("seed lesson");
    const learnId = learnTabs()[0]?.id ?? "";
    finishTurn(learnId, "learn-a");
    stopTab("tab-main");
    stopTab(learnId);
    vi.mocked(invoke).mockClear();
    setDocument(PROJECT_B);

    await useClaudeChatStore.getState().sendPrompt("lesson for A", undefined, {
      tabId: learnId,
      skipAmbientContext: true,
    });

    expect(startRequests()).toEqual([]);
    expect(useClaudeChatStore.getState().activeProjectPath).toBe(PROJECT_A);
    expect(userTexts(learnTabs()[0])).toEqual(["seed lesson"]);
    expect(
      useClaudeChatStore
        .getState()
        .tabs.some((tab) => tab.projectPath === PROJECT_B),
    ).toBe(false);
  });

  it("reports the waiting-stop error instead of dropping a second ask", async () => {
    await sendLatexTeachAsk(constructPrompt);
    const learnId = learnTabs()[0]?.id ?? "";
    useClaudeChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === learnId
          ? {
              ...tab,
              cancelledAttempts: [
                {
                  attemptId: "stopping",
                  attemptEpoch: 1,
                  runtime: "claude" as const,
                  mode: "interrupt" as const,
                },
              ],
            }
          : tab,
      ),
    }));

    await sendLatexTeachAsk(errorPrompt);

    const learn = learnTabs()[0];
    expect(learn?.queuedGuidance).toEqual([]);
    expect(userTexts(learn)).toEqual([constructPrompt]);
    expect(learn?.error).toBe(translate("zh", "errors.waitingStop"));
    expect(startRequests()).toHaveLength(1);
  });

  it("opens another tab when auto-resume would bind a writing session", async () => {
    await sendLatexTeachAsk(constructPrompt);
    const learnId = learnTabs()[0]?.id ?? "";
    finishTurn(learnId, "learn-a");
    stopTab("tab-main");
    useClaudeChatStore.getState().setActiveTab(learnId);
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command !== "runtime_read_conversation") return undefined;
      const reference = (args as { reference: ConversationRef }).reference;
      return {
        reference,
        items: [
          {
            type: "user",
            message: {
              content: [{ type: "text", text: "writing history" }],
            },
          },
        ],
      };
    });

    await useClaudeChatStore.getState().resumeConversation(
      {
        runtime: "claude",
        sessionId: "writing-session",
        projectPath: PROJECT_A,
      },
      "Writing",
    );

    const learn = useClaudeChatStore
      .getState()
      .tabs.find((tab) => tab.id === learnId);
    expect(learn?.purpose).toBe("latex-learn");
    expect(learn?.sessionId).toBe("learn-a");
    expect(userTexts(learn)).toEqual([constructPrompt]);
    const writing = useClaudeChatStore
      .getState()
      .tabs.find((tab) => tab.sessionId === "writing-session");
    expect(writing?.id).not.toBe(learnId);
    expect(writing?.purpose ?? null).toBeNull();
    expect(userTexts(writing)).toEqual(["writing history"]);
  });
});

describe("displayConversationTitle", () => {
  it("shows the localized learning title while that session is open", () => {
    const reference: ConversationRef = {
      runtime: "claude",
      projectPath: PROJECT_A,
      sessionId: "learn-a",
    };
    const tabs = [
      {
        purpose: "latex-learn",
        runtime: "claude",
        projectPath: PROJECT_A,
        sessionId: "learn-a",
        sessionRef: reference,
        messages: [],
      },
    ] as unknown as TabState[];
    const conversation = {
      title: "请讲解这个结构",
      reference,
    };

    expect(
      displayConversationTitle(conversation, tabs, "New Chat", "边写边学"),
    ).toBe("边写边学");
    expect(
      displayConversationTitle(conversation, tabs, "New Chat", "Learn LaTeX"),
    ).toBe("Learn LaTeX");
    expect(
      displayConversationTitle(conversation, [], "New Chat", "边写边学"),
    ).toBe("请讲解这个结构");
  });
});
