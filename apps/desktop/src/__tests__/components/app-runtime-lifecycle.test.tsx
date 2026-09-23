import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConversation } from "@/runtime/types";

const {
  documentState,
  chatState,
  resetForProject,
  runtimeListConversations,
  resumeConversation,
  resumeSession,
  newSession,
  useClaudeEvents,
  setTitle,
} = vi.hoisted(() => {
  const resetForProject = vi.fn();
  const resumeConversation = vi.fn(() => Promise.resolve());
  const resumeSession = vi.fn(() => Promise.resolve());
  const newSession = vi.fn();
  return {
    documentState: { projectRoot: null as string | null, initialized: false },
    chatState: {
      tabs: [] as Array<{
        id: string;
        projectPath: string | null;
        runtime: "claude" | "codex";
        attemptEpoch: number;
        isStreaming: boolean;
        cancelledAttempts?: unknown[];
        messages?: unknown[];
        sessionId?: string | null;
        sessionRef?: unknown;
      }>,
      activeTabId: "missing-tab",
      pendingInitialPrompt: null as string | null,
      isStreaming: false,
      resetForProject,
      consumePendingInitialPrompt: vi.fn(() => null),
      sendPrompt: vi.fn(() => Promise.resolve()),
      newSession,
      resumeConversation,
      resumeSession,
    },
    resetForProject,
    runtimeListConversations: vi.fn(
      (): Promise<RuntimeConversation[]> => Promise.resolve([]),
    ),
    resumeConversation,
    resumeSession,
    newSession,
    useClaudeEvents: vi.fn(),
    setTitle: vi.fn(() => Promise.resolve()),
  };
});

vi.mock("@/stores/document-store", () => ({
  useDocumentStore: Object.assign(
    (selector: (state: typeof documentState) => unknown) =>
      selector(documentState),
    { getState: () => documentState },
  ),
}));

vi.mock("@/stores/claude-chat-store", () => ({
  useClaudeChatStore: Object.assign(
    (selector: (state: typeof chatState) => unknown) => selector(chatState),
    { getState: () => chatState },
  ),
}));

vi.mock("@/hooks/use-claude-events", () => ({ useClaudeEvents }));
vi.mock("@/hooks/use-keyboard-shortcuts", () => ({
  useKeyboardShortcuts: vi.fn(),
}));
vi.mock("@/hooks/use-claude-runtime-sync", () => ({
  useClaudeRuntimeSync: vi.fn(),
}));
vi.mock("@/hooks/use-runtime-warning-events", () => ({
  useRuntimeWarningEvents: vi.fn(),
}));
vi.mock("@/runtime/commands", () => ({ runtimeListConversations }));
vi.mock("@/stores/claude-setup-store", () => ({
  useClaudeSetupStore: Object.assign(
    () => ({
      ensureEngine: vi.fn(() => Promise.resolve()),
    }),
    {
      getState: () => ({
        ensureEngine: vi.fn(() => Promise.resolve()),
      }),
    },
  ),
}));
vi.mock("@/stores/uv-setup-store", () => ({
  useUvSetupStore: {
    getState: () => ({
      status: "missing",
      checkStatus: vi.fn(() => Promise.resolve()),
    }),
  },
}));
vi.mock("@/stores/agent-store", () => ({
  useAgentStore: {
    getState: () => ({
      ensureBuiltinPresets: vi.fn(() => Promise.resolve()),
    }),
  },
}));
vi.mock("@/stores/skill-store", () => ({
  useSkillStore: Object.assign(
    () => ({
      ensureDefaultSkillPacks: vi.fn(() => Promise.resolve([])),
    }),
    {
      getState: () => ({
        ensureDefaultSkillPacks: vi.fn(() => Promise.resolve([])),
      }),
    },
  ),
}));
vi.mock("@/components/project-picker", () => ({
  ProjectPicker: () => <div data-testid="project-picker" />,
}));
vi.mock("@/components/workspace/workspace-layout", () => ({
  WorkspaceLayout: () => <div data-testid="workspace" />,
}));
vi.mock("@/components/environment-onboarding", () => ({
  EnvironmentOnboarding: () => null,
}));
vi.mock("@/components/welcome-wizard", () => ({
  WelcomeWizard: () => <div data-testid="welcome-wizard" />,
}));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("next-themes", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
  useTheme: () => ({ resolvedTheme: "light", theme: "light" }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setTitle, setTheme: vi.fn() }),
}));

import { WELCOME_COMPLETED_KEY } from "@/lib/welcome";
import { App } from "@/App";

type MockTab = (typeof chatState.tabs)[number];

function makeTab(overrides: Partial<MockTab> = {}): MockTab {
  return {
    id: "tab-1",
    projectPath: "/project",
    runtime: "claude",
    attemptEpoch: 0,
    isStreaming: false,
    cancelledAttempts: [],
    messages: [],
    sessionId: null,
    sessionRef: null,
    ...overrides,
  };
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

function conversation(
  runtime: "claude" | "codex",
  sessionId: string,
  conversationProjectPath: string,
  updatedAt: number,
  title = sessionId,
): RuntimeConversation {
  return {
    reference: {
      runtime,
      sessionId,
      projectPath: conversationProjectPath,
    },
    title,
    status: "idle",
    updatedAt,
  };
}

describe("App runtime event lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem(WELCOME_COMPLETED_KEY, "true");
    documentState.projectRoot = null;
    documentState.initialized = false;
    chatState.tabs = [];
    chatState.activeTabId = "missing-tab";
    chatState.pendingInitialPrompt = null;
    chatState.isStreaming = false;
    resetForProject.mockReset().mockReturnValue("reset");
    runtimeListConversations.mockReset().mockResolvedValue([]);
    resumeConversation.mockReset().mockResolvedValue(undefined);
    resumeSession.mockReset().mockResolvedValue(undefined);
    newSession.mockReset();
    vi.mocked(invoke).mockResolvedValue([]);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        matches: false,
      })),
    });
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
  });

  it("keeps runtime event listeners mounted when no project is open", async () => {
    await act(async () => root.render(<App />));

    expect(useClaudeEvents).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-testid="project-picker"]'),
    ).not.toBeNull();
    expect(
      document.body.querySelector('[data-testid="product-tour"]'),
    ).toBeNull();
  });

  it("does not auto-resume archived Codex conversations", async () => {
    documentState.projectRoot = "/project";
    documentState.initialized = true;
    chatState.tabs = [makeTab({ id: "before-reset", runtime: "claude" })];
    chatState.activeTabId = "before-reset";
    resetForProject.mockImplementation(() => {
      chatState.tabs = [makeTab({ id: "codex-tab", runtime: "codex" })];
      chatState.activeTabId = "codex-tab";
      return "reset";
    });
    runtimeListConversations.mockResolvedValue([
      conversation("codex", "codex-latest", "/project", 20, "Latest Codex"),
    ]);

    await act(async () => root.render(<App />));
    await act(async () => {
      await Promise.resolve();
    });

    expect(runtimeListConversations).not.toHaveBeenCalled();
    expect(resumeConversation).not.toHaveBeenCalled();
    expect(newSession).not.toHaveBeenCalled();
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it("captures the reset Claude tab and resumes its latest exact conversation", async () => {
    documentState.projectRoot = "/project";
    documentState.initialized = true;
    chatState.tabs = [makeTab({ id: "before-reset", runtime: "codex" })];
    chatState.activeTabId = "before-reset";
    resetForProject.mockImplementation(() => {
      chatState.tabs = [makeTab({ id: "claude-tab", runtime: "claude" })];
      chatState.activeTabId = "claude-tab";
      return "reset";
    });
    const latest = conversation(
      "claude",
      "claude-latest",
      "/project",
      20,
      "Latest Claude",
    );
    runtimeListConversations.mockResolvedValue([
      conversation("claude", "claude-older", "/project", 10),
      conversation("codex", "wrong-runtime", "/project", 100),
      conversation("claude", "wrong-project", "/other-project", 200),
      latest,
    ]);

    await act(async () => root.render(<App />));

    await vi.waitFor(() =>
      expect(resumeConversation).toHaveBeenCalledWith(
        latest.reference,
        latest.title,
      ),
    );
    expect(runtimeListConversations).toHaveBeenCalledWith("claude", "/project");
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it("ignores a conversation response after the document project changes", async () => {
    const response = deferred<ReturnType<typeof conversation>[]>();
    const latest = conversation("claude", "thread-1", "/project", 10);
    documentState.projectRoot = "/project";
    documentState.initialized = true;
    chatState.tabs = [makeTab({ id: "claude-tab", runtime: "claude" })];
    chatState.activeTabId = "claude-tab";
    runtimeListConversations.mockReturnValue(response.promise);

    await act(async () => root.render(<App />));
    await vi.waitFor(() =>
      expect(runtimeListConversations).toHaveBeenCalledWith(
        "claude",
        "/project",
      ),
    );
    documentState.projectRoot = "/other-project";
    await act(async () => {
      response.resolve([latest]);
      await response.promise;
      await Promise.resolve();
    });

    expect(resumeConversation).not.toHaveBeenCalled();
    expect(newSession).not.toHaveBeenCalled();
  });

  it("keeps a valid request when another tab's stopping count changes", async () => {
    const response = deferred<ReturnType<typeof conversation>[]>();
    const latest = conversation("claude", "thread-1", "/project", 10);
    documentState.projectRoot = "/project";
    documentState.initialized = true;
    chatState.tabs = [
      makeTab({ id: "claude-tab", runtime: "claude" }),
      makeTab({ id: "other-tab", runtime: "claude" }),
    ];
    chatState.activeTabId = "claude-tab";
    runtimeListConversations.mockReturnValue(response.promise);

    await act(async () => root.render(<App />));
    await vi.waitFor(() =>
      expect(runtimeListConversations).toHaveBeenCalledWith(
        "claude",
        "/project",
      ),
    );

    chatState.tabs = chatState.tabs.map((tab) =>
      tab.id === "other-tab"
        ? { ...tab, cancelledAttempts: [{ attemptId: "stopping" }] }
        : tab,
    );
    await act(async () => root.render(<App />));
    await act(async () => {
      response.resolve([latest]);
      await response.promise;
      await Promise.resolve();
    });

    expect(resumeConversation).toHaveBeenCalledWith(
      latest.reference,
      latest.title,
    );
    expect(newSession).not.toHaveBeenCalled();
  });

  it("does not overwrite a conversation replaced by the user while history is loading", async () => {
    const response = deferred<ReturnType<typeof conversation>[]>();
    const latest = conversation("claude", "thread-1", "/project", 10);
    documentState.projectRoot = "/project";
    documentState.initialized = true;
    chatState.tabs = [makeTab({ id: "claude-tab", runtime: "claude" })];
    chatState.activeTabId = "claude-tab";
    runtimeListConversations.mockReturnValue(response.promise);

    await act(async () => root.render(<App />));
    await vi.waitFor(() =>
      expect(runtimeListConversations).toHaveBeenCalledWith(
        "claude",
        "/project",
      ),
    );

    chatState.tabs = chatState.tabs.map((tab) =>
      tab.id === "claude-tab"
        ? { ...tab, attemptEpoch: tab.attemptEpoch + 1 }
        : tab,
    );
    await act(async () => {
      response.resolve([latest]);
      await response.promise;
      await Promise.resolve();
    });

    expect(resumeConversation).not.toHaveBeenCalled();
    expect(newSession).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "active tab",
      mutateOwnership: () => {
        chatState.tabs = [
          ...chatState.tabs,
          makeTab({ id: "other-tab", runtime: "claude" }),
        ];
        chatState.activeTabId = "other-tab";
      },
    },
    {
      name: "captured tab runtime",
      mutateOwnership: () => {
        chatState.tabs = chatState.tabs.map((tab) =>
          tab.id === "claude-tab" ? { ...tab, runtime: "codex" } : tab,
        );
      },
    },
    {
      name: "captured tab project",
      mutateOwnership: () => {
        chatState.tabs = chatState.tabs.map((tab) =>
          tab.id === "claude-tab"
            ? { ...tab, projectPath: "/other-project" }
            : tab,
        );
      },
    },
  ])("does not start an empty-history session after the same-project $name changes", async ({
    mutateOwnership,
  }) => {
    const response = deferred<ReturnType<typeof conversation>[]>();
    documentState.projectRoot = "/project";
    documentState.initialized = true;
    chatState.tabs = [makeTab({ id: "claude-tab", runtime: "claude" })];
    chatState.activeTabId = "claude-tab";
    runtimeListConversations.mockReturnValue(response.promise);

    await act(async () => root.render(<App />));
    await vi.waitFor(() =>
      expect(runtimeListConversations).toHaveBeenCalledWith(
        "claude",
        "/project",
      ),
    );
    mutateOwnership();
    await act(async () => {
      response.resolve([]);
      await response.promise;
      await Promise.resolve();
    });

    expect(newSession).not.toHaveBeenCalled();
    expect(resumeConversation).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "a pending initial prompt appears",
      blockApply: () => {
        chatState.pendingInitialPrompt = "queued prompt";
      },
    },
    {
      name: "the captured tab starts streaming",
      blockApply: () => {
        chatState.tabs = chatState.tabs.map((tab) =>
          tab.id === "claude-tab" ? { ...tab, isStreaming: true } : tab,
        );
      },
    },
    {
      name: "the captured tab starts stopping",
      blockApply: () => {
        chatState.tabs = chatState.tabs.map((tab) =>
          tab.id === "claude-tab"
            ? { ...tab, cancelledAttempts: [{ attemptId: "stopping" }] }
            : tab,
        );
      },
    },
  ])("does not apply history when $name", async ({ blockApply }) => {
    const response = deferred<ReturnType<typeof conversation>[]>();
    const latest = conversation("claude", "thread-1", "/project", 10);
    documentState.projectRoot = "/project";
    documentState.initialized = true;
    chatState.tabs = [makeTab({ id: "claude-tab", runtime: "claude" })];
    chatState.activeTabId = "claude-tab";
    runtimeListConversations.mockReturnValue(response.promise);

    await act(async () => root.render(<App />));
    await vi.waitFor(() =>
      expect(runtimeListConversations).toHaveBeenCalledWith(
        "claude",
        "/project",
      ),
    );
    blockApply();
    await act(async () => {
      response.resolve([latest]);
      await response.promise;
      await Promise.resolve();
    });

    expect(resumeConversation).not.toHaveBeenCalled();
    expect(newSession).not.toHaveBeenCalled();
  });

  it("retries a blocked chat scope reset after the stopping marker clears", async () => {
    documentState.projectRoot = "/project";
    chatState.tabs = [
      makeTab({ cancelledAttempts: [{ attemptId: "attempt-1" }] }),
    ];
    chatState.activeTabId = "tab-1";
    resetForProject
      .mockReturnValueOnce("blocked-stopping")
      .mockReturnValueOnce("reset");

    await act(async () => root.render(<App />));
    expect(resetForProject).toHaveBeenCalledTimes(1);
    expect(resetForProject).toHaveBeenLastCalledWith("/project");

    chatState.tabs = [makeTab()];
    await act(async () => root.render(<App />));

    expect(resetForProject).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="workspace"]')).not.toBeNull();
  });

  it("retries a blocked chat scope reset after an active stream completes", async () => {
    documentState.projectRoot = "/project";
    chatState.tabs = [makeTab({ isStreaming: true })];
    chatState.activeTabId = "tab-1";
    resetForProject
      .mockReturnValueOnce("blocked-stopping")
      .mockReturnValueOnce("reset");

    await act(async () => root.render(<App />));
    expect(resetForProject).toHaveBeenCalledTimes(1);
    expect(resetForProject).toHaveBeenLastCalledWith("/project");

    chatState.tabs = [makeTab({ isStreaming: false })];
    await act(async () => root.render(<App />));

    expect(resetForProject).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="workspace"]')).not.toBeNull();
  });
});
