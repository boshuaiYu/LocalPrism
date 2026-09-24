import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceAccountButton,
  workspaceAccountChipText,
  workspaceAccountVisibleLabel,
} from "@/components/claude-chat/workspace-account-button";
import {
  resetProviderStoreForTests,
  useProviderStore,
} from "@/stores/provider-store";

const mocks = vi.hoisted(() => ({
  runtimeSettingsProps: [] as Array<{ officialOpenDefault?: boolean }>,
}));

vi.mock("@/components/runtime/runtime-settings", () => ({
  RuntimeSettings: (props: { officialOpenDefault?: boolean }) => {
    mocks.runtimeSettingsProps.push(props);
    return <div data-testid="runtime-settings">Runtime settings</div>;
  },
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
}));

describe("WorkspaceAccountButton", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.runtimeSettingsProps.length = 0;
    resetProviderStoreForTests();
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

  it("opens in-workspace provider login without leaving the editor", async () => {
    useProviderStore.setState({
      cards: [
        {
          id: "chatgpt-official",
          kind: "official-chatgpt",
          name: "ChatGPT Official",
          authenticated: true,
          isActive: true,
          accountLabel: "writer@example.com",
        },
      ],
    });

    await act(async () => root.render(<WorkspaceAccountButton />));

    const button = container.querySelector("button");
    expect(button?.textContent).toContain("ChatGPT Official");
    expect(button?.textContent).toContain("writer@example.com");
    expect(button?.getAttribute("title")).toBe(
      "ChatGPT Official · writer@example.com",
    );
    expect(button?.className).toContain("min-w-[4.5rem]");
    expect(button?.querySelector("span")?.className).toContain("min-w-0");
    expect(button?.className).toContain("overflow-hidden");
    expect(button?.querySelector("span")?.className).toContain("truncate");
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => button?.click());

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.textContent).toMatch(/without leaving this project/i);
    expect(
      mocks.runtimeSettingsProps[mocks.runtimeSettingsProps.length - 1],
    ).toEqual({ officialOpenDefault: true });
  });

  it("keeps a provider and long model id in one truncating label", () => {
    expect(
      workspaceAccountChipText(
        "SiliconFlow",
        "Qwen/Qwen3.6-35B-A3B",
        "Signed in",
      ),
    ).toBe("SiliconFlow · Qwen/Qwen3.6-35B-A3B");
    expect(
      workspaceAccountChipText("SiliconFlow", "SiliconFlow", "Signed in"),
    ).toBe("SiliconFlow");
    expect(workspaceAccountChipText("SiliconFlow", "  ", "Signed in")).toBe(
      "SiliconFlow",
    );
    expect(workspaceAccountChipText("  ", "   ", "Signed in")).toBe(
      "Signed in",
    );
  });

  it("uses the provider name alone when the header is too narrow for the model", () => {
    expect(
      workspaceAccountVisibleLabel(
        "SiliconFlow",
        "Qwen/Qwen3.6-35B-A3B",
        "Signed in",
        "provider",
      ),
    ).toBe("SiliconFlow");
    expect(
      workspaceAccountVisibleLabel(
        "SiliconFlow",
        "Qwen/Qwen3.6-35B-A3B",
        "Signed in",
        "full",
      ),
    ).toBe("SiliconFlow · Qwen/Qwen3.6-35B-A3B");
  });

  it("does not repeat the provider in the tooltip when it is the only label", async () => {
    useProviderStore.setState({
      cards: [
        {
          id: "siliconflow",
          kind: "third-party",
          name: "SiliconFlow",
          authenticated: true,
          isActive: true,
          accountLabel: "SiliconFlow",
        },
      ],
    });

    await act(async () => root.render(<WorkspaceAccountButton />));

    const button = container.querySelector("button");
    expect(button?.textContent).toContain("SiliconFlow");
    expect(button?.getAttribute("title")).toBe("SiliconFlow");
    expect(button?.getAttribute("aria-label")).toBe("Account: SiliconFlow");
  });

  it("prompts sign-in when no account is active", async () => {
    await act(async () => root.render(<WorkspaceAccountButton />));

    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Sign in");
    expect(button?.textContent).toContain("Sign in");
  });
});
