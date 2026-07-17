import { act, type ComponentProps, type ReactNode, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvironmentOnboarding } from "@/components/environment-onboarding";
import type { RuntimeAccount, RuntimeKind } from "@/runtime/types";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import {
  resetRuntimeStoreForTests,
  type RuntimeState,
  useRuntimeStore,
} from "@/stores/runtime-store";

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
  RuntimeSettings: (props: { refreshOnMount?: boolean }) => {
    mocks.runtimeSettingsProps.push(props);
    return <div data-testid="runtime-settings">Runtime settings</div>;
  },
}));

vi.mock("@/components/claude-setup", () => ({
  ClaudeSetup: () => <div>Legacy Claude setup</div>,
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

function account(
  runtime: RuntimeKind,
  overrides: Partial<RuntimeAccount> = {},
): RuntimeAccount {
  return {
    runtime,
    installed: false,
    authenticated: false,
    version: null,
    accountLabel: null,
    authMode: null,
    capabilities: {
      models: false,
      skills: false,
      customAgents: false,
      subagents: false,
      approvals: false,
    },
    error: null,
    ...overrides,
  };
}

describe("EnvironmentOnboarding", () => {
  let container: HTMLDivElement;
  let root: Root;
  let refresh = vi.fn<RuntimeState["refresh"]>();
  let checkClaudeStatus =
    vi.fn<ReturnType<typeof useClaudeSetupStore.getState>["checkStatus"]>();

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    mocks.uvCheckStatus.mockClear();
    mocks.finishUvInstall.mockClear();
    mocks.runtimeSettingsProps.length = 0;
    resetRuntimeStoreForTests();
    refresh = vi.fn<RuntimeState["refresh"]>().mockResolvedValue(undefined);
    useRuntimeStore.setState((state) => ({
      accounts: {
        claude: account("claude"),
        codex: account("codex"),
      },
      refresh,
      loading: state.loading,
    }));
    checkClaudeStatus = vi
      .fn<ReturnType<typeof useClaudeSetupStore.getState>["checkStatus"]>()
      .mockResolvedValue(undefined);
    useClaudeSetupStore.setState({
      status: "not-installed",
      error: null,
      checkStatus: checkClaudeStatus,
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
    resetRuntimeStoreForTests();
  });

  async function renderOnboarding(): Promise<void> {
    await act(async () => {
      root.render(<EnvironmentOnboarding />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function doneButton(): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Done",
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("Done button was not rendered");
    }
    return button;
  }

  async function makeReady(runtime: RuntimeKind): Promise<void> {
    await act(async () => {
      useRuntimeStore.setState((state) => ({
        accounts: {
          ...state.accounts,
          [runtime]: account(runtime, {
            installed: true,
            authenticated: true,
          }),
        },
      }));
    });
  }

  it("opens with runtime settings and disables Done when neither runtime is ready", async () => {
    await renderOnboarding();

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="runtime-settings"]'),
    ).not.toBeNull();
    expect(doneButton().disabled).toBe(true);
  });

  it("does not let nested settings repeat the completed startup refresh", async () => {
    await renderOnboarding();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(
      mocks.runtimeSettingsProps[mocks.runtimeSettingsProps.length - 1],
    ).toEqual({
      refreshOnMount: false,
    });
  });

  it.each([
    "claude",
    "codex",
  ] as const)("enables Done when only %s becomes ready", async (runtime) => {
    await renderOnboarding();
    await makeReady(runtime);

    expect(doneButton().disabled).toBe(false);
  });

  it("allows one ready runtime even when the other runtime has an error", async () => {
    await renderOnboarding();

    await act(async () => {
      useRuntimeStore.setState({
        accounts: {
          claude: account("claude", { error: "Claude unavailable" }),
          codex: account("codex", {
            installed: true,
            authenticated: true,
          }),
        },
      });
    });

    expect(doneButton().disabled).toBe(false);
  });

  it("does not check uv or skills because neither participates in the gate", async () => {
    await renderOnboarding();

    expect(mocks.uvCheckStatus).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    "claude",
    "codex",
  ] as const)("does not open on startup when %s is already ready", async (runtime) => {
    useRuntimeStore.setState((state) => ({
      accounts: {
        ...state.accounts,
        [runtime]: account(runtime, {
          installed: true,
          authenticated: true,
        }),
      },
    }));

    await renderOnboarding();

    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("never opens when startup refresh authenticates a runtime before the initial check settles", async () => {
    let finishRefresh: (() => void) | undefined;
    const refreshPending = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    refresh.mockImplementationOnce(async () => {
      useRuntimeStore.setState((state) => ({
        accounts: {
          ...state.accounts,
          codex: account("codex", {
            installed: true,
            authenticated: true,
          }),
        },
      }));
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
      useRuntimeStore.setState((state) => ({
        accounts: {
          ...state.accounts,
          codex: account("codex", {
            installed: true,
            authenticated: true,
          }),
        },
      }));
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
    await makeReady("codex");

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(doneButton().disabled).toBe(false);

    await act(async () => doneButton().click());

    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("does not reopen a dismissed setup for an error while another runtime stays ready", async () => {
    await renderOnboarding();
    await makeReady("codex");
    await act(async () => doneButton().click());

    await act(async () => {
      useRuntimeStore.setState((state) => ({
        accounts: {
          ...state.accounts,
          claude: account("claude", { error: "Claude unavailable" }),
        },
      }));
    });

    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("finishes the initial check when both startup checks reject", async () => {
    refresh.mockRejectedValueOnce(new Error("runtime status failed"));
    checkClaudeStatus.mockRejectedValueOnce(new Error("legacy status failed"));

    await renderOnboarding();

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(doneButton().disabled).toBe(true);
  });

  it("uses a wide vertically scrollable dialog for both runtime cards", async () => {
    await renderOnboarding();

    const content = container.querySelector(
      '[data-testid="onboarding-content"]',
    );
    expect(content?.className).toContain("overflow-y-auto");
    expect(content?.className).toContain("sm:max-w-none");
  });
});
