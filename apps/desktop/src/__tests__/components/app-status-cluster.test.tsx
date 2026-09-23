import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppStatusCluster } from "@/components/app-status-cluster";
import { PRODUCT_TOUR_STEPS, findProductTourElement } from "@/lib/product-tour";
import { useSettingsStore } from "@/stores/settings-store";

describe("AppStatusCluster tour anchor", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useSettingsStore.setState({ uiLanguage: "en" });
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

  it("puts the tour hotspot on the check-update button", async () => {
    await act(async () => {
      root.render(<AppStatusCluster version="1.0.8-2" />);
    });

    const check = container.querySelector('[data-testid="check-for-updates"]');
    const language = container.querySelector('[data-testid="language-switch"]');
    expect(check).toBeInstanceOf(HTMLButtonElement);
    expect(check?.getAttribute("data-tour")).toBe("tour-updates");
    expect(language?.getAttribute("data-tour")).toBeNull();
    expect(
      container.querySelectorAll('[data-tour="tour-updates"]'),
    ).toHaveLength(1);

    const button = check as HTMLButtonElement;
    button.getBoundingClientRect = () =>
      ({
        x: 8,
        y: 8,
        top: 8,
        left: 8,
        right: 56,
        bottom: 32,
        width: 48,
        height: 24,
        toJSON() {
          return {};
        },
      }) as DOMRect;
    const step = PRODUCT_TOUR_STEPS.find((item) => item.id === "updates");
    expect(findProductTourElement(step!)).toBe(button);
  });
});
