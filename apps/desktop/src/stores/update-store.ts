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
  installCoversLoadedBetas,
  isNewerVersion,
  isPlaceholderReleaseNotes,
  isPrereleaseVersion,
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
  /** Placeholder updater notes are replaced after the dialog is already open. */
  notesState?: "loading" | "empty" | "unavailable";
  channel: UpdateChannel;
}

export interface DismissedUpdateOffer extends UpdateOfferFields {
  kind: "confirm" | "manual";
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
      /**
       * Install and download failures keep the raw message as the status
       * label. Check failures omit phase and use the generic check-failed label.
       */
      phase?: "download" | "install";
    };

interface UpdateStore {
  status: UpdateStatus;
  bannerDismissed: boolean;
  /** Hides the offer dialog without discarding an in-progress download. */
  offerDialogHidden: boolean;
  /** Survives Cancel so the footer can reopen this version for the session. */
  dismissedOffer: DismissedUpdateOffer | null;
  checkForUpdate: (options?: { explicit?: boolean }) => Promise<void>;
  confirmDownload: () => Promise<void>;
  applyUpdate: () => Promise<void>;
  dismissBanner: () => void;
  /** Cancel, Esc, and the close button. Does not start a download. */
  dismissOfferDialog: () => void;
  /** Reopens a cancelled offer. Does not download. */
  reopenDismissedOffer: () => void;
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

type ReleaseNotesCacheEntry =
  | { state: "ready"; notes: string }
  | { state: "empty" }
  | { state: "unavailable" };

const releaseNotesCache = new Map<string, ReleaseNotesCacheEntry>();
const releaseNotesInflight = new Set<string>();
/** Explicit checks may retry an unavailable body once per version. */
const releaseNotesRetryCounts = new Map<string, number>();
let releaseNotesEpoch = 0;

function releaseNotesPatch(
  version: string,
): Pick<UpdateOfferFields, "notes" | "notesState"> | null {
  const cached = releaseNotesCache.get(version);
  if (!cached) return null;
  if (cached.state === "ready") {
    return { notes: cached.notes, notesState: undefined };
  }
  if (cached.state === "empty") {
    return { notes: undefined, notesState: "empty" };
  }
  return { notes: undefined, notesState: "unavailable" };
}

function applyCachedReleaseNotes(version: string) {
  const patch = releaseNotesPatch(version);
  if (!patch) return;
  useUpdateStore.setState((state) => {
    const partial: Partial<UpdateStore> = {};
    const status = state.status;
    if (
      "version" in status &&
      status.version === version &&
      status.notesState === "loading"
    ) {
      partial.status = {
        ...status,
        notes: patch.notes,
        notesState: patch.notesState,
      };
    }
    const dismissed = state.dismissedOffer;
    if (dismissed?.version === version && dismissed.notesState === "loading") {
      partial.dismissedOffer = {
        ...dismissed,
        notes: patch.notes,
        notesState: patch.notesState,
      };
    }
    return partial;
  });
}

function cacheReleaseNotes(version: string, body: unknown) {
  if (typeof body !== "string") {
    releaseNotesCache.set(version, { state: "unavailable" });
    return;
  }
  const text = body.trim();
  if (!text || isPlaceholderReleaseNotes(text, version)) {
    releaseNotesCache.set(version, { state: "empty" });
    return;
  }
  releaseNotesCache.set(version, { state: "ready", notes: text });
}

function requestReleaseNotes(version: string) {
  if (
    !version ||
    releaseNotesCache.has(version) ||
    releaseNotesInflight.has(version)
  ) {
    return;
  }
  releaseNotesInflight.add(version);
  const epoch = releaseNotesEpoch;
  void invoke<string>("fetch_github_release_body", { tag: version })
    .then((body) => {
      if (epoch !== releaseNotesEpoch) return;
      cacheReleaseNotes(version, body);
    })
    .catch((error: unknown) => {
      if (epoch !== releaseNotesEpoch) return;
      log.warn("Release notes fetch failed", {
        version,
        message: formatUpdateError(error),
      });
      releaseNotesCache.set(version, { state: "unavailable" });
    })
    .finally(() => {
      releaseNotesInflight.delete(version);
      if (epoch !== releaseNotesEpoch) return;
      applyCachedReleaseNotes(version);
    });
}

function notesForOffer(
  version: string,
  notes: string | undefined,
  explicit: boolean,
): Pick<UpdateOfferFields, "notes" | "notesState"> {
  if (!isPlaceholderReleaseNotes(notes, version)) return { notes };
  const failed = releaseNotesCache.get(version);
  if (
    failed?.state === "unavailable" &&
    explicit &&
    (releaseNotesRetryCounts.get(version) ?? 0) < 1
  ) {
    releaseNotesCache.delete(version);
    releaseNotesRetryCounts.set(
      version,
      (releaseNotesRetryCounts.get(version) ?? 0) + 1,
    );
  }
  const cached = releaseNotesPatch(version);
  if (cached) return cached;
  requestReleaseNotes(version);
  return { notesState: "loading" };
}

function githubRateLimited(message: string): boolean {
  return /\b403\b|rate limit/i.test(message);
}

function logBetaFeedFallback(feed: BetaFeedResult, offer: UpdateOffer) {
  const message = feed.errorMessage ?? "GitHub releases request failed.";
  const rateLimited = githubRateLimited(message);
  const offeredVersion = offer.action === "none" ? undefined : offer.version;
  const offeredStable =
    offer.action === "download" ||
    (offer.action === "confirm" && !isPrereleaseVersion(offer.version));
  log.warn("beta list unavailable", {
    message,
    rateLimited,
    offeredVersion,
    offeredStable,
  });
}

/** A cancelled newer version stays until a loaded beta list covers this install. */
function dismissedOfferStillApplies(
  currentVersion: string,
  betaFeedLoaded: boolean,
  betas: readonly ReleaseCandidate[],
): boolean {
  const dismissed = useUpdateStore.getState().dismissedOffer;
  if (!dismissed) return false;
  if (!isNewerVersion(dismissed.version, currentVersion)) return false;
  if (betaFeedLoaded && installCoversLoadedBetas(currentVersion, betas)) {
    return false;
  }
  return true;
}

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

function commitOfferStatus(
  set: StoreSet,
  status: UpdateStatus,
  extra?: Partial<UpdateStore>,
) {
  set({ status, ...extra });
  if ("version" in status && status.notesState === "loading") {
    applyCachedReleaseNotes(status.version);
  }
}

function withResolvedNotes(meta: UpdateOfferFields): UpdateOfferFields {
  if (meta.notesState !== "loading") return meta;
  const patch = releaseNotesPatch(meta.version);
  if (!patch) return meta;
  return { ...meta, notes: patch.notes, notesState: patch.notesState };
}

function downloadingStatus(
  meta: UpdateOfferFields,
  percent: number | null,
): UpdateStatus {
  return { state: "downloading", ...withResolvedNotes(meta), percent };
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
    status: { state: "ready", ...withResolvedNotes(meta) },
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
  errorMessage?: string;
}

async function loadBetaCandidates(): Promise<BetaFeedResult> {
  try {
    const payload = await invoke<unknown>("fetch_github_releases");
    return {
      loaded: true,
      candidates: betaCandidatesFromGithub(payload),
    };
  } catch (error) {
    return {
      loaded: false,
      candidates: [],
      errorMessage: formatUpdateError(error),
    };
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
  dismissedOffer: null,
  dismissBanner: () => set({ bannerDismissed: true }),
  dismissOfferDialog: () => {
    const status = get().status;
    if (status.state === "confirm" || status.state === "manual") {
      sessionDismissedVersions.add(status.version);
      set({
        status: { state: "idle" },
        offerDialogHidden: false,
        dismissedOffer: {
          kind: status.state,
          version: status.version,
          currentVersion: status.currentVersion,
          notes: status.notes,
          notesState: status.notesState,
          channel: status.channel,
        },
      });
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
  reopenDismissedOffer: () => {
    const offer = get().dismissedOffer;
    if (!offer) return;
    const state = get().status.state;
    if (
      state === "checking" ||
      state === "downloading" ||
      state === "installing" ||
      state === "ready"
    ) {
      return;
    }
    const { kind, ...fields } = offer;
    const notesPatch = releaseNotesPatch(offer.version);
    set({
      status: { state: kind, ...fields, ...(notesPatch ?? {}) },
      offerDialogHidden: false,
      bannerDismissed: false,
    });
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
    if (current === "ready") {
      if (explicit) set({ offerDialogHidden: false });
      return;
    }
    if (!explicit && (current === "manual" || current === "confirm")) {
      return;
    }
    if (checkLock) {
      const running = checkLock;
      if (!explicit) return running;
      await running.catch(() => undefined);
      if (checkLock) return checkLock;
      const settled = get().status.state;
      if (settled === "downloading" || settled === "installing") return;
      if (settled === "ready") {
        if (explicit) set({ offerDialogHidden: false });
        return;
      }
    }

    let releaseLock = () => {};
    const lock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    checkLock = lock;

    const run = (async () => {
      const parkedUpdate = pending;
      const parkedManifest = pendingManifest;
      pending = null;
      pendingManifest = null;
      set({ status: { state: "checking", explicit } });
      clearPreparedManifest();
      let stableUpdate: Update | null = null;
      const releaseParked = async (keep: Update | null) => {
        if (parkedUpdate && parkedUpdate !== keep) {
          await parkedUpdate.close().catch(() => undefined);
        }
      };
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
        stableUpdate = stablePayload;
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
            if (stableUpdate !== parkedUpdate) {
              await stableUpdate.close().catch(() => undefined);
            }
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
        if (allowPrerelease && !betaFeed.loaded) {
          logBetaFeedFallback(betaFeed, offer);
        }

        const discardFreshStable = async () => {
          if (stableUpdate && stableUpdate !== parkedUpdate) {
            await stableUpdate.close().catch(() => undefined);
            stableUpdate = null;
          }
        };

        if (offer.action === "none") {
          await discardFreshStable();
          let failureAction: "surface-error" | "up-to-date" | "idle" | null =
            null;
          if (!stableResult.ok) {
            // up-to-date only when a loaded beta list already covers this
            // install. An empty or failed list stays idle: do not rethrow
            // the stable error, and do not claim a newer beta was ruled out.
            failureAction = stableCheckFailureAction({
              allowPrerelease,
              explicit,
              errorMessage: formatUpdateError(stableResult.error),
              betaFeedLoaded: betaFeed.loaded,
              currentVersion,
              betas,
            });
            if (failureAction === "surface-error") throw stableResult.error;
          } else if (stableVerifyError && stablePayload) {
            // The stable payload was dropped after verify failed. Report that
            // only when policy would have installed it. Plain 1.0.8 over a
            // newer 1.0.8-N build is already declined.
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

          // A later `none` must not drop a cancelled newer build just
          // because the beta list failed or came back empty.
          if (
            dismissedOfferStillApplies(currentVersion, betaFeed.loaded, betas)
          ) {
            pending = parkedUpdate;
            pendingManifest = parkedManifest;
            set({ status: { state: "idle" } });
            return;
          }

          const dismissed = useUpdateStore.getState().dismissedOffer;
          if (failureAction === "idle" && !dismissed) {
            pending = parkedUpdate;
            pendingManifest = parkedManifest;
            set({ status: { state: "idle" } });
            return;
          }

          await releaseParked(null);
          pending = null;
          pendingManifest = null;
          const state =
            failureAction === "up-to-date" ||
            (failureAction === null && explicit)
              ? "up-to-date"
              : "idle";
          set({
            status: { state },
            dismissedOffer: null,
          });
          return;
        }

        const offerFields: UpdateOfferFields = {
          version: offer.version,
          currentVersion,
          ...notesForOffer(offer.version, offer.notes, explicit),
          channel: offer.action === "confirm" ? "beta" : "stable",
        };
        // Cancel hides this exact version from later automatic checks.
        // A manual check still shows the dialog.
        if (!explicit && sessionDismissedVersions.has(offer.version)) {
          await discardFreshStable();
          pending = parkedUpdate;
          pendingManifest = parkedManifest;
          log.info("Skipped automatic update dialog", {
            version: offer.version,
          });
          set({ status: { state: "idle" } });
          return;
        }
        if (mode === "manual-package") {
          await discardFreshStable();
          await releaseParked(null);
          pending = null;
          pendingManifest = null;
          commitOfferStatus(
            set,
            { state: "manual", ...offerFields },
            {
              bannerDismissed: false,
              offerDialogHidden: false,
              dismissedOffer: null,
            },
          );
          return;
        }

        if (offer.action === "confirm") {
          if (offer.manifestUrl) {
            await discardFreshStable();
            await releaseParked(null);
            pending = null;
            pendingManifest = offer.manifestUrl;
          } else {
            await releaseParked(stableUpdate);
            pending = stableUpdate;
            pendingManifest = null;
          }
          commitOfferStatus(
            set,
            { state: "confirm", ...offerFields, channel: "beta" },
            {
              bannerDismissed: false,
              offerDialogHidden: false,
              dismissedOffer: null,
            },
          );
          return;
        }

        if (!stableUpdate) {
          await releaseParked(null);
          pending = null;
          pendingManifest = null;
          set({
            status: { state: explicit ? "up-to-date" : "idle" },
            dismissedOffer: null,
          });
          return;
        }
        // Stable payloads used to download immediately. Both channels now
        // wait for the dialog's Download and install action.
        await releaseParked(stableUpdate);
        pending = stableUpdate;
        pendingManifest = null;
        commitOfferStatus(
          set,
          { state: "confirm", ...offerFields, channel: "stable" },
          {
            bannerDismissed: false,
            offerDialogHidden: false,
            dismissedOffer: null,
          },
        );
      } catch (err) {
        if (pending === null && pendingManifest === null) {
          if (stableUpdate && stableUpdate !== parkedUpdate) {
            await stableUpdate.close().catch(() => undefined);
          }
          pending = parkedUpdate;
          pendingManifest = parkedManifest;
        } else if (parkedUpdate && parkedUpdate !== pending) {
          await parkedUpdate.close().catch(() => undefined);
        }
        const message = formatUpdateError(err);
        log.error("Update check failed", { message, explicit });
        set({
          status: {
            state: "error",
            message,
            explicit,
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
      notesState: status.notesState,
      channel: status.channel,
    };
    if (update) {
      try {
        await downloadPending(update, meta, set);
      } catch (err) {
        const message = formatUpdateError(err);
        log.error("Update download failed", { message });
        set({
          status: {
            state: "error",
            message,
            explicit: true,
            phase: "download",
          },
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
          phase: "download",
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
      const resolved = withResolvedNotes(meta);
      set({
        status: {
          state: "ready",
          ...resolved,
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
        status: {
          state: "error",
          message,
          explicit: true,
          phase: "download",
        },
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
        notesState: status.notesState,
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
  releaseNotesEpoch += 1;
  releaseNotesCache.clear();
  releaseNotesInflight.clear();
  releaseNotesRetryCounts.clear();
  useSettingsStore.setState({ joinBetaChannel: false });
  useUpdateStore.setState({
    status: { state: "idle" },
    bannerDismissed: false,
    offerDialogHidden: false,
    dismissedOffer: null,
  });
}
