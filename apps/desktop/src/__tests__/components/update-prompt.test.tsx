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
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "update_install_channel") return "native";
      if (command === "download_manifest_update") return "1.0.8beta3";
      if (command === "clear_prepared_update") return undefined;
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

  it("downloads a stable update from Latest and flashes restart text", async () => {
    const update = updateFixture();
    vi.mocked(check).mockResolvedValue(update as never);

    await renderBar();
    await act(async () => {
      await Promise.resolve();
    });

    expect(update.download).toHaveBeenCalledOnce();
    expect(update.install).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='update-prompt']")).toBeNull();
    const flash = container.querySelector("[data-testid='update-flash']");
    expect(flash?.textContent).toMatch(/Restart 9\.9\.9/);
    expect(flash?.className).toMatch(/lp-update-flash/);

    await act(async () => {
      if (flash instanceof HTMLButtonElement) flash.click();
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
    const flash = container.querySelector("[data-testid='update-flash']");
    expect(flash?.getAttribute("title")).toMatch(/deb or \.rpm/i);
    expect(container.textContent).not.toMatch(/Restart to update/);

    await act(async () => {
      if (flash instanceof HTMLButtonElement) flash.click();
    });
    expect(open).toHaveBeenCalledWith(
      "https://github.com/boshuaiYu/LocalPrism/releases/latest",
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
    expect(container.textContent).not.toContain("1.0.8beta2");
  });

  it("discovers v1.0.8beta3 from the tag manifest when Beta is on", async () => {
    useSettingsStore.setState({ joinBetaChannel: true });
    vi.mocked(check).mockResolvedValue(null);
    vi.mocked(getVersion).mockResolvedValue("1.0.8");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [
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
        ],
      })),
    );

    await renderBar();
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetch).toHaveBeenCalled();
    const flash = container.querySelector("[data-testid='update-flash']");
    expect(flash?.textContent).toContain("1.0.8beta3");
    expect(flash?.className).toMatch(/lp-update-flash/);
    expect(container.querySelector("[data-testid='update-prompt']")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith(
      "download_manifest_update",
      expect.anything(),
    );

    await act(async () => {
      if (flash instanceof HTMLButtonElement) flash.click();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith("download_manifest_update", {
      manifestUrl:
        "https://github.com/boshuaiYu/LocalPrism/releases/download/v1.0.8beta3/latest.json",
    });
    expect(container.textContent).toMatch(/Restart 1\.0\.8beta3/);
  });

  it("persists Join prerelease / Beta locally and defaults off", () => {
    expect(useSettingsStore.getState().joinBetaChannel).toBe(false);
    useSettingsStore.getState().setJoinBetaChannel(true);
    expect(useSettingsStore.getState().joinBetaChannel).toBe(true);
    const raw = localStorage.getItem("claude-prism-settings");
    expect(raw).toContain('"joinBetaChannel":true');
    expect(translate("zh", "updates.betaJoin")).toBe("加入预发布 / Beta");
    expect(translate("en", "updates.betaJoin")).toBe("Join prerelease / Beta");
  });
});
