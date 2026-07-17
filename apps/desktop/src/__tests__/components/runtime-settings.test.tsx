import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import type { RuntimeCardProps } from "@/components/runtime/runtime-card";
import { RuntimeSettings } from "@/components/runtime/runtime-settings";
import type { RuntimeAccount, RuntimeKind } from "@/runtime/types";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import {
  resetRuntimeStoreForTests,
  type RuntimeState,
  useRuntimeStore,
} from "@/stores/runtime-store";

type ClaudeSetupState = ReturnType<typeof useClaudeSetupStore.getState>;

const mocks = vi.hoisted(() => ({
  cards: new Map<RuntimeKind, RuntimeCardProps>(),
  shellOpen: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: mocks.shellOpen,
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError },
}));

vi.mock("@/components/claude-setup", () => ({
  ClaudeSetup: ({ variant }: { variant: string }) => (
    <div data-testid="claude-setup">ClaudeSetup:{variant}</div>
  ),
}));

vi.mock("@/components/runtime/runtime-card", () => ({
  RuntimeCard: (props: RuntimeCardProps) => {
    mocks.cards.set(props.account.runtime, props);
    return (
      <section data-runtime={props.account.runtime}>
        <h2>{props.title}</h2>
        <p>{props.description}</p>
        {props.account.error && <p role="alert">{props.account.error}</p>}
        {props.children}
      </section>
    );
  },
}));

function account(
  runtime: RuntimeKind,
  overrides: Partial<RuntimeAccount> = {},
): RuntimeAccount {
  return {
    runtime,
    installed: true,
    authenticated: runtime === "claude",
    version: "1.0.0",
    accountLabel: null,
    authMode: null,
    capabilities: {
      models: true,
      skills: true,
      customAgents: true,
      subagents: true,
      approvals: true,
    },
    error: null,
    ...overrides,
  };
}

describe("RuntimeSettings", () => {
  let container: HTMLDivElement;
  let root: Root;
  let refresh: Mock<RuntimeState["refresh"]>;
  let install: Mock<RuntimeState["install"]>;
  let startLogin: Mock<RuntimeState["startLogin"]>;
  let cancelLogin: Mock<RuntimeState["cancelLogin"]>;
  let logout: Mock<RuntimeState["logout"]>;
  let checkClaudeStatus: Mock<ClaudeSetupState["checkStatus"]>;

  beforeEach(() => {
    mocks.cards.clear();
    mocks.shellOpen.mockReset().mockResolvedValue(undefined);
    mocks.toastError.mockReset();
    resetRuntimeStoreForTests();
    refresh = vi.fn<RuntimeState["refresh"]>().mockResolvedValue(undefined);
    install = vi.fn<RuntimeState["install"]>().mockResolvedValue(true);
    startLogin = vi
      .fn<RuntimeState["startLogin"]>()
      .mockResolvedValue(undefined);
    cancelLogin = vi
      .fn<RuntimeState["cancelLogin"]>()
      .mockResolvedValue(undefined);
    logout = vi.fn<RuntimeState["logout"]>().mockResolvedValue(undefined);
    useRuntimeStore.setState({
      accounts: {
        claude: account("claude"),
        codex: account("codex"),
      },
      loading: {},
      login: {},
      refresh,
      install,
      startLogin,
      cancelLogin,
      logout,
    });
    checkClaudeStatus = vi
      .fn<ClaudeSetupState["checkStatus"]>()
      .mockResolvedValue(undefined);
    useClaudeSetupStore.setState({
      status: "checking",
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

  async function renderSettings(props: { refreshOnMount?: boolean } = {}) {
    await act(async () => {
      root.render(<RuntimeSettings {...props} />);
      await Promise.resolve();
    });
  }

  it("keeps both runtimes visible and nests the full Claude setup in the Claude card", async () => {
    useRuntimeStore.setState((state) => ({
      accounts: {
        ...state.accounts,
        codex: account("codex", { error: "Codex status unavailable" }),
      },
    }));

    await renderSettings();

    expect(container.querySelector('[data-runtime="claude"]')).not.toBeNull();
    expect(container.querySelector('[data-runtime="codex"]')).not.toBeNull();
    expect(container.textContent).toContain("Claude / Claude-backed providers");
    expect(container.textContent).toContain("Codex status unavailable");
    const claudeSetup = container.querySelector('[data-testid="claude-setup"]');
    expect(claudeSetup?.textContent).toBe("ClaudeSetup:embedded");
    expect(
      claudeSetup?.closest("[data-runtime]")?.getAttribute("data-runtime"),
    ).toBe("claude");
  });

  it("refreshes shared status on mount", async () => {
    await renderSettings();
    expect(refresh).toHaveBeenCalledWith();
  });

  it("can reuse a completed parent refresh without launching another one", async () => {
    await renderSettings({ refreshOnMount: false });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("syncs legacy Claude status only after a successful shared Claude logout", async () => {
    await renderSettings();
    const onClaudeLogout = mocks.cards.get("claude")?.onLogout;
    expect(onClaudeLogout).toBeTypeOf("function");

    await expect(onClaudeLogout?.()).resolves.toBeUndefined();

    expect(logout).toHaveBeenCalledWith("claude");
    expect(checkClaudeStatus).toHaveBeenCalledTimes(1);
    expect(logout.mock.invocationCallOrder[0]).toBeLessThan(
      checkClaudeStatus.mock.invocationCallOrder[0],
    );
  });

  it("consumes a failed shared Claude logout without checking legacy status", async () => {
    logout.mockRejectedValueOnce(new Error("logout failed"));
    await renderSettings();
    const onClaudeLogout = mocks.cards.get("claude")?.onLogout;

    await expect(onClaudeLogout?.()).resolves.toBeUndefined();

    expect(logout).toHaveBeenCalledWith("claude");
    expect(checkClaudeStatus).not.toHaveBeenCalled();
  });

  it("routes Codex actions and external links without touching legacy Claude status", async () => {
    await renderSettings();
    const codex = mocks.cards.get("codex");
    expect(codex).toBeDefined();

    await expect(codex?.onInstall?.()).resolves.toBeUndefined();
    await expect(codex?.onLogin?.("browser")).resolves.toBeUndefined();
    await expect(
      codex?.onLogin?.("api-key", "sk-test"),
    ).resolves.toBeUndefined();
    await expect(codex?.onCancelLogin?.()).resolves.toBeUndefined();
    await expect(
      codex?.onOpenExternal?.("https://auth.example"),
    ).resolves.toBeUndefined();
    await expect(codex?.onLogout?.()).resolves.toBeUndefined();

    expect(install).toHaveBeenCalledWith("codex");
    expect(startLogin).toHaveBeenNthCalledWith(
      1,
      "codex",
      "browser",
      undefined,
    );
    expect(startLogin).toHaveBeenNthCalledWith(
      2,
      "codex",
      "api-key",
      "sk-test",
    );
    expect(cancelLogin).toHaveBeenCalledWith("codex");
    expect(mocks.shellOpen).toHaveBeenCalledWith("https://auth.example");
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(logout).toHaveBeenCalledWith("codex");
    expect(checkClaudeStatus).not.toHaveBeenCalled();
  });

  it("consumes rejected Codex actions", async () => {
    install.mockRejectedValueOnce(new Error("install failed"));
    startLogin.mockRejectedValueOnce(new Error("login failed"));
    cancelLogin.mockRejectedValueOnce(new Error("cancel failed"));
    logout.mockRejectedValueOnce(new Error("logout failed"));
    mocks.shellOpen.mockRejectedValueOnce(
      new Error("open failed for https://auth.example?key=sk-secret"),
    );
    await renderSettings();
    const codex = mocks.cards.get("codex");

    await expect(codex?.onInstall?.()).resolves.toBeUndefined();
    await expect(codex?.onLogin?.("browser")).resolves.toBeUndefined();
    await expect(codex?.onCancelLogin?.()).resolves.toBeUndefined();
    await expect(codex?.onLogout?.()).resolves.toBeUndefined();
    await expect(
      codex?.onOpenExternal?.("https://auth.example"),
    ).resolves.toBeUndefined();
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Could not open authorization page",
      { description: "Copy the URL and open it manually." },
    );
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(
      "sk-secret",
    );
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(
      "auth.example",
    );
  });
});
