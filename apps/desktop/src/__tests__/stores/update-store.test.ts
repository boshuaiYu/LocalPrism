import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STABLE_UPDATER_ENDPOINT } from "@/lib/update-policy";
import { useSettingsStore } from "@/stores/settings-store";
import {
  resetUpdateStoreForTests,
  useUpdateStore,
} from "@/stores/update-store";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(async () => "1.0.8-11"),
}));

function betaRelease(tag: string, draft = false) {
  return {
    tag_name: tag,
    prerelease: true,
    draft,
    body: "preview",
    assets: [
      {
        name: "latest.json",
        browser_download_url: `https://github.com/boshuaiYu/LocalPrism/releases/download/${tag}/latest.json`,
      },
    ],
  };
}

function stableRelease(version: string) {
  return {
    version,
    currentVersion: "1.0.8",
    body: "Stable notes",
    download: vi.fn(async () => undefined),
    install: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function stubReleases(releases: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => releases,
    })),
  );
}

describe("update store check", () => {
  beforeEach(() => {
    resetUpdateStoreForTests();
    vi.mocked(check).mockReset();
    vi.mocked(invoke).mockReset();
    vi.mocked(getVersion).mockReset();
    vi.mocked(getVersion).mockResolvedValue("1.0.8-11");
    vi.mocked(check).mockRejectedValue(new Error("signature mismatch"));
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "update_install_channel") return "native";
      if (command === "verify_bound_updater_manifest") return "1.0.8";
      if (command === "clear_prepared_update") return undefined;
      if (command === "js_log") return undefined;
      return undefined;
    });
    stubReleases([]);
  });

  afterEach(() => {
    resetUpdateStoreForTests();
    vi.unstubAllGlobals();
  });

  it("shows up to date when stable check fails but the beta install is already current", async () => {
    useSettingsStore.setState({ joinBetaChannel: true });
    vi.mocked(getVersion).mockResolvedValue("1.0.8-12");
    stubReleases([betaRelease("v1.0.8beta11"), betaRelease("v1.0.8beta12")]);

    await useUpdateStore.getState().checkForUpdate({ explicit: true });

    expect(useUpdateStore.getState().status).toEqual({ state: "up-to-date" });
    expect(invoke).not.toHaveBeenCalledWith(
      "verify_bound_updater_manifest",
      expect.anything(),
    );
  });

  it("stays idle on an automatic check when the current beta covers the loaded list", async () => {
    useSettingsStore.setState({ joinBetaChannel: true });
    vi.mocked(getVersion).mockResolvedValue("1.0.8-12");
    stubReleases([betaRelease("v1.0.8beta12")]);

    await useUpdateStore.getState().checkForUpdate({ explicit: false });

    expect(useUpdateStore.getState().status).toEqual({ state: "idle" });
  });

  it("still offers a newer beta when the stable check fails", async () => {
    useSettingsStore.setState({ joinBetaChannel: true });
    stubReleases([betaRelease("v1.0.8beta12")]);

    await useUpdateStore.getState().checkForUpdate({ explicit: true });

    expect(useUpdateStore.getState().status).toMatchObject({
      state: "confirm",
      version: "1.0.8beta12",
      channel: "beta",
    });
  });

  it("reports a check error when stable fails and no usable beta was loaded", async () => {
    useSettingsStore.setState({ joinBetaChannel: true });
    stubReleases([betaRelease("v1.0.8beta12", true)]);

    await useUpdateStore.getState().checkForUpdate({ explicit: true });

    expect(useUpdateStore.getState().status).toEqual({
      state: "error",
      message: "signature mismatch",
      explicit: true,
    });

    stubReleases([]);
    await useUpdateStore.getState().checkForUpdate({ explicit: true });
    expect(useUpdateStore.getState().status).toMatchObject({
      state: "error",
      message: "signature mismatch",
      explicit: true,
    });
  });

  it("reports a check error when Beta is off and the stable check fails", async () => {
    await useUpdateStore.getState().checkForUpdate({ explicit: true });

    expect(useUpdateStore.getState().status).toEqual({
      state: "error",
      message: "signature mismatch",
      explicit: true,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("offers a newer beta when stable manifest verification fails", async () => {
    const stable = stableRelease("1.0.8");
    useSettingsStore.setState({ joinBetaChannel: true });
    vi.mocked(check).mockResolvedValue(stable as never);
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "update_install_channel") return "native";
      if (command === "verify_bound_updater_manifest") {
        throw new Error("manifest bind failed");
      }
      if (command === "clear_prepared_update") return undefined;
      if (command === "js_log") return undefined;
      return undefined;
    });
    stubReleases([betaRelease("v1.0.8beta12")]);

    await useUpdateStore.getState().checkForUpdate({ explicit: true });

    expect(invoke).toHaveBeenCalledWith("verify_bound_updater_manifest", {
      manifestUrl: STABLE_UPDATER_ENDPOINT,
      expectedVersion: "1.0.8",
    });
    expect(stable.close).toHaveBeenCalledOnce();
    expect(stable.download).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().status).toMatchObject({
      state: "confirm",
      version: "1.0.8beta12",
      channel: "beta",
    });
  });

  it("still offers the beta when verification fails for a higher stable version", async () => {
    const stable = stableRelease("1.0.9");
    useSettingsStore.setState({ joinBetaChannel: true });
    vi.mocked(check).mockResolvedValue(stable as never);
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "update_install_channel") return "native";
      if (command === "verify_bound_updater_manifest") {
        throw new Error("manifest bind failed");
      }
      return undefined;
    });
    stubReleases([betaRelease("v1.0.8beta12")]);

    await useUpdateStore.getState().checkForUpdate({ explicit: true });

    expect(stable.download).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().status).toMatchObject({
      state: "confirm",
      version: "1.0.8beta12",
      channel: "beta",
    });
  });

  it("surfaces verification failure when that stable build would have been installed", async () => {
    const stable = stableRelease("1.0.9");
    vi.mocked(getVersion).mockResolvedValue("1.0.8");
    vi.mocked(check).mockResolvedValue(stable as never);
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "update_install_channel") return "native";
      if (command === "verify_bound_updater_manifest") {
        throw new Error("manifest bind failed");
      }
      return undefined;
    });

    await useUpdateStore.getState().checkForUpdate({ explicit: true });

    expect(stable.download).not.toHaveBeenCalled();
    expect(stable.close).toHaveBeenCalledOnce();
    expect(useUpdateStore.getState().status).toEqual({
      state: "error",
      message: "manifest bind failed",
      explicit: true,
    });
  });

  it("stays up to date when verification fails for a stable build the policy already declines", async () => {
    const stable = stableRelease("1.0.8");
    vi.mocked(getVersion).mockResolvedValue("1.0.8-12");
    vi.mocked(check).mockResolvedValue(stable as never);
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "update_install_channel") return "native";
      if (command === "verify_bound_updater_manifest") {
        throw new Error("manifest bind failed");
      }
      return undefined;
    });

    await useUpdateStore.getState().checkForUpdate({ explicit: true });

    expect(stable.download).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().status).toEqual({ state: "up-to-date" });
  });
});
