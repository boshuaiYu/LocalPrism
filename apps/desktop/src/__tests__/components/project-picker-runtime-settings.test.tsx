import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPicker } from "@/components/project-picker";
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
  getVersion: vi.fn().mockResolvedValue("1.0.8"),
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

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
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
    expect(
      container.querySelector('[data-testid="language-switch"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="check-for-updates"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("Getting Started");

    await act(async () => findButton(container, "Settings").click());

    expect(container.textContent).toContain("Providers");
    expect(container.textContent).toContain(
      "Engine on · 1 connected · Model set",
    );
    expect(container.textContent).not.toContain("0/2 ready");
    expect(container.textContent).not.toContain("1/2 ready");
    expect(
      container.querySelector('[data-testid="runtime-settings"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Environment");
    expect(container.textContent).toContain("Python / Skills");
    expect(container.textContent).not.toContain("AI Runtimes");
    expect(checkClaudeStatus).not.toHaveBeenCalled();
  });
});
