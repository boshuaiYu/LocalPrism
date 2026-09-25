import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { Sidebar } from "@/components/workspace/sidebar";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("1.9.0"),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

async function waitForTourAnchor(anchor: string): Promise<Element | null> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const node = document.body.querySelector(`[data-tour="${anchor}"]`);
    if (node) return node;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  return document.body.querySelector(`[data-tour="${anchor}"]`);
}

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
    vi.mocked(invoke).mockReset();
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

  it("mounts skills and agents anchors and closes panels the tour opened", async () => {
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

    const skills = container.querySelector('[data-tour="tour-skills"]');
    const agents = container.querySelector('[data-tour="tour-agents-open"]');
    expect(skills).toBeInstanceOf(HTMLButtonElement);
    expect(agents).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("localprism-product-tour", { detail: "open-agents" }),
      );
    });
    const list = document.body.querySelector('[data-tour="tour-agent-list"]');
    expect(list).not.toBeNull();
    expect(document.body.textContent).toContain("论文抛光机");
    expect(document.body.textContent).toContain("AI消除器");
    expect(document.body.textContent).toContain("毒舌审稿官");

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("localprism-product-tour", {
          detail: "close-overlays",
        }),
      );
    });
    expect(
      document.body.querySelector('[data-tour="tour-agent-list"]'),
    ).toBeNull();

    vi.mocked(invoke).mockImplementation(() => Promise.resolve([]));
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("localprism-product-tour", { detail: "open-skills" }),
      );
    });
    const categories = await waitForTourAnchor("tour-skill-categories");
    expect(categories).not.toBeNull();
    expect(
      document.body.querySelector('[data-tour="tour-skill-import"]'),
    ).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("localprism-product-tour", {
          detail: "close-overlays",
        }),
      );
    });
    expect(
      document.body.querySelector('[data-tour="tour-skill-categories"]'),
    ).toBeNull();
  });
});
