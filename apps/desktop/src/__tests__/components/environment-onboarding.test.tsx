import { act, type ComponentProps, type ReactNode, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvironmentOnboarding } from "@/components/environment-onboarding";
import {
  markWelcomeCompleted,
  resetWelcomeCompletedForTests,
} from "@/lib/welcome";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useDocumentStore } from "@/stores/document-store";
import {
  resetProviderStoreForTests,
  useProviderStore,
} from "@/stores/provider-store";
import { resetDefaultSkillPacksForTests } from "@/stores/skill-store";

const mocks = vi.hoisted(() => ({
  uvCheckStatus: vi.fn().mockResolvedValue(undefined),
  finishUvInstall: vi.fn(),
  runtimeSettingsProps: [] as Array<{ refreshOnMount?: boolean }>,
}));

vi.mock("@/stores/uv-setup-store", () => {
  const state = {
    status: "not-installed",
    version: null,
    error: null,
    isInstalling: false,
    checkStatus: mocks.uvCheckStatus,
    install: vi.fn(),
    _finishInstall: mocks.finishUvInstall,
  };
  return {
    useUvSetupStore: (selector: (value: typeof state) => unknown) =>
      selector(state),
  };
});

vi.mock("@/components/runtime/runtime-settings", () => ({
  RuntimeSettings: (props: {
    refreshOnMount?: boolean;
    showEngine?: boolean;
  }) => {
    mocks.runtimeSettingsProps.push(props);
    return <div data-testid="runtime-settings">Runtime settings</div>;
  },
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({
    children,
    className,
  }: ComponentProps<"div"> & { showCloseButton?: boolean }) => (
    <div data-testid="onboarding-content" className={className}>
      {children}
    </div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
}));

describe("EnvironmentOnboarding", () => {
  let container: HTMLDivElement;
  let root: Root;
  let refresh = vi.fn(async () => undefined);
  let checkClaudeStatus =
    vi.fn<ReturnType<typeof useClaudeSetupStore.getState>["checkStatus"]>();

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    resetDefaultSkillPacksForTests();
    resetWelcomeCompletedForTests();
    markWelcomeCompleted();
    mocks.uvCheckStatus.mockClear();
    mocks.finishUvInstall.mockClear();
    mocks.runtimeSettingsProps.length = 0;
    resetProviderStoreForTests();
    useDocumentStore.setState({ projectRoot: null });
    refresh = vi.fn(async () => undefined);
    useProviderStore.setState({
      ready: false,
      engineInstalled: false,
      activeAuthenticated: false,
      refresh,
    });
    checkClaudeStatus = vi
      .fn<ReturnType<typeof useClaudeSetupStore.getState>["checkStatus"]>()
      .mockResolvedValue(undefined);
    useClaudeSetupStore.setState({
      status: "not-installed",
      error: null,
      checkStatus: checkClaudeStatus,
      ensureEngine: vi.fn(async () => undefined),
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
    resetProviderStoreForTests();
    useDocumentStore.setState({ projectRoot: null });
    useClaudeSetupStore.setState({
      ensureEngine: useClaudeSetupStore.getInitialState().ensureEngine,
      checkStatus: useClaudeSetupStore.getInitialState().checkStatus,
    });
  });

  async function renderOnboarding(): Promise<void> {
    await act(async () => {
      root.render(<EnvironmentOnboarding />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function buttonNamed(name: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === name,
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`${name} button was not rendered`);
    }
    return button;
  }

  async function makeReady(): Promise<void> {
    await act(async () => {
      useProviderStore.setState({
        ready: true,
        engineInstalled: true,
        activeAuthenticated: true,
      });
    });
  }

  it("stays hidden while first-run welcome is still incomplete", async () => {
    resetWelcomeCompletedForTests();
    await renderOnboarding();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("allows entering the workspace when no provider is ready", async () => {
    await renderOnboarding();

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.textContent).toMatch(/API key/i);
    expect(container.textContent).toMatch(/optional/i);
    expect(container.textContent).not.toMatch(
      /Pick one provider card — Claude Official/,
    );
    expect(
      container.querySelector('[data-testid="runtime-settings"]'),
    ).not.toBeNull();
    const action = buttonNamed("Skip model setup");
    expect(action.disabled).toBe(false);

    await act(async () => action.click());

    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("does not let nested settings repeat the completed startup refresh", async () => {
    await renderOnboarding();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(
      mocks.runtimeSettingsProps[mocks.runtimeSettingsProps.length - 1],
    ).toEqual({
      refreshOnMount: false,
      showEngine: false,
    });
  });

  it("enables Done when the active provider becomes ready", async () => {
    await renderOnboarding();
    await makeReady();

    expect(buttonNamed("Done").disabled).toBe(false);
  });

  it("does not check uv because it does not participate in the gate", async () => {
    await renderOnboarding();

    expect(mocks.uvCheckStatus).not.toHaveBeenCalled();
  });

  it("stays hidden while a project is open so account changes do not bounce home", async () => {
    useDocumentStore.setState({ projectRoot: "C:/paper" });
    useProviderStore.setState({
      ready: false,
      engineInstalled: true,
      activeAuthenticated: false,
    });

    await renderOnboarding();

    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("closes the homepage gate as soon as a project is opened", async () => {
    await renderOnboarding();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      useDocumentStore.setState({ projectRoot: "C:/paper" });
    });

    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("does not open on startup when a provider is already ready", async () => {
    useProviderStore.setState({
      ready: true,
      engineInstalled: true,
      activeAuthenticated: true,
    });

    await renderOnboarding();

    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("never opens when startup refresh authenticates a provider before the initial check settles", async () => {
    let finishRefresh: (() => void) | undefined;
    const refreshPending = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    refresh.mockImplementationOnce(async () => {
      useProviderStore.setState({
        ready: true,
        engineInstalled: true,
        activeAuthenticated: true,
      });
      await refreshPending;
    });

    await act(async () => {
      root.render(<EnvironmentOnboarding />);
      await Promise.resolve();
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      finishRefresh?.();
      await refreshPending;
      await Promise.resolve();
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(checkClaudeStatus).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("shares one startup check across StrictMode effect replay and still completes the gate", async () => {
    let finishRefresh: (() => void) | undefined;
    let finishClaudeCheck: (() => void) | undefined;
    const refreshPending = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    const claudeCheckPending = new Promise<void>((resolve) => {
      finishClaudeCheck = resolve;
    });
    refresh.mockImplementation(async () => {
      useProviderStore.setState({
        ready: true,
        engineInstalled: true,
        activeAuthenticated: true,
      });
      await refreshPending;
    });
    checkClaudeStatus.mockImplementation(async () => {
      await claudeCheckPending;
    });

    await act(async () => {
      root.render(
        <StrictMode>
          <EnvironmentOnboarding />
        </StrictMode>,
      );
      await Promise.resolve();
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(checkClaudeStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishRefresh?.();
      finishClaudeCheck?.();
      await Promise.all([refreshPending, claudeCheckPending]);
      await Promise.resolve();
    });

    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("starts a new check after a completed mount is unmounted and mounted again", async () => {
    await renderOnboarding();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(checkClaudeStatus).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderOnboarding();

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(checkClaudeStatus).toHaveBeenCalledTimes(2);
  });

  it("keeps an opened setup visible after authentication until Done is clicked", async () => {
    await renderOnboarding();
    await makeReady();

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(buttonNamed("Done").disabled).toBe(false);

    await act(async () => buttonNamed("Done").click());

    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("does not reopen after continuing without AI when provider readiness changes", async () => {
    await renderOnboarding();

    await act(async () => buttonNamed("Skip model setup").click());

    await makeReady();

    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("still allows entering when both startup checks reject", async () => {
    refresh.mockRejectedValueOnce(new Error("provider status failed"));
    checkClaudeStatus.mockRejectedValueOnce(new Error("legacy status failed"));

    await renderOnboarding();

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(buttonNamed("Skip model setup").disabled).toBe(false);
  });

  it("uses a wide vertically scrollable dialog for provider cards", async () => {
    await renderOnboarding();

    const content = container.querySelector(
      '[data-testid="onboarding-content"]',
    );
    expect(content?.className).toContain("overflow-y-auto");
    expect(content?.className).toContain("sm:max-w-none");
  });
});
