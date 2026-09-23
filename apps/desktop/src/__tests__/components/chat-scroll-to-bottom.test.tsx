import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatMessages } from "@/components/claude-chat/chat-messages";
import {
  useClaudeChatStore,
  type ClaudeStreamMessage,
} from "@/stores/claude-chat-store";
import { useSettingsStore } from "@/stores/settings-store";

function user(text: string): ClaudeStreamMessage {
  return {
    type: "user",
    message: { content: [{ type: "text", text }] },
  };
}

function setTranscriptMetrics(
  el: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    value: metrics.scrollHeight,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    value: metrics.clientHeight,
  });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    writable: true,
    value: metrics.scrollTop,
  });
}

describe("chat scroll to bottom", () => {
  let container: HTMLDivElement;
  let root: Root;
  let scrollTo: ReturnType<typeof vi.fn>;
  let originalScrollTo: typeof HTMLElement.prototype.scrollTo;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    originalScrollTo = HTMLElement.prototype.scrollTo;
    scrollTo = vi.fn(function (this: HTMLElement, options?: ScrollToOptions) {
      const requested =
        options && typeof options.top === "number"
          ? options.top
          : this.scrollTop;
      const maxTop = Math.max(0, this.scrollHeight - this.clientHeight);
      const top = Math.min(Math.max(0, requested), maxTop);
      Object.defineProperty(this, "scrollTop", {
        configurable: true,
        writable: true,
        value: top,
      });
      this.dispatchEvent(new Event("scroll"));
    });
    HTMLElement.prototype.scrollTo =
      scrollTo as typeof HTMLElement.prototype.scrollTo;
    useSettingsStore.setState({ uiLanguage: "en" });
    useClaudeChatStore.getState().resetForProject("/project-a");
    const tab = useClaudeChatStore.getState().tabs[0];
    const messages = [
      user("Rewrite the abstract"),
      user("Check the citations"),
    ];
    useClaudeChatStore.setState({
      tabs: [
        {
          ...tab,
          messages,
          projectPath: "/project-a",
          isStreaming: false,
        },
      ],
      messages,
      isStreaming: false,
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    HTMLElement.prototype.scrollTo = originalScrollTo;
    vi.unstubAllGlobals();
    useSettingsStore.setState({ uiLanguage: "en" });
  });

  async function renderTranscript() {
    await act(async () => {
      root.render(<ChatMessages />);
    });
    const transcript = container.querySelector(
      '[data-testid="chat-transcript"]',
    );
    expect(transcript).toBeInstanceOf(HTMLElement);
    return transcript as HTMLElement;
  }

  async function scrollTranscript(
    transcript: HTMLElement,
    metrics: { scrollHeight: number; clientHeight: number; scrollTop: number },
  ) {
    setTranscriptMetrics(transcript, metrics);
    await act(async () => {
      transcript.dispatchEvent(new Event("scroll"));
    });
  }

  it("jumps to the latest messages when the reader is scrolled up", async () => {
    const transcript = await renderTranscript();
    await scrollTranscript(transcript, {
      scrollHeight: 800,
      clientHeight: 300,
      scrollTop: 0,
    });

    const button = container.querySelector(
      '[data-testid="scroll-to-bottom"]',
    ) as HTMLButtonElement | null;
    expect(button).toBeTruthy();
    expect(button?.getAttribute("aria-label")).toBe("Scroll to latest");
    expect(button?.textContent).toContain("Scroll to latest");

    scrollTo.mockClear();
    await act(async () => {
      button?.click();
    });
    expect(scrollTo).toHaveBeenCalledWith({
      top: 800,
      behavior: "instant",
    });
    expect(
      container.querySelector('[data-testid="scroll-to-bottom"]'),
    ).toBeNull();
  });

  it("stays hidden when the viewport is already on the latest messages", async () => {
    const transcript = await renderTranscript();
    await scrollTranscript(transcript, {
      scrollHeight: 800,
      clientHeight: 300,
      scrollTop: 500,
    });
    expect(
      container.querySelector('[data-testid="scroll-to-bottom"]'),
    ).toBeNull();
  });

  it("stays available when a new message arrives below the viewport", async () => {
    const transcript = await renderTranscript();
    await scrollTranscript(transcript, {
      scrollHeight: 400,
      clientHeight: 300,
      scrollTop: 0,
    });
    expect(
      container.querySelector('[data-testid="scroll-to-bottom"]'),
    ).toBeTruthy();

    scrollTo.mockClear();
    const messages = [
      ...useClaudeChatStore.getState().messages,
      user("A newer reply arrived"),
    ];
    setTranscriptMetrics(transcript, {
      scrollHeight: 900,
      clientHeight: 300,
      scrollTop: 0,
    });
    await act(async () => {
      const tab = useClaudeChatStore.getState().tabs[0];
      useClaudeChatStore.setState({
        messages,
        tabs: [{ ...tab, messages }],
      });
    });

    expect(scrollTo).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="scroll-to-bottom"]'),
    ).toBeTruthy();
  });

  it("does not yank a queued streaming frame after the reader scrolls up", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      delete frames[id - 1];
    });
    useClaudeChatStore.setState({ isStreaming: true });

    await act(async () => {
      root.render(<ChatMessages />);
    });
    await act(async () => {
      for (const frame of frames.splice(0)) frame?.(0);
    });
    expect(scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: "instant" }),
    );

    const transcript = container.querySelector(
      '[data-testid="chat-transcript"]',
    );
    expect(transcript).toBeInstanceOf(HTMLElement);
    const messages = [
      ...useClaudeChatStore.getState().messages,
      user("still writing"),
    ];
    await act(async () => {
      const tab = useClaudeChatStore.getState().tabs[0];
      useClaudeChatStore.setState({
        isStreaming: true,
        messages,
        tabs: [{ ...tab, messages, isStreaming: true }],
      });
    });
    expect(frames.some(Boolean)).toBe(true);

    await scrollTranscript(transcript as HTMLElement, {
      scrollHeight: 900,
      clientHeight: 300,
      scrollTop: 0,
    });
    scrollTo.mockClear();
    await act(async () => {
      for (const frame of frames.splice(0)) frame?.(0);
    });

    expect(scrollTo).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="scroll-to-bottom"]'),
    ).toBeTruthy();
  });

  it("does not pull the reader down when streaming ends above the latest message", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    useClaudeChatStore.setState({ isStreaming: true });

    await act(async () => {
      root.render(<ChatMessages />);
    });
    await act(async () => {
      for (const frame of frames.splice(0)) frame(0);
    });

    const transcript = container.querySelector(
      '[data-testid="chat-transcript"]',
    );
    expect(transcript).toBeInstanceOf(HTMLElement);
    await scrollTranscript(transcript as HTMLElement, {
      scrollHeight: 800,
      clientHeight: 300,
      scrollTop: 0,
    });
    expect(
      container.querySelector('[data-testid="scroll-to-bottom"]'),
    ).toBeTruthy();

    scrollTo.mockClear();
    const messages = [
      ...useClaudeChatStore.getState().messages,
      user("The turn finished below"),
    ];
    setTranscriptMetrics(transcript as HTMLElement, {
      scrollHeight: 1100,
      clientHeight: 300,
      scrollTop: 0,
    });
    await act(async () => {
      const tab = useClaudeChatStore.getState().tabs[0];
      useClaudeChatStore.setState({
        isStreaming: false,
        messages,
        tabs: [{ ...tab, messages, isStreaming: false }],
      });
    });
    await act(async () => {
      for (const frame of frames.splice(0)) frame(0);
    });

    expect(scrollTo).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="scroll-to-bottom"]'),
    ).toBeTruthy();
  });

  it("labels the control in Chinese", async () => {
    useSettingsStore.setState({ uiLanguage: "zh" });
    const transcript = await renderTranscript();
    await scrollTranscript(transcript, {
      scrollHeight: 800,
      clientHeight: 300,
      scrollTop: 0,
    });
    const button = container.querySelector('[data-testid="scroll-to-bottom"]');
    expect(button?.getAttribute("aria-label")).toBe("跳到最新");
    expect(button?.textContent).toContain("跳到最新");
  });

  it("keeps compress earlier messages as a secondary action", async () => {
    const messages = Array.from({ length: 10 }, (_, index) =>
      user(`note ${index}`),
    );
    const compressEarlierMessages = vi.fn(async () => "skipped" as const);
    const tab = useClaudeChatStore.getState().tabs[0];
    useClaudeChatStore.setState({
      messages,
      tabs: [{ ...tab, messages }],
      compressEarlierMessages,
    });

    await act(async () => {
      root.render(<ChatMessages />);
    });

    const compress = container.querySelector(
      '[data-testid="compress-earlier"]',
    ) as HTMLButtonElement | null;
    expect(compress).toBeTruthy();
    expect(compress?.className).not.toContain("rounded-full");
    expect(compress?.parentElement?.className).toContain("justify-end");
    expect(compress?.parentElement?.className).not.toContain("justify-center");

    await act(async () => {
      compress?.click();
    });
    expect(compressEarlierMessages).toHaveBeenCalledWith({ force: true });
  });
});
