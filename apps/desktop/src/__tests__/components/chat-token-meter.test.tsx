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
    const ring = trigger?.querySelector(
      '[data-testid="chat-token-meter-ring"]',
    );
    expect(ring).not.toBeNull();
    expect(ring?.getAttribute("data-state")).toBe("used");
    expect(ring?.querySelectorAll("circle")).toHaveLength(2);
    expect(ring?.querySelector(".animate-spin")).toBeNull();
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
    expect(meter?.textContent).toContain("640");
    expect(meter?.textContent).toContain("Input tokens");
    expect(meter?.textContent).toContain("3,588");
    expect(meter?.textContent).toContain("Output tokens");
    expect(meter?.textContent).toContain("Used");
    expect(meter?.textContent).toContain("25,320");
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
    const ring = trigger?.querySelector(
      '[data-testid="chat-token-meter-ring"]',
    );
    expect(ring?.getAttribute("data-state")).toBe("empty");
    expect(ring?.querySelectorAll("circle")).toHaveLength(1);
    expect(trigger?.querySelector(".animate-spin")).toBeNull();
  });

  it("keeps the previous turn visible while the next turn is thinking", async () => {
    const usage = {
      inputTokens: 12_000,
      outputTokens: 400,
      cacheReadTokens: 8_000,
      cacheCreationTokens: 0,
    };
    useClaudeChatStore.setState((state) => ({
      selectedModel: "gpt-6-luna",
      lastTurnUsage: usage,
      tabs: state.tabs.map((tab) =>
        tab.id === state.activeTabId
          ? {
              ...tab,
              runtimeModel: "gpt-6-luna",
              contextWindowTokens: 272_000,
              isStreaming: true,
              usageFromPreviousTurn: true,
              lastTurnUsage: usage,
              messages: [
                {
                  type: "assistant",
                  message: {
                    content: [{ type: "text", text: "done" }],
                  },
                },
                {
                  type: "user",
                  message: {
                    content: [{ type: "text", text: "next" }],
                  },
                },
              ],
            }
          : tab,
      ),
    }));

    await act(async () => root.render(<ChatTokenMeter />));
    const trigger = container.querySelector(
      '[data-testid="chat-token-meter-trigger"]',
    );
    expect(trigger?.getAttribute("data-usage")).toBe("previous");
    expect(trigger?.className).toContain("opacity-70");
    expect(trigger?.getAttribute("aria-label")).toBe("Context 8%");
    const ring = trigger?.querySelector(
      '[data-testid="chat-token-meter-ring"]',
    );
    expect(ring?.getAttribute("data-state")).toBe("used");

    if (!(trigger instanceof HTMLButtonElement)) {
      throw new Error("Context circle missing");
    }
    await act(async () => trigger.click());
    const meter = document.querySelector('[data-testid="chat-token-meter"]');
    expect(meter?.textContent).toContain("Previous turn");
    expect(meter?.textContent).toContain("20,400");
    expect(meter?.textContent).not.toContain("Waiting for usage");
  });

  it("clears the ring when the model changes and uses the new window", async () => {
    const activeTabId = useClaudeChatStore.getState().activeTabId;
    useClaudeChatStore.setState((state) => ({
      selectedModel: "gpt-6-luna",
      tabs: state.tabs.map((tab) =>
        tab.id === activeTabId
          ? {
              ...tab,
              runtimeModel: "gpt-6-luna",
              contextWindowTokens: 272_000,
              isStreaming: false,
              lastTurnUsage: {
                inputTokens: 180_000,
                outputTokens: 2_000,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
              },
              messages: [
                {
                  type: "assistant",
                  message: {
                    usage: {
                      input_tokens: 180_000,
                      output_tokens: 2_000,
                    },
                  },
                },
              ],
            }
          : tab,
      ),
    }));
    expect(
      useClaudeChatStore.getState().updateTabRuntimeSelection(activeTabId, {
        runtimeModel: "kimi-k2.5",
        reasoningEffort: null,
        agentId: null,
      }),
    ).toBe("changed");

    await act(async () => root.render(<ChatTokenMeter />));
    const trigger = container.querySelector(
      '[data-testid="chat-token-meter-trigger"]',
    );
    expect(trigger?.getAttribute("aria-label")).toBe("Context 0%");
    expect(trigger?.getAttribute("data-usage")).toBe("current");
    const ring = trigger?.querySelector(
      '[data-testid="chat-token-meter-ring"]',
    );
    expect(ring?.getAttribute("data-state")).toBe("empty");
    if (!(trigger instanceof HTMLButtonElement)) {
      throw new Error("Context circle missing");
    }
    await act(async () => trigger.click());
    const meter = document.querySelector('[data-testid="chat-token-meter"]');
    expect(meter?.textContent).toContain("kimi-k2.5");
    expect(meter?.textContent).toContain("262,144");
    expect(meter?.textContent).toContain("Waiting for usage");
    expect(meter?.textContent).not.toContain("182,000");
    expect(meter?.textContent).not.toContain("180,000");
  });
});
