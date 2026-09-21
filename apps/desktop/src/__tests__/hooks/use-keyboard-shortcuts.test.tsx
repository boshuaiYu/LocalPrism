import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";

function Probe() {
  useKeyboardShortcuts();
  return <textarea data-testid="editor" defaultValue="hello world" />;
}

describe("useKeyboardShortcuts capture vs cut", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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
  });

  it("leaves Ctrl+X for native cut and does not start capture", async () => {
    const capture = vi.fn();
    window.addEventListener("toggle-capture-mode", capture);
    await act(async () => {
      root.render(<Probe />);
    });

    const event = new KeyboardEvent("keydown", {
      key: "x",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    const prevented = !window.dispatchEvent(event);

    expect(prevented).toBe(false);
    expect(capture).not.toHaveBeenCalled();
    window.removeEventListener("toggle-capture-mode", capture);
  });

  it("toggles Capture & Ask with Ctrl+Shift+X", async () => {
    const capture = vi.fn();
    window.addEventListener("toggle-capture-mode", capture);
    await act(async () => {
      root.render(<Probe />);
    });

    const event = new KeyboardEvent("keydown", {
      key: "X",
      code: "KeyX",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(capture).toHaveBeenCalledTimes(1);
    window.removeEventListener("toggle-capture-mode", capture);
  });

  it("does not treat IME leftover Shift+Ctrl+X as capture", async () => {
    const capture = vi.fn();
    window.addEventListener("toggle-capture-mode", capture);
    await act(async () => {
      root.render(<Probe />);
    });

    const event = new KeyboardEvent("keydown", {
      key: "x",
      code: "KeyX",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    const prevented = !window.dispatchEvent(event);

    expect(prevented).toBe(false);
    expect(capture).not.toHaveBeenCalled();
    window.removeEventListener("toggle-capture-mode", capture);
  });

  it("leaves Ctrl+Shift+X in the document editor for cut, not capture", async () => {
    const capture = vi.fn();
    window.addEventListener("toggle-capture-mode", capture);
    await act(async () => {
      root.render(<Probe />);
    });

    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    const event = new KeyboardEvent("keydown", {
      key: "X",
      code: "KeyX",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    textarea?.dispatchEvent(event);

    expect(capture).not.toHaveBeenCalled();
    window.removeEventListener("toggle-capture-mode", capture);
  });
});
