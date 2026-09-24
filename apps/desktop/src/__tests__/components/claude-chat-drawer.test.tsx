import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeChatDrawer } from "@/components/claude-chat/claude-chat-drawer";
import { AGENT_SWITCH_FLASH_EVENT } from "@/lib/reply-mode";
import {
  resetChatLayoutStoreForTests,
  useChatLayoutStore,
} from "@/stores/chat-layout-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";

vi.mock("@/components/approvals/approval-dialog", () => ({
  ApprovalDialog: () => null,
}));

vi.mock("@/components/subagents/subagent-panel", () => ({
  SubagentPanel: () => null,
}));

vi.mock("@/components/claude-chat/chat-messages", () => ({
  ChatMessages: () => <div data-testid="chat-messages" />,
}));

vi.mock("@/components/claude-chat/chat-composer", () => ({
  ChatComposer: ({ agentFlashId }: { agentFlashId?: string | null }) => (
    <div
      data-testid="chat-composer"
      data-agent-flash={agentFlashId ?? undefined}
      className={agentFlashId ? "lp-agent-switch-flash" : undefined}
    />
  ),
}));

vi.mock("@/components/claude-chat/chat-tab-bar", () => ({
  ChatTabBar: ({ leading }: { leading?: ReactNode }) => (
    <div data-testid="chat-tab-bar">{leading}</div>
  ),
}));

describe("ClaudeChatDrawer", () => {
  let container: HTMLDivElement;
  let root: Root;
  let chatSnapshot: ReturnType<typeof useClaudeChatStore.getState>;

  beforeEach(() => {
    chatSnapshot = useClaudeChatStore.getState();
    resetChatLayoutStoreForTests();
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
    resetChatLayoutStoreForTests();
    useClaudeChatStore.setState(chatSnapshot, true);
  });

  it("docks as a pane instead of a fullscreen overlay", async () => {
    await act(async () => root.render(<ClaudeChatDrawer />));

    const pane = container.querySelector('[data-testid="chat-pane"]');
    expect(pane).not.toBeNull();
    expect(pane?.className).toContain("h-full");
    expect(pane?.className).toContain("max-h-full");
    expect(pane?.className).toContain("overflow-hidden");
    expect(pane?.className).toContain("minmax(0,1fr)");
    const thread = container.querySelector('[data-testid="chat-thread"]');
    const composer = container.querySelector(
      '[data-testid="chat-composer-slot"]',
    );
    expect(thread?.className).toContain("min-h-0");
    expect(thread?.className).toContain("flex-1");
    expect(composer?.className).toContain("shrink-0");
    expect(thread?.compareDocumentPosition(composer as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(container.querySelector('[aria-label="Fullscreen"]')).toBeNull();
    expect(
      container.querySelector('[aria-label="Open AI Assistant"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="chat-token-meter"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="chat-reasoning-slider"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="chat-token-meter-trigger"]'),
    ).toBeNull();
  });

  it("flashes the composer border token, not the message thread", async () => {
    await act(async () => root.render(<ClaudeChatDrawer />));

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(AGENT_SWITCH_FLASH_EVENT, {
          detail: { agentId: "de-ai" },
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    const thread = container.querySelector('[data-testid="chat-thread"]');
    const composer = container.querySelector('[data-testid="chat-composer"]');
    expect(thread?.className).not.toContain("lp-agent-switch-flash");
    expect(composer?.className).toContain("lp-agent-switch-flash");
    expect(composer?.getAttribute("data-agent-flash")).toBe("de-ai");
  });

  it("hides the workspace chat column without covering the editor", async () => {
    await act(async () => root.render(<ClaudeChatDrawer />));

    const hide = container.querySelector('[aria-label="Hide chat"]');
    expect(hide).toBeInstanceOf(HTMLButtonElement);
    await act(async () => (hide as HTMLButtonElement).click());

    expect(useChatLayoutStore.getState().visible).toBe(false);
  });

  it("exposes retry and details for a failed turn", async () => {
    const sendPrompt = vi.fn();
    const detail = `provider failed\n${"x".repeat(180)}`;
    useClaudeChatStore.setState({
      error: detail,
      isStreaming: false,
      messages: [
        {
          type: "user",
          message: { content: "please retry" },
        },
      ] as never,
      sendPrompt,
    });

    await act(async () => root.render(<ClaudeChatDrawer />));

    const card = container.querySelector('[data-testid="chat-error-card"]');
    expect(card).not.toBeNull();
    const retry = Array.from(card?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Retry",
    );
    const details = Array.from(card?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Details",
    );
    expect(retry).toBeInstanceOf(HTMLButtonElement);
    expect(details).toBeInstanceOf(HTMLButtonElement);
    expect(retry?.hasAttribute("disabled")).toBe(false);

    await act(async () => (details as HTMLButtonElement).click());
    expect(card?.textContent).toContain(detail);

    await act(async () => (retry as HTMLButtonElement).click());
    expect(sendPrompt).toHaveBeenCalledWith("please retry", undefined, {
      reuseTrailingUserMessage: true,
    });
  });
});
