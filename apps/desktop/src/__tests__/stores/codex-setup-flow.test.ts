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
import { runtimeInstall, runtimeLoginStart } from "@/runtime/commands";
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

  it("refuses Codex app-server install-and-login and points at ChatGPT Official", async () => {
    await useRuntimeStore
      .getState()
      .ensureInstalledAndStartLogin("codex", "browser");

    expect(runtimeInstall).not.toHaveBeenCalled();
    expect(runtimeLoginStart).not.toHaveBeenCalled();
    expect(shellOpen).not.toHaveBeenCalled();
    const flow = useRuntimeStore.getState().codexSetupFlow;
    expect(flow.phase).toBe("error");
    expect(flow.error).toMatch(/ChatGPT Official/);
  });

  it("still starts Claude login without installing Codex", async () => {
    vi.mocked(runtimeLoginStart).mockResolvedValue({
      type: "chatgpt",
      authUrl: "https://auth.example/claude",
      loginId: "login-claude",
    });

    await useRuntimeStore
      .getState()
      .ensureInstalledAndStartLogin("claude", "browser");

    expect(runtimeInstall).not.toHaveBeenCalled();
    expect(runtimeLoginStart).toHaveBeenCalledWith("claude", "browser");
  });
});
