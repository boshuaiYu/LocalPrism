import { createRoot, type Root } from "react-dom/client";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { EditorToolbar } from "@/components/workspace/editor/editor-toolbar";
import { useDocumentStore } from "@/stores/document-store";

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
    useDocumentStore.setState({
      projectRoot: null,
      activeFileId: "",
      files: [],
    });
  });

  it("lists installed editors and opens the current file in the chosen one", async () => {
    root.render(<ToolbarHarness />);

    const button = await vi.waitFor(() => {
      const node = container.querySelector('button[title="Open in Editor"]');
      if (!(node instanceof HTMLButtonElement)) {
        throw new Error("open button missing");
      }
      return node;
    });
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("detect_editors");
    });

    openMenu(button);

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Cursor");
      expect(document.body.textContent).toContain("VS Code");
      expect(document.body.textContent).toContain("Codex");
    });

    for (const name of ["Cursor", "VS Code", "Codex"]) {
      const item = [
        ...document.body.querySelectorAll('[role="menuitem"]'),
      ].find((node) => node.textContent?.includes(name));
      expect(item?.querySelector("img"), name).toBeTruthy();
    }

    const codex = [...document.body.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent?.includes("Codex"),
    );
    if (!(codex instanceof HTMLElement)) {
      throw new Error("Codex menu item missing");
    }
    codex.click();

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("open_in_editor", {
        editorId: "codex",
        projectPath: "/work/paper",
        filePath: "main.tex",
        line: undefined,
      });
    });
  });

  it("shows a hint instead of an empty menu when nothing is installed", async () => {
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "detect_editors") return Promise.resolve([]);
      return Promise.resolve(null);
    });
    root.render(<ToolbarHarness />);

    const button = await vi.waitFor(() => {
      const node = container.querySelector('button[title="Open in Editor"]');
      if (!(node instanceof HTMLButtonElement)) {
        throw new Error("open button missing");
      }
      return node;
    });
    openMenu(button);

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("No editors found");
    });
    expect(document.body.textContent).not.toContain("Cursor");
  });
});
