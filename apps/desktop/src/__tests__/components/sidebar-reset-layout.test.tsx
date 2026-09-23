import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "@/components/workspace/sidebar";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("1.0.4"),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

describe("Sidebar reset layout", () => {
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

  it("exposes a one-click reset outside the layout menu", async () => {
    const onResetLayout = vi.fn();
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
            onResetLayout,
            layoutResetKey: 0,
          }}
        />,
      ),
    );

    const resets = Array.from(
      container.querySelectorAll('[data-testid="reset-workspace-layout"]'),
    ).filter((node) => !node.closest('[aria-hidden="true"]'));
    expect(resets).toHaveLength(1);
    const button = resets[0];
    expect(button).toBeInstanceOf(HTMLButtonElement);
    expect(button?.textContent).toMatch(/Reset layout/);
    expect(button?.closest("[data-radix-hover-card-content]")).toBeNull();

    await act(async () => (button as HTMLButtonElement).click());
    expect(onResetLayout).toHaveBeenCalledTimes(1);
  });
});
