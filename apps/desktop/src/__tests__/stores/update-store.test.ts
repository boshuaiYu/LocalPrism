import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLogStore } from "@/lib/debug/log-store";
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

let githubReleases: unknown[] | "error" = [];

function stubReleases(releases: unknown[]) {
  githubReleases = releases;
}

function stubReleaseListFailure() {
  githubReleases = "error";
}

async function invokeUpdateCommand(command: string): Promise<unknown> {
  if (command === "fetch_github_releases") {
    if (githubReleases === "error") throw new Error("github unavailable");
    return githubReleases;
  }
  if (command === "update_install_channel") return "native";
  if (command === "verify_bound_updater_manifest") return "1.0.8";
  if (command === "clear_prepared_update") return undefined;
  if (command === "js_log") return undefined;
  return undefined;
}

describe("update store check", () => {
  beforeEach(() => {
    resetUpdateStoreForTests();
    vi.mocked(check).mockReset();
    vi.mocked(invoke).mockReset();
    vi.mocked(getVersion).mockReset();
    vi.mocked(getVersion).mockResolvedValue("1.0.8-11");
    vi.mocked(check).mockRejectedValue(new Error("signature mismatch"));
    githubReleases = [];
    vi.mocked(invoke).mockImplementation(async (command: string) =>
      invokeUpdateCommand(command),
    );
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
    expect(check).toHaveBeenCalledWith({ allowDowngrades: true });
    expect(invoke).toHaveBeenCalledWith("fetch_github_releases");
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
    expect(check).toHaveBeenCalledWith({ allowDowngrades: true });
  });

  it("does not flash a check error when Beta is on, stable check throws, and the beta list is empty", async () => {
    useSettingsStore.setState({ joinBetaChannel: true });
    stubReleases([]);

    await useUpdateStore.getState().checkForUpdate({ explicit: true });

    expect(useUpdateStore.getState().status).toEqual({ state: "idle" });
    expect(check).toHaveBeenCalledWith({ allowDowngrades: true });
    expect(invoke).toHaveBeenCalledWith("fetch_github_releases");
  });

  it("stays idle on an automatic check when Beta is on and the beta list failed", async () => {
    useSettingsStore.setState({ joinBetaChannel: true });
    stubReleaseListFailure();

    await useUpdateStore.getState().checkForUpdate({ explicit: false });

    expect(useUpdateStore.getState().status).toEqual({ state: "idle" });
  });

  it("does not treat a draft-only beta list as a stable check failure", async () => {
    useSettingsStore.setState({ joinBetaChannel: true });
    stubReleases([betaRelease("v1.0.8beta12", true)]);

    await useUpdateStore.getState().checkForUpdate({ explicit: true });

    expect(useUpdateStore.getState().status).toEqual({ state: "idle" });
  });

  it("still reports a missing-platform failure when Beta is on and the beta list is empty", async () => {
    const message =
      'None of the fallback platforms ["windows-x86_64-nsis", "windows-x86_64"] were found in the response platforms object';
    useSettingsStore.setState({ joinBetaChannel: true });
    vi.mocked(check).mockRejectedValue(new Error(message));
    stubReleases([]);

    await useUpdateStore.getState().checkForUpdate({ explicit: true });

    expect(useUpdateStore.getState().status).toEqual({
      state: "error",
      message,
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
    expect(check).toHaveBeenCalledWith({ allowDowngrades: true });
    expect(invoke).not.toHaveBeenCalledWith("fetch_github_releases");
  });

  it("passes allowDowngrades whether or not Beta is on", async () => {
    useSettingsStore.setState({ joinBetaChannel: true });
    await useUpdateStore.getState().checkForUpdate({ explicit: true });
    useSettingsStore.setState({ joinBetaChannel: false });
    await useUpdateStore.getState().checkForUpdate({ explicit: true });

    expect(vi.mocked(check).mock.calls.length).toBe(2);
    for (const call of vi.mocked(check).mock.calls) {
      expect(call[0]).toEqual({ allowDowngrades: true });
    }
  });

  it("offers a newer beta when stable manifest verification fails", async () => {
    const stable = stableRelease("1.0.8");
    useSettingsStore.setState({ joinBetaChannel: true });
    vi.mocked(check).mockResolvedValue(stable as never);
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "verify_bound_updater_manifest") {
        throw new Error("manifest bind failed");
      }
      return invokeUpdateCommand(command);
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
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "verify_bound_updater_manifest") {
        throw new Error("manifest bind failed");
      }
      return invokeUpdateCommand(command);
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
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "verify_bound_updater_manifest") {
        throw new Error("manifest bind failed");
      }
      return invokeUpdateCommand(command);
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

  it("asks before downloading a newer stable release when Beta is off", async () => {
    const stable = stableRelease("1.1.0");
    vi.mocked(getVersion).mockResolvedValue("1.0.0");
    vi.mocked(check).mockResolvedValue(stable as never);

    await useUpdateStore.getState().checkForUpdate({ explicit: false });

    expect(stable.download).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith("fetch_github_releases");
    expect(useUpdateStore.getState().status).toMatchObject({
      state: "confirm",
      version: "1.1.0",
      currentVersion: "1.0.0",
      channel: "stable",
      notes: "Stable notes",
    });

    await useUpdateStore.getState().confirmDownload();

    expect(stable.download).toHaveBeenCalledOnce();
    expect(useUpdateStore.getState().status).toMatchObject({
      state: "ready",
      version: "1.1.0",
      channel: "stable",
    });
  });

  it("does not offer a beta release when Beta is off", async () => {
    const stable = stableRelease("1.2.0beta1");
    vi.mocked(getVersion).mockResolvedValue("1.0.0");
    vi.mocked(check).mockResolvedValue(stable as never);
    stubReleases([betaRelease("v1.2.0beta2")]);

    await useUpdateStore.getState().checkForUpdate({ explicit: true });

    expect(useUpdateStore.getState().status).toEqual({ state: "up-to-date" });
    expect(stable.download).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith("fetch_github_releases");
  });

  it("offers the newer stable release instead of an older beta when Beta is on", async () => {
    const stable = stableRelease("1.3.0");
    useSettingsStore.setState({ joinBetaChannel: true });
    vi.mocked(getVersion).mockResolvedValue("1.0.0");
    vi.mocked(check).mockResolvedValue(stable as never);
    stubReleases([betaRelease("v1.2.0beta1")]);

    await useUpdateStore.getState().checkForUpdate({ explicit: true });

    expect(stable.download).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().status).toMatchObject({
      state: "confirm",
      version: "1.3.0",
      channel: "stable",
    });
  });

  it("offers the newer beta instead of an older stable when Beta is on", async () => {
    const stable = stableRelease("1.1.0");
    useSettingsStore.setState({ joinBetaChannel: true });
    vi.mocked(getVersion).mockResolvedValue("1.0.0");
    vi.mocked(check).mockResolvedValue(stable as never);
    stubReleases([betaRelease("v1.2.0beta1")]);

    await useUpdateStore.getState().checkForUpdate({ explicit: false });

    expect(stable.download).not.toHaveBeenCalled();
    expect(stable.close).toHaveBeenCalled();
    expect(useUpdateStore.getState().status).toMatchObject({
      state: "confirm",
      version: "1.2.0beta1",
      channel: "beta",
      notes: "preview",
    });
  });

  it("does not show a cancelled version again until a manual check", async () => {
    const stable = stableRelease("1.1.0");
    vi.mocked(getVersion).mockResolvedValue("1.0.0");
    vi.mocked(check).mockResolvedValue(stable as never);

    await useUpdateStore.getState().checkForUpdate({ explicit: false });
    expect(useUpdateStore.getState().status.state).toBe("confirm");
    useUpdateStore.getState().dismissOfferDialog();

    expect(useUpdateStore.getState().status).toEqual({ state: "idle" });
    expect(stable.download).not.toHaveBeenCalled();

    await useUpdateStore.getState().checkForUpdate({ explicit: false });
    expect(useUpdateStore.getState().status).toEqual({ state: "idle" });
    expect(stable.download).not.toHaveBeenCalled();

    await useUpdateStore.getState().checkForUpdate({ explicit: true });
    expect(useUpdateStore.getState().status).toMatchObject({
      state: "confirm",
      version: "1.1.0",
      channel: "stable",
    });
  });

  it("still shows an automatic dialog for a version the user has not cancelled", async () => {
    vi.mocked(getVersion).mockResolvedValue("1.0.0");
    vi.mocked(check).mockResolvedValue(stableRelease("1.1.0") as never);
    await useUpdateStore.getState().checkForUpdate({ explicit: false });
    useUpdateStore.getState().dismissOfferDialog();

    vi.mocked(check).mockResolvedValue(stableRelease("1.2.0") as never);
    await useUpdateStore.getState().checkForUpdate({ explicit: false });

    expect(useUpdateStore.getState().status).toMatchObject({
      state: "confirm",
      version: "1.2.0",
      channel: "stable",
    });
  });

  it("keeps a download running when the dialog is closed after it starts", async () => {
    let releaseDownload: () => void = () => undefined;
    const stable = stableRelease("1.1.0");
    stable.download = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          releaseDownload = () => resolve(undefined);
        }),
    );
    vi.mocked(getVersion).mockResolvedValue("1.0.0");
    vi.mocked(check).mockResolvedValue(stable as never);

    await useUpdateStore.getState().checkForUpdate({ explicit: true });
    const downloading = useUpdateStore.getState().confirmDownload();
    await Promise.resolve();
    expect(useUpdateStore.getState().status.state).toBe("downloading");

    useUpdateStore.getState().dismissOfferDialog();
    expect(useUpdateStore.getState().offerDialogHidden).toBe(true);
    expect(useUpdateStore.getState().status.state).toBe("downloading");

    releaseDownload();
    await downloading;
    expect(useUpdateStore.getState().status).toMatchObject({
      state: "ready",
      version: "1.1.0",
    });
    expect(useUpdateStore.getState().offerDialogHidden).toBe(true);
  });

  it("stays up to date when verification fails for a stable build the policy already declines", async () => {
    const stable = stableRelease("1.0.8");
    vi.mocked(getVersion).mockResolvedValue("1.0.8-12");
    vi.mocked(check).mockResolvedValue(stable as never);
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "verify_bound_updater_manifest") {
        throw new Error("manifest bind failed");
      }
      return invokeUpdateCommand(command);
    });

    await useUpdateStore.getState().checkForUpdate({ explicit: true });

    expect(stable.download).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().status).toEqual({ state: "up-to-date" });
  });

  it("offers 1.0.9beta2 when Beta is on and the release list loads", async () => {
    const stable = stableRelease("1.0.9");
    useSettingsStore.setState({ joinBetaChannel: true });
    vi.mocked(getVersion).mockResolvedValue("1.0.8");
    vi.mocked(check).mockResolvedValue(stable as never);
    stubReleases([betaRelease("v1.0.9beta2")]);

    await useUpdateStore.getState().checkForUpdate({ explicit: true });

    expect(useUpdateStore.getState().status).toMatchObject({
      state: "confirm",
      version: "1.0.9beta2",
      channel: "beta",
    });
    expect(stable.download).not.toHaveBeenCalled();
  });

  it("logs a stable fallback when the beta release list is rate limited", async () => {
    const stable = stableRelease("1.0.9");
    useSettingsStore.setState({ joinBetaChannel: true });
    vi.mocked(getVersion).mockResolvedValue("1.0.8");
    vi.mocked(check).mockResolvedValue(stable as never);
    useLogStore.getState().clear();
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "fetch_github_releases") {
        throw new Error("GitHub releases request failed (403 Forbidden).");
      }
      return invokeUpdateCommand(command);
    });

    await useUpdateStore.getState().checkForUpdate({ explicit: true });

    expect(useUpdateStore.getState().status).toMatchObject({
      state: "confirm",
      version: "1.0.9",
      channel: "stable",
    });
    expect(stable.download).not.toHaveBeenCalled();
    const warning = useLogStore
      .getState()
      .getEntries()
      .find(
        (entry) =>
          entry.level === "warn" && entry.message === "beta list unavailable",
      );
    expect(warning?.data).toMatchObject({
      rateLimited: true,
      offeredStable: true,
      offeredVersion: "1.0.9",
    });
  });

  it("keeps a cancelled beta after a later check returns none", async () => {
    useSettingsStore.setState({ joinBetaChannel: true });
    vi.mocked(getVersion).mockResolvedValue("1.0.9");
    const stable = stableRelease("1.0.9");
    vi.mocked(check).mockResolvedValue(stable as never);
    stubReleases([betaRelease("v1.0.9beta2")]);

    await useUpdateStore.getState().checkForUpdate({ explicit: true });
    expect(useUpdateStore.getState().status).toMatchObject({
      state: "confirm",
      version: "1.0.9beta2",
      channel: "beta",
    });
    useUpdateStore.getState().dismissOfferDialog();
    expect(useUpdateStore.getState().dismissedOffer).toMatchObject({
      version: "1.0.9beta2",
      kind: "confirm",
    });

    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "fetch_github_releases") {
        throw new Error("GitHub releases request failed (403 Forbidden).");
      }
      if (command === "download_manifest_update") return "1.0.9beta2";
      return invokeUpdateCommand(command);
    });

    await useUpdateStore.getState().checkForUpdate({ explicit: true });

    expect(useUpdateStore.getState().status).toEqual({ state: "idle" });
    expect(useUpdateStore.getState().dismissedOffer).toMatchObject({
      version: "1.0.9beta2",
      kind: "confirm",
    });
    expect(stable.download).not.toHaveBeenCalled();

    const checksAfterNone = vi.mocked(check).mock.calls.length;
    useUpdateStore.getState().reopenDismissedOffer();
    expect(useUpdateStore.getState().status).toMatchObject({
      state: "confirm",
      version: "1.0.9beta2",
      channel: "beta",
    });
    expect(vi.mocked(check).mock.calls.length).toBe(checksAfterNone);
    expect(stable.download).not.toHaveBeenCalled();

    await useUpdateStore.getState().confirmDownload();
    expect(invoke).toHaveBeenCalledWith("download_manifest_update", {
      manifestUrl:
        "https://github.com/boshuaiYu/LocalPrism/releases/download/v1.0.9beta2/latest.json",
    });
    expect(vi.mocked(check).mock.calls.length).toBe(checksAfterNone);
    expect(stable.download).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().status).toMatchObject({
      state: "ready",
      version: "1.0.9beta2",
    });
  });

  it("applies release notes that resolve before the offer is stored", async () => {
    vi.mocked(getVersion).mockResolvedValue("1.0.0");
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "fetch_github_release_body") return "real changelog";
      return invokeUpdateCommand(command);
    });
    const stable = stableRelease("1.1.0");
    stable.body = "LocalPrism v1.1.0";
    vi.mocked(check).mockResolvedValue(stable as never);

    await useUpdateStore.getState().checkForUpdate({ explicit: true });

    expect(useUpdateStore.getState().status).toMatchObject({
      state: "confirm",
      version: "1.1.0",
      notes: "real changelog",
    });
    expect(useUpdateStore.getState().status).not.toHaveProperty(
      "notesState",
      "loading",
    );

    useUpdateStore.setState({
      status: { state: "idle" },
      dismissedOffer: {
        kind: "confirm",
        version: "1.1.0",
        currentVersion: "1.0.0",
        notesState: "loading",
        channel: "stable",
      },
    });
    useUpdateStore.getState().reopenDismissedOffer();
    expect(useUpdateStore.getState().status).toMatchObject({
      state: "confirm",
      version: "1.1.0",
      notes: "real changelog",
    });
  });

  it("retries unavailable release notes once on an explicit check", async () => {
    vi.mocked(getVersion).mockResolvedValue("1.0.0");
    let notesCalls = 0;
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "fetch_github_release_body") {
        notesCalls += 1;
        throw new Error("GitHub release request failed (403).");
      }
      return invokeUpdateCommand(command);
    });
    const stable = stableRelease("1.1.0");
    stable.body = "LocalPrism v1.1.0";
    vi.mocked(check).mockResolvedValue(stable as never);

    await useUpdateStore.getState().checkForUpdate({ explicit: true });
    expect(useUpdateStore.getState().status).toMatchObject({
      notesState: "unavailable",
    });

    useUpdateStore.setState({ status: { state: "idle" } });
    await useUpdateStore.getState().checkForUpdate({ explicit: false });
    expect(notesCalls).toBe(1);
    expect(useUpdateStore.getState().status).toMatchObject({
      state: "confirm",
      notesState: "unavailable",
    });

    await useUpdateStore.getState().checkForUpdate({ explicit: true });
    expect(notesCalls).toBe(2);
    expect(useUpdateStore.getState().status).toMatchObject({
      notesState: "unavailable",
    });

    useUpdateStore.setState({ status: { state: "idle" } });
    await useUpdateStore.getState().checkForUpdate({ explicit: true });
    expect(notesCalls).toBe(2);
    expect(useUpdateStore.getState().status).toMatchObject({
      notesState: "unavailable",
    });
  });

  it("keeps a cancelled update in the footer without downloading", async () => {
    const first = stableRelease("1.1.0");
    const second = stableRelease("1.1.0");
    vi.mocked(getVersion).mockResolvedValue("1.0.0");
    vi.mocked(check)
      .mockResolvedValueOnce(first as never)
      .mockResolvedValueOnce(second as never);

    await useUpdateStore.getState().checkForUpdate({ explicit: false });
    useUpdateStore.getState().dismissOfferDialog();

    expect(useUpdateStore.getState().status).toEqual({ state: "idle" });
    expect(useUpdateStore.getState().dismissedOffer).toMatchObject({
      kind: "confirm",
      version: "1.1.0",
      channel: "stable",
    });
    expect(first.download).not.toHaveBeenCalled();
    expect(first.close).not.toHaveBeenCalled();

    await useUpdateStore.getState().checkForUpdate({ explicit: false });
    expect(useUpdateStore.getState().status).toEqual({ state: "idle" });
    expect(useUpdateStore.getState().dismissedOffer).toMatchObject({
      version: "1.1.0",
    });
    expect(second.close).toHaveBeenCalled();
    expect(first.close).not.toHaveBeenCalled();
    expect(first.download).not.toHaveBeenCalled();

    useUpdateStore.getState().reopenDismissedOffer();
    expect(useUpdateStore.getState().status).toMatchObject({
      state: "confirm",
      version: "1.1.0",
    });
    expect(first.download).not.toHaveBeenCalled();

    await useUpdateStore.getState().confirmDownload();
    expect(first.download).toHaveBeenCalledOnce();
  });

  it("keeps a prepared update when an explicit check runs in the ready state", async () => {
    const stable = stableRelease("1.1.0");
    vi.mocked(getVersion).mockResolvedValue("1.0.0");
    vi.mocked(check).mockResolvedValue(stable as never);

    await useUpdateStore.getState().checkForUpdate({ explicit: true });
    await useUpdateStore.getState().confirmDownload();
    expect(useUpdateStore.getState().status.state).toBe("ready");
    useUpdateStore.getState().dismissOfferDialog();
    expect(useUpdateStore.getState().offerDialogHidden).toBe(true);

    await useUpdateStore.getState().checkForUpdate({ explicit: true });

    expect(vi.mocked(check).mock.calls).toHaveLength(1);
    expect(stable.close).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith("clear_prepared_update");
    expect(useUpdateStore.getState().offerDialogHidden).toBe(false);
    expect(useUpdateStore.getState().status).toMatchObject({
      state: "ready",
      version: "1.1.0",
    });
  });

  it("keeps a prepared beta package when an explicit check runs again", async () => {
    useSettingsStore.setState({ joinBetaChannel: true });
    vi.mocked(getVersion).mockResolvedValue("1.0.8");
    vi.mocked(check).mockResolvedValue(stableRelease("1.0.9") as never);
    stubReleases([betaRelease("v1.0.9beta2")]);

    await useUpdateStore.getState().checkForUpdate({ explicit: true });
    expect(useUpdateStore.getState().status).toMatchObject({
      state: "confirm",
      version: "1.0.9beta2",
    });
    await useUpdateStore.getState().confirmDownload();
    expect(useUpdateStore.getState().status.state).toBe("ready");
    useUpdateStore.getState().dismissOfferDialog();

    await useUpdateStore.getState().checkForUpdate({ explicit: true });

    expect(invoke).not.toHaveBeenCalledWith("clear_prepared_update");
    expect(useUpdateStore.getState().status).toMatchObject({
      state: "ready",
      version: "1.0.9beta2",
    });
    expect(useUpdateStore.getState().offerDialogHidden).toBe(false);
  });

  it("labels a download failure with the download phase", async () => {
    const stable = stableRelease("1.1.0");
    stable.download = vi.fn(async () => {
      throw new Error("network dropped");
    });
    vi.mocked(getVersion).mockResolvedValue("1.0.0");
    vi.mocked(check).mockResolvedValue(stable as never);

    await useUpdateStore.getState().checkForUpdate({ explicit: true });
    await useUpdateStore.getState().confirmDownload();

    expect(useUpdateStore.getState().status).toEqual({
      state: "error",
      message: "network dropped",
      explicit: true,
      phase: "download",
    });
  });
});
