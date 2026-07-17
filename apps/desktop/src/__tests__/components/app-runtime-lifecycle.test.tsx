import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { documentState, chatState, resetForProject, useClaudeEvents, setTitle } =
  vi.hoisted(() => {
    const resetForProject = vi.fn();
    return {
      documentState: { projectRoot: null as string | null, initialized: false },
      chatState: {
        tabs: [] as Array<{
          isStreaming: boolean;
          cancelledAttempts?: unknown[];
        }>,
        pendingInitialPrompt: null,
        isStreaming: false,
        resetForProject,
        consumePendingInitialPrompt: vi.fn(() => null),
        sendPrompt: vi.fn(() => Promise.resolve()),
        newSession: vi.fn(),
        resumeSession: vi.fn(() => Promise.resolve()),
      },
      resetForProject,
      useClaudeEvents: vi.fn(),
      setTitle: vi.fn(() => Promise.resolve()),
    };
  });

vi.mock("@/stores/document-store", () => ({
  useDocumentStore: (selector: (state: typeof documentState) => unknown) =>
    selector(documentState),
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
vi.mock("@/stores/uv-setup-store", () => ({
  useUvSetupStore: { getState: () => ({ checkStatus: vi.fn() }) },
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

import { App } from "@/App";

describe("App runtime event lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    documentState.projectRoot = null;
    documentState.initialized = false;
    chatState.tabs = [];
    resetForProject.mockReturnValue("reset");
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
  });

  it("retries a blocked chat scope reset after the stopping marker clears", async () => {
    documentState.projectRoot = "/project";
    chatState.tabs = [
      { isStreaming: false, cancelledAttempts: [{ attemptId: "attempt-1" }] },
    ];
    resetForProject
      .mockReturnValueOnce("blocked-stopping")
      .mockReturnValueOnce("reset");

    await act(async () => root.render(<App />));
    expect(resetForProject).toHaveBeenCalledTimes(1);
    expect(resetForProject).toHaveBeenLastCalledWith("/project");

    chatState.tabs = [{ isStreaming: false, cancelledAttempts: [] }];
    await act(async () => root.render(<App />));

    expect(resetForProject).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="workspace"]')).not.toBeNull();
  });
});
