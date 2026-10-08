import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { open } from "@tauri-apps/plugin-shell";
import { check } from "@tauri-apps/plugin-updater";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppStatusBar } from "@/components/app-status-cluster";
import { translate } from "@/lib/i18n";
import { useSettingsStore } from "@/stores/settings-store";
import { resetUpdateStoreForTests } from "@/stores/update-store";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => "1.0.0"),
}));

function updateFixture(overrides?: { failInstall?: boolean }) {
  return {
    version: "9.9.9",
    body: "Bug fixes",
    download: vi.fn(
      async (onEvent?: (event: { event: string; data: object }) => void) => {
        onEvent?.({
          event: "Started",
          data: { contentLength: 10 },
        });
        onEvent?.({ event: "Progress", data: { chunkLength: 10 } });
        onEvent?.({ event: "Finished", data: {} });
      },
    ),
    install: vi.fn(async () => {
      if (overrides?.failInstall) throw new Error("install failed");
    }),
    close: vi.fn(async () => undefined),
  };
}

let githubReleases: unknown = [];

describe("AppStatusBar updates", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetUpdateStoreForTests();
    vi.mocked(check).mockReset();
    vi.mocked(invoke).mockReset();
    vi.mocked(relaunch).mockReset();
    vi.mocked(open).mockReset();
    vi.mocked(getVersion).mockResolvedValue("1.0.0");
    githubReleases = [];
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "fetch_github_releases") return githubReleases;
      if (command === "update_install_channel") return "native";
      if (command === "download_manifest_update") return "1.0.8beta3";
      if (command === "verify_bound_updater_manifest") return "9.9.9";
      if (command === "clear_prepared_update") return undefined;
      if (command === "js_log") return undefined;
      return undefined;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [],
      })),
    );
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
    vi.unstubAllGlobals();
  });

  async function renderBar() {
    await act(async () => {
      root.render(<AppStatusBar />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  it("asks before a stable download and restarts from the footer when ready", async () => {
    const update = updateFixture();
    vi.mocked(check).mockResolvedValue(update as never);

    await renderBar();
    await act(async () => {
      await Promise.resolve();
    });

    expect(update.download).not.toHaveBeenCalled();
    expect(update.install).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='update-prompt']")).toBeNull();
    const dialog = document.body.querySelector(
      "[data-testid='update-available-dialog']",
    );
    expect(dialog?.getAttribute("data-channel")).toBe("stable");
    expect(dialog?.textContent).toContain(
      translate("en", "updates.availableTitle"),
    );
    expect(dialog?.textContent).toContain(
      translate("en", "updates.availableLine", {
        version: "9.9.9",
        current: "1.0.0",
      }),
    );
    expect(
      dialog?.querySelector("[data-testid='update-beta-badge']"),
    ).toBeNull();
    const flash = container.querySelector("[data-testid='update-flash']");
    expect(flash?.textContent).toMatch(/Update 9\.9\.9/);
    expect(flash).not.toBeInstanceOf(HTMLButtonElement);

    const download = dialog?.querySelector(
      "[data-testid='update-dialog-download']",
    );
    await act(async () => {
      if (download instanceof HTMLButtonElement) download.click();
      await Promise.resolve();
    });

    expect(update.download).toHaveBeenCalledOnce();
    const restart = container.querySelector("[data-testid='update-flash']");
    expect(restart?.textContent).toMatch(/Restart 9\.9\.9/);
    expect(restart?.className).toMatch(/lp-update-flash/);
    expect(
      document.body.querySelector("[data-testid='update-dialog-restart']"),
    ).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      if (restart instanceof HTMLButtonElement) restart.click();
      await Promise.resolve();
    });

    expect(update.install).toHaveBeenCalledOnce();
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it("does not download the AppImage over a deb or rpm install", async () => {
    const update = updateFixture();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "update_install_channel") return "linux-package";
      return undefined;
    });
    vi.mocked(check).mockResolvedValue(update as never);

    await renderBar();
    await act(async () => {
      await Promise.resolve();
    });

    expect(update.download).not.toHaveBeenCalled();
    expect(update.close).toHaveBeenCalledOnce();
    const dialog = document.body.querySelector(
      "[data-testid='update-available-dialog']",
    );
    expect(dialog?.getAttribute("data-phase")).toBe("manual");
    expect(
      dialog?.querySelector("[data-testid='update-dialog-download']"),
    ).toBeNull();
    expect(
      dialog?.querySelector("[data-testid='update-manual-note']")?.textContent,
    ).toMatch(/deb or \.rpm/i);
    const flash = container.querySelector("[data-testid='update-flash']");
    expect(flash?.getAttribute("title")).toMatch(/deb or \.rpm/i);
    expect(container.textContent).not.toMatch(/Restart to update/);

    await act(async () => {
      if (flash instanceof HTMLButtonElement) flash.click();
    });
    expect(open).toHaveBeenCalledWith(
      "https://github.com/boshuaiYu/LocalPrism/releases/tag/v9.9.9",
    );
  });

  it("replaces an empty platform manifest error with a short status", async () => {
    const raw =
      'None of the fallback platforms ["windows-x86_64-nsis", "windows-x86_64"] were found in the response platforms object';
    vi.mocked(check).mockRejectedValue(new Error(raw));

    await renderBar();
    const checkButton = container.querySelector(
      "[data-testid='check-for-updates']",
    );
    await act(async () => {
      if (checkButton instanceof HTMLButtonElement) checkButton.click();
      await Promise.resolve();
    });

    const flash = container.querySelector("[data-testid='update-flash']");
    expect(flash?.textContent).toBe(translate("en", "updates.flashMissing"));
    expect(flash?.getAttribute("title")).toBe(
      translate("en", "updates.missingPlatform"),
    );
    expect(container.textContent).not.toContain("fallback platforms");
    expect(container.textContent).not.toContain("were found in the response");
  });

  it("hides a prerelease that arrives on the stable endpoint when Beta is off", async () => {
    const update = updateFixture();
    update.version = "1.0.8beta2";
    vi.mocked(check).mockResolvedValue(update as never);

    await renderBar();
    await act(async () => {
      await Promise.resolve();
    });

    expect(useSettingsStore.getState().joinBetaChannel).toBe(false);
    expect(update.download).not.toHaveBeenCalled();
    expect(update.close).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='update-flash']")).toBeNull();
    expect(
      document.body.querySelector("[data-testid='update-available-dialog']"),
    ).toBeNull();
    expect(container.textContent).not.toContain("1.0.8beta2");
  });

  it("does not offer stable 1.0.8 when Beta is turned off on 1.0.8-6", async () => {
    const update = updateFixture();
    update.version = "1.0.8";
    vi.mocked(getVersion).mockResolvedValue("1.0.8-6");
    vi.mocked(check).mockResolvedValue(update as never);
    useSettingsStore.setState({ joinBetaChannel: true });

    await renderBar();
    await act(async () => {
      await Promise.resolve();
    });

    expect(update.download).not.toHaveBeenCalled();
    const toggle = container.querySelector(
      "[data-testid='beta-channel-toggle']",
    );
    await act(async () => {
      if (toggle instanceof HTMLButtonElement) toggle.click();
      await Promise.resolve();
    });

    expect(useSettingsStore.getState().joinBetaChannel).toBe(false);
    expect(vi.mocked(check).mock.calls.length).toBeGreaterThan(0);
    for (const call of vi.mocked(check).mock.calls) {
      expect(call[0]).toEqual({ allowDowngrades: true });
    }
    expect(update.download).not.toHaveBeenCalled();
    expect(update.close).toHaveBeenCalled();
    const flash = container.querySelector("[data-testid='update-flash']");
    expect(flash?.textContent).toBe(translate("en", "updates.flashCurrent"));
    expect(container.textContent).not.toContain(
      translate("en", "updates.manual", { version: "1.0.8" }),
    );
    expect(container.textContent).not.toMatch(/Restart 1\.0\.8/);
  });

  it("discovers v1.0.8beta3 from the tag manifest when Beta is on", async () => {
    useSettingsStore.setState({ joinBetaChannel: true });
    vi.mocked(check).mockResolvedValue(null);
    vi.mocked(getVersion).mockResolvedValue("1.0.8");
    githubReleases = [
      {
        tag_name: "v1.0.8beta3",
        prerelease: true,
        draft: false,
        body: "preview",
        assets: [
          {
            name: "latest.json",
            browser_download_url:
              "https://github.com/boshuaiYu/LocalPrism/releases/latest/download/latest.json",
          },
        ],
      },
    ];

    await renderBar();
    await act(async () => {
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith("fetch_github_releases");
    expect(fetch).not.toHaveBeenCalled();
    const flash = container.querySelector("[data-testid='update-flash']");
    expect(flash?.textContent).toContain("1.0.8beta3");
    expect(flash?.className).toMatch(/lp-update-flash/);
    expect(container.querySelector("[data-testid='update-prompt']")).toBeNull();
    const dialog = document.body.querySelector(
      "[data-testid='update-available-dialog']",
    );
    expect(dialog?.getAttribute("data-channel")).toBe("beta");
    expect(
      dialog?.querySelector("[data-testid='update-beta-badge']"),
    ).not.toBeNull();
    expect(invoke).not.toHaveBeenCalledWith(
      "download_manifest_update",
      expect.anything(),
    );

    const download = dialog?.querySelector(
      "[data-testid='update-dialog-download']",
    );
    await act(async () => {
      if (download instanceof HTMLButtonElement) download.click();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith("download_manifest_update", {
      manifestUrl:
        "https://github.com/boshuaiYu/LocalPrism/releases/download/v1.0.8beta3/latest.json",
    });
    expect(container.textContent).toMatch(/Restart 1\.0\.8beta3/);
  });

  it("shows the beta install error and does not check for updates again", async () => {
    const installError =
      "temp directory is not on the same mount point as the AppImage";
    useSettingsStore.setState({ joinBetaChannel: true });
    vi.mocked(check).mockResolvedValue(null);
    vi.mocked(getVersion).mockResolvedValue("1.0.8");
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "fetch_github_releases") {
        return [
          {
            tag_name: "v1.0.8beta9",
            prerelease: true,
            draft: false,
            body: "preview",
            assets: [{ name: "latest.json" }],
          },
        ];
      }
      if (command === "update_install_channel") return "appimage";
      if (command === "download_manifest_update") return "1.0.8beta9";
      if (command === "install_prepared_update") throw installError;
      if (command === "js_log") return undefined;
      if (command === "clear_prepared_update") return undefined;
      return undefined;
    });

    await renderBar();
    await act(async () => {
      await Promise.resolve();
    });

    const offer = document.body.querySelector(
      "[data-testid='update-dialog-download']",
    );
    await act(async () => {
      if (offer instanceof HTMLButtonElement) offer.click();
      await Promise.resolve();
    });
    expect(container.textContent).toMatch(/Restart 1\.0\.8beta9/);
    const checksBeforeRestart = vi.mocked(check).mock.calls.length;
    expect(checksBeforeRestart).toBeGreaterThan(0);

    const restart = container.querySelector("[data-testid='update-flash']");
    await act(async () => {
      if (restart instanceof HTMLButtonElement) restart.click();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith("install_prepared_update");
    expect(vi.mocked(check).mock.calls.length).toBe(checksBeforeRestart);
    expect(relaunch).not.toHaveBeenCalled();
    const flash = container.querySelector("[data-testid='update-flash']");
    expect(flash?.textContent).toBe(installError);
    expect(flash?.getAttribute("title")).toBe(installError);
    expect(flash?.textContent).not.toBe(translate("en", "updates.flashError"));
    expect(invoke).toHaveBeenCalledWith(
      "js_log",
      expect.objectContaining({
        msg: expect.stringContaining(installError),
      }),
    );
  });

  it("shows a download failure instead of the check-failed label", async () => {
    const update = updateFixture();
    update.download = vi.fn(async () => {
      throw new Error("network dropped");
    });
    vi.mocked(check).mockResolvedValue(update as never);

    await renderBar();
    const download = document.body.querySelector(
      "[data-testid='update-dialog-download']",
    );
    await act(async () => {
      if (download instanceof HTMLButtonElement) download.click();
      await Promise.resolve();
    });

    const flash = container.querySelector("[data-testid='update-flash']");
    expect(flash?.textContent).toBe("network dropped");
    expect(flash?.textContent).not.toBe(translate("en", "updates.flashError"));
  });

  it("keeps a failed update check on the check-failed label", async () => {
    vi.mocked(check).mockRejectedValue(new Error("signature mismatch"));

    await renderBar();
    const checkButton = container.querySelector(
      "[data-testid='check-for-updates']",
    );
    await act(async () => {
      if (checkButton instanceof HTMLButtonElement) checkButton.click();
      await Promise.resolve();
    });

    const flash = container.querySelector("[data-testid='update-flash']");
    expect(flash?.textContent).toBe(translate("en", "updates.flashError"));
    expect(flash?.getAttribute("title")).toContain("signature mismatch");
  });

  it("does not show a failed update check when Beta is turned on and the release list is empty", async () => {
    vi.mocked(check).mockRejectedValue(new Error("signature mismatch"));

    await renderBar();
    const toggle = container.querySelector(
      "[data-testid='beta-channel-toggle']",
    );
    await act(async () => {
      if (toggle instanceof HTMLButtonElement) toggle.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(useSettingsStore.getState().joinBetaChannel).toBe(true);
    expect(invoke).toHaveBeenCalledWith("fetch_github_releases");
    expect(fetch).not.toHaveBeenCalled();
    for (const call of vi.mocked(check).mock.calls) {
      expect(call[0]).toEqual({ allowDowngrades: true });
    }
    const flash = container.querySelector("[data-testid='update-flash']");
    expect(flash?.textContent ?? "").not.toBe(
      translate("en", "updates.flashError"),
    );
    expect(container.textContent).not.toContain(
      translate("en", "updates.flashError"),
    );
    expect(container.textContent).not.toContain(
      translate("en", "updates.flashCurrent"),
    );
  });

  it("persists Join prerelease / Beta locally and defaults off", () => {
    expect(useSettingsStore.getState().joinBetaChannel).toBe(false);
    useSettingsStore.getState().setJoinBetaChannel(true);
    expect(useSettingsStore.getState().joinBetaChannel).toBe(true);
    const raw = localStorage.getItem("claude-prism-settings");
    expect(raw).toContain('"joinBetaChannel":true');
    expect(translate("zh", "updates.betaJoin")).toBe("加入预发布 / Beta");
    expect(translate("en", "updates.betaJoin")).toBe("Join prerelease / Beta");
    expect(translate("zh", "updates.betaJoined")).toBe(
      "已在 Beta 频道 — 点击退出",
    );
    expect(translate("en", "updates.betaJoined")).toBe(
      "On Beta channel — click to leave",
    );
  });

  it("shows a leave tooltip after the Beta channel is joined", async () => {
    vi.mocked(check).mockResolvedValue(null);
    useSettingsStore.setState({ joinBetaChannel: false, uiLanguage: "en" });

    await renderBar();
    const toggle = container.querySelector(
      "[data-testid='beta-channel-toggle']",
    );
    expect(toggle?.getAttribute("title")).toBe(
      translate("en", "updates.betaJoin"),
    );
    expect(toggle?.getAttribute("aria-label")).toBe(
      translate("en", "updates.betaJoin"),
    );

    useSettingsStore.setState({ joinBetaChannel: true });
    await act(async () => {
      await Promise.resolve();
    });
    const joined = container.querySelector(
      "[data-testid='beta-channel-toggle']",
    );
    expect(joined?.getAttribute("title")).toBe(
      translate("en", "updates.betaJoined"),
    );
    expect(joined?.getAttribute("aria-label")).toBe(
      translate("en", "updates.betaJoined"),
    );

    useSettingsStore.setState({ uiLanguage: "zh" });
    await act(async () => {
      await Promise.resolve();
    });
    const joinedZh = container.querySelector(
      "[data-testid='beta-channel-toggle']",
    );
    expect(joinedZh?.getAttribute("title")).toBe(
      translate("zh", "updates.betaJoined"),
    );
    expect(joinedZh?.getAttribute("aria-label")).toBe(
      translate("zh", "updates.betaJoined"),
    );
  });
});
