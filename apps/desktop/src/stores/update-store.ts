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
  releasePageUrl,
  STABLE_UPDATER_ENDPOINT,
  stableCheckFailureAction,
  updateApplyMode,
  type ReleaseCandidate,
  type UpdateApplyMode,
  type UpdateOffer,
} from "@/lib/update-policy";
import { createLogger } from "@/lib/debug/logger";
import { useSettingsStore } from "@/stores/settings-store";

const log = createLogger("updater");

export type UpdateChannel = "stable" | "beta";

interface UpdateOfferFields {
  version: string;
  currentVersion: string;
  notes?: string;
  channel: UpdateChannel;
}

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking"; explicit: boolean }
  | { state: "up-to-date" }
  | ({ state: "confirm" } & UpdateOfferFields)
  | ({
      state: "downloading";
      percent: number | null;
    } & UpdateOfferFields)
  | ({ state: "ready" } & UpdateOfferFields)
  | ({ state: "manual" } & UpdateOfferFields)
  | ({ state: "installing" } & UpdateOfferFields)
  | {
      state: "error";
      message: string;
      explicit: boolean;
      /** Install failures keep the raw message as the status label. */
      phase?: "check" | "install";
    };

interface UpdateStore {
  status: UpdateStatus;
  bannerDismissed: boolean;
  /** Hides the offer dialog without discarding an in-progress download. */
  offerDialogHidden: boolean;
  checkForUpdate: (options?: { explicit?: boolean }) => Promise<void>;
  confirmDownload: () => Promise<void>;
  applyUpdate: () => Promise<void>;
  dismissBanner: () => void;
  /** Cancel, Esc, and the close button. Does not start a download. */
  dismissOfferDialog: () => void;
  openReleases: () => Promise<void>;
}

let pending: Update | null = null;
let pendingManifest: string | null = null;
let preparedManifest = false;
let autoCheckStarted = false;
let checkLock: Promise<void> | null = null;
let stopProgress: (() => void) | null = null;
/** Versions the user cancelled. Automatic checks skip these until restart. */
const sessionDismissedVersions = new Set<string>();

function notesFrom(update: Update): string | undefined {
  const body = update.body?.trim();
  return body ? body : undefined;
}

function formatUpdateError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  if (typeof err === "string" && err.trim()) return err.trim();
  if (typeof err === "object" && err !== null && "message" in err) {
    const message = err.message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
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

type StoreSet = (
  partial:
    | Partial<UpdateStore>
    | ((state: UpdateStore) => Partial<UpdateStore>),
) => void;

function downloadingStatus(
  meta: UpdateOfferFields,
  percent: number | null,
): UpdateStatus {
  return { state: "downloading", ...meta, percent };
}

async function downloadPending(
  update: Update,
  meta: UpdateOfferFields,
  set: StoreSet,
) {
  let downloaded = 0;
  let contentLength = 0;
  set({
    status: downloadingStatus(meta, null),
    bannerDismissed: false,
  });

  await update.download((event: DownloadEvent) => {
    if (event.event === "Started") {
      contentLength = event.data.contentLength ?? 0;
      set({
        status: downloadingStatus(meta, contentLength > 0 ? 0 : null),
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
      status: downloadingStatus(meta, percent),
    });
  });

  set({
    status: { state: "ready", ...meta },
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

interface BetaFeedResult {
  /** False when the shell could not load the GitHub releases list. */
  loaded: boolean;
  candidates: ReleaseCandidate[];
}

async function loadBetaCandidates(): Promise<BetaFeedResult> {
  try {
    const payload = await invoke<unknown>("fetch_github_releases");
    return {
      loaded: true,
      candidates: betaCandidatesFromGithub(payload),
    };
  } catch (error) {
    log.warn("Beta release list failed", {
      message: formatUpdateError(error),
    });
    return { loaded: false, candidates: [] };
  }
}

async function trackManifestProgress(meta: UpdateOfferFields, set: StoreSet) {
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
      status: downloadingStatus(meta, percent),
    });
  });
  stopProgress = () => {
    unlisten();
  };
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  status: { state: "idle" },
  bannerDismissed: false,
  offerDialogHidden: false,
  dismissBanner: () => set({ bannerDismissed: true }),
  dismissOfferDialog: () => {
    const status = get().status;
    if (status.state === "confirm" || status.state === "manual") {
      sessionDismissedVersions.add(status.version);
      set({ status: { state: "idle" }, offerDialogHidden: false });
      void closePending();
      clearPreparedManifest();
      return;
    }
    if (
      status.state === "downloading" ||
      status.state === "ready" ||
      status.state === "installing"
    ) {
      set({ offerDialogHidden: true });
    }
  },
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
        const [stableResult, betaFeed] = await Promise.all([
          // A post-release build such as `1.0.8-6` compares newer than
          // plain `1.0.8` in this policy. allowDowngrades keeps that
          // stable payload visible on both channels so the policy can
          // decline the same core instead of the updater hiding it.
          check({ allowDowngrades: true })
            .then((value) => ({ ok: true as const, value }))
            .catch((error: unknown) => ({ ok: false as const, error })),
          allowPrerelease
            ? loadBetaCandidates()
            : Promise.resolve({
                loaded: false,
                candidates: [] as ReleaseCandidate[],
              }),
        ]);
        const betas = betaFeed.candidates;

        if (!stableResult.ok) {
          log.error("Stable update check failed", {
            message: formatUpdateError(stableResult.error),
            allowPrerelease,
            betaFeedLoaded: betaFeed.loaded,
          });
        }

        // Verification is soft. An unsigned or unreachable stable manifest
        // must not abort the check before a newer beta can be offered, and
        // the unverified payload must not be downloaded.
        const stablePayload = stableResult.ok ? stableResult.value : null;
        let stableUpdate = stablePayload;
        let stableVerifyError: unknown = null;
        if (stableUpdate) {
          try {
            await invoke("verify_bound_updater_manifest", {
              manifestUrl: STABLE_UPDATER_ENDPOINT,
              expectedVersion: stableUpdate.version,
            });
          } catch (error) {
            stableVerifyError = error;
            log.error("Stable updater manifest verification failed", {
              message: formatUpdateError(error),
              version: stableUpdate.version,
            });
            await stableUpdate.close().catch(() => undefined);
            stableUpdate = null;
          }
        }
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
          if (!stableResult.ok) {
            // up-to-date only when a loaded beta list already covers this
            // install. An empty or failed list stays idle: do not rethrow
            // the stable error, and do not claim a newer beta was ruled out.
            const action = stableCheckFailureAction({
              allowPrerelease,
              explicit,
              errorMessage: formatUpdateError(stableResult.error),
              betaFeedLoaded: betaFeed.loaded,
              currentVersion,
              betas,
            });
            if (action === "surface-error") throw stableResult.error;
            set({
              status: {
                state: action === "up-to-date" ? "up-to-date" : "idle",
              },
            });
            return;
          }
          // The stable payload was dropped after verify failed. Report that
          // only when policy would have installed it. Plain 1.0.8 over a
          // newer 1.0.8-N build is already declined.
          if (stableVerifyError && stablePayload) {
            const unverified = chooseUpdateOffer({
              currentVersion,
              stable: {
                version: stablePayload.version,
                notes: notesFrom(stablePayload),
              },
              betas,
              allowPrerelease,
            });
            if (unverified.action !== "none") throw stableVerifyError;
          }
          set({
            status: { state: explicit ? "up-to-date" : "idle" },
          });
          return;
        }

        const notes = offer.notes;
        const offerFields: UpdateOfferFields = {
          version: offer.version,
          currentVersion,
          notes,
          channel: offer.action === "confirm" ? "beta" : "stable",
        };
        // Cancel hides this exact version from later automatic checks.
        // A manual check still shows the dialog.
        if (!explicit && sessionDismissedVersions.has(offer.version)) {
          if (stableUpdate) await stableUpdate.close().catch(() => undefined);
          log.info("Skipped automatic update dialog", {
            version: offer.version,
          });
          set({ status: { state: "idle" } });
          return;
        }
        if (mode === "manual-package") {
          if (stableUpdate) await stableUpdate.close().catch(() => undefined);
          set({
            status: { state: "manual", ...offerFields },
            bannerDismissed: false,
            offerDialogHidden: false,
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
            status: { state: "confirm", ...offerFields, channel: "beta" },
            bannerDismissed: false,
            offerDialogHidden: false,
          });
          return;
        }

        if (!stableUpdate) {
          set({
            status: { state: explicit ? "up-to-date" : "idle" },
          });
          return;
        }
        // Stable payloads used to download immediately. Both channels now
        // wait for the dialog's Download and install action.
        pending = stableUpdate;
        set({
          status: { state: "confirm", ...offerFields, channel: "stable" },
          bannerDismissed: false,
          offerDialogHidden: false,
        });
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
    const meta: UpdateOfferFields = {
      version: status.version,
      currentVersion: status.currentVersion,
      notes: status.notes,
      channel: status.channel,
    };
    if (update) {
      try {
        await downloadPending(update, meta, set);
      } catch (err) {
        const message = formatUpdateError(err);
        log.error("Update download failed", { message });
        set({
          status: { state: "error", message, explicit: true, phase: "check" },
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
      status: downloadingStatus(meta, null),
      bannerDismissed: false,
    });
    try {
      await trackManifestProgress(meta, set);
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
          ...meta,
          version: installedVersion || meta.version,
        },
        bannerDismissed: false,
      });
    } catch (err) {
      stopProgress?.();
      stopProgress = null;
      const message = formatUpdateError(err);
      log.error("Update download failed", { message });
      set({
        status: { state: "error", message, explicit: true, phase: "check" },
      });
    }
  },
  applyUpdate: async () => {
    const update = pending;
    const status = get().status;
    if (status.state !== "ready") return;
    if (!update && !preparedManifest) return;
    set({
      status: {
        state: "installing",
        version: status.version,
        currentVersion: status.currentVersion,
        notes: status.notes,
        channel: status.channel,
      },
    });
    try {
      if (update) {
        await update.install();
      } else {
        await invoke("install_prepared_update");
      }
      await relaunch();
    } catch (err) {
      const message = formatUpdateError(err);
      log.error("Update install failed", { message });
      set({
        status: {
          state: "error",
          message,
          explicit: true,
          phase: "install",
        },
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
  sessionDismissedVersions.clear();
  useSettingsStore.setState({ joinBetaChannel: false });
  useUpdateStore.setState({
    status: { state: "idle" },
    bannerDismissed: false,
    offerDialogHidden: false,
  });
}
