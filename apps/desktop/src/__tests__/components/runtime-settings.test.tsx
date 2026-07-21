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
import { getThirdPartyProviderCards } from "@/components/claude-setup";
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
  cards: new Map<string, RuntimeCardProps>(),
  shellOpen: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: mocks.shellOpen,
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError },
}));

vi.mock("@/components/claude-setup", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/claude-setup")>();
  return {
    ...actual,
    ClaudeSetup: ({ variant, scope }: { variant: string; scope?: string }) => (
      <div data-testid="claude-setup">
        ClaudeSetup:{variant}:{scope ?? "all"}
      </div>
    ),
  };
});

vi.mock("@/components/runtime/runtime-card", () => ({
  RuntimeCard: (props: RuntimeCardProps) => {
    mocks.cards.set(props.sectionId ?? props.title, props);
    return (
      <section
        data-runtime={props.account.runtime}
        data-section={props.sectionId}
      >
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

describe("third-party provider presets", () => {
  it("exposes both OpenAI and Anthropic cards for dual-protocol vendors", () => {
    const ids = getThirdPartyProviderCards().map((card) => card.id);
    for (const vendor of ["deepseek", "siliconflow", "xiaomi", "qwen"]) {
      expect(ids).toContain(`${vendor}-openai`);
      expect(ids).toContain(`${vendor}-anthropic`);
    }
  });
});

describe("RuntimeSettings", () => {
  let container: HTMLDivElement;
  let root: Root;
  let refresh: Mock<RuntimeState["refresh"]>;
  let install: Mock<RuntimeState["install"]>;
  let startLogin: Mock<RuntimeState["startLogin"]>;
  let ensureInstalledAndStartLogin: Mock<
    RuntimeState["ensureInstalledAndStartLogin"]
  >;
  let resetCodexSetupFlow: Mock<RuntimeState["resetCodexSetupFlow"]>;
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
    ensureInstalledAndStartLogin = vi
      .fn<RuntimeState["ensureInstalledAndStartLogin"]>()
      .mockResolvedValue(undefined);
    resetCodexSetupFlow = vi.fn<RuntimeState["resetCodexSetupFlow"]>();
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
      ensureInstalledAndStartLogin,
      resetCodexSetupFlow,
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

  it("renders Claude, Codex, and Third-party API sections", async () => {
    useRuntimeStore.setState((state) => ({
      accounts: {
        ...state.accounts,
        codex: account("codex", { error: "Codex status unavailable" }),
      },
    }));

    await renderSettings();

    expect(container.querySelector('[data-section="claude"]')).not.toBeNull();
    expect(container.querySelector('[data-section="codex"]')).not.toBeNull();
    expect(
      container.querySelector('[data-section="third-party"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Claude");
    expect(container.textContent).toContain("Codex");
    expect(container.textContent).toContain("Third-party API");
    expect(container.textContent).toContain("Codex status unavailable");

    const setups = Array.from(
      container.querySelectorAll('[data-testid="claude-setup"]'),
    );
    expect(setups).toHaveLength(2);
    expect(setups[0]?.textContent).toBe("ClaudeSetup:embedded:claude");
    expect(setups[1]?.textContent).toBe("ClaudeSetup:embedded:third-party");
    expect(
      setups[0]?.closest("[data-section]")?.getAttribute("data-section"),
    ).toBe("claude");
    expect(
      setups[1]?.closest("[data-section]")?.getAttribute("data-section"),
    ).toBe("third-party");
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

  it("resets Codex setup flow before Install only", async () => {
    await renderSettings();
    const codex = mocks.cards.get("codex");

    await expect(codex?.onInstall?.()).resolves.toBeUndefined();

    expect(resetCodexSetupFlow).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith("codex");
    expect(resetCodexSetupFlow.mock.invocationCallOrder[0]).toBeLessThan(
      install.mock.invocationCallOrder[0],
    );
  });

  it("routes Codex actions and external links without touching legacy Claude status", async () => {
    await renderSettings();
    const codex = mocks.cards.get("codex");
    expect(codex).toBeDefined();

    await expect(codex?.onInstall?.()).resolves.toBeUndefined();
    await expect(codex?.onLogin?.("browser")).resolves.toBeUndefined();
    await expect(codex?.onLogin?.("device-code")).resolves.toBeUndefined();
    await expect(
      codex?.onLogin?.("api-key", "sk-test"),
    ).resolves.toBeUndefined();
    await expect(codex?.onCancelLogin?.()).resolves.toBeUndefined();
    await expect(
      codex?.onOpenExternal?.("https://auth.example"),
    ).resolves.toBeUndefined();
    await expect(codex?.onLogout?.()).resolves.toBeUndefined();

    expect(resetCodexSetupFlow).toHaveBeenCalled();
    expect(install).toHaveBeenCalledWith("codex");
    expect(ensureInstalledAndStartLogin).toHaveBeenNthCalledWith(
      1,
      "codex",
      "browser",
    );
    expect(ensureInstalledAndStartLogin).toHaveBeenNthCalledWith(
      2,
      "codex",
      "device-code",
    );
    expect(startLogin).toHaveBeenCalledWith("codex", "api-key", "sk-test");
    expect(startLogin).not.toHaveBeenCalledWith(
      "codex",
      "browser",
      expect.anything(),
    );
    expect(cancelLogin).toHaveBeenCalledWith("codex");
    expect(mocks.shellOpen).toHaveBeenCalledWith("https://auth.example");
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(logout).toHaveBeenCalledWith("codex");
    expect(checkClaudeStatus).not.toHaveBeenCalled();
  });

  it("keeps Third-party API card free of login/install actions", async () => {
    await renderSettings();
    const thirdParty = mocks.cards.get("third-party");
    expect(thirdParty).toBeDefined();
    expect(thirdParty?.onLogin).toBeUndefined();
    expect(thirdParty?.onInstall).toBeUndefined();
    expect(thirdParty?.onLogout).toBeUndefined();
    expect(thirdParty?.description).toMatch(/OpenAI-compatible/i);
  });

  it("consumes rejected Codex actions", async () => {
    install.mockRejectedValueOnce(new Error("install failed"));
    ensureInstalledAndStartLogin.mockRejectedValueOnce(
      new Error("login failed"),
    );
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
