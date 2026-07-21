import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeCard } from "@/components/runtime/runtime-card";
import type {
  CodexSetupFlowState,
  RuntimeAccount,
  RuntimeLoginState,
} from "@/runtime/types";

function account(overrides: Partial<RuntimeAccount> = {}): RuntimeAccount {
  return {
    runtime: "codex",
    installed: true,
    authenticated: false,
    version: "0.135.0",
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

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

async function changeInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("RuntimeCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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

  async function renderCard(
    options: {
      account?: RuntimeAccount;
      login?: RuntimeLoginState | null;
      loading?: boolean;
      installInFlight?: boolean;
      setupFlow?: CodexSetupFlowState | null;
      onInstall?: () => Promise<unknown>;
      onLogin?: (
        mode: "browser" | "device-code" | "api-key",
        apiKey?: string,
      ) => Promise<void>;
      onCancelLogin?: () => Promise<void>;
      onLogout?: () => Promise<void>;
      onOpenExternal?: (url: string) => Promise<void>;
    } = {},
  ) {
    await act(async () => {
      root.render(
        <RuntimeCard
          title="Codex"
          description="OpenAI Codex runtime"
          account={options.account ?? account()}
          login={options.login}
          loading={options.loading}
          installInFlight={options.installInFlight}
          setupFlow={options.setupFlow}
          onInstall={options.onInstall}
          onLogin={options.onLogin}
          onCancelLogin={options.onCancelLogin}
          onLogout={options.onLogout}
          onOpenExternal={options.onOpenExternal}
        />,
      );
    });
  }

  it("shows Continue in browser when Codex is not installed", async () => {
    const onLogin = vi.fn().mockResolvedValue(undefined);
    await renderCard({
      account: account({ installed: false, version: null }),
      onInstall: vi.fn(),
      onLogin,
    });
    expect(findButton(container, "Continue in browser")).toBeTruthy();
    expect(findButton(container, "Install only")).toBeTruthy();
    await act(async () => findButton(container, "Continue in browser").click());
    expect(onLogin).toHaveBeenCalledWith("browser");
  });

  it("renders setup flow steps while installing/logging in", async () => {
    await renderCard({
      account: account({ installed: false, version: null }),
      installInFlight: true,
      setupFlow: {
        phase: "installing",
        installSteps: [
          { id: "downloading", label: "Downloading Codex", status: "complete" },
          { id: "installing", label: "Installing CLI", status: "active" },
          {
            id: "verifying",
            label: "Verifying installation",
            status: "pending",
          },
          { id: "complete", label: "Codex ready", status: "pending" },
        ],
        loginSteps: [],
        installLogs: ["npm install -g @openai/codex"],
        error: null,
        autoOpenBrowser: false,
      },
      onInstall: vi.fn(),
      onLogin: vi.fn(),
    });
    expect(container.textContent).toContain("Downloading Codex");
    expect(container.textContent).toContain("Installing CLI");
  });

  it("keeps Install only clickable after setupFlow error", async () => {
    const onInstall = vi.fn().mockResolvedValue(true);
    await renderCard({
      account: account({ installed: false, version: null }),
      installInFlight: false,
      setupFlow: {
        phase: "error",
        installSteps: [
          { id: "downloading", label: "Downloading Codex", status: "error" },
        ],
        loginSteps: [],
        installLogs: [],
        error: "Codex installation failed",
        autoOpenBrowser: false,
      },
      onInstall,
      onLogin: vi.fn(),
    });

    const installOnly = findButton(container, "Install only");
    expect(installOnly.disabled).toBe(false);
    await act(async () => installOnly.click());
    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  it("does not treat background loading as Installing without installInFlight", async () => {
    await renderCard({
      account: account({ installed: false, version: null }),
      loading: true,
      onInstall: vi.fn().mockResolvedValue(true),
    });

    expect(container.textContent).toContain("Working...");
    expect(container.textContent).not.toContain("Installing...");
    expect(container.textContent).not.toContain("Checking Codex");
    expect(findButton(container, "Install only").disabled).toBe(true);
  });

  it("shows Installing / Checking Codex only while installInFlight", async () => {
    await renderCard({
      account: account({ installed: false, version: null }),
      loading: true,
      installInFlight: true,
      onInstall: vi.fn().mockResolvedValue(true),
    });

    expect(container.textContent).toContain("Installing...");
    expect(container.textContent).toContain("Checking Codex");
    expect(container.textContent).not.toContain("Working...");
  });

  it("shows installation, authenticated metadata, and separate account errors", async () => {
    const onInstall = vi.fn().mockResolvedValue(true);
    await renderCard({
      account: account({
        installed: false,
        version: null,
        error: "status unavailable",
      }),
      onInstall,
    });

    expect(container.textContent).toContain("Account error");
    expect(container.textContent).toContain("status unavailable");
    await act(async () => findButton(container, "Install only").click());
    expect(onInstall).toHaveBeenCalledTimes(1);

    const onLogout = vi.fn().mockResolvedValue(undefined);
    await renderCard({
      account: account({
        authenticated: true,
        accountLabel: "person@example.com",
        authMode: "chatgpt",
      }),
      onLogout,
    });
    expect(container.textContent).toContain("0.135.0");
    expect(container.textContent).toContain("person@example.com");
    expect(container.textContent).toContain("chatgpt");
    await act(async () => findButton(container, "Log out").click());
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("clears a typed API key before starting browser or device-code login", async () => {
    const onLogin = vi.fn().mockResolvedValue(undefined);
    await renderCard({ onLogin });
    const input = container.querySelector(
      'input[aria-label="Codex API key"]',
    ) as HTMLInputElement;

    await changeInput(input, "browser-secret");
    await act(async () => findButton(container, "Continue in browser").click());
    expect(input.value).toBe("");

    await changeInput(input, "device-secret");
    await act(async () => findButton(container, "Use device code").click());
    expect(input.value).toBe("");

    expect(onLogin).toHaveBeenNthCalledWith(1, "browser");
    expect(onLogin).toHaveBeenNthCalledWith(2, "device-code");
  });

  it("does not restore an API key after waiting login returns to idle", async () => {
    const onLogin = vi.fn().mockResolvedValue(undefined);
    await renderCard({ onLogin });
    const input = container.querySelector(
      'input[aria-label="Codex API key"]',
    ) as HTMLInputElement;
    await changeInput(input, "waiting-secret");

    await renderCard({
      login: {
        mode: "browser",
        status: "waiting",
        loginId: "login-waiting",
        authUrl: "https://auth.example/browser",
      },
      onCancelLogin: vi.fn().mockResolvedValue(undefined),
    });
    await renderCard({ onLogin });

    const idleInput = container.querySelector(
      'input[aria-label="Codex API key"]',
    ) as HTMLInputElement;
    expect(idleInput.value).toBe("");
    expect(container.textContent).not.toContain("waiting-secret");
  });

  it("does not restore an API key after authenticated logout returns to idle", async () => {
    const onLogin = vi.fn().mockResolvedValue(undefined);
    const onLogout = vi.fn().mockResolvedValue(undefined);
    await renderCard({ onLogin });
    const input = container.querySelector(
      'input[aria-label="Codex API key"]',
    ) as HTMLInputElement;
    await changeInput(input, "logout-secret");

    await renderCard({
      account: account({ authenticated: true }),
      onLogout,
    });
    await act(async () => findButton(container, "Log out").click());
    await renderCard({ onLogin });

    const idleInput = container.querySelector(
      'input[aria-label="Codex API key"]',
    ) as HTMLInputElement;
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(idleInput.value).toBe("");
    expect(container.textContent).not.toContain("logout-secret");
  });

  it("does not restore an API key after the runtime becomes uninstalled", async () => {
    const onLogin = vi.fn().mockResolvedValue(undefined);
    await renderCard({ onLogin });
    const input = container.querySelector(
      'input[aria-label="Codex API key"]',
    ) as HTMLInputElement;
    await changeInput(input, "uninstalled-secret");

    await renderCard({
      account: account({ installed: false, version: null }),
      onInstall: vi.fn().mockResolvedValue(true),
    });
    await renderCard({ onLogin });

    const idleInput = container.querySelector(
      'input[aria-label="Codex API key"]',
    ) as HTMLInputElement;
    expect(idleInput.value).toBe("");
    expect(container.textContent).not.toContain("uninstalled-secret");
  });

  it.each([
    "resolved",
    "rejected",
  ])("keeps the API key local and clears it after a %s login", async (outcome) => {
    const onLogin =
      outcome === "resolved"
        ? vi.fn().mockResolvedValue(undefined)
        : vi.fn().mockRejectedValue(new Error("login failed"));
    await renderCard({ onLogin });
    const input = container.querySelector('input[aria-label="Codex API key"]');
    expect(input).toBeInstanceOf(HTMLInputElement);
    const apiKeyInput = input as HTMLInputElement;
    expect(apiKeyInput.type).toBe("password");
    expect(apiKeyInput.autocomplete).toBe("off");

    await changeInput(apiKeyInput, "  sk-secret  ");
    await act(async () => {
      findButton(container, "Use API key").click();
      await Promise.resolve();
    });

    expect(onLogin).toHaveBeenCalledWith("api-key", "sk-secret");
    expect(apiKeyInput.value).toBe("");
    expect(container.textContent).not.toContain("sk-secret");
  });

  it("shows browser waiting details and supports reopening and cancellation", async () => {
    const onOpenExternal = vi.fn().mockResolvedValue(undefined);
    const onCancelLogin = vi.fn().mockResolvedValue(undefined);
    await renderCard({
      login: {
        mode: "browser",
        status: "waiting",
        loginId: "login-1",
        authUrl: "https://auth.example/browser",
      },
      onOpenExternal,
      onCancelLogin,
      loading: true,
    });

    expect(container.textContent).toContain("https://auth.example/browser");
    expect(container.textContent).toContain("Working");
    expect(findButton(container, "Open authorization page").disabled).toBe(
      true,
    );
    expect(findButton(container, "Cancel").disabled).toBe(true);

    await renderCard({
      login: {
        mode: "browser",
        status: "waiting",
        loginId: "login-1",
        authUrl: "https://auth.example/browser",
      },
      onOpenExternal,
      onCancelLogin,
    });
    await act(async () =>
      findButton(container, "Open authorization page").click(),
    );
    await act(async () => findButton(container, "Cancel").click());
    expect(onOpenExternal).toHaveBeenCalledWith("https://auth.example/browser");
    expect(onCancelLogin).toHaveBeenCalledTimes(1);
  });

  it("shows device verification data and supports opening and cancellation", async () => {
    const onOpenExternal = vi.fn().mockResolvedValue(undefined);
    const onCancelLogin = vi.fn().mockResolvedValue(undefined);
    await renderCard({
      account: account({ error: "account status failed" }),
      login: {
        mode: "device-code",
        status: "waiting",
        loginId: "login-2",
        verificationUrl: "https://auth.example/device",
        userCode: "ABCD-EFGH",
      },
      onOpenExternal,
      onCancelLogin,
    });
    expect(container.textContent).toContain("https://auth.example/device");
    expect(container.textContent).toContain("ABCD-EFGH");
    expect(container.textContent).toContain("Account error");
    await act(async () =>
      findButton(container, "Open verification page").click(),
    );
    await act(async () => findButton(container, "Cancel").click());
    expect(onOpenExternal).toHaveBeenCalledWith("https://auth.example/device");
    expect(onCancelLogin).toHaveBeenCalledTimes(1);
  });

  it("requires cancelling a failed live login before showing retry controls", async () => {
    const onCancelLogin = vi.fn().mockResolvedValue(undefined);
    await renderCard({
      account: account({ error: "account status failed" }),
      login: {
        mode: "browser",
        status: "error",
        loginId: "login-3",
        message: "login rejected",
      },
      onCancelLogin,
      loading: true,
    });
    expect(container.textContent).toContain("Account error");
    expect(container.textContent).toContain("account status failed");
    expect(container.textContent).toContain("Login error");
    expect(container.textContent).toContain("login rejected");
    expect(findButton(container, "Cancel").disabled).toBe(true);
    expect(container.querySelector('input[aria-label="Codex API key"]')).toBe(
      null,
    );
    expect(container.textContent).not.toContain("Continue in browser");
    expect(container.textContent).not.toContain("Use device code");
    expect(container.textContent).not.toContain("Use API key");

    await renderCard({
      account: account({ error: "account status failed" }),
      login: {
        mode: "browser",
        status: "error",
        loginId: "login-3",
        message: "login rejected",
      },
      onCancelLogin,
    });
    await act(async () => findButton(container, "Cancel").click());
    expect(onCancelLogin).toHaveBeenCalledTimes(1);

    await renderCard({ onLogin: vi.fn().mockResolvedValue(undefined) });
    expect(container.textContent).toContain("Continue in browser");
    expect(
      container.querySelector('input[aria-label="Codex API key"]'),
    ).toBeInstanceOf(HTMLInputElement);
  });
});
