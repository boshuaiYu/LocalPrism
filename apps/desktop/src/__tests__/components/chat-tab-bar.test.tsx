import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/claude-chat/session-selector", () => ({
  SessionSelector: () => <div data-testid="session-selector" />,
}));

vi.mock("@/components/claude-chat/workspace-account-button", async () => {
  const actual = await vi.importActual<
    typeof import("@/components/claude-chat/workspace-account-button")
  >("@/components/claude-chat/workspace-account-button");
  return {
    ...actual,
    WorkspaceAccountButton: ({
      density = "full",
    }: {
      density?: "full" | "provider" | "icon";
    }) => <div data-testid="workspace-account-button" data-density={density} />,
  };
});

import { LATEX_LEARN_PURPOSE } from "@/lib/latex-learn-tab";
import {
  accountHeaderChrome,
  ChatTabBar,
} from "@/components/claude-chat/chat-tab-bar";
import { chatTabStripPlan } from "@/lib/chat-tab-strip";
import { useApprovalStore } from "@/stores/approval-store";
import { type TabState, useClaudeChatStore } from "@/stores/claude-chat-store";
import {
  resetProviderStoreForTests,
  useProviderStore,
} from "@/stores/provider-store";
import { useSettingsStore } from "@/stores/settings-store";

if (typeof globalThis.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {}
  globalThis.PointerEvent =
    PointerEventPolyfill as unknown as typeof PointerEvent;
}

function makeTab(
  id: string,
  title: string,
  runtime: TabState["runtime"],
  isStreaming = false,
): TabState {
  const baseTab = useClaudeChatStore.getState().tabs[0];
  return {
    ...baseTab,
    id,
    title,
    projectPath: "C:/project",
    runtime,
    sessionRef: null,
    sessionId: null,
    messages: [],
    isStreaming,
    streamingStartedAt: isStreaming ? 1 : null,
    cancelledAttempts: [],
    activeAttemptId: isStreaming ? `${id}-attempt` : null,
  };
}

function userText(text: string): TabState["messages"][number] {
  return {
    type: "user",
    message: { content: [{ type: "text", text }] },
  };
}

function tabButton(container: HTMLElement, tabId: string): HTMLButtonElement {
  const button = container.querySelector(`button[data-tab-id="${tabId}"]`);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Tab button not found: ${tabId}`);
  }
  return button;
}

describe("ChatTabBar runtime badges", () => {
  let container: HTMLDivElement;
  let root: Root;
  let chatSnapshot: ReturnType<typeof useClaudeChatStore.getState>;
  let scrollIntoViewDescriptor: PropertyDescriptor | undefined;
  let canvasGetContext: typeof HTMLCanvasElement.prototype.getContext;

  beforeEach(() => {
    canvasGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => ({
      measureText: () => ({ width: 0 }),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    chatSnapshot = useClaudeChatStore.getState();
    useApprovalStore.getState().reset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView",
    );
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    HTMLCanvasElement.prototype.getContext = canvasGetContext;
    await act(async () => root.unmount());
    container.remove();
    useClaudeChatStore.setState(chatSnapshot, true);
    useApprovalStore.getState().reset();
    if (scrollIntoViewDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollIntoView",
        scrollIntoViewDescriptor,
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });

  async function renderTabs(tabs: TabState[], leading?: ReactNode) {
    const activeTab = tabs[0];
    useClaudeChatStore.setState({
      tabs,
      activeTabId: activeTab.id,
      activeProjectPath: activeTab.projectPath,
      messages: activeTab.messages,
      sessionId: activeTab.sessionId,
      isStreaming: activeTab.isStreaming,
      streamingStartedAt: activeTab.streamingStartedAt,
      error: activeTab.error,
      totalInputTokens: activeTab.totalInputTokens,
      totalOutputTokens: activeTab.totalOutputTokens,
    });
    await act(async () => {
      root.render(<ChatTabBar leading={leading} />);
      await document.fonts?.ready;
    });
  }

  it("clears caption buttons above the row instead of beside the label", async () => {
    await renderTabs([makeTab("tab-claude", "Hello", "claude")]);
    const band = container.querySelector("[data-testid='chat-titlebar-band']");
    const toolbar = container.querySelector("[data-testid='chat-tab-toolbar']");
    const cluster = container.querySelector(
      "[data-testid='chat-account-cluster']",
    );
    const tab = tabButton(container, "tab-claude");
    const scroller = container.querySelector(
      "[data-testid='chat-tab-scroller']",
    );
    expect(band?.className).toContain("--titlebar-height");
    expect(toolbar?.className ?? "").not.toContain("window-controls-inset");
    expect(scroller?.className.split(/\s+/)).toContain("flex-1");
    expect(scroller?.className.split(/\s+/)).toContain("overflow-x-auto");
    expect(scroller?.className.split(/\s+/)).toContain("overflow-y-hidden");
    expect(scroller?.className).not.toContain("overflow-y-auto");
    expect(toolbar?.className.split(/\s+/)).toContain("overflow-hidden");
    expect(toolbar?.className).not.toContain("overflow-y-auto");
    expect(cluster?.className.split(/\s+/)).toContain("w-max");
    expect(cluster?.className.split(/\s+/)).toContain("grow-0");
    expect(cluster?.className.split(/\s+/)).toContain("shrink-0");
    expect(cluster?.className.split(/\s+/)).not.toContain("flex-1");
    expect(
      container
        .querySelector("[data-testid='chat-account-chip']")
        ?.className.split(/\s+/),
    ).not.toContain("flex-1");
    expect(tab.className.split(/\s+/)).toContain("shrink-0");
    expect(tab.className.split(/\s+/)).not.toContain("min-w-0");
    expect(
      tab.querySelector("[data-testid='chat-tab-title']")?.textContent,
    ).toBe("Hello");
  });

  it("shows tab titles without runtime badges", async () => {
    await renderTabs([
      makeTab("tab-claude", "Literature review", "claude"),
      makeTab("tab-codex", "Run checks", "codex"),
    ]);

    const claudeTab = tabButton(container, "tab-claude");
    const codexTab = tabButton(container, "tab-codex");
    expect(claudeTab.getAttribute("aria-label")).toBe("Literature review");
    expect(codexTab.getAttribute("aria-label")).toBe("Run checks");
    expect(claudeTab.textContent).not.toContain("Claude");
    expect(codexTab.textContent).not.toContain("Codex");
    expect(
      container.querySelector('[data-testid="workspace-account-button"]'),
    ).not.toBeNull();
  });

  it("keeps the streaming indicator and close-button protections", async () => {
    await renderTabs([
      makeTab("tab-claude", "Streaming", "claude", true),
      makeTab("tab-codex", "Idle", "codex"),
    ]);

    const streamingTab = tabButton(container, "tab-claude");
    const idleTab = tabButton(container, "tab-codex");
    expect(streamingTab.querySelector(".animate-ping")).not.toBeNull();
    expect(
      streamingTab.querySelector('[role="button"][aria-label="Close tab"]'),
    ).toBeNull();

    const closeButton = idleTab.querySelector(
      '[role="button"][aria-label="Close tab"]',
    );
    expect(closeButton).toBeInstanceOf(HTMLSpanElement);
    await act(async () => (closeButton as HTMLSpanElement).click());

    expect(useClaudeChatStore.getState().tabs.map((tab) => tab.id)).toEqual([
      "tab-claude",
    ]);
    expect(useClaudeChatStore.getState().activeTabId).toBe("tab-claude");
  });

  it("can close a streaming tab that was opened under another account", async () => {
    useClaudeChatStore.setState({
      accountObserved: true,
      activeAccountKey: "account-b",
    });
    await renderTabs([
      {
        ...makeTab("tab-foreign", "Other account", "claude", true),
        openedUnderAccountKey: "account-a",
      },
      {
        ...makeTab("tab-current", "Current account", "claude", true),
        openedUnderAccountKey: "account-b",
      },
    ]);

    const foreignTab = tabButton(container, "tab-foreign");
    const currentTab = tabButton(container, "tab-current");
    expect(
      foreignTab.querySelector('[role="button"][aria-label="Close tab"]'),
    ).toBeInstanceOf(HTMLSpanElement);
    expect(
      currentTab.querySelector('[role="button"][aria-label="Close tab"]'),
    ).toBeNull();

    await act(async () => {
      (
        foreignTab.querySelector(
          '[role="button"][aria-label="Close tab"]',
        ) as HTMLSpanElement
      ).click();
    });

    expect(useClaudeChatStore.getState().tabs.map((tab) => tab.id)).toEqual([
      "tab-current",
    ]);
  });

  it("keeps tab switching, creation, and closing keyboard shortcuts", async () => {
    await renderTabs([
      makeTab("tab-claude", "Claude work", "claude"),
      makeTab("tab-codex", "Codex work", "codex"),
    ]);

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true }),
      );
    });
    expect(useClaudeChatStore.getState().activeTabId).toBe("tab-codex");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          ctrlKey: true,
          shiftKey: true,
        }),
      );
    });
    expect(useClaudeChatStore.getState().activeTabId).toBe("tab-claude");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "t", ctrlKey: true }),
      );
    });
    const createdTabId = useClaudeChatStore.getState().activeTabId;
    expect(useClaudeChatStore.getState().tabs).toHaveLength(3);
    expect(createdTabId).not.toBe("tab-claude");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "w", ctrlKey: true }),
      );
    });
    expect(useClaudeChatStore.getState().tabs).toHaveLength(2);
    expect(
      useClaudeChatStore.getState().tabs.some((tab) => tab.id === createdTabId),
    ).toBe(false);
  });

  it("marks the originating tab when a tool approval is parked", async () => {
    await renderTabs([
      makeTab("tab-old", "你好", "claude", true),
      makeTab("tab-new", "New Chat", "claude"),
    ]);
    await act(async () => {
      useApprovalStore.getState().enqueue({
        requestId: "req-old",
        method: "claude/can_use_tool",
        runtime: "claude",
        threadId: "thread-old",
        turnId: "turn-old",
        tabId: "tab-old",
        agentRunId: null,
        title: "PowerShell",
        command: "Get-Location",
        cwd: null,
        diff: null,
        permissions: null,
        questions: [],
        details: null,
      });
    });

    const oldTab = tabButton(container, "tab-old");
    const newTab = tabButton(container, "tab-new");
    expect(oldTab.getAttribute("aria-label")).toBe("你好 (needs approval)");
    expect(
      oldTab.querySelector('[data-testid="tab-approval-indicator"]'),
    ).not.toBeNull();
    expect(newTab.getAttribute("aria-label")).toBe("New Chat");
    expect(
      newTab.querySelector('[data-testid="tab-approval-indicator"]'),
    ).toBeNull();
    useApprovalStore.getState().reset();
  });

  it("gives the account chip room once the header gets narrow", () => {
    expect(accountHeaderChrome(0).utilities).toBe(true);
    expect(accountHeaderChrome(420).utilities).toBe(true);
    expect(accountHeaderChrome(419).utilities).toBe(false);
    expect(accountHeaderChrome(234)).toEqual({
      utilities: false,
      hideLabel: false,
    });
    expect(accountHeaderChrome(94)).toEqual({
      utilities: false,
      hideLabel: true,
    });
  });

  it("fills a blank or punctuation title from the first user message", async () => {
    await renderTabs([
      {
        ...makeTab("tab-blank", "", "claude"),
        messages: [userText("你好")],
      },
      {
        ...makeTab("tab-pipe", "|", "claude"),
        messages: [userText("润色这一段")],
      },
      makeTab("tab-empty", "   ", "claude"),
    ]);

    expect(
      tabButton(container, "tab-blank").querySelector(
        "[data-testid='chat-tab-title']",
      )?.textContent,
    ).toBe("你好");
    expect(
      tabButton(container, "tab-pipe").querySelector(
        "[data-testid='chat-tab-title']",
      )?.textContent,
    ).toBe("润色这一段");
    expect(
      tabButton(container, "tab-empty").querySelector(
        "[data-testid='chat-tab-title']",
      )?.textContent,
    ).toBe("New Chat");
  });

  it("localizes the empty-tab fallback", async () => {
    const previous = useSettingsStore.getState().uiLanguage;
    useSettingsStore.setState({ uiLanguage: "zh" });
    try {
      await renderTabs([makeTab("tab-new", "New Chat", "claude")]);
      expect(
        tabButton(container, "tab-new").querySelector(
          "[data-testid='chat-tab-title']",
        )?.textContent,
      ).toBe("新对话");
    } finally {
      await act(async () => {
        useSettingsStore.setState({ uiLanguage: previous });
      });
    }
  });

  function installWidthObserver(width: number) {
    const original = globalThis.ResizeObserver;
    class WidthObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        Object.defineProperty(target, "clientWidth", {
          configurable: true,
          value: width,
        });
        this.callback([], this);
      }
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver =
      WidthObserver as unknown as typeof ResizeObserver;
    return () => {
      globalThis.ResizeObserver = original;
    };
  }

  it("keeps new-tab, history, and the account chip tight on a wide bar", async () => {
    const restore = installWidthObserver(560);
    try {
      await renderTabs([
        makeTab("tab-wide", "你好", "claude"),
        makeTab("tab-two", "润色", "claude"),
        makeTab("tab-three", "翻译", "claude"),
        makeTab("tab-four", "摘要", "claude"),
        makeTab("tab-five", "校对", "claude"),
      ]);
      const toolbar = container.querySelector(
        "[data-testid='chat-tab-toolbar']",
      );
      const cluster = container.querySelector(
        "[data-testid='chat-account-cluster']",
      );
      const scroller = container.querySelector(
        "[data-testid='chat-tab-scroller']",
      );
      const chip = container.querySelector("[data-testid='chat-account-chip']");
      expect(
        [...(toolbar?.children ?? [])].map((node) =>
          node.getAttribute("data-testid"),
        ),
      ).toEqual([null, "chat-tab-scroller", "chat-account-cluster"]);
      expect(container.querySelector("[aria-label='New tab']")).toBeInstanceOf(
        HTMLButtonElement,
      );
      expect(
        container.querySelector("[data-testid='session-selector']"),
      ).not.toBeNull();
      expect(
        chip?.querySelector("[data-testid='workspace-account-button']"),
      ).not.toBeNull();
      expect(scroller?.className.split(/\s+/)).toContain("flex-1");
      expect(scroller?.className.split(/\s+/)).toContain("overflow-y-hidden");
      expect(scroller?.className).not.toContain("overflow-y-auto");
      expect(toolbar?.className).not.toContain("overflow-y-auto");
      expect(cluster?.className).not.toContain("overflow-y-auto");
      expect(cluster?.className.split(/\s+/)).toContain("w-max");
      expect(cluster?.className.split(/\s+/)).toContain("shrink-0");
      expect(cluster?.className.split(/\s+/)).not.toContain("flex-1");
      expect(chip?.className.split(/\s+/)).not.toContain("flex-1");
      expect(
        [...(cluster?.children ?? [])].map((node) =>
          node.getAttribute("data-testid"),
        ),
      ).toEqual([null, "session-selector", "chat-account-chip"]);
      expect(tabButton(container, "tab-wide").textContent).toContain("你好");
      expect(tabButton(container, "tab-five").textContent).toContain("校对");
    } finally {
      restore();
    }
  });

  it("keeps a narrow tab title visible without the history controls", async () => {
    const restore = installWidthObserver(180);
    try {
      await renderTabs([makeTab("tab-narrow", "你好", "claude")]);
      expect(container.querySelector("[aria-label='New tab']")).toBeNull();
      expect(
        container.querySelector("[data-testid='session-selector']"),
      ).toBeNull();
      expect(tabButton(container, "tab-narrow").textContent).toContain("你好");
      const cluster = container.querySelector(
        "[data-testid='chat-account-cluster']",
      );
      expect(cluster?.className.split(/\s+/)).toContain("shrink-0");
      expect(cluster?.className).not.toContain("min-w-0");
      expect(tabButton(container, "tab-narrow").style.minWidth).not.toBe("0px");
    } finally {
      restore();
    }
  });

  it("labels the learning session in the active UI language", async () => {
    useSettingsStore.setState({ uiLanguage: "zh" });
    try {
      await renderTabs([
        {
          ...makeTab("tab-learn", "请讲解这个结构", "claude"),
          purpose: LATEX_LEARN_PURPOSE,
          resumeRequestId: "resume-1",
          messages: [userText("请讲解这个结构")],
        },
      ]);
      expect(
        tabButton(container, "tab-learn").querySelector(
          "[data-testid='chat-tab-title']",
        )?.textContent,
      ).toBe("边写边学");
      expect(
        tabButton(container, "tab-learn").querySelector(
          "[data-testid='tab-history-indicator']",
        ),
      ).not.toBeNull();

      await act(async () => {
        useSettingsStore.setState({ uiLanguage: "en" });
      });
      expect(
        tabButton(container, "tab-learn").querySelector(
          "[data-testid='chat-tab-title']",
        )?.textContent,
      ).toBe("Learn LaTeX");
    } finally {
      useSettingsStore.setState({ uiLanguage: "en" });
    }
  });

  it("keeps the writing chat beside the pinned learning tab", async () => {
    const restore = installWidthObserver(307);
    const previous = useSettingsStore.getState().uiLanguage;
    useSettingsStore.setState({ uiLanguage: "en" });
    useProviderStore.setState({
      cards: [
        {
          id: "deepseek",
          kind: "third-party",
          name: "DeepSeek",
          authenticated: true,
          isActive: true,
          accountLabel: "DeepSeek",
        },
      ],
    });
    try {
      const writingTitle =
        "Proofread and fix any remaining issues in this draft";
      await renderTabs(
        [
          makeTab("tab-write", writingTitle, "claude"),
          {
            ...makeTab("tab-learn", "请讲解这个结构", "claude"),
            purpose: LATEX_LEARN_PURPOSE,
            messages: [userText("请讲解这个结构")],
          },
        ],
        <button type="button" aria-label="Hide chat" title="Hide chat">
          <span>Hide</span>
        </button>,
      );

      const scroller = container.querySelector(
        "[data-testid='chat-tab-scroller']",
      );
      const learnSlot = container.querySelector(
        "[data-testid='chat-tab-learn-slot']",
      );
      const writing = tabButton(container, "tab-write");
      const learn = tabButton(container, "tab-learn");
      const toolbar = container.querySelector(
        "[data-testid='chat-tab-toolbar']",
      );
      const english = chatTabStripPlan({
        barWidthPx: 307,
        writingTabCount: 1,
        hasLearnTab: true,
        labels: {
          learn: "Learn LaTeX",
          leading: "Hide",
          accountFull: "DeepSeek",
          accountProvider: "DeepSeek",
        },
      });

      expect(container.querySelectorAll("[data-tab-id]")).toHaveLength(2);
      expect(scroller?.contains(writing)).toBe(true);
      expect(scroller?.contains(learn)).toBe(false);
      expect(learnSlot?.contains(learn)).toBe(true);
      expect(
        learn.querySelector("[data-testid='chat-tab-learn-icon']"),
      ).not.toBeNull();
      expect(learn.getAttribute("data-full-title")).toBe("Learn LaTeX");
      expect(
        learn.querySelector("[data-testid='chat-tab-title']")?.textContent,
      ).toBe("Learn LaTeX");
      expect(
        learn.querySelector("[data-testid='chat-tab-title']")?.className,
      ).not.toContain("truncate");
      expect(learn.className).toContain("whitespace-nowrap");
      expect(learn.className).not.toContain("max-w-[11rem]");
      expect(writing.getAttribute("data-full-title")).toBe(writingTitle);
      expect(writing.getAttribute("title")).toBeNull();
      await act(async () => {
        writing.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            pointerType: "mouse",
          }),
        );
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });
      const tip = document.querySelector("[data-testid='chat-tab-tooltip']");
      // Radix repeats the label in a visually hidden accessible tooltip.
      expect(tip?.textContent).toContain(writingTitle);
      expect(tip?.textContent).not.toContain("…");
      expect(
        container
          .querySelector("[data-testid='chat-tab-scroller']")
          ?.contains(tip),
      ).toBe(false);
      expect(
        writing.querySelector("[data-testid='chat-tab-title']")?.textContent,
      ).toBe(writingTitle);
      expect(
        writing.querySelector("[data-testid='chat-tab-title']")?.className,
      ).toContain("truncate");
      expect(learn.style.minWidth).toBe(`${english.learnSlotPx}px`);
      expect(writing.style.minWidth).toBe(`${english.writingTabMinPx}px`);
      expect(writing.style.maxWidth).toBe(`${english.writingTabMaxPx}px`);
      expect(english.writingTabMinPx).toBeGreaterThan(0);
      expect(english.writingTabMaxPx).toBeGreaterThan(english.writingTabMinPx);
      expect(english.accountDensity).toBe("icon");
      expect(english.hideLeadingLabel).toBe(true);
      expect(
        container.querySelector("[data-testid='chat-account-cluster']"),
      ).toHaveProperty("style.minWidth", `${english.accountMinPx}px`);
      expect(toolbar?.getAttribute("data-account-density")).toBe("icon");
      expect(
        container
          .querySelector("[data-testid='workspace-account-button']")
          ?.getAttribute("data-density"),
      ).toBe("icon");
      expect(
        toolbar?.firstElementChild?.getAttribute("data-leading-label"),
      ).toBe("hidden");
      expect(toolbar?.firstElementChild?.className).toContain(
        "[&_span]:hidden",
      );
      const measure = container.querySelector(
        "[data-testid='chat-tab-measure']",
      );
      expect(measure?.className).not.toContain("h-0");
      expect(measure?.className).not.toContain("w-0");
      expect(
        measure instanceof HTMLElement ? measure.style.visibility : "",
      ).toBe("hidden");
      expect(measure instanceof HTMLElement ? measure.style.width : "").toBe(
        "max-content",
      );
      expect(measure instanceof HTMLElement ? measure.style.height : "").toBe(
        "auto",
      );
      expect(toolbar?.querySelector("button")?.getAttribute("aria-label")).toBe(
        "Hide chat",
      );
      expect(toolbar?.querySelector("button")?.getAttribute("title")).toBe(
        "Hide chat",
      );
      expect(container.querySelector("[aria-label='New tab']")).toBeNull();
      expect(
        container.querySelector("[data-testid='session-selector']"),
      ).toBeNull();
      expect(
        toolbar instanceof HTMLElement ? toolbar.style.fontFamily : "",
      ).toContain("Segoe UI");

      await act(async () => learn.click());
      expect(useClaudeChatStore.getState().activeTabId).toBe("tab-learn");
      expect(tabButton(container, "tab-write").isConnected).toBe(true);
      expect(tabButton(container, "tab-learn").isConnected).toBe(true);

      await act(async () => tabButton(container, "tab-write").click());
      expect(useClaudeChatStore.getState().activeTabId).toBe("tab-write");
      expect(tabButton(container, "tab-learn").isConnected).toBe(true);
      expect(container.querySelectorAll("[data-tab-id]")).toHaveLength(2);

      await act(async () => {
        useSettingsStore.setState({ uiLanguage: "zh" });
      });
      const chinese = chatTabStripPlan({
        barWidthPx: 307,
        writingTabCount: 1,
        hasLearnTab: true,
        labels: {
          learn: "边写边学",
          leading: "隐藏",
          accountFull: "DeepSeek",
          accountProvider: "DeepSeek",
        },
      });
      expect(
        tabButton(container, "tab-learn").getAttribute("data-full-title"),
      ).toBe("边写边学");
      expect(
        tabButton(container, "tab-learn").querySelector(
          "[data-testid='chat-tab-title']",
        )?.textContent,
      ).toBe("边写边学");
      expect(tabButton(container, "tab-learn").style.minWidth).toBe(
        `${chinese.learnSlotPx}px`,
      );
      expect(chinese.learnSlotPx).toBeLessThan(english.learnSlotPx);
      expect(tabButton(container, "tab-write").style.maxWidth).toBe(
        `${chinese.writingTabMaxPx}px`,
      );
      expect(chinese.writingTabMaxPx).toBeGreaterThan(english.writingTabMaxPx);
      expect(chinese.accountDensity).toBe("icon");
      expect(
        toolbar?.firstElementChild?.getAttribute("data-leading-label"),
      ).toBe("hidden");
    } finally {
      useSettingsStore.setState({ uiLanguage: previous });
      resetProviderStoreForTests();
      restore();
    }
  });

  it("shows a close control on the last idle tab", async () => {
    await renderTabs([makeTab("tab-only", "Literature review", "claude")]);

    const onlyTab = tabButton(container, "tab-only");
    expect(
      onlyTab.querySelector('[role="button"][aria-label="Close tab"]'),
    ).toBeInstanceOf(HTMLSpanElement);
  });
});
