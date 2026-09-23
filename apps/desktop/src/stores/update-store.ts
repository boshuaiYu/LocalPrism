import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { open } from "@tauri-apps/plugin-shell";
import {
  check,
  type DownloadEvent,
  type Update,
} from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import {
  RELEASES_URL,
  updateApplyMode,
  type UpdateApplyMode,
} from "@/lib/update-policy";

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking"; explicit: boolean }
  | { state: "up-to-date" }
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
  applyUpdate: () => Promise<void>;
  dismissBanner: () => void;
  openReleases: () => Promise<void>;
}

let pending: Update | null = null;
let autoCheckStarted = false;
let checkLock: Promise<void> | null = null;

function notesFrom(update: Update): string | undefined {
  const body = update.body?.trim();
  return body ? body : undefined;
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

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  status: { state: "idle" },
  bannerDismissed: false,
  dismissBanner: () => set({ bannerDismissed: true }),
  openReleases: async () => {
    await open(RELEASES_URL);
  },
  checkForUpdate: async (options) => {
    const explicit = options?.explicit ?? false;
    const current = get().status.state;
    if (
      !explicit &&
      (current === "downloading" ||
        current === "ready" ||
        current === "manual" ||
        current === "installing")
    ) {
      return;
    }
    if (checkLock) return checkLock;

    const run = (async () => {
      set({ status: { state: "checking", explicit } });
      try {
        let channel: string | null = "native";
        try {
          channel = await invoke<string>("update_install_channel");
        } catch {
          channel = "native";
        }
        const mode: UpdateApplyMode = updateApplyMode(channel);
        const update = await check();
        if (!update) {
          pending = null;
          set({
            status: { state: explicit ? "up-to-date" : "idle" },
          });
          return;
        }
        const notes = notesFrom(update);
        if (mode === "manual-package") {
          pending = null;
          await update.close();
          set({
            status: { state: "manual", version: update.version, notes },
            bannerDismissed: false,
          });
          return;
        }
        pending = update;
        await downloadPending(update, set);
      } catch (err) {
        const failedDuringDownload = get().status.state === "downloading";
        set({
          status: {
            state: "error",
            message: String(err),
            explicit: explicit || failedDuringDownload,
          },
        });
      }
    })();

    checkLock = run.finally(() => {
      checkLock = null;
    });
    return checkLock;
  },
  applyUpdate: async () => {
    const update = pending;
    const status = get().status;
    if (!update || status.state !== "ready") return;
    set({ status: { state: "installing", version: status.version } });
    try {
      await update.install();
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
  checkLock = null;
  useUpdateStore.setState({
    status: { state: "idle" },
    bannerDismissed: false,
  });
}
