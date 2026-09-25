import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppStatusBar } from "@/components/app-status-cluster";
import { PRODUCT_TOUR_STEPS, findProductTourElement } from "@/lib/product-tour";
import { useSettingsStore } from "@/stores/settings-store";
import { resetUpdateStoreForTests } from "@/stores/update-store";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => "1.9.0"),
}));

describe("AppStatusBar tour anchor", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetUpdateStoreForTests();
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
      root.render(<AppStatusBar />);
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
