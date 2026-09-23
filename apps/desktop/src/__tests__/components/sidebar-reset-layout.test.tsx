import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "@/components/workspace/sidebar";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("1.0.8-2"),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

describe("Sidebar chrome", () => {
  let container: HTMLDivElement;
  let root: Root;

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

  it("has settings and no reset-layout or updates control", async () => {
    await act(async () =>
      root.render(
        <Sidebar
          layoutControls={{
            codeVisible: true,
            chatVisible: true,
            pdfVisible: true,
            sidebarVisible: true,
            setCodeVisible: vi.fn(),
            setChatVisible: vi.fn(),
            setPdfVisible: vi.fn(),
            setSidebarVisible: vi.fn(),
          }}
        />,
      ),
    );

    const visibleText = Array.from(container.querySelectorAll("button, a"))
      .filter((node) => !node.closest('[aria-hidden="true"]'))
      .map((node) => node.textContent ?? "")
      .join("\n");
    expect(
      container.querySelector('[data-testid="reset-workspace-layout"]'),
    ).toBeNull();
    expect(visibleText).not.toMatch(/Reset layout/);
    expect(visibleText).not.toMatch(/重置布局/);
    expect(
      container.querySelector('[data-testid="update-settings"]'),
    ).toBeNull();
    expect(
      container.querySelector('[aria-label="Open settings"]'),
    ).toBeTruthy();
  });
});
