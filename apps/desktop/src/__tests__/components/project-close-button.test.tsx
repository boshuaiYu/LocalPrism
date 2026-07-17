import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectCloseButton } from "@/components/workspace/project-close-button";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("ProjectCloseButton", () => {
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

  it("disables close with an accessible stop hint while a runtime is busy", async () => {
    const onClose = vi.fn(() => Promise.resolve(true));
    await act(async () => {
      root.render(<ProjectCloseButton runtimeBusy={true} onClose={onClose} />);
    });

    const button = container.querySelector("button");
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-label")).toBe(
      "Stop all runtime turns before closing the project",
    );
    button?.click();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the button disabled while an asynchronous close is draining", async () => {
    const close = deferred<boolean>();
    const onClose = vi.fn(() => close.promise);
    await act(async () => {
      root.render(<ProjectCloseButton runtimeBusy={false} onClose={onClose} />);
    });

    const button = container.querySelector("button")!;
    act(() => {
      button.click();
      button.click();
    });

    try {
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("aria-label")).toMatch(/closing/i);
    } finally {
      await act(async () => {
        close.resolve(true);
        await close.promise;
      });
    }
    expect(button.disabled).toBe(false);
  });
});
