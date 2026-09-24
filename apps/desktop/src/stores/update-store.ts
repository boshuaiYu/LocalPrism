import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { open } from "@tauri-apps/plugin-shell";
import {
  check,
  type DownloadEvent,
  type Update,
} from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import {
  betaCandidatesFromGithub,
  chooseUpdateOffer,
  GITHUB_RELEASES_API,
  releasePageUrl,
  updateApplyMode,
  type ReleaseCandidate,
  type UpdateApplyMode,
  type UpdateOffer,
} from "@/lib/update-policy";
import { createLogger } from "@/lib/debug/logger";
import { useSettingsStore } from "@/stores/settings-store";

const log = createLogger("updater");

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking"; explicit: boolean }
  | { state: "up-to-date" }
  | {
      state: "confirm";
      version: string;
      notes?: string;
      channel: "beta";
    }
  | {
      state: "downloading";
      version: string;
      percent: number | null;
      notes?: string;
    }
  | { state: "ready"; version: string; notes?: string }
  | { state: "manual"; version: string; notes?: string }
  | { state: "installing"; version: string }
  | { state: "error"; message: string; explicit: boolean };

interface UpdateStore {
  status: UpdateStatus;
  bannerDismissed: boolean;
  checkForUpdate: (options?: { explicit?: boolean }) => Promise<void>;
  confirmDownload: () => Promise<void>;
  applyUpdate: () => Promise<void>;
  dismissBanner: () => void;
  openReleases: () => Promise<void>;
}

let pending: Update | null = null;
let pendingManifest: string | null = null;
let preparedManifest = false;
let autoCheckStarted = false;
let checkLock: Promise<void> | null = null;
let stopProgress: (() => void) | null = null;

function notesFrom(update: Update): string | undefined {
  const body = update.body?.trim();
  return body ? body : undefined;
}

function formatUpdateError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  if (typeof err === "string" && err.trim()) return err.trim();
  return String(err);
}

async function closePending() {
  stopProgress?.();
  stopProgress = null;
  const update = pending;
  pending = null;
  pendingManifest = null;
  if (!update) return;
  await update.close().catch(() => undefined);
}

function clearPreparedManifest() {
  if (!preparedManifest) return;
  preparedManifest = false;
  void invoke("clear_prepared_update").catch(() => undefined);
}

async function downloadPending(
  update: Update,
  set: (
    partial:
      | Partial<UpdateStore>
      | ((state: UpdateStore) => Partial<UpdateStore>),
  ) => void,
) {
  let downloaded = 0;
  let contentLength = 0;
  const notes = notesFrom(update);
  const version = update.version;
  set({
    status: { state: "downloading", version, percent: null, notes },
    bannerDismissed: false,
  });

  await update.download((event: DownloadEvent) => {
    if (event.event === "Started") {
      contentLength = event.data.contentLength ?? 0;
      set({
        status: {
          state: "downloading",
          version,
          percent: contentLength > 0 ? 0 : null,
          notes,
        },
      });
      return;
    }
    if (event.event !== "Progress") return;
    downloaded += event.data.chunkLength;
    const percent =
      contentLength > 0
        ? Math.min(100, Math.round((downloaded / contentLength) * 100))
        : null;
    set({
      status: { state: "downloading", version, percent, notes },
    });
  });

  set({
    status: { state: "ready", version, notes },
    bannerDismissed: false,
  });
}

async function currentAppVersion(stable: Update | null): Promise<string> {
  try {
    const version = await getVersion();
    if (typeof version === "string" && version.trim()) return version.trim();
  } catch {
    // Tests and non-Tauri previews fall through to the updater payload.
  }
  return stable?.currentVersion ?? "";
}

async function loadBetaCandidates(): Promise<ReleaseCandidate[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(GITHUB_RELEASES_API, {
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "LocalPrism",
      },
    });
    if (!response.ok) return [];
    return betaCandidatesFromGithub(await response.json());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function trackManifestProgress(
  version: string,
  notes: string | undefined,
  set: (
    partial:
      | Partial<UpdateStore>
      | ((state: UpdateStore) => Partial<UpdateStore>),
  ) => void,
) {
  stopProgress?.();
  const unlisten = await listen<{
    downloaded: number;
    total: number | null;
  }>("updater-download-progress", (event) => {
    const total = event.payload.total ?? 0;
    const percent =
      total > 0
        ? Math.min(100, Math.round((event.payload.downloaded / total) * 100))
        : null;
    set({
      status: { state: "downloading", version, percent, notes },
    });
  });
  stopProgress = () => {
    unlisten();
  };
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  status: { state: "idle" },
  bannerDismissed: false,
  dismissBanner: () => set({ bannerDismissed: true }),
  openReleases: async () => {
    const status = get().status;
    const version = "version" in status ? status.version : undefined;
    await open(releasePageUrl(version));
  },
  checkForUpdate: async (options) => {
    const explicit = options?.explicit ?? false;
    const current = get().status.state;
    if (current === "downloading" || current === "installing") return;
    if (
      !explicit &&
      (current === "ready" || current === "manual" || current === "confirm")
    ) {
      return;
    }
    if (checkLock) {
      const running = checkLock;
      if (!explicit) return running;
      await running.catch(() => undefined);
      if (checkLock) return checkLock;
      const settled = get().status.state;
      if (
        settled === "ready" ||
        settled === "downloading" ||
        settled === "installing"
      ) {
        return;
      }
    }

    let releaseLock = () => {};
    const lock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    checkLock = lock;

    const run = (async () => {
      set({ status: { state: "checking", explicit } });
      await closePending();
      clearPreparedManifest();
      try {
        const allowPrerelease =
          useSettingsStore.getState().joinBetaChannel === true;
        let channel: string | null = "native";
        try {
          channel = await invoke<string>("update_install_channel");
        } catch {
          channel = "native";
        }
        const mode: UpdateApplyMode = updateApplyMode(channel);
        const [stableResult, betas] = await Promise.all([
          // Beta off must still receive the stable manifest when this
          // install is `1.0.8-4`. Semver ranks that build below `1.0.8`,
          // but a comparator that treats the build number as newer would
          // hide the channel return. allowDowngrades keeps the payload.
          check(allowPrerelease ? undefined : { allowDowngrades: true })
            .then((value) => ({ ok: true as const, value }))
            .catch((error: unknown) => ({ ok: false as const, error })),
          allowPrerelease ? loadBetaCandidates() : Promise.resolve([]),
        ]);

        if (!stableResult.ok) {
          log.error("Stable update check failed", {
            message: formatUpdateError(stableResult.error),
            allowPrerelease,
          });
        }

        if (!stableResult.ok && betas.length === 0) {
          throw stableResult.error;
        }

        const stableUpdate = stableResult.ok ? stableResult.value : null;
        const currentVersion = await currentAppVersion(stableUpdate);
        const offer: UpdateOffer = chooseUpdateOffer({
          currentVersion,
          stable: stableUpdate
            ? {
                version: stableUpdate.version,
                notes: notesFrom(stableUpdate),
              }
            : null,
          betas,
          allowPrerelease,
        });

        if (offer.action === "none") {
          if (stableUpdate) await stableUpdate.close().catch(() => undefined);
          if (!stableResult.ok) throw stableResult.error;
          set({
            status: { state: explicit ? "up-to-date" : "idle" },
          });
          return;
        }

        const notes = offer.notes;
        if (mode === "manual-package") {
          if (stableUpdate) await stableUpdate.close().catch(() => undefined);
          set({
            status: { state: "manual", version: offer.version, notes },
            bannerDismissed: false,
          });
          return;
        }

        if (offer.action === "confirm") {
          if (offer.manifestUrl) {
            if (stableUpdate) await stableUpdate.close().catch(() => undefined);
            pendingManifest = offer.manifestUrl;
          } else {
            pending = stableUpdate;
          }
          set({
            status: {
              state: "confirm",
              version: offer.version,
              notes,
              channel: "beta",
            },
            bannerDismissed: false,
          });
          return;
        }

        if (!stableUpdate) {
          set({
            status: { state: explicit ? "up-to-date" : "idle" },
          });
          return;
        }
        pending = stableUpdate;
        await downloadPending(stableUpdate, set);
      } catch (err) {
        const message = formatUpdateError(err);
        log.error("Update check failed", { message, explicit });
        const failedDuringDownload = get().status.state === "downloading";
        set({
          status: {
            state: "error",
            message,
            explicit: explicit || failedDuringDownload,
          },
        });
      }
    })();

    void run.finally(() => {
      if (checkLock === lock) checkLock = null;
      releaseLock();
    });
    return run;
  },
  confirmDownload: async () => {
    const status = get().status;
    if (status.state !== "confirm") return;
    const update = pending;
    const manifestUrl = pendingManifest;
    const notes = status.notes;
    const version = status.version;
    if (update) {
      try {
        await downloadPending(update, set);
      } catch (err) {
        set({
          status: { state: "error", message: String(err), explicit: true },
        });
      }
      return;
    }
    if (!manifestUrl) {
      set({
        status: {
          state: "error",
          message: "Beta manifest URL is missing.",
          explicit: true,
        },
      });
      return;
    }
    set({
      status: { state: "downloading", version, percent: null, notes },
      bannerDismissed: false,
    });
    try {
      await trackManifestProgress(version, notes, set);
      const installedVersion = await invoke<string>(
        "download_manifest_update",
        {
          manifestUrl,
        },
      );
      stopProgress?.();
      stopProgress = null;
      preparedManifest = true;
      pendingManifest = null;
      set({
        status: {
          state: "ready",
          version: installedVersion || version,
          notes,
        },
        bannerDismissed: false,
      });
    } catch (err) {
      stopProgress?.();
      stopProgress = null;
      set({
        status: { state: "error", message: String(err), explicit: true },
      });
    }
  },
  applyUpdate: async () => {
    const update = pending;
    const status = get().status;
    if (status.state !== "ready") return;
    if (!update && !preparedManifest) return;
    set({ status: { state: "installing", version: status.version } });
    try {
      if (update) {
        await update.install();
      } else {
        await invoke("install_prepared_update");
      }
      await relaunch();
    } catch (err) {
      set({
        status: { state: "error", message: String(err), explicit: true },
      });
    }
  },
}));

export function ensureUpdateCheck() {
  if (autoCheckStarted) return;
  autoCheckStarted = true;
  void useUpdateStore.getState().checkForUpdate({ explicit: false });
}

export function resetUpdateStoreForTests() {
  autoCheckStarted = false;
  pending = null;
  pendingManifest = null;
  preparedManifest = false;
  stopProgress = null;
  checkLock = null;
  useSettingsStore.setState({ joinBetaChannel: false });
  useUpdateStore.setState({
    status: { state: "idle" },
    bannerDismissed: false,
  });
}
