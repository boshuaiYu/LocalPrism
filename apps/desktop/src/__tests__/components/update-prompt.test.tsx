import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { open } from "@tauri-apps/plugin-shell";
import { check } from "@tauri-apps/plugin-updater";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdatePrompt, UpdateSettings } from "@/components/update-prompt";
import { translate } from "@/lib/i18n";
import { resetUpdateStoreForTests } from "@/stores/update-store";

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
    vi.mocked(invoke).mockResolvedValue("native");
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
});
