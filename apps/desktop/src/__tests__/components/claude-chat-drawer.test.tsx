import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeChatDrawer } from "@/components/claude-chat/claude-chat-drawer";
import {
  resetChatLayoutStoreForTests,
  useChatLayoutStore,
} from "@/stores/chat-layout-store";

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
  ChatComposer: () => <div data-testid="chat-composer" />,
}));

vi.mock("@/components/claude-chat/chat-tab-bar", () => ({
  ChatTabBar: ({ leading }: { leading?: ReactNode }) => (
    <div data-testid="chat-tab-bar">{leading}</div>
  ),
}));

describe("ClaudeChatDrawer", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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
  });

  it("docks as a pane instead of a fullscreen overlay", async () => {
    await act(async () => root.render(<ClaudeChatDrawer />));

    const pane = container.querySelector('[data-testid="chat-pane"]');
    expect(pane).not.toBeNull();
    expect(pane?.className).toContain("h-full");
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

  it("hides the workspace chat column without covering the editor", async () => {
    await act(async () => root.render(<ClaudeChatDrawer />));

    const hide = container.querySelector('[aria-label="Hide chat"]');
    expect(hide).toBeInstanceOf(HTMLButtonElement);
    await act(async () => (hide as HTMLButtonElement).click());

    expect(useChatLayoutStore.getState().visible).toBe(false);
  });
});
