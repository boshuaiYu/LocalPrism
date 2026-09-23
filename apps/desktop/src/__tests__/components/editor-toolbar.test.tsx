import { createRoot, type Root } from "react-dom/client";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { EditorToolbar } from "@/components/workspace/editor/editor-toolbar";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";

const editors = [
  { id: "cursor", name: "Cursor" },
  { id: "vscode", name: "VS Code" },
  { id: "codex", name: "Codex" },
];

function ToolbarHarness() {
  const editorView = useRef(null);
  return <EditorToolbar editorView={editorView} />;
}

if (typeof globalThis.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {}
  globalThis.PointerEvent =
    PointerEventPolyfill as unknown as typeof PointerEvent;
}

function openMenu(button: HTMLElement) {
  const eventInit = { bubbles: true, cancelable: true, button: 0 };
  button.dispatchEvent(new PointerEvent("pointerdown", eventInit));
  button.dispatchEvent(new MouseEvent("mousedown", eventInit));
  button.click();
}

describe("EditorToolbar external editors", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.removeItem("localprism.preferredEditor");
    useSettingsStore.setState({ uiLanguage: "en" });
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "detect_editors") return Promise.resolve(editors);
      return Promise.resolve(null);
    });
    useDocumentStore.setState({
      projectRoot: "/work/paper",
      activeFileId: "main.tex",
      files: [
        {
          id: "main.tex",
          name: "main.tex",
          relativePath: "main.tex",
          absolutePath: "/work/paper/main.tex",
          type: "tex",
          isDirty: false,
        },
      ],
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    localStorage.removeItem("localprism.preferredEditor");
    useSettingsStore.setState({ uiLanguage: "en" });
    useDocumentStore.setState({
      projectRoot: null,
      activeFileId: "",
      files: [],
    });
  });

  it("opens Codex from the primary button and keeps distinct editor marks", async () => {
    root.render(<ToolbarHarness />);

    const button = await vi.waitFor(() => {
      const node = container.querySelector('button[title="Open in Codex"]');
      if (!(node instanceof HTMLButtonElement)) {
        throw new Error("open button missing");
      }
      return node;
    });
    expect(button.querySelector('[data-editor-icon="codex"]')).toBeTruthy();
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("detect_editors");
    });

    button.click();

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("open_in_editor", {
        editorId: "codex",
        projectPath: "/work/paper",
        filePath: "main.tex",
        line: undefined,
      });
    });

    const menu = container.querySelector('button[title="Choose editor"]');
    if (!(menu instanceof HTMLButtonElement)) {
      throw new Error("editor menu missing");
    }
    openMenu(menu);

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Cursor");
      expect(document.body.textContent).toContain("VS Code");
      expect(document.body.textContent).toContain("Codex");
    });

    const item = (name: string) => {
      const node = [
        ...document.body.querySelectorAll('[role="menuitem"]'),
      ].find((entry) => entry.textContent?.includes(name));
      if (!(node instanceof HTMLElement)) {
        throw new Error(`${name} menu item missing`);
      }
      return node;
    };

    expect(
      item("Cursor").querySelector('[data-editor-icon="cursor"]'),
    ).toBeTruthy();
    expect(item("Cursor").querySelector("img")).toBeNull();
    expect(
      item("VS Code").querySelector('img[data-editor-icon="vscode"]'),
    ).toBeTruthy();
    expect(
      item("Codex").querySelector('[data-editor-icon="codex"]'),
    ).toBeTruthy();
    expect(item("Codex").querySelector("img")).toBeNull();
  });

  it("remembers the editor chosen from the menu", async () => {
    root.render(<ToolbarHarness />);

    const menu = await vi.waitFor(() => {
      const node = container.querySelector('button[title="Choose editor"]');
      if (!(node instanceof HTMLButtonElement)) {
        throw new Error("editor menu missing");
      }
      return node;
    });
    openMenu(menu);

    const cursor = await vi.waitFor(() => {
      const node = [
        ...document.body.querySelectorAll('[role="menuitem"]'),
      ].find((entry) => entry.textContent?.includes("Cursor"));
      if (!(node instanceof HTMLElement)) {
        throw new Error("Cursor menu item missing");
      }
      return node;
    });
    cursor.click();

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("open_in_editor", {
        editorId: "cursor",
        projectPath: "/work/paper",
        filePath: "main.tex",
        line: undefined,
      });
      expect(
        container.querySelector('button[title="Open in Cursor"]'),
      ).toBeTruthy();
    });
    expect(localStorage.getItem("localprism.preferredEditor")).toBe("cursor");
  });

  it("uses the first installed editor when Codex is not installed", async () => {
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "detect_editors") {
        return Promise.resolve([
          { id: "cursor", name: "Cursor" },
          { id: "vscode", name: "VS Code" },
        ]);
      }
      return Promise.resolve(null);
    });
    root.render(<ToolbarHarness />);

    const button = await vi.waitFor(() => {
      const node = container.querySelector('button[title="Open in Cursor"]');
      if (!(node instanceof HTMLButtonElement)) {
        throw new Error("fallback button missing");
      }
      return node;
    });
    button.click();
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("open_in_editor", {
        editorId: "cursor",
        projectPath: "/work/paper",
        filePath: "main.tex",
        line: undefined,
      });
    });
    expect(localStorage.getItem("localprism.preferredEditor")).toBeNull();
  });

  it("uses Chinese labels for the split button", async () => {
    useSettingsStore.setState({ uiLanguage: "zh" });
    root.render(<ToolbarHarness />);

    await vi.waitFor(() => {
      expect(
        container.querySelector('button[title="在 Codex 中打开"]'),
      ).toBeTruthy();
      expect(
        container.querySelector('button[title="选择编辑器"]'),
      ).toBeTruthy();
    });
  });

  it("shows a hint instead of an empty menu when nothing is installed", async () => {
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "detect_editors") return Promise.resolve([]);
      return Promise.resolve(null);
    });
    root.render(<ToolbarHarness />);

    const button = await vi.waitFor(() => {
      const node = container.querySelector('button[title="Choose editor"]');
      if (!(node instanceof HTMLButtonElement)) {
        throw new Error("editor menu missing");
      }
      return node;
    });
    expect(container.querySelector("button[disabled]")).toBeTruthy();
    openMenu(button);

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("No editors found");
    });
    expect(document.body.textContent).not.toContain("Cursor");
  });
});
