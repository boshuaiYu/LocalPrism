import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners = new Map<string, (event: { payload: unknown }) => void>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (event: string, cb: (event: { payload: unknown }) => void) => {
      listeners.set(event, cb);
      return () => listeners.delete(event);
    },
  ),
}));

vi.mock("@/runtime/commands", () => ({
  runtimeInstall: vi.fn(),
  runtimeLoginStart: vi.fn(),
  runtimeLoginCancel: vi.fn(),
  runtimeLogout: vi.fn(),
  runtimeStatus: vi.fn(),
  runtimeListModels: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn().mockResolvedValue(undefined),
}));

import { open as shellOpen } from "@tauri-apps/plugin-shell";
import {
  runtimeInstall,
  runtimeLoginStart,
  runtimeStatus,
} from "@/runtime/commands";
import { useRuntimeStore } from "@/stores/runtime-store";

describe("Codex ensureInstalledAndStartLogin", () => {
  beforeEach(() => {
    listeners.clear();
    vi.clearAllMocks();
    useRuntimeStore.setState({
      accounts: {
        claude: useRuntimeStore.getState().accounts.claude,
        codex: {
          ...useRuntimeStore.getState().accounts.codex,
          installed: false,
          authenticated: false,
          error: null,
        },
      },
      login: {},
      installInFlight: {},
      loading: {},
      codexSetupFlow: useRuntimeStore.getState().idleCodexSetupFlow(),
    } as never);
  });

  it("installs then starts browser login and auto-opens authUrl", async () => {
    vi.mocked(runtimeInstall).mockImplementation(async () => {
      listeners.get("runtime-install-output")?.({
        payload: {
          runtime: "codex",
          stream: "status",
          line: "Downloading package",
        },
      });
      listeners.get("runtime-install-complete")?.({
        payload: { runtime: "codex", success: true },
      });
      return true;
    });
    vi.mocked(runtimeLoginStart).mockResolvedValue({
      type: "chatgpt",
      authUrl: "https://auth.example/codex",
      loginId: "login-1",
    });
    vi.mocked(runtimeStatus).mockResolvedValue({
      runtime: "codex",
      installed: true,
      authenticated: false,
      version: "0.144.0",
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
    });

    await useRuntimeStore
      .getState()
      .ensureInstalledAndStartLogin("codex", "browser");

    expect(runtimeInstall).toHaveBeenCalledWith("codex");
    expect(runtimeLoginStart).toHaveBeenCalledWith("codex", "browser");
    expect(shellOpen).toHaveBeenCalledWith("https://auth.example/codex");
    const flow = useRuntimeStore.getState().codexSetupFlow;
    expect(flow.phase).toBe("logging-in");
    expect(flow.loginSteps.find((s) => s.id === "waiting-auth")?.status).toBe(
      "active",
    );
    expect(useRuntimeStore.getState().login.codex).toMatchObject({
      mode: "browser",
      status: "waiting",
      authUrl: "https://auth.example/codex",
    });
  });

  it("skips install when already installed", async () => {
    useRuntimeStore.setState((state) => ({
      accounts: {
        ...state.accounts,
        codex: { ...state.accounts.codex, installed: true },
      },
    }));
    vi.mocked(runtimeLoginStart).mockResolvedValue({
      type: "chatgpt",
      authUrl: "https://auth.example/codex",
      loginId: "login-2",
    });

    await useRuntimeStore
      .getState()
      .ensureInstalledAndStartLogin("codex", "browser");

    expect(runtimeInstall).not.toHaveBeenCalled();
    expect(runtimeLoginStart).toHaveBeenCalledWith("codex", "browser");
  });

  it("stops with error phase when install fails", async () => {
    vi.mocked(runtimeInstall).mockResolvedValue(false);

    await useRuntimeStore
      .getState()
      .ensureInstalledAndStartLogin("codex", "browser");

    expect(runtimeLoginStart).not.toHaveBeenCalled();
    expect(useRuntimeStore.getState().codexSetupFlow.phase).toBe("error");
  });
});
