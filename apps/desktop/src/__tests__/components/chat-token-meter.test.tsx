import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatTokenMeter } from "@/components/claude-chat/chat-token-meter";
import { type TabState, useClaudeChatStore } from "@/stores/claude-chat-store";

describe("ChatTokenMeter", () => {
  let container: HTMLDivElement;
  let root: Root;
  let snapshot: ReturnType<typeof useClaudeChatStore.getState>;

  beforeEach(() => {
    snapshot = useClaudeChatStore.getState();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const usage = {
      inputTokens: 3588,
      outputTokens: 100,
      cacheReadTokens: 20992,
      cacheCreationTokens: 640,
    };
    const messages = [
      {
        type: "result" as const,
        usage: {
          input_tokens: 3588,
          output_tokens: 100,
          cache_read_input_tokens: 20992,
        },
      },
    ];
    useClaudeChatStore.setState((state) => ({
      selectedModel: "gpt-6-astra",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      lastTurnUsage: usage,
      messages,
      tabs: state.tabs.map((tab) =>
        tab.id === state.activeTabId
          ? { ...tab, lastTurnUsage: usage, messages }
          : tab,
      ),
    }));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.querySelector('[data-testid="chat-token-meter"]')?.remove();
    useClaudeChatStore.setState(snapshot, true);
  });

  it("shows a compact context circle and hides the breakdown until clicked", async () => {
    await act(async () => root.render(<ChatTokenMeter />));

    const trigger = container.querySelector(
      '[data-testid="chat-token-meter-trigger"]',
    );
    expect(trigger).toBeInstanceOf(HTMLButtonElement);
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(trigger?.getAttribute("aria-label")).toMatch(/Context/i);
    expect(
      trigger?.querySelector('[data-testid="chat-token-meter-ring"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="chat-token-meter"]'),
    ).toBeNull();
  });

  it("opens the token breakdown when the circle is clicked", async () => {
    await act(async () => root.render(<ChatTokenMeter />));

    const trigger = container.querySelector(
      '[data-testid="chat-token-meter-trigger"]',
    );
    if (!(trigger instanceof HTMLButtonElement)) {
      throw new Error("Context circle missing");
    }

    await act(async () => trigger.click());

    const meter = document.querySelector('[data-testid="chat-token-meter"]');
    expect(meter).not.toBeNull();
    expect(meter?.parentElement).toBe(document.body);
    expect(meter?.className.split(/\s+/)).toContain("fixed");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(meter?.textContent).toContain("Context");
    expect(meter?.textContent).toContain("gpt-6-astra");
    expect(meter?.textContent).toContain("Cache read");
    expect(meter?.textContent).toContain("20,992");
    expect(meter?.textContent).toContain("Cache write");
    expect(meter?.textContent).toContain("Input tokens");
    expect(meter?.textContent).toContain("3,588");
    expect(meter?.textContent).toContain("Output tokens");
    expect(meter?.textContent).toContain("Used");
    expect(meter?.textContent).toContain("24,580");
  });

  it("reads usage from the active conversation, not leftover store totals", async () => {
    const emptyTab: TabState = {
      ...useClaudeChatStore.getState().tabs[0],
      id: "tab-new",
      title: "New Chat",
      messages: [],
      lastTurnUsage: null,
      isStreaming: false,
      sessionId: null,
      sessionRef: null,
    };
    useClaudeChatStore.setState((state) => ({
      tabs: [
        ...state.tabs,
        {
          ...emptyTab,
          lastTurnUsage: {
            inputTokens: 99999,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        },
      ],
      activeTabId: "tab-new",
      messages: [],
      lastTurnUsage: {
        inputTokens: 99999,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    }));

    await act(async () => root.render(<ChatTokenMeter />));
    const trigger = container.querySelector(
      '[data-testid="chat-token-meter-trigger"]',
    );
    expect(trigger?.getAttribute("aria-label")).toBe("Context 0%");
  });
});
