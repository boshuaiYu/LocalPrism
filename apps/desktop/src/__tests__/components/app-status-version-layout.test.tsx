import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getVersion } from "@tauri-apps/api/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppStatusBar } from "@/components/app-status-cluster";
import { translate } from "@/lib/i18n";
import { useSettingsStore } from "@/stores/settings-store";
import {
  resetUpdateStoreForTests,
  useUpdateStore,
} from "@/stores/update-store";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => "1.0.8"),
}));

/** Content box of a ~210px sidebar footer once the actions have wrapped. */
const NARROW_CLUSTER_PX = 198;
const WIDE_CLUSTER_PX = 720;

function installClusterWidth(width: number, noticeScrollWidth?: number) {
  const original = globalThis.ResizeObserver;
  class WidthObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      Object.defineProperty(target, "clientWidth", {
        configurable: true,
        value: width,
      });
      if (noticeScrollWidth != null) {
        const notice = target.ownerDocument.querySelector(
          "[data-status-measure='notice']",
        );
        if (notice) {
          Object.defineProperty(notice, "scrollWidth", {
            configurable: true,
            value: noticeScrollWidth,
          });
        }
      }
      this.callback([], this);
    }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = WidthObserver as unknown as typeof ResizeObserver;
  return () => {
    globalThis.ResizeObserver = original;
  };
}

describe("AppStatusBar version hint layout", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetUpdateStoreForTests();
    useSettingsStore.setState({ uiLanguage: "zh" });
    vi.mocked(getVersion).mockResolvedValue("1.0.8");
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
    resetUpdateStoreForTests();
  });

  async function renderDismissedOffer(
    channel: "beta" | "stable",
    version: string,
  ) {
    useUpdateStore.setState({
      status: {
        state: "confirm",
        version,
        currentVersion: "1.0.8",
        channel,
        notes: "Notes",
      },
      dismissedOffer: null,
      offerDialogHidden: false,
    });
    await act(async () => {
      root.render(<AppStatusBar />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      useUpdateStore.getState().dismissOfferDialog();
    });
  }

  function expectFullLabels(versionText: string, hintText: string) {
    const version = container.querySelector('[data-testid="app-version"]');
    const hint = container.querySelector('[data-testid="update-flash"]');
    expect(version?.textContent).toBe(versionText);
    expect(hint?.textContent).toBe(hintText);
    expect(version?.className).not.toContain("truncate");
    expect(hint?.className).not.toContain("truncate");
    expect(hint).toBeInstanceOf(HTMLButtonElement);
    return { version, hint };
  }

  function expectActionsUntouched() {
    const actions = container.querySelector(
      '[data-testid="app-status-actions"]',
    );
    const cluster = container.querySelector(
      '[data-testid="app-status-version"]',
    );
    expect(actions?.className).toContain("shrink-0");
    expect(actions?.className).toContain("ml-auto");
    expect(cluster?.contains(actions)).toBe(false);
    expect(
      actions?.querySelector('[data-testid="language-switch"]'),
    ).not.toBeNull();
    expect(
      actions?.querySelector('[data-testid="beta-channel-toggle"]'),
    ).not.toBeNull();
    expect(
      actions?.querySelector('[data-testid="check-for-updates"]'),
    ).not.toBeNull();
  }

  it("shows the full beta version on its own line in a narrow sidebar", async () => {
    const restore = installClusterWidth(NARROW_CLUSTER_PX);
    try {
      await renderDismissedOffer("beta", "1.0.9beta2");

      const hintText = translate("zh", "updates.flashBeta", {
        version: "1.0.9beta2",
      });
      const { version, hint } = expectFullLabels("LocalPrism v1.0.8", hintText);
      const cluster = container.querySelector(
        '[data-testid="app-status-version"]',
      );
      expect(cluster?.getAttribute("data-layout")).toBe("stacked");
      expect(cluster?.className).toContain("flex-col");
      expect(version?.className).toContain("whitespace-nowrap");
      expect(hint?.className).toContain("whitespace-nowrap");
      expect(hint?.getAttribute("title")).toBe(
        translate("zh", "updates.betaAvailable", { version: "1.0.9beta2" }),
      );
      expectActionsUntouched();

      await act(async () => {
        useSettingsStore.setState({ uiLanguage: "en" });
      });
      const english = translate("en", "updates.flashBeta", {
        version: "1.0.9beta2",
      });
      expect(
        container.querySelector('[data-testid="update-flash"]')?.textContent,
      ).toBe(english);
      expect(
        container
          .querySelector('[data-testid="app-status-version"]')
          ?.getAttribute("data-layout"),
      ).toBe("stacked");
      expect(
        container.querySelector('[data-testid="update-flash"]')?.className,
      ).not.toContain("truncate");

      await act(async () => {
        const button = container.querySelector('[data-testid="update-flash"]');
        if (button instanceof HTMLButtonElement) button.click();
      });
      const dialog = document.body.querySelector(
        "[data-testid='update-available-dialog']",
      );
      expect(dialog?.getAttribute("data-phase")).toBe("confirm");
    } finally {
      restore();
    }
  });

  it("keeps a wide footer on a single line", async () => {
    const restore = installClusterWidth(WIDE_CLUSTER_PX);
    try {
      await renderDismissedOffer("stable", "1.0.9");
      const hintText = translate("zh", "updates.flashAvailable", {
        version: "1.0.9",
      });
      expectFullLabels("LocalPrism v1.0.8", hintText);
      const cluster = container.querySelector(
        '[data-testid="app-status-version"]',
      );
      expect(cluster?.getAttribute("data-layout")).toBe("inline");
      expect(cluster?.className).not.toMatch(/(^|\s)flex-col(\s|$)/);
      expect(cluster?.className).toContain("items-center");
      expectActionsUntouched();

      await act(async () => {
        useSettingsStore.setState({ uiLanguage: "en" });
      });
      expect(
        container.querySelector('[data-testid="update-flash"]')?.textContent,
      ).toBe(translate("en", "updates.flashAvailable", { version: "1.0.9" }));
      expect(
        container
          .querySelector('[data-testid="app-status-version"]')
          ?.getAttribute("data-layout"),
      ).toBe("inline");
    } finally {
      restore();
    }
  });

  it("keeps a long beta hint on one line when the footer is wide", async () => {
    const restore = installClusterWidth(WIDE_CLUSTER_PX);
    try {
      useSettingsStore.setState({ uiLanguage: "en" });
      await renderDismissedOffer("beta", "1.0.9beta2");
      expectFullLabels(
        "LocalPrism v1.0.8",
        translate("en", "updates.flashBeta", { version: "1.0.9beta2" }),
      );
      expect(
        container
          .querySelector('[data-testid="app-status-version"]')
          ?.getAttribute("data-layout"),
      ).toBe("inline");
    } finally {
      restore();
    }
  });

  it("stacks the hint when a runtime measurement is wider than the upper bound", async () => {
    const restore = installClusterWidth(WIDE_CLUSTER_PX, 2000);
    try {
      await renderDismissedOffer("stable", "1.0.9");
      const cluster = container.querySelector(
        '[data-testid="app-status-version"]',
      );
      expect(cluster?.getAttribute("data-layout")).toBe("stacked");
      const hint = container.querySelector('[data-testid="update-flash"]');
      expect(hint?.textContent).toBe(
        translate("zh", "updates.flashAvailable", { version: "1.0.9" }),
      );
      expect(hint?.className).not.toContain("truncate");
      expect(hint?.className).toContain("break-words");
    } finally {
      restore();
    }
  });
});
