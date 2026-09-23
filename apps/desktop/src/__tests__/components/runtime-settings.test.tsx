import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getThirdPartyProviderCards } from "@/components/claude-setup";
import { RuntimeSettings } from "@/components/runtime/runtime-settings";
import { providerReadinessBadge } from "@/lib/provider-readiness";
import {
  resetProviderStoreForTests,
  useProviderStore,
} from "@/stores/provider-store";

vi.mock("@/stores/claude-setup-store", () => ({
  useClaudeSetupStore: (
    selector: (state: {
      install: () => Promise<void>;
      ensureEngine: () => Promise<void>;
      isInstalling: boolean;
    }) => unknown,
  ) =>
    selector({
      install: vi.fn(),
      ensureEngine: vi.fn(),
      isInstalling: false,
    }),
}));

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

  beforeEach(() => {
    resetProviderStoreForTests();
    useProviderStore.setState({
      cards: [
        {
          id: "claude-official",
          kind: "official-claude",
          name: "Claude Official",
          authenticated: false,
          isActive: false,
          accountLabel: null,
        },
        {
          id: "chatgpt-official",
          kind: "official-chatgpt",
          name: "ChatGPT Official",
          authenticated: false,
          isActive: false,
          accountLabel: null,
        },
      ],
      refresh: vi.fn(async () => undefined),
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
  });

  it("leads with API-key presets and keeps official browser login collapsed", async () => {
    await act(async () => {
      root.render(<RuntimeSettings />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Use an API key");
    expect(container.textContent).toContain("DeepSeek");
    expect(container.textContent).not.toContain("Kimi");
    expect(container.textContent).not.toContain("Cursor");
    expect(container.textContent).toMatch(/not required/i);
    expect(
      container.querySelector('input[placeholder="API key"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("Sign in to Claude Official");
    expect(container.textContent).not.toContain("Writing engine");

    const advancedToggle = container.querySelector(
      '[data-testid="provider-advanced"]',
    );
    expect(advancedToggle).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      if (advancedToggle instanceof HTMLButtonElement) advancedToggle.click();
    });

    expect(container.textContent).toContain("Kimi");
    expect(container.textContent).toContain("Cursor");
    expect(container.textContent).not.toContain("Sign in to Claude Official");

    const officialToggle = Array.from(
      container.querySelectorAll("button"),
    ).find((button) =>
      button.textContent?.includes("Official Claude / ChatGPT"),
    );
    expect(officialToggle).toBeTruthy();

    await act(async () => {
      officialToggle?.click();
    });

    expect(container.textContent).toContain("Sign in to Claude Official");
    expect(container.textContent).toContain("Sign in to ChatGPT Official");
  });

  it("hides the engine install banner once Claude Code CLI is present", async () => {
    useProviderStore.setState({ engineInstalled: true });

    await act(async () => {
      root.render(<RuntimeSettings />);
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("Install Claude Code CLI");
    expect(container.textContent).toContain("DeepSeek");
  });

  it("can hide the engine banner during homepage onboarding", async () => {
    await act(async () => {
      root.render(<RuntimeSettings showEngine={false} />);
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("Install Claude Code CLI");
    expect(container.textContent).toContain("Use an API key");
  });

  it("uses the same readiness text for an active API provider and the summary", async () => {
    useProviderStore.setState({
      engineInstalled: true,
      cards: [
        {
          id: "claude-official",
          kind: "official-claude",
          name: "Claude Official",
          authenticated: false,
          isActive: false,
          accountLabel: null,
        },
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

    await act(async () => {
      root.render(<RuntimeSettings />);
      await Promise.resolve();
    });

    const badge = providerReadinessBadge(useProviderStore.getState());
    expect(container.textContent).toContain("SiliconFlow");
    expect(container.textContent).toContain(
      "Qwen/Qwen2.5-7B-Instruct · Active",
    );
    expect(container.textContent).toContain(badge);
    expect(badge).toContain("1 connected");
    expect(container.textContent).not.toContain("0/2 ready");
  });

  it("can reuse a completed parent refresh without launching another one", async () => {
    const refresh = vi.fn(async () => undefined);
    useProviderStore.setState({ refresh });

    await act(async () => {
      root.render(<RuntimeSettings refreshOnMount={false} />);
      await Promise.resolve();
    });

    expect(refresh).not.toHaveBeenCalled();
  });
});
