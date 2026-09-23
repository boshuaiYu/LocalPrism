import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProductTour } from "@/components/product-tour";
import { useSettingsStore } from "@/stores/settings-store";

describe("ProductTour", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useSettingsStore.setState({ productTour: "pending", uiLanguage: "en" });
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
    useSettingsStore.setState({ productTour: "pending" });
  });

  function renderTour() {
    return act(async () => {
      root.render(
        <>
          <div data-tour="tour-projects">Projects</div>
          <ProductTour />
        </>,
      );
    });
  }

  it("shows once, then stays hidden after skip", async () => {
    await renderTour();
    expect(
      container.querySelector('[data-testid="product-tour"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Project navigation");

    const skip = container.querySelector('[data-testid="product-tour-skip"]');
    expect(skip).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      (skip as HTMLButtonElement).click();
    });

    expect(useSettingsStore.getState().productTour).toBe("skipped");
    expect(container.querySelector('[data-testid="product-tour"]')).toBeNull();

    await renderTour();
    expect(container.querySelector('[data-testid="product-tour"]')).toBeNull();
  });

  it("does not auto-show after the tour is completed", async () => {
    useSettingsStore.setState({ productTour: "completed" });
    await renderTour();
    expect(container.querySelector('[data-testid="product-tour"]')).toBeNull();
  });
});
