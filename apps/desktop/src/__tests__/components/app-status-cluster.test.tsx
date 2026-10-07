import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppStatusBar } from "@/components/app-status-cluster";
import { PRODUCT_TOUR_STEPS, findProductTourElement } from "@/lib/product-tour";
import { useSettingsStore } from "@/stores/settings-store";
import { resetUpdateStoreForTests } from "@/stores/update-store";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => "1.0.9-2"),
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

  it("keeps version and actions on one row, stacking only on a narrow pane", async () => {
    await act(async () => {
      root.render(<AppStatusBar />);
    });

    const bar = container.querySelector('[data-testid="app-status-bar"]');
    const row = container.querySelector('[data-testid="app-status-bar-row"]');
    const version = container.querySelector('[data-testid="app-version"]');
    const actions = container.querySelector(
      '[data-testid="app-status-actions"]',
    );
    expect(bar?.getAttribute("data-layout")).toBe("inline");
    expect(bar?.className).toContain("@container/status");
    expect(row?.className).toContain("flex");
    expect(row?.className).toContain("items-center");
    expect(row?.className).toContain("overflow-x-hidden");
    expect(row?.className).not.toMatch(/(^|\s)flex-col(\s|$)/);
    expect(row?.className).toContain("@max-[13.75rem]/status:flex-col");
    expect(version?.className).toContain("truncate");
    expect(version?.className).not.toContain("shrink-0");
    expect(version?.getAttribute("title")).toContain("LocalPrism");
    expect(actions?.className).toContain("ml-auto");
    expect(actions?.className).toContain("shrink-0");
    expect(actions?.className).toContain("@max-[13.75rem]/status:flex-wrap");
    expect(
      actions?.querySelector('[data-testid="beta-channel-toggle"]'),
    ).not.toBeNull();
    expect(
      actions?.querySelector('[data-testid="check-for-updates"]'),
    ).not.toBeNull();
  });
});
