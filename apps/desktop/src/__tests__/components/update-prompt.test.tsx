import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { open } from "@tauri-apps/plugin-shell";
import { check } from "@tauri-apps/plugin-updater";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdatePrompt, UpdateSettings } from "@/components/update-prompt";
import { translate } from "@/lib/i18n";
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

describe("UpdatePrompt", () => {
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
      if (command === "download_manifest_update") return "1.0.8-1";
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

  async function renderPrompt() {
    await act(async () => {
      root.render(<UpdatePrompt />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  it("downloads in the background and waits for restart", async () => {
    const update = updateFixture();
    vi.mocked(check).mockResolvedValue(update as never);

    await renderPrompt();
    await act(async () => {
      await Promise.resolve();
    });

    expect(update.download).toHaveBeenCalledOnce();
    expect(update.install).not.toHaveBeenCalled();
    expect(container.textContent).toMatch(/Restart to install/i);
    const banner = container.querySelector("[data-testid='update-prompt']");
    expect(banner?.className).not.toMatch(/\bfixed\b/);
    expect(banner?.className).not.toMatch(/\bbottom-4\b/);

    const restart = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Restart to update",
    );
    await act(async () => {
      restart?.click();
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

    await renderPrompt();
    await act(async () => {
      await Promise.resolve();
    });

    expect(update.download).not.toHaveBeenCalled();
    expect(update.close).toHaveBeenCalledOnce();
    expect(container.textContent).toMatch(/deb or \.rpm/i);
    expect(container.textContent).not.toMatch(/Restart to update/);

    const releases = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "View releases",
    );
    await act(async () => {
      releases?.click();
    });
    expect(open).toHaveBeenCalledWith(
      "https://github.com/boshuaiYu/LocalPrism/releases/latest",
    );
  });

  it("replaces an empty platform manifest error with a localized explanation", async () => {
    const raw =
      'None of the fallback platforms ["windows-x86_64-nsis", "windows-x86_64"] were found in the response platforms object';
    vi.mocked(check).mockRejectedValue(new Error(raw));

    await act(async () => {
      root.render(<UpdateSettings />);
    });
    const checkButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Check for updates",
    );
    await act(async () => {
      checkButton?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      translate("en", "updates.missingPlatform"),
    );
    expect(container.textContent).not.toContain("fallback platforms");
    expect(container.textContent).not.toContain("were found in the response");
  });

  it("asks before downloading a prerelease from the stable endpoint", async () => {
    const update = updateFixture();
    update.version = "1.0.8-1";
    vi.mocked(check).mockResolvedValue(update as never);

    await renderPrompt();
    await act(async () => {
      await Promise.resolve();
    });

    expect(update.download).not.toHaveBeenCalled();
    expect(container.textContent).toContain("1.0.8-1");
    expect(container.textContent).toContain(
      translate("en", "updates.download"),
    );
    expect(translate("zh", "updates.download")).toBe("下载");
    expect(translate("zh", "updates.later")).toBe("稍后");
    expect(
      translate("zh", "updates.betaAvailable", { version: "1.0.8-1" }),
    ).toContain("1.0.8-1");

    const download = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Download",
    );
    await act(async () => {
      download?.click();
      await Promise.resolve();
    });

    expect(update.download).toHaveBeenCalledOnce();
    expect(update.install).not.toHaveBeenCalled();
  });

  it("does not download a GitHub prerelease until Download is chosen", async () => {
    vi.mocked(check).mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          {
            tag_name: "v1.0.8-1",
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

    await renderPrompt();
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("1.0.8-1");
    expect(invoke).not.toHaveBeenCalledWith(
      "download_manifest_update",
      expect.anything(),
    );

    const download = container.querySelector("[data-testid='update-download']");
    await act(async () => {
      if (download instanceof HTMLButtonElement) download.click();
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith("download_manifest_update", {
      manifestUrl:
        "https://github.com/boshuaiYu/LocalPrism/releases/download/v1.0.8-1/latest.json",
    });
    expect(container.textContent).toMatch(/Restart to install/i);
  });

  it("hides the beta banner when the user chooses Later", async () => {
    const update = updateFixture();
    update.version = "1.0.8-1";
    vi.mocked(check).mockResolvedValue(update as never);

    await renderPrompt();
    const later = container.querySelector("[data-testid='update-later']");
    await act(async () => {
      if (later instanceof HTMLButtonElement) later.click();
    });

    expect(container.querySelector("[data-testid='update-prompt']")).toBeNull();
    expect(update.download).not.toHaveBeenCalled();
  });
});
