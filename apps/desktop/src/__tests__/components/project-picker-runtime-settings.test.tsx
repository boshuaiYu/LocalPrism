import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPicker } from "@/components/project-picker";
import { resetUpdateStoreForTests } from "@/stores/update-store";
import type { RuntimeAccount, RuntimeKind } from "@/runtime/types";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import {
  resetProviderStoreForTests,
  useProviderStore,
} from "@/stores/provider-store";
import {
  resetRuntimeStoreForTests,
  useRuntimeStore,
} from "@/stores/runtime-store";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("1.9.0"),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

vi.mock("@/components/runtime/runtime-settings", () => ({
  RuntimeSettings: () => (
    <div data-testid="runtime-settings">Runtime settings content</div>
  ),
}));

vi.mock("@/components/homepage-environment-status", () => ({
  HomepageEnvironmentStatus: () => (
    <div data-testid="homepage-environment">Environment</div>
  ),
}));

function account(runtime: RuntimeKind, authenticated: boolean): RuntimeAccount {
  return {
    runtime,
    installed: true,
    authenticated,
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
  };
}

describe("ProjectPicker runtime settings", () => {
  let container: HTMLDivElement;
  let root: Root;
  let checkClaudeStatus =
    vi.fn<ReturnType<typeof useClaudeSetupStore.getState>["checkStatus"]>();

  beforeEach(() => {
    resetRuntimeStoreForTests();
    resetProviderStoreForTests();
    useRuntimeStore.setState({
      accounts: {
        claude: account("claude", false),
        codex: account("codex", false),
      },
    });
    useProviderStore.setState({
      engineInstalled: true,
      cards: [
        {
          id: "siliconflow",
          kind: "third-party",
          name: "SiliconFlow",
          authenticated: true,
          isActive: true,
          accountLabel: "Qwen/Qwen2.5-7B-Instruct",
        },
      ],
      models: [
        {
          id: "Qwen/Qwen2.5-7B-Instruct",
          displayName: "Qwen",
          reasoningEfforts: ["medium"],
          isDefault: true,
        },
      ],
    });
    checkClaudeStatus = vi
      .fn<ReturnType<typeof useClaudeSetupStore.getState>["checkStatus"]>()
      .mockResolvedValue(undefined);
    useClaudeSetupStore.setState({ checkStatus: checkClaudeStatus });
    resetUpdateStoreForTests();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [],
      })),
    );
    vi.mocked(check).mockReset();
    vi.mocked(check).mockResolvedValue(null);
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "list_default_projects") return [];
      if (command === "list_openai_compatible_credentials") return [];
      if (command === "check_claude_status") {
        return {
          installed: true,
          authenticated: true,
          binary_path: "claude",
          version: "1.0.0",
          provider_kind: "claude-code",
          account_email: null,
          provider_model: null,
          provider_base_url: null,
          claude_provider_configured: false,
          missing_git: false,
        };
      }
      return undefined;
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
    resetProviderStoreForTests();
    resetUpdateStoreForTests();
    vi.unstubAllGlobals();
  });

  it("shows provider readiness separately from legacy runtime accounts", async () => {
    await act(async () => {
      root.render(<ProjectPicker />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("LocalPrism");
    expect(container.textContent).toContain(
      "AI-powered academic writing workspace",
    );
    expect(container.textContent).toContain("New Project");
    expect(container.textContent).toContain("Open Folder");
    const statusBar = container.querySelector('[data-testid="app-status-bar"]');
    expect(
      statusBar?.querySelector('[data-testid="language-switch"]'),
    ).not.toBeNull();
    expect(
      statusBar?.querySelector('[data-testid="check-for-updates"]'),
    ).not.toBeNull();
    expect(
      statusBar?.querySelector('[data-testid="beta-channel-toggle"]'),
    ).not.toBeNull();
    expect(
      container
        .querySelector("[data-testid='app-chrome-header']")
        ?.querySelector('[data-testid="language-switch"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain("Getting Started");
    const header = container.querySelector("[data-testid='app-chrome-header']");
    expect(header?.textContent).not.toContain("Settings");
    expect(
      container.querySelector('[data-testid="runtime-settings"]'),
    ).toBeNull();
    expect(checkClaudeStatus).not.toHaveBeenCalled();
  });

  it("keeps version, Beta, and the refresh check in the bottom bar", async () => {
    const download = vi.fn();
    vi.mocked(check).mockResolvedValue({
      version: "1.9.1-1",
      body: "beta",
      currentVersion: "1.9.0",
      download,
      install: vi.fn(),
      close: vi.fn(async () => undefined),
    } as never);

    await act(async () => {
      root.render(<ProjectPicker />);
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    const header = container.querySelector("[data-testid='app-chrome-header']");
    expect(header?.textContent).not.toContain("v1.9.0");
    expect(header?.querySelector("[data-testid='language-switch']")).toBeNull();
    expect(
      header?.querySelector("[data-testid='check-for-updates']"),
    ).toBeNull();
    expect(header?.textContent).not.toContain("Settings");
    expect(container.querySelector("[data-testid='update-prompt']")).toBeNull();
    expect(download).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("1.9.1-1");

    const bar = container.querySelector("[data-testid='app-status-bar']");
    expect(bar?.textContent).toContain("v1.9.0");
    expect(
      bar?.querySelector("[data-testid='check-for-updates']"),
    ).toBeTruthy();
    const beta = bar?.querySelector("[data-testid='beta-channel-toggle']");
    expect(beta?.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      if (beta instanceof HTMLButtonElement) beta.click();
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(download).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='update-prompt']")).toBeNull();
    const flash = container.querySelector("[data-testid='update-flash']");
    expect(flash?.textContent).toContain("1.9.1-1");
    expect(flash?.className).toMatch(/lp-update-flash/);
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });
});
