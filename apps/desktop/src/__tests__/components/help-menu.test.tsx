import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HelpMenu } from "@/components/help-menu";
import { ProductTour } from "@/components/product-tour";
import {
  isProductTourReplayRequested,
  resetProductTourReplayForTests,
} from "@/lib/product-tour";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";

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
    useSettingsStore.setState({ uiLanguage: "en", productTour: "pending" });
    document.body
      .querySelectorAll("[data-slot='dropdown-menu-content']")
      .forEach((node) => node.remove());
  });

  async function renderMenu() {
    await act(async () => {
      root.render(<HelpMenu />);
    });
  }

  it("disables the tour when no project is open and does not queue it", async () => {
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
    expect(item?.getAttribute("aria-disabled")).toBe("true");
    expect(item?.getAttribute("data-disabled")).not.toBeNull();
    const hint = document.body.querySelector('[data-testid="help-tour-hint"]');
    expect(hint?.textContent).toBe("Open a project to take the tour.");
    expect(item?.parentElement?.getAttribute("title")).toBe(
      "Open a project to take the tour.",
    );
    const menu = item?.closest("[data-slot='dropdown-menu-content']");
    expect(menu?.className).toContain("bg-popover");
    expect(menu?.className).toContain("text-popover-foreground");

    await act(async () => {
      (item as HTMLElement).click();
    });
    expect(isProductTourReplayRequested()).toBe(false);
    expect(useSettingsStore.getState().productTour).toBe("completed");

    await act(async () => {
      root.render(
        <>
          <div data-tour="tour-files">Files</div>
          <ProductTour />
        </>,
      );
    });
    expect(document.body.querySelector('[data-testid="product-tour"]')).toBe(
      null,
    );
    expect(useSettingsStore.getState().productTour).toBe("completed");
  });

  it("uses the Chinese hint while the tour stays disabled", async () => {
    useSettingsStore.setState({ uiLanguage: "zh" });
    await renderMenu();
    const button = container.querySelector('[data-testid="help-menu"]');
    await act(async () => {
      openMenu(button as HTMLButtonElement);
    });
    const item = document.body.querySelector('[data-testid="help-take-tour"]');
    expect(item?.textContent).toBe("查看引导");
    expect(item?.getAttribute("aria-disabled")).toBe("true");
    expect(button?.getAttribute("aria-label")).toBe("帮助");
    expect(
      document.body.querySelector('[data-testid="help-tour-hint"]')
        ?.textContent,
    ).toBe("打开项目后可查看引导");
    expect(isProductTourReplayRequested()).toBe(false);
    expect(useSettingsStore.getState().productTour).toBe("completed");
  });

  it("starts the existing tour inside an open project", async () => {
    useDocumentStore.setState({ projectRoot: "/paper" });
    await renderMenu();

    const button = container.querySelector('[data-testid="help-menu"]');
    await act(async () => {
      openMenu(button as HTMLButtonElement);
    });
    const item = document.body.querySelector('[data-testid="help-take-tour"]');
    expect(item?.getAttribute("aria-disabled")).not.toBe("true");
    expect(
      document.body.querySelector('[data-testid="help-tour-hint"]'),
    ).toBeNull();

    await act(async () => {
      (item as HTMLElement).click();
    });
    expect(isProductTourReplayRequested()).toBe(true);
    expect(useSettingsStore.getState().productTour).toBe("completed");
  });
});
