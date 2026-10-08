import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { check } from "@tauri-apps/plugin-updater";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppStatusBar } from "@/components/app-status-cluster";
import { translate } from "@/lib/i18n";
import { useSettingsStore } from "@/stores/settings-store";
import {
  resetUpdateStoreForTests,
  useUpdateStore,
} from "@/stores/update-store";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => "0.5.77"),
}));

const RELEASE_NOTES = [
  "## 新功能",
  "",
  "- 数据传输支持按表设置传输条件",
  "- [发布说明](https://github.com/boshuaiYu/LocalPrism/releases/tag/v1.2.0)",
].join("\n");

function updateFixture(overrides?: { version?: string; body?: string }) {
  return {
    version: overrides?.version ?? "1.2.0",
    body: overrides && "body" in overrides ? overrides.body : RELEASE_NOTES,
    currentVersion: "0.5.77",
    download: vi.fn(async () => undefined),
    install: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

let githubReleases: unknown = [];

describe("UpdateAvailableDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetUpdateStoreForTests();
    useSettingsStore.setState({ uiLanguage: "en", joinBetaChannel: false });
    vi.mocked(check).mockReset();
    vi.mocked(invoke).mockReset();
    vi.mocked(open).mockReset();
    vi.mocked(getVersion).mockResolvedValue("0.5.77");
    githubReleases = [];
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "fetch_github_releases") return githubReleases;
      if (command === "update_install_channel") return "native";
      if (command === "verify_bound_updater_manifest") return "1.2.0";
      if (command === "clear_prepared_update") return undefined;
      if (command === "js_log") return undefined;
      return undefined;
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
    document.body.querySelector("[role='dialog']")?.remove();
    resetUpdateStoreForTests();
    useSettingsStore.setState({ uiLanguage: "en", joinBetaChannel: false });
  });

  async function renderBar() {
    await act(async () => {
      root.render(<AppStatusBar />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  function dialog(): HTMLElement | null {
    const node = document.body.querySelector(
      "[data-testid='update-available-dialog']",
    );
    return node instanceof HTMLElement ? node : null;
  }

  it("opens on a stable offer and renders release notes", async () => {
    const update = updateFixture();
    vi.mocked(check).mockResolvedValue(update as never);

    await renderBar();

    const offer = dialog();
    expect(offer?.getAttribute("data-phase")).toBe("confirm");
    expect(offer?.getAttribute("data-channel")).toBe("stable");
    expect(offer?.textContent).toContain(
      translate("en", "updates.availableTitle"),
    );
    expect(offer?.textContent).toContain(
      translate("en", "updates.availableLine", {
        version: "1.2.0",
        current: "0.5.77",
      }),
    );
    expect(
      offer?.querySelector("[data-testid='update-beta-badge']"),
    ).toBeNull();
    const notes = offer?.querySelector("[data-testid='update-release-notes']");
    expect(notes?.querySelector("h2")?.textContent).toBe("新功能");
    expect(notes?.querySelector("li")?.textContent).toContain("数据传输");
    expect(update.download).not.toHaveBeenCalled();

    const link = offer?.querySelector("[data-testid='update-release-link']");
    expect(link).toBeInstanceOf(HTMLAnchorElement);
    expect(link?.getAttribute("href")).toBe(
      "https://github.com/boshuaiYu/LocalPrism/releases/tag/v1.2.0",
    );
    const before = window.location.href;
    await act(async () => {
      if (link instanceof HTMLAnchorElement) link.click();
    });
    expect(window.location.href).toBe(before);
    expect(open).toHaveBeenCalledWith(
      "https://github.com/boshuaiYu/LocalPrism/releases/tag/v1.2.0",
    );
    expect(update.download).not.toHaveBeenCalled();
  });

  it("shows Chinese copy and a short fallback when notes are empty", async () => {
    useSettingsStore.setState({ uiLanguage: "zh" });
    const update = updateFixture({ body: "   " });
    vi.mocked(check).mockResolvedValue(update as never);

    await renderBar();

    const offer = dialog();
    expect(offer?.textContent).toContain(
      translate("zh", "updates.availableTitle"),
    );
    expect(offer?.textContent).toContain(
      translate("zh", "updates.availableLine", {
        version: "1.2.0",
        current: "0.5.77",
      }),
    );
    expect(
      offer?.querySelector("[data-testid='update-release-notes']"),
    ).toBeNull();
    expect(
      offer?.querySelector("[data-testid='update-notes-empty']")?.textContent,
    ).toBe(translate("zh", "updates.notesEmpty"));
    expect(
      offer?.querySelector("[data-testid='update-dialog-cancel']")?.textContent,
    ).toBe("取消");
    expect(
      offer?.querySelector("[data-testid='update-dialog-open-page']")
        ?.textContent,
    ).toBe("打开下载页");
    expect(
      offer?.querySelector("[data-testid='update-dialog-download']")
        ?.textContent,
    ).toBe("下载并安装");
  });

  it("marks a beta offer and does not show one while Beta is off", async () => {
    const hidden = updateFixture({ version: "1.2.0beta1", body: "preview" });
    vi.mocked(check).mockResolvedValue(hidden as never);

    await renderBar();
    expect(dialog()).toBeNull();
    expect(hidden.download).not.toHaveBeenCalled();

    useSettingsStore.setState({ joinBetaChannel: true });
    githubReleases = [
      {
        tag_name: "v1.2.0beta4",
        prerelease: true,
        draft: false,
        body: "## Preview\n\n- newer beta",
        assets: [
          {
            name: "latest.json",
            browser_download_url:
              "https://github.com/boshuaiYu/LocalPrism/releases/download/v1.2.0beta4/latest.json",
          },
        ],
      },
    ];
    const checkButton = container.querySelector(
      "[data-testid='check-for-updates']",
    );
    await act(async () => {
      if (checkButton instanceof HTMLButtonElement) checkButton.click();
      await Promise.resolve();
    });

    const offer = dialog();
    expect(offer?.getAttribute("data-channel")).toBe("beta");
    expect(
      offer?.querySelector("[data-testid='update-beta-badge']")?.textContent,
    ).toBe("Beta");
    expect(offer?.textContent).toContain("1.2.0beta4");
    expect(offer?.textContent).toContain("0.5.77");
    expect(hidden.download).not.toHaveBeenCalled();
  });

  it("opens the exact release page and starts download only from the primary button", async () => {
    const update = updateFixture();
    vi.mocked(check).mockResolvedValue(update as never);
    await renderBar();

    const page = dialog()?.querySelector(
      "[data-testid='update-dialog-open-page']",
    );
    await act(async () => {
      if (page instanceof HTMLButtonElement) page.click();
    });
    expect(open).toHaveBeenCalledWith(
      "https://github.com/boshuaiYu/LocalPrism/releases/tag/v1.2.0",
    );
    expect(update.download).not.toHaveBeenCalled();
    expect(dialog()?.getAttribute("data-phase")).toBe("confirm");

    const download = dialog()?.querySelector(
      "[data-testid='update-dialog-download']",
    );
    await act(async () => {
      if (download instanceof HTMLButtonElement) download.click();
      await Promise.resolve();
    });
    expect(update.download).toHaveBeenCalledOnce();
    expect(dialog()?.getAttribute("data-phase")).toBe("ready");
    expect(
      dialog()?.querySelector("[data-testid='update-dialog-restart']"),
    ).toBeInstanceOf(HTMLButtonElement);
  });

  it("shows download progress in the dialog, then offers restart", async () => {
    let releaseDownload: (() => void) | null = null;
    const update = updateFixture();
    update.download = vi.fn(
      async (onEvent?: (event: { event: string; data: object }) => void) => {
        onEvent?.({ event: "Started", data: { contentLength: 10 } });
        onEvent?.({ event: "Progress", data: { chunkLength: 4 } });
        await new Promise<void>((resolve) => {
          releaseDownload = resolve;
        });
      },
    );
    vi.mocked(check).mockResolvedValue(update as never);
    await renderBar();

    const download = dialog()?.querySelector(
      "[data-testid='update-dialog-download']",
    );
    await act(async () => {
      if (download instanceof HTMLButtonElement) download.click();
    });

    expect(dialog()?.getAttribute("data-phase")).toBe("downloading");
    expect(
      dialog()?.querySelector("[data-testid='update-download-progress']"),
    ).not.toBeNull();
    expect(
      dialog()?.querySelector("[data-testid='update-dialog-download']")
        ?.textContent,
    ).toBe(
      translate("en", "updates.dialogDownloadingPercent", { percent: 40 }),
    );
    expect(
      dialog()?.querySelector("[data-testid='update-dialog-cancel']"),
    ).toBeNull();

    await act(async () => {
      releaseDownload?.();
      await Promise.resolve();
    });
    expect(dialog()?.getAttribute("data-phase")).toBe("ready");
    expect(
      dialog()?.querySelector("[data-testid='update-dialog-restart']")
        ?.textContent,
    ).toBe(translate("en", "updates.restart"));
  });

  it("keeps a manual package on the download page without install", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "update_install_channel") return "linux-package";
      if (command === "verify_bound_updater_manifest") return "1.2.0";
      if (command === "js_log") return undefined;
      return undefined;
    });
    const update = updateFixture();
    vi.mocked(check).mockResolvedValue(update as never);

    await renderBar();

    const offer = dialog();
    expect(offer?.getAttribute("data-phase")).toBe("manual");
    expect(
      offer?.querySelector("[data-testid='update-dialog-download']"),
    ).toBeNull();
    expect(
      offer?.querySelector("[data-testid='update-manual-note']")?.textContent,
    ).toMatch(/deb or \.rpm/i);
    expect(update.download).not.toHaveBeenCalled();

    const page = offer?.querySelector(
      "[data-testid='update-dialog-open-page']",
    );
    await act(async () => {
      if (page instanceof HTMLButtonElement) page.click();
    });
    expect(open).toHaveBeenCalledWith(
      "https://github.com/boshuaiYu/LocalPrism/releases/tag/v1.2.0",
    );
    expect(update.download).not.toHaveBeenCalled();
  });

  it("treats Cancel, the close button, and Esc as no download", async () => {
    const update = updateFixture();
    vi.mocked(check).mockResolvedValue(update as never);
    await renderBar();

    const cancel = dialog()?.querySelector(
      "[data-testid='update-dialog-cancel']",
    );
    await act(async () => {
      if (cancel instanceof HTMLButtonElement) cancel.click();
    });
    expect(dialog()).toBeNull();
    expect(update.download).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().status).toEqual({ state: "idle" });
  });

  it("closes from the corner button and Escape without downloading", async () => {
    const update = updateFixture();
    vi.mocked(check).mockResolvedValue(update as never);
    await renderBar();

    const close = dialog()?.querySelector(
      "[data-testid='update-dialog-close']",
    );
    await act(async () => {
      if (close instanceof HTMLButtonElement) close.click();
    });
    expect(dialog()).toBeNull();
    expect(update.download).not.toHaveBeenCalled();

    await act(async () => {
      await useUpdateStore.getState().checkForUpdate({ explicit: true });
    });
    expect(dialog()).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(dialog()).toBeNull();
    expect(update.download).not.toHaveBeenCalled();
  });

  it("does not reopen a cancelled version on the next automatic check", async () => {
    const update = updateFixture();
    vi.mocked(check).mockResolvedValue(update as never);
    await renderBar();
    expect(dialog()).not.toBeNull();

    await act(async () => {
      const cancel = dialog()?.querySelector(
        "[data-testid='update-dialog-cancel']",
      );
      if (cancel instanceof HTMLButtonElement) cancel.click();
    });
    expect(dialog()).toBeNull();

    await act(async () => {
      await useUpdateStore.getState().checkForUpdate({ explicit: false });
    });
    expect(dialog()).toBeNull();
    expect(update.download).not.toHaveBeenCalled();

    const checkButton = container.querySelector(
      "[data-testid='check-for-updates']",
    );
    await act(async () => {
      if (checkButton instanceof HTMLButtonElement) checkButton.click();
      await Promise.resolve();
    });
    expect(dialog()?.getAttribute("data-phase")).toBe("confirm");
    expect(dialog()?.textContent).toContain("1.2.0");
    expect(update.download).not.toHaveBeenCalled();
  });
});
