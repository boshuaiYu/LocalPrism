import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HelpMenu } from "@/components/help-menu";
import {
  isProductTourReplayRequested,
  resetProductTourReplayForTests,
} from "@/lib/product-tour";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";

const toastMessage = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    message: (...args: unknown[]) => toastMessage(...args),
  },
}));

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

describe("HelpMenu", () => {
  let container: HTMLDivElement;
  let root: Root;
  let projectRoot: string | null;

  beforeEach(() => {
    resetProductTourReplayForTests();
    toastMessage.mockReset();
    projectRoot = useDocumentStore.getState().projectRoot;
    useDocumentStore.setState({ projectRoot: null });
    useSettingsStore.setState({ uiLanguage: "en", productTour: "completed" });
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
    resetProductTourReplayForTests();
    useDocumentStore.setState({ projectRoot });
    useSettingsStore.setState({ uiLanguage: "en" });
    document.body
      .querySelectorAll("[data-slot='dropdown-menu-content']")
      .forEach((node) => node.remove());
  });

  async function renderMenu() {
    await act(async () => {
      root.render(<HelpMenu />);
    });
  }

  it("opens a help menu and queues the existing tour", async () => {
    await renderMenu();
    const button = container.querySelector('[data-testid="help-menu"]');
    expect(button).toBeInstanceOf(HTMLButtonElement);
    expect(button?.getAttribute("aria-label")).toBe("Help");
    expect(button?.getAttribute("data-variant")).toBe("ghost");
    expect(button?.className).toContain("dark:hover:bg-accent/50");
    expect(button?.className).not.toMatch(/bg-white|text-black/);

    await act(async () => {
      openMenu(button as HTMLButtonElement);
    });
    const item = document.body.querySelector('[data-testid="help-take-tour"]');
    expect(item?.textContent).toBe("Take a tour");
    const menu = item?.closest("[data-slot='dropdown-menu-content']");
    expect(menu?.className).toContain("bg-popover");
    expect(menu?.className).toContain("text-popover-foreground");

    await act(async () => {
      (item as HTMLElement).click();
    });
    expect(isProductTourReplayRequested()).toBe(true);
    expect(toastMessage).toHaveBeenCalledWith(
      "Open a project to start the tour.",
    );
    expect(useSettingsStore.getState().productTour).toBe("completed");
  });

  it("uses the Chinese label and does not toast inside a project", async () => {
    useSettingsStore.setState({ uiLanguage: "zh" });
    useDocumentStore.setState({ projectRoot: "/paper" });
    await renderMenu();

    const button = container.querySelector('[data-testid="help-menu"]');
    await act(async () => {
      openMenu(button as HTMLButtonElement);
    });
    const item = document.body.querySelector('[data-testid="help-take-tour"]');
    expect(item?.textContent).toBe("查看引导");
    expect(button?.getAttribute("aria-label")).toBe("帮助");

    await act(async () => {
      (item as HTMLElement).click();
    });
    expect(isProductTourReplayRequested()).toBe(true);
    expect(toastMessage).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().productTour).toBe("completed");
  });
});
