import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceLayout } from "@/components/workspace/workspace-layout";
import {
  resetChatLayoutStoreForTests,
  useChatLayoutStore,
} from "@/stores/chat-layout-store";
import { useDocumentStore } from "@/stores/document-store";
import { usePreviewStore } from "@/stores/preview-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { useSettingsStore } from "@/stores/settings-store";

vi.mock("@/hooks/use-runtime-events", () => ({
  useRuntimeEvents: () => undefined,
}));

vi.mock("@/components/workspace/sidebar", () => ({
  Sidebar: () => <div data-testid="sidebar" />,
}));

vi.mock("@/components/workspace/editor/latex-editor", () => ({
  LatexEditor: () => <div data-testid="latex-editor" />,
}));

vi.mock("@/components/workspace/preview/pdf-preview", () => ({
  PdfPreview: () => <div data-testid="pdf-preview" />,
}));

vi.mock("@/components/claude-chat/claude-chat-drawer", () => ({
  ClaudeChatDrawer: () => <div data-testid="chat-pane">Chat pane</div>,
}));

describe("WorkspaceLayout chat pane", () => {
  let container: HTMLDivElement;
  let root: Root;
  let documentSnapshot: ReturnType<typeof useDocumentStore.getState>;
  let chatSnapshot: ReturnType<typeof useClaudeChatStore.getState>;

  beforeEach(() => {
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    });
    documentSnapshot = useDocumentStore.getState();
    chatSnapshot = useClaudeChatStore.getState();
    resetChatLayoutStoreForTests();
    usePreviewStore.setState({ visible: true });
    useDocumentStore.setState({ initialized: true, projectRoot: "C:/paper" });
    useSettingsStore.setState({ productTour: "completed", uiLanguage: "en" });
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
    usePreviewStore.setState({ visible: true });
    useDocumentStore.setState(documentSnapshot, true);
    useClaudeChatStore.setState(chatSnapshot, true);
  });

  it("keeps editor, chat, and preview visible side by side", async () => {
    await act(async () => root.render(<WorkspaceLayout />));

    expect(
      container.querySelector('[data-testid="latex-editor"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-pane"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="pdf-preview"]'),
    ).not.toBeNull();
  });

  it("can hide chat without removing the editor or preview", async () => {
    await act(async () => root.render(<WorkspaceLayout />));
    expect(
      container.querySelector('[data-testid="resize-code-chat"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="resize-chat-pdf"]'),
    ).not.toBeNull();

    await act(async () => useChatLayoutStore.getState().setVisible(false));

    expect(useChatLayoutStore.getState().visible).toBe(false);
    expect(container.querySelector('[data-testid="chat-pane"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="latex-editor"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="pdf-preview"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="resize-code-chat"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="resize-chat-pdf"]'),
    ).toBeNull();
    const codePdf = container.querySelector('[data-testid="resize-code-pdf"]');
    expect(codePdf).not.toBeNull();
    expect(
      codePdf?.previousElementSibling?.querySelector(
        '[data-testid="latex-editor"]',
      ),
    ).not.toBeNull();
    expect(
      codePdf?.nextElementSibling?.querySelector('[data-testid="pdf-preview"]'),
    ).not.toBeNull();
    const restore = container.querySelector(
      '[data-testid="open-ai-assistant"]',
    );
    expect(restore).toBeInstanceOf(HTMLButtonElement);
    expect(restore?.getAttribute("aria-label")).toBe("Open AI Assistant");
  });

  it("restores the docked chat column from the small assistant icon", async () => {
    useChatLayoutStore.setState({ visible: false, suppressAutoOpen: true });
    await act(async () => root.render(<WorkspaceLayout />));

    const restore = container.querySelector(
      '[data-testid="open-ai-assistant"]',
    );
    expect(restore).toBeInstanceOf(HTMLButtonElement);
    expect(container.querySelector('[data-testid="chat-pane"]')).toBeNull();

    await act(async () => (restore as HTMLButtonElement).click());

    expect(useChatLayoutStore.getState().visible).toBe(true);
    expect(useChatLayoutStore.getState().suppressAutoOpen).toBe(false);
    expect(container.querySelector('[data-testid="chat-pane"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="open-ai-assistant"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="resize-code-chat"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="resize-chat-pdf"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="resize-code-pdf"]'),
    ).toBeNull();
  });

  it("toggles chat with Ctrl+Shift+A while the editor is focused", async () => {
    useChatLayoutStore.setState({ visible: false, suppressAutoOpen: true });
    await act(async () => root.render(<WorkspaceLayout />));

    const editor = document.createElement("div");
    editor.className = "cm-content";
    document.body.append(editor);
    try {
      await act(async () => {
        editor.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            shiftKey: true,
            code: "KeyA",
            key: "a",
          }),
        );
      });
    } finally {
      editor.remove();
    }

    expect(useChatLayoutStore.getState().visible).toBe(true);
    expect(container.querySelector('[data-testid="chat-pane"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="open-ai-assistant"]'),
    ).toBeNull();
  });

  it("does not force chat back open while the user has hidden it during a stream", async () => {
    await act(async () => root.render(<WorkspaceLayout />));
    await act(async () => {
      const current = useClaudeChatStore.getState();
      useClaudeChatStore.setState({
        tabs: current.tabs.map((tab, index) =>
          index === 0 ? { ...tab, isStreaming: true } : tab,
        ),
      });
    });
    await act(async () => useChatLayoutStore.getState().setVisible(false));

    expect(useChatLayoutStore.getState().visible).toBe(false);
    expect(useChatLayoutStore.getState().suppressAutoOpen).toBe(true);
    expect(
      container.querySelector('[data-testid="open-ai-assistant"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="open-ai-assistant-attention"]'),
    ).not.toBeNull();
  });

  it("reopens chat when a turn starts streaming", async () => {
    useChatLayoutStore.setState({ visible: false, suppressAutoOpen: false });
    await act(async () => root.render(<WorkspaceLayout />));
    expect(useChatLayoutStore.getState().visible).toBe(false);

    await act(async () => {
      const current = useClaudeChatStore.getState();
      useClaudeChatStore.setState({
        tabs: current.tabs.map((tab, index) =>
          index === 0 ? { ...tab, isStreaming: true } : tab,
        ),
      });
    });

    expect(useChatLayoutStore.getState().visible).toBe(true);
    expect(container.querySelector('[data-testid="chat-pane"]')).not.toBeNull();
  });

  it("shows the product tour only after the LaTeX workspace is ready", async () => {
    useSettingsStore.setState({ productTour: "pending", uiLanguage: "en" });
    useDocumentStore.setState({ initialized: false, projectRoot: "C:/paper" });
    await act(async () => root.render(<WorkspaceLayout />));
    expect(
      document.body.querySelector('[data-testid="product-tour"]'),
    ).toBeNull();

    await act(async () => {
      useDocumentStore.setState({ initialized: true });
    });
    expect(
      document.body.querySelector('[data-testid="product-tour"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain("Project files");
  });

  it("restores chat only when the tour opened it", async () => {
    await act(async () => root.render(<WorkspaceLayout />));
    expect(useChatLayoutStore.getState().visible).toBe(true);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("localprism-product-tour", { detail: "show-chat" }),
      );
      window.dispatchEvent(
        new CustomEvent("localprism-product-tour", {
          detail: "close-overlays",
        }),
      );
    });
    expect(useChatLayoutStore.getState().visible).toBe(true);

    await act(async () => {
      useChatLayoutStore.getState().setVisible(false);
    });
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("localprism-product-tour", { detail: "show-chat" }),
      );
    });
    expect(useChatLayoutStore.getState().visible).toBe(true);
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("localprism-product-tour", {
          detail: "close-overlays",
        }),
      );
    });
    expect(useChatLayoutStore.getState().visible).toBe(false);
  });

  it("does not render a top-bar Settings control", async () => {
    await act(async () => root.render(<WorkspaceLayout />));
    expect(
      container.querySelector("[data-testid='app-chrome-header']"),
    ).toBeNull();
    expect(container.querySelector("[data-testid='chrome-settings']")).toBeNull();
    expect(container.textContent).not.toContain("Settings");
  });
});
